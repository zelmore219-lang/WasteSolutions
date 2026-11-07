import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import {
  QuickBooks,
  AccountingRequest,
  journalExportDocument,
} from "../src/quickbooks";
import {
  encryptIntegration,
  decryptIntegration,
} from "../src/integration-crypto";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
process.env.NODE_ENV = "test";
process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.QUICKBOOKS_CLIENT_ID = "test-client";
process.env.QUICKBOOKS_CLIENT_SECRET = "test-secret";
process.env.QUICKBOOKS_REDIRECT_URI =
  "http://localhost:3000/api/accounting/quickbooks/callback";
process.env.QUICKBOOKS_MODE = "sandbox";
let pool: Pool,
  adminPool: Pool,
  schema: string,
  ops: Operations,
  owner: Actor,
  accountant: Actor,
  qb: QuickBooks;
let posts: AccountingRequest[],
  receipts: any[],
  failure: "none" | "lost_response" | "not_delivered" | "changed_receipt";
let queries = 0;
const key = () => randomUUID();
const accounts = [
  { Id: "10", Name: "Operating bank", AccountType: "Bank", Active: true },
  { Id: "20", Name: "Repairs", AccountType: "Expense", Active: true },
  {
    Id: "30",
    Name: "Receivables",
    AccountType: "Accounts Receivable",
    Active: true,
  },
  { Id: "40", Name: "Service income", AccountType: "Income", Active: true },
];
beforeEach(async () => {
  schema = "qb_" + key().replaceAll("-", "");
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
  owner = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'QB owner','owner') RETURNING *",
      [key(), "qb_" + key().slice(0, 8)],
    )
  ).rows[0];
  accountant = { ...owner, role: "accountant" };
  posts = [];
  receipts = [];
  failure = "none";
  queries = 0;
  qb = new QuickBooks(
    ops,
    async (realm, token, mode, request) => {
      assert.equal(realm, "12345");
      assert.equal(mode, "sandbox");
      assert.equal(token, "test-access");
      if (request.method === "POST") {
        posts.push(request);
        if (failure === "not_delivered") throw Error("provider unavailable");
        const receipt = {
          ...(request.body as any),
          Id: String(100 + posts.length),
        };
        receipts.push(receipt);
        if (failure === "lost_response") throw Error("response lost");
        if (failure === "changed_receipt")
          return { JournalEntry: { ...receipt, TxnDate: "1999-01-01" } };
        return { JournalEntry: receipt };
      }
      if (request.path.startsWith("companyinfo/"))
        return { CompanyInfo: { CompanyName: "Test Waste Company" } };
      if (request.path.startsWith("customer/"))
        return {
          Customer: {
            Id: request.path.split("/")[1],
            Active: true,
            DisplayName: "Verified Customer",
          },
        };
      const query =
        new URL("https://example.test/" + request.path).searchParams.get(
          "query",
        ) || "";
      if (query.includes("FROM Account"))
        return { QueryResponse: { Account: accounts } };
      queries++;
      const doc = query.match(/DocNumber = '([^']+)'/)?.[1];
      return {
        QueryResponse: {
          JournalEntry: receipts.filter((r) => r.DocNumber === doc),
        },
      };
    },
    async () => ({
      access_token: "test-access",
      refresh_token: "test-refresh",
      expires_in: 3600,
    }),
  );
});
afterEach(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA "' + schema + '" CASCADE');
  await adminPool.end();
});
async function active() {
  const start = await qb.connect(owner),
    state = new URL(start.url).searchParams.get("state")!;
  const callback = { state, code: "test-code", realmId: "12345" };
  await qb.callback(callback);
  await qb.activate(owner, key(), {
    realm_id: "12345",
    confirm_company_name: "Test Waste Company",
  });
  return callback;
}
async function journal(
  debit = "expense:repair",
  credit = "cash",
  invoiceId: string | null = null,
) {
  return (
    await pool.query(
      "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id,posting_date,invoice_id) VALUES($1,$2,12345,'test',$3,'2026-11-01',$4) RETURNING *",
      [debit, credit, key(), invoiceId],
    )
  ).rows[0];
}
async function mapped() {
  await qb.mapping(owner, key(), {
    local_account: "expense:repair",
    remote_account_id: "20",
  });
  await qb.mapping(owner, key(), {
    local_account: "cash",
    remote_account_id: "10",
  });
}
test("OAuth state is single-use, company review is exact, tokens stay encrypted, and permissions hold", async () => {
  const start = await qb.connect(owner),
    state = new URL(start.url).searchParams.get("state")!;
  await qb.callback({ state, code: "test-code", realmId: "12345" });
  const connection = (await pool.query("SELECT * FROM quickbooks_connection"))
    .rows[0];
  assert.ok(!connection.encrypted_tokens.includes("test-access"));
  assert.equal(
    JSON.parse(
      decryptIntegration(
        connection.encrypted_tokens,
        Buffer.from(process.env.INTEGRATION_ENCRYPTION_KEY!, "base64"),
        "quickbooks:12345",
      ),
    ).access_token,
    "test-access",
  );
  await assert.rejects(
    qb.callback({ state, code: "test-code", realmId: "12345" }),
    /invalid or expired/,
  );
  await assert.rejects(
    qb.activate(owner, key(), {
      realm_id: "12345",
      confirm_company_name: "Wrong Company",
    }),
    /exact connected company/,
  );
  await assert.rejects(qb.exportJournals(accountant), /not active/);
  await qb.activate(owner, key(), {
    realm_id: "12345",
    confirm_company_name: "Test Waste Company",
  });
  const status = JSON.stringify(await qb.status(accountant));
  assert.ok(
    !status.includes("encrypted_tokens") &&
      !status.includes("test-access") &&
      !status.includes("test-refresh"),
  );
  await assert.rejects(qb.connect(accountant));
  await assert.rejects(qb.status({ ...owner, role: "customer" }));
  const second = await qb.connect(owner);
  await assert.rejects(
    qb.callback({
      state: new URL(second.url).searchParams.get("state"),
      code: "test-code",
      realmId: "99999",
    }),
    /another QuickBooks company/,
  );
});
test("ledger mappings validate classification; successful exports are balanced, date-stable and once-only", async () => {
  await active();
  const j = await journal();
  await assert.rejects(qb.exportJournals(owner), /Map both/);
  assert.equal(posts.length, 0);
  await assert.rejects(
    qb.mapping(owner, key(), {
      local_account: "cash",
      remote_account_id: "40",
    }),
    /classification/,
  );
  await mapped();
  assert.deepEqual(await qb.exportJournals(accountant), {
    exported: 1,
    remaining: 0,
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].requestId, j.id);
  const doc = posts[0].body as any;
  assert.equal(doc.TxnDate, "2026-11-01");
  assert.equal(doc.Line[0].Amount, 123.45);
  assert.equal(doc.Line[0].JournalEntryLineDetail.PostingType, "Debit");
  assert.equal(doc.Line[1].JournalEntryLineDetail.PostingType, "Credit");
  assert.deepEqual(await qb.exportJournals(owner), {
    exported: 0,
    remaining: 0,
  });
  assert.equal(posts.length, 1);
  await assert.rejects(
    pool.query("UPDATE quickbooks_exports SET remote_id='bad'"),
    /Append-only/,
  );
});
test("lost export response is recovered from an exact provider receipt without posting twice", async () => {
  await active();
  const j = await journal();
  await mapped();
  failure = "lost_response";
  await assert.rejects(qb.exportJournals(owner), /response lost/);
  assert.equal(posts.length, 1);
  assert.equal(
    (await pool.query("SELECT * FROM quickbooks_exports")).rowCount,
    0,
  );
  // A later account change must not change the saved document used for reconciliation.
  await pool.query(
    "UPDATE quickbooks_account_mappings SET remote_account_id='999' WHERE local_account='cash'",
  );
  failure = "none";
  assert.deepEqual(await qb.exportJournals(owner), {
    exported: 1,
    remaining: 0,
  });
  assert.equal(posts.length, 1);
  assert.ok(queries >= 2);
  await assert.rejects(
    pool.query(
      "UPDATE quickbooks_export_attempts SET document='{}' WHERE journal_id=$1",
      [j.id],
    ),
    /immutable/,
  );
});
test("unresolved provider delivery never resends; a mismatching receipt cannot acknowledge the export", async () => {
  await active();
  await journal();
  await mapped();
  failure = "not_delivered";
  await assert.rejects(qb.exportJournals(owner), /provider unavailable/);
  failure = "none";
  await assert.rejects(qb.exportJournals(owner), /unresolved/);
  assert.equal(posts.length, 1);
  const document = (
    await pool.query("SELECT document FROM quickbooks_export_attempts")
  ).rows[0].document;
  receipts.push({
    ...document,
    Id: "999",
    Line: [{ ...document.Line[0], Amount: 0 }, document.Line[1]],
  });
  await assert.rejects(qb.exportJournals(owner), /receipt differs/);
  assert.equal(
    (await pool.query("SELECT * FROM quickbooks_exports")).rowCount,
    0,
  );
  assert.equal(posts.length, 1);
});
test("receivables require an explicitly verified customer mapping", async () => {
  await active();
  const customer: any = await ops.createCustomer(owner, key(), {
    name: "Local customer",
    kind: "commercial",
    email: "qb@example.test",
    billing_address: "Billing",
  });
  await journal("accounts_receivable", "service_revenue");
  await qb.mapping(owner, key(), {
    local_account: "accounts_receivable",
    remote_account_id: "30",
  });
  await qb.mapping(owner, key(), {
    local_account: "service_revenue",
    remote_account_id: "40",
  });
  await assert.rejects(qb.exportJournals(owner), /linked customer/);
  assert.equal(posts.length, 0);
  await assert.rejects(
    qb.customerMapping(owner, key(), {
      customer_id: customer.id,
      remote_id: "77",
      confirm_display_name: "Wrong",
    }),
    /exact active/,
  );
  await qb.customerMapping(owner, key(), {
    customer_id: customer.id,
    remote_id: "77",
    confirm_display_name: "Verified Customer",
  });
  await assert.rejects(
    qb.customerMapping(owner, key(), {
      customer_id: customer.id,
      remote_id: "88",
      confirm_display_name: "Verified Customer",
    }),
    /migration review/,
  );
  const doc = journalExportDocument(
    {
      id: key(),
      debit_account: "accounts_receivable",
      credit_account: "service_revenue",
      amount_cents: 12345,
      created_at: new Date(),
      source_kind: "invoice",
    },
    new Map([
      [
        "accounts_receivable",
        { remote_account_type: "Accounts Receivable", remote_account_id: "30" },
      ],
      [
        "service_revenue",
        { remote_account_type: "Income", remote_account_id: "40" },
      ],
    ]),
    "77",
  );
  assert.equal(
    doc.Line[0].JournalEntryLineDetail.Entity?.EntityRef.value,
    "77",
  );
});
test("integration encryption authenticates company scope and detects modified ciphertext", () => {
  const keyBytes = randomBytes(32),
    encrypted = encryptIntegration(
      "sensitive token",
      keyBytes,
      "quickbooks:12345",
    );
  assert.equal(
    decryptIntegration(encrypted, keyBytes, "quickbooks:12345"),
    "sensitive token",
  );
  assert.throws(() =>
    decryptIntegration(encrypted, keyBytes, "quickbooks:99999"),
  );
  const modified = Buffer.from(encrypted, "base64");
  modified[30] ^= 1;
  assert.throws(() =>
    decryptIntegration(
      modified.toString("base64"),
      keyBytes,
      "quickbooks:12345",
    ),
  );
});
