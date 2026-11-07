import { ConflictException } from "@nestjs/common";
import { PoolClient } from "pg";
export async function calendarLock(c: PoolClient) {
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtext('corewaste-service-calendar'))",
  );
}
export async function calendarPolicy(c: PoolClient) {
  const zones = new Map(
    (await c.query("SELECT * FROM service_zones")).rows.map((z) => [z.id, z]),
  );
  const global = new Map<string, string>(),
    specific = new Map<string, Map<string, string>>();
  for (const row of (await c.query("SELECT * FROM service_calendar_changes"))
    .rows) {
    if (!row.zone_id) global.set(row.original_date, row.replacement_date);
    else {
      if (!specific.has(row.zone_id)) specific.set(row.zone_id, new Map());
      specific.get(row.zone_id)!.set(row.original_date, row.replacement_date);
    }
  }
  return (original: string, zoneId: string | null) => {
    const zone = zoneId ? zones.get(zoneId) : null;
    if (zoneId && (!zone || !zone.active))
      throw new ConflictException(
        "Service zone is inactive; review the agreement location",
      );
    let date = original;
    const visited = new Set<string>();
    for (let step = 0; step < 32; step++) {
      if (visited.has(date))
        throw new ConflictException(
          "Service calendar contains a cycle; review the holiday rules",
        );
      visited.add(date);
      const replacement = zoneId
        ? specific.get(zoneId)?.get(date) || global.get(date)
        : global.get(date);
      if (replacement) {
        date = replacement;
        continue;
      }
      if (
        zone &&
        !zone.weekdays.includes(new Date(date + "T12:00:00Z").getUTCDay())
      ) {
        date = new Date(Date.parse(date + "T12:00:00Z") + 86400000)
          .toISOString()
          .slice(0, 10);
        continue;
      }
      if (Math.abs(Date.parse(date) - Date.parse(original)) > 31 * 86400000)
        throw new ConflictException(
          "Calendar change moves work by more than 31 days; review the rules",
        );
      return date;
    }
    throw new ConflictException(
      "Service calendar requires too many date changes",
    );
  };
}
export async function serviceDate(
  c: PoolClient,
  original: string,
  zoneId: string | null,
) {
  return (await calendarPolicy(c))(original, zoneId);
}
