import { useEffect, useState } from "react";
export function DriverActionReviews({
  api,
}: {
  api: (p: string, b?: unknown) => Promise<any>;
}) {
  const [items, setItems] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setItems(await api("/driver-actions/reviews"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => void load().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="panel">
      <h2>Offline driver updates for review</h2>
      <p>
        These updates were removed from a device's sending queue only after the
        evidence was saved here. Reviewing evidence does not change the original
        task, inspection, message or disposal record. Use the relevant workflow
        for any correction.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!items.length ? (
        <p>No driver action evidence awaiting review.</p>
      ) : (
        items.map((r) => (
          <article className="order" key={r.id}>
            <div>
              <span className="badge">{r.status}</span>
              <h3>{r.entity_label}</h3>
              <small>
                {r.driver_name} · Recorded{" "}
                {new Date(r.performed_at).toLocaleString()}
              </small>
              {r.already_committed && (
                <p className="notice">
                  The original update was already saved. Check its current
                  record before taking further action.
                </p>
              )}
              {Object.entries(r.original_action.body)
                .filter(
                  ([key]) =>
                    !["version", "performed_at", "recorded_at"].includes(key) &&
                    !key.endsWith("_id"),
                )
                .map(([key, value]) => (
                  <p key={key}>
                    <b>{key.replaceAll("_", " ")}:</b>{" "}
                    {typeof value === "boolean"
                      ? value
                        ? "Yes"
                        : "No"
                      : String(value)}
                  </p>
                ))}
              {r.resolution && <p>Office review: {r.resolution}</p>}
            </div>
            {r.status === "open" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const b = Object.fromEntries(new FormData(e.currentTarget));
                  setBusy(true);
                  setError("");
                  void api("/driver-actions/reviews/" + r.id + "/resolve", b)
                    .then(load)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                <label>
                  Review decision
                  <select
                    name="status"
                    aria-label="Offline evidence review decision"
                  >
                    <option value="acknowledged">Acknowledge evidence</option>
                    <option value="rejected">Reject evidence</option>
                  </select>
                </label>
                <label>
                  Review resolution
                  <input name="resolution" required maxLength={2000} />
                </label>
                <button disabled={busy}>Save offline evidence review</button>
              </form>
            )}
          </article>
        ))
      )}
    </section>
  );
}
