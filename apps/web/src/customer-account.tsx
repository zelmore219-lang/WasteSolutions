import { useEffect, useState, FormEvent } from "react";
type Row = Record<string, any>;
export function CustomerAccount({
  customer,
  actor,
  api,
  onClose,
  onSaved,
}: {
  customer: Row;
  actor: Row;
  api: (p: string, b?: unknown) => Promise<any>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [record, setRecord] = useState(customer),
    [notes, setNotes] = useState<Row[]>([]),
    [statement, setStatement] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const office = ["owner", "manager", "dispatcher", "office"].includes(
      actor.role,
    ),
    self = actor.role === "customer";
  async function load() {
    setStatement(await api(`/customers/${record.id}/statement`));
    if (!self) setNotes(await api(`/customers/${record.id}/notes`));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [record.id]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function body(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Account · {record.name}</h2>
        <button className="secondary" onClick={onClose}>
          Close account
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="grid"
        key={record.version}
        onSubmit={(e) => {
          const b = body(e);
          void act(async () => {
            setRecord(
              await api(`/customers/${record.id}`, {
                ...b,
                version: record.version,
              }),
            );
          });
        }}
      >
        {office && (
          <>
            <label>
              Account name
              <input name="name" defaultValue={record.name} required />
            </label>
            <label>
              Type
              <select name="kind" defaultValue={record.kind}>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
              </select>
            </label>
            <label>
              Billing contact email
              <input
                type="email"
                name="email"
                defaultValue={record.email}
                required
              />
            </label>
            <label>
              Service status
              <select name="status" defaultValue={record.status}>
                <option value="active">Active</option>
                <option value="suspended">Suspended — stop new services</option>
              </select>
            </label>
          </>
        )}
        <label>
          Contact phone
          <input
            name="phone"
            defaultValue={record.phone}
            disabled={!office && !self}
          />
        </label>
        <label>
          Billing address
          <input
            name="billing_address"
            defaultValue={record.billing_address}
            required
            disabled={!office && !self}
          />
        </label>
        {(office || self) && (
          <button disabled={busy}>Save account changes</button>
        )}
      </form>
      <h3>Customer statement</h3>
      <table>
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Due date</th>
            <th>Amount</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {statement.map((i) => (
            <tr key={i.id}>
              <td>CW-{String(i.number).padStart(6, "0")}</td>
              <td>{i.due_date}</td>
              <td>
                $
                {(Number(i.net_amount_cents ?? i.amount_cents) / 100).toFixed(
                  2,
                )}
              </td>
              <td>${(Number(i.balance_cents) / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Balance due:{" "}
        <b>
          $
          {(
            statement.reduce((n, i) => n + Number(i.balance_cents), 0) / 100
          ).toFixed(2)}
        </b>
      </p>
      {!self && (
        <>
          <h3>Internal account notes</h3>
          {notes.map((n) => (
            <p key={n.id}>
              {n.note}
              <small>
                {n.actor_name} · {new Date(n.created_at).toLocaleString()}
              </small>
            </p>
          ))}
          {office && (
            <form
              className="grid"
              onSubmit={(e) => {
                const b = body(e);
                void act(async () => {
                  await api(`/customers/${record.id}/notes`, b);
                });
              }}
            >
              <label>
                New internal note
                <input name="note" required maxLength={5000} />
              </label>
              <button disabled={busy}>Add note</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
