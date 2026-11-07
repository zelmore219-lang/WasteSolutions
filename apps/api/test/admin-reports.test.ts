import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Operations, Actor } from "../src/domain";
import { Administration } from "../src/administration";
import { Reports, csvCell, reportNames } from "../src/reports";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  admin = new Administration(ops),
  reports = new Reports(ops);
const key = () => randomUUID();
let owner: Actor,
  driver: Actor,
  dispatcher: Actor,
  truckId: string,
  orderId: string;
before(async () => {
  for (const role of ["owner", "driver", "dispatcher"]) {
    const actor = (
      await pool.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$3) RETURNING *",
        [key(), "admin_" + key().slice(0, 8), role],
      )
    ).rows[0];
    if (role === "owner") owner = actor;
    if (role === "driver") driver = actor;
    if (role === "dispatcher") dispatcher = actor;
  }
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Admin fixture",
    kind: "commercial",
    email: "admin@example.test",
    billing_address: "1 Admin Street",
  });
  const l: any = await ops.createLocation(owner, key(), c.id, {
    address: "2 Admin Street",
  });
  const t: any = await admin.truck(owner, key(), { number: "FLEET-" + key() });
  truckId = t.id;
  const o: any = await ops.createOrder(owner, key(), {
    customer_id: c.id,
    location_id: l.id,
    kind: "pickup",
    scheduled_date: "2026-11-10",
    price_cents: 10000,
  });
  orderId = o.id;
  await ops.assign(owner, key(), o.id, {
    driver_id: driver.id,
    truck_id: t.id,
    version: 1,
  });
});
after(async () => {
  await pool.end();
});
test("safety inspection puts truck into maintenance and prevents starting work until cleared", async () => {
  await assert.rejects(
    admin.inspect(driver, key(), {
      truck_id: truckId,
      kind: "pre_trip",
      odometer_km: 50000,
      safe_to_operate: false,
      notes: "",
    }),
    /Describe safety/,
  );
  const inspection: any = await admin.inspect(driver, key(), {
    truck_id: truckId,
    kind: "pre_trip",
    odometer_km: 50000,
    safe_to_operate: false,
    notes: "Brake warning during pre-trip inspection",
  });
  assert.equal(inspection.safe_to_operate, false);
  await assert.rejects(
    ops.transition(driver, key(), orderId, {
      status: "in_progress",
      version: 2,
    }),
    /truck is unavailable/,
  );
  const task: any = await admin.scheduleMaintenance(owner, key(), {
    truck_id: truckId,
    description: "Inspect brake warning",
    due_date: "2026-11-10",
  });
  await admin.completeMaintenance(owner, key(), task.id, {
    completion_notes: "Repairs completed and tested",
    version: task.version,
  });
  await admin.truckStatus(owner, key(), truckId, { status: "available" });
  const o: any = await ops.transition(driver, key(), orderId, {
    status: "in_progress",
    version: 2,
  });
  assert.equal(o.status, "in_progress");
  await assert.rejects(
    admin.truckStatus(owner, key(), truckId, { status: "retired" }),
    /in progress/,
  );
  await assert.rejects(
    admin.truckStatus(driver, key(), truckId, { status: "available" }),
    /Forbidden/,
  );
});
test("dispatch messages are private to participants and drivers cannot change employee permissions", async () => {
  const message: any = await admin.message(dispatcher, key(), {
    recipient_id: driver.id,
    message: "Use the north entrance for the assigned pickup.",
  });
  assert.ok((await admin.messages(driver)).some((m) => m.id === message.id));
  assert.ok(!(await admin.messages(owner)).some((m) => m.id === message.id));
  await assert.rejects(
    admin.updateEmployee(driver, key(), dispatcher.id, {
      role: "owner",
      active: true,
    }),
    /Forbidden/,
  );
  const before = (await admin.employees(owner)).find(
    (e) => e.id === dispatcher.id,
  );
  assert.equal(before.role, "dispatcher");
  await admin.updateEmployee(owner, key(), dispatcher.id, {
    role: "office",
    active: true,
  });
  assert.equal(
    (await admin.employees(owner)).find((e) => e.id === dispatcher.id).role,
    "office",
  );
});
test("all report queries execute with correct date binding; journal trial balance balances and exports are real files", async () => {
  for (const name of reportNames) {
    const report = await reports.run(owner, name, {
      from: "2026-01-01",
      to: "2026-12-31",
    });
    assert.ok(Array.isArray(report.rows), name);
  }
  const trial = await reports.run(owner, "trial_balance", {
    from: "2026-01-01",
    to: "2026-12-31",
  });
  const total = trial.rows.reduce((n, r) => n + Number(r.net_debit_cents), 0);
  assert.equal(total, 0);
  const pdf = await reports.pdf(trial);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 500);
  assert.match(
    reports.csv([{ name: '=HYPERLINK("bad")', value: 20 }]),
    /"'=HYPERLINK/,
  );
  assert.equal(csvCell('one,"two"'), '"one,""two"""');
  await assert.rejects(
    reports.run(driver, "revenue", { from: "2026-01-01", to: "2026-12-31" }),
    /Forbidden/,
  );
  await assert.rejects(
    reports.run(owner, "revenue", { from: "2026-12-31", to: "2026-01-01" }),
    /date range/,
  );
});
test("live changes disclose only customer-scoped refresh events to portal users", async () => {
  const { visibleChange } = await import("../src/changes");
  const customer = { id: key(), role: "customer", customer_id: key() };
  assert.equal(
    visibleChange(customer, { customer_id: customer.customer_id }),
    true,
  );
  assert.equal(visibleChange(customer, { customer_id: key() }), false);
  assert.equal(visibleChange(customer, { customer_id: null }), false);
  assert.equal(visibleChange(owner, { customer_id: null }), true);
});

test("only the message recipient can acknowledge dispatch messages", async () => {
  const m: any = await admin.message(dispatcher, key(), {
    recipient_id: driver.id,
    message: "Please check your next stop",
  });
  await assert.rejects(admin.readMessage(dispatcher, key(), m.id), /not found/);
  const read: any = await admin.readMessage(driver, key(), m.id);
  assert.ok(read.read_at);
  const again: any = await admin.readMessage(driver, key(), m.id);
  assert.equal(
    new Date(again.read_at).toISOString(),
    new Date(read.read_at).toISOString(),
  );
});
test("post-trip inspections remain available after completing the last assigned job", async () => {
  await pool.query("UPDATE trucks SET status='available' WHERE id=$1", [
    truckId,
  ]);
  const order = (
    await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])
  ).rows[0];
  if (order.status === "assigned")
    await ops.transition(driver, key(), orderId, {
      status: "in_progress",
      version: order.version,
    });
  const current = (
    await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])
  ).rows[0];
  if (current.status === "in_progress")
    await ops.transition(driver, key(), orderId, {
      status: "completed",
      version: current.version,
    });
  const at = new Date(Date.now() - 1000).toISOString();
  const inspection: any = await admin.inspect(driver, key(), {
    truck_id: truckId,
    kind: "post_trip",
    odometer_km: 1234,
    safe_to_operate: true,
    notes: "End of shift",
    recorded_at: at,
  });
  assert.equal(new Date(inspection.recorded_at).toISOString(), at);
});
