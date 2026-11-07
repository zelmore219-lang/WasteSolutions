import { useEffect, useState, FormEvent } from "react";
type Row = Record<string, any>;
type Api = (path: string, body?: unknown) => Promise<any>;
function cents(raw: unknown) {
  const value = String(raw);
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw Error("Enter dollars with up to two decimal places");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export function ProviderRefundPanel({
  api,
  refresh,
  payment,
  credit,
}: {
  api: Api;
  refresh: () => Promise<void>;
  payment?: Row;
  credit?: Row;
}) {
  const [data, setData] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const target = payment ? "payment" : credit ? "credit" : null,
    id = payment?.id || credit?.id;
  async function load() {
    setData(
      await api(
        "/provider-refunds" +
          (id ? "?" + (payment ? "payment_id" : "credit_id") + "=" + id : ""),
      ),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [id]);
  async function act(action: () => Promise<unknown>) {
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
  function fields(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  return (
    <section className="panel">
      <h3>Stripe {credit ? "account-credit " : ""}refunds</h3>
      <p>
        Save a request to reserve funds, then explicitly submit it to Stripe. A
        returned payment reopens its invoice; an account-credit refund reduces
        the credit liability. Uncertain delivery stays reserved until an exact
        receipt is reconciled. No automatic resubmission occurs.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data && !data.configured && (
        <p>
          Stripe refunds are not configured. Connect the provider before
          requesting or submitting a live refund.
        </p>
      )}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => void act(async () => {})}
      >
        Refresh provider refunds
      </button>
      {target && data?.configured && (
        <form
          className="grid"
          onSubmit={(e) => {
            const b = fields(e);
            void act(() =>
              api(
                "/" +
                  (payment ? "payments" : "credits") +
                  "/" +
                  id +
                  "/provider-refunds",
                {
                  amount_cents: cents(b.amount_cents),
                  reason: b.reason,
                  ...(b.payment_id ? { payment_id: b.payment_id } : {}),
                },
              ),
            );
          }}
        >
          <label>
            Stripe refund amount ($)
            <input name="amount_cents" inputMode="decimal" required />
          </label>
          <label>
            Stripe refund reason
            <input name="reason" maxLength={2000} required />
          </label>
          {credit && (
            <label>
              Original Stripe payment ID (invoice-funded credit only)
              <input name="payment_id" />
              <small>
                Use the recorded payment ID from the source invoice. Captured
                Stripe account credit uses its original reference automatically.
              </small>
            </label>
          )}
          <button disabled={busy}>Save Stripe refund request</button>
        </form>
      )}
      {data?.requests.map((r: Row) => (
        <article className="order" key={r.id}>
          <div>
            <strong>
              {r.customer_name} · ${(r.amount_cents / 100).toFixed(2)} ·{" "}
              {r.state}
            </strong>
            <p>{r.reason}</p>
            <small>
              Request {r.id} ·{" "}
              {r.credit_id ? "account credit" : "payment return"}
            </small>
            {r.provider_refund_id && (
              <small>Stripe receipt: {r.provider_refund_id}</small>
            )}
            {r.last_error && <p>{r.last_error}</p>}
          </div>
          {r.state === "requested" && (
            <div className="actions">
              <button
                disabled={busy || !data.configured}
                onClick={() =>
                  void act(() =>
                    api("/provider-refunds/" + r.id + "/submit", {}),
                  )
                }
              >
                Submit refund to Stripe
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api("/provider-refunds/" + r.id + "/cancel", {}),
                  )
                }
              >
                Cancel unsubmitted refund
              </button>
            </div>
          )}
          {r.attempted_at &&
            !["succeeded", "cancelled", "failed"].includes(r.state) && (
              <form
                className="grid"
                key={r.id + ":" + r.provider_refund_id}
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/provider-refunds/" + r.id + "/reconcile", b),
                  );
                }}
              >
                <label>
                  Stripe refund receipt ID
                  <input
                    name="provider_refund_id"
                    placeholder="re_…"
                    defaultValue={r.provider_refund_id || ""}
                    required
                  />
                </label>
                <button
                  className="secondary"
                  disabled={busy || !data.configured}
                >
                  Reconcile exact Stripe receipt
                </button>
              </form>
            )}
        </article>
      ))}
      {data && !data.requests.length && (
        <p>No provider refund requests recorded.</p>
      )}
      {!target && data?.configured && (
        <details>
          <summary>Reconcile an externally issued Stripe refund</summary>
          <p>
            Record a refund that already exists at Stripe. This retrieves its
            exact receipt and posts the reviewed accounting treatment; it never
            sends another refund. Payment returns reopen the invoice;
            account-credit refunds reduce an existing credit liability.
          </p>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(() =>
                api(
                  "/provider-refunds/external/" +
                    (b.target === "payment" ? "payments" : "credits") +
                    "/" +
                    b.target_id,
                  {
                    provider_refund_id: b.provider_refund_id,
                    amount_cents: cents(b.amount_cents),
                    reason: b.reason,
                    confirm: b.confirm,
                    ...(b.payment_id ? { payment_id: b.payment_id } : {}),
                  },
                ),
              );
            }}
          >
            <label>
              External refund accounting treatment
              <select name="target">
                <option value="payment">
                  Return original payment · reopen invoice
                </option>
                <option value="credit">
                  Refund existing account-credit liability
                </option>
              </select>
            </label>
            <label>
              Recorded payment or account-credit ID
              <input name="target_id" required />
            </label>
            <label>
              Existing Stripe refund receipt ID
              <input name="provider_refund_id" placeholder="re_…" required />
            </label>
            <label>
              External refund amount ($)
              <input name="amount_cents" inputMode="decimal" required />
            </label>
            <label>
              Original Stripe payment ID for invoice-funded account credit
              <input name="payment_id" />
            </label>
            <label>
              Reason for external refund reconciliation
              <input name="reason" maxLength={2000} required />
            </label>
            <label>
              Exact receipt confirmation
              <input
                name="confirm"
                placeholder="RECONCILE re_…"
                autoComplete="off"
                required
              />
            </label>
            <button className="secondary" disabled={busy}>
              Record existing Stripe refund receipt
            </button>
          </form>
        </details>
      )}
      {!target && Boolean(data?.unmatched.length) && (
        <div>
          <h4>External refund receipts needing review</h4>
          <p>
            These signed provider observations have no matched request. No
            accounting treatment has been guessed. Resolve the original
            payment/account-credit funding before further refunds against these
            funds.
          </p>
          {data!.unmatched.map((r: Row) => (
            <p key={r.event_id}>
              {r.provider_refund_id} · {r.provider_status} · {r.currency}{" "}
              {r.amount_cents} cents · {r.payment_intent}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

export function ProviderRefundTools(props: {
  api: Api;
  refresh: () => Promise<void>;
  payment?: Row;
  credit?: Row;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Review Stripe refunds</summary>
      {open && <ProviderRefundPanel {...props} />}
    </details>
  );
}
