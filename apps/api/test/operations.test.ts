import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Operations, Actor } from "../src/domain";
// A dedicated database is mandatory. Never point these tests at business data.
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must name a dedicated *_test database");
const pool = new Pool({ connectionString: url });
const ops = new Operations(pool);
let owner: Actor,
  driver: Actor,
  otherDriver: Actor,
  customerActor: Actor,
  truck: string;
const key = () => randomUUID();
before(async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('corewaste-test-fixtures'))",
    );
    const make = async (role: string) => {
      const r = (
        await c.query(
          "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$4) RETURNING id,role,customer_id",
          [key(), "test_" + key().slice(0, 8), role, role],
        )
      ).rows[0];
      return r;
    };
    owner = await make("owner");
    driver = await make("driver");
    otherDriver = await make("driver");
    truck = (
      await c.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
        "TEST-" + key(),
      ])
    ).rows[0].id;
    const customer = (
      await c.query(
        "INSERT INTO customers(name,kind,email,billing_address) VALUES('Portal account','residential','portal@example.test','1 Portal Lane') RETURNING id",
      )
    ).rows[0];
    customerActor = (
      await c.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,'Portal account','customer',$3) RETURNING id,role,customer_id",
        [key(), "test_" + key().slice(0, 8), customer.id],
      )
    ).rows[0];
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
});
after(async () => {
  await pool.end();
});
async function setupOrder() {
  const customer: any = await ops.createCustomer(owner, key(), {
    name: "Integration customer",
    kind: "commercial",
    email: "office@example.test",
    billing_address: "100 Main St",
  });
  const location: any = await ops.createLocation(owner, key(), customer.id, {
    address: "200 Service Rd",
  });
  const order: any = await ops.createOrder(owner, key(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "pickup",
    scheduled_date: "2026-11-07",
    price_cents: 17500,
  });
  return { customer, location, order };
}
test("customer → location → order → dispatch → driver completion → invoice and balanced journal", async () => {
  const { order } = await setupOrder();
  const assigned: any = await ops.assign(owner, key(), order.id, {
    driver_id: driver.id,
    truck_id: truck,
    version: 1,
  });
  const started: any = await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: assigned.version,
  });
  const commandKey = key();
  const body = {
    status: "completed",
    version: started.version,
    note: "Service completed",
  };
  const [a, b]: any[] = await Promise.all([
    ops.transition(driver, commandKey, order.id, body),
    ops.transition(driver, commandKey, order.id, body),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.version, b.version);
  const invoices: any[] = await Promise.all([
    ops.invoice(owner, key(), order.id),
    ops.invoice(owner, key(), order.id),
  ]);
  assert.equal(invoices[0].id, invoices[1].id);
  assert.equal(invoices[0].amount_cents, 17500);
  const journal = (
    await pool.query("SELECT * FROM journal WHERE invoice_id=$1", [
      invoices[0].id,
    ])
  ).rows;
  assert.equal(journal.length, 1);
  assert.equal(journal[0].debit_account, "accounts_receivable");
  assert.equal(journal[0].credit_account, "service_revenue");
  assert.equal(journal[0].amount_cents, 17500);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND status='completed'",
        [order.id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    pool.query("UPDATE journal SET amount_cents=0 WHERE invoice_id=$1", [
      invoices[0].id,
    ]),
    /Append-only/,
  );
});
test("prevents cross-customer location linkage, invalid prices, and unauthorized writes", async () => {
  const { customer, location } = await setupOrder();
  await assert.rejects(
    ops.createOrder(owner, key(), {
      customer_id: customerActor.customer_id,
      location_id: location.id,
      kind: "pickup",
      scheduled_date: "2026-11-07",
      price_cents: 100,
    }),
    /matching service location/,
  );
  await assert.rejects(
    ops.createOrder(owner, key(), {
      customer_id: customer.id,
      location_id: location.id,
      kind: "pickup",
      scheduled_date: "2026-11-07",
      price_cents: -1,
    }),
  );
  await assert.rejects(
    ops.createCustomer(driver, key(), { name: "Unauthorized" }),
    /Forbidden/,
  );
  await assert.rejects(ops.locations(customerActor, customer.id), /Forbidden/);
  assert.ok(
    (await ops.customers(customerActor)).every(
      (c) => c.id === customerActor.customer_id,
    ),
  );
  assert.ok(
    (await ops.orders(customerActor)).every(
      (o) => o.customer_id === customerActor.customer_id,
    ),
  );
});
test("enforces assignment, transition rules, stale versions, and completion authorization", async () => {
  const { order } = await setupOrder();
  await assert.rejects(ops.invoice(owner, key(), order.id), /Only completed/);
  await assert.rejects(
    ops.transition(driver, key(), order.id, {
      status: "completed",
      version: 1,
    }),
    /Forbidden/,
  );
  const assigned: any = await ops.assign(owner, key(), order.id, {
    driver_id: driver.id,
    truck_id: truck,
    version: 1,
  });
  await assert.rejects(
    ops.transition(otherDriver, key(), order.id, {
      status: "in_progress",
      version: assigned.version,
    }),
    /Forbidden/,
  );
  await assert.rejects(
    ops.transition(driver, key(), order.id, {
      status: "completed",
      version: assigned.version,
    }),
    /Invalid order/,
  );
  await assert.rejects(
    ops.assign(owner, key(), order.id, {
      driver_id: driver.id,
      truck_id: truck,
      version: 1,
    }),
    /Order changed/,
  );
  await assert.rejects(
    ops.transition(driver, key(), order.id, {
      status: "failed",
      version: assigned.version,
      note: "",
    }),
    /Failure reason/,
  );
  assert.equal(
    (await ops.orders(otherDriver)).filter((o) => o.id === order.id).length,
    0,
  );
});
test("request retries return the original result; reused keys conflict and failed commands roll back", async () => {
  const k = key(),
    body = {
      name: "Retry customer",
      kind: "residential",
      email: "retry@example.test",
      billing_address: "1 Retry Rd",
    };
  const a: any = await ops.createCustomer(owner, k, body),
    b: any = await ops.createCustomer(owner, k, body);
  assert.equal(a.id, b.id);
  await assert.rejects(
    ops.createCustomer(owner, k, { ...body, name: "Changed" }),
    /reused/,
  );
  const { order } = await setupOrder();
  const commandKey = key();
  await assert.rejects(
    ops.assign(owner, commandKey, order.id, {
      driver_id: otherDriver.id,
      truck_id: randomUUID(),
      version: 1,
    }),
    /Available truck/,
  );
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [order.id]))
      .rows[0].status,
    "new",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM commands WHERE actor_id=$1 AND key=$2",
        [owner.id, commandKey],
      )
    ).rows[0].n,
    0,
  );
});

test("customer request reaches office queue and converts once into executable service", async () => {
  const { Workflows } = await import("../src/workflows");
  const wf = new Workflows(ops);
  const location: any = await ops.createLocation(
    owner,
    key(),
    customerActor.customer_id!,
    { address: "Portal service address" },
  );
  const request: any = await wf.request(customerActor, key(), {
    customer_id: customerActor.customer_id,
    location_id: location.id,
    kind: "missed_pickup",
    description: "Cart was missed",
  });
  assert.ok((await wf.requests(owner)).some((r) => r.id === request.id));
  const order: any = await wf.convert(owner, key(), request.id, {
    scheduled_date: "2026-11-08",
    price_cents: 0,
  });
  assert.equal(order.kind, "extra_pickup");
  assert.equal(order.customer_id, customerActor.customer_id);
  await assert.rejects(
    wf.convert(owner, key(), request.id, {
      scheduled_date: "2026-11-08",
      price_cents: 0,
    }),
    /already processed/,
  );
  const assigned: any = await ops.assign(owner, key(), order.id, {
    driver_id: driver.id,
    truck_id: truck,
    version: 1,
  });
  const started: any = await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: assigned.version,
  });
  const completed: any = await ops.transition(driver, key(), order.id, {
    status: "completed",
    version: started.version,
  });
  assert.equal(completed.status, "completed");
});
test("route creation assigns ordered stops atomically; completion appears in route progress", async () => {
  const { Workflows } = await import("../src/workflows");
  const wf = new Workflows(ops);
  const { order: a } = await setupOrder();
  const { order: b } = await setupOrder();
  const route: any = await wf.route(owner, key(), {
    name: "North collection",
    service_date: "2026-11-07",
    driver_id: driver.id,
    truck_id: truck,
    order_ids: [b.id, a.id],
  });
  const routes = await wf.routes(driver),
    r = routes.find((r) => r.id === route.id);
  assert.deepEqual(
    r.stops.map((s: any) => s.id),
    [b.id, a.id],
  );
  assert.ok(
    r.stops.every(
      (s: any) => s.driver_id === driver.id && s.status === "assigned",
    ),
  );
  await assert.rejects(
    wf.route(owner, key(), {
      name: "Duplicate assignment",
      service_date: "2026-11-07",
      driver_id: otherDriver.id,
      truck_id: truck,
      order_ids: [a.id],
    }),
    /already on a route/,
  );
  const s: any = await ops.transition(driver, key(), a.id, {
    status: "in_progress",
    version: r.stops[1].version,
  });
  await ops.transition(driver, key(), a.id, {
    status: "completed",
    version: s.version,
  });
  assert.equal(
    (await wf.routes(driver)).find((r) => r.id === route.id).stops[1].status,
    "completed",
  );
  assert.ok(!(await wf.routes(otherDriver)).some((r) => r.id === route.id));
});
test("recurring agreements generate each scheduled service once and retain exact integer pricing", async () => {
  const { Workflows } = await import("../src/workflows");
  const wf = new Workflows(ops);
  const { customer, location } = await setupOrder();
  const agreement: any = await wf.agreement(owner, key(), {
    customer_id: customer.id,
    location_id: location.id,
    kind: "commercial",
    price_cents: 2350,
    interval_days: 7,
    next_service_date: "2026-11-07",
  });
  await Promise.all([
    wf.generate(owner, key(), { through_date: "2026-11-21" }),
    wf.generate(owner, key(), { through_date: "2026-11-21" }),
  ]);
  const orders = (
    await pool.query(
      "SELECT scheduled_date,price_cents FROM orders WHERE agreement_id=$1 ORDER BY scheduled_date",
      [agreement.id],
    )
  ).rows;
  assert.deepEqual(
    orders.map((o) => o.scheduled_date),
    ["2026-11-07", "2026-11-14", "2026-11-21"],
  );
  assert.ok(orders.every((o) => o.price_cents === 2350));
  assert.equal(
    (
      await pool.query(
        "SELECT next_service_date FROM service_agreements WHERE id=$1",
        [agreement.id],
      )
    ).rows[0].next_service_date,
    "2026-11-28",
  );
});
test("arrival records its capture time, retries once, and commits customer lifecycle notices atomically", async () => {
  const { order, customer } = await setupOrder();
  await ops.assign(owner, key(), order.id, {
    driver_id: driver.id,
    truck_id: truck,
    version: 1,
  });
  await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: 2,
  });
  const at = new Date(Date.now() - 1000).toISOString(),
    arrivalKey = key();
  const payload = {
    status: "arrived",
    version: 3,
    performed_at: at,
    note: "Private driver detail",
  };
  const arrival: any = await ops.transition(
    driver,
    arrivalKey,
    order.id,
    payload,
  );
  assert.equal(arrival.status, "in_progress");
  assert.equal(new Date(arrival.arrived_at).toISOString(), at);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await ops.transition(driver, arrivalKey, order.id, payload),
      ),
    ),
    JSON.parse(JSON.stringify(arrival)),
  );
  await assert.rejects(
    ops.transition(otherDriver, key(), order.id, {
      status: "arrived",
      version: 4,
    }),
  );
  await assert.rejects(
    ops.transition(driver, key(), order.id, { status: "arrived", version: 4 }),
    /already recorded/,
  );
  await ops.transition(driver, key(), order.id, {
    status: "completed",
    version: 4,
  });
  const notices = (
    await pool.query(
      "SELECT kind,message,id FROM notifications WHERE customer_id=$1 ORDER BY created_at,id",
      [customer.id],
    )
  ).rows;
  assert.deepEqual(
    notices.map((n) => n.kind),
    ["en_route", "arrival", "service_completed"],
  );
  assert.ok(notices.every((n) => !n.message.includes("Private driver detail")));
  for (const n of notices)
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM notification_outbox WHERE notification_id=$1",
          [n.id],
        )
      ).rows[0].n,
      1,
    );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND status='arrived'",
        [order.id],
      )
    ).rows[0].n,
    1,
  );
  const stale = await setupOrder();
  await ops.assign(owner, key(), stale.order.id, {
    driver_id: driver.id,
    truck_id: truck,
    version: 1,
  });
  await assert.rejects(
    ops.transition(driver, key(), stale.order.id, {
      status: "in_progress",
      version: 2,
      performed_at: new Date(Date.now() - 8 * 86400000).toISOString(),
    }),
    /seven days/,
  );
});

import { OrderTasks } from "../src/order-tasks";
test("required tasks prevent completion, keep ownership, and replay without duplicating driver work", async () => {
  const tasks = new OrderTasks(ops);
  const { order, customer } = await setupOrder();
  const task: any = await tasks.add(owner, key(), order.id, {
    label: "Verify container latch",
    required: true,
    version: 1,
  });
  await ops.assign(owner, key(), order.id, {
    driver_id: driver.id,
    truck_id: truck,
    version: 2,
  });
  await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: 3,
  });
  await assert.rejects(
    ops.transition(driver, key(), order.id, {
      status: "completed",
      version: 4,
    }),
    /required tasks/,
  );
  const payload = {
      version: 1,
      note: "Latch secured",
      performed_at: new Date().toISOString(),
    },
    taskKey = key();
  await assert.rejects(
    tasks.complete(otherDriver, key(), order.id, task.id, payload),
  );
  const done: any = await tasks.complete(
    driver,
    taskKey,
    order.id,
    task.id,
    payload,
  );
  assert.deepEqual(
    await tasks.complete(driver, taskKey, order.id, task.id, payload),
    JSON.parse(JSON.stringify(done)),
  );
  await assert.rejects(
    tasks.complete(driver, key(), order.id, task.id, payload),
    /already complete/,
  );
  assert.equal(
    (await pool.query("SELECT version FROM orders WHERE id=$1", [order.id]))
      .rows[0].version,
    4,
  );
  await ops.transition(driver, key(), order.id, {
    status: "completed",
    version: 4,
  });
  const portalActor: Actor = { ...customerActor, customer_id: customer.id };
  const portalOrders = await ops.orders(portalActor);
  assert.deepEqual(portalOrders.find((o) => o.id === order.id).tasks, []);
  const driverOrders = await ops.orders(driver);
  assert.equal(
    driverOrders.find((o) => o.id === order.id).tasks[0].completion_note,
    "Latch secured",
  );
});
