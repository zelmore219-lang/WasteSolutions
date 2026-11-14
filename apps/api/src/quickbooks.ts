import { providerValue } from "./provider-runtime";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { fetch, EnvHttpProxyAgent } from "undici";
import { PoolClient } from "pg";
import { z } from "zod";
import { Actor, Operations, FINANCE, parse, permit } from "./domain";
import {
  encryptIntegration,
  decryptIntegration,
  integrationKey,
} from "./integration-crypto";
type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};
export type AccountingRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  requestId?: string;
};
export type AccountingTransport = (
  realm: string,
  token: string,
  mode: string,
  request: AccountingRequest,
) => Promise<any>;
const dispatcher = new EnvHttpProxyAgent();
function configuration() {
  const id = providerValue("QUICKBOOKS_CLIENT_ID"),
    secret = providerValue("QUICKBOOKS_CLIENT_SECRET"),
    redirect = providerValue("QUICKBOOKS_REDIRECT_URI"),
    mode = providerValue("QUICKBOOKS_MODE") || "sandbox";
  if (!id || !secret || !redirect)
    throw new ServiceUnavailableException(
      "QuickBooks connection is not configured",
    );
  if (
    !["sandbox", "production"].includes(mode) ||
    (process.env.NODE_ENV === "production" && mode !== "production")
  )
    throw new ServiceUnavailableException(
      "QuickBooks mode does not match this environment",
    );
  const url = new URL(redirect);
  if (
    url.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new ServiceUnavailableException("QuickBooks redirect must use HTTPS");
  return { id, secret, redirect, mode };
}
async function exchange(body: URLSearchParams): Promise<Tokens> {
  const config = configuration();
  const r = await fetch(
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    {
      dispatcher,
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(config.id + ":" + config.secret).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
  );
  if (!r.ok)
    throw new ServiceUnavailableException(
      "QuickBooks authorization must be renewed",
    );
  const value = (await r.json()) as Tokens;
  if (
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string" ||
    !Number.isFinite(value.expires_in)
  )
    throw new ServiceUnavailableException(
      "QuickBooks returned invalid authorization data",
    );
  return value;
}
const productionTransport: AccountingTransport = async (
  realm,
  token,
  mode,
  request,
) => {
  const host =
      mode === "production"
        ? "https://quickbooks.api.intuit.com"
        : "https://sandbox-quickbooks.api.intuit.com",
    url = new URL(
      "/v3/company/" + encodeURIComponent(realm) + "/" + request.path,
      host,
    );
  url.searchParams.set("minorversion", "75");
  if (request.requestId) url.searchParams.set("requestid", request.requestId);
  const r = await fetch(url, {
    dispatcher,
    method: request.method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  if (!r.ok)
    throw new ServiceUnavailableException(
      "QuickBooks request failed with HTTP " + r.status,
    );
  return await r.json();
};
export function journalExportDocument(
  j: any,
  mappings: Map<string, any>,
  customerRef?: string,
) {
  const debit = mappings.get(j.debit_account),
    credit = mappings.get(j.credit_account);
  if (!debit || !credit)
    throw new ConflictException("Map both ledger accounts before exporting");
  const line = (posting: "Debit" | "Credit", mapping: any) => {
    const type = mapping.remote_account_type;
    if (type === "Accounts Receivable" && !customerRef)
      throw new ConflictException(
        "Receivable entry requires a linked customer",
      );
    if (type === "Accounts Payable")
      throw new ConflictException(
        "Payable export requires a verified vendor mapping",
      );
    return {
      Amount: j.amount_cents / 100,
      DetailType: "JournalEntryLineDetail",
      Description: "CoreWaste " + j.source_kind,
      JournalEntryLineDetail: {
        PostingType: posting,
        AccountRef: { value: mapping.remote_account_id },
        ...(type === "Accounts Receivable"
          ? { Entity: { Type: "Customer", EntityRef: { value: customerRef } } }
          : {}),
      },
    };
  };
  return {
    DocNumber:
      "CWJ-" +
      createHash("sha256").update(j.id).digest("base64url").slice(0, 17),
    TxnDate:
      j.posting_date || new Date(j.created_at).toISOString().slice(0, 10),
    PrivateNote: "CoreWaste journal " + j.id,
    Line: [line("Debit", debit), line("Credit", credit)],
  };
}
export class QuickBooks {
  constructor(
    readonly ops: Operations,
    private transport: AccountingTransport = productionTransport,
    private exchangeTokens: (
      body: URLSearchParams,
    ) => Promise<Tokens> = exchange,
  ) {}
  async status(a: Actor) {
    permit(a, FINANCE);
    const connection = (
      await this.ops.pool.query(
        "SELECT realm_id,company_name,mode,status,expires_at,updated_at FROM quickbooks_connection WHERE singleton",
      )
    ).rows[0];
    return {
      connection: connection || null,
      mappings: (
        await this.ops.pool.query(
          "SELECT * FROM quickbooks_account_mappings ORDER BY local_account",
        )
      ).rows,
      local_accounts: (
        await this.ops.pool.query(
          "SELECT debit_account AS name FROM journal UNION SELECT credit_account FROM journal ORDER BY name",
        )
      ).rows.map((r) => r.name),
      customer_mappings: (
        await this.ops.pool.query(
          "SELECT q.customer_id,q.remote_id,c.name FROM quickbooks_customers q JOIN customers c ON c.id=q.customer_id ORDER BY c.name",
        )
      ).rows,
      exports: (
        await this.ops.pool.query(
          "SELECT e.*,j.amount_cents,j.debit_account,j.credit_account FROM quickbooks_exports e JOIN journal j ON j.id=e.journal_id ORDER BY exported_at DESC LIMIT 100",
        )
      ).rows,
      unresolved: (
        await this.ops.pool.query(
          "SELECT a.journal_id,a.attempted_at FROM quickbooks_export_attempts a LEFT JOIN quickbooks_exports e ON e.journal_id=a.journal_id WHERE a.attempted_at IS NOT NULL AND e.journal_id IS NULL",
        )
      ).rows,
      pending_journals: Number(
        (
          await this.ops.pool.query(
            "SELECT count(*) AS n FROM journal j LEFT JOIN quickbooks_exports e ON e.journal_id=j.id WHERE e.journal_id IS NULL AND j.amount_cents>0",
          )
        ).rows[0].n,
      ),
    };
  }
  async connect(a: Actor) {
    permit(a, ["owner", "manager"]);
    const config = configuration(),
      state = randomBytes(32).toString("base64url"),
      hash = createHash("sha256").update(state).digest("hex");
    await this.ops.pool.query(
      "INSERT INTO quickbooks_oauth_states(state_hash,actor_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
      [hash, a.id],
    );
    const url = new URL("https://appcenter.intuit.com/connect/oauth2");
    url.searchParams.set("client_id", config.id);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
    url.searchParams.set("redirect_uri", config.redirect);
    url.searchParams.set("state", state);
    return { url: url.href };
  }
  async callback(query: unknown) {
    const b = parse(
        z
          .object({
            state: z.string().min(20).max(200),
            code: z.string().min(1).max(4000),
            realmId: z.string().regex(/^[0-9]{1,20}$/),
          })
          .strict(),
        query,
      ),
      hash = createHash("sha256").update(b.state).digest("hex");
    const state = (
      await this.ops.pool.query(
        "UPDATE quickbooks_oauth_states SET status='processing' WHERE state_hash=$1 AND status='pending' AND expires_at>now() RETURNING actor_id",
        [hash],
      )
    ).rows[0];
    if (!state)
      throw new BadRequestException(
        "QuickBooks authorization state is invalid or expired",
      );
    try {
      if (
        !(
          await this.ops.pool.query(
            "SELECT 1 FROM employees WHERE id=$1 AND active AND role IN ('owner','manager')",
            [state.actor_id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Connecting administrator no longer has permission",
        );
      const old = (
        await this.ops.pool.query(
          "SELECT realm_id,mode FROM quickbooks_connection WHERE singleton",
        )
      ).rows[0];
      if (
        old &&
        (old.realm_id !== b.realmId || old.mode !== configuration().mode)
      )
        throw new ConflictException(
          "This environment is already bound to another QuickBooks company; do not switch without a migration review",
        );
      const config = configuration(),
        tokens = await this.exchangeTokens(
          new URLSearchParams({
            grant_type: "authorization_code",
            code: b.code,
            redirect_uri: config.redirect,
          }),
        ),
        info = await this.transport(
          b.realmId,
          tokens.access_token,
          config.mode,
          {
            method: "GET",
            path: "companyinfo/" + encodeURIComponent(b.realmId),
          },
        ),
        name = info.CompanyInfo?.CompanyName;
      if (typeof name !== "string")
        throw new ServiceUnavailableException(
          "QuickBooks company information is unavailable",
        );
      const encrypted = encryptIntegration(
        JSON.stringify(tokens),
        await integrationKey(),
        "quickbooks:" + b.realmId,
      );
      const saved = await this.ops.pool.query(
        "INSERT INTO quickbooks_connection(singleton,realm_id,company_name,mode,status,encrypted_tokens,expires_at,connected_by) VALUES(true,$1,$2,$3,'pending_review',$4,now()+$5::int*interval '1 second',$6) ON CONFLICT(singleton) DO UPDATE SET company_name=$2,mode=$3,status='pending_review',encrypted_tokens=$4,expires_at=now()+$5::int*interval '1 second',connected_by=$6,updated_at=now() WHERE quickbooks_connection.realm_id=EXCLUDED.realm_id AND quickbooks_connection.mode=EXCLUDED.mode RETURNING realm_id",
        [
          b.realmId,
          name,
          config.mode,
          encrypted,
          tokens.expires_in,
          state.actor_id,
        ],
      );
      if (!saved.rowCount)
        throw new ConflictException(
          "QuickBooks company changed during authorization",
        );
      await this.ops.pool.query(
        "UPDATE quickbooks_oauth_states SET status='completed' WHERE state_hash=$1",
        [hash],
      );
      return { connected: true, review_required: true };
    } catch (error) {
      await this.ops.pool.query(
        "UPDATE quickbooks_oauth_states SET status='failed' WHERE state_hash=$1",
        [hash],
      );
      throw error;
    }
  }
  async activate(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager"]);
    const b = parse(
      z
        .object({
          realm_id: z.string().regex(/^[0-9]{1,20}$/),
          confirm_company_name: z.string().min(1),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["quickbooks.activate", b], async (c) => {
      const row = (
        await c.query(
          "UPDATE quickbooks_connection SET status='active',updated_at=now() WHERE singleton AND realm_id=$1 AND company_name=$2 AND status='pending_review' RETURNING realm_id,company_name,status",
          [b.realm_id, b.confirm_company_name],
        )
      ).rows[0];
      if (!row)
        throw new ConflictException(
          "Review and confirm the exact connected company before activation",
        );
      await this.ops.audit(c, a, "quickbooks.activated", a.id, {
        realm_id: b.realm_id,
      });
      return row;
    });
  }
  private async access(c: PoolClient) {
    const connection = (
      await c.query(
        "SELECT * FROM quickbooks_connection WHERE singleton FOR UPDATE",
      )
    ).rows[0];
    if (!connection || connection.status !== "active")
      throw new ServiceUnavailableException(
        "QuickBooks connection is not active",
      );
    if (
      process.env.NODE_ENV === "production" &&
      connection.mode !== "production"
    )
      throw new ServiceUnavailableException(
        "Sandbox accounting is not allowed for production",
      );
    let tokens: Tokens = JSON.parse(
      decryptIntegration(
        connection.encrypted_tokens,
        await integrationKey(),
        "quickbooks:" + connection.realm_id,
      ),
    );
    if (new Date(connection.expires_at).getTime() - Date.now() < 60000) {
      tokens = await this.exchangeTokens(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }),
      );
      await c.query(
        "UPDATE quickbooks_connection SET encrypted_tokens=$1,expires_at=now()+$2::int*interval '1 second',updated_at=now() WHERE singleton",
        [
          encryptIntegration(
            JSON.stringify(tokens),
            await integrationKey(),
            "quickbooks:" + connection.realm_id,
          ),
          tokens.expires_in,
        ],
      );
    }
    return { connection, tokens };
  }
  async accounts(a: Actor) {
    permit(a, FINANCE);
    const c = await this.ops.pool.connect();
    try {
      await c.query("BEGIN");
      const { connection, tokens } = await this.access(c);
      await c.query("COMMIT");
      const response = await this.transport(
        connection.realm_id,
        tokens.access_token,
        connection.mode,
        {
          method: "GET",
          path:
            "query?query=" +
            encodeURIComponent("SELECT * FROM Account MAXRESULTS 1000"),
        },
      );
      return response.QueryResponse?.Account || [];
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async mapping(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager"]);
    const b = parse(
      z
        .object({
          local_account: z.string().min(1).max(100),
          remote_account_id: z.string().regex(/^[0-9]+$/),
        })
        .strict(),
      body,
    );
    const account = (await this.accounts(a)).find(
      (r: any) => r.Id === b.remote_account_id && r.Active,
    );
    if (!account)
      throw new BadRequestException(
        "Select an active account from the connected chart",
      );
    const expected =
      b.local_account === "accounts_receivable"
        ? ["Accounts Receivable"]
        : ["customer_credit", "deferred_revenue"].includes(b.local_account)
          ? ["Other Current Liability", "Long Term Liability"]
          : b.local_account.endsWith("_revenue")
            ? ["Income", "Other Income"]
            : b.local_account === "cash"
              ? ["Bank", "Other Current Asset"]
              : b.local_account === "opening_equity"
                ? ["Equity"]
                : b.local_account.startsWith("expense:") ||
                    b.local_account.endsWith("_expense")
                  ? ["Expense", "Cost of Goods Sold", "Other Expense"]
                  : [];
    if (!expected.length || !expected.includes(account.AccountType))
      throw new BadRequestException(
        "Choose an account with a matching ledger classification",
      );
    return this.ops.command(a, key, ["quickbooks.map", b], async (c) => {
      if (
        !(
          await c.query(
            "SELECT 1 FROM journal WHERE debit_account=$1 OR credit_account=$1",
            [b.local_account],
          )
        ).rowCount
      )
        throw new BadRequestException("Local ledger account not found");
      const row = (
        await c.query(
          "INSERT INTO quickbooks_account_mappings(local_account,remote_account_id,remote_account_name,remote_account_type,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(local_account) DO UPDATE SET remote_account_id=$2,remote_account_name=$3,remote_account_type=$4,updated_by=$5 RETURNING *",
          [
            b.local_account,
            account.Id,
            account.Name,
            account.AccountType,
            a.id,
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "quickbooks.mapping_updated", a.id, {
        local_account: b.local_account,
      });
      return row;
    });
  }
  async customerMapping(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager"]);
    const b = parse(
      z
        .object({
          customer_id: z.uuid(),
          remote_id: z.string().regex(/^[0-9]+$/),
          confirm_display_name: z.string().min(1).max(500),
        })
        .strict(),
      body,
    );
    const c = await this.ops.pool.connect();
    let remote: any,
      transaction = false;
    try {
      await c.query("BEGIN");
      transaction = true;
      const { connection, tokens } = await this.access(c);
      await c.query("COMMIT");
      transaction = false;
      remote = (
        await this.transport(
          connection.realm_id,
          tokens.access_token,
          connection.mode,
          { method: "GET", path: "customer/" + b.remote_id },
        )
      ).Customer;
    } catch (error) {
      if (transaction) await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
    if (
      !remote ||
      remote.Id !== b.remote_id ||
      !remote.Active ||
      remote.DisplayName !== b.confirm_display_name
    )
      throw new BadRequestException(
        "Confirm the exact active QuickBooks customer display name",
      );
    return this.ops.command(a, key, ["quickbooks.customer", b], async (c) => {
      if (
        !(await c.query("SELECT 1 FROM customers WHERE id=$1", [b.customer_id]))
          .rowCount
      )
        throw new BadRequestException("Customer not found");
      const old = (
        await c.query(
          "SELECT remote_id FROM quickbooks_customers WHERE customer_id=$1 FOR UPDATE",
          [b.customer_id],
        )
      ).rows[0];
      if (old && old.remote_id !== b.remote_id)
        throw new ConflictException(
          "Existing customer links require an accounting migration review",
        );
      const row = (
        await c.query(
          "INSERT INTO quickbooks_customers(customer_id,remote_id) VALUES($1,$2) ON CONFLICT(customer_id) DO UPDATE SET remote_id=EXCLUDED.remote_id RETURNING *",
          [b.customer_id, b.remote_id],
        )
      ).rows[0];
      await this.ops.audit(c, a, "quickbooks.customer_linked", b.customer_id, {
        remote_id: b.remote_id,
      });
      return row;
    });
  }
  async exportJournals(a: Actor) {
    permit(a, FINANCE);
    const c = await this.ops.pool.connect();
    let held = false,
      transaction = false;
    try {
      held = (
        await c.query(
          "SELECT pg_try_advisory_lock(hashtext('corewaste-quickbooks-export')) AS held",
        )
      ).rows[0].held;
      if (!held)
        throw new ConflictException("Accounting export is already running");
      await c.query("BEGIN");
      transaction = true;
      const { connection, tokens } = await this.access(c);
      await c.query("COMMIT");
      transaction = false;
      const mappings = new Map(
        (await c.query("SELECT * FROM quickbooks_account_mappings")).rows.map(
          (r) => [r.local_account, r],
        ),
      );
      const journals = (
        await c.query(
          "SELECT j.*,i.customer_id FROM journal j LEFT JOIN invoices i ON i.id=j.invoice_id LEFT JOIN quickbooks_exports e ON e.journal_id=j.id WHERE e.journal_id IS NULL AND j.amount_cents>0 ORDER BY j.created_at,j.id LIMIT 50",
        )
      ).rows;
      let exported = 0;
      for (const journal of journals) {
        let attempt = (
          await c.query(
            "SELECT * FROM quickbooks_export_attempts WHERE journal_id=$1",
            [journal.id],
          )
        ).rows[0];
        if (!attempt) {
          const customer = (
            await c.query(
              "SELECT remote_id FROM quickbooks_customers WHERE customer_id=$1",
              [journal.customer_id],
            )
          ).rows[0];
          const document = journalExportDocument(
            journal,
            mappings,
            customer?.remote_id,
          );
          attempt = (
            await c.query(
              "INSERT INTO quickbooks_export_attempts(journal_id,realm_id,document) VALUES($1,$2,$3) RETURNING *",
              [journal.id, connection.realm_id, document],
            )
          ).rows[0];
        }
        if (attempt.realm_id !== connection.realm_id)
          throw new ConflictException(
            "Export company does not match the saved request",
          );
        const document = attempt.document;
        const query =
          "SELECT * FROM JournalEntry WHERE DocNumber = '" +
          document.DocNumber +
          "' MAXRESULTS 2";
        const found =
          (
            await this.transport(
              connection.realm_id,
              tokens.access_token,
              connection.mode,
              {
                method: "GET",
                path: "query?query=" + encodeURIComponent(query),
              },
            )
          ).QueryResponse?.JournalEntry || [];
        let remote: any;
        if (found.length) {
          if (found.length !== 1 || !matchingJournal(found[0], document))
            throw new ConflictException(
              "QuickBooks receipt differs from the saved export; reconcile it before continuing",
            );
          remote = found[0];
        } else {
          if (attempt.attempted_at)
            throw new ConflictException(
              "QuickBooks delivery is unresolved. No second journal will be sent; reconcile the original request with the provider",
            );
          await c.query(
            "UPDATE quickbooks_export_attempts SET attempted_at=now() WHERE journal_id=$1",
            [journal.id],
          );
          remote = (
            await this.transport(
              connection.realm_id,
              tokens.access_token,
              connection.mode,
              {
                method: "POST",
                path: "journalentry",
                requestId: journal.id,
                body: document,
              },
            )
          ).JournalEntry;
          if (!remote?.Id || !matchingJournal(remote, document))
            throw new ServiceUnavailableException(
              "QuickBooks export has no matching receipt; reconcile before retrying",
            );
        }
        await c.query("BEGIN");
        transaction = true;
        await c.query(
          "INSERT INTO quickbooks_exports(journal_id,remote_id,realm_id,exported_by) VALUES($1,$2,$3,$4)",
          [journal.id, remote.Id, connection.realm_id, a.id],
        );
        await this.ops.audit(c, a, "quickbooks.journal_exported", journal.id, {
          remote_id: remote.Id,
        });
        await c.query("COMMIT");
        transaction = false;
        exported++;
      }
      return {
        exported,
        remaining: Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM journal j LEFT JOIN quickbooks_exports e ON e.journal_id=j.id WHERE e.journal_id IS NULL AND j.amount_cents>0",
            )
          ).rows[0].n,
        ),
      };
    } catch (error) {
      if (transaction) await c.query("ROLLBACK");
      throw error;
    } finally {
      try {
        if (held)
          await c.query(
            "SELECT pg_advisory_unlock(hashtext('corewaste-quickbooks-export'))",
          );
      } finally {
        c.release();
      }
    }
  }
}
function matchingJournal(remote: any, document: any) {
  if (
    !remote.Id ||
    remote.DocNumber !== document.DocNumber ||
    remote.PrivateNote !== document.PrivateNote ||
    remote.TxnDate !== document.TxnDate
  )
    return false;
  const normalize = (lines: any[]) =>
    JSON.stringify(
      lines
        .filter((l) => l.DetailType === "JournalEntryLineDetail")
        .map((l) => ({
          amount: Math.round(Number(l.Amount) * 100),
          posting: l.JournalEntryLineDetail?.PostingType,
          account: l.JournalEntryLineDetail?.AccountRef?.value,
          customer: l.JournalEntryLineDetail?.Entity?.EntityRef?.value || null,
        }))
        .sort((a, b) => String(a.posting).localeCompare(String(b.posting))),
    );
  return (
    Array.isArray(remote.Line) &&
    normalize(remote.Line) === normalize(document.Line)
  );
}
