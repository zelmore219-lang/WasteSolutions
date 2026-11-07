import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import {
  transitionInput,
  Actor,
  Operations,
  OFFICE,
  parse,
  permit,
  uuid,
} from "./domain";
export class DriverTracking {
  constructor(readonly ops: Operations) {}
  async record(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["driver"]);
    const b = parse(
      z
        .object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracy_m: z.number().min(0).max(100000),
          recorded_at: z.iso.datetime(),
          consent: z.literal(true),
        })
        .strict(),
      body,
    );
    const age = Date.now() - Date.parse(b.recorded_at);
    if (age < -300000 || age > 86400000)
      throw new BadRequestException(
        "Location timestamp must be within the last 24 hours",
      );
    return this.ops.command(a, key, ["driver.location", b], async (c) => {
      const row = (
        await c.query(
          "INSERT INTO driver_locations(driver_id,latitude,longitude,accuracy_m,recorded_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(driver_id,recorded_at) DO NOTHING RETURNING *",
          [a.id, b.latitude, b.longitude, b.accuracy_m, b.recorded_at],
        )
      ).rows[0];
      return row || { recorded: true };
    });
  }
  async latest(a: Actor) {
    permit(a, ["owner", "manager", "dispatcher"]);
    return (
      await this.ops.pool.query(
        "SELECT DISTINCT ON (l.driver_id) l.*,e.display_name AS driver_name,extract(epoch FROM now()-recorded_at)::int AS age_seconds FROM driver_locations l JOIN employees e ON e.id=l.driver_id WHERE e.active AND recorded_at>now()-interval '24 hours' ORDER BY l.driver_id,recorded_at DESC",
      )
    ).rows;
  }
  async exceptions(a: Actor) {
    permit(a, [...OFFICE, "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT x.*,e.display_name AS driver_name,c.name AS customer_name,l.address FROM sync_exceptions x JOIN employees e ON e.id=x.driver_id JOIN orders o ON o.id=x.order_id JOIN customers c ON c.id=o.customer_id JOIN locations l ON l.id=o.location_id WHERE ($1::uuid IS NULL OR x.driver_id=$1) ORDER BY x.created_at DESC LIMIT 500",
        [a.role === "driver" ? a.id : null],
      )
    ).rows;
  }
  async exception(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["driver"]);
    const b = parse(
      z
        .object({
          order_id: uuid,
          command_key: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
          original_version: z.number().int().positive(),
          reported_status: z.enum([
            "in_progress",
            "arrived",
            "completed",
            "failed",
          ]),
          note: z.string().trim().max(2000),
          performed_at: z.iso.datetime(),
          original_body: transitionInput.optional(),
        })
        .strict(),
      body,
    );
    if (
      Date.now() - Date.parse(b.performed_at) > 90 * 86400000 ||
      Date.parse(b.performed_at) > Date.now() + 300000
    )
      throw new BadRequestException("Service evidence must be within 90 days");
    if (
      b.original_body &&
      (b.original_body.version !== b.original_version ||
        b.original_body.status !== b.reported_status ||
        (b.original_body.performed_at &&
          Date.parse(b.original_body.performed_at) !==
            Date.parse(b.performed_at)))
    )
      throw new BadRequestException(
        "Original service evidence must match its reported command",
      );
    return this.ops.command(a, key, ["sync.exception", b], async (c) => {
      const order = (
        await c.query("SELECT * FROM orders WHERE id=$1", [b.order_id])
      ).rows[0];
      if (!order) throw new NotFoundException();
      const history = (
        await c.query(
          "SELECT 1 FROM order_events WHERE order_id=$1 AND driver_id=$2 UNION ALL SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='order.assigned' AND detail->>'driver_id'=$2::text",
          [b.order_id, a.id],
        )
      ).rowCount;
      if (order.driver_id !== a.id && !history)
        throw new ForbiddenException("No assignment history for this order");
      const existing = (
        await c.query(
          "SELECT * FROM sync_exceptions WHERE driver_id=$1 AND command_key=$2",
          [a.id, b.command_key],
        )
      ).rows[0];
      if (existing) {
        const same = (
          await c.query(
            "SELECT order_id=$2 AND original_version=$3 AND reported_status=$4 AND note=$5 AND performed_at=$6::timestamptz AND original_body IS NOT DISTINCT FROM $7::jsonb AS same FROM sync_exceptions WHERE id=$1",
            [
              existing.id,
              b.order_id,
              b.original_version,
              b.reported_status,
              b.note,
              b.performed_at,
              b.original_body ? JSON.stringify(b.original_body) : null,
            ],
          )
        ).rows[0].same;
        if (!same)
          throw new ConflictException(
            "Original queued service evidence cannot be replaced",
          );
        return existing;
      }
      const row = (
        await c.query(
          "INSERT INTO sync_exceptions(driver_id,order_id,command_key,original_version,reported_status,note,performed_at,original_body) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            a.id,
            b.order_id,
            b.command_key,
            b.original_version,
            b.reported_status,
            b.note,
            b.performed_at,
            b.original_body ? JSON.stringify(b.original_body) : null,
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "sync.exception_submitted", row.id);
      return row;
    });
  }
  async resolve(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          status: z.enum(["acknowledged", "rejected"]),
          resolution: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["sync.resolve", id, b], async (c) => {
      const row = (
        await c.query(
          "UPDATE sync_exceptions SET status=$2,resolution=$3,resolved_by=$4 WHERE id=$1 AND status='open' RETURNING *",
          [id, b.status, b.resolution, a.id],
        )
      ).rows[0];
      if (!row)
        throw new ConflictException(
          "Exception is already resolved or unavailable",
        );
      await this.ops.audit(c, a, "sync.exception_resolved", id, b);
      return row;
    });
  }
}
