import { FormEvent, useEffect, useState } from "react";
type Row = Record<string, any>;
type Props = {
  actor: Row;
  customers: Row[];
  api: (p: string, b?: unknown) => Promise<any>;
};
function form(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget));
}
function cents(v: unknown) {
  const s = String(v || "");
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw Error("Enter a dollar amount with up to two decimal places");
  const [d, f = ""] = s.split(".");
  return Number(d) * 100 + Number(f.padEnd(2, "0"));
}
export function StationPanel({ actor, customers, api }: Props) {
  const [stockAccounts, setStockAccounts] = useState<Row[]>([]),
    [stockMaterial, setStockMaterial] = useState("");
  const [tickets, setTickets] = useState<Row[]>([]),
    [materials, setMaterials] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [report, setReport] = useState<Row | null>(null);
  const office = ["owner", "manager", "dispatcher", "office"].includes(
      actor.role,
    ),
    finance = ["owner", "manager", "accountant"].includes(actor.role);
  async function load() {
    setTickets(await api("/station/tickets"));
    setMaterials(await api("/station/materials"));
    setStockAccounts(await api("/stock/materials"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [actor]);
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
  return (
    <>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <section className="panel">
        <div className="section-title">
          <h2>Transfer station scale tickets</h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(async () => {})}
          >
            Refresh
          </button>
        </div>
        {!tickets.length && <p className="empty">No scale tickets yet.</p>}
        {tickets.map((t) => (
          <article className="order" key={t.id}>
            <div>
              <span className="badge">
                {t.status} · {t.direction}
              </span>
              <h3>
                Ticket {t.number} · {t.customer_name}
              </h3>
              <p>
                {t.vehicle_number} · {t.material_name}
              </p>
              <small>
                Gross: {t.gross_kg ?? "Pending"} kg · Tare:{" "}
                {t.tare_kg ?? "Pending"} kg · Net: {t.net_kg ?? "Pending"} kg
              </small>
              <small>Manual source: {t.source_reference}</small>
              <small>
                Material stock: {t.stock_site_name || "untracked ticket"}
              </small>
            </div>
            <div className="actions">
              {office && t.status === "open" && (
                <form
                  onSubmit={(e) => {
                    const b = form(e);
                    void act(() =>
                      api(`/station/tickets/${t.id}/weigh`, {
                        second_weight_kg: Number(b.second_weight_kg),
                        version: t.version,
                      }),
                    );
                  }}
                >
                  <label>
                    {t.direction === "inbound"
                      ? "Outbound tare weight (kg)"
                      : "Outbound gross weight (kg)"}
                    <input
                      type="number"
                      name="second_weight_kg"
                      min="0"
                      max="1000000"
                      step="1"
                      required
                    />
                  </label>
                  <button disabled={busy}>Record second weighing</button>
                </form>
              )}
              {finance && t.status === "weighed" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() => api(`/station/tickets/${t.id}/invoice`, {}))
                  }
                >
                  Generate disposal invoice
                </button>
              )}
            </div>
          </article>
        ))}
      </section>
      {office && (
        <section className="panel">
          <h2>Open manual scale ticket</h2>
          <p className="muted">
            Enter a verified scale reading in kilograms. This form does not
            connect to scale hardware.
          </p>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = form(e);
              void act(() =>
                api("/station/tickets", {
                  ...b,
                  first_weight_kg: Number(b.first_weight_kg),
                  stock_account_id: b.stock_account_id || undefined,
                }),
              );
            }}
          >
            <label>
              Customer
              <select name="customer_id" required aria-label="Scale customer">
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
              Material
              <select
                name="material_id"
                required
                aria-label="Material"
                value={stockMaterial}
                onChange={(e) => setStockMaterial(e.target.value)}
              >
                <option value="">Select material</option>
                {materials
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Movement
              <select name="direction">
                <option value="inbound">Inbound load (gross first)</option>
                <option value="outbound">Outbound material (tare first)</option>
              </select>
            </label>
            <label>
              Vehicle number
              <input name="vehicle_number" required />
            </label>
            <label>
              First weight (kg)
              <input
                type="number"
                name="first_weight_kg"
                step="1"
                min="0"
                max="1000000"
                required
              />
            </label>
            <label>
              Material stock site
              <select
                key={stockMaterial}
                name="stock_account_id"
                aria-label="Material stock site"
              >
                <option value="">
                  Untracked ticket — no material stock movement
                </option>
                {stockAccounts
                  .filter((a) => a.active && a.material_id === stockMaterial)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.site_name} · {Number(a.balance_kg).toLocaleString()} kg
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Scale reference / operator attestation
              <input name="source_reference" required />
            </label>
            <button disabled={busy}>Open scale ticket</button>
          </form>
        </section>
      )}
      {finance && (
        <>
          <section className="panel">
            <h2>Material pricing</h2>
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Category</th>
                  <th>Rate / metric tonne</th>
                  <th>Minimum</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.category}</td>
                    <td>${(m.rate_cents_per_tonne / 100).toFixed(2)}</td>
                    <td>${(m.minimum_charge_cents / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>Add material</h3>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = form(e);
                void act(() =>
                  api("/station/materials", {
                    ...b,
                    rate_cents_per_tonne: cents(b.rate_cents_per_tonne),
                    minimum_charge_cents: cents(b.minimum_charge_cents),
                  }),
                );
              }}
            >
              <label>
                Material name
                <input name="name" required />
              </label>
              <label>
                Category
                <select name="category">
                  {[
                    "landfill",
                    "recycling",
                    "green_waste",
                    "construction",
                    "metal",
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Rate per metric tonne ($)
                <input
                  name="rate_cents_per_tonne"
                  inputMode="decimal"
                  required
                />
              </label>
              <label>
                Minimum charge ($)
                <input
                  name="minimum_charge_cents"
                  inputMode="decimal"
                  defaultValue="0"
                  required
                />
              </label>
              <button disabled={busy}>Add material</button>
            </form>
          </section>
          <section className="panel">
            <h2>Daily reconciliation</h2>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = form(e);
                void act(async () => {
                  setReport(
                    await api(`/station/reconciliation?date=${b.date}`),
                  );
                });
              }}
            >
              <label>
                Business date
                <input type="date" name="date" required />
              </label>
              <button disabled={busy}>Reconcile day</button>
            </form>
            {report && (
              <>
                <h3>Material movements</h3>
                {report.tonnage.map((r: Row, i: number) => (
                  <p key={i}>
                    {r.category} · {r.direction} · {r.net_kg} kg · {r.tickets}{" "}
                    tickets
                  </p>
                ))}
                <h3>Recorded receipts</h3>
                {report.receipts.map((r: Row, i: number) => (
                  <p key={i}>
                    {r.method} · ${(Number(r.amount_cents) / 100).toFixed(2)} ·{" "}
                    {r.receipts} receipts
                  </p>
                ))}
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
