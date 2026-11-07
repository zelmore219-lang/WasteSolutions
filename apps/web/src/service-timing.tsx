import { FormEvent, useState } from "react";
export function ServiceTimingPanel({
  order,
  actor,
  api,
  refresh,
}: {
  order: any;
  actor: any;
  api: (path: string, body?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editable =
    ["owner", "manager", "dispatcher", "office"].includes(actor.role) &&
    ["new", "assigned", "failed"].includes(order.status);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      await api("/orders/" + order.id + "/service-timing", {
        version: order.version,
        window_start: b.window_start || null,
        window_end: b.window_end || null,
        duration_minutes: Number(b.duration_minutes),
        reason: b.reason,
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {(order.service_window_start || order.service_duration_minutes > 0) && (
        <p>
          Arrival window:{" "}
          {order.service_window_start
            ? order.service_window_start.slice(0, 5) +
              "–" +
              order.service_window_end.slice(0, 5)
            : "not specified"}{" "}
          (company local time) · Planned work: {order.service_duration_minutes}{" "}
          minutes
        </p>
      )}
      {editable && (
        <details>
          <summary>Arrival window and service time</summary>
          <p>
            Same-day arrival times in the company timezone. Road previews
            include planned work and waiting; they reject an estimated service
            start after the window ends. Times are planning estimates.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <form
            className="grid"
            key={order.id + ":" + order.version}
            onSubmit={(e) => void submit(e)}
          >
            <label>
              Arrival window start
              <input
                name="window_start"
                type="time"
                defaultValue={order.service_window_start?.slice(0, 5) || ""}
              />
            </label>
            <label>
              Arrival window end
              <input
                name="window_end"
                type="time"
                defaultValue={order.service_window_end?.slice(0, 5) || ""}
              />
            </label>
            <label>
              Planned service minutes
              <input
                name="duration_minutes"
                type="number"
                min="0"
                max="720"
                step="1"
                defaultValue={order.service_duration_minutes || 0}
                required
              />
            </label>
            <label>
              Service timing change reason
              <input name="reason" maxLength={2000} required />
            </label>
            <button disabled={busy}>Save service timing</button>
          </form>
        </details>
      )}
    </div>
  );
}
