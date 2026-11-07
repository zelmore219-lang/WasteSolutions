import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Actor, Operations } from "../src/domain";
import { Imports } from "../src/imports";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  imports = new Imports(ops);
const key = () => randomUUID();
let owner: Actor, customerId: string, locationId: string;
before(async () => {
  owner = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Import owner','owner') RETURNING *",
      [key(), "import_" + key().slice(0, 8)],
    )
  ).rows[0];
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Import fixture",
    kind: "commercial",
    email: "import-fixture-" + key() + "@example.test",
    billing_address: "Import Street",
  });
  customerId = c.id;
  locationId = (
    (await ops.createLocation(owner, key(), c.id, {
      address: "Import Service Road",
    })) as any
  ).id;
});
after(async () => {
  await pool.end();
});
test("CSV preview detects duplicates and invalid rows without changing company customer records", async () => {
  const email = "duplicate-" + key() + "@example.test",
    external = key();
  const batch: any = await imports.preview(owner, key(), {
    kind: "customers",
    csv: `external_id,name,kind,email,billing_address\n${external},First,residential,${email},Street\n${external},Second,residential,${email},Street\n${key()},Broken,commercial,invalid-email,Street\n`,
  });
  assert.equal(batch.invalid_rows, 2);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM customers WHERE email=$1",
        [email],
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(
    imports.apply(owner, key(), batch.id, { confirm: "APPLY " + batch.id }),
    /invalid preview/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM customers WHERE email=$1",
        [email],
      )
    ).rows[0].n,
    0,
  );
});
test("customer import is explicit, retry-safe and rollback archives only its new records", async () => {
  const email = "new-import-" + key() + "@example.test";
  const batch: any = await imports.preview(owner, key(), {
    kind: "customers",
    csv: `external_id,name,kind,email,billing_address\n${key()},"Quoted, Customer",residential,${email},"123 Long Street"\n`,
  });
  assert.equal(batch.invalid_rows, 0);
  await assert.rejects(
    imports.apply(owner, key(), batch.id, { confirm: "yes" }),
    /exact previewed/,
  );
  const command = key();
  const [a, b]: any[] = await Promise.all([
    imports.apply(owner, command, batch.id, { confirm: "APPLY " + batch.id }),
    imports.apply(owner, command, batch.id, { confirm: "APPLY " + batch.id }),
  ]);
  assert.equal(a.applied, 1);
  assert.deepEqual(a, b);
  const result: any = await imports.rollback(owner, key(), batch.id, {
    confirm: "ROLLBACK " + batch.id,
  });
  assert.equal(result.records_deleted, 0);
  assert.equal(
    (await pool.query("SELECT status FROM customers WHERE email=$1", [email]))
      .rows[0].status,
    "suspended",
  );
  const reimport: any = await imports.preview(owner, key(), {
    kind: "customers",
    csv: `external_id,name,kind,email,billing_address\n${key()},Existing,residential,${email},Street\n`,
  });
  assert.equal(reimport.invalid_rows, 1);
});
test("opening balances post to equity rather than revenue; rollback reverses the journal without deleting history", async () => {
  const batch: any = await imports.preview(owner, key(), {
    kind: "opening_balances",
    csv: `external_id,customer_id,amount_cents,balance_date,due_date,source_reference\n${key()},${customerId},12345,2026-01-01,2026-02-01,${key()}\n`,
  });
  await imports.apply(owner, key(), batch.id, { confirm: "APPLY " + batch.id });
  const invoice = (
    await pool.query(
      "SELECT i.* FROM invoices i JOIN migration_balances m ON m.id=i.migration_balance_id WHERE m.batch_id=$1",
      [batch.id],
    )
  ).rows[0];
  assert.equal(invoice.due_date, "2026-02-01");
  assert.equal(
    (
      await pool.query(
        "SELECT credit_account FROM journal WHERE invoice_id=$1",
        [invoice.id],
      )
    ).rows[0].credit_account,
    "opening_equity",
  );
  await imports.rollback(owner, key(), batch.id, {
    confirm: "ROLLBACK " + batch.id,
  });
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [invoice.id]))
      .rows[0].status,
    "void",
  );
  const entries = (
    await pool.query(
      "SELECT debit_account,credit_account FROM journal WHERE invoice_id=$1",
      [invoice.id],
    )
  ).rows;
  assert.equal(entries.length, 2);
});
test("route import rollback restores prior assignment only while imported work is unchanged", async () => {
  const driver = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Import driver','driver') RETURNING id",
      [key(), "imp_" + key().slice(0, 8)],
    )
  ).rows[0];
  const truck = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "IMP-" + key(),
    ])
  ).rows[0];
  const o: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "pickup",
    scheduled_date: "2026-11-11",
    price_cents: 10000,
  });
  const batch: any = await imports.preview(owner, key(), {
    kind: "routes",
    csv: `external_id,name,service_date,driver_id,truck_id,order_ids\n${key()},Imported Route,2026-11-11,${driver.id},${truck.id},${o.id}\n`,
  });
  assert.equal(batch.invalid_rows, 0);
  await imports.apply(owner, key(), batch.id, { confirm: "APPLY " + batch.id });
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0]
      .status,
    "assigned",
  );
  await imports.rollback(owner, key(), batch.id, {
    confirm: "ROLLBACK " + batch.id,
  });
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0]
      .status,
    "new",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM route_stops WHERE order_id=$1",
        [o.id],
      )
    ).rows[0].n,
    0,
  );
});

test("historical source transactions import for lookup without reposting ledger balances and rollback preserves every source row", async () => {
  const { Reports } = await import("../src/reports");
  const reports = new Reports(ops),
    source = "Source-" + key();
  const header =
    "external_id,source_system,source_reference,transaction_kind,transaction_date,amount_cents,currency,customer_id,vendor,related_reference,memo";
  const csv =
    header +
    "\n" +
    [
      [
        key(),
        source,
        "INV-1",
        "invoice",
        "2026-01-02",
        10000,
        "USD",
        customerId,
        "",
        "",
        "Original invoice",
      ],
      [
        key(),
        source,
        "PAY-1",
        "payment",
        "2026-01-03",
        6000,
        "USD",
        customerId,
        "",
        "INV-1",
        "Original partial payment",
      ],
      [
        key(),
        source,
        "EXP-1",
        "expense",
        "2026-01-04",
        500,
        "USD",
        "",
        "Legacy supplier",
        "",
        "Historical fuel receipt",
      ],
    ]
      .map((row) => row.join(","))
      .join("\n");
  const counts = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM journal)::int AS journal,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM payments)::int AS payments",
      )
    ).rows[0];
  const before = await counts();
  const batch: any = await imports.preview(owner, key(), {
    kind: "legacy_transactions",
    csv,
  });
  assert.equal(batch.invalid_rows, 0);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM legacy_transactions WHERE source_system=$1",
        [source],
      )
    ).rows[0].n,
    0,
  );
  const command = key();
  await imports.apply(owner, command, batch.id, {
    confirm: "APPLY " + batch.id,
  });
  await imports.apply(owner, command, batch.id, {
    confirm: "APPLY " + batch.id,
  });
  assert.deepEqual(await counts(), before);
  const report = await reports.run(owner, "legacy_transactions", {
    from: "2026-01-01",
    to: "2026-01-31",
  });
  const rows = report.rows.filter((r) => r.source_system === source);
  assert.equal(rows.length, 3);
  assert.equal(
    rows.find((r) => r.source_reference === "INV-1")?.amount_cents,
    10000,
  );
  assert.equal(
    rows.find((r) => r.source_reference === "EXP-1")?.vendor,
    "Legacy supplier",
  );
  assert.ok(
    rows.every(
      (r) =>
        r.accounting_treatment === "source archive only; no ledger posting",
    ),
  );
  await assert.rejects(
    pool.query(
      "UPDATE legacy_transactions SET amount_cents=1 WHERE source_system=$1",
      [source],
    ),
    /Append-only/,
  );
  const result: any = await imports.rollback(owner, key(), batch.id, {
    confirm: "ROLLBACK " + batch.id,
  });
  assert.equal(result.records_deleted, 0);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM legacy_transactions WHERE source_system=$1",
        [source],
      )
    ).rows[0].n,
    3,
  );
  assert.equal(
    (
      await reports.run(owner, "legacy_transactions", {
        from: "2026-01-01",
        to: "2026-01-31",
      })
    ).rows.filter((r) => r.source_system === source).length,
    0,
  );
  assert.deepEqual(await counts(), before);
  const again: any = await imports.preview(owner, key(), {
    kind: "legacy_transactions",
    csv:
      header +
      "\n" +
      [
        key(),
        source,
        "INV-1",
        "invoice",
        "2026-01-02",
        10000,
        "USD",
        customerId,
        "",
        "",
        "",
      ].join(","),
  });
  assert.equal(again.invalid_rows, 1);
});

test("historical import rejects duplicate source identities, unsupported currency, future dates, missing account and unauthorized roles", async () => {
  const source = "Invalid-" + key();
  const header =
    "external_id,source_system,source_reference,transaction_kind,transaction_date,amount_cents,currency,customer_id,vendor";
  const valid = (reference: string) => [
    key(),
    source,
    reference,
    "invoice",
    "2026-01-01",
    100,
    "USD",
    customerId,
    "",
  ];
  const a = valid("DUP"),
    b = valid("DUP"),
    currency = valid("CURRENCY"),
    future = valid("FUTURE"),
    missing = valid("MISSING");
  currency[6] = "EUR";
  future[4] = "2099-01-01";
  missing[7] = "";
  const batch: any = await imports.preview(owner, key(), {
    kind: "legacy_transactions",
    csv:
      header +
      "\n" +
      [a, b, currency, future, missing].map((x) => x.join(",")).join("\n"),
  });
  assert.equal(batch.invalid_rows, 4);
  await assert.rejects(
    imports.apply(owner, key(), batch.id, { confirm: "APPLY " + batch.id }),
    /invalid preview/,
  );
  for (const role of ["dispatcher", "office", "driver", "customer"])
    await assert.rejects(
      imports.preview({ ...owner, role }, key(), {
        kind: "legacy_transactions",
        csv: header + "\n" + a.join(","),
      }),
      /Forbidden/,
    );
  const reference = "Race-" + key();
  const one: any = await imports.preview(owner, key(), {
    kind: "legacy_transactions",
    csv: header + "\n" + valid(reference).join(","),
  });
  const two: any = await imports.preview(owner, key(), {
    kind: "legacy_transactions",
    csv: header + "\n" + valid(reference).join(","),
  });
  await imports.apply(owner, key(), one.id, { confirm: "APPLY " + one.id });
  await assert.rejects(
    imports.apply(owner, key(), two.id, { confirm: "APPLY " + two.id }),
    /Source transaction already/,
  );
  assert.equal((await imports.detail(owner, two.id)).status, "preview");
});

test("opening balances use their source accounting date and adjustments prevent rollback from corrupting receivables", async () => {
  const { Reports } = await import("../src/reports");
  const { BillingControls } = await import("../src/billing-controls");
  const source = "OPEN-" + key();
  const batch: any = await imports.preview(owner, key(), {
    kind: "opening_balances",
    csv:
      "external_id,customer_id,amount_cents,balance_date,due_date,source_reference\n" +
      [key(), customerId, 10000, "2026-01-01", "2026-02-01", source].join(","),
  });
  await imports.apply(owner, key(), batch.id, { confirm: "APPLY " + batch.id });
  const invoice = (
    await pool.query(
      "SELECT i.* FROM invoices i JOIN migration_balances m ON m.id=i.migration_balance_id WHERE m.source_reference=$1",
      [source],
    )
  ).rows[0];
  const entry = (
    await pool.query("SELECT posting_date FROM journal WHERE invoice_id=$1", [
      invoice.id,
    ])
  ).rows[0];
  assert.equal(entry.posting_date, "2026-01-01");
  const report = await new Reports(ops).run(owner, "accounts_receivable", {
    from: "2026-01-01",
    to: "2026-01-31",
  });
  assert.equal(
    Number(
      report.rows.find((r) => r.invoice === "CW-" + invoice.number)
        ?.balance_cents,
    ),
    10000,
  );
  await new BillingControls(ops).creditInvoice(owner, key(), invoice.id, {
    amount_cents: 2000,
    reason: "Reviewed adjustment after cutover",
  });
  await assert.rejects(
    imports.rollback(owner, key(), batch.id, {
      confirm: "ROLLBACK " + batch.id,
    }),
    /financial activity/,
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
    8000,
  );
  const future: any = await imports.preview(owner, key(), {
    kind: "opening_balances",
    csv:
      "external_id,customer_id,amount_cents,balance_date,due_date,source_reference\n" +
      [key(), customerId, 100, "2099-01-01", "2099-02-01", key()].join(","),
  });
  assert.equal(future.invalid_rows, 1);
});

test("imported equipment with real placement cannot be retired or detached by batch rollback", async () => {
  const { EquipmentStorage } = await import("../src/equipment-storage");
  const number = "IMPORT-CART-" + key();
  const batch: any = await imports.preview(owner, key(), {
    kind: "containers",
    csv:
      "external_id,number,kind,capacity_yards\n" +
      [key(), number, "cart", 1].join(","),
  });
  await imports.apply(owner, key(), batch.id, { confirm: "APPLY " + batch.id });
  const cart = (
    await pool.query("SELECT * FROM containers WHERE number=$1", [number])
  ).rows[0];
  await new EquipmentStorage(ops).place(owner, key(), cart.id, {
    version: 1,
    observed_number: number,
    reason: "Actual customer placement after import",
    customer_id: customerId,
    location_id: locationId,
  });
  await assert.rejects(
    imports.rollback(owner, key(), batch.id, {
      confirm: "ROLLBACK " + batch.id,
    }),
    /physical activity/,
  );
  const after = (
    await pool.query("SELECT status,location_id FROM containers WHERE id=$1", [
      cart.id,
    ])
  ).rows[0];
  assert.equal(after.status, "deployed");
  assert.equal(after.location_id, locationId);
});

test("CSV imports reject duplicate or empty headers rather than silently dropping a source column", async () => {
  await assert.rejects(
    imports.preview(owner, key(), {
      kind: "opening_balances",
      csv:
        "external_id,customer_id,amount_cents,amount_cents,balance_date,due_date,source_reference\n" +
        [key(), customerId, 100, 200, "2026-01-01", "2026-02-01", key()].join(
          ",",
        ),
    }),
    /CSV could not be parsed/,
  );
  await assert.rejects(
    imports.preview(owner, key(), {
      kind: "customers",
      csv:
        "external_id,name,,email,billing_address\n" +
        [
          key(),
          "Duplicate header",
          "residential",
          "header@example.test",
          "Street",
        ].join(","),
    }),
    /CSV could not be parsed/,
  );
});
