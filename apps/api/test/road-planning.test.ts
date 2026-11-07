import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
import { RoadPlanning } from "../src/road-planning";
import { AmazonRoadProvider, RoadTransport } from "../src/road-provider";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const key = () => randomUUID();
let adminPool: Pool,
  pool: Pool,
  schema: string,
  ops: Operations,
  wf: Workflows,
  roads: RoadPlanning,
  owner: Actor,
  driver: Actor,
  customerId: string,
  locationId: string,
  truckId: string;
beforeEach(async () => {
  schema = "monthly_" + key().replaceAll("-", "");
  adminPool = new Pool({ connectionString: url });
  await adminPool.query('CREATE SCHEMA "' + schema + '"');
  pool = new Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
  });
  const dir = new URL("../../../database/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort())
    await pool.query(await readFile(new URL(name, dir), "utf8"));
  ops = new Operations(pool);
  wf = new Workflows(ops);

  owner = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Monthly owner','owner') RETURNING *",
      [key(), "month_" + key().slice(0, 8)],
    )
  ).rows[0];
  driver = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Monthly driver','driver') RETURNING *",
      [key(), "month_" + key().slice(0, 8)],
    )
  ).rows[0];
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Monthly fixture",
    kind: "commercial",
    email: "monthly@example.test",
    billing_address: "Monthly billing",
  });
  customerId = c.id;
  locationId = (
    (await ops.createLocation(owner, key(), c.id, {
      address: "Monthly service",
    })) as any
  ).id;
  truckId = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "MONTH-" + key(),
    ])
  ).rows[0].id;
});
afterEach(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA "' + schema + '" CASCADE');
  await adminPool.end();
});
const profileBody = {
  height_cm: 400,
  width_cm: 250,
  length_cm: 900,
  gross_weight_kg: 26000,
  weight_per_axle_kg: 10000,
  verification_note: "Weighed and measured test fixture",
  version: 0,
  non_hazardous_rigid_truck: true,
};
const request = {
  origin: [-87.7, 41.8],
  destination: [-87.7, 41.8],
  departure_time: "2026-11-07T08:00:00-06:00",
  optimize: true,
  verified_depots: true,
};
let calls: { path: string; body: any }[];
function transportWith(
  change?: (response: any, path: string) => any,
): RoadTransport {
  return async (path, raw) => {
    const body = raw as any;
    calls.push({ path, body });
    let response: any;
    if (path === "/v2/optimize-waypoints")
      response = {
        ImpedingWaypoints: [],
        OptimizedWaypoints: [
          { Id: "depot-start" },
          ...body.Waypoints.slice()
            .reverse()
            .map((s: any) => ({ Id: s.Id })),
          { Id: "depot-end" },
        ],
      };
    else {
      const positions = [
        body.Origin,
        ...body.Waypoints.map((s: any) => s.Position),
        body.Destination,
      ];
      response = {
        Notices: [],
        Routes: [
          {
            Summary: { Distance: 12000, Duration: 1800 },
            Legs: positions.slice(1).map((p: any, i: number) => ({
              TravelMode: "Truck",
              Type: "Vehicle",
              Geometry: { LineString: [positions[i], p] },
              VehicleLegDetails: { Notices: [] },
            })),
          },
        ],
      };
    }
    return change ? change(response, path) : response;
  };
}
async function fixture(change?: (response: any, path: string) => any) {
  calls = [];
  roads = new RoadPlanning(ops, new AmazonRoadProvider(transportWith(change)));
  await roads.profile(owner, key(), truckId, profileBody);
  await roads.pin(owner, key(), locationId, {
    longitude: -87.65,
    latitude: 41.85,
    note: "Entrance confirmed in test fixture",
    version: 1,
  });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const o: any = await ops.createOrder(owner, key(), {
      customer_id: customerId,
      location_id: locationId,
      kind: "bulk",
      scheduled_date: "2026-11-07",
      price_cents: 2000,
    });
    ids.push(o.id);
  }
  const route: any = await wf.route(owner, key(), {
    name: "Road fixture",
    service_date: "2026-11-07",
    driver_id: driver.id,
    truck_id: truckId,
    order_ids: ids,
  });
  return { route, ids };
}
test("road preview uses truck dimensions, optimizes every stop, and applies atomically with exact retries", async () => {
  const { route, ids } = await fixture(),
    commandKey = key();
  const plan = await roads.create(owner, commandKey, route.id, {
    ...request,
    version: route.version,
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.result.order_ids, ids.slice().reverse());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.TravelMode, "Truck");
  assert.equal(calls[1].body.TravelModeOptions.Truck.WeightPerAxle, 10000);
  assert.equal(calls[0].body.TravelModeOptions.Truck.Height, 400);
  assert.equal(
    (
      await roads.create(owner, commandKey, route.id, {
        ...request,
        version: route.version,
      })
    ).id,
    plan.id,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT order_id FROM route_stops WHERE route_id=$1 ORDER BY position",
        [route.id],
      )
    ).rows.map((r) => r.order_id),
    ids,
  );
  const applyKey = key(),
    result: any = await roads.apply(owner, applyKey, plan.id);
  assert.equal(result.version, 2);
  assert.equal(
    ((await roads.apply(owner, applyKey, plan.id)) as any).version,
    2,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT order_id FROM route_stops WHERE route_id=$1 ORDER BY position",
        [route.id],
      )
    ).rows.map((r) => r.order_id),
    ids.slice().reverse(),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM audit_log WHERE action='route.road_plan_applied'",
      )
    ).rows[0].count,
    "1",
  );
});
test("changed service pins and truck profiles invalidate previews without partial reorder", async () => {
  const { route, ids } = await fixture();
  let plan = await roads.create(owner, key(), route.id, {
    ...request,
    version: 1,
  });
  await roads.pin(owner, key(), locationId, {
    longitude: -87.64,
    latitude: 41.86,
    note: "Changed test entrance",
    version: 2,
  });
  await assert.rejects(roads.apply(owner, key(), plan.id), /changed/);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT order_id FROM route_stops WHERE route_id=$1 ORDER BY position",
        [route.id],
      )
    ).rows.map((r) => r.order_id),
    ids,
  );
  plan = await roads.create(owner, key(), route.id, { ...request, version: 1 });
  await roads.profile(owner, key(), truckId, {
    ...profileBody,
    height_cm: 410,
    version: 1,
  });
  await assert.rejects(roads.apply(owner, key(), plan.id), /changed/);
  assert.equal(
    (await pool.query("SELECT version FROM routes WHERE id=$1", [route.id]))
      .rows[0].version,
    1,
  );
});
test("address changes clear verified pins; stale pin editors and missing coordinates are rejected", async () => {
  const { route } = await fixture();
  await pool.query(
    "UPDATE locations SET address='Changed address' WHERE id=$1",
    [locationId],
  );
  const l = (
    await pool.query("SELECT * FROM locations WHERE id=$1", [locationId])
  ).rows[0];
  assert.equal(l.routing_longitude, null);
  assert.equal(l.routing_verified_at, null);
  assert.equal(l.routing_version, 3);
  await assert.rejects(
    roads.pin(owner, key(), locationId, {
      longitude: 1,
      latitude: 1,
      note: "Stale",
      version: 2,
    }),
    /changed/,
  );
  await assert.rejects(
    roads.create(owner, key(), route.id, { ...request, version: 1 }),
    /coordinates/,
  );
  assert.equal(calls.length, 0);
});
test("provider constraints, duplicated stops, vehicle notices, car legs and absent geometry never become ready", async () => {
  for (const mode of ["constraint", "duplicate", "notice", "car", "geometry"]) {
    const { route } = await fixture((r, path) => {
      if (path.includes("optimize")) {
        if (mode === "constraint") r.ImpedingWaypoints = [{ Id: "blocked" }];
        if (mode === "duplicate")
          r.OptimizedWaypoints[2] = r.OptimizedWaypoints[1];
      } else {
        if (mode === "notice")
          r.Routes[0].Legs[0].VehicleLegDetails.Notices = [
            { Code: "ViolatedVehicleRestriction" },
          ];
        if (mode === "car") r.Routes[0].Legs[0].TravelMode = "Car";
        if (mode === "geometry") delete r.Routes[0].Legs[0].Geometry;
      }
      return r;
    });
    const plan = await roads.create(owner, key(), route.id, {
      ...request,
      version: 1,
    });
    assert.equal(plan.status, "failed", mode);
    assert.equal(plan.result, null);
    await assert.rejects(roads.apply(owner, key(), plan.id), /unavailable/);
    // Next fixture shares one truck and location within this isolated test.
    await pool.query("DELETE FROM truck_routing_profiles WHERE truck_id=$1", [
      truckId,
    ]);
    await pool.query("UPDATE locations SET routing_version=1 WHERE id=$1", [
      locationId,
    ]);
  }
});
test("started, expired, stale-version, and wrong-date plans cannot change dispatch", async () => {
  const { route, ids } = await fixture();
  await assert.rejects(
    roads.create(owner, key(), route.id, { ...request, version: 9 }),
    /changed/,
  );
  await assert.rejects(
    roads.create(owner, key(), route.id, {
      ...request,
      version: 1,
      departure_time: "2026-11-08T08:00:00-06:00",
    }),
    /Departure/,
  );
  const plan = await roads.create(owner, key(), route.id, {
    ...request,
    version: 1,
  });
  await pool.query(
    "UPDATE road_plans SET expires_at=now()-interval '1 second' WHERE id=$1",
    [plan.id],
  );
  await assert.rejects(roads.apply(owner, key(), plan.id), /expired/);
  const fresh = await roads.create(owner, key(), route.id, {
    ...request,
    version: 1,
  });
  await ops.transition(driver, key(), ids[0], {
    status: "in_progress",
    version: 2,
  });
  await assert.rejects(roads.apply(owner, key(), fresh.id), /unstarted/);
  assert.equal(
    (await pool.query("SELECT version FROM routes WHERE id=$1", [route.id]))
      .rows[0].version,
    1,
  );
});
test("office and customer cannot plan; dispatcher cannot alter truck safety profile; unconfigured provider is explicit", async () => {
  const { route } = await fixture();
  for (const role of ["office", "customer", "driver"])
    await assert.rejects(roads.data({ ...owner, role }, route.id), /Forbidden/);
  await assert.rejects(
    roads.profile({ ...owner, role: "dispatcher" }, key(), truckId, {
      ...profileBody,
      version: 1,
    }),
    /Forbidden/,
  );
  roads = new RoadPlanning(ops, {
    configured: () => false,
    plan: async () => {
      throw Error("must not be called");
    },
  });
  await assert.rejects(
    roads.create(owner, key(), route.id, { ...request, version: 1 }),
    /not configured/,
  );
  assert.equal(calls.length, 0);
});
test("dependent services support saved-order roads but optimization is blocked before provider billing", async () => {
  const { route, ids } = await fixture();
  await pool.query(
    "UPDATE orders SET parent_order_id=$2,depends_on_parent=true WHERE id=$1",
    [ids[1], ids[0]],
  );
  await assert.rejects(
    roads.create(owner, key(), route.id, { ...request, version: 1 }),
    /Linked/,
  );
  assert.equal(calls.length, 0);
  const plan = await roads.create(owner, key(), route.id, {
    ...request,
    optimize: false,
    version: 1,
  });
  assert.equal(plan.status, "ready");
  assert.equal(calls.length, 1);
  assert.deepEqual(plan.result.order_ids, ids);
});

test("service arrival windows add waiting and work to road ETAs and stale timing cannot be applied", async () => {
  const { ServiceTiming } = await import("../src/service-timing");
  const { route, ids } = await fixture((response, path) => {
    if (path === "/v2/routes")
      for (const leg of response.Routes[0].Legs)
        leg.VehicleLegDetails.Summary = { Overview: { Duration: 600 } };
    return response;
  });
  const timing = new ServiceTiming(ops);
  for (const id of ids) {
    const order = (
      await pool.query("SELECT version FROM orders WHERE id=$1", [id])
    ).rows[0];
    await timing.update(owner, key(), id, {
      version: order.version,
      window_start: "09:00",
      window_end: "11:00",
      duration_minutes: 20,
      reason: "Customer availability confirmed",
    });
  }
  const plan = await roads.create(owner, key(), route.id, {
    ...request,
    optimize: false,
    version: route.version,
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.result.schedule.length, 2);
  const first = plan.result.schedule[0],
    second = plan.result.schedule[1];
  assert.equal(first.arrival_at, "2026-11-07T14:10:00.000Z");
  assert.equal(first.service_start_at, "2026-11-07T15:00:00.000Z");
  assert.equal(first.wait_seconds, 3000);
  assert.equal(first.departure_at, "2026-11-07T15:20:00.000Z");
  assert.equal(second.service_start_at, "2026-11-07T15:30:00.000Z");
  assert.equal(plan.result.return_at, "2026-11-07T16:00:00.000Z");
  assert.equal(plan.result.planning_duration_s, 7200);
  assert.equal(plan.result.timezone, "America/Chicago");
  const current = (
    await pool.query("SELECT version FROM orders WHERE id=$1", [ids[0]])
  ).rows[0];
  await timing.update(owner, key(), ids[0], {
    version: current.version,
    window_start: "10:00",
    window_end: "11:00",
    duration_minutes: 20,
    reason: "Customer changed availability",
  });
  await assert.rejects(roads.apply(owner, key(), plan.id), /changed/);
});

test("road preview rejects infeasible windows and missing or inconsistent per-leg timing without changing saved routes", async () => {
  const { ServiceTiming } = await import("../src/service-timing");
  const { route, ids } = await fixture((response, path) => {
    if (path === "/v2/routes")
      for (const leg of response.Routes[0].Legs)
        leg.VehicleLegDetails.Summary = { Overview: { Duration: 600 } };
    return response;
  });
  const timing = new ServiceTiming(ops),
    v = (await pool.query("SELECT version FROM orders WHERE id=$1", [ids[0]]))
      .rows[0].version;
  await timing.update(owner, key(), ids[0], {
    version: v,
    window_start: "07:00",
    window_end: "08:05",
    duration_minutes: 10,
    reason: "Morning arrival requirement",
  });
  const late = await roads.create(owner, key(), route.id, {
    ...request,
    optimize: false,
    version: route.version,
  });
  assert.equal(late.status, "failed");
  assert.match(late.error, /misses a saved service arrival window/);
  await assert.rejects(roads.apply(owner, key(), late.id), /unavailable/);
  roads = new RoadPlanning(ops, new AmazonRoadProvider(transportWith()));
  const absent = await roads.create(owner, key(), route.id, {
    ...request,
    optimize: false,
    version: route.version,
  });
  assert.equal(absent.status, "failed");
  assert.match(absent.error, /leg durations required/);
  roads = new RoadPlanning(
    ops,
    new AmazonRoadProvider(
      transportWith((response, path) => {
        if (path === "/v2/routes")
          for (const leg of response.Routes[0].Legs)
            leg.VehicleLegDetails.Summary = { Overview: { Duration: 100 } };
        return response;
      }),
    ),
  );
  const inconsistent = await roads.create(owner, key(), route.id, {
    ...request,
    optimize: false,
    version: route.version,
  });
  assert.equal(inconsistent.status, "failed");
  assert.match(inconsistent.error, /do not reconcile/);
  const stops = (
    await pool.query(
      "SELECT order_id FROM route_stops WHERE route_id=$1 ORDER BY position",
      [route.id],
    )
  ).rows.map((x) => x.order_id);
  assert.deepEqual(stops, ids);
});

test("service timing validates paired same-day windows, roles, immutable started work and exact retries", async () => {
  const { ServiceTiming } = await import("../src/service-timing");
  const { route, ids } = await fixture(),
    timing = new ServiceTiming(ops);
  const order = (await pool.query("SELECT * FROM orders WHERE id=$1", [ids[0]]))
    .rows[0];
  const body = {
    version: order.version,
    window_start: "09:00",
    window_end: "11:00",
    duration_minutes: 15,
    reason: "Agreed collection window",
  };
  await assert.rejects(timing.update(driver, key(), ids[0], body), /Forbidden/);
  await assert.rejects(
    timing.update(owner, key(), ids[0], { ...body, window_end: null }),
    /both times/,
  );
  await assert.rejects(
    timing.update(owner, key(), ids[0], {
      ...body,
      window_start: "23:00",
      window_end: "01:00",
    }),
    /same service date/,
  );
  await assert.rejects(
    timing.update(owner, key(), ids[0], { ...body, window_start: "24:00" }),
  );
  const command = key(),
    updated: any = await timing.update(owner, command, ids[0], body);
  assert.equal(
    ((await timing.update(owner, command, ids[0], body)) as any).version,
    updated.version,
  );
  assert.equal(updated.service_window_start, "09:00:00");
  await assert.rejects(timing.update(owner, key(), ids[0], body), /changed/);
  const started: any = await ops.transition(driver, key(), ids[0], {
    status: "in_progress",
    version: updated.version,
  });
  await assert.rejects(
    timing.update(owner, key(), ids[0], { ...body, version: started.version }),
    /already started/,
  );
});

test("road ETA refuses nonexistent or ambiguous daylight-saving arrival windows", async () => {
  const { roadSchedule } = await import("../src/road-schedule");
  const id = key();
  const plan = (
    date: string,
    start: string,
    end: string,
    departure: string,
  ) => ({
    input: { departure_time: departure },
    snapshot: {
      timezone: "America/Chicago",
      stops: [
        {
          id,
          scheduled_date: date,
          service_window_start: start,
          service_window_end: end,
          service_duration_minutes: 10,
        },
      ],
    },
  });
  const result = {
    order_ids: [id],
    distance_m: 1000,
    duration_s: 1200,
    leg_durations_s: [600, 600],
    geometry: [],
    provider: "verified-test-transport",
  };
  await assert.rejects(
    roadSchedule(
      pool,
      plan("2026-03-08", "02:15:00", "03:30:00", "2026-03-08T07:00:00Z"),
      result,
    ),
    /daylight-saving/,
  );
  await assert.rejects(
    roadSchedule(
      pool,
      plan("2026-11-01", "01:15:00", "02:30:00", "2026-11-01T05:00:00Z"),
      result,
    ),
    /daylight-saving/,
  );
});
