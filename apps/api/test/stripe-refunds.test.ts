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
import Stripe from "stripe";
import { StripeRefunds, RefundProvider } from "../src/stripe-refunds";
import { StripePayments } from "../src/stripe-payments";
import { BillingControls } from "../src/billing-controls";
let refunds: StripeRefunds,
  payments: StripePayments,
  controls: BillingControls,
  provider: RefundProvider;
let receipts: Map<string, any>,
  creates: number,
  retrieves: number,
  enabled: boolean;
let providerState: "succeeded" | "pending" | "failed" | "lost";
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_refund_" + key();
  process.env.PAYMENTS_MODE = "test";
  creates = 0;
  retrieves = 0;
  enabled = true;
  providerState = "succeeded";
  receipts = new Map();
  provider = {
    configured: () => enabled,
    create: async (input, requestKey) => {
      creates++;
      assert.ok(requestKey.startsWith("corewaste-refund-"));
      const receipt = {
        id: "re_" + key().replaceAll("-", ""),
        payment_intent: input.payment_intent,
        currency: "usd",
        amount: input.amount,
        status: providerState === "lost" ? "succeeded" : providerState,
        metadata: input.metadata,
        livemode: false,
      };
      receipts.set(receipt.id, structuredClone(receipt));
      if (providerState === "lost")
        throw Error("Lost provider reply with sk_test_do_not_expose");
      return receipt;
    },
    retrieve: async (id) => {
      retrieves++;
      if (!receipts.has(id)) throw Error("Receipt not found");
      return structuredClone(receipts.get(id));
    },
  };
  refunds = new StripeRefunds(ops, provider);
  payments = new StripePayments(ops, new Finance(ops));
  payments.refundEvents = (event) => refunds.event(event);
  controls = new BillingControls(ops);
});
async function makeInvoice() {
  const date = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS date FROM company_settings WHERE singleton",
    )
  ).rows[0].date;
  const order: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "bulk",
    scheduled_date: date,
    price_cents: 10000,
  });
  const assigned: any = await ops.assign(owner, key(), order.id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  const started: any = await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: assigned.version,
  });
  await ops.transition(driver, key(), order.id, {
    status: "completed",
    version: started.version,
    service_date: date,
  });
  return (await ops.invoice(owner, key(), order.id)) as any;
}
async function capture(invoice: any) {
  const attempt = (
    await pool.query(
      "INSERT INTO payment_attempts(invoice_id,amount_cents) VALUES($1,10000) RETURNING id",
      [invoice.id],
    )
  ).rows[0];
  const pi = "pi_" + key().replaceAll("-", "");
  await payments.process({
    id: "evt_" + key(),
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_" + key(),
        metadata: { corewaste_attempt_id: attempt.id },
        payment_status: "paid",
        currency: "usd",
        amount_total: 10000,
        payment_intent: pi,
      },
    },
  } as any);
  return pi;
}
async function paidInvoice() {
  const invoice = await makeInvoice();
  const pi = await capture(invoice);
  const payment = (
    await pool.query(
      "SELECT * FROM payments WHERE method='stripe' AND reference=$1",
      [pi],
    )
  ).rows[0];
  return { invoice, payment, pi };
}
const requestBody = (amount_cents = 3000) => ({
  amount_cents,
  reason: "Finance-approved return of original payment",
});
async function signedRefund(event: any) {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_refund_" + key();
  const payload = JSON.stringify(event),
    secret = process.env.STRIPE_WEBHOOK_SECRET;
  return payments.webhook(
    Buffer.from(payload),
    Stripe.webhooks.generateTestHeaderString({ payload, secret }),
  );
}

test("Stripe refund reservations serialize, preserve request identity and cancel only before provider submission", async () => {
  const { payment } = await paidInvoice();
  const results = await Promise.allSettled([
    refunds.request(owner, key(), "payment", payment.id, requestBody(7000)),
    refunds.request(owner, key(), "payment", payment.id, requestBody(7000)),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(results.filter((x) => x.status === "rejected").length, 1);
  assert.equal(creates, 0);
  const row = (await refunds.list(owner, { payment_id: payment.id }))
    .requests[0];
  await assert.rejects(
    controls.creditInvoice(owner, key(), payment.invoice_id, {
      amount_cents: 1000,
      reason: "Cannot move reserved funds into credit",
    }),
    /Resolve pending provider refunds/,
  );
  await assert.rejects(
    pool.query("UPDATE stripe_refund_requests SET amount_cents=1 WHERE id=$1", [
      row.id,
    ]),
    /Immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM stripe_refund_requests WHERE id=$1", [row.id]),
    /cannot be deleted/,
  );
  await refunds.cancel(owner, key(), row.id);
  const command = key(),
    body = requestBody(10000);
  const next: any = await refunds.request(
    owner,
    command,
    "payment",
    payment.id,
    body,
  );
  assert.equal(
    (
      (await refunds.request(
        owner,
        command,
        "payment",
        payment.id,
        body,
      )) as any
    ).id,
    next.id,
  );
  await assert.rejects(
    refunds.request(owner, command, "payment", payment.id, {
      ...body,
      amount_cents: 9000,
    }),
    /different request/,
  );
});

test("concurrent submission sends once and confirmed Stripe refund posts cash return once without reversing revenue", async () => {
  const { invoice, payment } = await paidInvoice();
  const request: any = await refunds.request(
    owner,
    key(),
    "payment",
    payment.id,
    requestBody(),
  );
  await Promise.all([
    refunds.submit(owner, request.id),
    refunds.submit(owner, request.id),
  ]);
  assert.equal(creates, 1);
  const final = (await refunds.list(owner, { payment_id: payment.id }))
    .requests[0];
  assert.equal(final.state, "succeeded");
  assert.ok(final.local_refund_id);
  await refunds.submit(owner, request.id);
  await refunds.reconcile(owner, request.id, {
    provider_refund_id: final.provider_refund_id,
  });
  assert.equal(creates, 1);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    1,
  );
  const balance = (
    await pool.query(
      "SELECT status,balance_cents FROM invoice_balances WHERE id=$1",
      [invoice.id],
    )
  ).rows[0];
  assert.equal(balance.status, "open");
  assert.equal(Number(balance.balance_cents), 3000);
  const journal = (
    await pool.query(
      "SELECT debit_account,credit_account,amount_cents FROM journal WHERE source_kind='refund'",
    )
  ).rows;
  assert.deepEqual(journal, [
    {
      debit_account: "accounts_receivable",
      credit_account: "cash",
      amount_cents: 3000,
    },
  ]);
  await assert.rejects(
    refunds.cancel(owner, key(), request.id),
    /never submitted/,
  );
});

test("lost provider response remains reserved and recovers only from exact receipt without another POST", async () => {
  const { payment } = await paidInvoice();
  providerState = "lost";
  const request: any = await refunds.request(
    owner,
    key(),
    "payment",
    payment.id,
    requestBody(6000),
  );
  const uncertain = await refunds.submit(owner, request.id);
  assert.equal(uncertain.state, "review");
  assert.doesNotMatch(uncertain.last_error, /sk_test/);
  await refunds.submit(owner, request.id);
  assert.equal(creates, 1);
  await assert.rejects(
    refunds.request(owner, key(), "payment", payment.id, requestBody(5000)),
    /unreserved/,
  );
  const actual = [...receipts.values()][0],
    wrong = { ...actual, id: "re_wrong", amount: 5999 };
  receipts.set(wrong.id, wrong);
  await assert.rejects(
    refunds.reconcile(owner, request.id, { provider_refund_id: wrong.id }),
    /exactly match/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    0,
  );
  const reconciled = await refunds.reconcile(owner, request.id, {
    provider_refund_id: actual.id,
  });
  assert.equal(reconciled.state, "succeeded");
  assert.equal(creates, 1);
  assert.equal(retrieves, 2);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    1,
  );
});

test("pending Stripe receipts settle through signed webhooks exactly once and stale failure cannot downgrade success", async () => {
  const { payment } = await paidInvoice();
  providerState = "pending";
  const request: any = await refunds.request(
    owner,
    key(),
    "payment",
    payment.id,
    requestBody(),
  );
  const pending = await refunds.submit(owner, request.id);
  assert.equal(pending.state, "pending");
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    0,
  );
  const receipt = {
    ...receipts.get(pending.provider_refund_id),
    status: "succeeded",
  };
  const event = {
    id: "evt_" + key(),
    type: "refund.updated",
    livemode: false,
    data: { object: receipt },
  };
  await assert.rejects(
    payments.webhook(Buffer.from(JSON.stringify(event)), "not-a-signature"),
    /signature/,
  );
  await signedRefund(event);
  await signedRefund(event);
  await signedRefund({
    ...event,
    id: "evt_" + key(),
    type: "refund.failed",
    data: { object: { ...receipt, status: "failed" } },
  });
  assert.equal((await refunds.list(owner)).requests[0].state, "succeeded");
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM stripe_refund_observations",
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM notifications WHERE source_key=$1",
        ["stripe-refund:" + request.id],
      )
    ).rows[0].n,
    1,
  );
});

test("provider failure releases reservation while disabling provider configuration prevents financial requests", async () => {
  const { payment } = await paidInvoice();
  providerState = "failed";
  const request: any = await refunds.request(
    owner,
    key(),
    "payment",
    payment.id,
    requestBody(10000),
  );
  assert.equal((await refunds.submit(owner, request.id)).state, "failed");
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    0,
  );
  await refunds.request(
    owner,
    key(),
    "payment",
    payment.id,
    requestBody(10000),
  );
  enabled = false;
  await assert.rejects(
    refunds.request(owner, key(), "payment", payment.id, requestBody()),
    /not configured/,
  );
  for (const role of ["dispatcher", "office", "driver", "customer"]) {
    await assert.rejects(refunds.list({ ...owner, role }), /Forbidden/);
    await assert.rejects(
      refunds.request(
        { ...owner, role },
        key(),
        "payment",
        payment.id,
        requestBody(),
      ),
      /Forbidden/,
    );
    await assert.rejects(
      refunds.submit({ ...owner, role }, request.id),
      /Forbidden/,
    );
  }
});

test("Stripe refund of invoice-funded credit reserves its liability and does not reopen or double-refund its invoice", async () => {
  const { invoice, payment } = await paidInvoice();
  const credited: any = await controls.creditInvoice(owner, key(), invoice.id, {
    amount_cents: 3000,
    reason: "Cancellation of part of paid service",
  });
  await assert.rejects(
    refunds.request(owner, key(), "payment", payment.id, requestBody()),
    /funded account credit/,
  );
  await assert.rejects(
    refunds.request(
      owner,
      key(),
      "credit",
      credited.credit_id,
      requestBody(2000),
    ),
    /same invoice/,
  );
  const request: any = await refunds.request(
    owner,
    key(),
    "credit",
    credited.credit_id,
    { ...requestBody(2000), payment_id: payment.id },
  );
  await assert.rejects(
    controls.refundCredit(owner, key(), credited.credit_id, {
      amount_cents: 1001,
      method: "check",
      reference: key(),
      reason: "Cannot spend reserved funds",
    }),
    /unreserved/,
  );
  const other = await makeInvoice();
  await assert.rejects(
    new Finance(ops).applyCredit(owner, key(), credited.credit_id, {
      invoice_id: other.id,
      amount_cents: 1001,
    }),
    /unreserved/,
  );
  await new Finance(ops).applyCredit(owner, key(), credited.credit_id, {
    invoice_id: other.id,
    amount_cents: 1000,
  });
  const result = await refunds.submit(owner, request.id);
  assert.equal(result.state, "succeeded");
  assert.ok(result.local_credit_refund_id);
  assert.equal(result.local_refund_id, null);
  assert.equal(
    (
      await pool.query(
        "SELECT remaining_cents FROM customer_credits WHERE id=$1",
        [credited.credit_id],
      )
    ).rows[0].remaining_cents,
    0,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT balance_cents FROM invoice_balances WHERE id=$1",
          [invoice.id],
        )
      ).rows[0].balance_cents,
    ),
    0,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    0,
  );
  const creditRefund = (
    await pool.query("SELECT method,amount_cents FROM customer_credit_refunds")
  ).rows[0];
  assert.deepEqual(creditRefund, { method: "stripe", amount_cents: 2000 });
  const detail = await new Finance(ops).detail(owner, invoice.id);
  assert.equal(detail.payments[0].refunded_cents, 2000);
});

test("captured Stripe account credit can be refunded to its original intent without inventing an invoice payment", async () => {
  const { invoice } = await paidInvoice(),
    pi = await capture(invoice);
  const credit = (
    await pool.query(
      "SELECT * FROM customer_credits WHERE source_reference=$1",
      [pi],
    )
  ).rows[0];
  assert.ok(credit);
  const request: any = await refunds.request(
    owner,
    key(),
    "credit",
    credit.id,
    requestBody(4000),
  );
  assert.equal(request.payment_id, null);
  assert.equal(request.invoice_id, null);
  await refunds.submit(owner, request.id);
  assert.equal(
    (
      await pool.query(
        "SELECT remaining_cents FROM customer_credits WHERE id=$1",
        [credit.id],
      )
    ).rows[0].remaining_cents,
    6000,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM payments")).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("SELECT method FROM customer_credit_refunds")).rows[0]
      .method,
    "stripe",
  );
});

test("external Stripe refunds are retained for review and explicitly reconciled by GET without sending another refund", async () => {
  const { payment, pi } = await paidInvoice();
  const external = {
    id: "re_external_" + key().replaceAll("-", ""),
    payment_intent: pi,
    currency: "usd",
    amount: 2000,
    status: "succeeded",
    livemode: false,
    metadata: {},
  };
  receipts.set(external.id, external);
  await signedRefund({
    id: "evt_" + key(),
    type: "refund.updated",
    livemode: false,
    data: { object: external },
  });
  assert.equal((await refunds.list(owner)).unmatched.length, 1);
  await assert.rejects(
    refunds.request(owner, key(), "payment", payment.id, requestBody()),
    /unmatched provider refund/,
  );
  const body = {
    ...requestBody(2000),
    provider_refund_id: external.id,
    confirm: "RECONCILE " + external.id,
  };
  await assert.rejects(
    refunds.adoptExternal(owner, key(), "payment", payment.id, {
      ...body,
      confirm: "yes",
    }),
    /exact existing/,
  );
  const command = key();
  const result = await refunds.adoptExternal(
    owner,
    command,
    "payment",
    payment.id,
    body,
  );
  assert.equal(result.state, "succeeded");
  assert.equal(result.external_receipt, true);
  assert.equal(creates, 0);
  await refunds.adoptExternal(owner, command, "payment", payment.id, body);
  assert.equal((await refunds.list(owner)).unmatched.length, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    1,
  );
  await assert.rejects(
    pool.query(
      "UPDATE stripe_refund_requests SET external_receipt=false WHERE id=$1",
      [result.id],
    ),
    /Immutable/,
  );
  await refunds.request(owner, key(), "payment", payment.id, requestBody(7000));
  assert.equal(creates, 0);
});

test("refund receipt mode, reference, amount and funding account must match before any ledger mutation", async () => {
  const { payment, pi } = await paidInvoice();
  providerState = "pending";
  const request: any = await refunds.request(
    owner,
    key(),
    "payment",
    payment.id,
    requestBody(),
  );
  const pending = await refunds.submit(owner, request.id),
    receipt = receipts.get(pending.provider_refund_id);
  const event = (object: any, livemode = false) => ({
    id: "evt_" + key(),
    type: "refund.updated",
    livemode,
    data: { object },
  });
  await assert.rejects(
    signedRefund(event({ ...receipt, status: "succeeded" }, true)),
    /mode does not match/,
  );
  await assert.rejects(
    signedRefund(event({ ...receipt, status: "succeeded", livemode: true })),
    /exactly match/,
  );
  await assert.rejects(
    signedRefund(
      event({ ...receipt, status: "succeeded", payment_intent: "pi_other" }),
    ),
    /exactly match/,
  );
  await assert.rejects(
    signedRefund(
      event({ ...receipt, status: "succeeded", amount: receipt.amount + 1 }),
    ),
    /exactly match/,
  );
  await assert.rejects(
    signedRefund(event({ ...receipt, status: "succeeded", id: "re_other" })),
    /reference changed/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n,
    0,
  );
  assert.equal((await refunds.list(owner)).requests[0].state, "pending");
  const external = {
    id: "re_external_other",
    payment_intent: "pi_foreign",
    currency: "usd",
    amount: 3000,
    status: "succeeded",
    livemode: false,
    metadata: {},
  };
  receipts.set(external.id, external);
  await assert.rejects(
    refunds.adoptExternal(owner, key(), "payment", payment.id, {
      ...requestBody(),
      provider_refund_id: external.id,
      confirm: "RECONCILE " + external.id,
    }),
    /selected funds/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM stripe_refund_requests"))
      .rows[0].n,
    1,
  );
});
