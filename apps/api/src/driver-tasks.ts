import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PoolClient } from "pg";
import { z } from "zod";
import { Actor, Operations, OFFICE, parse, permit, uuid } from "./domain";
export class DriverTasks {
  constructor(readonly ops: Operations) {}
  async list(a: Actor) {
    permit(a, [...OFFICE, "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT t.*,e.display_name AS driver_name,tr.number AS truck_number,tr.status AS truck_status FROM driver_tasks t LEFT JOIN employees e ON e.id=t.driver_id LEFT JOIN trucks tr ON tr.id=t.truck_id WHERE ($1::uuid IS NULL OR t.driver_id=$1) AND (t.status IN ('new','assigned','in_progress','failed') OR t.scheduled_date>=(now()-interval '30 days')::date) ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,t.scheduled_date,t.created_at LIMIT 500",
        [a.role === "driver" ? a.id : null],
      )
    ).rows;
  }
  private async resources(
    c: PoolClient,
    driverId: string,
    truckId: string | null,
  ) {
    if (
      !(
        await c.query(
          "SELECT 1 FROM employees WHERE id=$1 AND active AND role='driver' FOR SHARE",
          [driverId],
        )
      ).rowCount
    )
      throw new BadRequestException("Active driver required");
    if (
      truckId &&
      !(
        await c.query(
          "SELECT 1 FROM trucks WHERE id=$1 AND status='available' FOR SHARE",
          [truckId],
        )
      ).rowCount
    )
      throw new BadRequestException("Available truck required");
  }
  private async event(
    c: PoolClient,
    a: Actor,
    task: any,
    status: string,
    note: string,
    time?: string,
  ) {
    await c.query(
      "INSERT INTO driver_task_events(task_id,actor_id,driver_id,status,note,performed_at) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()))",
      [task.id, a.id, task.driver_id, status, note, time || null],
    );
  }
  async create(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(
      z
        .object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(2000),
          address: z.string().trim().max(2000),
          scheduled_date: z.iso.date(),
          priority: z.enum(["low", "normal", "high", "urgent"]),
          driver_id: uuid.optional(),
          truck_id: uuid.optional(),
        })
        .strict(),
      body,
    );
    if (b.truck_id && !b.driver_id)
      throw new BadRequestException(
        "Assign a driver before choosing a task truck",
      );
    if (b.driver_id) permit(a, ["owner", "manager", "dispatcher"]);
    return this.ops.command(a, key, ["driver-task.create", b], async (c) => {
      if (b.driver_id) await this.resources(c, b.driver_id, b.truck_id || null);
      const row = (
        await c.query(
          "INSERT INTO driver_tasks(title,description,address,scheduled_date,priority,driver_id,truck_id,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            b.title,
            b.description,
            b.address,
            b.scheduled_date,
            b.priority,
            b.driver_id || null,
            b.truck_id || null,
            b.driver_id ? "assigned" : "new",
            a.id,
          ],
        )
      ).rows[0];
      await this.event(c, a, row, row.status, "Task created");
      await this.ops.audit(c, a, "driver_task.created", row.id, b);
      return row;
    });
  }
  async assign(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          driver_id: uuid,
          truck_id: uuid.nullable(),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["driver-task.assign", id, b],
      async (c) => {
        const old = (
          await c.query("SELECT * FROM driver_tasks WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0];
        if (!old) throw new NotFoundException();
        if (
          old.version !== b.version ||
          ["completed", "cancelled"].includes(old.status)
        )
          throw new ConflictException("Task changed or is already closed");
        await this.resources(c, b.driver_id, b.truck_id);
        const row = (
          await c.query(
            "UPDATE driver_tasks SET driver_id=$2,truck_id=$3,status=CASE WHEN status='in_progress' THEN status ELSE 'assigned' END,version=version+1 WHERE id=$1 RETURNING *",
            [id, b.driver_id, b.truck_id],
          )
        ).rows[0];
        await this.event(c, a, row, row.status, "Task assignment updated");
        await this.ops.audit(c, a, "driver_task.assigned", id, b);
        return row;
      },
    );
  }
  async status(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "driver"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          status: z.enum(["in_progress", "completed", "failed"]),
          version: z.number().int().positive(),
          note: z.string().trim().max(2000),
          performed_at: z.iso.datetime(),
        })
        .strict(),
      body,
    );
    if (
      Date.parse(b.performed_at) > Date.now() + 300000 ||
      Date.now() - Date.parse(b.performed_at) > 7 * 86400000
    )
      throw new BadRequestException(
        "Task timestamp must be within the last seven days",
      );
    if (b.status === "failed" && !b.note)
      throw new BadRequestException(
        "Describe why the task could not be completed",
      );
    return this.ops.command(
      a,
      key,
      ["driver-task.status", id, b],
      async (c) => {
        const task = (
          await c.query("SELECT * FROM driver_tasks WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0];
        if (!task) throw new NotFoundException();
        if (a.role === "driver" && task.driver_id !== a.id)
          throw new ForbiddenException();
        if (task.version !== b.version)
          throw new ConflictException("Task changed; reload before updating");
        const allowed: Record<string, string[]> = {
          assigned: ["in_progress", "failed"],
          in_progress: ["completed", "failed"],
        };
        if (!allowed[task.status]?.includes(b.status))
          throw new ConflictException("Invalid task transition");
        if (
          b.status === "in_progress" &&
          task.truck_id &&
          !(
            await c.query(
              "SELECT 1 FROM trucks WHERE id=$1 AND status='available' FOR SHARE",
              [task.truck_id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Task truck is unavailable; contact dispatch",
          );
        const row = (
          await c.query(
            "UPDATE driver_tasks SET status=$2,started_at=CASE WHEN $2='in_progress' THEN $3::timestamptz ELSE started_at END,completed_at=CASE WHEN $2='completed' THEN $3::timestamptz ELSE completed_at END,completion_note=$4,version=version+1 WHERE id=$1 RETURNING *",
            [id, b.status, b.performed_at, b.note],
          )
        ).rows[0];
        await this.event(c, a, row, b.status, b.note, b.performed_at);
        await this.ops.audit(c, a, "driver_task." + b.status, id, b);
        return row;
      },
    );
  }
  async cancel(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          version: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["driver-task.cancel", id, b],
      async (c) => {
        const row = (
          await c.query(
            "UPDATE driver_tasks SET status='cancelled',completion_note=$2,version=version+1 WHERE id=$1 AND version=$3 AND status IN ('new','assigned','failed') RETURNING *",
            [id, b.reason, b.version],
          )
        ).rows[0];
        if (!row)
          throw new ConflictException("Task changed or already started");
        await this.event(c, a, row, "cancelled", b.reason);
        await this.ops.audit(c, a, "driver_task.cancelled", id, b);
        return row;
      },
    );
  }
}
