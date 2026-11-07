import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
import { MonthlyBilling } from "../src/monthly-billing";
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
  billing: MonthlyBilling,
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
  billing = new MonthlyBilling(ops);
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
async function agreement(start = "2026-10-15", extra: any = {}) {
  return (await wf.agreement(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "commercial",
    price_cents: 0,
    monthly_rate_cents: 20000,
    billing_mode: "monthly",
    interval_days: 7,
    next_service_date: start,
    ...extra,
  })) as any;
}
async function completeAll(id: string) {
  const orders = (
    await pool.query(
      "SELECT * FROM orders WHERE agreement_id=$1 ORDER BY scheduled_date",
      [id],
    )
  ).rows;
  for (const order of orders) {
    if (order.status === "completed") continue;
    const assigned: any = await ops.assign(owner, key(), order.id, {
      driver_id: driver.id,
      truck_id: truckId,
      version: order.version,
    });
    const started: any = await ops.transition(driver, key(), order.id, {
      status: "in_progress",
      version: assigned.version,
    });
    await ops.transition(driver, key(), order.id, {
      status: "completed",
      version: started.version,
      service_date: order.scheduled_date,
    });
  }
  return orders;
}
test("monthly contract bills verified visits once, prorates calendar days, and posts period revenue", async () => {
  const a = await agreement();
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  const orders = await completeAll(a.id);
  assert.equal(orders.length, 3);
  assert.ok(orders.every((o) => o.price_cents === 0));
  await assert.rejects(
    ops.invoice(owner, key(), orders[0].id),
    /billed together/,
  );
  const [first, second]: any[] = await Promise.all([
    billing.invoice(owner, key(), a.id, { period_start: "2026-10-01" }),
    billing.invoice(owner, key(), a.id, { period_start: "2026-10-01" }),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(first.amount_cents, 10968);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM monthly_invoice_orders WHERE invoice_id=$1",
        [first.id],
      )
    ).rows[0].n,
    3,
  );
  const journal = (
    await pool.query("SELECT * FROM journal WHERE invoice_id=$1", [first.id])
  ).rows[0];
  assert.equal(journal.debit_account, "accounts_receivable");
  assert.equal(journal.credit_account, "service_revenue");
  assert.equal(journal.amount_cents, 10968);
  assert.equal(journal.posting_date, "2026-10-31");
  assert.equal(
    (
      await pool.query(
        "SELECT next_billing_month FROM service_agreements WHERE id=$1",
        [a.id],
      )
    ).rows[0].next_billing_month,
    "2026-11-01",
  );
  const finance = new Finance(ops);
  await finance.payment(owner, key(), first.id, {
    amount_cents: 10968,
    method: "check",
    reference: key(),
  });
  assert.equal((await ops.invoices(owner))[0].balance_cents, "0");
  await assert.rejects(
    pool.query("UPDATE monthly_billing_periods SET amount_cents=1"),
    /Append-only/,
  );
  await assert.rejects(
    pool.query("DELETE FROM monthly_invoice_orders"),
    /Append-only/,
  );
});
test("monthly billing refuses ungenerated or incomplete service and never creates a partial invoice", async () => {
  const a = await agreement();
  await assert.rejects(
    billing.invoice(owner, key(), a.id, { period_start: "2026-10-01" }),
    /Generate all service/,
  );
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  await assert.rejects(
    billing.invoice(owner, key(), a.id, { period_start: "2026-10-01" }),
    /complete all/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM monthly_billing_periods"))
      .rows[0].n,
    0,
  );
  await assert.rejects(
    billing.invoice(driver, key(), a.id, { period_start: "2026-10-01" }),
  );
  const current = (
    await pool.query(
      "SELECT date_trunc('month',now() AT TIME ZONE timezone)::date AS month FROM company_settings WHERE singleton",
    )
  ).rows[0].month;
  const b = await agreement(current);
  await assert.rejects(
    billing.invoice(owner, key(), b.id, { period_start: current }),
    /closed calendar month/,
  );
});
test("finite contracts generate no service after their end and last-month billing uses the agreed coverage", async () => {
  const a = await agreement("2026-10-01", { contract_end_date: "2026-10-15" });
  const generated: any = await wf.generate(owner, key(), {
    through_date: "2026-11-30",
  });
  assert.equal(generated.generated, 3);
  assert.equal(generated.has_more, false);
  const again: any = await wf.generate(owner, key(), {
    through_date: "2026-12-31",
  });
  assert.equal(again.generated, 0);
  assert.equal(again.has_more, false);
  await completeAll(a.id);
  const invoice: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2026-10-01",
  });
  assert.equal(invoice.amount_cents, 9677);
  assert.equal((await billing.due(owner)).length, 0);
});
test("ending an agreement cancels only unstarted unrouted future work and stops generation", async () => {
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0].today;
  const a = await agreement(today);
  const through = (
    await pool.query("SELECT ($1::date+21)::text AS date", [today])
  ).rows[0].date;
  await wf.generate(owner, key(), { through_date: through });
  const ended: any = await billing.end(owner, key(), a.id, {
    end_date: today,
    version: 1,
    reason: "Customer requested end of service",
  });
  assert.equal(ended.contract_end_date, today);
  const future = (
    await pool.query(
      "SELECT * FROM orders WHERE agreement_id=$1 AND scheduled_date>$2",
      [a.id, today],
    )
  ).rows;
  assert.equal(future.length, 3);
  assert.ok(future.every((o) => o.status === "cancelled"));
  const generated: any = await wf.generate(owner, key(), {
    through_date: through,
  });
  assert.equal(generated.has_more, false);
  assert.equal(generated.generated, 0);
  await assert.rejects(
    billing.end(owner, key(), a.id, {
      end_date: through,
      version: 1,
      reason: "Stale amendment",
    }),
    /Agreement changed/,
  );
});

import { ServiceCalendar } from "../src/service-calendar";
test("zone weekdays and holiday overrides preserve recurrence and apply only a current reviewed preview", async () => {
  const calendar = new ServiceCalendar(ops);
  const zone: any = await calendar.zone(owner, key(), {
    name: "North collection",
    description: "Weekday service",
    weekdays: [1, 2, 3, 4, 5],
    active: true,
  });
  await calendar.assignLocation(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    zone_id: zone.id,
  });
  await calendar.change(owner, key(), {
    zone_id: null,
    original_date: "2026-12-25",
    replacement_date: "2026-12-26",
    reason: "Company holiday",
  });
  const a = await agreement("2026-12-25", { billing_mode: "per_service" });
  await wf.generate(owner, key(), { through_date: "2026-12-25" });
  let order = (
    await pool.query("SELECT * FROM orders WHERE agreement_id=$1", [a.id])
  ).rows[0];
  assert.equal(order.scheduled_date, "2026-12-28");
  assert.equal(order.service_occurrence_date, "2026-12-25");
  assert.equal(order.zone_id, zone.id);
  await calendar.change(owner, key(), {
    zone_id: zone.id,
    original_date: "2026-12-25",
    replacement_date: "2026-12-29",
    reason: "North zone alternate collection",
  });
  const range = { from: "2026-12-25", through: "2026-12-25", zone_id: zone.id };
  const first = await calendar.preview(owner, range);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].planned_date, "2026-12-29");
  await ops.assign(owner, key(), order.id, {
    version: 1,
    driver_id: driver.id,
    truck_id: truckId,
  });
  await assert.rejects(
    calendar.apply(owner, key(), { ...range, preview_hash: first.hash }),
    /preview again/,
  );
  const current = await calendar.preview(owner, range),
    applyKey = key(),
    payload = { ...range, preview_hash: current.hash };
  assert.deepEqual(await calendar.apply(owner, applyKey, payload), {
    changed: 1,
  });
  assert.deepEqual(await calendar.apply(owner, applyKey, payload), {
    changed: 1,
  });
  order = (await pool.query("SELECT * FROM orders WHERE id=$1", [order.id]))
    .rows[0];
  assert.equal(order.scheduled_date, "2026-12-29");
  assert.equal(order.service_occurrence_date, "2026-12-25");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM notifications WHERE customer_id=$1 AND kind='holiday_changed'",
        [customerId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    ((await wf.generate(owner, key(), { through_date: "2026-12-25" })) as any)
      .generated,
    0,
  );
});
test("holiday and weekday cycles roll back rule or zone changes without altering service", async () => {
  const calendar = new ServiceCalendar(ops);
  const zone: any = await calendar.zone(owner, key(), {
    name: "Cycle fixture",
    description: "",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    active: true,
  });
  await calendar.change(owner, key(), {
    zone_id: null,
    original_date: "2026-12-25",
    replacement_date: "2026-12-26",
    reason: "First shift",
  });
  await assert.rejects(
    calendar.change(owner, key(), {
      zone_id: null,
      original_date: "2026-12-26",
      replacement_date: "2026-12-25",
      reason: "Invalid reverse shift",
    }),
    /cycle/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM service_calendar_changes",
      )
    ).rows[0].n,
    1,
  );
  await calendar.change(owner, key(), {
    zone_id: null,
    original_date: "2027-01-01",
    replacement_date: "2026-12-25",
    reason: "Earlier special collection",
  });
  await assert.rejects(
    calendar.zone(owner, key(), {
      id: zone.id,
      version: 1,
      name: zone.name,
      description: "",
      weekdays: [5],
      active: true,
    }),
    /cycle/,
  );
  const unchanged = (
    await pool.query("SELECT * FROM service_zones WHERE id=$1", [zone.id])
  ).rows[0];
  assert.equal(unchanged.version, 1);
  assert.equal(unchanged.weekdays.length, 7);
});
test("calendar collisions never generate or commit duplicate actual service dates", async () => {
  const calendar = new ServiceCalendar(ops);
  await calendar.change(owner, key(), {
    zone_id: null,
    original_date: "2026-12-25",
    replacement_date: "2026-12-26",
    reason: "Holiday",
  });
  const a = await agreement("2026-12-25", {
    billing_mode: "per_service",
    interval_days: 1,
  });
  await assert.rejects(
    wf.generate(owner, key(), { through_date: "2026-12-26" }),
    /share a date/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT next_service_date FROM service_agreements WHERE id=$1",
        [a.id],
      )
    ).rows[0].next_service_date,
    "2026-12-25",
  );
});
test("calendar preview marks routed and started service as blocked", async () => {
  const calendar = new ServiceCalendar(ops),
    a = await agreement("2026-12-25", { billing_mode: "per_service" });
  await wf.generate(owner, key(), { through_date: "2026-12-25" });
  const order = (
    await pool.query("SELECT * FROM orders WHERE agreement_id=$1", [a.id])
  ).rows[0];
  await wf.route(owner, key(), {
    name: "Calendar protected route",
    service_date: "2026-12-25",
    driver_id: driver.id,
    truck_id: truckId,
    order_ids: [order.id],
  });
  await calendar.change(owner, key(), {
    zone_id: null,
    original_date: "2026-12-25",
    replacement_date: "2026-12-26",
    reason: "Holiday",
  });
  const range = { from: "2026-12-25", through: "2026-12-25" };
  let preview = await calendar.preview(owner, range);
  assert.match(preview.items[0].blocked!, /route/);
  await assert.rejects(
    calendar.apply(owner, key(), { ...range, preview_hash: preview.hash }),
    /belongs to a route/,
  );
  await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: 2,
  });
  preview = await calendar.preview(owner, range);
  assert.equal(preview.items[0].blocked, "Service has started");
  assert.equal(
    (
      await pool.query("SELECT scheduled_date FROM orders WHERE id=$1", [
        order.id,
      ])
    ).rows[0].scheduled_date,
    "2026-12-25",
  );
});
test("a holiday crossing month-end stays linked to its original monthly contract period", async () => {
  const calendar = new ServiceCalendar(ops);
  await calendar.change(owner, key(), {
    zone_id: null,
    original_date: "2026-10-29",
    replacement_date: "2026-11-02",
    reason: "Facility closure",
  });
  const a = await agreement("2026-10-29");
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  const order = (
    await pool.query("SELECT * FROM orders WHERE agreement_id=$1", [a.id])
  ).rows[0];
  assert.equal(order.scheduled_date, "2026-11-02");
  assert.equal(order.service_occurrence_date, "2026-10-29");
  await assert.rejects(
    billing.invoice(owner, key(), a.id, { period_start: "2026-10-01" }),
    /complete all/,
  );
  await completeAll(a.id);
  const invoice: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2026-10-01",
  });
  assert.equal(invoice.amount_cents, 1935);
});

test("anniversary periods clamp February and restore the original day without drifting", async () => {
  const a = await agreement("2024-01-31", {
    billing_alignment: "anniversary",
    interval_days: 14,
  });
  await wf.generate(owner, key(), { through_date: "2024-03-30" });
  await completeAll(a.id);
  const january: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2024-01-31",
  });
  assert.equal(january.amount_cents, 20000);
  assert.equal(
    (
      await pool.query(
        "SELECT next_billing_month FROM service_agreements WHERE id=$1",
        [a.id],
      )
    ).rows[0].next_billing_month,
    "2024-02-29",
  );
  const february: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2024-02-29",
  });
  assert.equal(february.amount_cents, 20000);
  assert.equal(
    (
      await pool.query(
        "SELECT next_billing_month FROM service_agreements WHERE id=$1",
        [a.id],
      )
    ).rows[0].next_billing_month,
    "2024-03-31",
  );
  const periods = (
    await pool.query(
      "SELECT period_start,period_end,billing_alignment,full_period_cents FROM monthly_billing_periods WHERE agreement_id=$1 ORDER BY period_start",
      [a.id],
    )
  ).rows;
  assert.deepEqual(
    periods.map((p) => [p.period_start, p.period_end]),
    [
      ["2024-01-31", "2024-02-28"],
      ["2024-02-29", "2024-03-30"],
    ],
  );
  assert.ok(
    periods.every(
      (p) =>
        p.billing_alignment === "anniversary" && p.full_period_cents === 20000,
    ),
  );
});
test("quarterly calendar billing prorates a partial first period against the full cycle and posts period-end revenue", async () => {
  const a = await agreement("2026-07-15", {
    billing_cycle_months: 3,
    contract_end_date: "2026-09-30",
  });
  await wf.generate(owner, key(), { through_date: "2026-09-30" });
  await completeAll(a.id);
  const i: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2026-07-01",
  });
  assert.equal(i.amount_cents, 50870);
  const p = (
    await pool.query(
      "SELECT * FROM monthly_billing_periods WHERE agreement_id=$1",
      [a.id],
    )
  ).rows[0];
  assert.equal(p.period_end, "2026-09-30");
  assert.equal(p.billing_cycle_months, 3);
  assert.equal(p.full_period_cents, 60000);
  assert.equal(
    (
      await pool.query("SELECT posting_date FROM journal WHERE invoice_id=$1", [
        i.id,
      ])
    ).rows[0].posting_date,
    "2026-09-30",
  );
  assert.equal(
    (
      (await billing.invoice(owner, key(), a.id, {
        period_start: "2026-07-01",
      })) as any
    ).id,
    i.id,
  );
});
test("annual anniversary bills only after its full period closes and closed-period queue uses actual cycle ends", async () => {
  const a = await agreement("2025-11-01", {
    billing_cycle_months: 12,
    billing_alignment: "anniversary",
    interval_days: 90,
  });
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  await completeAll(a.id);
  assert.ok((await billing.due(owner)).some((r) => r.id === a.id));
  const i: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2025-11-01",
  });
  assert.equal(i.amount_cents, 240000);
  assert.ok(!(await billing.due(owner)).some((r) => r.id === a.id));
  const open = await agreement("2026-10-01", { billing_cycle_months: 3 });
  assert.ok(!(await billing.due(owner)).some((r) => r.id === open.id));
  await assert.rejects(
    billing.invoice(owner, key(), open.id, { period_start: "2026-10-01" }),
    /fully closed/,
  );
});
test("partial final anniversary periods prorate actual cycle days and free contracts settle without journal entries", async () => {
  const a = await agreement("2026-08-20", {
    billing_alignment: "anniversary",
    contract_end_date: "2026-09-05",
  });
  await wf.generate(owner, key(), { through_date: "2026-09-05" });
  await completeAll(a.id);
  const i: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2026-08-20",
  });
  assert.equal(i.amount_cents, 10968);
  const free = await agreement("2026-10-01", { monthly_rate_cents: 0 });
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  await completeAll(free.id);
  const zero: any = await billing.invoice(owner, key(), free.id, {
    period_start: "2026-10-01",
  });
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
  await assert.rejects(
    agreement("2026-10-01", {
      billing_cycle_months: 12,
      monthly_rate_cents: 100000000,
    }),
    /supported invoice/,
  );
});

test("advance contract invoices open coverage once without claiming future work or earned revenue", async () => {
  const dates = (
    await pool.query(
      "SELECT date_trunc('month',now() AT TIME ZONE timezone)::date AS first,(now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0];
  const a = await agreement(dates.first, { billing_timing: "advance" });
  assert.ok((await billing.due(owner)).some((x) => x.id === a.id));
  const [invoice, retry]: any[] = await Promise.all([
    billing.invoice(owner, key(), a.id, { period_start: dates.first }),
    billing.invoice(owner, key(), a.id, { period_start: dates.first }),
  ]);
  assert.equal(invoice.id, retry.id);
  assert.equal(invoice.amount_cents, 20000);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM monthly_invoice_orders"))
      .rows[0].n,
    0,
  );
  const journal = (
    await pool.query("SELECT * FROM journal WHERE invoice_id=$1", [invoice.id])
  ).rows;
  assert.equal(journal.length, 1);
  assert.equal(journal[0].debit_account, "accounts_receivable");
  assert.equal(journal[0].credit_account, "deferred_revenue");
  assert.equal(journal[0].posting_date, dates.today);
  const period = (
    await pool.query(
      "SELECT * FROM monthly_billing_periods WHERE agreement_id=$1",
      [a.id],
    )
  ).rows[0];
  assert.equal(period.billing_timing, "advance");
  assert.equal((await billing.pendingRecognition(owner)).length, 0);
  await assert.rejects(
    billing.recognize(owner, key(), period.id),
    /fully closed/,
  );
  const line = (
    await pool.query(
      "SELECT description FROM invoice_lines WHERE invoice_id=$1",
      [invoice.id],
    )
  ).rows[0].description;
  assert.match(line, /Reserved contract service/);
  assert.doesNotMatch(line, /completed visits/);
  assert.ok(!(await billing.due(owner)).some((x) => x.id === a.id));
});

test("prepaid recognition requires every visit and transfers only remaining deferred value; later credits reverse earned revenue", async () => {
  const { BillingControls } = await import("../src/billing-controls");
  const credits = new BillingControls(ops),
    finance = new Finance(ops);
  const a = await agreement("2026-10-01", {
    billing_timing: "advance",
    contract_end_date: "2026-10-31",
  });
  const invoice: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2026-10-01",
  });
  const period = (
    await pool.query(
      "SELECT * FROM monthly_billing_periods WHERE agreement_id=$1",
      [a.id],
    )
  ).rows[0];
  assert.equal((await billing.pendingRecognition(owner))[0].id, period.id);
  await assert.rejects(
    billing.recognize(owner, key(), period.id),
    /Generate and complete/,
  );
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  await assert.rejects(
    billing.recognize(owner, key(), period.id),
    /Generate and complete/,
  );
  await credits.creditInvoice(owner, key(), invoice.id, {
    amount_cents: 5000,
    reason: "Agreed price reduction before service verification",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT debit_account FROM journal WHERE source_kind='credit_memo'",
      )
    ).rows[0].debit_account,
    "deferred_revenue",
  );
  await finance.payment(owner, key(), invoice.id, {
    amount_cents: 15000,
    method: "check",
    reference: key(),
  });
  const orders = await completeAll(a.id);
  const command = key();
  const first: any = await billing.recognize(owner, command, period.id);
  const retry: any = await billing.recognize(owner, command, period.id);
  const duplicate: any = await billing.recognize(owner, key(), period.id);
  assert.equal(first.id, retry.id);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.amount_cents, 15000);
  assert.equal(first.credited_cents, 5000);
  assert.equal(first.order_ids.length, orders.length);
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0].today;
  assert.equal(first.posting_date, today);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM journal WHERE source_kind='contract_revenue'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM payments")).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM orders WHERE status='invoiced'",
      )
    ).rows[0].n,
    orders.length,
  );
  assert.equal((await billing.pendingRecognition(owner)).length, 0);
  await assert.rejects(
    pool.query("UPDATE contract_revenue_recognitions SET amount_cents=1"),
    /Append-only/,
  );
  const credit: any = await credits.creditInvoice(owner, key(), invoice.id, {
    amount_cents: 2500,
    reason: "Service adjustment after recognition",
  });
  assert.ok(credit.credit_id);
  const liability = (
    await pool.query(
      "SELECT remaining_cents FROM customer_credits WHERE id=$1",
      [credit.credit_id],
    )
  ).rows[0];
  assert.equal(liability.remaining_cents, 2500);
  const reversals = (
    await pool.query(
      "SELECT debit_account,amount_cents FROM journal WHERE source_kind='credit_memo' ORDER BY amount_cents DESC",
    )
  ).rows;
  assert.deepEqual(reversals, [
    { debit_account: "deferred_revenue", amount_cents: 5000 },
    { debit_account: "service_revenue", amount_cents: 2500 },
  ]);
  const balance = (
    await pool.query("SELECT balance_cents FROM invoice_balances WHERE id=$1", [
      invoice.id,
    ])
  ).rows[0];
  assert.equal(Number(balance.balance_cents), 0);
});

test("shortening prepaid coverage requires a finance credit before office cancellation", async () => {
  const { BillingControls } = await import("../src/billing-controls");
  const dates = (
    await pool.query(
      "SELECT date_trunc('month',now() AT TIME ZONE timezone)::date AS first,(now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0];
  const a = await agreement(dates.first, {
    billing_timing: "advance",
    billing_cycle_months: 3,
  });
  const invoice: any = await billing.invoice(owner, key(), a.id, {
    period_start: dates.first,
  });
  const period = (
    await pool.query(
      "SELECT * FROM monthly_billing_periods WHERE agreement_id=$1",
      [a.id],
    )
  ).rows[0];
  await wf.generate(owner, key(), { through_date: period.period_end });
  const body = {
    end_date: dates.today,
    version: 1,
    reason: "Customer requested cancellation after today",
  };
  await assert.rejects(
    billing.end(owner, key(), a.id, body),
    /Finance must credit prepaid coverage/,
  );
  assert.equal(
    (
      await pool.query("SELECT version FROM service_agreements WHERE id=$1", [
        a.id,
      ])
    ).rows[0].version,
    1,
  );
  const days = (
    await pool.query(
      "SELECT ($2::date-$1::date+1)::int AS active,($3::date-$1::date+1)::int AS full",
      [dates.first, dates.today, period.period_end],
    )
  ).rows[0];
  const revised = Number(
    (60000n * BigInt(days.active) + BigInt(Math.floor(days.full / 2))) /
      BigInt(days.full),
  );
  await new BillingControls(ops).creditInvoice(owner, key(), invoice.id, {
    amount_cents: 60000 - revised,
    reason: "Credit unused prepaid coverage",
  });
  const ended: any = await billing.end(owner, key(), a.id, body);
  assert.equal(ended.contract_end_date, dates.today);
  assert.equal(ended.version, 2);
  const future = (
    await pool.query(
      "SELECT status FROM orders WHERE agreement_id=$1 AND service_occurrence_date>$2",
      [a.id, dates.today],
    )
  ).rows;
  assert.ok(future.length > 0);
  assert.ok(future.every((o) => o.status === "cancelled"));
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT net_amount_cents FROM invoice_balances WHERE id=$1",
          [invoice.id],
        )
      ).rows[0].net_amount_cents,
    ),
    revised,
  );
});

test("free advance coverage still needs verified work but never posts a zero journal or payment", async () => {
  const a = await agreement("2026-10-01", {
    billing_timing: "advance",
    monthly_rate_cents: 0,
    contract_end_date: "2026-10-31",
  });
  const invoice: any = await billing.invoice(owner, key(), a.id, {
    period_start: "2026-10-01",
  });
  assert.equal(invoice.status, "paid");
  const period = (
    await pool.query(
      "SELECT id FROM monthly_billing_periods WHERE agreement_id=$1",
      [a.id],
    )
  ).rows[0];
  await assert.rejects(
    billing.recognize(owner, key(), period.id),
    /Generate and complete/,
  );
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  await completeAll(a.id);
  const result: any = await billing.recognize(owner, key(), period.id);
  assert.equal(result.amount_cents, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM journal")).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM payments")).rows[0].n,
    0,
  );
});

test("advance billing enforces finance access, start date, and contract-only timing", async () => {
  await assert.rejects(
    wf.agreement(owner, key(), {
      customer_id: customerId,
      location_id: locationId,
      kind: "commercial",
      price_cents: 1000,
      interval_days: 7,
      next_service_date: "2026-10-01",
      billing_timing: "advance",
    }),
    /Advance billing requires/,
  );
  const tomorrow = (
    await pool.query(
      "SELECT ((now() AT TIME ZONE timezone)::date+1)::text AS date FROM company_settings WHERE singleton",
    )
  ).rows[0].date;
  const a = await agreement(tomorrow, {
    billing_timing: "advance",
    billing_alignment: "anniversary",
  });
  await assert.rejects(
    billing.invoice(owner, key(), a.id, { period_start: tomorrow }),
    /coverage begins/,
  );
  await assert.rejects(
    billing.invoice(driver, key(), a.id, { period_start: tomorrow }),
  );
  await assert.rejects(billing.pendingRecognition(driver));
  assert.ok(!(await billing.due(owner)).some((x) => x.id === a.id));
  const closed = await agreement("2026-10-01", { billing_timing: "advance" });
  await billing.invoice(owner, key(), closed.id, {
    period_start: "2026-10-01",
  });
  const period = (
    await pool.query(
      "SELECT id FROM monthly_billing_periods WHERE agreement_id=$1",
      [closed.id],
    )
  ).rows[0];
  await assert.rejects(billing.recognize(driver, key(), period.id));
});

test("daily automation issues advance coverage and recognizes verified closed coverage without repeat charges on rerun", async () => {
  const { BillingControls } = await import("../src/billing-controls");
  const { Automation } = await import("../src/automation");
  const { StripeProfiles } = await import("../src/stripe-profiles");
  const closed = await agreement("2026-10-01", {
    billing_timing: "advance",
    contract_end_date: "2026-10-31",
  });
  await billing.invoice(owner, key(), closed.id, {
    period_start: "2026-10-01",
  });
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  await completeAll(closed.id);
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0].today;
  const current = await agreement(today, {
    billing_timing: "advance",
    billing_alignment: "anniversary",
  });
  const automation = new Automation(
    ops,
    wf,
    new BillingControls(ops),
    new StripeProfiles(ops, async () => ({ received: true })),
  );
  const first = await automation.run(owner, today);
  assert.equal(first.status, "completed");
  assert.equal(first.summary.monthly_invoices, 1);
  assert.equal(first.summary.contract_revenue_recognitions, 1);
  assert.deepEqual(first.summary.errors, []);
  const again = await automation.run(owner, today);
  assert.equal(again.status, "completed");
  assert.equal(again.summary.monthly_invoices, 0);
  assert.equal(again.summary.contract_revenue_recognitions, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n,
    2,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM contract_revenue_recognitions",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM payments")).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT billing_timing FROM monthly_billing_periods WHERE agreement_id=$1",
        [current.id],
      )
    ).rows[0].billing_timing,
    "advance",
  );
});

test("prepaid service contribution excludes deferred charges and keeps recognized multi-route contract revenue unallocated", async () => {
  const { Reports } = await import("../src/reports");
  const reports = new Reports(ops);
  const a = await agreement("2026-10-01", {
    billing_timing: "advance",
    contract_end_date: "2026-10-31",
    interval_days: 14,
  });
  await billing.invoice(owner, key(), a.id, { period_start: "2026-10-01" });
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0].today;
  assert.equal(
    (
      await reports.run(owner, "service_profitability", {
        from: today,
        to: today,
      })
    ).rows.length,
    0,
  );
  await wf.generate(owner, key(), { through_date: "2026-10-31" });
  const orders = (
    await pool.query(
      "SELECT * FROM orders WHERE agreement_id=$1 ORDER BY scheduled_date",
      [a.id],
    )
  ).rows;
  assert.equal(orders.length, 3);
  for (const order of orders) {
    await wf.route(owner, key(), {
      name: "Contract visit " + order.scheduled_date,
      service_date: order.scheduled_date,
      driver_id: driver.id,
      truck_id: truckId,
      order_ids: [order.id],
    });
    const assigned = (
      await pool.query("SELECT version FROM orders WHERE id=$1", [order.id])
    ).rows[0];
    const started: any = await ops.transition(driver, key(), order.id, {
      status: "in_progress",
      version: assigned.version,
    });
    await ops.transition(driver, key(), order.id, {
      status: "completed",
      version: started.version,
      service_date: order.scheduled_date,
    });
  }
  const period = (
    await pool.query(
      "SELECT id FROM monthly_billing_periods WHERE agreement_id=$1",
      [a.id],
    )
  ).rows[0];
  await billing.recognize(owner, key(), period.id);
  const service = await reports.run(owner, "service_profitability", {
    from: today,
    to: today,
  });
  assert.equal(service.rows.length, 1);
  assert.equal(service.rows[0].service, "commercial");
  assert.equal(Number(service.rows[0].revenue_cents), 20000);
  const byRoute = await reports.run(owner, "route_profitability", {
    from: today,
    to: today,
  });
  assert.equal(byRoute.rows.length, 1);
  assert.equal(byRoute.rows[0].route, "Unallocated / mixed routes");
  assert.equal(Number(byRoute.rows[0].revenue_cents), 20000);
});
