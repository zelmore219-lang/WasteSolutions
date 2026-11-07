import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { PoolClient } from "pg";
import { z } from "zod";
import { Actor, Operations, parse, permit, uuid } from "./domain";
const note = z.string().trim().max(2000),
  version = z.number().int().positive(),
  time = z.iso.datetime();
const bodies: Record<string, z.ZodType> = {
  message: z.object({ recipient_id: uuid, message: note.min(1) }).strict(),
  message_read: z.object({}).strict(),
  inspection: z
    .object({
      truck_id: uuid,
      kind: z.enum(["pre_trip", "post_trip"]),
      odometer_km: z.number().int().min(0).max(10000000),
      safe_to_operate: z.boolean(),
      notes: note,
      recorded_at: time,
    })
    .strict(),
  disposal: z
    .object({
      order_id: uuid,
      facility: z.string().min(1).max(200),
      ticket_number: z.string().min(1).max(100),
      gross_kg: z.number().int().positive().max(1000000),
      tare_kg: z.number().int().min(0).max(1000000),
      disposal_cost_cents: z.number().int().min(0).max(100000000),
    })
    .strict(),
  unable_dump: z
    .object({
      version,
      reason: note.min(1),
      returning_later: z.boolean(),
      performed_at: time,
    })
    .strict(),
  task: z.object({ version, note, performed_at: time }).strict(),
  driver_task: z
    .object({
      version,
      status: z.enum(["in_progress", "completed", "failed"]),
      note,
      performed_at: time,
    })
    .strict(),
};
const actionInput = z
  .object({
    kind: z.enum([
      "message",
      "message_read",
      "inspection",
      "disposal",
      "unable_dump",
      "task",
      "driver_task",
    ]),
    orderId: uuid.optional(),
    taskId: uuid.optional(),
    loadId: uuid.optional(),
    rentalId: uuid.optional(),
    messageId: uuid.optional(),
    body: z.unknown(),
  })
  .strict();
export class DriverActionReview {
  constructor(readonly ops: Operations) {}
  async list(a: Actor) {
    permit(a, ["owner", "manager", "dispatcher", "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT r.*,e.display_name AS driver_name FROM driver_action_reviews r JOIN employees e ON e.id=r.driver_id WHERE ($1::uuid IS NULL OR r.driver_id=$1) ORDER BY r.created_at DESC LIMIT 500",
        [a.role === "driver" ? a.id : null],
      )
    ).rows;
  }
  private async ownedOrder(c: PoolClient, a: Actor, id: string) {
    const row = (
      await c.query(
        "SELECT o.id,c.name,l.address FROM orders o JOIN customers c ON c.id=o.customer_id JOIN locations l ON l.id=o.location_id WHERE o.id=$1 AND (o.driver_id=$2 OR EXISTS(SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.driver_id=$2 AND e.created_at>now()-interval '90 days'))",
        [id, a.id],
      )
    ).rows[0];
    if (!row)
      throw new ForbiddenException(
        "This service evidence is not linked to your recent work",
      );
    return row;
  }
  async submit(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["driver"]);
    const b = parse(
      z
        .object({
          command_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
          performed_at: time,
          action: actionInput,
        })
        .strict(),
      body,
    );
    const details: any = parse(bodies[b.action.kind], b.action.body);
    const action = { ...b.action, body: details };
    if (JSON.stringify(action).length > 8000)
      throw new BadRequestException(
        "Offline evidence exceeds the supported size",
      );
    if (
      Date.parse(b.performed_at) > Date.now() + 300000 ||
      Date.now() - Date.parse(b.performed_at) > 90 * 86400000
    )
      throw new BadRequestException(
        "Offline evidence must be within the last 90 days",
      );
    return this.ops.command(
      a,
      key,
      ["driver-action.review", b.command_key, b.performed_at, action],
      async (c) => {
        let label: string;
        if (action.kind === "driver_task") {
          const id = parse(uuid, action.taskId),
            task = (
              await c.query(
                "SELECT title FROM driver_tasks t WHERE id=$1 AND (driver_id=$2 OR EXISTS(SELECT 1 FROM driver_task_events e WHERE e.task_id=t.id AND e.driver_id=$2 AND e.created_at>now()-interval '90 days'))",
                [id, a.id],
              )
            ).rows[0];
          if (!task)
            throw new ForbiddenException(
              "Task evidence is not linked to your recent assignments",
            );
          label = "Driver task: " + task.title;
        } else if (action.kind === "task") {
          const order = await this.ownedOrder(
              c,
              a,
              parse(uuid, action.orderId),
            ),
            task = (
              await c.query(
                "SELECT label FROM order_tasks WHERE id=$1 AND order_id=$2",
                [parse(uuid, action.taskId), order.id],
              )
            ).rows[0];
          if (!task) throw new ForbiddenException();
          label = "Service checklist: " + task.label + " · " + order.name;
        } else if (
          action.kind === "disposal" ||
          action.kind === "unable_dump"
        ) {
          const load = (
            await c.query(
              "SELECT d.*,co.number FROM disposal_loads d JOIN containers co ON co.id=d.container_id WHERE " +
                (action.kind === "disposal"
                  ? "d.order_id=$1 AND d.rental_id=$3"
                  : "d.id=$1") +
                " AND (d.assigned_driver_id=$2 OR EXISTS(SELECT 1 FROM order_events e WHERE e.order_id=d.order_id AND e.driver_id=$2 AND e.created_at>now()-interval '90 days') OR EXISTS(SELECT 1 FROM audit_log log WHERE log.entity_id=d.id AND log.action='disposal.assigned' AND log.detail->>'driver_id'=$2::text AND log.created_at>now()-interval '90 days'))",
              action.kind === "disposal"
                ? [details.order_id, a.id, parse(uuid, action.rentalId)]
                : [parse(uuid, action.loadId), a.id],
            )
          ).rows[0];
          if (!load)
            throw new ForbiddenException(
              "Disposal evidence is not linked to your recent assignments",
            );
          label = "Disposal: " + load.number;
        } else if (action.kind === "inspection") {
          const truck = (
            await c.query(
              "SELECT number FROM trucks t WHERE id=$1 AND (EXISTS(SELECT 1 FROM orders o WHERE o.truck_id=t.id AND o.driver_id=$2) OR EXISTS(SELECT 1 FROM order_events e WHERE e.truck_id=t.id AND e.driver_id=$2 AND e.created_at>now()-interval '90 days') OR EXISTS(SELECT 1 FROM disposal_loads d WHERE d.assigned_truck_id=t.id AND d.assigned_driver_id=$2) OR EXISTS(SELECT 1 FROM driver_tasks d WHERE d.truck_id=t.id AND d.driver_id=$2) OR EXISTS(SELECT 1 FROM vehicle_inspections i WHERE i.truck_id=t.id AND i.driver_id=$2 AND i.created_at>now()-interval '90 days')))",
              [details.truck_id, a.id],
            )
          ).rows[0];
          if (!truck)
            throw new ForbiddenException(
              "Inspection evidence is not linked to your truck assignments",
            );
          label = "Vehicle inspection: " + truck.number;
        } else if (action.kind === "message_read") {
          if (
            !(
              await c.query(
                "SELECT 1 FROM driver_messages WHERE id=$1 AND recipient_id=$2",
                [parse(uuid, action.messageId), a.id],
              )
            ).rowCount
          )
            throw new ForbiddenException();
          label = "Dispatch message acknowledgement";
        } else label = "Outgoing office message";
        const committed = Boolean(
          (
            await c.query(
              "SELECT 1 FROM commands WHERE actor_id=$1 AND key=$2",
              [a.id, b.command_key],
            )
          ).rowCount,
        );
        const row = (
          await c.query(
            "INSERT INTO driver_action_reviews(driver_id,command_key,original_action,performed_at,entity_label,already_committed) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(driver_id,command_key) DO NOTHING RETURNING *",
            [a.id, b.command_key, action, b.performed_at, label, committed],
          )
        ).rows[0];
        if (!row) {
          const prior = (
            await c.query(
              "SELECT * FROM driver_action_reviews WHERE driver_id=$1 AND command_key=$2",
              [a.id, b.command_key],
            )
          ).rows[0];
          if (
            !(
              await c.query(
                "SELECT 1 FROM driver_action_reviews WHERE id=$1 AND original_action=$2::jsonb AND performed_at=$3::timestamptz",
                [prior.id, JSON.stringify(action), b.performed_at],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Evidence for this request was already submitted with different details",
            );
          return prior;
        }
        await this.ops.audit(c, a, "driver_action.evidence_submitted", row.id, {
          kind: action.kind,
          command_key: b.command_key,
          already_committed: committed,
        });
        return row;
      },
    );
  }
  async resolve(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          status: z.enum(["acknowledged", "rejected"]),
          resolution: note.min(1),
        })
        .strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["driver-action.resolve", id, b],
      async (c) => {
        const row = (
          await c.query(
            "UPDATE driver_action_reviews SET status=$2,resolution=$3,reviewed_by=$4 WHERE id=$1 AND status='open' RETURNING *",
            [id, b.status, b.resolution, a.id],
          )
        ).rows[0];
        if (!row) throw new ConflictException("Evidence was already reviewed");
        await this.ops.audit(c, a, "driver_action.evidence_reviewed", id, b);
        return row;
      },
    );
  }
}
