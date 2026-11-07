import { useEffect, useState, FormEvent } from "react";
import { dollarsToCents } from "./money-input";
export function DisposalLoadsPanel({
  actor,
  resources,
  api,
}: {
  actor: any;
  resources: { drivers: any[]; trucks: any[] };
  api: (p: string, b?: unknown) => Promise<any>;
}) {
  const [items, setItems] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setItems(await api("/disposal-loads"));
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
  function fields(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Loaded containers awaiting disposal</h2>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void act(async () => {})}
        >
          Refresh disposal tasks
        </button>
      </div>
      <p>
        Collected containers stay unavailable until a verified facility ticket
        clears the load. An unable-to-dump report preserves the load and its
        inventory hold. Dispatch can assign outstanding disposal separately from
        the completed collection job.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!items.length ? (
        <p>No outstanding disposal loads.</p>
      ) : (
        items.map((l) => (
          <article className="panel" key={l.id}>
            <span className="badge">{l.status.replaceAll("_", " ")}</span>
            <h3>
              {l.container_number} · {l.customer_name}
            </h3>
            <p>{l.address}</p>
            <small>
              {l.driver_name || "Unassigned disposal task"} ·{" "}
              {l.truck_number || "No disposal truck assigned"}
            </small>
            {l.last_failure_reason && (
              <p>Unable to dump: {l.last_failure_reason}</p>
            )}
            {["owner", "manager", "dispatcher"].includes(actor.role) && (
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/disposal-loads/" + l.id + "/assign", {
                      ...b,
                      version: l.version,
                    }),
                  );
                }}
              >
                <label>
                  Disposal driver
                  <select
                    name="driver_id"
                    aria-label="Disposal driver"
                    required
                    defaultValue={l.assigned_driver_id || ""}
                  >
                    <option value="">Choose driver</option>
                    {resources.drivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Disposal truck
                  <select
                    name="truck_id"
                    aria-label="Disposal truck"
                    required
                    defaultValue={l.assigned_truck_id || ""}
                  >
                    <option value="">Choose truck</option>
                    {resources.trucks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.number}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy}>Assign disposal task</button>
              </form>
            )}
            {actor.role === "driver" && (
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/disposal-loads/" + l.id + "/unable", {
                      version: l.version,
                      reason: b.reason,
                      returning_later: b.returning_later === "on",
                      performed_at: new Date().toISOString(),
                    }),
                  );
                }}
              >
                <label>
                  Unable to dump reason
                  <input name="reason" required maxLength={2000} />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    name="returning_later"
                    defaultChecked
                  />
                  Returning later — keep on my schedule
                </label>
                <button className="secondary" disabled={busy}>
                  Report unable to dump
                </button>
              </form>
            )}
            <details>
              <summary>Record verified disposal ticket</summary>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/rentals/" + l.rental_id + "/disposal", {
                      ...b,
                      order_id: l.order_id,
                      gross_kg: Number(b.gross_kg),
                      tare_kg: Number(b.tare_kg),
                      disposal_cost_cents: dollarsToCents(
                        b.disposal_cost_cents,
                      ),
                    }),
                  );
                }}
              >
                <label>
                  Facility
                  <input name="facility" required maxLength={200} />
                </label>
                <label>
                  Facility ticket number
                  <input name="ticket_number" required maxLength={100} />
                </label>
                <label>
                  Gross weight (kg)
                  <input
                    name="gross_kg"
                    type="number"
                    min="1"
                    max="1000000"
                    step="1"
                    required
                  />
                </label>
                <label>
                  Tare weight (kg)
                  <input
                    name="tare_kg"
                    type="number"
                    min="0"
                    max="1000000"
                    step="1"
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
                <button disabled={busy}>
                  Verify disposal and release inventory hold
                </button>
              </form>
            </details>
          </article>
        ))
      )}
    </section>
  );
}
