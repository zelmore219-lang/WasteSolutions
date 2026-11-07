import { dollarsToCents } from "./money-input";
import { useEffect, useState, FormEvent } from "react";
type Row = Record<string, any>;
type Props = {
  tab: string;
  actor: Row;
  api: (p: string, b?: unknown) => Promise<any>;
};
const form = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget));
};
export function AdminPanel({ tab, actor, api }: Props) {
  const [items, setItems] = useState<Row[]>([]),
    [trucks, setTrucks] = useState<Row[]>([]),
    [contacts, setContacts] = useState<Row[]>([]),
    [company, setCompany] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const manager = ["owner", "manager"].includes(actor.role),
    dispatcher = ["owner", "manager", "dispatcher"].includes(actor.role);
  async function load() {
    if (tab === "Company") setCompany(await api("/company"));
    if (tab === "Employees") setItems(await api("/employees"));
    if (tab === "Audit log") setItems(await api("/audit"));
    if (tab === "Fleet") {
      setTrucks(await api("/fleet/trucks"));
      if (actor.role !== "accountant")
        setItems(await api("/fleet/inspections"));
    }
    if (tab === "Maintenance") {
      setItems(await api("/fleet/maintenance"));
      setTrucks(await api("/fleet/trucks"));
    }
    if (tab === "Messages") {
      setItems(await api("/messages"));
      setContacts(await api("/messages/contacts"));
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [tab,actor]);
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
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {tab === "Company" && company && (
        <section className="panel">
          <h2>Company information</h2>
          <form
            className="grid"
            key={company.version}
            onSubmit={(e) => {
              const b = form(e);
              void act(() =>
                api("/company", {
                  ...b,
                  invoice_terms_days: Number(b.invoice_terms_days),
                  late_fee_cents: dollarsToCents(b.late_fee_cents),
                  late_fee_grace_days: Number(b.late_fee_grace_days),
                  version: company.version,
                }),
              );
            }}
          >
            <label>
              Company name
              <input
                name="name"
                defaultValue={company.name}
                required
                disabled={!manager}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                name="email"
                defaultValue={company.email}
                disabled={!manager}
              />
            </label>
            <label>
              Phone
              <input
                name="phone"
                defaultValue={company.phone}
                disabled={!manager}
              />
            </label>
            <label>
              Business address
              <input
                name="address"
                defaultValue={company.address}
                disabled={!manager}
              />
            </label>
            <label>
              Business timezone
              <input
                name="timezone"
                defaultValue={company.timezone}
                required
                disabled={!manager}
              />
            </label>
            <label>
              Invoice terms (days)
              <input
                type="number"
                name="invoice_terms_days"
                min="0"
                max="365"
                step="1"
                defaultValue={company.invoice_terms_days}
                required
                disabled={!manager}
              />
            </label>
                <label>
                  Configured overdue fee ($)
                  <input
                    name="late_fee_cents"
                    inputMode="decimal"
                    defaultValue={((company.late_fee_cents ?? 0) / 100).toFixed(
                      2,
                    )}
                    disabled={!manager}
                    required
                  />
                </label>
                <label>
                  Overdue fee grace period (days)
                  <input
                    type="number"
                    name="late_fee_grace_days"
                    min="0"
                    max="365"
                    step="1"
                    defaultValue={company.late_fee_grace_days ?? 0}
                    disabled={!manager}
                    required
                  />
                </label>
            {manager && (
              <button disabled={busy}>Save company information</button>
            )}
          </form>
        </section>
      )}
      {tab === "Employees" && (
        <>
          <section className="panel">
            <h2>Employee accounts and permissions</h2>
            {items.map((e) => (
              <article className="order" key={e.id}>
                <div>
                  <h3>{e.display_name}</h3>
                  <p>
                    {e.username} · {e.role} · {e.active ? "Active" : "Disabled"}
                  </p>
                </div>
                {actor.role === "owner" && (
                  <form
                    className="actions"
                    onSubmit={(event) => {
                      const b = form(event);
                      void act(() =>
                        api(`/employees/${e.id}`, {
                          role: b.role,
                          active: b.active === "true",
                        }),
                      );
                    }}
                  >
                    <select
                      name="role"
                      aria-label={`Role for ${e.display_name}`}
                      defaultValue={e.role}
                    >
                      {[
                        "owner",
                        "manager",
                        "dispatcher",
                        "office",
                        "accountant",
                        "driver",
                      ].map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                    <select
                      name="active"
                      aria-label={`Account status for ${e.display_name}`}
                      defaultValue={String(e.active)}
                    >
                      <option value="true">Active</option>
                      <option value="false">Disabled</option>
                    </select>
                    <button disabled={busy}>Update account</button>
                  </form>
                )}
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>Create employee account</h2>
            <p className="muted">
              Employees must activate their identity and enroll any required MFA
              before signing in. No default password is assigned.
            </p>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = form(e);
                void act(() => api("/employees", b));
              }}
            >
              <label>
                Display name
                <input name="display_name" required />
              </label>
              <label>
                Employee email
                <input name="email" type="email" required />
              </label>
              <label>
                Username
                <input name="username" pattern="[a-z0-9._-]{3,64}" required />
              </label>
              <label>
                Role
                <select name="role">
                  {(actor.role === "owner"
                    ? [
                        "owner",
                        "manager",
                        "dispatcher",
                        "office",
                        "accountant",
                        "driver",
                      ]
                    : ["dispatcher", "office", "accountant", "driver"]
                  ).map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <button disabled={busy}>Create employee account</button>
            </form>
          </section>
        </>
      )}
      {tab === "Fleet" && (
        <>
          <section className="panel">
            <h2>Truck fleet</h2>
            {trucks.map((t) => (
              <article className="order" key={t.id}>
                <div>
                  <h3>{t.number}</h3>
                  <span className="badge">{t.status}</span>
                </div>
                {manager && (
                  <form
                    className="actions"
                    onSubmit={(e) => {
                      const b = form(e);
                      void act(() => api(`/fleet/trucks/${t.id}/status`, b));
                    }}
                  >
                    <select
                      name="status"
                      aria-label={`Status for ${t.number}`}
                      defaultValue={t.status}
                    >
                      <option>available</option>
                      <option>maintenance</option>
                      <option>retired</option>
                    </select>
                    <button disabled={busy}>Update truck status</button>
                  </form>
                )}
              </article>
            ))}
          </section>
          {dispatcher && (
            <section className="panel">
              <h2>Add truck</h2>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = form(e);
                  void act(() => api("/fleet/trucks", b));
                }}
              >
                <label>
                  Truck number
                  <input name="number" required />
                </label>
                <button disabled={busy}>Add truck</button>
              </form>
            </section>
          )}
          {actor.role === "driver" && (
            <section className="panel">
              <h2>Vehicle inspection</h2>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = form(e);
                  void act(() =>
                    api("/fleet/inspections", {
                      ...b,
                      odometer_km: Number(b.odometer_km),
                      safe_to_operate: b.safe_to_operate === "true",
                    }),
                  );
                }}
              >
                <label>
                  Assigned truck
                  <select name="truck_id" required>
                    <option value="">Select truck</option>
                    {trucks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.number}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Inspection
                  <select name="kind">
                    <option value="pre_trip">Pre-trip</option>
                    <option value="post_trip">Post-trip</option>
                  </select>
                </label>
                <label>
                  Odometer (km)
                  <input
                    type="number"
                    min="0"
                    max="10000000"
                    step="1"
                    name="odometer_km"
                    required
                  />
                </label>
                <label>
                  Safe to operate
                  <select name="safe_to_operate">
                    <option value="true">Yes</option>
                    <option value="false">No — report safety defects</option>
                  </select>
                </label>
                <label>
                  Inspection notes
                  <input name="notes" />
                </label>
                <button disabled={busy}>Record inspection</button>
              </form>
            </section>
          )}
          {items.length > 0 && (
            <section className="panel">
              <h2>Inspection history</h2>
              {items.map((i) => (
                <p key={i.id}>
                  {i.truck_number} · {i.driver_name} · {i.kind} ·{" "}
                  {i.safe_to_operate ? "Safe" : "Safety defect"} · {i.notes}
                </p>
              ))}
            </section>
          )}
        </>
      )}
      {tab === "Maintenance" && (
        <>
          <section className="panel">
            <h2>Maintenance schedule</h2>
            {items.length === 0 && <p>No maintenance tasks.</p>}
            {items.map((m) => (
              <article className="order" key={m.id}>
                <div>
                  <span className="badge">{m.status}</span>
                  <h3>
                    {m.truck_number} · {m.due_date}
                  </h3>
                  <p>{m.description}</p>
                  {m.completion_notes && <p>{m.completion_notes}</p>}
                </div>
                {manager && m.status === "open" && (
                  <form
                    className="actions"
                    onSubmit={(e) => {
                      const b = form(e);
                      void act(() =>
                        api(`/fleet/maintenance/${m.id}/complete`, {
                          ...b,
                          version: m.version,
                        }),
                      );
                    }}
                  >
                    <label>
                      Work performed
                      <input name="completion_notes" required />
                    </label>
                    <button disabled={busy}>Complete maintenance task</button>
                  </form>
                )}
              </article>
            ))}
          </section>
          {manager && (
            <section className="panel">
              <h2>Schedule maintenance</h2>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = form(e);
                  void act(() => api("/fleet/maintenance", b));
                }}
              >
                <label>
                  Truck
                  <select name="truck_id" required>
                    <option value="">Select truck</option>
                    {trucks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.number}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Due date
                  <input type="date" name="due_date" required />
                </label>
                <label>
                  Maintenance work
                  <input name="description" required />
                </label>
                <button disabled={busy}>Schedule maintenance</button>
              </form>
            </section>
          )}
        </>
      )}
      {tab === "Messages" && (
        <>
          <section className="panel">
            <div className="section-title">
              <h2>Dispatch messages</h2>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void act(async () => {})}
              >
                Refresh
              </button>
            </div>
            {!items.length && <p>No messages yet.</p>}
            {items.map((m) => (
              <article className="order" key={m.id}>
                <div>
                  <h3>
                    {m.sender_name} → {m.recipient_name}
                  </h3>
                  <p>{m.message}</p>
                  <small>{new Date(m.created_at).toLocaleString()}</small>
                </div>
              </article>
            ))}
          </section>
          <section className="panel">
            <h2>Send a message</h2>
            <form
              className="grid"
              onSubmit={(e) => {
                const b = form(e);
                void act(() => api("/messages", b));
              }}
            >
              <label>
                Recipient
                <select name="recipient_id" required>
                  <option value="">Choose contact</option>
                  {contacts
                    .filter(
                      (c) => actor.role !== "driver" || c.role !== "driver",
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name} · {c.role}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Message
                <input name="message" required maxLength={2000} />
              </label>
              <button disabled={busy}>Send message</button>
            </form>
          </section>
        </>
      )}
      {tab === "Audit log" && (
        <section className="panel">
          <h2>System activity</h2>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Employee</th>
                <th>Action</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id}>
                  <td>{new Date(l.created_at).toLocaleString()}</td>
                  <td>{l.actor_name}</td>
                  <td>{l.action}</td>
                  <td>{l.entity_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
