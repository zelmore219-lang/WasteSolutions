import { MonthlyBillingPanel } from "./monthly-billing";
import { useEffect, useState } from "react";
export function AutomationPanel({
  actor,
  api,
  refresh,
}: {
  actor: Record<string, any>;
  api: (p: string, b?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [runs, setRuns] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setRuns(await api("/automation"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function run() {
    setBusy(true);
    setError("");
    try {
      await api("/automation/run", {});
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <MonthlyBillingPanel actor={actor} api={api} refresh={refresh} />
      <section className="panel">
        <h2>Scheduled operations and billing</h2>
        <p className="muted">
          Generate today's recurring service orders, invoice verified completed
          work, apply the company's configured overdue fee, and submit
          customer-authorized autopay attempts. Payment confirmation is recorded
          separately from signed provider events.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {["owner", "manager"].includes(actor.role) && (
          <button disabled={busy} onClick={() => void run()}>
            {busy ? "Processing scheduled work…" : "Run today’s scheduled work"}
          </button>
        )}
        <h3>Run history</h3>
        {!runs.length ? (
          <p>No automation runs yet.</p>
        ) : (
          runs.map((r) => (
            <article className="order" key={r.id}>
              <div>
                <span className="badge">{r.status}</span>
                <h3>
                  {r.job_date} · attempt {r.attempts}
                </h3>
                <p>
                  {r.summary.generated_orders ?? 0} service orders ·{" "}
                  {r.summary.service_invoices ?? 0} service invoices ·{" "}
                  {r.summary.monthly_invoices ?? 0} monthly invoices ·{" "}
                  {r.summary.rental_invoices ?? 0} rental invoices ·{" "}
                  {r.summary.facility_invoices ?? 0} facility invoices
                </p>
                <small>
                  {r.summary.late_fees ?? 0} configured fees ·{" "}
                  {r.summary.provider_attempts ?? 0} provider attempts submitted
                </small>
                {r.summary.errors?.map((e: any, i: number) => (
                  <p className="error" key={i}>
                    {e.stage.replaceAll("_", " ")} requires review:{" "}
                    {e.record_id}
                  </p>
                ))}
              </div>
            </article>
          ))
        )}
      </section>
    </>
  );
}
