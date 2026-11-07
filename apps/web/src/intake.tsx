import { dollarsToCents } from "./money-input";
import { useEffect, useState, FormEvent } from "react";
type Row = Record<string, any>;
export function IntakePanel({
  tab,
  customers,
  api,
  refresh,
}: {
  tab: string;
  customers: Row[];
  api: (p: string, b?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [items, setItems] = useState<Row[]>([]),
    [locations, setLocations] = useState<Row[]>([]),
    [customerId, setCustomerId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const portal = tab === "Portal access",
    path = portal ? "/portal/registrations" : "/inquiries";
  async function load() {
    setItems(await api(path));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [tab]);
  useEffect(() => {
    setLocations([]);
    if (customerId)
      void api("/customers/" + customerId + "/locations")
        .then(setLocations)
        .catch((e) => setError(e.message));
  }, [customerId]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const form = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  };
  return (
    <section className="panel">
      <div className="section-title">
        <h2>
          {portal
            ? "Verified customer access requests"
            : "Public service inquiries"}
        </h2>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void act(async () => {})}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!items.length && <p>No requests yet.</p>}
      {items.map((i) => (
        <article className="order" key={i.id}>
          <div>
            <span className="badge">{i.status}</span>
            <h3>{i.name}</h3>
            <p>
              {i.email} · {i.phone}
            </p>
            <p>{i.service_address}</p>
            <p>{i.message || i.review_note}</p>
            {portal && (
              <small>
                Email verified by the identity provider. Existing account links
                must match this address.
              </small>
            )}
          </div>
          {portal && i.status === "pending" && (
            <form
              className="actions"
              onSubmit={(e) => {
                const b = form(e);
                void act(() =>
                  api("/portal/registrations/" + i.id + "/review", {
                    decision: b.decision,
                    review_note: b.review_note,
                    ...(b.customer_id ? { customer_id: b.customer_id } : {}),
                  }),
                );
              }}
            >
              <label>
                Decision
                <select name="decision">
                  <option value="approve">Approve customer access</option>
                  <option value="reject">Reject request</option>
                </select>
              </label>
              <label>
                Customer account
                <select
                  name="customer_id"
                  aria-label={"Customer account for " + i.name}
                >
                  <option value="">Create a new customer after review</option>
                  {customers
                    .filter(
                      (c) =>
                        c.email.toLowerCase() === i.email.toLowerCase() &&
                        c.status === "active",
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Review note
                <input name="review_note" required maxLength={2000} />
              </label>
              <button disabled={busy}>Record access decision</button>
            </form>
          )}
          {!portal && i.status === "open" && (
            <form
              className="actions"
              onSubmit={(e) => {
                const b = form(e);
                void act(() =>
                  api("/inquiries/" + i.id + "/convert", {
                    ...b,
                    customer_id: customerId,
                    price_cents: dollarsToCents(b.price_cents),
                  }),
                );
              }}
            >
              <p className="muted">
                Verify the customer, service location and agreed price before
                scheduling.
              </p>
              <label>
                Customer
                <select
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                >
                  <option value="">Select existing customer</option>
                  {customers
                    .filter((c) => c.status === "active")
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Service location
                <select key={customerId} name="location_id" required>
                  <option value="">Select location</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.address}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Order type
                <select name="kind">
                  <option value="extra_pickup">Extra pickup</option>
                  <option value="pickup">Pickup</option>
                  <option value="delivery">Delivery</option>
                  <option value="bulk">Bulk-item pickup</option>
                </select>
              </label>
              <label>
                Service date
                <input name="scheduled_date" type="date" required />
              </label>
              <label>
                Agreed price ($)
                <input
                  name="price_cents"
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,2})?"
                  required
                />
              </label>
              <button disabled={busy}>Create reviewed service order</button>
            </form>
          )}
        </article>
      ))}
    </section>
  );
}
