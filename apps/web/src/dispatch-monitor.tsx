import { DriverActionReviews } from "./driver-action-review";
import { useEffect, useState, FormEvent } from "react";
export function DispatchMonitor({
  api,
}: {
  api: (p: string, b?: unknown) => Promise<any>;
}) {
  const [locations, setLocations] = useState<any[]>([]),
    [exceptions, setExceptions] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setLocations(await api("/drivers/locations"));
    setExceptions(await api("/sync/exceptions"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const interval = setInterval(
      () => void load().catch(() => undefined),
      15000,
    );
    return () => clearInterval(interval);
  }, []);
  async function resolve(e: FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      await api(`/sync/exceptions/${id}/resolve`, data);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DriverActionReviews api={api} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="panel">
        <h2>Driver location monitor</h2>
        <p className="muted">
          Locations appear only after a driver opts in. Age and accuracy show
          how much confidence to place in the position.
        </p>
        {!locations.length ? (
          <p>No shared driver locations.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Driver</th>
                <th>Last update</th>
                <th>Accuracy</th>
                <th>Map</th>
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id}>
                  <td>{l.driver_name}</td>
                  <td>
                    {l.age_seconds < 300
                      ? `${l.age_seconds} seconds ago`
                      : `Stale · ${Math.floor(l.age_seconds / 60)} minutes ago`}
                  </td>
                  <td>±{Math.round(l.accuracy_m)} m</td>
                  <td>
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${l.latitude},${l.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open shared location on map
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <h2>Offline service exceptions</h2>
        <p className="muted">
          These records preserve a driver's report when dispatch changed the
          job. Acknowledging evidence does not complete or bill an order.
          Reconcile the service through the normal dispatch controls.
        </p>
        {!exceptions.length ? (
          <p>No offline exceptions.</p>
        ) : (
          exceptions.map((x) => (
            <article className="order" key={x.id}>
              <div>
                <span className="badge">{x.status}</span>
                <h3>
                  {x.driver_name} · {x.customer_name}
                </h3>
                <p>{x.address}</p>
                <p>
                  Reported {x.reported_status} ·{" "}
                  {new Date(x.performed_at).toLocaleString()}
                </p>
                <p>{x.note}</p>
                {x.original_body?.container_verification && (
                  <p>
                    Captured container:{" "}
                    {x.original_body.container_verification.container_number}
                    {x.original_body.container_verification
                      .replacement_container_number &&
                      " · Replacement: " +
                        x.original_body.container_verification
                          .replacement_container_number}
                  </p>
                )}
                {x.resolution && <p>Resolution: {x.resolution}</p>}
              </div>
              {x.status === "open" && (
                <form
                  className="actions"
                  onSubmit={(e) => void resolve(e, x.id)}
                >
                  <label>
                    Decision
                    <select name="status">
                      <option value="acknowledged">Acknowledge evidence</option>
                      <option value="rejected">Reject evidence</option>
                    </select>
                  </label>
                  <label>
                    Resolution notes
                    <input name="resolution" required />
                  </label>
                  <button disabled={busy}>Record review decision</button>
                </form>
              )}
            </article>
          ))
        )}
      </section>
    </>
  );
}
