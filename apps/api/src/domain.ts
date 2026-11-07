import { feeSelections, snapshotFees } from "./service-fees";
import { notify } from "./notification-outbox";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Pool, PoolClient, types } from "pg";
types.setTypeParser(1082, (value) => value);
import { createHash } from "node:crypto";
import { z } from "zod";
import { completeRentalJob, assertRentalStart } from "./rental-completion";
export type Actor = { id: string; role: string; customer_id: string | null };
export const uuid = z.uuid();
const text = z.string().trim().min(1).max(2000);
export const customerInput = z
  .object({
    name: text.max(200),
    kind: z.enum(["residential", "commercial"]),
    email: z.email(),
    phone: z.string().max(40).default(""),
    billing_address: text,
  })
  .strict();
export const locationInput = z
  .object({ address: text, instructions: z.string().max(2000).default("") })
  .strict();
export const orderInput = z
  .object({
    customer_id: uuid,
    location_id: uuid,
    kind: z.enum([
      "delivery",
      "pickup",
      "exchange",
      "relocation",
      "live_load",
      "extra_pickup",
      "bulk",
      "disposal",
      "recurring",
    ]),
    scheduled_date: z.iso.date(),
    instructions: z.string().max(2000).default(""),
    price_cents: z.number().int().min(0).max(100000000),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    fee_policies: feeSelections.optional(),
    pricebook_id: uuid.optional(),
    pricebook_version: z.number().int().positive().optional(),
    parent_order_id: uuid.optional(),
    depends_on_parent: z.boolean().default(false),
  })
  .strict();
export const assignInput = z
  .object({
    driver_id: uuid,
    truck_id: uuid,
    version: z.number().int().positive(),
  })
  .strict();
export const containerVerificationInput = z
  .object({
    container_number: z.string().trim().min(1).max(80),
    replacement_container_number: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export const transitionInput = z
  .object({
    status: z.enum(["in_progress", "arrived", "completed", "failed"]),
    performed_at: z.iso.datetime().optional(),
    version: z.number().int().positive(),
    note: z.string().trim().max(2000).default(""),
    service_date: z.iso.date().optional(),
    container_verification: containerVerificationInput.optional(),
  })
  .strict();
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues);
  return result.data;
}
export function permit(actor: Actor, roles: string[]) {
  if (!roles.includes(actor.role)) throw new ForbiddenException();
}
export const OFFICE = ["owner", "manager", "dispatcher", "office"];
export const FINANCE = ["owner", "manager", "accountant"];
export function assertRouteDependencies(orders: any[], orderIds: string[]) {
  const positions = new Map(orderIds.map((id, index) => [id, index])),
    byId = new Map(orders.map((o) => [o.id, o]));
  for (const order of orders)
    if (
      order.depends_on_parent &&
      positions.has(order.id) &&
      positions.has(order.parent_order_id) &&
      !["completed", "invoiced"].includes(
        byId.get(order.parent_order_id)?.status,
      ) &&
      positions.get(order.parent_order_id)! > positions.get(order.id)!
    )
      throw new ConflictException(
        "Place the parent service before its dependent child stop",
      );
}
export class Operations {
  constructor(readonly pool: Pool) {}
  async command(
    actor: Actor,
    key: string | undefined,
    input: unknown,
    action: (c: PoolClient) => Promise<unknown>,
  ) {
    if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
      throw new BadRequestException(
        "A unique Idempotency-Key (8–128 letters, numbers, _ or -) is required",
      );
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        actor.id + ":" + key,
      ]);
      const existing = (
        await c.query("SELECT * FROM commands WHERE actor_id=$1 AND key=$2", [
          actor.id,
          key,
        ])
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== hash)
          throw new ConflictException(
            "Idempotency key reused with different request",
          );
        await c.query("COMMIT");
        return existing.response;
      }
      const result = await action(c);
      await c.query(
        "INSERT INTO commands(actor_id,key,request_hash,response) VALUES($1,$2,$3,$4)",
        [actor.id, key, hash, JSON.stringify(result)],
      );
      const affected =
        result && typeof result === "object" && "customer_id" in result
          ? (result as { customer_id?: unknown }).customer_id
          : actor.customer_id;
      await c.query("SELECT pg_notify('corewaste_changes',$1)", [
        JSON.stringify({
          customer_id: typeof affected === "string" ? affected : null,
        }),
      ]);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      const code = (e as { code?: string }).code;
      if (code === "23P01")
        throw new ConflictException(
          (e as { constraint?: string }).constraint ===
            "agreement_actual_date_once"
            ? "Two service occurrences would share a date; review the calendar"
            : "Container is already booked for the requested dates",
        );
      if (code === "23505")
        throw new ConflictException("Record already exists");
      if (code === "23503" || code === "23514")
        throw new BadRequestException(
          "Referenced record or business constraint is invalid",
        );
      throw e;
    } finally {
      c.release();
    }
  }
  async audit(
    c: PoolClient,
    a: Actor,
    action: string,
    id: string,
    detail: unknown = {},
  ) {
    await c.query(
      "INSERT INTO audit_log(actor_id,action,entity_id,detail) VALUES($1,$2,$3,$4)",
      [a.id, action, id, JSON.stringify(detail)],
    );
  }
  async customers(a: Actor, query: unknown = {}) {
    permit(a, [...OFFICE, ...FINANCE, "customer"]);
    const q = parse(
      z
        .object({
          search: z.string().max(200).default(""),
          status: z.enum(["active", "suspended"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(500),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
        })
        .strict(),
      query,
    );
    return (
      await this.pool.query(
        "SELECT * FROM customers WHERE ($1::uuid IS NULL OR id=$1) AND (name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2 OR billing_address ILIKE $2) AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC LIMIT $4 OFFSET $5",
        [
          a.role === "customer" ? a.customer_id : null,
          "%" + q.search + "%",
          q.status || null,
          q.limit,
          q.offset,
        ],
      )
    ).rows;
  }
  async createCustomer(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(customerInput, body);
    return this.command(a, key, ["customer", b], async (c) => {
      const r = (
        await c.query(
          "INSERT INTO customers(name,kind,email,phone,billing_address) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [b.name, b.kind, b.email, b.phone, b.billing_address],
        )
      ).rows[0];
      await this.audit(c, a, "customer.created", r.id);
      return r;
    });
  }
  async locations(a: Actor, id: string) {
    parse(uuid, id);
    permit(a, [...OFFICE, ...FINANCE, "customer"]);
    if (a.role === "customer" && a.customer_id !== id)
      throw new ForbiddenException();
    return (
      await this.pool.query(
        "SELECT * FROM locations WHERE customer_id=$1 AND active",
        [id],
      )
    ).rows;
  }
  async createLocation(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(locationInput, body);
    return this.command(a, key, ["location", id, b], async (c) => {
      if (
        !(await c.query("SELECT 1 FROM customers WHERE id=$1", [id])).rowCount
      )
        throw new NotFoundException("Customer not found");
      const r = (
        await c.query(
          "INSERT INTO locations(customer_id,address,instructions) VALUES($1,$2,$3) RETURNING *",
          [id, b.address, b.instructions],
        )
      ).rows[0];
      await this.audit(c, a, "location.created", r.id);
      return r;
    });
  }
  async orders(a: Actor, query: unknown = {}) {
    permit(a, [...OFFICE, ...FINANCE, "driver", "customer"]);
    const q = parse(
      z
        .object({
          search: z.string().max(200).default(""),
          status: z
            .enum([
              "new",
              "assigned",
              "in_progress",
              "completed",
              "failed",
              "invoiced",
              "cancelled",
            ])
            .optional(),
          date: z.iso.date().optional(),
          from_date: z.iso.date().optional(),
          through_date: z.iso.date().optional(),
          customer_id: uuid.optional(),
          priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
          sort: z.enum(["newest", "date", "priority"]).default("newest"),
          limit: z.coerce.number().int().min(1).max(500).default(500),
          offset: z.coerce.number().int().min(0).max(1000000).default(0),
        })
        .strict(),
      query,
    );
    if (
      q.from_date &&
      q.through_date &&
      (q.from_date > q.through_date ||
        Date.parse(q.through_date) - Date.parse(q.from_date) > 62 * 86400000)
    )
      throw new BadRequestException("Choose a service range of up to 63 days");
    return (
      await this.pool.query(
        `SELECT o.*,s.route_id,p.number AS parent_order_number,p.status AS parent_status,c.name AS customer_name,l.address,e.display_name AS driver_name,t.number AS truck_number,t.status AS truck_status,j.rental_id,j.action AS rental_action,co.number AS container_number,rep.number AS replacement_container_number,cv.container_number AS confirmed_container_number,cv.replacement_container_number AS confirmed_replacement_container_number,cv.verified_at AS container_verified_at,co.status AS container_status,dt.id AS disposal_ticket_id,dl.id AS disposal_load_id,dl.assigned_driver_id AS disposal_driver_id, CASE WHEN $8::boolean THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(task ORDER BY task.created_at,task.id) FROM order_tasks task WHERE task.order_id=o.id),'[]'::jsonb) END AS tasks FROM orders o LEFT JOIN route_stops s ON s.order_id=o.id LEFT JOIN orders p ON p.id=o.parent_order_id JOIN customers c ON c.id=o.customer_id JOIN locations l ON l.id=o.location_id LEFT JOIN employees e ON e.id=o.driver_id LEFT JOIN trucks t ON t.id=o.truck_id LEFT JOIN rental_jobs j ON j.order_id=o.id LEFT JOIN containers co ON co.id=j.container_id LEFT JOIN containers rep ON rep.id=j.replacement_container_id LEFT JOIN container_verifications cv ON cv.order_id=o.id LEFT JOIN disposal_tickets dt ON dt.order_id=o.id LEFT JOIN disposal_loads dl ON dl.order_id=o.id WHERE ($1::uuid IS NULL OR o.driver_id=$1) AND ($2::uuid IS NULL OR o.customer_id=$2) AND (c.name ILIKE $3 OR l.address ILIKE $3 OR o.instructions ILIKE $3 OR ('CW-O'||lpad(o.number::text,GREATEST(6,length(o.number::text)),'0')) ILIKE $3) AND ($4::text IS NULL OR o.status=$4) AND ($5::date IS NULL OR o.scheduled_date=$5) AND ($9::uuid IS NULL OR o.customer_id=$9) AND ($10::text IS NULL OR o.priority=$10) AND ($12::date IS NULL OR o.scheduled_date>=$12) AND ($13::date IS NULL OR o.scheduled_date<=$13) ORDER BY CASE WHEN $11='priority' THEN CASE o.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ELSE 0 END,CASE WHEN $11 IN ('priority','date') THEN o.scheduled_date END,o.created_at DESC LIMIT $6 OFFSET $7`,
        [
          a.role === "driver" ? a.id : null,
          a.role === "customer" ? a.customer_id : null,
          "%" + q.search + "%",
          q.status || null,
          q.date || null,
          q.limit,
          q.offset,
          a.role === "customer",
          q.customer_id || null,
          q.priority || null,
          q.sort,
          q.from_date || null,
          q.through_date || null,
        ],
      )
    ).rows;
  }
  async createOrder(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(orderInput, body);
    if (Boolean(b.pricebook_id) !== Boolean(b.pricebook_version))
      throw new BadRequestException(
        "Select a customer rate and its current version together",
      );
    if (b.depends_on_parent && !b.parent_order_id)
      throw new BadRequestException(
        "Choose a parent order before adding a dependency",
      );
    return this.command(a, key, ["order", b], async (c) => {
      if (b.parent_order_id) {
        const parent = (
          await c.query(
            "SELECT * FROM orders WHERE id=$1 AND customer_id=$2 FOR SHARE",
            [b.parent_order_id, b.customer_id],
          )
        ).rows[0];
        if (!parent || parent.status === "cancelled")
          throw new BadRequestException(
            "Choose an existing non-cancelled order for the same customer",
          );
        if (
          (
            await c.query("SELECT 1 FROM rental_jobs WHERE order_id=$1", [
              parent.id,
            ])
          ).rowCount
        )
          throw new BadRequestException(
            "Create related roll-off work through the rental workflow",
          );
      }
      if (
        !(
          await c.query(
            "SELECT 1 FROM customers c JOIN locations l ON l.customer_id=c.id WHERE c.id=$1 AND l.id=$2 AND l.active AND c.status='active' FOR SHARE OF c",
            [b.customer_id, b.location_id],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Active customer and matching service location required",
        );
      let pricingSnapshot: Record<string, unknown> | null = null;
      if (b.pricebook_id) {
        const rate = (
          await c.query(
            "SELECT * FROM customer_pricebooks WHERE id=$1 FOR SHARE",
            [b.pricebook_id],
          )
        ).rows[0];
        if (
          !rate ||
          rate.customer_id !== b.customer_id ||
          (rate.location_id && rate.location_id !== b.location_id) ||
          rate.kind !== b.kind
        )
          throw new BadRequestException(
            "Rate must match the selected customer, location and service",
          );
        if (
          rate.version !== b.pricebook_version ||
          !rate.active ||
          b.scheduled_date < rate.effective_from ||
          (rate.effective_to && b.scheduled_date > rate.effective_to)
        )
          throw new ConflictException(
            "Customer rate changed or is not effective on the service date",
          );
        if (rate.price_cents !== b.price_cents)
          throw new ConflictException(
            "Quoted price differs from the selected customer rate; refresh the quote",
          );
        pricingSnapshot = {
          id: rate.id,
          version: rate.version,
          name: rate.name,
          description: rate.description,
          kind: rate.kind,
          price_cents: rate.price_cents,
          effective_from: rate.effective_from,
          effective_to: rate.effective_to,
        };
      }
      const fees = await snapshotFees(
        c,
        b.customer_id,
        b.scheduled_date,
        b.price_cents,
        b.fee_policies || [],
      );
      const r = (
        await c.query(
          "INSERT INTO orders(customer_id,location_id,kind,scheduled_date,instructions,price_cents,priority,parent_order_id,depends_on_parent,pricebook_id,pricing_snapshot,fee_snapshot,fee_total_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
          [
            b.customer_id,
            b.location_id,
            b.kind,
            b.scheduled_date,
            b.instructions,
            b.price_cents,
            b.priority,
            b.parent_order_id || null,
            b.depends_on_parent,
            b.pricebook_id || null,
            pricingSnapshot ? JSON.stringify(pricingSnapshot) : null,
            JSON.stringify(fees.snapshot),
            fees.total,
          ],
        )
      ).rows[0];
      await this.event(c, a, r.id, "new", "");
      await this.audit(c, a, "order.created", r.id);
      return r;
    });
  }
  async event(
    c: PoolClient,
    a: Actor,
    id: string,
    status: string,
    note: string,
    performedAt?: string,
    statusChange = false,
  ) {
    const event = (
      await c.query(
        "INSERT INTO order_events(order_id,actor_id,status,note,driver_id,truck_id,performed_at) SELECT $1,$2,$3,$4,driver_id,truck_id,COALESCE($5::timestamptz,now()) FROM orders WHERE id=$1 RETURNING id",
        [id, a.id, status, note, performedAt || null],
      )
    ).rows[0];
    const kinds: Record<string, [string, string, string]> = {
      in_progress: [
        "en_route",
        "Your driver has started service",
        "Your driver is on the way for your scheduled service.",
      ],
      arrived: [
        "arrival",
        "Your driver has arrived",
        "Your driver recorded arrival at your service location.",
      ],
      completed: [
        "service_completed",
        "Your service is complete",
        "Your scheduled service has been marked complete.",
      ],
      failed: [
        "missed_pickup",
        "Your service needs attention",
        "Your driver could not complete the scheduled service. Contact the office to arrange the next step.",
      ],
    };
    if (kinds[status]) {
      // Assignment snapshots do not represent another departure.
      if (status === "in_progress" && !statusChange) return;
      const order = (
        await c.query(
          "SELECT o.customer_id,l.address FROM orders o JOIN locations l ON l.id=o.location_id WHERE o.id=$1",
          [id],
        )
      ).rows[0];
      const [kind, subject, message] = kinds[status];
      await notify(
        c,
        order.customer_id,
        kind,
        subject,
        message + " Location: " + order.address,
        "order-event:" + event.id,
      );
    }
  }
  async locked(c: PoolClient, id: string) {
    const job = (
      await c.query("SELECT rental_id FROM rental_jobs WHERE order_id=$1", [id])
    ).rows[0];
    if (job) {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('corewaste-container-scheduling'))",
      );
      await c.query("SELECT id FROM rentals WHERE id=$1 FOR UPDATE", [
        job.rental_id,
      ]);
    }
    const r = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!r) throw new NotFoundException("Order not found");
    return r;
  }
  async assign(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(assignInput, body);
    return this.command(a, key, ["assign", id, b], async (c) => {
      const o = await this.locked(c, id);
      if (
        (await c.query("SELECT 1 FROM route_stops WHERE order_id=$1", [id]))
          .rowCount
      )
        throw new ConflictException(
          "Order belongs to a route; route reassignment is not yet supported",
        );
      if (o.version !== b.version)
        throw new ConflictException("Order changed; reload before assigning");
      if (!["new", "assigned", "in_progress"].includes(o.status))
        throw new ConflictException("Order cannot be assigned");
      if (
        !(
          await c.query(
            "SELECT 1 FROM employees WHERE id=$1 AND role='driver' AND active FOR SHARE",
            [b.driver_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Active driver required");
      if (
        !(
          await c.query(
            "SELECT 1 FROM trucks WHERE id=$1 AND status='available' FOR SHARE",
            [b.truck_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Available truck required");
      const r = (
        await c.query(
          "UPDATE orders SET driver_id=$2,truck_id=$3,status=CASE WHEN status='new' THEN 'assigned' ELSE status END,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.driver_id, b.truck_id],
        )
      ).rows[0];
      await this.event(c, a, id, r.status, "Assignment updated");
      await this.audit(c, a, "order.assigned", id, b);
      return r;
    });
  }
  async transition(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, ["owner", "manager", "driver"]);
    parse(uuid, id);
    const b = parse(transitionInput, body);
    if (b.container_verification && b.status !== "completed")
      throw new BadRequestException(
        "Container verification belongs to service completion",
      );
    if (
      b.performed_at &&
      (Date.parse(b.performed_at) > Date.now() + 300000 ||
        Date.now() - Date.parse(b.performed_at) > 7 * 86400000)
    )
      throw new BadRequestException(
        "Service timestamp must be within the last seven days",
      );
    return this.command(a, key, ["transition", id, b], async (c) => {
      const o = await this.locked(c, id);
      if (a.role === "driver" && o.driver_id !== a.id)
        throw new ForbiddenException();
      if (o.version !== b.version)
        throw new ConflictException("Order changed; reload before updating");
      if (
        b.status === "in_progress" &&
        !(
          await c.query(
            "SELECT 1 FROM customers WHERE id=$1 AND status='active'",
            [o.customer_id],
          )
        ).rowCount &&
        !(
          await c.query(
            "SELECT 1 FROM rental_jobs WHERE order_id=$1 AND action='pickup'",
            [o.id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Customer service is suspended; contact dispatch",
        );
      if (
        b.status === "in_progress" &&
        !(
          await c.query(
            "SELECT 1 FROM trucks WHERE id=$1 AND status='available' FOR SHARE",
            [o.truck_id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Assigned truck is unavailable; contact dispatch",
        );
      if (b.status === "in_progress" && o.depends_on_parent) {
        const parent = (
          await c.query("SELECT status FROM orders WHERE id=$1 FOR SHARE", [
            o.parent_order_id,
          ])
        ).rows[0];
        if (!parent || !["completed", "invoiced"].includes(parent.status))
          throw new ConflictException(
            "Complete the parent service before starting this dependent order",
          );
      }
      if (b.status === "in_progress") await assertRentalStart(c, id);
      const allowed: Record<string, string[]> = {
        assigned: ["in_progress", "failed"],
        in_progress: ["arrived", "completed", "failed"],
      };
      if (!allowed[o.status]?.includes(b.status))
        throw new ConflictException("Invalid order transition");
      if (b.status === "arrived" && o.arrived_at)
        throw new ConflictException("Arrival is already recorded");
      if (b.status === "failed" && !b.note)
        throw new BadRequestException("Failure reason required");
      if (
        b.status === "completed" &&
        (
          await c.query(
            "SELECT 1 FROM order_tasks WHERE order_id=$1 AND required AND completed_at IS NULL",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Complete required tasks before completing service",
        );
      if (b.status === "completed")
        await completeRentalJob(
          c,
          a,
          {
            ...o,
            scheduled_date:
              b.service_date ||
              (
                await c.query(
                  "SELECT (COALESCE($1::timestamptz,now()) AT TIME ZONE timezone)::date AS date FROM company_settings WHERE singleton",
                  [b.performed_at || null],
                )
              ).rows[0].date,
          },
          b.container_verification,
          b.performed_at,
        );
      const r = (
        await c.query(
          "UPDATE orders SET status=CASE WHEN $2='arrived' THEN status ELSE $2 END,completion_note=CASE WHEN $2 IN ('completed','failed') THEN $3 ELSE completion_note END,arrived_at=CASE WHEN $2='arrived' THEN COALESCE($4::timestamptz,now()) ELSE arrived_at END,completed_at=CASE WHEN $2='completed' THEN COALESCE($4::timestamptz,now()) ELSE completed_at END,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.status, b.note, b.performed_at || null],
        )
      ).rows[0];
      await this.event(c, a, id, b.status, b.note, b.performed_at, true);
      await this.audit(c, a, "order." + b.status, id);
      return r;
    });
  }
  async invoice(a: Actor, key: string | undefined, id: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    return this.command(a, key, ["invoice", id], async (c) => {
      const o = await this.locked(c, id);
      if (
        (await c.query("SELECT 1 FROM rental_jobs WHERE order_id=$1", [id]))
          .rowCount
      )
        throw new ConflictException(
          "Invoice the rental after final pickup; rental jobs are not billed separately",
        );
      if (
        o.agreement_id &&
        (
          await c.query(
            "SELECT 1 FROM service_agreements WHERE id=$1 AND billing_mode='monthly'",
            [o.agreement_id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Monthly contract visits are billed together through monthly billing",
        );
      const existing = (
        await c.query("SELECT * FROM invoices WHERE order_id=$1", [id])
      ).rows[0];
      if (existing) return existing;
      if (o.status !== "completed")
        throw new ConflictException("Only completed service can be invoiced");
      const total = o.price_cents + o.fee_total_cents;
      const r = (
        await c.query(
          "INSERT INTO invoices(customer_id,order_id,amount_cents,status) VALUES($1,$2,$3,CASE WHEN $3::int=0 THEN 'paid' ELSE 'open' END) RETURNING *",
          [o.customer_id, id, total],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO invoice_lines(invoice_id,description,amount_cents) VALUES($1,$2,$3)",
        [
          r.id,
          [
            o.kind + " service · " + o.scheduled_date,
            o.pricing_snapshot?.name,
            o.pricing_snapshot?.description,
          ]
            .filter(Boolean)
            .join(" · "),
          o.price_cents,
        ],
      );
      if (o.price_cents > 0)
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents) VALUES($1,'accounts_receivable','service_revenue',$2)",
          [r.id, o.price_cents],
        );
      for (const fee of o.fee_snapshot)
        await c.query(
          "INSERT INTO invoice_lines(invoice_id,description,amount_cents) VALUES($1,$2,$3)",
          [r.id, fee.kind + " fee · " + fee.name, fee.amount_cents],
        );
      if (o.fee_total_cents > 0)
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,'accounts_receivable','fee_revenue',$2,'invoice_fees',$1)",
          [r.id, o.fee_total_cents],
        );
      await c.query(
        "UPDATE orders SET status='invoiced',version=version+1 WHERE id=$1",
        [id],
      );
      await this.event(c, a, id, "invoiced", "");
      await notify(
        c,
        o.customer_id,
        "invoice_generated",
        "Your invoice is ready",
        "Invoice " + r.number + " is available in your customer portal.",
        "invoice:" + r.id,
      );
      await this.audit(c, a, "invoice.created", r.id);
      return r;
    });
  }
  async invoices(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE, "customer"]);
    return (
      await this.pool.query(
        "SELECT i.*,c.name AS customer_name FROM invoice_balances i JOIN customers c ON c.id=i.customer_id WHERE ($1::uuid IS NULL OR customer_id=$1) ORDER BY i.created_at DESC LIMIT 500",
        [a.role === "customer" ? a.customer_id : null],
      )
    ).rows;
  }
  async resources(a: Actor) {
    permit(a, ["owner", "manager", "dispatcher"]);
    return {
      drivers: (
        await this.pool.query(
          "SELECT id,display_name FROM employees WHERE role='driver' AND active ORDER BY display_name",
        )
      ).rows,
      trucks: (
        await this.pool.query(
          "SELECT * FROM trucks WHERE status='available' ORDER BY number",
        )
      ).rows,
    };
  }
}
