import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { Actor, Operations, OFFICE, parse, permit, uuid } from "./domain";
import { schedulingLock } from "./rentals";
export class DisposalLoads {
  constructor(readonly ops: Operations) {}
  async list(a: Actor) {
    permit(a, [...OFFICE, "accountant", "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT d.*,co.number AS container_number,co.capacity_yards,c.name AS customer_name,l.address,e.display_name AS driver_name,t.number AS truck_number FROM disposal_loads d JOIN containers co ON co.id=d.container_id JOIN rentals r ON r.id=d.rental_id JOIN customers c ON c.id=r.customer_id JOIN locations l ON l.id=r.location_id LEFT JOIN employees e ON e.id=d.assigned_driver_id LEFT JOIN trucks t ON t.id=d.assigned_truck_id WHERE d.status<>'disposed' AND ($1::uuid IS NULL OR d.assigned_driver_id=$1) ORDER BY d.created_at LIMIT 500",
        [a.role === "driver" ? a.id : null],
      )
    ).rows;
  }
  async assign(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          version: z.number().int().positive(),
          driver_id: uuid,
          truck_id: uuid,
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["disposal.assign", id, b], async (c) => {
      await schedulingLock(c);
      if (
        !(
          await c.query(
            "SELECT 1 FROM employees WHERE id=$1 AND active AND role='driver' FOR SHARE",
            [b.driver_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Choose an active driver");
      if (
        !(
          await c.query(
            "SELECT 1 FROM trucks WHERE id=$1 AND status='available' FOR SHARE",
            [b.truck_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Choose an available truck");
      const row = (
        await c.query(
          "UPDATE disposal_loads SET assigned_driver_id=$2,assigned_truck_id=$3,status=CASE WHEN status='disposal_failed' THEN 'awaiting_disposal' ELSE status END,version=version+1 WHERE id=$1 AND version=$4 AND status<>'disposed' RETURNING *",
          [id, b.driver_id, b.truck_id, b.version],
        )
      ).rows[0];
      if (!row)
        throw new ConflictException(
          "Disposal task changed or is already complete",
        );
      await c.query(
        "INSERT INTO disposal_load_events(load_id,actor_id,action,note) VALUES($1,$2,'assigned','Disposal task assignment updated')",
        [id, a.id],
      );
      await this.ops.audit(c, a, "disposal.assigned", id, b);
      return row;
    });
  }
  async unable(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["driver"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          version: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2000),
          returning_later: z.boolean(),
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
        "Disposal timestamp must be within the last seven days",
      );
    return this.ops.command(a, key, ["disposal.unable", id, b], async (c) => {
      await schedulingLock(c);
      const load = (
        await c.query("SELECT * FROM disposal_loads WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!load) throw new NotFoundException("Disposal task not found");
      if (load.assigned_driver_id !== a.id) throw new ForbiddenException();
      if (load.version !== b.version || load.status === "disposed")
        throw new ConflictException(
          "Disposal task changed; refresh before updating",
        );
      const row = (
        await c.query(
          "UPDATE disposal_loads SET status='disposal_failed',last_failure_reason=$2,assigned_driver_id=CASE WHEN $3 THEN assigned_driver_id ELSE NULL END,assigned_truck_id=CASE WHEN $3 THEN assigned_truck_id ELSE NULL END,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.reason, b.returning_later],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO disposal_load_events(load_id,actor_id,action,note,performed_at) VALUES($1,$2,'unable_to_dump',$3,$4)",
        [id, a.id, b.reason, b.performed_at],
      );
      await this.ops.audit(c, a, "disposal.unable_to_dump", id, b);
      return row;
    });
  }
}
