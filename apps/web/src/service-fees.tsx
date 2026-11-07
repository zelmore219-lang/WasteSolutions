import { FormEvent, useEffect, useState } from "react";
import { dollarsToCents } from "./money-input";
type Row = Record<string, any>;
type Api = (path: string, body?: unknown) => Promise<any>;
const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
function label(p: Row) {
  return (
    p.name +
    " · " +
    (p.method === "flat"
      ? money(p.value)
      : (p.value / 100).toFixed(2) + "% of base") +
    " · " +
    p.effective_from +
    " through " +
    (p.effective_to || "open ended")
  );
}
export function FeePicker({
  customerId,
  api,
  baseCents,
}: {
  customerId: string;
  api: Api;
  baseCents?: number;
}) {
  const [policies, setPolicies] = useState<Row[]>([]),
    [selected, setSelected] = useState<Record<string, Row>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setSelected({});
    setPolicies([]);
    setError("");
    if (customerId)
      void api("/customers/" + customerId + "/fee-policies")
        .then((rows) => {
          if (current) setPolicies(rows);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [customerId]);
  const chosen = Object.values(selected),
    extra =
      baseCents === undefined
        ? undefined
        : chosen.reduce(
            (n, p) =>
              n +
              (p.method === "flat"
                ? p.value
                : Math.floor((baseCents * p.value + 5000) / 10000)),
            0,
          );
  return (
    <fieldset className="service-fee-picker">
      <legend>Agreed fuel and handling charges</legend>
      <input
        type="hidden"
        name="fee_policies"
        value={JSON.stringify(
          chosen.map((p) => ({ id: p.id, version: p.version })),
        )}
      />
      <p className="muted">
        Optional charges are added to the agreed base price. Percentage fees
        each use the base price, without compounding. None are selected
        automatically.
      </p>
      {error && (
        <p role="alert">
          Fee choices could not load: {error}. Reopen this quote to refresh
          them.
        </p>
      )}
      {["fuel", "handling"].map((kind) => (
        <label key={kind}>
          {kind === "fuel" ? "Fuel fee policy" : "Handling fee policy"}
          <select
            aria-label={
              kind === "fuel" ? "Fuel fee policy" : "Handling fee policy"
            }
            value={selected[kind]?.id || ""}
            onChange={(e) =>
              setSelected((old) => {
                const next = { ...old };
                const p = policies.find((p) => p.id === e.target.value);
                if (p) next[kind] = p;
                else delete next[kind];
                return next;
              })
            }
          >
            <option value="">No {kind} charge</option>
            {policies
              .filter((p) => p.kind === kind && p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {label(p)}
                </option>
              ))}
          </select>
        </label>
      ))}
      {extra !== undefined && (
        <p>
          Selected fees {money(extra)} · Agreed order total{" "}
          {money(baseCents! + extra)}
        </p>
      )}
    </fieldset>
  );
}
export function FeePoliciesPanel({
  customerId,
  api,
  canEdit,
}: {
  customerId: string;
  api: Api;
  canEdit: boolean;
}) {
  const [policies, setPolicies] = useState<Row[]>([]),
    [editing, setEditing] = useState<Row | null>(null),
    [method, setMethod] = useState("flat"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api("/customers/" + customerId + "/fee-policies")
      .then((rows) => {
        if (current) setPolicies(rows);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [customerId]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      const body = {
        name: b.name,
        value: dollarsToCents(b.value),
        effective_from: b.effective_from,
        effective_to: b.effective_to || null,
        active: b.active === "on",
      };
      if (editing)
        await api("/fee-policies/" + editing.id + "/update", {
          ...body,
          version: editing.version,
          reason: b.reason,
        });
      else
        await api("/fee-policies", {
          ...body,
          customer_id: customerId,
          method,
          kind: b.kind,
        });
      setPolicies(await api("/customers/" + customerId + "/fee-policies"));
      setEditing(null);
      setMethod("flat");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Customer fuel and handling policies</h2>
      <p>
        Changes apply only to charges explicitly selected on future ordinary
        service orders. Existing quoted charges stay fixed. Monthly contracts,
        rentals and facility tickets use their separate charge workflows.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!policies.length && <p>No saved charge policies.</p>}
      {policies.map((p) => (
        <article className="order" key={p.id}>
          <div>
            <h3>
              {p.kind} · {label(p)}
            </h3>
            <p>
              {p.active ? "Active for new quotes" : "Inactive"} · version{" "}
              {p.version}
            </p>
          </div>
          {canEdit && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(p);
                setMethod(p.method);
              }}
            >
              Edit fee policy
            </button>
          )}
        </article>
      ))}
      {canEdit && (
        <>
          <div className="section-title">
            <h3>{editing ? "Edit fee policy" : "Add fee policy"}</h3>
            {editing && (
              <button
                className="secondary"
                onClick={() => {
                  setEditing(null);
                  setMethod("flat");
                }}
              >
                Cancel fee edit
              </button>
            )}
          </div>
          <form
            className="grid"
            key={
              customerId +
              ":" +
              (editing?.id || "new") +
              ":" +
              (editing?.version || 0)
            }
            onSubmit={(e) => void save(e)}
          >
            <label>
              Fee policy name
              <input
                name="name"
                maxLength={200}
                required
                defaultValue={editing?.name || ""}
              />
            </label>
            {!editing && (
              <>
                <label>
                  Fee kind
                  <select aria-label="Fee kind" name="kind">
                    <option value="fuel">Fuel</option>
                    <option value="handling">Handling</option>
                  </select>
                </label>
                <label>
                  Fee calculation
                  <select
                    aria-label="Fee calculation"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    <option value="flat">Flat dollars</option>
                    <option value="percent">Percentage of base</option>
                  </select>
                </label>
              </>
            )}
            <label>
              {method === "flat" ? "Fee amount ($)" : "Fee percentage (%)"}
              <input
                name="value"
                inputMode="decimal"
                required
                defaultValue={editing ? (editing.value / 100).toFixed(2) : ""}
              />
            </label>
            <label>
              Fee effective from
              <input
                name="effective_from"
                type="date"
                required
                defaultValue={editing?.effective_from || ""}
              />
            </label>
            <label>
              Fee effective through
              <input
                name="effective_to"
                type="date"
                defaultValue={editing?.effective_to || ""}
              />
            </label>
            <label>
              <input
                type="checkbox"
                name="active"
                defaultChecked={editing?.active ?? true}
              />
              Fee policy active
            </label>
            {editing && (
              <label>
                Fee change reason
                <input name="reason" maxLength={2000} required />
              </label>
            )}
            <button disabled={busy}>Save fee policy</button>
          </form>
        </>
      )}
    </section>
  );
}
