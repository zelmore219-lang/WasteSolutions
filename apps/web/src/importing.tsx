import { useEffect, useState, FormEvent } from "react";
const templates: Record<string, string> = {
  customers: "external_id,name,kind,email,phone,billing_address",
  locations: "external_id,customer_id,address,instructions",
  containers: "external_id,number,kind,capacity_yards",
  agreements:
    "external_id,customer_id,location_id,kind,price_cents,interval_days,next_service_date",
  orders:
    "external_id,customer_id,location_id,kind,scheduled_date,instructions,price_cents",
  routes: "external_id,name,service_date,driver_id,truck_id,order_ids",
  legacy_transactions:
    "external_id,source_system,source_reference,transaction_kind,transaction_date,amount_cents,currency,customer_id,vendor,related_reference,memo",
  opening_balances:
    "external_id,customer_id,amount_cents,balance_date,due_date,source_reference",
};
export function ImportPanel({
  api,
}: {
  api: (p: string, b?: unknown) => Promise<any>;
}) {
  const [batches, setBatches] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(null),
    [kind, setKind] = useState("customers"),
    [csv, setCsv] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBatches(await api("/imports"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function transition(e: FormEvent<HTMLFormElement>, action: string) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    await act(async () => {
      await api(`/imports/${detail.id}/${action}`, body);
      setDetail(await api(`/imports/${detail.id}`));
    });
  }
  function template() {
    const url = URL.createObjectURL(
        new Blob([templates[kind] + "\r\n"], { type: "text/csv" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = `CoreWaste-${kind}-import.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <section className="panel">
        <h2>Preview a CSV import</h2>
        <p className="muted">
          Imports create new records only. Preview detects invalid rows and
          duplicates before business records are changed. Use authorized source
          exports. Each batch supports up to 500 rows and 50 KB.
        </p>
        {kind === "legacy_transactions" && (
          <p>
            Historical source archive only: invoice, payment, refund, credit and
            expense records remain available in the legacy transactions report.
            They do not create live invoices, post revenue, initiate payments or
            change cutover balances. Use opening balances separately for
            reviewed unpaid receivables. Amounts are positive integer USD cents;
            the transaction kind preserves their meaning.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const batch = await api("/imports/preview", { kind, csv });
              setDetail(await api(`/imports/${batch.id}`));
            });
          }}
        >
          <div className="grid">
            <label>
              Import type
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setCsv("");
                }}
                aria-label="Import type"
              >
                {Object.keys(templates).map((k) => (
                  <option key={k} value={k}>
                    {k.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 50000) {
                      setError("CSV exceeds the 50 KB batch limit");
                      return;
                    }
                    void f
                      .text()
                      .then(setCsv)
                      .catch((e) => setError(e.message));
                  }
                }}
              />
            </label>
            <button type="button" className="secondary" onClick={template}>
              Download empty template
            </button>
          </div>
          <label>
            CSV contents
            <textarea
              rows={8}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={templates[kind]}
              required
            />
          </label>
          <button disabled={busy}>Validate and preview</button>
        </form>
      </section>
      {detail && (
        <section className="panel">
          <h2>Batch preview · {detail.kind.replaceAll("_", " ")}</h2>
          <p>
            <span className="badge">{detail.status}</span> ·{" "}
            {detail.rows.length} rows ·{" "}
            {detail.rows.filter((r: any) => r.errors.length > 0).length} invalid
            rows
          </p>
          <small>Batch ID: {detail.id}</small>
          <table>
            <thead>
              <tr>
                <th>CSV row</th>
                <th>External ID</th>
                <th>Values</th>
                <th>Validation</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((r: any) => (
                <tr key={r.id}>
                  <td>{r.row_number}</td>
                  <td>{r.payload.external_id}</td>
                  <td>
                    {Object.entries(r.payload)
                      .filter(([k]) => k !== "external_id")
                      .map(([k, v]) => (
                        <small key={k}>
                          {k}: {String(v)}
                        </small>
                      ))}
                  </td>
                  <td>
                    {r.errors.length ? r.errors.join("; ") : "Valid at preview"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.status === "preview" && (
            <>
              <p>
                Review every row. Type <code>APPLY {detail.id}</code> to
                authorize this exact batch. Data is revalidated when applied.
              </p>
              <form
                className="grid"
                onSubmit={(e) => void transition(e, "apply")}
              >
                <label>
                  Apply confirmation
                  <input name="confirm" autoComplete="off" required />
                </label>
                <button
                  disabled={
                    busy || detail.rows.some((r: any) => r.errors.length)
                  }
                >
                  Apply reviewed import
                </button>
              </form>
            </>
          )}
          {detail.status === "applied" && (
            <>
              <p>
                Rollback preserves history and archives the new records. It is
                blocked if dependent business activity would be affected. Type{" "}
                <code>ROLLBACK {detail.id}</code> to authorize rollback.
              </p>
              <form
                className="grid"
                onSubmit={(e) => void transition(e, "rollback")}
              >
                <label>
                  Rollback confirmation
                  <input name="confirm" autoComplete="off" required />
                </label>
                <button className="secondary" disabled={busy}>
                  Roll back this batch
                </button>
              </form>
            </>
          )}
        </section>
      )}
      <section className="panel">
        <h2>Import history</h2>
        {batches.length ? (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Type</th>
                <th>Rows</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.created_at).toLocaleString()}</td>
                  <td>{b.kind}</td>
                  <td>{b.rows}</td>
                  <td>{b.status}</td>
                  <td>
                    <button
                      className="secondary"
                      onClick={() =>
                        void act(async () => {
                          setDetail(await api(`/imports/${b.id}`));
                        })
                      }
                    >
                      View batch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No import batches.</p>
        )}
      </section>
    </>
  );
}
