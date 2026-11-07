import { FormEvent, useEffect, useState } from "react";
type Row = Record<string, any>;
type Props = {
  tab: string;
  actor: Row;
  customers: Row[];
  api: (path: string, body?: unknown) => Promise<any>;
};
function cents(value: FormDataEntryValue | undefined) {
  const s = String(value || "");
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw Error("Enter a dollar amount with up to two decimal places");
  const [d, f = ""] = s.split(".");
  const n = Number(d) * 100 + Number(f.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n > 100000000)
    throw Error("Amount exceeds supported limit");
  return n;
}
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
function fields(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget));
}
export function RentalsPanel({ tab, actor, customers, api }: Props) {
  const [yards, setYards] = useState<Row[]>([]);
  const [items, setItems] = useState<Row[]>([]),
    [containers, setContainers] = useState<Row[]>([]),
    [detail, setDetail] = useState<Row | null>(null),
    [locations, setLocations] = useState<Row[]>([]),
    [customer, setCustomer] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const office = ["owner", "manager", "dispatcher", "office"].includes(
      actor.role,
    ),
    finance = ["owner", "manager", "accountant"].includes(actor.role),
    inventory = ["owner", "manager", "dispatcher"].includes(actor.role);
  async function load() {
    setItems(await api(tab === "Containers" ? "/containers" : "/rentals"));
    if (office) {
      setContainers(await api("/containers"));
      setYards(await api("/equipment/yards"));
    }
    if (detail) setDetail(await api("/rentals/" + detail.id));
  }
  useEffect(() => {
    setDetail(null);
  }, [tab, actor.id]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [tab, actor]);
  useEffect(() => {
    setLocations([]);
    if (customer)
      void api(`/customers/${customer}/locations`)
        .then(setLocations)
        .catch((e) => setError(e.message));
  }, [customer]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      if (detail) setDetail(await api(`/rentals/${detail.id}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const containerSelect = (name: string) => (
    <label>
      Container
      <select name={name} required>
        <option value="">Select container</option>
        {containers
          .filter(
            (c) =>
              c.kind === "roll_off" &&
              !["maintenance", "retired", "awaiting_disposal"].includes(
                c.status,
              ),
          )
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.number} · {c.capacity_yards} yd³ · {c.status}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <section className="panel">
        <div className="section-title">
          <h2>
            {tab === "Containers" ? "Equipment inventory" : "Roll-off rentals"}
          </h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(async () => {})}
          >
            Refresh
          </button>
        </div>
        {items.length === 0 ? (
          <p className="empty">No {tab.toLowerCase()} yet.</p>
        ) : tab === "Containers" ? (
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Type</th>
                <th>Capacity</th>
                <th>Status</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>{c.number}</td>
                  <td>{c.kind}</td>
                  <td>{c.capacity_yards} yd³</td>
                  <td>
                    <span className="badge">{c.status}</span>
                  </td>
                  <td>
                    {c.status === "awaiting_disposal"
                      ? "Loaded — disposal pending"
                      : c.status === "on_truck"
                        ? "Truck " + c.carrier_number
                        : c.address || c.yard_name || "Unspecified yard"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Container</th>
                <th>Delivery / pickup</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.customer_name}
                    <small>{r.address}</small>
                  </td>
                  <td>{r.container_number}</td>
                  <td>
                    {r.start_date}
                    <small>{r.pickup_date}</small>
                  </td>
                  <td>
                    <span className="badge">{r.status}</span>
                  </td>
                  <td>
                    <button
                      className="secondary"
                      onClick={() =>
                        void act(async () => {
                          setDetail(await api(`/rentals/${r.id}`));
                        })
                      }
                    >
                      Open rental
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {tab === "Containers" && inventory && (
        <section className="panel">
          <h2>Add equipment</h2>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(() =>
                api("/containers", {
                  ...b,
                  capacity_yards: Number(b.capacity_yards),
                  yard_id: b.yard_id || undefined,
                }),
              );
            }}
          >
            <label>
              Container number
              <input name="number" maxLength={80} required />
            </label>
            <label>
              Type
              <select name="kind">
                <option value="roll_off">Roll-off</option>
                <option value="commercial">Commercial</option>
                <option value="cart">Residential cart</option>
                <option value="trailer">Trailer</option>
              </select>
            </label>
            <label>
              Capacity (cubic yards)
              <input
                name="capacity_yards"
                type="number"
                min="0.01"
                max="1000"
                step="0.01"
                required
              />
            </label>
            <label>
              Initial equipment yard
              <select name="yard_id" aria-label="Initial equipment yard">
                <option value="">Unspecified yard — reconcile later</option>
                {yards
                  .filter((y) => y.active)
                  .map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name}
                    </option>
                  ))}
              </select>
            </label>
            <button disabled={busy}>Add equipment</button>
          </form>
        </section>
      )}
      {tab === "Rentals" && office && (
        <section className="panel">
          <h2>Reserve a roll-off container</h2>
          <p className="muted">
            A reservation includes the pickup day. Conflicting bookings are
            rejected before any orders are created.
          </p>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(() =>
                api("/rentals", {
                  ...b,
                  customer_id: customer,
                  base_price_cents: cents(b.base_price_cents),
                  extension_daily_cents: cents(b.extension_daily_cents),
                  included_weight_kg: Number(b.included_weight_kg),
                  overweight_cents_per_tonne: cents(
                    b.overweight_cents_per_tonne,
                  ),
                }),
              );
            }}
          >
            <label>
              Customer
              <select
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                required
              >
                <option value="">Select customer</option>
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
              <select key={customer} name="location_id" required>
                <option value="">Select location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.address}
                  </option>
                ))}
              </select>
            </label>
            {containerSelect("container_id")}
            <label>
              Delivery date
              <input type="date" name="start_date" required />
            </label>
            <label>
              Pickup date
              <input type="date" name="pickup_date" required />
            </label>
            <label>
              Base rental price ($)
              <input
                name="base_price_cents"
                inputMode="decimal"
                pattern="[0-9]+(\.[0-9]{1,2})?"
                required
              />
            </label>
            <label>
              Extension per day ($)
              <input
                name="extension_daily_cents"
                inputMode="decimal"
                defaultValue="0"
                required
              />
            </label>
            <label>
              Included disposal weight (kg)
              <input
                type="number"
                min="0"
                max="10000000"
                step="1"
                name="included_weight_kg"
                defaultValue="0"
                required
              />
            </label>
            <label>
              Overweight per metric tonne ($)
              <input
                name="overweight_cents_per_tonne"
                inputMode="decimal"
                defaultValue="0"
                required
              />
            </label>
            <button disabled={busy}>Reserve and create service orders</button>
          </form>
        </section>
      )}
      {detail && (
        <section className="panel">
          <div className="section-title">
            <h2>
              {detail.customer_name} · {detail.container_number}
            </h2>
            <button className="secondary" onClick={() => setDetail(null)}>
              Close details
            </button>
          </div>
          <p>
            {detail.address} · {detail.start_date} → {detail.pickup_date} ·{" "}
            <span className="badge">{detail.status}</span>
          </p>
          <p>
            Base price {money(detail.base_price_cents)} · Extension{" "}
            {money(detail.extension_daily_cents)}/day · Included{" "}
            {detail.included_weight_kg} kg · Overweight{" "}
            {money(detail.overweight_cents_per_tonne)}/metric tonne
          </p>
          <h3>Connected service orders</h3>
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Scheduled</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {detail.jobs.map((j: Row) => (
                <tr key={j.order_id}>
                  <td>{j.action}</td>
                  <td>{j.scheduled_date}</td>
                  <td>{j.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Container movement history</h3>
          {detail.movements.length === 0 ? (
            <p>No completed movements.</p>
          ) : (
            detail.movements.map((m: Row) => (
              <p key={m.id}>
                {m.service_date} · {m.number} · {m.action}
              </p>
            ))
          )}
          <h3>Disposal tickets</h3>
          {detail.tickets.length === 0 ? (
            <p>No disposal tickets recorded.</p>
          ) : (
            detail.tickets.map((t: Row) => (
              <p key={t.id}>
                {t.facility} / {t.ticket_number} · Gross {t.gross_kg} kg − tare{" "}
                {t.tare_kg} kg = {t.net_kg} kg · Cost{" "}
                {money(t.disposal_cost_cents)}
              </p>
            ))
          )}
          {office && ["reserved", "delivered"].includes(detail.status) && (
            <form
              className="grid"
              onSubmit={(e) => {
                const b = fields(e);
                void act(() =>
                  api(`/rentals/${detail.id}/extend`, {
                    ...b,
                    version: detail.version,
                  }),
                );
              }}
            >
              <label>
                Extend pickup date
                <input
                  type="date"
                  name="pickup_date"
                  min={detail.pickup_date}
                  required
                />
              </label>
              <button disabled={busy}>Extend rental</button>
            </form>
          )}
          {office && detail.status === "delivered" && (
            <>
              <h3>Schedule exchange</h3>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api(`/rentals/${detail.id}/exchange`, {
                      ...b,
                      version: detail.version,
                    }),
                  );
                }}
              >
                {containerSelect("replacement_container_id")}
                <label>
                  Exchange date
                  <input
                    type="date"
                    name="service_date"
                    min={detail.start_date}
                    max={detail.pickup_date}
                    required
                  />
                </label>
                <button disabled={busy}>Create exchange order</button>
              </form>
            </>
          )}
          {office && detail.status === "reserved" && (
            <>
              <h3>Cancel undelivered rental</h3>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api(`/rentals/${detail.id}/cancel`, {
                      ...b,
                      version: detail.version,
                    }),
                  );
                }}
              >
                <label>
                  Cancellation reason
                  <input name="reason" required maxLength={2000} />
                </label>
                <button className="secondary" disabled={busy}>
                  Cancel reservation
                </button>
              </form>
            </>
          )}
          {(office || finance) &&
            ["delivered", "collected"].includes(detail.status) && (
              <>
                <h3>Record disposal ticket</h3>
                <form
                  className="grid"
                  onSubmit={(e) => {
                    const b = fields(e);
                    void act(() =>
                      api(`/rentals/${detail.id}/disposal`, {
                        ...b,
                        gross_kg: Number(b.gross_kg),
                        tare_kg: Number(b.tare_kg),
                        disposal_cost_cents: cents(b.disposal_cost_cents),
                      }),
                    );
                  }}
                >
                  <label>
                    Completed collection
                    <select name="order_id" required>
                      <option value="">
                        Select completed pickup or exchange
                      </option>
                      {detail.jobs
                        .filter(
                          (j: Row) =>
                            ["pickup", "exchange"].includes(j.action) &&
                            j.status === "completed" &&
                            !detail.tickets.some(
                              (t: Row) => t.order_id === j.order_id,
                            ),
                        )
                        .map((j: Row) => (
                          <option key={j.order_id} value={j.order_id}>
                            {j.action} · {j.scheduled_date}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Facility
                    <input name="facility" required />
                  </label>
                  <label>
                    Ticket number
                    <input name="ticket_number" required />
                  </label>
                  <label>
                    Gross weight (kg)
                    <input
                      type="number"
                      step="1"
                      min="1"
                      max="1000000"
                      name="gross_kg"
                      required
                    />
                  </label>
                  <label>
                    Tare weight (kg)
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="1000000"
                      name="tare_kg"
                      required
                    />
                  </label>
                  <label>
                    Disposal cost ($)
                    <input
                      name="disposal_cost_cents"
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <button disabled={busy}>Record ticket</button>
                </form>
              </>
            )}
          {finance && detail.status === "collected" && (
            <button
              disabled={busy}
              onClick={() =>
                void act(() => api(`/rentals/${detail.id}/invoice`, {}))
              }
            >
              Generate final rental invoice
            </button>
          )}
        </section>
      )}
    </>
  );
}
