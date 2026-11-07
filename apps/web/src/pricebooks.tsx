import { FeePicker, FeePoliciesPanel } from "./service-fees";
import { FormEvent, useEffect, useRef, useState } from "react";
import { dollarsToCents } from "./money-input";
type Row = Record<string, any>;
type Api = (path: string, body?: unknown) => Promise<any>;
const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export function PricebooksPanel({
  actor,
  customers,
  api,
  refresh,
}: {
  actor: Row;
  customers: Row[];
  api: Api;
  refresh: () => Promise<void>;
}) {
  const [customer, setCustomer] = useState(""),
    [rates, setRates] = useState<Row[]>([]),
    [locations, setLocations] = useState<Row[]>([]),
    [editing, setEditing] = useState<Row | null>(null),
    [quote, setQuote] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const sequence = useRef(0),
    canEdit = ["owner", "manager", "accountant"].includes(actor.role),
    canOrder = ["owner", "manager", "dispatcher", "office"].includes(
      actor.role,
    );
  async function load(id = customer) {
    const request = ++sequence.current;
    if (!id) {
      setRates([]);
      setLocations([]);
      return;
    }
    const [rates, locations] = await Promise.all([
      api("/customers/" + id + "/pricebooks"),
      api("/customers/" + id + "/locations"),
    ]);
    if (sequence.current === request) {
      setRates(rates);
      setLocations(locations);
    }
  }
  useEffect(() => {
    setRates([]);
    setLocations([]);
    setEditing(null);
    setQuote(null);
    setNotice("");
    setError("");
    void load(customer).catch((e) => setError(e.message));
    return () => {
      sequence.current++;
    };
  }, [customer]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
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
  function fields(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  function rateFields(b: Record<string, FormDataEntryValue>) {
    return {
      name: b.name,
      description: b.description,
      price_cents: dollarsToCents(b.price_cents),
      effective_from: b.effective_from,
      effective_to: b.effective_to || null,
      active: b.active === "on",
    };
  }
  return (
    <>
      <section className="panel">
        <div className="section-title">
          <h2>Customer service rates</h2>
          <button
            className="secondary"
            disabled={busy || !customer}
            onClick={() =>
              void act(async () => {
                setQuote(null);
                setEditing(null);
              })
            }
          >
            Refresh rates
          </button>
        </div>
        <p>
          Reusable per-service quotes. Selecting a rate copies its agreed price
          and terms to a new order. Later rate changes do not reprice existing
          orders, including rescheduled work. Monthly contracts and roll-off
          rental packages use their own billing workflows.
        </p>
        <label>
          Pricing customer
          <select
            aria-label="Pricing customer"
            value={customer}
            disabled={busy}
            onChange={(e) => setCustomer(e.target.value)}
          >
            <option value="">Choose a customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === "suspended" ? " · suspended" : ""}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {customer && (
          <>
            <p className="muted">
              Rate selection is explicit. Overlapping rates are shown for office
              review; no rate is silently substituted.{" "}
              {rates.length >= 500 ? "Showing the first 500 rates." : ""}
            </p>
            {!rates.length && <p>No saved rates for this customer.</p>}
            {rates.map((rate) => (
              <article className="order" key={rate.id}>
                <div>
                  <h3>
                    {rate.name} · {money(rate.price_cents)}
                  </h3>
                  <p>
                    {rate.kind} · {rate.address || "All customer locations"} ·{" "}
                    {rate.effective_from} through{" "}
                    {rate.effective_to || "open ended"} ·{" "}
                    {rate.active ? "active" : "inactive"}
                  </p>
                  <p>{rate.description}</p>
                </div>
                <div className="export-actions">
                  {canEdit && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setEditing(rate);
                        setQuote(null);
                      }}
                    >
                      Edit customer rate
                    </button>
                  )}
                  {canOrder && rate.active && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setQuote(rate);
                        setEditing(null);
                      }}
                    >
                      Create order at this rate
                    </button>
                  )}
                </div>
              </article>
            ))}
          </>
        )}
      </section>
      {quote && (
        <section className="panel">
          <div className="section-title">
            <h2>Quoted service · {quote.name}</h2>
            <button className="secondary" onClick={() => setQuote(null)}>
              Close quote
            </button>
          </div>
          <p>
            {money(quote.price_cents)} per {quote.kind} · rate version{" "}
            {quote.version}
          </p>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(async () => {
                const order = await api("/orders", {
                  customer_id: customer,
                  location_id: b.location_id,
                  kind: quote.kind,
                  scheduled_date: b.scheduled_date,
                  instructions: b.instructions,
                  price_cents: quote.price_cents,
                  pricebook_id: quote.id,
                  pricebook_version: quote.version,
                  fee_policies: JSON.parse(String(b.fee_policies || "[]")),
                });
                setQuote(null);
                setNotice(
                  "Created order CW-O" +
                    String(order.number).padStart(6, "0") +
                    " at " +
                    money(order.price_cents + (order.fee_total_cents || 0)),
                );
              });
            }}
          >
            <label>
              Quoted service location
              <select
                name="location_id"
                aria-label="Quoted service location"
                required
                defaultValue={quote.location_id || ""}
              >
                <option value="">Choose a service location</option>
                {locations
                  .filter(
                    (l) => !quote.location_id || l.id === quote.location_id,
                  )
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.address}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Quoted service date
              <input
                name="scheduled_date"
                type="date"
                min={quote.effective_from}
                max={quote.effective_to || undefined}
                required
              />
            </label>
            <label>
              Quoted service instructions
              <input name="instructions" maxLength={2000} />
            </label>
            <FeePicker
              customerId={customer}
              api={api}
              baseCents={quote.price_cents}
            />
            <button disabled={busy}>Create quoted service order</button>
          </form>
        </section>
      )}
      {customer && canEdit && (
        <section className="panel">
          <div className="section-title">
            <h2>{editing ? "Edit customer rate" : "Add customer rate"}</h2>
            {editing && (
              <button className="secondary" onClick={() => setEditing(null)}>
                Cancel rate edit
              </button>
            )}
          </div>
          <form
            key={
              customer +
              ":" +
              (editing?.id || "new") +
              ":" +
              (editing?.version || 0)
            }
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(async () => {
                if (editing)
                  await api("/pricebooks/" + editing.id + "/update", {
                    ...rateFields(b),
                    version: editing.version,
                    reason: b.reason,
                  });
                else
                  await api("/pricebooks", {
                    ...rateFields(b),
                    customer_id: customer,
                    location_id: b.location_id || null,
                    kind: b.kind,
                  });
                setEditing(null);
                setNotice(
                  "Customer rate saved. Existing agreed order prices are unchanged.",
                );
              });
            }}
          >
            <label>
              Rate name
              <input
                name="name"
                maxLength={200}
                required
                defaultValue={editing?.name || ""}
              />
            </label>
            {!editing && (
              <>
                <label>
                  Rate service
                  <select name="kind" aria-label="Rate service">
                    {[
                      "pickup",
                      "delivery",
                      "exchange",
                      "relocation",
                      "live_load",
                      "extra_pickup",
                      "bulk",
                      "disposal",
                      "recurring",
                    ].map((kind) => (
                      <option key={kind}>{kind}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Rate location
                  <select name="location_id" aria-label="Rate location">
                    <option value="">All customer locations</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.address}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>
              Rate amount ($)
              <input
                name="price_cents"
                inputMode="decimal"
                required
                defaultValue={
                  editing ? (editing.price_cents / 100).toFixed(2) : ""
                }
              />
            </label>
            <label>
              Rate effective from
              <input
                name="effective_from"
                type="date"
                required
                defaultValue={editing?.effective_from || ""}
              />
            </label>
            <label>
              Rate effective through
              <input
                name="effective_to"
                type="date"
                defaultValue={editing?.effective_to || ""}
              />
            </label>
            <label>
              Customer-facing rate terms
              <textarea
                name="description"
                maxLength={2000}
                defaultValue={editing?.description || ""}
              />
            </label>
            <label>
              <input
                name="active"
                type="checkbox"
                defaultChecked={editing?.active ?? true}
              />
              Rate active for new orders
            </label>
            {editing && (
              <label>
                Reason for rate change
                <input name="reason" maxLength={2000} required />
              </label>
            )}
            <button disabled={busy}>Save customer rate</button>
          </form>
        </section>
      )}
      {customer && (
        <FeePoliciesPanel
          key={customer}
          customerId={customer}
          api={api}
          canEdit={canEdit}
        />
      )}
    </>
  );
}
