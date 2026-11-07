import { recordStorageEvent } from "./equipment-events";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { PoolClient } from "pg";
import {
  Actor,
  Operations,
  OFFICE,
  FINANCE,
  parse,
  permit,
  uuid,
} from "./domain";
import { schedulingLock } from "./rentals";
const inventory = ["owner", "manager", "dispatcher"];
const reason = z.string().trim().min(1).max(2000),
  proof = {
    version: z.number().int().positive(),
    observed_number: z.string().trim().min(1).max(80),
    reason,
  };
const destination = { yard_id: uuid.nullable(), truck_id: uuid.nullable() };
export class EquipmentStorage {
  constructor(readonly ops: Operations) {}
  async yards(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE, "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT * FROM equipment_yards ORDER BY active DESC,name,id",
      )
    ).rows;
  }
  async createYard(a: Actor, key: string | undefined, body: unknown) {
    permit(a, inventory);
    const b = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          address: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["equipment.yard.create", b], async (c) => {
      const row = (
        await c.query(
          "INSERT INTO equipment_yards(name,address) VALUES($1,$2) RETURNING *",
          [b.name, b.address],
        )
      ).rows[0];
      await this.ops.audit(c, a, "equipment.yard_created", row.id, b);
      return row;
    });
  }
  async updateYard(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, inventory);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          address: z.string().trim().min(1).max(2000),
          active: z.boolean(),
          version: z.number().int().positive(),
          reason,
        })
        .strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["equipment.yard.update", id, b],
      async (c) => {
        const old = (
          await c.query(
            "SELECT * FROM equipment_yards WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!old) throw new NotFoundException("Yard not found");
        if (old.version !== b.version)
          throw new ConflictException("Yard changed; refresh before editing");
        if (
          !b.active &&
          (
            await c.query("SELECT 1 FROM containers WHERE yard_id=$1 LIMIT 1", [
              id,
            ])
          ).rowCount
        )
          throw new ConflictException(
            "Move all equipment out before deactivating its yard",
          );
        const row = (
          await c.query(
            "UPDATE equipment_yards SET name=$2,address=$3,active=$4,version=version+1 WHERE id=$1 RETURNING *",
            [id, b.name, b.address, b.active],
          )
        ).rows[0];
        await this.ops.audit(c, a, "equipment.yard_updated", id, {
          before: old,
          after: b,
        });
        return row;
      },
    );
  }
  async history(a: Actor, id: string) {
    permit(a, [...OFFICE, ...FINANCE]);
    parse(uuid, id);
    const row = (
      await this.ops.pool.query(
        "SELECT co.*,y.name AS yard_name,t.number AS carrier_number,l.address,COALESCE((SELECT jsonb_agg(e ORDER BY e.recorded_at DESC,e.id DESC) FROM (SELECT * FROM equipment_storage_events WHERE container_id=co.id ORDER BY recorded_at DESC,id DESC LIMIT 50)e),'[]'::jsonb) AS events,COALESCE((SELECT jsonb_agg(d ORDER BY d.placed_at DESC) FROM (SELECT * FROM equipment_deployments WHERE container_id=co.id ORDER BY placed_at DESC,id DESC LIMIT 50) d),'[]'::jsonb) AS deployments FROM containers co LEFT JOIN equipment_yards y ON y.id=co.yard_id LEFT JOIN trucks t ON t.id=co.carried_by_truck_id LEFT JOIN locations l ON l.id=co.location_id WHERE co.id=$1",
        [id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Equipment not found");
    return { ...row, ...(await this.events(a, id, {})) };
  }
  async events(a: Actor, id: string, query: unknown) {
    permit(a, [...OFFICE, ...FINANCE]);
    parse(uuid, id);
    const b = parse(z.object({ before: uuid.optional() }).strict(), query);
    if (
      b.before &&
      !(
        await this.ops.pool.query(
          "SELECT 1 FROM equipment_storage_events WHERE id=$1 AND container_id=$2",
          [b.before, id],
        )
      ).rowCount
    )
      throw new BadRequestException(
        "History cursor must belong to this equipment",
      );
    const events = (
      await this.ops.pool.query(
        "SELECT * FROM equipment_storage_events WHERE container_id=$1 AND ($2::uuid IS NULL OR (recorded_at,id)<(SELECT recorded_at,id FROM equipment_storage_events WHERE id=$2)) ORDER BY recorded_at DESC,id DESC LIMIT 51",
        [id, b.before || null],
      )
    ).rows;
    return {
      events: events.slice(0, 50),
      next_cursor: events.length > 50 ? events[49].id : null,
    };
  }
  async observeLegacyPlacement(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, ["owner", "manager"]);
    parse(uuid, id);
    const b = parse(
      z.object({ ...proof, confirm_location_id: uuid }).strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["equipment.observe_legacy", id, b],
      async (c) => {
        const before = await this.container(c, id, b);
        if (
          !["cart", "commercial"].includes(before.kind) ||
          before.status !== "deployed" ||
          before.location_id !== b.confirm_location_id
        )
          throw new ConflictException(
            "Observe only existing deployed cart/commercial equipment at its recorded location",
          );
        if (
          (
            await c.query(
              "SELECT 1 FROM equipment_deployments WHERE container_id=$1 AND recovered_at IS NULL",
              [id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "This equipment already has a recorded active placement",
          );
        const location = (
          await c.query("SELECT * FROM locations WHERE id=$1 FOR SHARE", [
            before.location_id,
          ])
        ).rows[0];
        const deployment = (
          await c.query(
            "INSERT INTO equipment_deployments(container_id,customer_id,location_id,placed_by,record_kind) VALUES($1,$2,$3,$4,'legacy_observation') RETURNING *",
            [id, location.customer_id, location.id, a.id],
          )
        ).rows[0];
        const after = (
          await c.query(
            "UPDATE containers SET version=version+1 WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
        await this.event(
          c,
          a,
          before,
          after,
          "legacy_placement_observed",
          b,
          deployment.id,
        );
        return { ...after, deployment_id: deployment.id };
      },
    );
  }
  private async container(
    c: PoolClient,
    id: string,
    b: { version: number; observed_number: string },
  ) {
    await schedulingLock(c);
    const row = (
      await c.query("SELECT * FROM containers WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!row) throw new NotFoundException("Equipment not found");
    if (row.version !== b.version)
      throw new ConflictException(
        "Equipment changed; refresh before recording its movement",
      );
    if (row.number !== b.observed_number)
      throw new ConflictException(
        "Observed equipment number does not match the assigned equipment",
      );
    return row;
  }
  private async target(
    c: PoolClient,
    b: { yard_id: string | null; truck_id: string | null },
  ) {
    if (Boolean(b.yard_id) === Boolean(b.truck_id))
      throw new BadRequestException(
        "Select exactly one destination yard or truck",
      );
    if (
      b.yard_id &&
      !(
        await c.query(
          "SELECT 1 FROM equipment_yards WHERE id=$1 AND active FOR SHARE",
          [b.yard_id],
        )
      ).rowCount
    )
      throw new BadRequestException("Active destination yard required");
    if (
      b.truck_id &&
      !(
        await c.query(
          "SELECT 1 FROM trucks WHERE id=$1 AND status='available' FOR SHARE",
          [b.truck_id],
        )
      ).rowCount
    )
      throw new BadRequestException("Available destination truck required");
  }
  private async event(
    c: PoolClient,
    a: Actor,
    before: any,
    after: any,
    action: string,
    b: { observed_number: string; reason: string },
    deploymentId: string | null = null,
  ) {
    await recordStorageEvent(c, a.id, before, after, action, b.reason, {
      observed_number: b.observed_number,
      deployment_id: deploymentId || undefined,
    });
    await this.ops.audit(c, a, "equipment." + action, before.id, {
      before,
      after,
      reason: b.reason,
      deployment_id: deploymentId,
    });
  }
  async move(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, inventory);
    parse(uuid, id);
    const b = parse(z.object({ ...proof, ...destination }).strict(), body);
    return this.ops.command(a, key, ["equipment.move", id, b], async (c) => {
      const before = await this.container(c, id, b);
      if (
        !["yard", "on_truck", "maintenance", "retired"].includes(before.status)
      )
        throw new ConflictException(
          "Only empty available yard/truck stock can be relocated; recover deployed equipment or resolve its hold first",
        );
      if (b.truck_id && ["maintenance", "retired"].includes(before.status))
        throw new ConflictException(
          "Quarantined equipment can move between yards but cannot be loaded as available truck stock",
        );
      await this.target(c, b);
      if (
        before.yard_id === b.yard_id &&
        before.carried_by_truck_id === b.truck_id
      )
        throw new ConflictException("Equipment is already at this destination");
      if (
        b.truck_id &&
        (
          await c.query(
            "SELECT 1 FROM rental_jobs j JOIN orders o ON o.id=j.order_id WHERE (j.container_id=$1 AND j.action='delivery' OR j.replacement_container_id=$1 AND j.action='exchange') AND o.status IN ('assigned','in_progress') AND o.truck_id<>$2 LIMIT 1",
            [id, b.truck_id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Equipment is assigned to rental work on another truck; review dispatch before loading",
        );
      const after = (
        await c.query(
          "UPDATE containers SET status=CASE WHEN $4 IN ('maintenance','retired') THEN $4 WHEN $2::uuid IS NULL THEN 'on_truck' ELSE 'yard' END,yard_id=$2,carried_by_truck_id=$3,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.yard_id, b.truck_id, before.status],
        )
      ).rows[0];
      await this.event(c, a, before, after, "relocated", b);
      return after;
    });
  }
  async place(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, inventory);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          ...proof,
          customer_id: uuid,
          location_id: uuid,
          order_id: uuid.optional(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["equipment.place", id, b], async (c) => {
      const before = await this.container(c, id, b);
      if (
        !["cart", "commercial"].includes(before.kind) ||
        !["yard", "on_truck"].includes(before.status)
      )
        throw new ConflictException(
          "Cart/commercial placement requires available stock; roll-offs use their rental workflow",
        );
      if (
        !(
          await c.query(
            "SELECT 1 FROM customers c JOIN locations l ON l.customer_id=c.id WHERE c.id=$1 AND l.id=$2 AND c.status='active' AND l.active FOR SHARE OF c,l",
            [b.customer_id, b.location_id],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Active customer and matching service location required",
        );
      if (b.order_id) {
        const order = (
          await c.query("SELECT * FROM orders WHERE id=$1 FOR SHARE", [
            b.order_id,
          ])
        ).rows[0];
        if (
          !order ||
          order.customer_id !== b.customer_id ||
          order.location_id !== b.location_id ||
          !["completed", "invoiced"].includes(order.status) ||
          (before.status === "on_truck" &&
            order.truck_id !== before.carried_by_truck_id)
        )
          throw new ConflictException(
            "Linked service must be completed for this customer/location and match its carrying truck",
          );
      }
      const deployment = (
        await c.query(
          "INSERT INTO equipment_deployments(container_id,customer_id,location_id,order_id,placed_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [id, b.customer_id, b.location_id, b.order_id || null, a.id],
        )
      ).rows[0];
      const after = (
        await c.query(
          "UPDATE containers SET status='deployed',location_id=$2,yard_id=NULL,carried_by_truck_id=NULL,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.location_id],
        )
      ).rows[0];
      await this.event(c, a, before, after, "placed", b, deployment.id);
      return { ...after, deployment_id: deployment.id };
    });
  }
  async recover(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, inventory);
    parse(uuid, id);
    const b = parse(z.object({ ...proof, ...destination }).strict(), body);
    return this.ops.command(a, key, ["equipment.recover", id, b], async (c) => {
      const before = await this.container(c, id, b),
        deployment = (
          await c.query(
            "SELECT * FROM equipment_deployments WHERE container_id=$1 AND recovered_at IS NULL FOR UPDATE",
            [id],
          )
        ).rows[0];
      if (
        !["cart", "commercial"].includes(before.kind) ||
        before.status !== "deployed" ||
        !deployment ||
        deployment.location_id !== before.location_id
      )
        throw new ConflictException(
          "Recover only an active recorded cart/commercial placement; roll-offs use their rental pickup",
        );
      await this.target(c, b);
      await c.query(
        "UPDATE equipment_deployments SET recovered_at=now(),recovered_by=$2 WHERE id=$1",
        [deployment.id, a.id],
      );
      const after = (
        await c.query(
          "UPDATE containers SET status=CASE WHEN $2::uuid IS NULL THEN 'on_truck' ELSE 'yard' END,location_id=NULL,yard_id=$2,carried_by_truck_id=$3,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.yard_id, b.truck_id],
        )
      ).rows[0];
      await this.event(c, a, before, after, "recovered", b, deployment.id);
      return after;
    });
  }
  async status(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, inventory);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          ...proof,
          status: z.enum(["yard", "maintenance", "retired"]),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["equipment.status", id, b], async (c) => {
      const before = await this.container(c, id, b);
      if (
        (b.status === "retired" || before.status === "retired") &&
        !["owner", "manager"].includes(a.role)
      )
        throw new BadRequestException(
          "Owner or manager required for retirement or reactivation",
        );
      if (
        !["yard", "maintenance", "retired"].includes(before.status) ||
        before.status === b.status
      )
        throw new ConflictException(
          "Unload/recover equipment before changing its availability",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM container_bookings b JOIN rentals r ON r.id=b.rental_id WHERE b.container_id=$1 AND NOT b.released AND (b.end_date_exclusive>(now() AT TIME ZONE (SELECT timezone FROM company_settings WHERE singleton))::date OR r.status IN ('reserved','delivered')) LIMIT 1",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Review and release existing rental reservations before changing equipment availability",
        );
      const after = (
        await c.query(
          "UPDATE containers SET status=$2,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.status],
        )
      ).rows[0];
      await this.event(
        c,
        a,
        before,
        after,
        b.status === "yard" ? "returned_to_service" : b.status,
        b,
      );
      return after;
    });
  }
}
