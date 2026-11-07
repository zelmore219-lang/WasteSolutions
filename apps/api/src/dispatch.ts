import { notify } from "./notification-outbox";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import {
  Actor,
  Operations,
  parse,
  permit,
  uuid,
  assertRouteDependencies,
} from "./domain";
export class Dispatch {
  constructor(readonly ops: Operations) {}
  async updateRoute(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          service_date: z.iso.date(),
          driver_id: uuid,
          truck_id: uuid,
          order_ids: z.array(uuid).min(1).max(250),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    if (new Set(b.order_ids).size !== b.order_ids.length)
      throw new BadRequestException("Duplicate stop IDs");
    return this.ops.command(a, key, ["route.update", id, b], async (c) => {
      const route = (
        await c.query(
          "SELECT * FROM routes WHERE id=$1 AND NOT archived FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!route) throw new NotFoundException("Route not found");
      if (route.version !== b.version)
        throw new ConflictException("Route changed; refresh before editing");
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
      const oldStops = (
        await c.query(
          "SELECT order_id,position FROM route_stops WHERE route_id=$1 ORDER BY position",
          [id],
        )
      ).rows;
      const union = [
        ...new Set([...oldStops.map((s) => s.order_id), ...b.order_ids]),
      ].sort();
      const orders = (
        await c.query(
          "SELECT * FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [union],
        )
      ).rows;
      assertRouteDependencies(orders, b.order_ids);
      const existingIds = new Set(oldStops.map((s) => s.order_id));
      if (orders.length !== union.length)
        throw new NotFoundException("A requested order does not exist");
      for (const o of orders) {
        const wanted = b.order_ids.includes(o.id),
          existing = existingIds.has(o.id);
        if (
          existing &&
          ["completed", "invoiced", "in_progress"].includes(o.status) &&
          !wanted
        )
          throw new ConflictException(
            "In-progress and completed stops must remain on the route",
          );
        if (wanted && o.status === "cancelled")
          throw new ConflictException("Cancelled orders cannot be routed");
        if (
          wanted &&
          !existing &&
          !["new", "assigned", "in_progress"].includes(o.status)
        )
          throw new ConflictException("Only uncompleted work may be added");
        if (wanted && o.scheduled_date !== b.service_date)
          throw new ConflictException(
            "All stops must match the route date; reschedule the service order first",
          );
      }
      if (
        (
          await c.query(
            "SELECT 1 FROM route_stops WHERE order_id=ANY($1::uuid[]) AND route_id<>$2",
            [b.order_ids, id],
          )
        ).rowCount
      )
        throw new ConflictException("An order belongs to another route");
      const snapshot = { route, stops: oldStops };
      await c.query("DELETE FROM route_stops WHERE route_id=$1", [id]);
      for (const o of orders) {
        const wanted = b.order_ids.includes(o.id);
        if (wanted && !["completed", "invoiced", "failed"].includes(o.status)) {
          await c.query(
            "UPDATE orders SET driver_id=$2,truck_id=$3,status=CASE WHEN status='new' THEN 'assigned' ELSE status END,version=version+1 WHERE id=$1",
            [o.id, b.driver_id, b.truck_id],
          );
          await this.ops.event(
            c,
            a,
            o.id,
            o.status === "in_progress" ? "in_progress" : "assigned",
            "Route assignment updated",
          );
        } else if (
          !wanted &&
          existingIds.has(o.id) &&
          o.status === "assigned"
        ) {
          await c.query(
            "UPDATE orders SET status='new',driver_id=NULL,truck_id=NULL,version=version+1 WHERE id=$1",
            [o.id],
          );
          await this.ops.event(
            c,
            a,
            o.id,
            "new",
            "Removed from route to unassigned work",
          );
        }
      }
      for (const [i, orderId] of b.order_ids.entries())
        await c.query(
          "INSERT INTO route_stops(route_id,order_id,position) VALUES($1,$2,$3)",
          [id, orderId, i + 1],
        );
      const updated = (
        await c.query(
          "UPDATE routes SET name=$2,service_date=$3,driver_id=$4,truck_id=$5,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.name, b.service_date, b.driver_id, b.truck_id],
        )
      ).rows[0];
      await this.ops.audit(c, a, "route.updated", id, {
        before: snapshot,
        after: b,
      });
      return updated;
    });
  }
  async reschedule(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, ["owner", "manager", "dispatcher", "office"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          scheduled_date: z.iso.date(),
          instructions: z.string().max(2000),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["order.reschedule", id, b], async (c) => {
      const o = await this.ops.locked(c, id);
      if (
        o.version !== b.version ||
        !["new", "assigned", "failed"].includes(o.status)
      )
        throw new ConflictException("Order changed or already started");
      if (
        (await c.query("SELECT 1 FROM rental_jobs WHERE order_id=$1", [id]))
          .rowCount
      )
        throw new ConflictException(
          "Change rental dates through the rental workflow",
        );
      if (
        (await c.query("SELECT 1 FROM route_stops WHERE order_id=$1", [id]))
          .rowCount
      )
        throw new ConflictException(
          "Remove order from its route before rescheduling",
        );
      const updated = (
        await c.query(
          "UPDATE orders SET scheduled_date=$2,instructions=$3,driver_id=CASE WHEN status='failed' THEN NULL ELSE driver_id END,truck_id=CASE WHEN status='failed' THEN NULL ELSE truck_id END,status=CASE WHEN status='failed' THEN 'new' ELSE status END,arrived_at=NULL,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.scheduled_date, b.instructions],
        )
      ).rows[0];
      await this.ops.event(c, a, id, updated.status, "Service rescheduled");
      await notify(
        c,
        o.customer_id,
        "service_changed",
        "Your service date has changed",
        "Your service moved from " +
          o.scheduled_date +
          " to " +
          b.scheduled_date +
          ".",
        "order-rescheduled:" + id + ":" + updated.version,
      );
      await this.ops.audit(c, a, "order.rescheduled", id, b);
      return updated;
    });
  }
  async priority(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          priority: z.enum(["low", "normal", "high", "urgent"]),
          version: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["order.priority", id, b], async (c) => {
      const order = await this.ops.locked(c, id);
      if (
        order.version !== b.version ||
        ["completed", "invoiced", "cancelled"].includes(order.status)
      )
        throw new ConflictException("Order changed or is already closed");
      const row = (
        await c.query(
          "UPDATE orders SET priority=$2,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.priority],
        )
      ).rows[0];
      await this.ops.audit(c, a, "order.priority_changed", id, b);
      return row;
    });
  }
  async cancel(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher", "office"]);
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
    return this.ops.command(a, key, ["order.cancel", id, b], async (c) => {
      const order = await this.ops.locked(c, id);
      if (
        order.version !== b.version ||
        !["new", "assigned", "failed"].includes(order.status)
      )
        throw new ConflictException("Order changed or already started");
      if (
        (await c.query("SELECT 1 FROM rental_jobs WHERE order_id=$1", [id]))
          .rowCount
      )
        throw new ConflictException(
          "Cancel roll-off work through its rental workflow",
        );
      if (
        (await c.query("SELECT 1 FROM route_stops WHERE order_id=$1", [id]))
          .rowCount
      )
        throw new ConflictException(
          "Remove the order from its route before cancelling",
        );
      if (
        (
          await c.query(
            "SELECT 1 FROM orders WHERE parent_order_id=$1 AND status<>'cancelled'",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Review and cancel related child orders before cancelling their parent",
        );
      const row = (
        await c.query(
          "UPDATE orders SET status='cancelled',version=version+1 WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await this.ops.event(c, a, id, "cancelled", b.reason);
      await this.ops.audit(c, a, "order.cancelled", id, b);
      await notify(
        c,
        order.customer_id,
        "service_changed",
        "Your service order was cancelled",
        "The scheduled service on " +
          order.scheduled_date +
          " was cancelled. Contact the office if you have questions.",
        "order-cancelled:" + id,
      );
      return row;
    });
  }
  async move(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          scheduled_date: z.iso.date(),
          driver_id: uuid.nullable(),
          truck_id: uuid.nullable(),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    if (Boolean(b.driver_id) !== Boolean(b.truck_id))
      throw new BadRequestException(
        "Select both a driver and truck or leave the order unassigned",
      );
    return this.ops.command(
      a,
      key,
      ["order.calendar_move", id, b],
      async (c) => {
        const order = await this.ops.locked(c, id);
        if (
          order.version !== b.version ||
          !["new", "assigned", "failed"].includes(order.status)
        )
          throw new ConflictException("Order changed or already started");
        if (
          (await c.query("SELECT 1 FROM rental_jobs WHERE order_id=$1", [id]))
            .rowCount
        )
          throw new ConflictException(
            "Change rental dates and inventory through the rental workflow",
          );
        if (
          (await c.query("SELECT 1 FROM route_stops WHERE order_id=$1", [id]))
            .rowCount
        )
          throw new ConflictException(
            "Edit a routed stop through its route before changing its calendar assignment",
          );
        if (b.driver_id) {
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
        }
        const row = (
          await c.query(
            "UPDATE orders SET scheduled_date=$2,driver_id=$3,truck_id=$4,status=CASE WHEN $3::uuid IS NULL THEN 'new' ELSE 'assigned' END,arrived_at=NULL,version=version+1 WHERE id=$1 RETURNING *",
            [id, b.scheduled_date, b.driver_id, b.truck_id],
          )
        ).rows[0];
        await this.ops.event(
          c,
          a,
          id,
          row.status,
          "Calendar dispatch assignment",
        );
        await this.ops.audit(c, a, "order.calendar_moved", id, {
          before: {
            date: order.scheduled_date,
            driver_id: order.driver_id,
            truck_id: order.truck_id,
          },
          after: b,
        });
        if (order.scheduled_date !== b.scheduled_date)
          await notify(
            c,
            order.customer_id,
            "service_changed",
            "Your service date has changed",
            "Your service moved from " +
              order.scheduled_date +
              " to " +
              b.scheduled_date +
              ".",
            "order-moved:" + id + ":" + row.version,
          );
        return row;
      },
    );
  }
}
