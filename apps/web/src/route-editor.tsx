import { useState, FormEvent } from "react";
type Row = Record<string, any>;
export function RouteEditor({
  route,
  orders,
  resources,
  save,
  cancel,
}: {
  route: Row;
  orders: Row[];
  resources: { drivers: Row[]; trucks: Row[] };
  save: (body: unknown) => Promise<void>;
  cancel: () => void;
}) {
  const [ids, setIds] = useState<string[]>(route.stops.map((s: Row) => s.id)),
    [drag, setDrag] = useState<number | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const all = new Map<string, Row>();
  for (const o of orders) all.set(o.id, o);
  for (const o of route.stops) all.set(o.id, o);
  const available = orders.filter(
    (o) =>
      o.scheduled_date === route.service_date &&
      ["new", "assigned", "in_progress"].includes(o.status) &&
      !ids.includes(o.id),
  );
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    setIds(next);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const b = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await save({ ...b, order_ids: ids, version: route.version });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Edit route · {route.name}</h2>
        <button className="secondary" onClick={cancel}>
          Close editor
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <form onSubmit={(e) => void submit(e)}>
        <div className="grid">
          <label>
            Route name
            <input name="name" defaultValue={route.name} required />
          </label>
          <label>
            Route date
            <input
              type="date"
              name="service_date"
              defaultValue={route.service_date}
              required
            />
          </label>
          <label>
            Assigned driver
            <select
              name="driver_id"
              defaultValue={route.driver_id}
              required
              aria-label="Assigned driver"
            >
              {resources.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.display_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assigned truck
            <select
              name="truck_id"
              defaultValue={route.truck_id}
              required
              aria-label="Assigned truck"
            >
              {resources.trucks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.number}
                </option>
              ))}
            </select>
          </label>
        </div>
        <h3>Stop order</h3>
        <p className="muted">
          Drag stops to reorder, or use the move buttons. Removing an unstarted
          stop returns it to unassigned work. In-progress and completed stops
          stay on their route.
        </p>
        <ol className="route-stops">
          {ids.map((id, i) => {
            const o = all.get(id)!;
            return (
              <li
                key={id}
                draggable
                onDragStart={() => setDrag(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag !== null) move(drag, i);
                  setDrag(null);
                }}
              >
                <div>
                  <b>{o.customer_name}</b>
                  <small>
                    {o.address} · {o.status}
                  </small>
                </div>
                <div className="export-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Move stop ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Move stop ${i + 1} down`}
                    disabled={i === ids.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={["completed", "invoiced", "in_progress"].includes(
                      o.status,
                    )}
                    onClick={() => setIds(ids.filter((x) => x !== id))}
                  >
                    Remove stop
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        <label>
          Add unstarted service
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setIds([...ids, e.target.value]);
            }}
            aria-label="Add unstarted service"
          >
            <option value="">Choose a stop on this route date</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.customer_name} · {o.address}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !ids.length}>Save route changes</button>
      </form>
    </section>
  );
}
