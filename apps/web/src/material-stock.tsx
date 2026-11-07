import { FormEvent, useEffect, useState } from "react";
type Row = Record<string, any>;
type Api = (path: string, body?: unknown) => Promise<any>;
export function MaterialStockPanel({ actor, api }: { actor: Row; api: Api }) {
  const [accounts, setAccounts] = useState<Row[]>([]),
    [materials, setMaterials] = useState<Row[]>([]),
    [detail, setDetail] = useState<Row | null>(null),
    [from, setFrom] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const canEdit = ["owner", "manager", "dispatcher"].includes(actor.role);
  async function load() {
    const [rows, materials] = await Promise.all([
      api("/stock/materials"),
      api("/station/materials"),
    ]);
    setAccounts(rows);
    setMaterials(materials);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [actor.id]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      if (detail) setDetail(await api("/stock/materials/" + detail.id));
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
  async function view(id: string) {
    setBusy(true);
    setError("");
    try {
      setDetail(await api("/stock/materials/" + id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const source = accounts.find((a) => a.id === from);
  return (
    <>
      <section className="panel">
        <div className="section-title">
          <h2>Material stock by site</h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(async () => {})}
          >
            Refresh stock
          </button>
        </div>
        <p>
          Quantities are kilograms. Stock starts with a reviewed physical count.
          Scale tickets move stock only when a stock site is explicitly selected
          and both readings are completed. Earlier and untracked tickets are not
          added retrospectively.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {accounts.length >= 500 && <p>Showing the first 500 stock accounts.</p>}
        {!accounts.length && <p>No material stock accounts yet.</p>}
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Material</th>
              <th>Stock kg</th>
              <th>History</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.site_name}</td>
                <td>{a.material_name}</td>
                <td>{Number(a.balance_kg).toLocaleString()}</td>
                <td>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void view(a.id)}
                  >
                    Review stock
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {detail && (
        <section className="panel">
          <div className="section-title">
            <h2>
              Stock history · {detail.site_name} · {detail.material_name}
            </h2>
            <button className="secondary" onClick={() => setDetail(null)}>
              Close stock history
            </button>
          </div>
          <p>
            Current stock {Number(detail.balance_kg).toLocaleString()} kg ·
            version {detail.version}
          </p>
          <table>
            <thead>
              <tr>
                <th>Recorded</th>
                <th>Movement</th>
                <th>Change kg</th>
                <th>Balance kg</th>
                <th>Reference / reason</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {detail.movements.map((m: Row) => (
                <tr key={m.id}>
                  <td>{new Date(m.recorded_at).toLocaleString()}</td>
                  <td>{m.kind}</td>
                  <td>{Number(m.delta_kg).toLocaleString()}</td>
                  <td>{Number(m.balance_after_kg).toLocaleString()}</td>
                  <td>
                    {m.scale_ticket_number
                      ? "Scale " + m.scale_ticket_number + " · "
                      : ""}
                    {m.transfer_id ? "Transfer " + m.transfer_id + " · " : ""}
                    {m.reason}
                  </td>
                  <td>{m.recorded_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Latest 100 immutable movements. Stock movements do not create
            accounting entries.
          </p>
          {canEdit && (
            <form
              className="grid"
              key={detail.id + ":" + detail.version}
              onSubmit={(e) => {
                const b = fields(e);
                void act(() =>
                  api("/stock/materials/" + detail.id + "/count", {
                    counted_kg: Number(b.counted_kg),
                    version: detail.version,
                    reason: b.reason,
                  }),
                );
              }}
            >
              <h3>Reconcile a physical count</h3>
              <label>
                Verified counted stock (kg)
                <input
                  name="counted_kg"
                  type="number"
                  min="0"
                  max="1000000000000"
                  required
                />
              </label>
              <label>
                Stock count reason
                <input name="reason" maxLength={2000} required />
              </label>
              <p>
                Any stock movement since this version was loaded blocks the
                count. Refresh and reconcile the measured quantity before
                retrying.
              </p>
              <button disabled={busy}>Record physical stock count</button>
            </form>
          )}
        </section>
      )}
      {canEdit && (
        <>
          <section className="panel">
            <h2>Open material stock account</h2>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = fields(e);
                void act(() =>
                  api("/stock/materials", {
                    material_id: b.material_id,
                    site_name: b.site_name,
                    opening_kg: Number(b.opening_kg),
                    reason: b.reason,
                  }),
                );
              }}
            >
              <label>
                Stock material
                <select name="material_id" aria-label="Stock material" required>
                  <option value="">Choose an active material</option>
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
                Stock site or bin name
                <input name="site_name" maxLength={120} required />
              </label>
              <label>
                Verified opening stock (kg)
                <input
                  name="opening_kg"
                  type="number"
                  min="0"
                  max="1000000000000"
                  required
                />
              </label>
              <label>
                Opening count source
                <input name="reason" maxLength={2000} required />
              </label>
              <button disabled={busy}>Open stock account</button>
            </form>
          </section>
          <section className="panel">
            <h2>Transfer material between sites</h2>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = fields(e),
                  target = accounts.find((a) => a.id === b.to_id);
                void act(() =>
                  api("/stock/transfers", {
                    from_id: source?.id,
                    to_id: target?.id,
                    quantity_kg: Number(b.quantity_kg),
                    from_version: source?.version,
                    to_version: target?.version,
                    reason: b.reason,
                  }),
                );
              }}
            >
              <label>
                Transfer from
                <select
                  aria-label="Transfer from"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                >
                  <option value="">Choose a stock account</option>
                  {accounts
                    .filter((a) => a.active)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.site_name} · {a.material_name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Transfer to
                <select
                  key={from}
                  name="to_id"
                  aria-label="Transfer to"
                  required
                >
                  <option value="">Choose a site for the same material</option>
                  {accounts
                    .filter(
                      (a) =>
                        a.active &&
                        a.id !== from &&
                        a.material_id === source?.material_id,
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.site_name} · {a.material_name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Transfer quantity (kg)
                <input
                  name="quantity_kg"
                  type="number"
                  min="1"
                  max="1000000000000"
                  required
                />
              </label>
              <label>
                Material transfer reason
                <input name="reason" maxLength={2000} required />
              </label>
              <button disabled={busy || !source}>
                Record material transfer
              </button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
