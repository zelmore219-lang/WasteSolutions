import { RoadPlanningPanel } from "./road-planning";
import { dollarsToCents } from "./money-input";
import { FormEvent, useEffect, useState } from "react";
import { RouteEditor } from "./route-editor";
type Row = Record<string, any>;
type Props = {
  tab: string;
  actor: Row;
  customers: Row[];
  orders: Row[];
  resources: { drivers: Row[]; trucks: Row[] };
  api: (path: string, body?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
};
export function WorkflowPanel({
  tab,
  actor,
  customers,
  orders,
  resources,
  api,
  refresh,
}: Props) {
  const [mapRoute, setMapRoute] = useState<string | null>(null);
  const [billingMode, setBillingMode] = useState("per_service");
  const [editing, setEditing] = useState<Row | null>(null);
  const [items, setItems] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [customerId, setCustomerId] = useState(actor.customer_id || ""),
    [locations, setLocations] = useState<Row[]>([]);
  const path =
    tab === "Requests"
      ? "/requests"
      : tab === "Routes"
        ? "/routes"
        : "/agreements";
  const office = ["owner", "manager", "dispatcher", "office"].includes(
      actor.role,
    ),
    dispatch = ["owner", "manager", "dispatcher"].includes(actor.role);
  async function load() {
    setItems(await api(path));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [tab, actor]);
  useEffect(() => {
    setLocations([]);
    if (customerId)
      void api(`/customers/${customerId}/locations`)
        .then(setLocations)
        .catch((e) => setError(e.message));
  }, [customerId]);
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
  function body(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  const addressFields = (
    <>
      <label>
        Customer
        <select
          aria-label="Customer"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          required
        >
          <option value="">Select customer</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Service location
        <select
          aria-label="Service location"
          key={customerId}
          name="location_id"
          required
        >
          <option value="">Select location</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.address}
            </option>
          ))}
        </select>
      </label>
    </>
  );
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {mapRoute && (
        <RoadPlanningPanel
          key={mapRoute}
          routeId={mapRoute}
          actor={actor}
          api={api}
          refresh={async () => {
            await refresh();
            await load();
          }}
          close={() => setMapRoute(null)}
        />
      )}
      <section className="panel">
        <div className="section-title">
          <h2>
            {tab === "Requests"
              ? "Customer service queue"
              : tab === "Routes"
                ? "Collection routes"
                : "Recurring service agreements"}
          </h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(async () => {})}
          >
            Refresh
          </button>
        </div>
        {!items.length && <p className="empty">No {tab.toLowerCase()} yet.</p>}
        {items.map((r) => (
          <article key={r.id} className="order">
            <div>
              <span className="badge">{r.status || r.kind || "route"}</span>
              <h3>{r.customer_name || r.name}</h3>
              <p>{r.address || r.service_date}</p>
              <p>{r.description}</p>
              {r.interval_days && (
                <small>
                  Every {r.interval_days} days ·{" "}
                  {"$" +
                    (
                      (r.billing_mode === "monthly"
                        ? r.monthly_rate_cents
                        : r.price_cents) / 100
                    ).toFixed(2)}{" "}
                  {r.billing_mode === "monthly"
                    ? "per month · " +
                      r.billing_cycle_months +
                      "-month " +
                      r.billing_alignment +
                      " cycle · " +
                      (r.billing_timing === "advance"
                        ? "billed in advance"
                        : "billed in arrears")
                    : "per service"}{" "}
                  · Next: {r.next_service_date}
                  {r.contract_end_date && " · Ends: " + r.contract_end_date}
                </small>
              )}
              {r.stops && (
                <ol>
                  {r.stops.map((s: Row) => (
                    <li key={s.id}>
                      <b>{s.customer_name}</b> · {s.address} · {s.status}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            {tab === "Agreements" && office && (
              <details>
                <summary>Change agreement end date</summary>
                <form
                  className="actions"
                  onSubmit={(e) => {
                    const b = body(e);
                    void act(() =>
                      api("/agreements/" + r.id + "/end", {
                        ...b,
                        version: r.version,
                      }),
                    );
                  }}
                >
                  <label>
                    Last service date
                    <input type="date" name="end_date" required />
                  </label>
                  <label>
                    Change reason
                    <input name="reason" required maxLength={2000} />
                  </label>
                  <button disabled={busy}>Save agreement end date</button>
                </form>
              </details>
            )}
            {tab === "Routes" && dispatch && (
              <div className="export-actions">
                <button className="secondary" onClick={() => setMapRoute(r.id)}>
                  Map and road planning
                </button>
                <button className="secondary" onClick={() => setEditing(r)}>
                  Edit route
                </button>
              </div>
            )}
            {tab === "Requests" &&
              office &&
              r.status === "open" &&
              r.kind !== "support" && (
                <form
                  className="actions"
                  onSubmit={(e) => {
                    const b = body(e);
                    void act(() =>
                      api(`/requests/${r.id}/convert`, {
                        ...b,
                        price_cents: dollarsToCents(b.price_cents),
                      }),
                    );
                  }}
                >
                  <label>
                    Service date
                    <input type="date" name="scheduled_date" required />
                  </label>
                  <label>
                    Agreed price ($)
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      name="price_cents"
                      required
                    />
                  </label>
                  <button disabled={busy}>Create service order</button>
                </form>
              )}
          </article>
        ))}
      </section>
      {editing && (
        <RouteEditor
          key={editing.id + ":" + editing.version}
          route={editing}
          orders={orders}
          resources={resources}
          cancel={() => setEditing(null)}
          save={async (body) => {
            await api(`/routes/${editing.id}/update`, body);
            await refresh();
            await load();
            setEditing(null);
          }}
        />
      )}
      {tab === "Requests" && (
        <section className="panel">
          <h2>Submit service request</h2>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = body(e);
              void act(() =>
                api("/requests", { ...b, customer_id: customerId }),
              );
            }}
          >
            {addressFields}
            <label>
              Request type
              <select name="kind">
                {[
                  "extra_pickup",
                  "bulk",
                  "delivery",
                  "missed_pickup",
                  "support",
                ].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              Description
              <input name="description" required maxLength={2000} />
            </label>
            <button disabled={busy}>Submit request</button>
          </form>
        </section>
      )}
      {tab === "Routes" && dispatch && (
        <section className="panel">
          <h2>Create collection route</h2>
          <p className="muted">
            Select unassigned stops for the same date. Stop order follows the
            order shown. Use the route editor to reorder stops or change
            assignments. Road optimization requires a connected routing
            provider.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(() =>
                api("/routes", {
                  name: f.get("name"),
                  service_date: f.get("service_date"),
                  driver_id: f.get("driver_id"),
                  truck_id: f.get("truck_id"),
                  order_ids: f.getAll("order_ids"),
                }),
              );
            }}
          >
            <div className="grid">
              <label>
                Route name
                <input name="name" required maxLength={200} />
              </label>
              <label>
                Service date
                <input name="service_date" type="date" required />
              </label>
              <label>
                Driver
                <select name="driver_id" required>
                  <option value="">Choose driver</option>
                  {resources.drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Truck
                <select name="truck_id" required>
                  <option value="">Choose truck</option>
                  {resources.trucks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.number}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset>
              <legend>Stops</legend>
              {orders
                .filter((o) => o.status === "new")
                .map((o) => (
                  <label className="check" key={o.id}>
                    <input type="checkbox" name="order_ids" value={o.id} />
                    {o.customer_name} · {o.address} ·{" "}
                    {o.scheduled_date.slice(0, 10)}
                  </label>
                ))}
            </fieldset>
            <button disabled={busy}>Create route and assign stops</button>
          </form>
        </section>
      )}
      {tab === "Agreements" && office && (
        <>
          <section className="panel">
            <h2>New recurring service agreement</h2>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = body(e);
                void act(() =>
                  api("/agreements", {
                    ...b,
                    customer_id: customerId,
                    price_cents:
                      billingMode === "monthly"
                        ? 0
                        : dollarsToCents(b.price_cents),
                    monthly_rate_cents:
                      billingMode === "monthly"
                        ? dollarsToCents(b.price_cents)
                        : undefined,
                    contract_end_date: b.contract_end_date || undefined,
                    billing_alignment:
                      billingMode === "monthly"
                        ? b.billing_alignment
                        : undefined,
                    billing_timing:
                      billingMode === "monthly" ? b.billing_timing : undefined,
                    billing_cycle_months:
                      billingMode === "monthly"
                        ? Number(b.billing_cycle_months)
                        : undefined,
                    interval_days: Number(b.interval_days),
                  }),
                );
              }}
            >
              {addressFields}
              <label>
                Service type
                <select name="kind">
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                </select>
              </label>
              <label>
                {billingMode === "monthly"
                  ? "Monthly contract rate ($)"
                  : "Price per service ($)"}
                <input
                  type="number"
                  name="price_cents"
                  min="0"
                  max="1000000"
                  step="0.01"
                  required
                />
              </label>
              <label>
                Interval in days
                <input
                  type="number"
                  name="interval_days"
                  min="1"
                  max="366"
                  step="1"
                  defaultValue="7"
                  required
                />
              </label>
              <label>
                Billing schedule
                <select
                  aria-label="Billing schedule"
                  name="billing_mode"
                  value={billingMode}
                  onChange={(e) => setBillingMode(e.target.value)}
                >
                  <option value="per_service">Each completed service</option>
                  <option value="monthly">Monthly contract</option>
                </select>
              </label>
              {billingMode === "monthly" && (
                <>
                  <label>
                    Contract billing timing
                    <select
                      name="billing_timing"
                      aria-label="Contract billing timing"
                    >
                      <option value="arrears">
                        Arrears · after verified service
                      </option>
                      <option value="advance">
                        Advance · when coverage starts
                      </option>
                    </select>
                  </label>
                  <label>
                    Contract billing alignment
                    <select
                      name="billing_alignment"
                      aria-label="Contract billing alignment"
                    >
                      <option value="calendar">Calendar month boundary</option>
                      <option value="anniversary">
                        Contract anniversary day
                      </option>
                    </select>
                  </label>
                  <label>
                    Contract billing cycle
                    <select
                      name="billing_cycle_months"
                      aria-label="Contract billing cycle"
                    >
                      <option value="1">Monthly · 1 monthly base rate</option>
                      <option value="3">
                        Quarterly · 3 monthly base rates
                      </option>
                      <option value="12">Annual · 12 monthly base rates</option>
                    </select>
                  </label>
                </>
              )}
              <label>
                First service date
                <input type="date" name="next_service_date" required />
              </label>
              <label>
                Last service date (optional)
                <input name="contract_end_date" type="date" />
              </label>
              {billingMode === "monthly" && (
                <p className="muted">
                  Arrears contracts bill after the period closes and every visit
                  is complete. Advance contracts bill when coverage starts;
                  charges stay in deferred revenue until the period closes and
                  service is verified. Full periods charge the monthly base rate
                  times the selected months. Partial periods prorate by active
                  calendar days in that full period. Anniversary dates retain
                  their original day after short months. Failed or unresolved
                  visits block arrears billing and advance revenue recognition.
                  Shortening prepaid coverage requires finance to credit the
                  unused coverage first.
                </p>
              )}
              <button disabled={busy}>Create agreement</button>
            </form>
          </section>
          <section className="panel">
            <h2>Generate scheduled orders</h2>
            <p className="muted">
              Creates service orders for active agreements through the selected
              date. Each-service agreements bill completed visits. Monthly
              contracts bill by their agreed period and timing through Scheduled
              work.
            </p>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = body(e);
                void act(() => api("/agreements/generate", b));
              }}
            >
              <label>
                Through date
                <input type="date" name="through_date" required />
              </label>
              <button disabled={busy}>Generate service orders</button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
