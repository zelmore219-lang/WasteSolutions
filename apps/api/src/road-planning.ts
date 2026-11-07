import { roadSchedule, ServiceWindowConflict } from "./road-schedule";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PoolClient } from "pg";
import { z } from "zod";
import {
  Actor,
  Operations,
  parse,
  permit,
  uuid,
  assertRouteDependencies,
} from "./domain";
import { AmazonRoadProvider, RoadProvider, position } from "./road-provider";
const planners = ["owner", "manager", "dispatcher"];
const pin = z
  .object({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-85).max(85),
    note: z.string().trim().min(1).max(2000),
    version: z.number().int().positive(),
  })
  .strict();
const profile = z
  .object({
    height_cm: z.number().int().min(100).max(600),
    width_cm: z.number().int().min(100).max(500),
    length_cm: z.number().int().min(200).max(2000),
    gross_weight_kg: z.number().int().min(1000).max(100000),
    weight_per_axle_kg: z.number().int().min(500).max(40000),
    verification_note: z.string().trim().min(1).max(2000),
    version: z.number().int().nonnegative(),
    non_hazardous_rigid_truck: z.literal(true),
  })
  .strict()
  .refine(
    (p) => p.weight_per_axle_kg <= p.gross_weight_kg,
    "Axle weight exceeds gross weight",
  );
const planInput = z
  .object({
    version: z.number().int().positive(),
    origin: position,
    destination: position,
    departure_time: z.iso.datetime({ offset: true }),
    optimize: z.boolean(),
    verified_depots: z.literal(true),
  })
  .strict();
function canonical(value: any): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class RoadPlanning {
  constructor(
    readonly ops: Operations,
    readonly provider: RoadProvider = new AmazonRoadProvider(),
  ) {}
  async data(a: Actor, id: string) {
    permit(a, planners);
    parse(uuid, id);
    const c = await this.ops.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const route = (
        await c.query("SELECT * FROM routes WHERE id=$1 AND NOT archived", [id])
      ).rows[0];
      if (!route) throw new NotFoundException("Route not found");
      const stops = (
        await c.query(
          "SELECT o.id,o.location_id,o.version,o.status,o.depends_on_parent,o.parent_order_id,o.service_window_start,o.service_window_end,o.service_duration_minutes,l.address,l.routing_longitude AS longitude,l.routing_latitude AS latitude,l.routing_note,l.routing_version,c.name AS customer_name FROM route_stops s JOIN orders o ON o.id=s.order_id JOIN locations l ON l.id=o.location_id JOIN customers c ON c.id=o.customer_id WHERE s.route_id=$1 ORDER BY s.position",
          [id],
        )
      ).rows;
      const truck = (
        await c.query(
          "SELECT t.id,t.number,t.status,p.height_cm,p.width_cm,p.length_cm,p.gross_weight_kg,p.weight_per_axle_kg,p.verification_note,p.version FROM trucks t LEFT JOIN truck_routing_profiles p ON p.truck_id=t.id WHERE t.id=$1",
          [route.truck_id],
        )
      ).rows[0];
      const plans = (
        await c.query(
          "SELECT id,status,created_at,expires_at,result,error,input,snapshot FROM road_plans WHERE route_id=$1 ORDER BY created_at DESC LIMIT 5",
          [id],
        )
      ).rows;
      const timezone = (
        await c.query("SELECT timezone FROM company_settings WHERE singleton")
      ).rows[0].timezone;
      await c.query("COMMIT");
      return {
        timezone,
        route,
        stops,
        truck,
        plans,
        configured: this.provider.configured(),
      };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async pin(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, planners);
    parse(uuid, id);
    const b = parse(pin, body);
    return this.ops.command(a, key, ["routing.pin", id, b], async (c) => {
      const location = (
        await c.query(
          "SELECT * FROM locations WHERE id=$1 AND active FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!location) throw new NotFoundException("Service location not found");
      if (location.routing_version !== b.version)
        throw new ConflictException(
          "Location changed; refresh the service pin",
        );
      const row = (
        await c.query(
          "UPDATE locations SET routing_longitude=$2,routing_latitude=$3,routing_note=$4,routing_verified_by=$5,routing_verified_at=now(),routing_version=routing_version+1 WHERE id=$1 RETURNING *",
          [id, b.longitude, b.latitude, b.note, a.id],
        )
      ).rows[0];
      await this.ops.audit(c, a, "location.routing_pin", id, b);
      return row;
    });
  }
  async profile(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager"]);
    parse(uuid, id);
    const b = parse(profile, body);
    return this.ops.command(a, key, ["routing.profile", id, b], async (c) => {
      if (
        !(await c.query("SELECT 1 FROM trucks WHERE id=$1 FOR UPDATE", [id]))
          .rowCount
      )
        throw new NotFoundException("Truck not found");
      const old = (
        await c.query(
          "SELECT version FROM truck_routing_profiles WHERE truck_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if ((old?.version || 0) !== b.version)
        throw new ConflictException("Truck routing profile changed; refresh");
      const row = (
        await c.query(
          "INSERT INTO truck_routing_profiles(truck_id,height_cm,width_cm,length_cm,gross_weight_kg,weight_per_axle_kg,verification_note,verified_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(truck_id) DO UPDATE SET height_cm=$2,width_cm=$3,length_cm=$4,gross_weight_kg=$5,weight_per_axle_kg=$6,verification_note=$7,verified_by=$8,verified_at=now(),version=truck_routing_profiles.version+1 RETURNING *",
          [
            id,
            b.height_cm,
            b.width_cm,
            b.length_cm,
            b.gross_weight_kg,
            b.weight_per_axle_kg,
            b.verification_note,
            a.id,
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "truck.routing_profile", id, b);
      return row;
    });
  }
  private async snapshot(c: PoolClient, id: string) {
    const route = (
      await c.query(
        "SELECT id,version,service_date,driver_id,truck_id FROM routes WHERE id=$1 AND NOT archived FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!route) throw new NotFoundException("Route not found");
    // Match route-edit lock order: route, resources, sorted orders, locations.
    const driver = (
      await c.query(
        "SELECT id,active,role FROM employees WHERE id=$1 FOR SHARE",
        [route.driver_id],
      )
    ).rows[0];
    const truck = (
      await c.query("SELECT id,status FROM trucks WHERE id=$1 FOR SHARE", [
        route.truck_id,
      ])
    ).rows[0];
    if (
      !driver?.active ||
      driver.role !== "driver" ||
      truck?.status !== "available"
    )
      throw new ConflictException("Active driver and available truck required");
    const profile = (
      await c.query(
        "SELECT * FROM truck_routing_profiles WHERE truck_id=$1 FOR SHARE",
        [route.truck_id],
      )
    ).rows[0];
    if (!profile)
      throw new ConflictException(
        "Verify truck dimensions and loaded weights first",
      );
    const links = (
      await c.query(
        "SELECT order_id,position FROM route_stops WHERE route_id=$1 ORDER BY position",
        [id],
      )
    ).rows;
    if (links.length < 1 || links.length > 20)
      throw new BadRequestException(
        "Road planning supports 1–20 saved stops per route",
      );
    const orders = (
      await c.query(
        "SELECT id,version,status,location_id,scheduled_date,depends_on_parent,parent_order_id,service_window_start,service_window_end,service_duration_minutes FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [links.map((s) => s.order_id)],
      )
    ).rows;
    if (
      orders.some(
        (o) =>
          !["new", "assigned"].includes(o.status) ||
          o.scheduled_date !== route.service_date,
      )
    )
      throw new ConflictException(
        "Road planning requires unstarted stops on the saved route date",
      );
    const locations = (
      await c.query(
        "SELECT id,address,active,routing_longitude AS longitude,routing_latitude AS latitude,routing_version FROM locations WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
        [orders.map((o) => o.location_id)],
      )
    ).rows;
    if (
      locations.some(
        (l) => !l.active || l.longitude === null || l.latitude === null,
      )
    )
      throw new ConflictException(
        "Verify coordinates for every service location first",
      );
    const stops = links.map((l) => {
      const o = orders.find((o) => o.id === l.order_id)!;
      return {
        ...o,
        ...{
          longitude: locations.find((p) => p.id === o.location_id)!.longitude,
          latitude: locations.find((p) => p.id === o.location_id)!.latitude,
        },
      };
    });
    const timezone = (
      await c.query("SELECT timezone FROM company_settings WHERE singleton")
    ).rows[0].timezone;
    return { route, profile, locations, stops, timezone };
  }
  async create(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, planners);
    parse(uuid, id);
    const b = parse(planInput, body);
    if (!this.provider.configured())
      throw new ServiceUnavailableException("Road routing is not configured");
    let created = false;
    const plan: any = await this.ops.command(
      a,
      key,
      ["routing.plan", id, b],
      async (c) => {
        const snapshot = await this.snapshot(c, id);
        if (snapshot.route.version !== b.version)
          throw new ConflictException("Route changed; refresh before planning");
        const timezone = (
          await c.query("SELECT timezone FROM company_settings LIMIT 1")
        ).rows[0].timezone;
        const localDate = (
          await c.query(
            "SELECT ($1::timestamptz AT TIME ZONE $2)::date AS date",
            [b.departure_time, timezone],
          )
        ).rows[0].date;
        if (localDate !== snapshot.route.service_date)
          throw new BadRequestException(
            "Departure must fall on the route date in the company timezone",
          );
        if (b.optimize && snapshot.stops.some((s) => s.depends_on_parent))
          throw new BadRequestException(
            "Linked services support saved-order road preview; reorder them manually",
          );
        const row = (
          await c.query(
            "INSERT INTO road_plans(route_id,created_by,snapshot,input) VALUES($1,$2,$3,$4) RETURNING *",
            [id, a.id, JSON.stringify(snapshot), JSON.stringify(b)],
          )
        ).rows[0];
        await this.ops.audit(c, a, "route.road_plan_requested", row.id, {
          route_id: id,
          optimize: b.optimize,
        });
        created = true;
        return row;
      },
    );
    if (created) {
      try {
        const result = await this.provider.plan(
          plan.input,
          plan.snapshot.stops,
          plan.snapshot.profile,
        );
        assertRouteDependencies(plan.snapshot.stops, result.order_ids);
        const timing = await roadSchedule(this.ops.pool, plan, result);
        await this.ops.pool.query(
          "UPDATE road_plans SET status='ready',result=$2 WHERE id=$1 AND status='pending'",
          [plan.id, JSON.stringify({ ...result, ...timing })],
        );
      } catch (error) {
        await this.ops.pool.query(
          "UPDATE road_plans SET status='failed',error=$2 WHERE id=$1 AND status='pending'",
          [
            plan.id,
            error instanceof ServiceWindowConflict
              ? error.message
              : "Road planning failed or returned an unsupported restriction. No route changes were applied. Verify provider access and settings before requesting a new preview.",
          ],
        );
      }
    }
    return (
      await this.ops.pool.query(
        "SELECT id,status,result,error,expires_at,input,snapshot FROM road_plans WHERE id=$1",
        [plan.id],
      )
    ).rows[0];
  }
  async apply(a: Actor, key: string | undefined, id: string) {
    permit(a, planners);
    parse(uuid, id);
    return this.ops.command(a, key, ["routing.apply", id], async (c) => {
      // Read route ID first, lock route before plan to avoid crossing with route edits.
      const link = (
        await c.query("SELECT route_id FROM road_plans WHERE id=$1", [id])
      ).rows[0];
      if (!link) throw new NotFoundException("Road preview not found");
      const current = await this.snapshot(c, link.route_id);
      const plan = (
        await c.query(
          "SELECT *,expires_at>now() AS fresh FROM road_plans WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (plan.status !== "ready" || !plan.fresh)
        throw new ConflictException(
          "Preview is unavailable or expired; request a fresh road plan",
        );
      if (canonical(plan.snapshot) !== canonical(current))
        throw new ConflictException(
          "Route, service pin, or truck profile changed; request a fresh road plan",
        );
      assertRouteDependencies(current.stops, plan.result.order_ids);
      await c.query("DELETE FROM route_stops WHERE route_id=$1", [
        link.route_id,
      ]);
      for (const [index, orderId] of plan.result.order_ids.entries())
        await c.query(
          "INSERT INTO route_stops(route_id,order_id,position) VALUES($1,$2,$3)",
          [link.route_id, orderId, index + 1],
        );
      const route = (
        await c.query(
          "UPDATE routes SET version=version+1 WHERE id=$1 RETURNING *",
          [link.route_id],
        )
      ).rows[0];
      await c.query(
        "UPDATE road_plans SET status='applied',applied_at=now() WHERE id=$1",
        [id],
      );
      await this.ops.audit(c, a, "route.road_plan_applied", link.route_id, {
        plan_id: id,
        order_ids: plan.result.order_ids,
      });
      return route;
    });
  }
}
