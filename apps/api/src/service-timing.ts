import { notify } from "./notification-outbox";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { z } from "zod";
import { Actor, Operations, OFFICE, parse, permit, uuid } from "./domain";
export class ServiceTiming {
  constructor(readonly ops: Operations) {}
  async update(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
    const b = parse(
      z
        .object({
          version: z.number().int().positive(),
          window_start: time.nullable(),
          window_end: time.nullable(),
          duration_minutes: z.number().int().min(0).max(720),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    if (
      (b.window_start === null) !== (b.window_end === null) ||
      (b.window_start && b.window_end && b.window_start >= b.window_end)
    )
      throw new BadRequestException(
        "Arrival windows need both times, ending after the start on the same service date",
      );
    return this.ops.command(a, key, ["order.timing", id, b], async (c) => {
      const order = await this.ops.locked(c, id);
      if (
        order.version !== b.version ||
        !["new", "assigned", "failed"].includes(order.status)
      )
        throw new ConflictException(
          "Service changed or already started; refresh before editing its timing",
        );
      const after = (
        await c.query(
          "UPDATE orders SET service_window_start=$2,service_window_end=$3,service_duration_minutes=$4,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.window_start, b.window_end, b.duration_minutes],
        )
      ).rows[0];
      await this.ops.audit(c, a, "order.service_timing", id, {
        before: {
          window_start: order.service_window_start,
          window_end: order.service_window_end,
          duration_minutes: order.service_duration_minutes,
        },
        after: b,
      });
      const timezone = (
        await c.query("SELECT timezone FROM company_settings WHERE singleton")
      ).rows[0].timezone;
      await notify(
        c,
        order.customer_id,
        "service_changed",
        "Service timing updated",
        "Service on " +
          order.scheduled_date +
          (b.window_start
            ? " has an arrival window of " +
              b.window_start +
              "–" +
              b.window_end +
              " (" +
              timezone +
              ")."
            : " has no specified arrival window.") +
          " Contact the office with questions.",
        "service-timing:" + id + ":" + after.version,
      );
      return after;
    });
  }
}
