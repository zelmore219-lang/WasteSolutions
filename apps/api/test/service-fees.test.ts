import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
import { FeePolicies } from "../src/fee-policies";
import { BillingControls } from "../src/billing-controls";
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
  fees: FeePolicies,
  billing: BillingControls,
  finance: Finance,
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
  fees = new FeePolicies(ops);
  billing = new BillingControls(ops);
  finance = new Finance(ops);
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
const policyFields = {
  name: "Agreed fuel",
  value: 1250,
  effective_from: "2026-11-01",
  effective_to: "2026-11-30",
  active: true,
};
async function policy(extra: any = {}) {
  return (await fees.create(owner, key(), {
    ...policyFields,
    customer_id: customerId,
    kind: "fuel",
    method: "percent",
    ...extra,
  })) as any;
}
function orderBody(policies: any[], extra: any = {}) {
  return {
    customer_id: customerId,
    location_id: locationId,
    kind: "bulk",
    scheduled_date: "2026-11-07",
    price_cents: 10005,
    fee_policies: policies.map((p) => ({ id: p.id, version: p.version })),
    ...extra,
  };
}
async function invoice(order: any) {
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
  return (await ops.invoice(owner, key(), order.id)) as any;
}
test("explicit flat and percentage fees round half-up, snapshot agreed amounts and invoice separate revenue once", async () => {
  const fuel = await policy(),
    handling = await policy({
      kind: "handling",
      method: "flat",
      name: "Handling",
      value: 250,
    });
  const order: any = await ops.createOrder(
    owner,
    key(),
    orderBody([fuel, handling]),
  );
  assert.equal(order.price_cents, 10005);
  assert.equal(order.fee_total_cents, 1501);
  assert.deepEqual(
    order.fee_snapshot.map((p: any) => p.amount_cents),
    [1251, 250],
  );
  const i = await invoice(order);
  assert.equal(i.amount_cents, 11506);
  const entries = (
    await pool.query(
      "SELECT credit_account,amount_cents FROM journal WHERE invoice_id=$1 ORDER BY credit_account",
      [i.id],
    )
  ).rows;
  assert.deepEqual(entries, [
    { credit_account: "fee_revenue", amount_cents: 1501 },
    { credit_account: "service_revenue", amount_cents: 10005 },
  ]);
  const lines = (
    await pool.query(
      "SELECT amount_cents FROM invoice_lines WHERE invoice_id=$1",
      [i.id],
    )
  ).rows;
  assert.equal(lines.length, 3);
  assert.equal(
    lines.reduce((n, r) => n + r.amount_cents, 0),
    11506,
  );
  assert.equal(((await ops.invoice(owner, key(), order.id)) as any).id, i.id);
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM journal WHERE invoice_id=$1", [
        i.id,
      ])
    ).rows[0].count,
    "2",
  );
});
test("a quote survives policy edits while new stale selections are rejected and exact retries retain original charges", async () => {
  const p = await policy(),
    command = key(),
    body = orderBody([p]),
    o: any = await ops.createOrder(owner, command, body);
  await fees.update(owner, key(), p.id, {
    ...policyFields,
    value: 2000,
    version: 1,
    reason: "Agreed future policy",
  });
  await assert.rejects(ops.createOrder(owner, key(), body), /changed/);
  assert.equal(((await ops.createOrder(owner, command, body)) as any).id, o.id);
  assert.equal((await invoice(o)).amount_cents, 11256);
  assert.equal(
    (await pool.query("SELECT fee_snapshot FROM orders WHERE id=$1", [o.id]))
      .rows[0].fee_snapshot[0].value,
    1250,
  );
});
test("policy scope, dates, duplicates, same-kind stacking, totals and permissions cannot be bypassed", async () => {
  const p = await policy(),
    another = await policy({ name: "Alternate" });
  await assert.rejects(
    ops.createOrder(owner, key(), orderBody([p, p])),
    /only once/,
  );
  await assert.rejects(
    ops.createOrder(owner, key(), orderBody([p, another])),
    /at most one/,
  );
  await assert.rejects(
    ops.createOrder(
      owner,
      key(),
      orderBody([p], { scheduled_date: "2026-12-01" }),
    ),
    /effective/,
  );
  const other: any = await ops.createCustomer(owner, key(), {
    name: "Other fee customer",
    kind: "commercial",
    email: "other@example.test",
    billing_address: "Other",
  });
  const foreign = await policy({ customer_id: other.id });
  await assert.rejects(
    ops.createOrder(owner, key(), orderBody([foreign])),
    /belong/,
  );
  await assert.rejects(
    ops.createOrder(owner, key(), orderBody([p], { price_cents: 100000000 })),
    /total/,
  );
  for (const role of ["driver", "customer"])
    await assert.rejects(
      fees.list({ ...owner, role }, customerId),
      /Forbidden/,
    );
  for (const role of ["office", "dispatcher", "driver", "customer"])
    await assert.rejects(
      fees.update({ ...owner, role }, key(), p.id, {
        ...policyFields,
        version: 1,
        reason: "Attempt",
      }),
      /Forbidden/,
    );
  assert.equal(
    (await pool.query("SELECT count(*) FROM orders")).rows[0].count,
    "0",
  );
});
test("partial and final invoice credits reverse service and fee revenue proportionally without drifting cents", async () => {
  const p = await policy({ method: "flat", value: 2000 });
  const o: any = await ops.createOrder(
      owner,
      key(),
      orderBody([p], { price_cents: 10000 }),
    ),
    i = await invoice(o);
  const command = key(),
    body = { amount_cents: 1000, reason: "Partial agreed credit" };
  await billing.creditInvoice(owner, command, i.id, body);
  await billing.creditInvoice(owner, command, i.id, body);
  const split = (
    await pool.query(
      "SELECT debit_account,amount_cents FROM journal WHERE invoice_id=$1 AND credit_account='accounts_receivable' ORDER BY debit_account",
      [i.id],
    )
  ).rows;
  assert.deepEqual(split, [
    { debit_account: "fee_revenue", amount_cents: 167 },
    { debit_account: "service_revenue", amount_cents: 833 },
  ]);
  await billing.creditInvoice(owner, key(), i.id, {
    amount_cents: 11000,
    reason: "Remaining agreed cancellation",
  });
  const balances = (
    await pool.query(
      "WITH p AS (SELECT credit_account AS account,amount_cents AS n FROM journal WHERE invoice_id=$1 UNION ALL SELECT debit_account,-amount_cents FROM journal WHERE invoice_id=$1) SELECT account,sum(n)::int AS n FROM p GROUP BY account",
      [i.id],
    )
  ).rows;
  assert.ok(balances.every((r) => r.n === 0));
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [i.id]))
      .rows[0].status,
    "paid",
  );
});
test("a credit after payment becomes account liability while reversing the original fee/service mix", async () => {
  const p = await policy({ method: "flat", value: 2000 });
  const o: any = await ops.createOrder(
      owner,
      key(),
      orderBody([p], { price_cents: 10000 }),
    ),
    i = await invoice(o);
  await finance.payment(owner, key(), i.id, {
    amount_cents: 12000,
    method: "cash",
    reference: key(),
  });
  await billing.creditInvoice(owner, key(), i.id, {
    amount_cents: 1000,
    reason: "Credit after settlement",
  });
  assert.equal(Number((await finance.detail(owner, i.id)).balance_cents), 0);
  assert.equal(
    (
      await pool.query(
        "SELECT remaining_cents FROM customer_credits WHERE customer_id=$1",
        [customerId],
      )
    ).rows[0].remaining_cents,
    1000,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT amount_cents FROM journal WHERE invoice_id=$1 AND debit_account='fee_revenue'",
        [i.id],
      )
    ).rows[0].amount_cents,
    167,
  );
});
test("zero base plus a flat fee invoices only fee revenue; a full credit leaves no unearned balance", async () => {
  const p = await policy({ method: "flat", value: 100 });
  const o: any = await ops.createOrder(
      owner,
      key(),
      orderBody([p], { price_cents: 0 }),
    ),
    i = await invoice(o);
  assert.equal(i.amount_cents, 100);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT credit_account FROM journal WHERE invoice_id=$1",
        [i.id],
      )
    ).rows,
    [{ credit_account: "fee_revenue" }],
  );
  await billing.creditInvoice(owner, key(), i.id, {
    amount_cents: 100,
    reason: "Full fee credit",
  });
  assert.equal(Number((await finance.detail(owner, i.id)).balance_cents), 0);
});
