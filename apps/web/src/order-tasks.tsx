import { useState } from "react";
export function OrderTaskPanel({
  order,
  actor,
  api,
  refresh,
}: {
  order: any;
  actor: any;
  api: (p: string, b?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (
    !["owner", "manager", "dispatcher", "office", "driver"].includes(
      actor?.role,
    )
  )
    return null;
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>
        Service tasks (
        {(order.tasks || []).filter((t: any) => t.completed_at).length}/
        {order.tasks?.length || 0})
      </summary>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {(order.tasks || []).map((t: any) => (
        <div key={t.id}>
          <p>
            {t.completed_at ? "✓" : "○"} {t.label}{" "}
            {t.required && <small>Required</small>}
          </p>
          {!t.completed_at &&
            ["owner", "manager", "driver"].includes(actor.role) &&
            ["assigned", "in_progress"].includes(order.status) && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api(
                      "/orders/" + order.id + "/tasks/" + t.id + "/complete",
                      {
                        version: t.version,
                        note: "",
                        performed_at: new Date().toISOString(),
                      },
                    ),
                  )
                }
              >
                Complete task
              </button>
            )}
        </div>
      ))}
      {actor.role !== "driver" &&
        ["new", "assigned", "in_progress"].includes(order.status) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const b = new FormData(e.currentTarget);
              void act(() =>
                api("/orders/" + order.id + "/tasks", {
                  label: b.get("label"),
                  required: b.get("required") === "on",
                  version: order.version,
                }),
              );
            }}
          >
            <label>
              Assigned task
              <input name="label" required maxLength={500} />
            </label>
            <label className="check">
              <input name="required" type="checkbox" defaultChecked />
              Required before service completion
            </label>
            <button disabled={busy}>Add service task</button>
          </form>
        )}
    </details>
  );
}
