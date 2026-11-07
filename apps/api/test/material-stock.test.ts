import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
import { MaterialStock } from "../src/material-stock";
import { Station } from "../src/station";
import { Reports } from "../src/reports";
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
  stock: MaterialStock,
  station: Station,
  reports: Reports,
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
  stock = new MaterialStock(ops);
  station = new Station(ops);
  reports = new Reports(ops);
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
async function material(extra: any = {}) {
  return (await station.material(owner, key(), {
    name: "Tracked recycling " + key(),
    category: "recycling",
    rate_cents_per_tonne: 5000,
    minimum_charge_cents: 0,
    ...extra,
  })) as any;
}
async function account(materialId: string, opening = 1000, site = key()) {
  return (await stock.create(owner, key(), {
    material_id: materialId,
    site_name: site,
    opening_kg: opening,
    reason: "Verified physical opening count",
  })) as any;
}
async function ticket(
  materialId: string,
  accountId: string | undefined,
  direction = "inbound",
  first = 3000,
) {
  return (await station.open(owner, key(), {
    customer_id: customerId,
    material_id: materialId,
    direction,
    first_weight_kg: first,
    vehicle_number: "STOCK-TEST",
    source_reference: key(),
    stock_account_id: accountId,
  })) as any;
}
test("verified inbound weighing posts stock atomically once; invoicing never moves material again", async () => {
  const m = await material(),
    a = await account(m.id, 500),
    t = await ticket(m.id, a.id);
  const command = key(),
    body = { version: 1, second_weight_kg: 1000 };
  await station.weigh(owner, command, t.id, body);
  await station.weigh(owner, command, t.id, body);
  const h = await stock.history(owner, a.id);
  assert.equal(Number(h.balance_kg), 2500);
  assert.equal(h.movements.length, 2);
  assert.equal(
    h.movements.filter((r: any) => r.scale_ticket_id === t.id).length,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM journal")).rows[0].count,
    "0",
  );
  const invoice: any = await station.invoice(owner, key(), t.id);
  assert.equal(invoice.amount_cents, 10000);
  assert.equal(Number((await stock.history(owner, a.id)).balance_kg), 2500);
  await assert.rejects(
    pool.query("DELETE FROM material_stock_movements WHERE account_id=$1", [
      a.id,
    ]),
    /Append-only/,
  );
});
test("insufficient stock rolls back the scale reading; reviewed count enables an exact retry", async () => {
  const m = await material(),
    a = await account(m.id),
    t = await ticket(m.id, a.id, "outbound", 1000),
    command = key(),
    body = { version: 1, second_weight_kg: 4000 };
  await assert.rejects(
    station.weigh(owner, command, t.id, body),
    /Insufficient/,
  );
  const open = (
    await pool.query(
      "SELECT status,second_weight_kg,version FROM scale_tickets WHERE id=$1",
      [t.id],
    )
  ).rows[0];
  assert.deepEqual(open, {
    status: "open",
    second_weight_kg: null,
    version: 1,
  });
  const counted: any = await stock.count(owner, key(), a.id, {
    counted_kg: 5000,
    version: a.version,
    reason: "Review physical stock before authorizing shipment",
  });
  assert.equal(Number(counted.balance_kg), 5000);
  await station.weigh(owner, command, t.id, body);
  const current = await stock.history(owner, a.id);
  assert.equal(Number(current.balance_kg), 2000);
  assert.equal(current.movements.length, 3);
  await assert.rejects(
    stock.count(owner, key(), a.id, {
      counted_kg: 5000,
      version: counted.version,
      reason: "Stale observed count",
    }),
    /changed/,
  );
});
test("concurrent outbound tickets cannot ship more than available stock", async () => {
  const m = await material(),
    a = await account(m.id),
    one = await ticket(m.id, a.id, "outbound", 1000),
    two = await ticket(m.id, a.id, "outbound", 1000);
  const results = await Promise.allSettled([
    station.weigh(owner, key(), one.id, { version: 1, second_weight_kg: 1700 }),
    station.weigh(owner, key(), two.id, { version: 1, second_weight_kg: 1700 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(Number((await stock.history(owner, a.id)).balance_kg), 300);
});
test("paired site transfers conserve material and rollback both legs on invalid destination", async () => {
  const m = await material(),
    a = await account(m.id),
    b = await account(m.id, 200),
    command = key(),
    body = {
      from_id: a.id,
      to_id: b.id,
      quantity_kg: 300,
      from_version: a.version,
      to_version: b.version,
      reason: "Recorded transfer between stock sites",
    };
  const moved: any = await stock.transfer(owner, command, body);
  assert.equal(Number(moved.from.balance_kg), 700);
  assert.equal(Number(moved.to.balance_kg), 500);
  assert.equal(
    ((await stock.transfer(owner, command, body)) as any).transfer_id,
    moved.transfer_id,
  );
  const pair = (
    await pool.query(
      "SELECT delta_kg FROM material_stock_movements WHERE transfer_id=$1",
      [moved.transfer_id],
    )
  ).rows;
  assert.equal(pair.length, 2);
  assert.equal(
    pair.reduce((n, r) => n + Number(r.delta_kg), 0),
    0,
  );
  await assert.rejects(stock.transfer(owner, key(), body), /changed/);
  await pool.query(
    "UPDATE material_stock_accounts SET active=false WHERE id=$1",
    [b.id],
  );
  await assert.rejects(
    stock.transfer(owner, key(), {
      ...body,
      from_version: moved.from.version,
      to_version: moved.to.version,
      quantity_kg: 100,
    }),
    /inactive/,
  );
  assert.equal(Number((await stock.history(owner, a.id)).balance_kg), 700);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM material_stock_movements WHERE kind='transfer_out'",
      )
    ).rows[0].count,
    "1",
  );
});
test("untracked tickets do not invent stock; material/site mismatches and unauthorized counts are rejected", async () => {
  const m = await material(),
    a = await account(m.id),
    other = await material();
  await assert.rejects(ticket(other.id, a.id), /stock site/);
  const t = await ticket(m.id, undefined);
  await station.weigh(owner, key(), t.id, {
    version: 1,
    second_weight_kg: 1000,
  });
  assert.equal(Number((await stock.history(owner, a.id)).balance_kg), 1000);
  await assert.rejects(
    account(m.id, 1000, "  Same site  ").then(() =>
      account(m.id, 1000, "same SITE"),
    ),
    /already exists/,
  );
  for (const role of ["driver", "customer"])
    await assert.rejects(stock.history({ ...owner, role }, a.id), /Forbidden/);
  for (const role of ["office", "accountant", "driver", "customer"])
    await assert.rejects(
      stock.count({ ...owner, role }, key(), a.id, {
        counted_kg: 0,
        version: a.version,
        reason: "Attempt",
      }),
      /Forbidden/,
    );
  const zero = await account(other.id, 0);
  assert.equal((await stock.history(owner, zero.id)).movements.length, 1);
});
test("stock reporting uses dated movement sums and zero-charge scale invoices do not create cash or journal entries", async () => {
  const m = await material({ rate_cents_per_tonne: 0 }),
    a = await account(m.id, 0),
    t = await ticket(m.id, a.id);
  await station.weigh(owner, key(), t.id, {
    version: 1,
    second_weight_kg: 1000,
  });
  const invoice: any = await station.invoice(owner, key(), t.id);
  assert.equal(invoice.amount_cents, 0);
  assert.equal(invoice.status, "paid");
  assert.equal(
    (await pool.query("SELECT count(*) FROM journal")).rows[0].count,
    "0",
  );
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings",
    )
  ).rows[0].today;
  const report = await reports.run(owner, "material_stock", {
    from: today,
    to: today,
  });
  assert.equal(report.rows.length, 1);
  assert.equal(Number(report.rows[0].stock_kg), 2000);
  assert.equal(
    (
      await reports.run(owner, "material_stock", {
        from: "2020-01-01",
        to: "2020-01-02",
      })
    ).rows.length,
    0,
  );
});
