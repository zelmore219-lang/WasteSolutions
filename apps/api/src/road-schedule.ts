import type { Pool } from "pg";
import type { RoadResult } from "./road-provider";
export class ServiceWindowConflict extends Error {}
export async function roadSchedule(pool: Pool, plan: any, result: RoadResult) {
  const timed = plan.snapshot.stops.some(
    (s: any) => s.service_window_start || s.service_duration_minutes,
  );
  if (!result.leg_durations_s) {
    if (timed)
      throw new ServiceWindowConflict(
        "Road provider did not return the leg durations required to verify service timing. No route changes were applied.",
      );
    return {};
  }
  if (
    result.leg_durations_s.length !== result.order_ids.length + 1 ||
    result.leg_durations_s.some((n) => !Number.isFinite(n) || n < 0) ||
    Math.abs(
      result.leg_durations_s.reduce((a, b) => a + b, 0) - result.duration_s,
    ) > Math.max(1, result.leg_durations_s.length)
  )
    throw new ServiceWindowConflict(
      "Road leg durations do not reconcile with the route. Request a fresh preview.",
    );
  let cursor = new Date(plan.input.departure_time).getTime();
  const schedule = [];
  for (const [index, id] of result.order_ids.entries()) {
    const stop = plan.snapshot.stops.find((s: any) => s.id === id);
    const arrival = cursor + result.leg_durations_s[index] * 1000;
    let start = arrival,
      windowStart: number | null = null,
      windowEnd: number | null = null;
    if (stop.service_window_start) {
      const times = (
        await pool.query(
          `WITH bounds AS (SELECT ($1::date+$2::time) AT TIME ZONE $4 AS starts,($1::date+$3::time) AT TIME ZONE $4 AS ends)
      SELECT starts,ends,to_char(starts AT TIME ZONE $4,'HH24:MI:SS') AS start_local,to_char(ends AT TIME ZONE $4,'HH24:MI:SS') AS end_local,
      EXISTS(SELECT 1 FROM bounds b CROSS JOIN (VALUES(interval '-2 hours'),(interval '-1 hour'),(interval '-30 minutes'),(interval '30 minutes'),(interval '1 hour'),(interval '2 hours')) shifts(delta) WHERE (b.starts+delta) AT TIME ZONE $4=b.starts AT TIME ZONE $4 OR (b.ends+delta) AT TIME ZONE $4=b.ends AT TIME ZONE $4) AS ambiguous FROM bounds`,
          [
            stop.scheduled_date,
            stop.service_window_start,
            stop.service_window_end,
            plan.snapshot.timezone,
          ],
        )
      ).rows[0];
      if (
        times.start_local !== stop.service_window_start ||
        times.end_local !== stop.service_window_end ||
        times.ambiguous
      )
        throw new ServiceWindowConflict(
          "A service window crosses an ambiguous or nonexistent daylight-saving time. Review the local arrival times before planning.",
        );
      windowStart = new Date(times.starts).getTime();
      windowEnd = new Date(times.ends).getTime();
      start = Math.max(arrival, windowStart);
      if (start > windowEnd)
        throw new ServiceWindowConflict(
          "The proposed road order misses a saved service arrival window. Review stop order, departure time and service durations; no route changes were applied.",
        );
    }
    cursor = start + (stop.service_duration_minutes || 0) * 60000;
    schedule.push({
      order_id: id,
      arrival_at: new Date(arrival).toISOString(),
      service_start_at: new Date(start).toISOString(),
      departure_at: new Date(cursor).toISOString(),
      wait_seconds: (start - arrival) / 1000,
      window_start_at:
        windowStart === null ? null : new Date(windowStart).toISOString(),
      window_end_at:
        windowEnd === null ? null : new Date(windowEnd).toISOString(),
    });
  }
  cursor += result.leg_durations_s.at(-1)! * 1000;
  return {
    schedule,
    return_at: new Date(cursor).toISOString(),
    planning_duration_s:
      (cursor - new Date(plan.input.departure_time).getTime()) / 1000,
    timezone: plan.snapshot.timezone,
  };
}
