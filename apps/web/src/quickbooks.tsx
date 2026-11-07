import { FormEvent, useEffect, useState } from "react";
type Props = {
  actor: Record<string, any>;
  api: (path: string, body?: unknown) => Promise<any>;
};
export function QuickBooksPanel({ actor, api }: Props) {
  const [data, setData] = useState<any>(null),
    [accounts, setAccounts] = useState<any[]>([]),
    [customers, setCustomers] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const admin = ["owner", "manager"].includes(actor.role);
  async function load() {
    const d = await api("/accounting/quickbooks");
    setData(d);
    if (admin) setCustomers(await api("/customers?limit=500"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [actor]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function fields(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <section className="panel">
        <h2>QuickBooks accounting connection</h2>
        <p>
          CoreWaste exports balanced general ledger journal entries. CoreWaste
          remains the source for invoices, receipts and customer balances. Have
          your accountant review the mappings and opening balances before the
          first export.
        </p>
        {data?.connection ? (
          <>
            <p>
              <b>{data.connection.company_name}</b> · Company{" "}
              {data.connection.realm_id} · {data.connection.mode} ·{" "}
              {data.connection.status.replaceAll("_", " ")}
            </p>
            {admin && data.connection.status === "pending_review" && (
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/accounting/quickbooks/activate", {
                      realm_id: data.connection.realm_id,
                      confirm_company_name: b.name,
                    }),
                  );
                }}
              >
                <label>
                  Type the exact QuickBooks company name
                  <input name="name" required autoComplete="off" />
                </label>
                <button disabled={busy}>Confirm connected company</button>
              </form>
            )}
          </>
        ) : (
          <p>No QuickBooks company connected.</p>
        )}
        {admin && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api("/accounting/quickbooks/connect", {});
                const url = new URL(r.url);
                if (
                  url.protocol !== "https:" ||
                  url.hostname !== "appcenter.intuit.com"
                )
                  throw Error("Invalid authorization destination");
                window.location.assign(url.href);
              })
            }
          >
            {data?.connection
              ? "Renew QuickBooks authorization"
              : "Connect QuickBooks"}
          </button>
        )}
      </section>
      {data?.connection?.status === "active" && (
        <>
          <section className="panel">
            <h2>Ledger account mappings</h2>
            {data.mappings.map((m: any) => (
              <p key={m.local_account}>
                {m.local_account.replaceAll("_", " ")} → {m.remote_account_name}{" "}
                ({m.remote_account_type})
              </p>
            ))}
            {admin && (
              <>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setAccounts(await api("/accounting/quickbooks/accounts")),
                    )
                  }
                >
                  Load QuickBooks chart of accounts
                </button>
                {accounts.length > 0 && (
                  <form
                    className="grid"
                    onSubmit={(e) => {
                      const b = fields(e);
                      void act(() => api("/accounting/quickbooks/mappings", b));
                    }}
                  >
                    <label>
                      CoreWaste account
                      <select name="local_account" required>
                        {data.local_accounts.map((n: string) => (
                          <option key={n} value={n}>
                            {n.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      QuickBooks account
                      <select name="remote_account_id" required>
                        {accounts
                          .filter((a) => a.Active)
                          .map((a) => (
                            <option value={a.Id} key={a.Id}>
                              {a.Name} · {a.AccountType}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button disabled={busy}>Save account mapping</button>
                  </form>
                )}
              </>
            )}
          </section>
          <section className="panel">
            <h2>Customer links</h2>
            <p>
              Link each customer to their existing QuickBooks customer before
              exporting receivables. Confirm its exact QuickBooks display name
              to prevent linking the wrong account.
            </p>
            {data.customer_mappings.map((c: any) => (
              <p key={c.customer_id}>
                {c.name} → QuickBooks customer {c.remote_id}
              </p>
            ))}
            {admin && (
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() => api("/accounting/quickbooks/customers", b));
                }}
              >
                <label>
                  CoreWaste customer
                  <select name="customer_id" required>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  QuickBooks customer ID
                  <input name="remote_id" pattern="[0-9]+" required />
                </label>
                <label>
                  Exact QuickBooks display name
                  <input name="confirm_display_name" required />
                </label>
                <button disabled={busy}>Verify and link customer</button>
              </form>
            )}
          </section>
          <section className="panel">
            <h2>Journal exports</h2>
            <p>
              {data.pending_journals} journal entries awaiting export. Each run
              exports up to 50 entries.
            </p>
            {data.unresolved.length > 0 && (
              <p className="notice">
                Some requests await provider reconciliation. Running an export
                checks for matching receipts. An unresolved request is never
                sent a second time automatically.
              </p>
            )}
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api("/accounting/quickbooks/export", {});
                  setMessage(
                    r.exported +
                      " journal entries exported; " +
                      r.remaining +
                      " remaining.",
                  );
                })
              }
            >
              Export and reconcile journal entries
            </button>
            {data.exports.map((e: any) => (
              <p key={e.journal_id}>
                {"$" + (e.amount_cents / 100).toFixed(2)} ·{" "}
                {e.debit_account.replaceAll("_", " ")} /{" "}
                {e.credit_account.replaceAll("_", " ")}
                <small>
                  QuickBooks receipt {e.remote_id} ·{" "}
                  {new Date(e.exported_at).toLocaleString()}
                </small>
              </p>
            ))}
          </section>
        </>
      )}
    </>
  );
}
