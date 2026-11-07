import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { PoolClient } from "pg";
import { z } from "zod";
import { Actor, Operations, OFFICE, parse, permit, uuid } from "./domain";
import { calendarLock, calendarPolicy } from "./calendar-policy";
import { notify } from "./notification-outbox";
const range = z
  .object({
    from: z.iso.date(),
    through: z.iso.date(),
    zone_id: uuid.optional(),
  })
  .strict();
export class ServiceCalendar {
  constructor(readonly ops: Operations) {}
  async list(a: Actor) {
    permit(a, OFFICE);
    return {
      zones: (
        await this.ops.pool.query("SELECT * FROM service_zones ORDER BY name")
      ).rows,
      changes: (
        await this.ops.pool.query(
          "SELECT h.*,z.name AS zone_name FROM service_calendar_changes h LEFT JOIN service_zones z ON z.id=h.zone_id ORDER BY original_date DESC LIMIT 500",
        )
      ).rows,
    };
  }
  async zone(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    const b = parse(
      z
        .object({
          id: uuid.optional(),
          version: z.number().int().positive().optional(),
          name: z.string().trim().min(1).max(120),
          description: z.string().trim().max(2000),
          weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
          active: z.boolean(),
        })
        .strict(),
      body,
    );
    if (new Set(b.weekdays).size !== b.weekdays.length)
      throw new BadRequestException("Do not repeat collection weekdays");
    return this.ops.command(a, key, ["zone.save", b], async (c) => {
      await calendarLock(c);
      let row: any;
      if (b.id) {
        if (!b.version) throw new BadRequestException("Zone version required");
        row = (
          await c.query(
            "UPDATE service_zones SET name=$2,description=$3,weekdays=$4,active=$5,version=version+1 WHERE id=$1 AND version=$6 RETURNING *",
            [b.id, b.name, b.description, b.weekdays, b.active, b.version],
          )
        ).rows[0];
        if (!row)
          throw new ConflictException("Zone changed; reload before editing");
      } else
        row = (
          await c.query(
            "INSERT INTO service_zones(name,description,weekdays,active) VALUES($1,$2,$3,$4) RETURNING *",
            [b.name, b.description, b.weekdays, b.active],
          )
        ).rows[0];
      if (row.active) {
        const policy = await calendarPolicy(c);
        const starts = (
          await c.query(
            "SELECT original_date FROM service_calendar_changes WHERE zone_id IS NULL OR zone_id=$1",
            [row.id],
          )
        ).rows;
        for (const start of starts) policy(start.original_date, row.id);
      }
      await this.ops.audit(c, a, "zone.saved", row.id, b);
      return row;
    });
  }
  async assignLocation(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(
      z
        .object({
          customer_id: uuid,
          location_id: uuid,
          zone_id: uuid.nullable(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["location.zone", b], async (c) => {
      await calendarLock(c);
      if (
        b.zone_id &&
        !(
          await c.query("SELECT 1 FROM service_zones WHERE id=$1 AND active", [
            b.zone_id,
          ])
        ).rowCount
      )
        throw new BadRequestException("Choose an active service zone");
      const row = (
        await c.query(
          "UPDATE locations SET zone_id=$3 WHERE id=$1 AND customer_id=$2 AND active RETURNING *",
          [b.location_id, b.customer_id, b.zone_id],
        )
      ).rows[0];
      if (!row)
        throw new NotFoundException("Active customer location not found");
      await this.ops.audit(c, a, "location.zone_assigned", row.id, b);
      return row;
    });
  }
  async change(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager", "dispatcher"]);
    const b = parse(
      z
        .object({
          id: uuid.optional(),
          version: z.number().int().positive().optional(),
          zone_id: uuid.nullable(),
          original_date: z.iso.date(),
          replacement_date: z.iso.date(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    const shift =
      Math.abs(Date.parse(b.replacement_date) - Date.parse(b.original_date)) /
      86400000;
    if (shift < 1 || shift > 14)
      throw new BadRequestException(
        "Replacement date must be 1 to 14 days before or after the original date",
      );
    return this.ops.command(a, key, ["calendar.change", b], async (c) => {
      await calendarLock(c);
      if (
        b.zone_id &&
        !(
          await c.query("SELECT 1 FROM service_zones WHERE id=$1 AND active", [
            b.zone_id,
          ])
        ).rowCount
      )
        throw new BadRequestException("Choose an active zone");
      let row: any;
      if (b.id) {
        row = (
          await c.query(
            "UPDATE service_calendar_changes SET zone_id=$2,original_date=$3,replacement_date=$4,reason=$5,version=version+1 WHERE id=$1 AND version=$6 RETURNING *",
            [
              b.id,
              b.zone_id,
              b.original_date,
              b.replacement_date,
              b.reason,
              b.version,
            ],
          )
        ).rows[0];
        if (!row)
          throw new ConflictException(
            "Calendar rule changed; reload before editing",
          );
      } else
        row = (
          await c.query(
            "INSERT INTO service_calendar_changes(zone_id,original_date,replacement_date,reason,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [b.zone_id, b.original_date, b.replacement_date, b.reason, a.id],
          )
        ).rows[0];
      const policy = await calendarPolicy(c);
      // Check every rule for each affected zone; a global change can introduce a zone-specific cycle.
      const zones = (await c.query("SELECT id FROM service_zones WHERE active"))
        .rows;
      for (const zoneId of [null, ...zones.map((z) => z.id)]) {
        const starts = (
          await c.query(
            "SELECT original_date FROM service_calendar_changes WHERE zone_id IS NULL OR zone_id=$1",
            [zoneId],
          )
        ).rows;
        for (const start of starts) policy(start.original_date, zoneId);
      }
      await this.ops.audit(c, a, "calendar.rule_saved", row.id, b);
      return row;
    });
  }
  private validateRange(b: z.infer<typeof range>) {
    if (
      b.from > b.through ||
      Date.parse(b.through) - Date.parse(b.from) > 366 * 86400000
    )
      throw new BadRequestException("Choose a date range of at most 367 days");
  }
  private async impact(c: PoolClient, b: z.infer<typeof range>) {
    const rows = (
      await c.query(
        "SELECT o.id,o.version,o.status,o.agreement_id,o.customer_id,o.scheduled_date,o.service_occurrence_date,l.zone_id,c.name AS customer_name,l.address,EXISTS(SELECT 1 FROM route_stops s WHERE s.order_id=o.id) AS routed FROM orders o JOIN locations l ON l.id=o.location_id JOIN customers c ON c.id=o.customer_id WHERE o.agreement_id IS NOT NULL AND COALESCE(o.service_occurrence_date,o.scheduled_date) BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR l.zone_id=$3) AND o.status<>'cancelled' ORDER BY o.id LIMIT 1001",
        [b.from, b.through, b.zone_id || null],
      )
    ).rows;
    if (rows.length > 1000)
      throw new BadRequestException(
        "More than 1000 orders match; select a narrower date range",
      );
    const items = [];
    const policy = await calendarPolicy(c);
    for (const row of rows) {
      const planned = policy(
        row.service_occurrence_date || row.scheduled_date,
        row.zone_id,
      );
      if (planned !== row.scheduled_date)
        items.push({
          ...row,
          planned_date: planned,
          blocked: !["new", "assigned", "failed"].includes(row.status)
            ? "Service has started"
            : row.routed
              ? "Remove stop from its route first"
              : null,
        });
    }
    const hash = createHash("sha256")
      .update(
        JSON.stringify(
          items.map((r) => [
            r.id,
            r.version,
            r.planned_date,
            r.zone_id,
            r.blocked,
          ]),
        ),
      )
      .digest("hex");
    return { hash, items };
  }
  async preview(a: Actor, query: unknown) {
    permit(a, OFFICE);
    const b = parse(range, query);
    this.validateRange(b);
    const c = await this.ops.pool.connect();
    try {
      await c.query("BEGIN");
      await calendarLock(c);
      const result = await this.impact(c, b);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async apply(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(
      range
        .extend({ preview_hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      body,
    );
    this.validateRange(b);
    return this.ops.command(a, key, ["calendar.apply", b], async (c) => {
      await calendarLock(c);
      const result = await this.impact(c, b);
      if (result.hash !== b.preview_hash)
        throw new ConflictException(
          "Calendar impact changed; preview again before applying",
        );
      if (result.items.some((r) => r.blocked))
        throw new ConflictException(
          "Some affected service has started or belongs to a route; review the preview",
        );
      const keys = result.items.map(
        (r) => r.agreement_id + ":" + r.planned_date,
      );
      if (new Set(keys).size !== keys.length)
        throw new ConflictException(
          "Two service occurrences would share a date; review the calendar",
        );
      const moving = result.items.map((r) => r.id);
      for (const row of result.items) {
        const locked = await this.ops.locked(c, row.id);
        if (locked.version !== row.version || locked.status !== row.status)
          throw new ConflictException("Service order changed; preview again");
        const collision = (
          await c.query(
            "SELECT 1 FROM orders WHERE agreement_id=$1 AND scheduled_date=$2 AND NOT(id=ANY($3::uuid[])) AND status<>'cancelled'",
            [locked.agreement_id, row.planned_date, moving],
          )
        ).rowCount;
        if (collision)
          throw new ConflictException(
            "Two service occurrences would share a date; review the calendar",
          );
        await c.query(
          "UPDATE orders SET scheduled_date=$2,zone_id=$3,version=version+1 WHERE id=$1",
          [row.id, row.planned_date, row.zone_id],
        );
        await this.ops.event(
          c,
          a,
          row.id,
          row.status,
          "Service calendar adjustment",
        );
        await this.ops.audit(c, a, "order.calendar_adjusted", row.id, {
          from: row.scheduled_date,
          to: row.planned_date,
          occurrence: row.service_occurrence_date,
        });
        await notify(
          c,
          row.customer_id,
          "holiday_changed",
          "Your collection date has changed",
          "Your service at " +
            row.address +
            " moved from " +
            row.scheduled_date +
            " to " +
            row.planned_date +
            ".",
          "calendar-order:" + row.id + ":" + (row.version + 1),
        );
      }
      return { changed: result.items.length };
    });
  }
}
