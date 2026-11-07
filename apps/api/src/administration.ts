import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { getAuth } from "firebase-admin/auth";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  Actor,
  Operations,
  OFFICE,
  FINANCE,
  parse,
  permit,
  uuid,
} from "./domain";
const roles = z.enum([
  "owner",
  "manager",
  "dispatcher",
  "office",
  "accountant",
  "driver",
]);
export class Administration {
  constructor(readonly ops: Operations) {}
  async company(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE, "driver", "customer"]);
    return (
      await this.ops.pool.query(
        "SELECT * FROM company_settings WHERE singleton",
      )
    ).rows[0];
  }
  async updateCompany(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager"]);
    const b = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          email: z.union([z.email(), z.literal("")]),
          phone: z.string().max(40),
          address: z.string().max(2000),
          timezone: z.string().max(100),
          invoice_terms_days: z.number().int().min(0).max(365),
          late_fee_cents: z.number().int().min(0).max(10000000).optional(),
          late_fee_grace_days: z.number().int().min(0).max(365).optional(),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: b.timezone });
    } catch {
      throw new BadRequestException("Valid IANA timezone required");
    }
    return this.ops.command(a, key, ["company.update", b], async (c) => {
      const r = (
        await c.query(
          "UPDATE company_settings SET name=$1,email=$2,phone=$3,address=$4,timezone=$5,invoice_terms_days=$6,late_fee_cents=COALESCE($8,late_fee_cents),late_fee_grace_days=COALESCE($9,late_fee_grace_days),version=version+1 WHERE singleton AND version=$7 RETURNING *",
          [
            b.name,
            b.email,
            b.phone,
            b.address,
            b.timezone,
            b.invoice_terms_days,
            b.version,
            b.late_fee_cents ?? null,
            b.late_fee_grace_days ?? null,
          ],
        )
      ).rows[0];
      if (!r) throw new ConflictException("Company settings changed");
      await this.ops.audit(c, a, "company.updated", a.id);
      return r;
    });
  }
  async employees(a: Actor) {
    permit(a, ["owner", "manager"]);
    return (
      await this.ops.pool.query(
        "SELECT id,firebase_uid,username,display_name,role,active FROM employees WHERE role<>'customer' ORDER BY display_name LIMIT 1000",
      )
    ).rows;
  }
  async createEmployee(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager"]);
    const b = parse(
      z
        .object({
          email: z.email(),
          username: z.string().regex(/^[a-z0-9._-]{3,64}$/),
          display_name: z.string().trim().min(1).max(200),
          role: roles,
        })
        .strict(),
      body,
    );
    if (["owner", "manager"].includes(b.role)) permit(a, ["owner"]);
    const domain = process.env.VITE_EMPLOYEE_LOGIN_DOMAIN;
    if (
      domain &&
      b.email.toLowerCase() !== `${b.username}@${domain}`.toLowerCase()
    )
      throw new BadRequestException(
        "Employee email must match username at the configured company login domain",
      );
    // Deterministic provider UID makes retries recoverable without creating a second identity.
    return this.ops.command(a, key, ["employee.create", b], async (c) => {
      const uid =
        "cw-" +
        createHash("sha256")
          .update(a.id + ":" + key)
          .digest("hex");
      let identity;
      try {
        identity = await getAuth().getUser(uid);
      } catch (e) {
        if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
        identity = await getAuth().createUser({
          uid,
          email: b.email,
          displayName: b.display_name,
          emailVerified: false,
        });
      }
      if (identity.email?.toLowerCase() !== b.email.toLowerCase())
        throw new ConflictException("Identity does not match request");
      const employee = (
        await c.query(
          "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,role,active",
          [uid, b.username, b.display_name, b.role],
        )
      ).rows[0];
      await this.ops.audit(c, a, "employee.created", employee.id);
      return { ...employee, activation_required: true };
    });
  }
  async updateEmployee(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, ["owner"]);
    parse(uuid, id);
    const b = parse(
      z.object({ role: roles, active: z.boolean() }).strict(),
      body,
    );
    return this.ops.command(a, key, ["employee.update", id, b], async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('corewaste-owner-management'))",
      );
      const old = (
        await c.query(
          "SELECT * FROM employees WHERE id=$1 AND role<>'customer' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException("Employee not found");
      if (
        old.role === "owner" &&
        old.active &&
        (b.role !== "owner" || !b.active) &&
        Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM employees WHERE role='owner' AND active",
            )
          ).rows[0].n,
        ) <= 1
      )
        throw new ConflictException("At least one active owner must remain");
      const r = (
        await c.query(
          "UPDATE employees SET role=$2,active=$3 WHERE id=$1 RETURNING id,username,display_name,role,active",
          [id, b.role, b.active],
        )
      ).rows[0];
      await this.ops.audit(c, a, "employee.permissions_updated", id, b);
      return r;
    });
  }
  async trucks(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE, "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT * FROM trucks ORDER BY number LIMIT 1000",
      )
    ).rows;
  }
  async truck(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    const b = parse(
      z.object({ number: z.string().trim().min(1).max(80) }).strict(),
      body,
    );
    return this.ops.command(a, key, ["truck.create", b], async (c) => {
      const r = (
        await c.query("INSERT INTO trucks(number) VALUES($1) RETURNING *", [
          b.number,
        ])
      ).rows[0];
      await this.ops.audit(c, a, "truck.created", r.id);
      return r;
    });
  }
  async truckStatus(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, ["owner", "manager"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({ status: z.enum(["available", "maintenance", "retired"]) })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["truck.status", id, b], async (c) => {
      const t = (
        await c.query("SELECT * FROM trucks WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!t) throw new NotFoundException("Truck not found");
      if (
        b.status !== "available" &&
        (
          await c.query(
            "SELECT 1 FROM orders WHERE truck_id=$1 AND status='in_progress'",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException("Truck has work in progress");
      const r = (
        await c.query("UPDATE trucks SET status=$2 WHERE id=$1 RETURNING *", [
          id,
          b.status,
        ])
      ).rows[0];
      await this.ops.audit(c, a, "truck.status_updated", id, b);
      return r;
    });
  }
  async inspections(a: Actor) {
    permit(a, [...OFFICE, "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT i.*,t.number AS truck_number,e.display_name AS driver_name FROM vehicle_inspections i JOIN trucks t ON t.id=i.truck_id JOIN employees e ON e.id=i.driver_id WHERE ($1::uuid IS NULL OR driver_id=$1) ORDER BY created_at DESC LIMIT 500",
        [a.role === "driver" ? a.id : null],
      )
    ).rows;
  }
  async inspect(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["driver"]);
    const b = parse(
      z
        .object({
          truck_id: uuid,
          kind: z.enum(["pre_trip", "post_trip"]),
          odometer_km: z.number().int().min(0).max(10000000),
          safe_to_operate: z.boolean(),
          notes: z.string().trim().max(2000),
          recorded_at: z.iso.datetime().optional(),
        })
        .strict(),
      body,
    );
    if (
      b.recorded_at &&
      (Date.parse(b.recorded_at) > Date.now() + 300000 ||
        Date.now() - Date.parse(b.recorded_at) > 7 * 86400000)
    )
      throw new BadRequestException(
        "Inspection timestamp must be within the last seven days",
      );
    if (!b.safe_to_operate && !b.notes)
      throw new BadRequestException("Describe safety defects");
    return this.ops.command(a, key, ["inspection", b], async (c) => {
      if (
        !(
          await c.query(
            "SELECT 1 FROM orders WHERE driver_id=$1 AND truck_id=$2 AND (status IN ('assigned','in_progress') OR ($3='post_trip' AND completed_at>now()-interval '7 days')) UNION ALL SELECT 1 FROM order_events WHERE driver_id=$1 AND truck_id=$2 AND created_at>now()-interval '7 days' AND $3='post_trip' UNION ALL SELECT 1 FROM disposal_loads WHERE assigned_driver_id=$1 AND assigned_truck_id=$2 AND (status<>'disposed' OR ($3='post_trip' AND disposed_at>now()-interval '7 days')) UNION ALL SELECT 1 FROM driver_tasks WHERE driver_id=$1 AND truck_id=$2 AND (status IN ('assigned','in_progress') OR ($3='post_trip' AND completed_at>now()-interval '7 days'))",
            [a.id, b.truck_id, b.kind],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Truck must be assigned to your active work",
        );
      const i = (
        await c.query(
          "INSERT INTO vehicle_inspections(truck_id,driver_id,kind,odometer_km,safe_to_operate,notes,recorded_at) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now())) RETURNING *",
          [
            b.truck_id,
            a.id,
            b.kind,
            b.odometer_km,
            b.safe_to_operate,
            b.notes,
            b.recorded_at || null,
          ],
        )
      ).rows[0];
      if (!b.safe_to_operate)
        await c.query("UPDATE trucks SET status='maintenance' WHERE id=$1", [
          b.truck_id,
        ]);
      await this.ops.audit(c, a, "vehicle.inspected", i.id);
      return i;
    });
  }
  async maintenance(a: Actor) {
    permit(a, [...OFFICE]);
    return (
      await this.ops.pool.query(
        "SELECT m.*,t.number AS truck_number FROM maintenance_tasks m JOIN trucks t ON t.id=m.truck_id ORDER BY due_date LIMIT 500",
      )
    ).rows;
  }
  async scheduleMaintenance(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager"]);
    const b = parse(
      z
        .object({
          truck_id: uuid,
          description: z.string().trim().min(1).max(2000),
          due_date: z.iso.date(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["maintenance.create", b], async (c) => {
      const m = (
        await c.query(
          "INSERT INTO maintenance_tasks(truck_id,description,due_date) VALUES($1,$2,$3) RETURNING *",
          [b.truck_id, b.description, b.due_date],
        )
      ).rows[0];
      await this.ops.audit(c, a, "maintenance.scheduled", m.id);
      return m;
    });
  }
  async completeMaintenance(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, ["owner", "manager"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          completion_notes: z.string().trim().min(1).max(2000),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["maintenance.complete", id, b],
      async (c) => {
        const r = (
          await c.query(
            "UPDATE maintenance_tasks SET status='completed',completion_notes=$2,completed_at=now(),version=version+1 WHERE id=$1 AND status='open' AND version=$3 RETURNING *",
            [id, b.completion_notes, b.version],
          )
        ).rows[0];
        if (!r)
          throw new ConflictException("Maintenance task changed or completed");
        await this.ops.audit(c, a, "maintenance.completed", id);
        return r;
      },
    );
  }
  async audit(a: Actor) {
    permit(a, ["owner", "manager"]);
    return (
      await this.ops.pool.query(
        "SELECT l.*,e.display_name AS actor_name FROM audit_log l JOIN employees e ON e.id=l.actor_id ORDER BY l.id DESC LIMIT 500",
      )
    ).rows;
  }
  async contacts(a: Actor) {
    permit(a, [...OFFICE, "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT id,display_name,role FROM employees WHERE active AND role IN ('owner','manager','dispatcher','office','driver') AND id<>$1 AND ($2::boolean=false OR role<>'driver') ORDER BY display_name",
        [a.id, a.role === "driver"],
      )
    ).rows;
  }
  async messages(a: Actor) {
    permit(a, [...OFFICE, "driver"]);
    return (
      await this.ops.pool.query(
        "SELECT m.*,s.display_name AS sender_name,r.display_name AS recipient_name FROM driver_messages m JOIN employees s ON s.id=m.sender_id JOIN employees r ON r.id=m.recipient_id WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at DESC LIMIT 500",
        [a.id],
      )
    ).rows;
  }
  async readMessage(a: Actor, key: string | undefined, id: string) {
    permit(a, [...OFFICE, "driver"]);
    parse(uuid, id);
    return this.ops.command(a, key, ["message.read", id], async (c) => {
      const row = (
        await c.query(
          "UPDATE driver_messages SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_id=$2 RETURNING *",
          [id, a.id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("Received message not found");
      return row;
    });
  }
  async message(a: Actor, key: string | undefined, body: unknown) {
    permit(a, [...OFFICE, "driver"]);
    const b = parse(
      z
        .object({
          recipient_id: uuid,
          message: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["message.send", b], async (c) => {
      const target = (
        await c.query(
          "SELECT role FROM employees WHERE id=$1 AND active AND role IN ('owner','manager','dispatcher','office','driver')",
          [b.recipient_id],
        )
      ).rows[0];
      if (
        !target ||
        b.recipient_id === a.id ||
        (a.role === "driver" && target.role === "driver")
      )
        throw new BadRequestException("Choose an active office contact");
      const m = (
        await c.query(
          "INSERT INTO driver_messages(sender_id,recipient_id,message) VALUES($1,$2,$3) RETURNING *",
          [a.id, b.recipient_id, b.message],
        )
      ).rows[0];
      await this.ops.audit(c, a, "message.sent", m.id);
      return m;
    });
  }
}
