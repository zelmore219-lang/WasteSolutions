import { calendarLock, calendarPolicy } from "./calendar-policy";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import {
  Actor,
  Operations,
  OFFICE,
  parse,
  permit,
  uuid,
  assertRouteDependencies,
} from "./domain";
export class Workflows {
  constructor(readonly ops: Operations) {}
  async requests(a: Actor) {
    permit(a, [...OFFICE, "customer"]);
    return (
      await this.ops.pool.query(
        "SELECT r.*,c.name AS customer_name,l.address FROM service_requests r JOIN customers c ON c.id=r.customer_id JOIN locations l ON l.id=r.location_id WHERE ($1::uuid IS NULL OR r.customer_id=$1) ORDER BY r.created_at DESC LIMIT 500",
        [a.role === "customer" ? a.customer_id : null],
      )
    ).rows;
  }
  async request(a: Actor, key: string | undefined, body: unknown) {
    permit(a, [...OFFICE, "customer"]);
    const b = parse(
      z
        .object({
          customer_id: uuid,
          location_id: uuid,
          kind: z.enum([
            "extra_pickup",
            "bulk",
            "delivery",
            "missed_pickup",
            "support",
          ]),
          description: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    if (a.role === "customer" && a.customer_id !== b.customer_id)
      throw new ForbiddenException();
    return this.ops.command(a, key, ["request", b], async (c) => {
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
      const r = (
        await c.query(
          "INSERT INTO service_requests(customer_id,location_id,kind,description) VALUES($1,$2,$3,$4) RETURNING *",
          [b.customer_id, b.location_id, b.kind, b.description],
        )
      ).rows[0];
      await this.ops.audit(c, a, "request.created", r.id);
      return r;
    });
  }
  async convert(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          scheduled_date: z.iso.date(),
          price_cents: z.number().int().min(0).max(100000000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["convert", id, b], async (c) => {
      const r = (
        await c.query("SELECT * FROM service_requests WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!r) throw new NotFoundException();
      if (r.status !== "open")
        throw new ConflictException("Request already processed");
      if (r.kind === "support")
        throw new BadRequestException(
          "Support requests cannot become service orders",
        );
      if (
        !(
          await c.query(
            "SELECT 1 FROM customers WHERE id=$1 AND status='active' FOR SHARE",
            [r.customer_id],
          )
        ).rowCount
      )
        throw new ConflictException("Customer is suspended");
      const order = (
        await c.query(
          "INSERT INTO orders(customer_id,location_id,kind,scheduled_date,instructions,price_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            r.customer_id,
            r.location_id,
            r.kind === "missed_pickup" ? "extra_pickup" : r.kind,
            b.scheduled_date,
            r.description,
            b.price_cents,
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE service_requests SET status='converted',order_id=$2 WHERE id=$1",
        [id, order.id],
      );
      await this.ops.event(
        c,
        a,
        order.id,
        "new",
        "Created from customer request",
      );
      await this.ops.audit(c, a, "request.converted", id, {
        order_id: order.id,
      });
      return order;
    });
  }
  async routes(a: Actor) {
    permit(a, [...OFFICE, "driver"]);
    const routes = (
      await this.ops.pool.query(
        "SELECT * FROM routes WHERE NOT archived AND ($1::uuid IS NULL OR driver_id=$1) ORDER BY service_date DESC,created_at DESC,id LIMIT 100",
        [a.role === "driver" ? a.id : null],
      )
    ).rows;
    for (const r of routes) {
      r.stops = (
        await this.ops.pool.query(
          "SELECT s.position,o.*,c.name AS customer_name,l.address FROM route_stops s JOIN orders o ON o.id=s.order_id JOIN customers c ON c.id=o.customer_id JOIN locations l ON l.id=o.location_id WHERE route_id=$1 ORDER BY position",
          [r.id],
        )
      ).rows;
    }
    return routes;
  }
  async route(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    const b = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          service_date: z.iso.date(),
          driver_id: uuid,
          truck_id: uuid,
          order_ids: z.array(uuid).min(1).max(250),
        })
        .strict(),
      body,
    );
    if (new Set(b.order_ids).size !== b.order_ids.length)
      throw new BadRequestException("Duplicate stops");
    return this.ops.command(a, key, ["route", b], async (c) => {
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
      // Deterministic locking prevents deadlocks when overlapping routes are submitted concurrently.
      const orders = (
        await c.query(
          "SELECT * FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [b.order_ids],
        )
      ).rows;
      assertRouteDependencies(orders, b.order_ids);
      if (
        orders.length !== b.order_ids.length ||
        orders.some(
          (o) =>
            !["new", "assigned"].includes(o.status) ||
            o.scheduled_date !== b.service_date,
        )
      )
        throw new ConflictException(
          "All stops must be unstarted work on the route date",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM route_stops WHERE order_id=ANY($1::uuid[])",
            [b.order_ids],
          )
        ).rowCount
      )
        throw new ConflictException("An order is already on a route");
      const route = (
        await c.query(
          "INSERT INTO routes(name,service_date,driver_id,truck_id) VALUES($1,$2,$3,$4) RETURNING *",
          [b.name, b.service_date, b.driver_id, b.truck_id],
        )
      ).rows[0];
      for (const [i, id] of b.order_ids.entries()) {
        await c.query(
          "INSERT INTO route_stops(route_id,order_id,position) VALUES($1,$2,$3)",
          [route.id, id, i + 1],
        );
        await c.query(
          "UPDATE orders SET driver_id=$2,truck_id=$3,status='assigned',version=version+1 WHERE id=$1",
          [id, b.driver_id, b.truck_id],
        );
        await this.ops.event(
          c,
          a,
          id,
          "assigned",
          "Assigned to route " + route.name,
        );
      }
      await this.ops.audit(c, a, "route.created", route.id);
      return route;
    });
  }
  async agreements(a: Actor) {
    permit(a, [...OFFICE, "accountant", "customer"]);
    return (
      await this.ops.pool.query(
        "SELECT a.*,c.name AS customer_name,l.address FROM service_agreements a JOIN customers c ON c.id=a.customer_id JOIN locations l ON l.id=a.location_id WHERE ($1::uuid IS NULL OR a.customer_id=$1) ORDER BY next_service_date LIMIT 500",
        [a.role === "customer" ? a.customer_id : null],
      )
    ).rows;
  }
  async agreement(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(
      z
        .object({
          customer_id: uuid,
          location_id: uuid,
          kind: z.enum(["residential", "commercial"]),
          price_cents: z.number().int().min(0).max(100000000),
          interval_days: z.number().int().min(1).max(366),
          next_service_date: z.iso.date(),
          billing_mode: z
            .enum(["per_service", "monthly"])
            .default("per_service"),
          monthly_rate_cents: z.number().int().min(0).max(100000000).optional(),
          billing_alignment: z.enum(["calendar", "anniversary"]).optional(),
          billing_timing: z.enum(["arrears", "advance"]).optional(),
          billing_cycle_months: z
            .union([z.literal(1), z.literal(3), z.literal(12)])
            .optional(),
          contract_end_date: z.iso.date().optional(),
        })
        .strict(),
      body,
    );
    if (b.billing_mode === "monthly" && b.monthly_rate_cents === undefined)
      throw new BadRequestException("Specify the agreed monthly contract rate");
    if (
      b.billing_mode !== "monthly" &&
      ((b.billing_alignment && b.billing_alignment !== "calendar") ||
        (b.billing_cycle_months && b.billing_cycle_months !== 1))
    )
      throw new BadRequestException(
        "Contract cycles require monthly-base contract billing",
      );
    if (b.billing_mode !== "monthly" && b.billing_timing === "advance")
      throw new BadRequestException("Advance billing requires a contract");
    if ((b.monthly_rate_cents || 0) * (b.billing_cycle_months || 1) > 100000000)
      throw new BadRequestException(
        "Full contract period exceeds the supported invoice amount",
      );
    if (b.contract_end_date && b.contract_end_date < b.next_service_date)
      throw new BadRequestException("Contract end cannot precede its start");
    return this.ops.command(a, key, ["agreement", b], async (c) => {
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
      const r = (
        await c.query(
          "INSERT INTO service_agreements(customer_id,location_id,kind,price_cents,interval_days,next_service_date,billing_mode,monthly_rate_cents,contract_start_date,contract_end_date,next_billing_month,billing_alignment,billing_cycle_months,billing_timing) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,CASE WHEN $7='monthly' THEN CASE WHEN $10='anniversary' THEN $6::date ELSE date_trunc('month',$6::date)::date END ELSE NULL END,$10,$11,$12) RETURNING *",
          [
            b.customer_id,
            b.location_id,
            b.kind,
            b.billing_mode === "monthly" ? 0 : b.price_cents,
            b.interval_days,
            b.next_service_date,
            b.billing_mode,
            b.monthly_rate_cents ?? null,
            b.contract_end_date ?? null,
            b.billing_alignment || "calendar",
            b.billing_cycle_months || 1,
            b.billing_timing || "arrears",
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "agreement.created", r.id);
      return r;
    });
  }
  async generate(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(z.object({ through_date: z.iso.date() }).strict(), body);
    return this.ops.command(a, key, ["generate", b], async (c) => {
      await calendarLock(c);
      const datePolicy = await calendarPolicy(c);
      const agreements = (
        await c.query(
          "SELECT a.*,l.zone_id FROM service_agreements a JOIN customers c ON c.id=a.customer_id JOIN locations l ON l.id=a.location_id WHERE a.active AND c.status='active' AND (a.contract_end_date IS NULL OR next_service_date<=a.contract_end_date) AND next_service_date<=$1 ORDER BY a.id FOR UPDATE OF a",
          [b.through_date],
        )
      ).rows;
      // Bound catch-up per transaction. Never advance an agreement beyond successfully generated work.
      let generated = 0;
      for (const agreement of agreements) {
        if (generated >= 1000) break;
        let next = agreement.next_service_date;
        while (
          next <= b.through_date &&
          (!agreement.contract_end_date ||
            next <= agreement.contract_end_date) &&
          generated < 1000
        ) {
          const actualDate = datePolicy(next, agreement.zone_id);
          if (
            (
              await c.query(
                "SELECT 1 FROM orders WHERE agreement_id=$1 AND scheduled_date=$2 AND status<>'cancelled'",
                [agreement.id, actualDate],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Two service occurrences would share a date; review the calendar",
            );
          const o = (
            await c.query(
              "INSERT INTO orders(customer_id,location_id,kind,scheduled_date,price_cents,agreement_id,service_occurrence_date,zone_id) VALUES($1,$2,'recurring',$3,$4,$5,$6,$7) RETURNING *",
              [
                agreement.customer_id,
                agreement.location_id,
                actualDate,
                agreement.price_cents,
                agreement.id,
                next,
                agreement.zone_id,
              ],
            )
          ).rows[0];
          await this.ops.event(c, a, o.id, "new", "Recurring service");
          generated++;
          next = (
            await c.query("SELECT ($1::date+$2::int)::text AS next", [
              next,
              agreement.interval_days,
            ])
          ).rows[0].next;
        }
        await c.query(
          "UPDATE service_agreements SET next_service_date=$2 WHERE id=$1",
          [agreement.id, next],
        );
      }
      const more = (
        await c.query(
          "SELECT EXISTS(SELECT 1 FROM service_agreements a JOIN customers c ON c.id=a.customer_id WHERE a.active AND c.status=\'active\' AND (a.contract_end_date IS NULL OR next_service_date<=a.contract_end_date) AND next_service_date<=$1) AS has_more",
          [b.through_date],
        )
      ).rows[0].has_more;
      return { generated, has_more: more };
    });
  }
}
