import { FormEvent, useState } from "react";
const reports = [
  "revenue",
  "legacy_transactions",
  "expenses",
  "material_stock",
  "accounts_payable",
  "profitability",
  "service_profitability",
  "route_profitability",
  "accounts_receivable",
  "customer_balances",
  "collections",
  "drivers",
  "routes",
  "fleet",
  "containers",
  "disposal_tonnage",
  "recycling",
  "customer_growth",
  "service_completion",
  "missed_pickups",
  "trial_balance",
];
type Props = {
  api: (p: string, b?: unknown) => Promise<any>;
  download: (p: string) => Promise<void>;
};
export function ReportingPanel({ api, download }: Props) {
  const [result, setResult] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [path, setPath] = useState("");
  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const b = new FormData(e.currentTarget);
    const name = String(b.get("name")),
      query = new URLSearchParams({
        from: String(b.get("from")),
        to: String(b.get("to")),
      });
    setBusy(true);
    setError("");
    try {
      const data = await api(`/reports/${name}?${query}`);
      setResult(data);
      setPath(`/reports/${name}/export/FORMAT?${query}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportFile(format: string) {
    setError("");
    try {
      await download(path.replace("FORMAT", format));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <section className="panel">
        <h2>Operational and financial reports</h2>
        <form className="grid" onSubmit={run}>
          <label>
            Report
            <select name="name" aria-label="Report">
              {reports.map((r) => (
                <option key={r} value={r}>
                  {r.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            From date
            <input type="date" name="from" required />
          </label>
          <label>
            Through date
            <input type="date" name="to" required />
          </label>
          <button disabled={busy}>Run report</button>
        </form>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </section>
      {result && (
        <section className="panel">
          <div className="section-title">
            <div>
              <h2>{result.name.replaceAll("_", " ")}</h2>
              <small>
                {result.from} through {result.to} · {result.timezone}
              </small>
            </div>
            <div className="export-actions">
              <button
                className="secondary"
                onClick={() => void exportFile("csv")}
              >
                Export CSV
              </button>
              <button
                className="secondary"
                onClick={() => void exportFile("pdf")}
              >
                Export PDF
              </button>
              <button className="secondary" onClick={() => window.print()}>
                Print
              </button>
            </div>
          </div>
          {["service_profitability", "route_profitability"].includes(
            result.name,
          ) && (
            <p className="muted">
              Recognized ledger revenue less recorded, explicitly attributed
              expense. Unallocated overhead and mixed-route revenue stay visible
              rather than being split by guesswork. Attribution uses current
              saved route-stop ownership. Disposal ticket costs count only when
              recorded as a business expense; this is operating contribution,
              not a fully allocated net margin.
            </p>
          )}
          {result.name === "legacy_transactions" && (
            <p className="muted">
              Authorized source records for historical lookup only. These
              amounts are not posted to the CoreWaste ledger and do not change
              receivables or revenue. Rolled-back archive batches are excluded;
              their original rows remain in import history.
            </p>
          )}
          {result.name === "material_stock" && (
            <p className="muted">
              Material stock as of {result.to}, including earlier movements.
              Quantities are kilograms; no inventory valuation is implied.
            </p>
          )}
          {result.name === "accounts_receivable" && (
            <p className="muted">
              Posted receivables as of {result.to}. Later receipts, refunds and
              adjustments do not alter this historical snapshot; aging uses that
              date.
            </p>
          )}
          {result.name === "customer_balances" && (
            <p className="muted">
              Customer receivables and unused account credits as of {result.to},
              reconstructed from dated ledger postings. Later payments, credit
              applications and refunds are excluded. Customer names reflect the
              current account.
            </p>
          )}
          {result.name === "accounts_payable" && (
            <p className="muted">
              Unpaid bills as of {result.to}, including earlier bills. Payments
              after that date are excluded. Vendor credits and returned-payment
              reversals use their recorded business dates.
            </p>
          )}
          {result.rows.length ? (
            <table>
              <thead>
                <tr>
                  {Object.keys(result.rows[0]).map((k) => (
                    <th key={k}>{k.replaceAll("_", " ")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r: any, i: number) => (
                  <tr key={i}>
                    {Object.entries(r).map(([k, v]) => (
                      <td key={k}>
                        {k.endsWith("_cents")
                          ? new Intl.NumberFormat("en-US", {
                              style: "currency",
                              currency: "USD",
                            }).format(Number(v) / 100)
                          : String(v ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No matching records.</p>
          )}
          {result.name === "profitability" && (
            <p className="muted">
              Revenue less recorded business expenses. Unrecorded costs, taxes
              and allocation adjustments are excluded.
            </p>
          )}
          {result.name === "containers" && (
            <p className="muted">
              Reserved calendar days in the selected period; this measures
              reservations rather than physical usage.
            </p>
          )}
        </section>
      )}
    </>
  );
}
