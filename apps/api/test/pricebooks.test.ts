import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
import { Pricebooks } from "../src/pricebooks";
import { Finance } from "../src/finance";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const key = () => randomUUID();
let adminPool: Pool,
  pool: Pool,
  schema: string,
  ops: Operations,
  wf: Workflows,
  prices: Pricebooks,
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
  prices = new Pricebooks(ops);
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
const fields = {
  name: "Agreed bulk pickup",
  description: "One normal bulk pickup",
  price_cents: 18750,
  effective_from: "2026-11-01",
  effective_to: "2026-11-30",
  active: true,
};
async function rate(extra: any = {}) {
  return (await prices.create(owner, key(), {
    ...fields,
    customer_id: customerId,
    location_id: null,
    kind: "bulk",
    ...extra,
  })) as any;
}
function orderBody(rate: any, extra: any = {}) {
  return {
    customer_id: customerId,
    location_id: locationId,
    kind: "bulk",
    scheduled_date: "2026-11-07",
    price_cents: rate.price_cents,
    pricebook_id: rate.id,
    pricebook_version: rate.version,
    ...extra,
  };
}
test("selected customer quote is snapshotted and later rate changes cannot reprice completion or invoicing", async () => {
  const r = await rate(),
    command = key(),
    body = orderBody(r);
  const order: any = await ops.createOrder(owner, command, body);
  assert.equal(
    ((await ops.createOrder(owner, command, body)) as any).id,
    order.id,
  );
  assert.equal(order.pricing_snapshot.version, 1);
  assert.equal(order.pricing_snapshot.price_cents, 18750);
  const updated: any = await prices.update(owner, key(), r.id, {
    ...fields,
    price_cents: 22000,
    version: 1,
    reason: "New agreed price for future work",
  });
  assert.equal(updated.version, 2);
  await assert.rejects(ops.createOrder(owner, key(), body), /changed/);
  assert.equal(
    (await pool.query("SELECT price_cents FROM orders WHERE id=$1", [order.id]))
      .rows[0].price_cents,
    18750,
  );
  await ops.assign(owner, key(), order.id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: 2,
  });
  await ops.transition(driver, key(), order.id, {
    status: "completed",
    version: 3,
    service_date: "2026-11-07",
  });
  const invoice: any = await ops.invoice(owner, key(), order.id);
  assert.equal(invoice.amount_cents, 18750);
  assert.match(
    (
      await pool.query(
        "SELECT description FROM invoice_lines WHERE invoice_id=$1",
        [invoice.id],
      )
    ).rows[0].description,
    /Agreed bulk pickup/,
  );
  assert.equal(
    (
      await pool.query("SELECT pricing_snapshot FROM orders WHERE id=$1", [
        order.id,
      ])
    ).rows[0].pricing_snapshot.name,
    fields.name,
  );
  const next: any = await ops.createOrder(owner, key(), orderBody(updated));
  assert.equal(next.price_cents, 22000);
  assert.equal(next.pricing_snapshot.version, 2);
});
test("rate customer, location, kind, dates, active state and exact price are checked atomically", async () => {
  const r = await rate({ location_id: locationId });
  for (const extra of [
    { kind: "pickup" },
    { scheduled_date: "2026-10-31" },
    { scheduled_date: "2026-12-01" },
    { price_cents: 1 },
    { pricebook_version: 99 },
    { pricebook_version: undefined },
  ])
    await assert.rejects(ops.createOrder(owner, key(), orderBody(r, extra)));
  const other: any = await ops.createCustomer(owner, key(), {
    name: "Other customer",
    kind: "commercial",
    email: "other@example.test",
    billing_address: "Other billing",
  });
  const location: any = await ops.createLocation(owner, key(), other.id, {
    address: "Other entrance",
  });
  await assert.rejects(
    ops.createOrder(
      owner,
      key(),
      orderBody(r, { customer_id: other.id, location_id: location.id }),
    ),
    /match/,
  );
  const sameCustomer: any = await ops.createLocation(owner, key(), customerId, {
    address: "Second entrance",
  });
  await assert.rejects(
    ops.createOrder(
      owner,
      key(),
      orderBody(r, { location_id: sameCustomer.id }),
    ),
    /match/,
  );
  await prices.update(owner, key(), r.id, {
    ...fields,
    active: false,
    version: 1,
    reason: "Quote withdrawn",
  });
  await assert.rejects(
    ops.createOrder(owner, key(), orderBody({ ...r, version: 2 })),
    /not effective/,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM orders")).rows[0].count,
    "0",
  );
});
test("price edits require finance roles and versions; staff may quote but drivers and customers cannot view internal cards", async () => {
  const r = await rate();
  for (const role of ["driver", "customer"])
    await assert.rejects(
      prices.list({ ...owner, role }, customerId),
      /Forbidden/,
    );
  for (const role of ["dispatcher", "office", "driver", "customer"])
    await assert.rejects(
      prices.update({ ...owner, role }, key(), r.id, {
        ...fields,
        version: 1,
        reason: "Attempt",
      }),
      /Forbidden/,
    );
  await assert.rejects(
    prices.update(owner, key(), r.id, {
      ...fields,
      version: 9,
      reason: "Stale editor",
    }),
    /changed/,
  );
  assert.equal(
    (await prices.list({ ...owner, role: "dispatcher" }, customerId)).length,
    1,
  );
  const quoted: any = await ops.createOrder(
    { ...owner, role: "office" },
    key(),
    orderBody(r),
  );
  assert.equal(quoted.pricebook_id, r.id);
  await assert.rejects(
    pool.query("UPDATE orders SET price_cents=1 WHERE id=$1", [quoted.id]),
    /order_price_snapshot/,
  );
});
test("rate creation validates active matching locations, date ranges and preserves explicit free service pricing", async () => {
  await assert.rejects(rate({ effective_to: "2026-10-31" }), /Rate end/);
  await assert.rejects(rate({ location_id: key() }), /location/);
  const free = await rate({ price_cents: 0 });
  const o: any = await ops.createOrder(owner, key(), orderBody(free));
  assert.equal(o.price_cents, 0);
  assert.equal(o.pricing_snapshot.price_cents, 0);
  await ops.assign(owner, key(), o.id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  await ops.transition(driver, key(), o.id, {
    status: "in_progress",
    version: 2,
  });
  await ops.transition(driver, key(), o.id, {
    status: "completed",
    version: 3,
    service_date: "2026-11-07",
  });
  const zero: any = await ops.invoice(owner, key(), o.id);
  assert.equal(zero.amount_cents, 0);
  assert.equal(zero.status, "paid");
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM journal WHERE invoice_id=$1", [
        zero.id,
      ])
    ).rows[0].count,
    "0",
  );

  const manual: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "bulk",
    scheduled_date: "2026-11-07",
    price_cents: 500,
  });
  assert.equal(manual.pricebook_id, null);
  assert.equal(manual.pricing_snapshot, null);
});
