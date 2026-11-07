import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
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
  finance: Finance,
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
  finance = new Finance(ops);
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
async function bill(extra: any = {}) {
  return (await finance.expense(owner, key(), {
    category: "repair",
    vendor: "Test repair shop",
    reference: key(),
    amount_cents: 10000,
    expense_date: "2026-11-01",
    payment_mode: "payable",
    due_date: "2026-11-05",
    ...extra,
  })) as any;
}
function payment(amount_cents: number, extra: any = {}) {
  return {
    amount_cents,
    reference: key(),
    method: "check",
    payment_date: "2026-11-06",
    ...extra,
  };
}
test("unpaid bill accrues expense once; partial payments settle liability without duplicating expense", async () => {
  const e = await bill(),
    payKey = key(),
    body = payment(3000);
  const first: any = await finance.expensePayment(owner, payKey, e.id, body);
  assert.equal(first.balance_cents, 7000);
  assert.deepEqual(
    await finance.expensePayment(owner, payKey, e.id, body),
    JSON.parse(JSON.stringify(first)),
  );
  await finance.expensePayment(
    owner,
    key(),
    e.id,
    payment(7000, { method: "bank_transfer" }),
  );
  const history = await finance.expenseHistory(owner, e.id);
  assert.equal(Number(history.balance_cents), 0);
  assert.equal(Number(history.paid_cents), 10000);
  assert.equal(history.payments.length, 2);
  const entries = (
    await pool.query(
      "SELECT debit_account,credit_account,amount_cents,posting_date FROM journal ORDER BY posting_date,amount_cents",
    )
  ).rows;
  assert.deepEqual(
    entries.map((r) => [
      r.debit_account,
      r.credit_account,
      r.amount_cents,
      r.posting_date,
    ]),
    [
      ["expense:repair", "accounts_payable", 10000, "2026-11-01"],
      ["accounts_payable", "cash", 3000, "2026-11-06"],
      ["accounts_payable", "cash", 7000, "2026-11-06"],
    ],
  );
  await assert.rejects(
    pool.query(
      "UPDATE expense_payments SET amount_cents=1 WHERE expense_id=$1",
      [e.id],
    ),
    /immutable|append|forbidden/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM expenses WHERE id=$1", [e.id]),
    /immutable|append|forbidden/i,
  );
});
test("concurrent settlements serialize and cannot overpay or reuse references on another bill", async () => {
  const e = await bill();
  const results = await Promise.allSettled([
    finance.expensePayment(owner, key(), e.id, payment(7000)),
    finance.expensePayment(owner, key(), e.id, payment(7000)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const h = await finance.expenseHistory(owner, e.id);
  assert.equal(Number(h.balance_cents), 3000);
  const other = await bill();
  await assert.rejects(
    finance.expensePayment(
      owner,
      key(),
      other.id,
      payment(1000, { reference: h.payments[0].reference }),
    ),
    /reference/,
  );
  assert.equal(
    (await finance.expenseHistory(owner, other.id)).payments.length,
    0,
  );
});
test("due dates, payment dates, roles, paid receipts and command payloads are checked", async () => {
  await assert.rejects(bill({ due_date: undefined }), /due date/);
  await assert.rejects(bill({ due_date: "2026-10-01" }), /due date/);
  await assert.rejects(
    bill({ expense_date: "2099-01-01", due_date: "2099-01-02" }),
    /future/,
  );
  const e = await bill();
  await assert.rejects(
    finance.expensePayment(
      owner,
      key(),
      e.id,
      payment(1, { payment_date: "2026-10-31" }),
    ),
    /Payment date/,
  );
  await assert.rejects(
    finance.expensePayment(
      owner,
      key(),
      e.id,
      payment(1, { payment_date: "2099-01-01" }),
    ),
    /Payment date/,
  );
  for (const role of ["dispatcher", "office", "driver", "customer"]) {
    const actor = { ...owner, role };
    await assert.rejects(finance.expenseHistory(actor, e.id), /Forbidden/);
    await assert.rejects(
      finance.expensePayment(actor, key(), e.id, payment(1)),
      /Forbidden/,
    );
  }
  const paid = await bill({ payment_mode: "paid", due_date: undefined });
  assert.equal(
    Number((await finance.expenseHistory(owner, paid.id)).balance_cents),
    0,
  );
  await assert.rejects(
    finance.expensePayment(owner, key(), paid.id, payment(1)),
    /already/,
  );
  const k = key(),
    b = payment(1000);
  await finance.expensePayment(owner, k, e.id, b);
  await assert.rejects(
    finance.expensePayment(owner, k, e.id, { ...b, amount_cents: 2000 }),
    /different request/,
  );
});
test("payable report reconstructs earlier balances and trial balance uses posting dates", async () => {
  const e = await bill({ expense_date: "2026-10-31", due_date: "2026-11-01" });
  await finance.expensePayment(
    owner,
    key(),
    e.id,
    payment(6000, { payment_date: "2026-11-04" }),
  );
  await finance.expensePayment(
    owner,
    key(),
    e.id,
    payment(4000, { payment_date: "2026-11-06" }),
  );
  const asOf = await reports.run(owner, "accounts_payable", {
    from: "2026-11-01",
    to: "2026-11-05",
  });
  assert.equal(asOf.rows.length, 1);
  assert.equal(Number(asOf.rows[0].balance_cents), 4000);
  assert.equal(asOf.rows[0].overdue_days, 4);
  assert.equal(
    (
      await reports.run(owner, "accounts_payable", {
        from: "2026-11-01",
        to: "2026-11-06",
      })
    ).rows.length,
    0,
  );
  const trial = await reports.run(owner, "trial_balance", {
    from: "2026-10-31",
    to: "2026-10-31",
  });
  assert.equal(
    Number(trial.rows.find((r) => r.account === "expense:repair")?.debit_cents),
    10000,
  );
  assert.equal(
    Number(
      trial.rows.find((r) => r.account === "accounts_payable")?.credit_cents,
    ),
    10000,
  );
  assert.equal(
    trial.rows.some((r) => r.account === "cash"),
    false,
  );
});

test("historical receivables use posted balances and as-of aging even after a later payment and refund", async () => {
  const order: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "bulk",
    scheduled_date: "2026-11-01",
    price_cents: 10000,
  });
  // Historical accounting fixture; production invoices are still issued through verified service workflows.
  const invoice = (
    await pool.query(
      "INSERT INTO invoices(customer_id,order_id,amount_cents,due_date,created_at) VALUES($1,$2,10000,'2026-11-03','2026-11-01T12:00:00Z') RETURNING *",
      [customerId, order.id],
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,posting_date) VALUES($1,'accounts_receivable','service_revenue',10000,'2026-11-01')",
    [invoice.id],
  );
  const receipt: any = await finance.payment(owner, key(), invoice.id, {
    amount_cents: 10000,
    method: "check",
    reference: key(),
  });
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [invoice.id]))
      .rows[0].status,
    "paid",
  );
  const historical = await reports.run(owner, "accounts_receivable", {
    from: "2026-11-04",
    to: "2026-11-05",
  });
  assert.equal(historical.rows.length, 1);
  assert.equal(Number(historical.rows[0].balance_cents), 10000);
  assert.equal(historical.rows[0].overdue_days, 2);
  assert.equal(historical.rows[0].age, "overdue");
  assert.equal(
    (
      await reports.run(owner, "accounts_receivable", {
        from: "2026-11-01",
        to: "2026-11-02",
      })
    ).rows[0].age,
    "current",
  );
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings",
    )
  ).rows[0].today;
  assert.equal(
    (
      await reports.run(owner, "accounts_receivable", {
        from: today,
        to: today,
      })
    ).rows.length,
    0,
  );
  await finance.refund(owner, key(), receipt.id, {
    amount_cents: 2000,
    reason: "Returned check portion",
    reference: key(),
  });
  assert.equal(
    Number(
      (
        await reports.run(owner, "accounts_receivable", {
          from: today,
          to: today,
        })
      ).rows[0].balance_cents,
    ),
    2000,
  );
  assert.equal(
    Number(
      (
        await reports.run(owner, "accounts_receivable", {
          from: "2026-11-05",
          to: "2026-11-05",
        })
      ).rows[0].balance_cents,
    ),
    10000,
  );
});

test("vendor credits reduce the outstanding bill and expense once without erasing the original bill", async () => {
  const { PayableAdjustments } = await import("../src/payable-adjustments");
  const adjustments = new PayableAdjustments(ops),
    e = await bill();
  await finance.expensePayment(
    owner,
    key(),
    e.id,
    payment(3000, { payment_date: "2026-11-03" }),
  );
  const command = key(),
    body = {
      amount_cents: 2000,
      credit_date: "2026-11-04",
      reference: key(),
      reason: "Supplier corrected the repair charge",
    };
  const credit: any = await adjustments.credit(owner, command, e.id, body);
  assert.equal(credit.balance_cents, 5000);
  assert.equal(
    ((await adjustments.credit(owner, command, e.id, body)) as any).id,
    credit.id,
  );
  const history = await finance.expenseHistory(owner, e.id);
  assert.equal(history.amount_cents, 10000);
  assert.equal(Number(history.net_amount_cents), 8000);
  assert.equal(Number(history.credited_cents), 2000);
  assert.equal(history.credits.length, 1);
  const posting = (
    await pool.query("SELECT * FROM journal WHERE source_kind='expense_credit'")
  ).rows[0];
  assert.equal(posting.debit_account, "accounts_payable");
  assert.equal(posting.credit_account, "expense:repair");
  assert.equal(posting.amount_cents, 2000);
  assert.equal(posting.posting_date, "2026-11-04");
  const earlier = await reports.run(owner, "accounts_payable", {
    from: "2026-11-01",
    to: "2026-11-03",
  });
  assert.equal(Number(earlier.rows[0].balance_cents), 7000);
  const after = await reports.run(owner, "accounts_payable", {
    from: "2026-11-01",
    to: "2026-11-04",
  });
  assert.equal(Number(after.rows[0].balance_cents), 5000);
  assert.equal(Number(after.rows[0].credited_cents), 2000);
  const income = await reports.run(owner, "profitability", {
    from: "2026-11-01",
    to: "2026-11-04",
  });
  assert.equal(Number(income.rows[0].expense_cents), 8000);
  const expenses = await reports.run(owner, "expenses", {
    from: "2026-11-01",
    to: "2026-11-04",
  });
  assert.equal(
    expenses.rows.reduce((n, r) => n + Number(r.amount_cents), 0),
    8000,
  );
  await assert.rejects(
    pool.query("UPDATE expense_credits SET amount_cents=1"),
    /Append-only/,
  );
  await assert.rejects(
    adjustments.credit(owner, key(), e.id, {
      ...body,
      reference: key(),
      amount_cents: 5001,
    }),
    /exceeds/,
  );
});

test("returned bill payments reopen liability on the reversal date and block historical overpayments", async () => {
  const { PayableAdjustments } = await import("../src/payable-adjustments");
  const adjustments = new PayableAdjustments(ops),
    e = await bill();
  const receipt: any = await finance.expensePayment(
    owner,
    key(),
    e.id,
    payment(6000, { payment_date: "2026-11-03" }),
  );
  const command = key(),
    body = {
      reversal_date: "2026-11-06",
      reference: key(),
      reason: "Bank returned the check; funds restored",
    };
  const reversed: any = await adjustments.reversePayment(
    owner,
    command,
    e.id,
    receipt.id,
    body,
  );
  assert.equal(reversed.balance_cents, 10000);
  assert.equal(
    (
      (await adjustments.reversePayment(
        owner,
        command,
        e.id,
        receipt.id,
        body,
      )) as any
    ).id,
    reversed.id,
  );
  await assert.rejects(
    adjustments.reversePayment(owner, key(), e.id, receipt.id, {
      ...body,
      reference: key(),
    }),
    /already recorded/,
  );
  const history = await finance.expenseHistory(owner, e.id);
  assert.equal(history.payments.length, 1);
  assert.equal(history.payments[0].reversal_id, reversed.id);
  assert.equal(Number(history.paid_cents), 0);
  const earlier = await reports.run(owner, "accounts_payable", {
    from: "2026-11-01",
    to: "2026-11-05",
  });
  assert.equal(Number(earlier.rows[0].balance_cents), 4000);
  const later = await reports.run(owner, "accounts_payable", {
    from: "2026-11-01",
    to: "2026-11-06",
  });
  assert.equal(Number(later.rows[0].balance_cents), 10000);
  await assert.rejects(
    finance.expensePayment(
      owner,
      key(),
      e.id,
      payment(8000, { payment_date: "2026-11-05" }),
    ),
    /historical date/,
  );
  assert.equal((await finance.expenseHistory(owner, e.id)).payments.length, 1);
  await assert.rejects(
    adjustments.credit(owner, key(), e.id, {
      amount_cents: 8000,
      credit_date: "2026-11-05",
      reference: key(),
      reason: "Backdated supplier correction",
    }),
    /historical date/,
  );
  assert.equal((await finance.expenseHistory(owner, e.id)).credits.length, 0);
  await finance.expensePayment(
    owner,
    key(),
    e.id,
    payment(8000, { payment_date: "2026-11-06" }),
  );
  assert.equal(
    Number((await finance.expenseHistory(owner, e.id)).balance_cents),
    2000,
  );
  const posting = (
    await pool.query(
      "SELECT debit_account,credit_account,amount_cents,posting_date FROM journal WHERE source_kind='expense_payment_reversal'",
    )
  ).rows[0];
  assert.deepEqual(posting, {
    debit_account: "cash",
    credit_account: "accounts_payable",
    amount_cents: 6000,
    posting_date: "2026-11-06",
  });
  await assert.rejects(
    pool.query("DELETE FROM expense_payment_reversals"),
    /Append-only/,
  );
});

test("concurrent bill credits and settlements cannot consume the same outstanding balance", async () => {
  const { PayableAdjustments } = await import("../src/payable-adjustments");
  const adjustments = new PayableAdjustments(ops),
    e = await bill();
  const results = await Promise.allSettled([
    adjustments.credit(owner, key(), e.id, {
      amount_cents: 7000,
      credit_date: "2026-11-06",
      reference: key(),
      reason: "Supplier reduction",
    }),
    finance.expensePayment(owner, key(), e.id, payment(7000)),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(results.filter((x) => x.status === "rejected").length, 1);
  assert.equal(
    Number((await finance.expenseHistory(owner, e.id)).balance_cents),
    3000,
  );
});

test("bill corrections validate finance roles, references, dates, original bill and command payload", async () => {
  const { PayableAdjustments } = await import("../src/payable-adjustments");
  const adjustments = new PayableAdjustments(ops),
    e = await bill(),
    other = await bill();
  const body = {
    amount_cents: 1000,
    credit_date: "2026-11-04",
    reference: key(),
    reason: "Supplier correction",
  };
  for (const role of ["dispatcher", "office", "driver", "customer"]) {
    await assert.rejects(
      adjustments.credit({ ...owner, role }, key(), e.id, body),
      /Forbidden/,
    );
    await assert.rejects(
      adjustments.reversePayment({ ...owner, role }, key(), e.id, key(), {
        reversal_date: "2026-11-06",
        reference: key(),
        reason: "Returned",
      }),
      /Forbidden/,
    );
  }
  await assert.rejects(
    adjustments.credit(owner, key(), e.id, {
      ...body,
      credit_date: "2026-10-31",
    }),
    /Credit date/,
  );
  await assert.rejects(
    adjustments.credit(owner, key(), e.id, {
      ...body,
      credit_date: "2099-01-01",
    }),
    /Credit date/,
  );
  const command = key();
  await adjustments.credit(owner, command, e.id, body);
  await assert.rejects(
    adjustments.credit(owner, command, e.id, { ...body, amount_cents: 2000 }),
    /different request/,
  );
  await assert.rejects(
    adjustments.credit(owner, key(), other.id, body),
    /reference already/,
  );
  const paid = await bill({ payment_mode: "paid", due_date: undefined });
  await assert.rejects(
    adjustments.credit(owner, key(), paid.id, { ...body, reference: key() }),
    /paid receipt/,
  );
  const receipt: any = await finance.expensePayment(
    owner,
    key(),
    e.id,
    payment(1000),
  );
  const reversal = {
    reversal_date: "2026-11-06",
    reference: key(),
    reason: "Returned check",
  };
  await assert.rejects(
    adjustments.reversePayment(owner, key(), other.id, receipt.id, reversal),
    /payment not found/,
  );
  await assert.rejects(
    adjustments.reversePayment(owner, key(), e.id, receipt.id, {
      ...reversal,
      reversal_date: "2026-11-05",
    }),
    /Reversal date/,
  );
  await assert.rejects(
    adjustments.reversePayment(owner, key(), e.id, receipt.id, {
      ...reversal,
      reversal_date: "2099-01-01",
    }),
    /Reversal date/,
  );
});

test("customer balance report reconstructs historical receivables and unused credits after applications and refunds", async () => {
  const { BillingControls } = await import("../src/billing-controls");
  const controls = new BillingControls(ops);
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0].today;
  const makeInvoice = async (amount: number, date: string) => {
    const order: any = await ops.createOrder(owner, key(), {
      customer_id: customerId,
      location_id: locationId,
      kind: "bulk",
      scheduled_date: date,
      price_cents: amount,
    });
    const invoice = (
      await pool.query(
        "INSERT INTO invoices(customer_id,order_id,amount_cents,due_date) VALUES($1,$2,$3,$4) RETURNING *",
        [customerId, order.id, amount, date],
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,posting_date) VALUES($1,'accounts_receivable','service_revenue',$2,$3)",
      [invoice.id, amount, date],
    );
    return invoice;
  };
  const historical = await makeInvoice(10000, "2026-11-01");
  await finance.payment(owner, key(), historical.id, {
    amount_cents: 10000,
    method: "cash",
    reference: key(),
  });
  const credit: any = await controls.creditInvoice(
    owner,
    key(),
    historical.id,
    { amount_cents: 3000, reason: "Paid service adjustment" },
  );
  const current = await makeInvoice(5000, today);
  await finance.applyCredit(owner, key(), credit.credit_id, {
    invoice_id: current.id,
    amount_cents: 1000,
  });
  await controls.refundCredit(owner, key(), credit.credit_id, {
    amount_cents: 500,
    method: "check",
    reference: key(),
    reason: "Customer requested return of unused credit",
  });
  const before = await reports.run(owner, "customer_balances", {
    from: "2026-11-05",
    to: "2026-11-05",
  });
  assert.equal(before.rows.length, 1);
  assert.equal(Number(before.rows[0].balance_cents), 10000);
  assert.equal(Number(before.rows[0].credit_cents), 0);
  const now = await reports.run(owner, "customer_balances", {
    from: today,
    to: today,
  });
  assert.equal(Number(now.rows[0].balance_cents), 4000);
  assert.equal(Number(now.rows[0].credit_cents), 1500);
  assert.equal(Number((await finance.credits(owner))[0].remaining_cents), 1500);
  const ledger = (
    await pool.query(
      "SELECT COALESCE(sum(CASE WHEN credit_account='customer_credit' THEN amount_cents ELSE 0 END-CASE WHEN debit_account='customer_credit' THEN amount_cents ELSE 0 END),0)::bigint AS amount FROM journal",
    )
  ).rows[0];
  assert.equal(Number(ledger.amount), Number(now.rows[0].credit_cents));
});

test("service and route contribution use recognized revenue and explicit net expenses while retaining all unallocated overhead", async () => {
  const { PayableAdjustments } = await import("../src/payable-adjustments");
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
    )
  ).rows[0].today;
  const order: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "bulk",
    scheduled_date: today,
    price_cents: 10000,
  });
  const route: any = await wf.route(owner, key(), {
    name: "Contribution route",
    service_date: today,
    driver_id: driver.id,
    truck_id: truckId,
    order_ids: [order.id],
  });
  const started: any = await ops.transition(driver, key(), order.id, {
    status: "in_progress",
    version: 2,
  });
  await ops.transition(driver, key(), order.id, {
    status: "completed",
    version: started.version,
    service_date: today,
  });
  const invoice: any = await ops.invoice(owner, key(), order.id);
  const cost: any = await finance.expense(owner, key(), {
    category: "fuel",
    vendor: "Direct fuel",
    reference: key(),
    amount_cents: 3000,
    expense_date: today,
    payment_mode: "payable",
    due_date: today,
    order_id: order.id,
    truck_id: truckId,
  });
  assert.equal(
    (await finance.expenseHistory(owner, cost.id)).order_id,
    order.id,
  );
  await new PayableAdjustments(ops).credit(owner, key(), cost.id, {
    amount_cents: 1000,
    credit_date: today,
    reference: key(),
    reason: "Fuel supplier adjustment",
  });
  await finance.expense(owner, key(), {
    category: "office",
    vendor: "Overhead",
    reference: key(),
    amount_cents: 500,
    expense_date: today,
  });
  await finance.expense(owner, key(), {
    category: "repair",
    vendor: "Route-only direct cost",
    reference: key(),
    amount_cents: 700,
    expense_date: today,
    route_id: route.id,
  });
  const service = await reports.run(owner, "service_profitability", {
    from: today,
    to: today,
  });
  const bulk = service.rows.find((r) => r.service === "bulk");
  assert.equal(Number(bulk?.revenue_cents), 10000);
  assert.equal(Number(bulk?.expense_cents), 2000);
  assert.equal(
    Number(
      service.rows.find((r) => r.service === "unallocated")?.expense_cents,
    ),
    1200,
  );
  const byRoute = await reports.run(owner, "route_profitability", {
    from: today,
    to: today,
  });
  const row = byRoute.rows.find((r) => r.route === "Contribution route");
  assert.equal(Number(row?.revenue_cents), 10000);
  assert.equal(Number(row?.expense_cents), 2700);
  assert.equal(
    Number(
      byRoute.rows.find((r) => r.route === "Unallocated / mixed routes")
        ?.expense_cents,
    ),
    500,
  );
  const total = await reports.run(owner, "profitability", {
    from: today,
    to: today,
  });
  for (const split of [service, byRoute]) {
    assert.equal(
      split.rows.reduce((n, r) => n + Number(r.revenue_cents), 0),
      Number(total.rows[0].revenue_cents),
    );
    assert.equal(
      split.rows.reduce((n, r) => n + Number(r.expense_cents), 0),
      Number(total.rows[0].expense_cents),
    );
    assert.equal(
      split.rows.reduce((n, r) => n + Number(r.contribution_cents), 0),
      6800,
    );
  }
  const { BillingControls } = await import("../src/billing-controls");
  await new BillingControls(ops).creditInvoice(owner, key(), invoice.id, {
    amount_cents: 2000,
    reason: "Customer service adjustment",
  });
  const after = await reports.run(owner, "service_profitability", {
    from: today,
    to: today,
  });
  assert.equal(
    Number(after.rows.find((r) => r.service === "bulk")?.revenue_cents),
    8000,
  );
});

test("expense attribution rejects missing, conflicting and wrong-truck targets without posting partial costs", async () => {
  const order: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "bulk",
    scheduled_date: "2026-11-06",
    price_cents: 1000,
  });
  const route: any = await wf.route(owner, key(), {
    name: "Attribution guard route",
    service_date: "2026-11-06",
    driver_id: driver.id,
    truck_id: truckId,
    order_ids: [order.id],
  });
  const other = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "OTHER-" + key(),
    ])
  ).rows[0];
  const body = {
    category: "fuel",
    vendor: "Attribution guard",
    reference: key(),
    amount_cents: 1000,
    expense_date: "2026-11-06",
  };
  await assert.rejects(
    finance.expense(owner, key(), {
      ...body,
      order_id: order.id,
      route_id: route.id,
    }),
    /one service order/,
  );
  await assert.rejects(
    finance.expense(owner, key(), { ...body, order_id: key() }),
    /existing non-cancelled/,
  );
  await assert.rejects(
    finance.expense(owner, key(), { ...body, route_id: key() }),
    /existing active route/,
  );
  await assert.rejects(
    finance.expense(owner, key(), {
      ...body,
      order_id: order.id,
      truck_id: other.id,
    }),
    /truck does not match/,
  );
  await assert.rejects(
    finance.expense(owner, key(), {
      ...body,
      route_id: route.id,
      truck_id: other.id,
    }),
    /truck does not match/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM expenses")).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM journal")).rows[0].n,
    0,
  );
});
