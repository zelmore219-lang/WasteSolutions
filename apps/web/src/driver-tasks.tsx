import { FormEvent, useEffect, useState } from "react";
export function DriverTaskPanel({
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
  const office = ["owner", "manager", "dispatcher", "office"].includes(
      actor.role,
    ),
    dispatch = ["owner", "manager", "dispatcher"].includes(actor.role);
  async function load() {
    setItems(await api("/driver-tasks"));
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
  const drivers = (
      <>
        <option value="">Choose driver</option>
        {resources.drivers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.display_name}
          </option>
        ))}
      </>
    ),
    trucks = (
      <>
        <option value="">No truck required</option>
        {resources.trucks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.number}
          </option>
        ))}
      </>
    );
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Independent driver tasks</h2>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void act(async () => {})}
        >
          Refresh driver tasks
        </button>
      </div>
      <p>
        Dispatch errands and other work independently of customer orders. These
        tasks do not create invoices or customer charges.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {office && (
        <details>
          <summary>Create a driver task</summary>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(() =>
                api("/driver-tasks", {
                  ...b,
                  driver_id: b.driver_id || undefined,
                  truck_id: b.truck_id || undefined,
                }),
              );
            }}
          >
            <label>
              Task title
              <input name="title" required maxLength={200} />
            </label>
            <label>
              Task date
              <input type="date" name="scheduled_date" required />
            </label>
            <label>
              Task priority
              <select name="priority" aria-label="Task priority">
                <option value="normal">Normal</option>
                <option value="low">Low</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label>
              Task description
              <textarea name="description" maxLength={2000} />
            </label>
            <label>
              Task address (optional)
              <input name="address" maxLength={2000} />
            </label>
            {dispatch && (
              <>
                <label>
                  Task driver
                  <select name="driver_id" aria-label="Task driver">
                    {drivers}
                  </select>
                </label>
                <label>
                  Task truck
                  <select name="truck_id" aria-label="Task truck">
                    {trucks}
                  </select>
                </label>
              </>
            )}
            <button disabled={busy}>Create independent task</button>
          </form>
        </details>
      )}
      {!items.length ? (
        <p>No driver tasks.</p>
      ) : (
        items.map((t) => (
          <article className="panel" key={t.id}>
            <span className="badge">
              {t.status.replaceAll("_", " ")} · {t.priority}
            </span>
            <h3>{t.title}</h3>
            <p>{t.description}</p>
            {t.address && <p>{t.address}</p>}
            <small>
              {t.scheduled_date} · {t.driver_name || "Unassigned"} ·{" "}
              {t.truck_number || "No truck required"}
            </small>
            {t.completion_note && <p>{t.completion_note}</p>}
            {dispatch && !["completed", "cancelled"].includes(t.status) && (
              <form
                className="actions"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/driver-tasks/" + t.id + "/assign", {
                      ...b,
                      truck_id: b.truck_id || null,
                      version: t.version,
                    }),
                  );
                }}
              >
                <label>
                  Assigned task driver
                  <select
                    name="driver_id"
                    aria-label="Assigned task driver"
                    required
                    defaultValue={t.driver_id || ""}
                  >
                    {drivers}
                  </select>
                </label>
                <label>
                  Assigned task truck
                  <select
                    name="truck_id"
                    aria-label="Assigned task truck"
                    defaultValue={t.truck_id || ""}
                  >
                    {trucks}
                  </select>
                </label>
                <button disabled={busy}>Assign independent task</button>
              </form>
            )}
            {["owner", "manager", "driver"].includes(actor.role) &&
              ["assigned", "in_progress"].includes(t.status) && (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api("/driver-tasks/" + t.id + "/status", {
                          version: t.version,
                          status:
                            t.status === "assigned"
                              ? "in_progress"
                              : "completed",
                          note: "",
                          performed_at: new Date().toISOString(),
                        }),
                      )
                    }
                  >
                    {t.status === "assigned"
                      ? "Start independent task"
                      : "Complete independent task"}
                  </button>
                  <form
                    className="actions"
                    onSubmit={(e) => {
                      const b = fields(e);
                      void act(() =>
                        api("/driver-tasks/" + t.id + "/status", {
                          version: t.version,
                          status: "failed",
                          note: b.note,
                          performed_at: new Date().toISOString(),
                        }),
                      );
                    }}
                  >
                    <label>
                      Task failure reason
                      <input name="note" required maxLength={2000} />
                    </label>
                    <button className="secondary" disabled={busy}>
                      Report task unable to complete
                    </button>
                  </form>
                </>
              )}
            {dispatch && ["new", "assigned", "failed"].includes(t.status) && (
              <details>
                <summary>Cancel independent task</summary>
                <form
                  onSubmit={(e) => {
                    const b = fields(e);
                    void act(() =>
                      api("/driver-tasks/" + t.id + "/cancel", {
                        reason: b.reason,
                        version: t.version,
                      }),
                    );
                  }}
                >
                  <label>
                    Cancellation reason
                    <input name="reason" required maxLength={2000} />
                  </label>
                  <button className="secondary" disabled={busy}>
                    Cancel task with reason
                  </button>
                </form>
              </details>
            )}
          </article>
        ))
      )}
    </section>
  );
}
