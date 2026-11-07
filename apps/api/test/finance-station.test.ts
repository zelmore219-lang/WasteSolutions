import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import Stripe from "stripe";
import { Operations, Actor } from "../src/domain";
import { Finance } from "../src/finance";
import { Station } from "../src/station";
import { StripePayments } from "../src/stripe-payments";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  finance = new Finance(ops),
  station = new Station(ops),
  stripe = new StripePayments(ops, finance);
const key = () => randomUUID();
let owner: Actor, customer: Actor, customerId: string, materialId: string;
before(async () => {
  owner = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Finance test owner','owner') RETURNING *",
      [key(), "fin_" + key().slice(0, 8)],
    )
  ).rows[0];
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Finance test account",
    kind: "commercial",
    email: "finance@example.test",
    billing_address: "1 Finance Road",
  });
  customerId = c.id;
  customer = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,'Finance test customer','customer',$3) RETURNING *",
      [key(), "fin_" + key().slice(0, 8), customerId],
    )
  ).rows[0];
  materialId = (
    (await station.material(owner, key(), {
      name: "Recycling " + key(),
      category: "recycling",
      rate_cents_per_tonne: 8500,
      minimum_charge_cents: 1500,
    })) as any
  ).id;
});
after(async () => {
  await pool.end();
});
async function invoice() {
  const t: any = await station.open(owner, key(), {
    customer_id: customerId,
    material_id: materialId,
    direction: "inbound",
    vehicle_number: "CW-TEST",
    first_weight_kg: 10500,
    source_reference: "Manual test scale reading",
  });
  const weighed: any = await station.weigh(owner, key(), t.id, {
    second_weight_kg: 7000,
    version: 1,
  });
  assert.equal(weighed.net_kg, 3500);
  return (await station.invoice(owner, key(), t.id)) as any;
}
async function attempt(invoiceId: string, amount: number) {
  return (
    await pool.query(
      "INSERT INTO payment_attempts(invoice_id,amount_cents,provider_session_id) VALUES($1,$2,$3) RETURNING *",
      [invoiceId, amount, "cs_" + key()],
    )
  ).rows[0];
}
function event(a: any, type: string, paid = true): Stripe.Event {
  return {
    id: "evt_" + key(),
    type,
    data: {
      object: {
        id: a.provider_session_id,
        metadata: { corewaste_attempt_id: a.id },
        currency: "usd",
        amount_total: a.amount_cents,
        payment_status: paid ? "paid" : "unpaid",
        payment_intent: "pi_" + a.id,
      },
    },
  } as unknown as Stripe.Event;
}
async function signed(e: Stripe.Event) {
  const secret =
    process.env.STRIPE_WEBHOOK_SECRET || randomBytes(32).toString("hex");
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  const payload = JSON.stringify(e);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return stripe.webhook(Buffer.from(payload), header);
}
test("transfer station → gross/tare/net charge → partial payments → daily reconciliation and immutable ledger", async () => {
  const i = await invoice();
  assert.equal(i.amount_cents, 29750);
  const one: any = await finance.payment(owner, key(), i.id, {
    amount_cents: 10000,
    method: "cash",
    reference: key(),
  });
  let statement = await finance.statement(customer, customerId);
  assert.equal(
    Number(statement.find((x) => x.id === i.id).balance_cents),
    19750,
  );
  await Promise.all([
    finance.payment(owner, key(), i.id, {
      amount_cents: 19750,
      method: "check",
      reference: "FINAL-" + i.id,
    }),
    finance.payment(owner, key(), i.id, {
      amount_cents: 19750,
      method: "check",
      reference: "FINAL-" + i.id,
    }),
  ]);
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [i.id]))
      .rows[0].status,
    "paid",
  );
  await assert.rejects(
    finance.payment(owner, key(), i.id, {
      amount_cents: 1,
      method: "cash",
      reference: key(),
    }),
    /exceeds/,
  );
  await finance.refund(owner, key(), one.id, {
    amount_cents: 2500,
    reason: "Recorded cash refund",
    reference: key(),
  });
  statement = await finance.statement(customer, customerId);
  assert.equal(
    Number(statement.find((x) => x.id === i.id).balance_cents),
    2500,
  );
  await assert.rejects(
    finance.refund(owner, key(), one.id, {
      amount_cents: 10000,
      reason: "Too large",
      reference: key(),
    }),
    /exceeds/,
  );
  const debitCredit = (
    await pool.query(
      "SELECT sum(CASE WHEN debit_account='accounts_receivable' THEN amount_cents ELSE 0 END)-sum(CASE WHEN credit_account='accounts_receivable' THEN amount_cents ELSE 0 END) AS balance FROM journal WHERE invoice_id=$1",
      [i.id],
    )
  ).rows[0];
  assert.equal(Number(debitCredit.balance), 2500);
  const report = await station.reconcile(
    owner,
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(
      new Date(),
    ),
  );
  assert.ok(
    report.tonnage.some(
      (x) => x.category === "recycling" && Number(x.net_kg) >= 3500,
    ),
  );
  assert.ok(report.receipts.some((x) => x.method === "cash"));
  await assert.rejects(
    pool.query("DELETE FROM payments WHERE id=$1", [one.id]),
    /Append-only/,
  );
});
test("signed provider events allocate once; unsigned or mismatched payments cannot alter balances", async () => {
  const i = await invoice(),
    a = await attempt(i.id, i.amount_cents),
    e = event(a, "checkout.session.completed");
  await Promise.all([signed(e), signed(e)]);
  await signed({
    ...e,
    id: "evt_" + key(),
    type: "checkout.session.async_payment_succeeded",
  } as Stripe.Event);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1",
        [i.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [i.id]))
      .rows[0].status,
    "paid",
  );
  await assert.rejects(
    stripe.webhook(Buffer.from(JSON.stringify(e)), "invalid"),
    /Invalid payment signature/,
  );
  const second = await invoice(),
    b = await attempt(second.id, second.amount_cents),
    bad = event(b, "checkout.session.completed");
  (bad.data.object as any).amount_total = 1;
  await assert.rejects(signed(bad), /does not match/);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM provider_events WHERE id=$1",
        [bad.id],
      )
    ).rows[0].n,
    0,
  );
});
test("failed ACH payment keeps invoice due and creates a customer notification/outbox entry", async () => {
  const i = await invoice(),
    a = await attempt(i.id, i.amount_cents),
    e = event(a, "checkout.session.async_payment_failed", false);
  await signed(e);
  await signed(e);
  assert.equal(
    (
      await pool.query("SELECT status FROM payment_attempts WHERE id=$1", [
        a.id,
      ])
    ).rows[0].status,
    "failed",
  );
  assert.equal(
    Number(
      (await finance.statement(customer, customerId)).find((x) => x.id === i.id)
        .balance_cents,
    ),
    i.amount_cents,
  );
  const notice = (
    await pool.query("SELECT * FROM notifications WHERE source_key=$1", [
      "payment-failed:" + a.id,
    ])
  ).rows[0];
  assert.equal(notice.kind, "payment_failed");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM notification_outbox WHERE notification_id=$1",
        [notice.id],
      )
    ).rows[0].n,
    1,
  );
});
test("captured funds after intervening payment become accounted customer credit and can pay another invoice", async () => {
  const i = await invoice(),
    a = await attempt(i.id, i.amount_cents);
  await finance.payment(owner, key(), i.id, {
    amount_cents: i.amount_cents,
    method: "cash",
    reference: key(),
  });
  const e = event(a, "checkout.session.completed");
  await signed(e);
  const credit = (
    await pool.query(
      "SELECT * FROM customer_credits WHERE source_reference=$1",
      ["pi_" + a.id],
    )
  ).rows[0];
  assert.equal(credit.remaining_cents, i.amount_cents);
  assert.equal(
    (
      await pool.query("SELECT status FROM payment_attempts WHERE id=$1", [
        a.id,
      ])
    ).rows[0].status,
    "review",
  );
  const next = await invoice();
  await finance.applyCredit(owner, key(), credit.id, {
    invoice_id: next.id,
    amount_cents: next.amount_cents,
  });
  assert.equal(
    (
      await pool.query(
        "SELECT remaining_cents FROM customer_credits WHERE id=$1",
        [credit.id],
      )
    ).rows[0].remaining_cents,
    0,
  );
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [next.id]))
      .rows[0].status,
    "paid",
  );
});
test("scale direction, stale versions, expense permissions and dollar limits are enforced", async () => {
  const t: any = await station.open(owner, key(), {
    customer_id: customerId,
    material_id: materialId,
    direction: "outbound",
    vehicle_number: "OUT-TEST",
    first_weight_kg: 7000,
    source_reference: "Manual tare",
  });
  await assert.rejects(
    station.weigh(owner, key(), t.id, { second_weight_kg: 6000, version: 1 }),
    /Gross weight/,
  );
  await assert.rejects(station.invoice(owner, key(), t.id), /both weighings/);
  const done: any = await station.weigh(owner, key(), t.id, {
    second_weight_kg: 7100,
    version: 1,
  });
  assert.equal(done.net_kg, 100);
  const i: any = await station.invoice(owner, key(), t.id);
  assert.equal(i.amount_cents, 1500);
  await assert.rejects(
    station.weigh(owner, key(), t.id, { second_weight_kg: 7200, version: 1 }),
    /changed/,
  );
  await assert.rejects(finance.expense(customer, key(), {}), /Forbidden/);
  const expense: any = await finance.expense(owner, key(), {
    category: "fuel",
    vendor: "Test fuel station",
    amount_cents: 15000,
    expense_date: "2026-11-06",
    reference: key(),
  });
  assert.equal(
    (
      await pool.query("SELECT debit_account FROM journal WHERE source_id=$1", [
        expense.id,
      ])
    ).rows[0].debit_account,
    "expense:fuel",
  );
});
