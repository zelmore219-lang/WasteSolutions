import { notify } from "./notification-outbox";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { PoolClient } from "pg";
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
const cents = z.number().int().min(0).max(100000000);
export async function schedulingLock(c: PoolClient) {
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtext('corewaste-container-scheduling'))",
  );
}
export class Rentals {
  constructor(readonly ops: Operations) {}
  async containers(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE]);
    return (
      await this.ops.pool.query(
        "SELECT c.*,l.address,y.name AS yard_name,t.number AS carrier_number FROM containers c LEFT JOIN locations l ON l.id=c.location_id LEFT JOIN equipment_yards y ON y.id=c.yard_id LEFT JOIN trucks t ON t.id=c.carried_by_truck_id ORDER BY number LIMIT 1000",
      )
    ).rows;
  }
  async createContainer(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    const b = parse(
      z
        .object({
          number: z.string().trim().min(1).max(80),
          kind: z.enum(["roll_off", "commercial", "cart", "trailer"]),
          capacity_yards: z.number().positive().max(1000).multipleOf(0.01),
          yard_id: uuid.optional(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["container", b], async (c) => {
      if (
        b.yard_id &&
        !(
          await c.query(
            "SELECT 1 FROM equipment_yards WHERE id=$1 AND active FOR SHARE",
            [b.yard_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Active equipment yard required");
      const r = (
        await c.query(
          "INSERT INTO containers(number,kind,capacity_yards,yard_id) VALUES($1,$2,$3,$4) RETURNING *",
          [b.number, b.kind, b.capacity_yards, b.yard_id || null],
        )
      ).rows[0];
      await this.ops.audit(c, a, "container.created", r.id);
      return r;
    });
  }
  async availability(a: Actor, query: unknown) {
    permit(a, OFFICE);
    const b = parse(
      z
        .object({ start_date: z.iso.date(), pickup_date: z.iso.date() })
        .strict(),
      query,
    );
    if (b.pickup_date < b.start_date)
      throw new BadRequestException("Pickup date must follow delivery");
    return (
      await this.ops.pool.query(
        "SELECT * FROM containers c WHERE c.kind='roll_off' AND c.status NOT IN ('maintenance','retired','awaiting_disposal') AND NOT EXISTS(SELECT 1 FROM disposal_loads d WHERE d.container_id=c.id AND d.status<>'disposed') AND NOT EXISTS(SELECT 1 FROM container_bookings b WHERE b.container_id=c.id AND NOT released AND daterange(b.start_date,b.end_date_exclusive,'[)') && daterange($1::date,$2::date+1,'[)')) ORDER BY number",
        [b.start_date, b.pickup_date],
      )
    ).rows;
  }
  async list(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE, "customer"]);
    return (
      await this.ops.pool.query(
        "SELECT r.*,c.name AS customer_name,l.address,co.number AS container_number FROM rentals r JOIN customers c ON c.id=r.customer_id JOIN locations l ON l.id=r.location_id JOIN containers co ON co.id=r.current_container_id WHERE ($1::uuid IS NULL OR r.customer_id=$1) ORDER BY r.created_at DESC LIMIT 500",
        [a.role === "customer" ? a.customer_id : null],
      )
    ).rows;
  }
  async detail(a: Actor, id: string) {
    parse(uuid, id);
    const r = (await this.list(a)).find((r) => r.id === id);
    if (!r) throw new NotFoundException("Rental not found");
    return {
      ...r,
      jobs: (
        await this.ops.pool.query(
          "SELECT j.*,o.status,o.version,o.scheduled_date FROM rental_jobs j JOIN orders o ON o.id=j.order_id WHERE rental_id=$1 ORDER BY o.scheduled_date,o.created_at",
          [id],
        )
      ).rows,
      movements: (
        await this.ops.pool.query(
          "SELECT m.*,c.number FROM container_movements m JOIN containers c ON c.id=m.container_id WHERE rental_id=$1 ORDER BY m.created_at",
          [id],
        )
      ).rows,
      tickets: (
        await this.ops.pool.query(
          "SELECT * FROM disposal_tickets WHERE rental_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows,
    };
  }
  async job(
    c: PoolClient,
    a: Actor,
    r: any,
    action: string,
    date: string,
    containerId: string,
    replacement?: string,
  ) {
    const o = (
      await c.query(
        "INSERT INTO orders(customer_id,location_id,kind,scheduled_date,instructions,price_cents) VALUES($1,$2,$3,$4,$5,0) RETURNING *",
        [
          r.customer_id,
          r.location_id,
          action,
          date,
          `Rental ${r.id}: ${action}; verify container number before service.`,
        ],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO rental_jobs(order_id,rental_id,action,container_id,replacement_container_id) VALUES($1,$2,$3,$4,$5)",
      [o.id, r.id, action, containerId, replacement || null],
    );
    await this.ops.event(c, a, o.id, "new", "Rental " + action);
    return o;
  }
  async reserve(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(
      z
        .object({
          customer_id: uuid,
          location_id: uuid,
          container_id: uuid,
          start_date: z.iso.date(),
          pickup_date: z.iso.date(),
          base_price_cents: cents,
          extension_daily_cents: cents,
          included_weight_kg: z.number().int().min(0).max(10000000),
          overweight_cents_per_tonne: cents,
        })
        .strict(),
      body,
    );
    if (b.pickup_date < b.start_date)
      throw new BadRequestException("Pickup cannot precede delivery");
    return this.ops.command(a, key, ["rental.reserve", b], async (c) => {
      await schedulingLock(c);
      if (
        !(
          await c.query(
            "SELECT 1 FROM customers c JOIN locations l ON l.customer_id=c.id WHERE c.id=$1 AND l.id=$2 AND l.active AND c.status='active' FOR SHARE OF c",
            [b.customer_id, b.location_id],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Active customer and matching location required",
        );
      const container = (
        await c.query("SELECT * FROM containers WHERE id=$1 FOR UPDATE", [
          b.container_id,
        ])
      ).rows[0];
      if (
        !container ||
        container.kind !== "roll_off" ||
        ["maintenance", "retired", "awaiting_disposal"].includes(
          container.status,
        )
      )
        throw new ConflictException("Serviceable roll-off container required");
      if (
        (
          await c.query(
            "SELECT 1 FROM disposal_loads WHERE container_id=$1 AND status<>'disposed'",
            [container.id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Container has an unresolved disposal load",
        );
      const r = (
        await c.query(
          "INSERT INTO rentals(customer_id,location_id,current_container_id,start_date,original_pickup_date,pickup_date,base_price_cents,extension_daily_cents,included_weight_kg,overweight_cents_per_tonne) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) RETURNING *",
          [
            b.customer_id,
            b.location_id,
            b.container_id,
            b.start_date,
            b.pickup_date,
            b.base_price_cents,
            b.extension_daily_cents,
            b.included_weight_kg,
            b.overweight_cents_per_tonne,
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO container_bookings(container_id,rental_id,start_date,end_date_exclusive) VALUES($1,$2,$3,$4::date+1)",
        [b.container_id, r.id, b.start_date, b.pickup_date],
      );
      const delivery = await this.job(
        c,
        a,
        r,
        "delivery",
        r.start_date,
        b.container_id,
      );
      const pickup = await this.job(
        c,
        a,
        r,
        "pickup",
        r.pickup_date,
        b.container_id,
      );
      await this.ops.audit(c, a, "rental.reserved", r.id);
      return {
        ...r,
        delivery_order_id: delivery.id,
        pickup_order_id: pickup.id,
      };
    });
  }
  async locked(c: PoolClient, id: string, version?: number) {
    await schedulingLock(c);
    const r = (
      await c.query("SELECT * FROM rentals WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!r) throw new NotFoundException("Rental not found");
    if (version !== undefined && r.version !== version)
      throw new ConflictException("Rental changed; refresh and retry");
    return r;
  }
  async extend(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          pickup_date: z.iso.date(),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["rental.extend", id, b], async (c) => {
      const r = await this.locked(c, id, b.version);
      if (
        !["reserved", "delivered"].includes(r.status) ||
        b.pickup_date <= r.pickup_date
      )
        throw new ConflictException(
          "Only open rentals can be extended to a later date",
        );
      const pickup = (
        await c.query(
          "SELECT o.* FROM rental_jobs j JOIN orders o ON o.id=j.order_id WHERE j.rental_id=$1 AND j.action='pickup' FOR UPDATE OF o",
          [id],
        )
      ).rows[0];
      if (!["new", "assigned"].includes(pickup.status))
        throw new ConflictException("Pickup has already started");
      await c.query(
        "UPDATE container_bookings SET end_date_exclusive=$2::date+1 WHERE rental_id=$1 AND NOT released AND end_date_exclusive=(SELECT pickup_date+1 FROM rentals WHERE id=$1)",
        [id, b.pickup_date],
      );
      await c.query(
        "UPDATE orders SET scheduled_date=$2,version=version+1 WHERE id=$1",
        [pickup.id, b.pickup_date],
      );
      // Routed pickups must be moved through dispatch first; silently changing route dates is unsafe.
      if (
        (
          await c.query("SELECT 1 FROM route_stops WHERE order_id=$1", [
            pickup.id,
          ])
        ).rowCount
      )
        throw new ConflictException(
          "Remove pickup from its route before extending",
        );
      const updated = (
        await c.query(
          "UPDATE rentals SET pickup_date=$2,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.pickup_date],
        )
      ).rows[0];
      await this.ops.audit(c, a, "rental.extended", id, b);
      return updated;
    });
  }
  async exchange(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          replacement_container_id: uuid,
          service_date: z.iso.date(),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["rental.exchange", id, b], async (c) => {
      const r = await this.locked(c, id, b.version);
      if (
        r.status !== "delivered" ||
        b.service_date < r.start_date ||
        b.service_date > r.pickup_date ||
        b.replacement_container_id === r.current_container_id
      )
        throw new ConflictException(
          "Exchange requires a delivered rental, another container and a date in the rental period",
        );
      const pending = (
        await c.query(
          "SELECT 1 FROM rental_jobs j JOIN orders o ON o.id=j.order_id WHERE rental_id=$1 AND (j.action='exchange' AND o.status NOT IN ('completed','invoiced') OR j.action='pickup' AND o.status NOT IN ('new','assigned'))",
          [id],
        )
      ).rowCount;
      if (pending)
        throw new ConflictException(
          "Outstanding exchange or started pickup prevents exchange",
        );
      const replacement = (
        await c.query("SELECT * FROM containers WHERE id=$1 FOR UPDATE", [
          b.replacement_container_id,
        ])
      ).rows[0];
      if (
        !replacement ||
        replacement.kind !== "roll_off" ||
        ["maintenance", "retired"].includes(replacement.status)
      )
        throw new ConflictException(
          "Serviceable replacement roll-off required",
        );
      await c.query(
        "INSERT INTO container_bookings(container_id,rental_id,start_date,end_date_exclusive) VALUES($1,$2,$3,$4::date+1)",
        [replacement.id, id, b.service_date, r.pickup_date],
      );
      const order = await this.job(
        c,
        a,
        r,
        "exchange",
        b.service_date,
        r.current_container_id,
        replacement.id,
      );
      await c.query("UPDATE rentals SET version=version+1 WHERE id=$1", [id]);
      await this.ops.audit(c, a, "rental.exchange_scheduled", id, {
        order_id: order.id,
      });
      return order;
    });
  }
  async cancel(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
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
    return this.ops.command(a, key, ["rental.cancel", id, b], async (c) => {
      const r = await this.locked(c, id, b.version);
      if (r.status !== "reserved")
        throw new ConflictException(
          "Only undelivered rentals may be cancelled",
        );
      const jobs = (
        await c.query(
          "SELECT o.* FROM rental_jobs j JOIN orders o ON o.id=j.order_id WHERE j.rental_id=$1 ORDER BY o.id FOR UPDATE OF o",
          [id],
        )
      ).rows;
      if (jobs.some((o) => !["new", "assigned"].includes(o.status)))
        throw new ConflictException("A rental job has started");
      await c.query(
        "UPDATE container_bookings SET released=true WHERE rental_id=$1",
        [id],
      );
      // Cancelled rental jobs remain in history; no silent deletion of operational records.
      for (const o of jobs) {
        await c.query(
          "UPDATE orders SET status='cancelled',version=version+1 WHERE id=$1",
          [o.id],
        );
        await this.ops.event(c, a, o.id, "cancelled", b.reason);
      }
      const updated = (
        await c.query(
          "UPDATE rentals SET status='cancelled',version=version+1 WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await this.ops.audit(c, a, "rental.cancelled", id, b);
      return updated;
    });
  }
  async disposal(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, [...OFFICE, "accountant", "driver"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          order_id: uuid,
          facility: z.string().trim().min(1).max(200),
          ticket_number: z.string().trim().min(1).max(100),
          gross_kg: z.number().int().positive().max(1000000),
          tare_kg: z.number().int().min(0).max(1000000),
          disposal_cost_cents: cents,
        })
        .strict(),
      body,
    );
    if (b.tare_kg > b.gross_kg)
      throw new BadRequestException("Tare exceeds gross");
    return this.ops.command(a, key, ["rental.disposal", id, b], async (c) => {
      const r = await this.locked(c, id);
      if (r.status === "invoiced" || r.status === "cancelled")
        throw new ConflictException("Rental is closed");
      const job = (
        await c.query(
          "SELECT j.*,o.driver_id,o.status FROM rental_jobs j JOIN orders o ON o.id=j.order_id WHERE j.rental_id=$1 AND j.order_id=$2 AND j.action IN ('exchange','pickup')",
          [id, b.order_id],
        )
      ).rows[0];
      if (!job || !["completed", "invoiced"].includes(job.status))
        throw new ConflictException("Completed exchange or pickup required");
      const load = (
        await c.query(
          "SELECT * FROM disposal_loads WHERE order_id=$1 FOR UPDATE",
          [b.order_id],
        )
      ).rows[0];
      if (
        a.role === "driver" &&
        (load ? load.assigned_driver_id !== a.id : job.driver_id !== a.id)
      )
        throw new ConflictException(
          "Ticket must belong to your assigned disposal task",
        );
      if (load?.status === "disposed")
        throw new ConflictException("Disposal load is already complete");
      const ticket = (
        await c.query(
          "INSERT INTO disposal_tickets(rental_id,order_id,facility,ticket_number,gross_kg,tare_kg,disposal_cost_cents) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            id,
            b.order_id,
            b.facility,
            b.ticket_number,
            b.gross_kg,
            b.tare_kg,
            b.disposal_cost_cents,
          ],
        )
      ).rows[0];
      let completedLoad: any;
      if (load) {
        completedLoad = (
          await c.query(
            "UPDATE disposal_loads SET status='disposed',disposal_ticket_id=$2,disposed_at=now(),version=version+1 WHERE id=$1 RETURNING id,version",
            [load.id, ticket.id],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO disposal_load_events(load_id,actor_id,action,note) VALUES($1,$2,'disposed',$3)",
          [load.id, a.id, "Verified facility ticket " + b.ticket_number],
        );
        await c.query(
          "UPDATE containers SET status='yard',version=version+1 WHERE id=$1 AND status='awaiting_disposal' AND NOT EXISTS(SELECT 1 FROM disposal_loads d WHERE d.container_id=$1 AND d.status<>'disposed')",
          [load.container_id],
        );
      }
      await this.ops.audit(c, a, "disposal.recorded", ticket.id);
      return {
        ...ticket,
        ...(completedLoad
          ? {
              disposal_load_id: completedLoad.id,
              disposal_load_version: completedLoad.version,
            }
          : {}),
      };
    });
  }
  async invoice(a: Actor, key: string | undefined, id: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    return this.ops.command(a, key, ["rental.invoice", id], async (c) => {
      const r = await this.locked(c, id);
      const previous = (
        await c.query("SELECT * FROM invoices WHERE rental_id=$1", [id])
      ).rows[0];
      if (previous) return previous;
      if (r.status !== "collected")
        throw new ConflictException(
          "Final pickup must be completed before billing",
        );
      const missing = (
        await c.query(
          "SELECT 1 FROM rental_jobs j JOIN orders o ON o.id=j.order_id LEFT JOIN disposal_tickets t ON t.order_id=j.order_id WHERE j.rental_id=$1 AND j.action IN ('exchange','pickup') AND o.status='completed' AND t.id IS NULL",
          [id],
        )
      ).rowCount;
      if (missing)
        throw new ConflictException(
          "Record disposal tickets for each collected load before billing",
        );
      const days = Number(
        (
          await c.query("SELECT GREATEST(0,$1::date-$2::date) AS days", [
            r.actual_pickup_date,
            r.original_pickup_date,
          ])
        ).rows[0].days,
      );
      const weight = Number(
        (
          await c.query(
            "SELECT COALESCE(sum(net_kg),0)::int AS kg FROM disposal_tickets WHERE rental_id=$1",
            [id],
          )
        ).rows[0].kg,
      );
      const overweight = Math.max(0, weight - r.included_weight_kg);
      // Metric tonnes are explicit; all arithmetic uses integer minor units and half-up rounding.
      const weightCharge = Number(
        (BigInt(overweight) * BigInt(r.overweight_cents_per_tonne) + 500n) /
          1000n,
      );
      const lines = [
        { description: "Base rental", amount_cents: r.base_price_cents },
        {
          description: `Extension (${days} days)`,
          amount_cents: days * r.extension_daily_cents,
        },
        {
          description: `Overweight (${overweight} kg above allowance)`,
          amount_cents: weightCharge,
        },
      ];
      const total = lines.reduce((sum, l) => sum + l.amount_cents, 0);
      if (!Number.isSafeInteger(total) || total > 100000000)
        throw new BadRequestException("Invoice total exceeds supported limit");
      const invoice = (
        await c.query(
          "INSERT INTO invoices(customer_id,rental_id,amount_cents,status) VALUES($1,$2,$3,CASE WHEN $3::int=0 THEN 'paid' ELSE 'open' END) RETURNING *",
          [r.customer_id, id, total],
        )
      ).rows[0];
      for (const l of lines)
        await c.query(
          "INSERT INTO invoice_lines(invoice_id,description,amount_cents) VALUES($1,$2,$3)",
          [invoice.id, l.description, l.amount_cents],
        );
      if (total > 0)
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents) VALUES($1,'accounts_receivable','rental_revenue',$2)",
          [invoice.id, total],
        );
      await c.query(
        "UPDATE rentals SET status='invoiced',version=version+1 WHERE id=$1",
        [id],
      );
      await notify(
        c,
        r.customer_id,
        "invoice_generated",
        "Your rental invoice is ready",
        "Invoice " + invoice.number + " is available in your customer portal.",
        "invoice:" + invoice.id,
      );
      await this.ops.audit(c, a, "rental.invoiced", id, {
        invoice_id: invoice.id,
      });
      return { ...invoice, lines };
    });
  }
}
