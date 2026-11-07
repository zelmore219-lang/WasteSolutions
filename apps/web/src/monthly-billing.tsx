import { useEffect, useState } from "react";
export function MonthlyBillingPanel({
  actor,
  api,
  refresh,
}: {
  actor: any;
  api: (p: string, b?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [items, setItems] = useState<any[]>([]),
    [recognitions, setRecognitions] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const [due, pending] = await Promise.all([
      api("/billing/monthly"),
      api("/billing/contract-recognition"),
    ]);
    setItems(due);
    setRecognitions(pending);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [actor]);
  async function act(action: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Contract period billing</h2>
      <p>
        Monthly, quarterly and annual periods follow calendar boundaries or the
        contract anniversary. Partial periods prorate by active days in the full
        period. Arrears invoices require a closed period and completed service.
        Advance invoices become available when coverage starts and post to
        deferred revenue.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!items.length ? (
        <p>No contract periods awaiting billing.</p>
      ) : (
        items.map((a) => (
          <article className="order" key={a.id}>
            <div>
              <h3>{a.customer_name}</h3>
              <p>
                {"$" + (a.monthly_rate_cents / 100).toFixed(2)} monthly rate ·
                Full {a.billing_cycle_months}-month {a.billing_alignment} cycle:
                $
                {(
                  (a.monthly_rate_cents * a.billing_cycle_months) /
                  100
                ).toFixed(2)}{" "}
                · Next period: {a.next_billing_month} through{" "}
                {a.billing_period_end}
              </p>
              <p>
                {a.billing_timing === "advance"
                  ? "Advance · deferred until verified fulfillment"
                  : "Arrears · verified completed service"}
              </p>
            </div>
            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api("/agreements/" + a.id + "/monthly-invoice", {
                    period_start: a.next_billing_month,
                  }),
                )
              }
            >
              {a.billing_timing === "advance"
                ? "Invoice advance contract period"
                : "Invoice verified contract period"}
            </button>
          </article>
        ))
      )}
      <h3>Verify prepaid service and recognize revenue</h3>
      <p>
        This closes an already invoiced advance period after every covered visit
        is generated and completed. It moves the remaining deferred balance to
        service revenue today; it does not create another invoice or collect a
        payment. Finance credits must be reviewed before shortening prepaid
        coverage.
      </p>
      {!recognitions.length ? (
        <p>No closed prepaid periods awaiting verification.</p>
      ) : (
        recognitions.map((p) => (
          <article className="order" key={p.id}>
            <div>
              <h4>{p.customer_name}</h4>
              <p>
                Invoice CW-{p.invoice_number} · Coverage {p.active_from} through{" "}
                {p.active_through} · Original charge $
                {(p.amount_cents / 100).toFixed(2)} before credits
              </p>
            </div>
            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api("/billing/contract-periods/" + p.id + "/recognize", {}),
                )
              }
            >
              Verify service and recognize revenue
            </button>
          </article>
        ))
      )}
    </section>
  );
}
