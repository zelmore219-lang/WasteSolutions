import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
import { Dispatch } from "../src/dispatch";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  wf = new Workflows(ops),
  dispatch = new Dispatch(ops);
const key = () => randomUUID();
let owner: Actor,
  first: Actor,
  second: Actor,
  truck: string,
  customerId: string,
  locationId: string;
before(async () => {
  for (const role of ["owner", "driver", "driver"]) {
    const r = (
      await pool.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$3) RETURNING *",
        [key(), "dispatch_" + key().slice(0, 8), role],
      )
    ).rows[0];
    if (role === "owner") owner = r;
    else if (!first) first = r;
    else second = r;
  }
  truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "DISPATCH-" + key(),
    ])
  ).rows[0].id;
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Dispatch fixture",
    kind: "commercial",
    email: "dispatch@example.test",
    billing_address: "1 Dispatch Street",
  });
  customerId = c.id;
  locationId = (
    (await ops.createLocation(owner, key(), c.id, {
      address: "2 Dispatch Street",
    })) as any
  ).id;
});
after(async () => {
  await pool.end();
});
async function order() {
  return (await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "pickup",
    scheduled_date: "2026-11-11",
    price_cents: 10000,
  })) as any;
}
test("dispatch changes an in-progress route assignment while old driver completion is rejected as stale/unauthorized", async () => {
  const a = await order(),
    b = await order();
  const route: any = await wf.route(owner, key(), {
    name: "Morning",
    service_date: "2026-11-11",
    driver_id: first.id,
    truck_id: truck,
    order_ids: [a.id, b.id],
  });
  const started: any = await ops.transition(first, key(), a.id, {
    status: "in_progress",
    version: 2,
  });
  const changed: any = await dispatch.updateRoute(owner, key(), route.id, {
    name: "Morning revised",
    service_date: "2026-11-11",
    driver_id: second.id,
    truck_id: truck,
    order_ids: [b.id, a.id],
    version: 1,
  });
  assert.equal(changed.version, 2);
  await assert.rejects(
    ops.transition(first, key(), a.id, {
      status: "completed",
      version: started.version,
    }),
    /Forbidden|changed/,
  );
  const work = (await ops.orders(second)).find((o) => o.id === a.id);
  assert.equal(work.status, "in_progress");
  await ops.transition(second, key(), a.id, {
    status: "completed",
    version: work.version,
  });
  await assert.rejects(
    dispatch.updateRoute(owner, key(), route.id, {
      name: "Remove complete",
      service_date: "2026-11-11",
      driver_id: second.id,
      truck_id: truck,
      order_ids: [b.id],
      version: 2,
    }),
    /completed stops/,
  );
});
test("removing an unstarted stop returns it to queue and permits safe rescheduling", async () => {
  const a = await order(),
    b = await order();
  const route: any = await wf.route(owner, key(), {
    name: "Queue test",
    service_date: "2026-11-11",
    driver_id: first.id,
    truck_id: truck,
    order_ids: [a.id, b.id],
  });
  await dispatch.updateRoute(owner, key(), route.id, {
    name: "Queue test",
    service_date: "2026-11-11",
    driver_id: first.id,
    truck_id: truck,
    order_ids: [a.id],
    version: 1,
  });
  const removed = (await pool.query("SELECT * FROM orders WHERE id=$1", [b.id]))
    .rows[0];
  assert.equal(removed.status, "new");
  assert.equal(removed.driver_id, null);
  const changed: any = await dispatch.reschedule(owner, key(), b.id, {
    scheduled_date: "2026-11-12",
    instructions: "Use west gate",
    version: removed.version,
  });
  assert.equal(changed.scheduled_date, "2026-11-12");
  await assert.rejects(
    dispatch.reschedule(owner, key(), b.id, {
      scheduled_date: "2026-11-13",
      instructions: "",
      version: removed.version,
    }),
    /changed/,
  );
});

test("linked child service waits for its parent, stays in the same account, and bills its own agreed price", async () => {
  const parent = await order();
  const child: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "extra_pickup",
    scheduled_date: "2026-11-11",
    price_cents: 5000,
    parent_order_id: parent.id,
    depends_on_parent: true,
    priority: "high",
  });
  await assert.rejects(
    dispatch.cancel(owner, key(), parent.id, {
      version: 1,
      reason: "Cancel parent too early",
    }),
    /child orders/,
  );
  const assignedChild: any = await ops.assign(owner, key(), child.id, {
    driver_id: first.id,
    truck_id: truck,
    version: 1,
  });
  await assert.rejects(
    ops.transition(first, key(), child.id, {
      status: "in_progress",
      version: assignedChild.version,
    }),
    /parent service/,
  );
  let p: any = await ops.assign(owner, key(), parent.id, {
    driver_id: first.id,
    truck_id: truck,
    version: 1,
  });
  p = await ops.transition(first, key(), parent.id, {
    status: "in_progress",
    version: p.version,
  });
  await ops.transition(first, key(), parent.id, {
    status: "completed",
    version: p.version,
  });
  const c: any = await ops.transition(first, key(), child.id, {
    status: "in_progress",
    version: assignedChild.version,
  });
  await ops.transition(first, key(), child.id, {
    status: "completed",
    version: c.version,
  });
  const parentInvoice: any = await ops.invoice(owner, key(), parent.id),
    childInvoice: any = await ops.invoice(owner, key(), child.id);
  assert.equal(parentInvoice.amount_cents, 10000);
  assert.equal(childInvoice.amount_cents, 5000);
  assert.notEqual(parentInvoice.id, childInvoice.id);
  const foreign: any = await ops.createCustomer(owner, key(), {
    name: "Other linked account",
    kind: "commercial",
    email: "other-linked@example.test",
    billing_address: "Other account street",
  });
  await assert.rejects(
    ops.createOrder(owner, key(), {
      customer_id: foreign.id,
      location_id: locationId,
      kind: "pickup",
      scheduled_date: "2026-11-11",
      price_cents: 0,
      parent_order_id: parent.id,
      depends_on_parent: true,
    }),
    /same customer/,
  );
  await assert.rejects(
    ops.createOrder(owner, key(), {
      customer_id: customerId,
      location_id: locationId,
      kind: "pickup",
      scheduled_date: "2026-11-11",
      price_cents: 0,
      depends_on_parent: true,
    }),
    /Choose a parent/,
  );
});
test("order priority changes are versioned, searchable by reference, and cannot change closed work", async () => {
  const original = await order();
  const urgent: any = await dispatch.priority(owner, key(), original.id, {
    version: 1,
    priority: "urgent",
    reason: "Customer access window closes early",
  });
  assert.equal(urgent.priority, "urgent");
  assert.equal(urgent.version, 2);
  await assert.rejects(
    dispatch.priority(first, key(), original.id, {
      version: 2,
      priority: "low",
      reason: "Driver cannot change dispatch priority",
    }),
  );
  await assert.rejects(
    dispatch.priority(owner, key(), original.id, {
      version: 1,
      priority: "low",
      reason: "Stale edit",
    }),
    /changed/,
  );
  const selected = await ops.orders(owner, {
    customer_id: customerId,
    priority: "urgent",
    sort: "priority",
  });
  assert.ok(selected.some((o) => o.id === original.id));
  assert.ok(selected.every((o) => o.priority === "urgent"));
  const reference = "CW-O" + String(original.number).padStart(6, "0");
  assert.equal(
    (
      await ops.orders(owner, { search: reference, customer_id: customerId })
    ).find((o) => o.id === original.id).number,
    original.number,
  );
  const cancelKey = key(),
    body = { version: 2, reason: "Customer cancelled before dispatch" };
  const cancelled: any = await dispatch.cancel(
    owner,
    cancelKey,
    original.id,
    body,
  );
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(
    await dispatch.cancel(owner, cancelKey, original.id, body),
    JSON.parse(JSON.stringify(cancelled)),
  );
  await assert.rejects(
    dispatch.priority(owner, key(), original.id, {
      version: 3,
      priority: "normal",
      reason: "Cannot reopen cancelled work",
    }),
    /closed/,
  );
});
test("retrying failed service clears the old arrival and notifies a real new departure without duplicate reassignment notices", async () => {
  const o = await order();
  let work: any = await ops.assign(owner, key(), o.id, {
    driver_id: first.id,
    truck_id: truck,
    version: 1,
  });
  work = await ops.transition(first, key(), o.id, {
    status: "in_progress",
    version: work.version,
  });
  work = await ops.transition(first, key(), o.id, {
    status: "arrived",
    version: work.version,
  });
  work = await ops.assign(owner, key(), o.id, {
    driver_id: second.id,
    truck_id: truck,
    version: work.version,
  });
  work = await ops.transition(second, key(), o.id, {
    status: "failed",
    version: work.version,
    note: "Access blocked",
  });
  work = await dispatch.reschedule(owner, key(), o.id, {
    scheduled_date: "2026-11-12",
    instructions: "Gate access confirmed",
    version: work.version,
  });
  assert.equal(work.status, "new");
  assert.equal(work.driver_id, null);
  assert.equal(work.arrived_at, null);
  work = await ops.assign(owner, key(), o.id, {
    driver_id: first.id,
    truck_id: truck,
    version: work.version,
  });
  await ops.transition(first, key(), o.id, {
    status: "in_progress",
    version: work.version,
  });
  const departures = (
    await pool.query(
      "SELECT count(*)::int AS n FROM notifications n JOIN order_events e ON n.source_key='order-event:'||e.id::text WHERE e.order_id=$1 AND n.kind='en_route'",
      [o.id],
    )
  ).rows[0].n;
  assert.equal(departures, 2);
});
test("route creation and reordering keep dependent service behind its unfinished parent", async () => {
  const parent = await order(),
    child: any = await ops.createOrder(owner, key(), {
      customer_id: customerId,
      location_id: locationId,
      kind: "extra_pickup",
      scheduled_date: "2026-11-11",
      price_cents: 5000,
      parent_order_id: parent.id,
      depends_on_parent: true,
    });
  const routeBody = {
    name: "Dependent service route",
    service_date: "2026-11-11",
    driver_id: first.id,
    truck_id: truck,
  };
  await assert.rejects(
    wf.route(owner, key(), { ...routeBody, order_ids: [child.id, parent.id] }),
    /parent service before/,
  );
  const route: any = await wf.route(owner, key(), {
    ...routeBody,
    order_ids: [parent.id, child.id],
  });
  await assert.rejects(
    dispatch.updateRoute(owner, key(), route.id, {
      ...routeBody,
      order_ids: [child.id, parent.id],
      version: 1,
    }),
    /parent service before/,
  );
  const stops = (
    await pool.query(
      "SELECT order_id FROM route_stops WHERE route_id=$1 ORDER BY position",
      [route.id],
    )
  ).rows;
  assert.deepEqual(
    stops.map((s) => s.order_id),
    [parent.id, child.id],
  );
});
test("calendar dispatch atomically changes date and assignment and rolls back unavailable resources", async () => {
  const original = await order(),
    nextDate = "2026-11-12";
  const badTruck = (
    await pool.query(
      "INSERT INTO trucks(number,status) VALUES($1,'maintenance') RETURNING id",
      ["CAL-" + key()],
    )
  ).rows[0];
  await assert.rejects(
    dispatch.move(owner, key(), original.id, {
      version: 1,
      scheduled_date: nextDate,
      driver_id: first.id,
      truck_id: badTruck.id,
    }),
    /Available truck/,
  );
  let persisted = (
    await pool.query("SELECT * FROM orders WHERE id=$1", [original.id])
  ).rows[0];
  assert.equal(persisted.scheduled_date, "2026-11-11");
  assert.equal(persisted.driver_id, null);
  assert.equal(persisted.version, 1);
  const moveKey = key(),
    body = {
      version: 1,
      scheduled_date: nextDate,
      driver_id: first.id,
      truck_id: truck,
    };
  const moved: any = await dispatch.move(owner, moveKey, original.id, body);
  assert.equal(moved.scheduled_date, nextDate);
  assert.equal(moved.driver_id, first.id);
  assert.equal(moved.truck_id, truck);
  assert.equal(moved.status, "assigned");
  assert.equal(moved.version, 2);
  assert.deepEqual(
    await dispatch.move(owner, moveKey, original.id, body),
    JSON.parse(JSON.stringify(moved)),
  );
  await assert.rejects(
    dispatch.move(owner, key(), original.id, {
      ...body,
      scheduled_date: "2026-11-13",
    }),
    /changed/,
  );
  const window = await ops.orders(owner, {
    customer_id: customerId,
    from_date: nextDate,
    through_date: nextDate,
    sort: "date",
  });
  assert.ok(window.some((o) => o.id === original.id));
  assert.ok(window.every((o) => o.scheduled_date === nextDate));
  await assert.rejects(
    ops.orders(owner, { from_date: "2026-01-01", through_date: "2026-12-31" }),
    /63 days/,
  );
  persisted = await ops.transition(first, key(), original.id, {
    status: "in_progress",
    version: 2,
  });
  await assert.rejects(
    dispatch.move(owner, key(), original.id, {
      ...body,
      version: persisted.version,
    }),
    /already started/,
  );
});
