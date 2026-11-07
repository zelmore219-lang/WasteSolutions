import { FormEvent, useEffect, useState } from "react";
type Props = {
  actor: any;
  customers: any[];
  api: (path: string, body?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
};
const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function ServiceCalendarPanel({
  actor,
  customers,
  api,
  refresh,
}: Props) {
  const [data, setData] = useState<any>({ zones: [], changes: [] }),
    [zone, setZone] = useState<any>(null),
    [change, setChange] = useState<any>(null),
    [customer, setCustomer] = useState(""),
    [locations, setLocations] = useState<any[]>([]),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const edit = ["owner", "manager", "dispatcher"].includes(actor.role);
  async function load() {
    setData(await api("/service-calendar"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [actor]);
  useEffect(() => {
    let active = true;
    setLocations([]);
    if (customer)
      void api("/customers/" + customer + "/locations")
        .then((r) => {
          if (active) setLocations(r);
        })
        .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [customer]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function fields(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return new FormData(e.currentTarget);
  }
  const zoneOptions = (
    <>
      <option value="">All zones / company-wide</option>
      {data.zones
        .filter((z: any) => z.active)
        .map((z: any) => (
          <option key={z.id} value={z.id}>
            {z.name}
          </option>
        ))}
    </>
  );
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <section className="panel">
        <h2>Service zones and collection days</h2>
        <p>
          Locations inherit collection days from their zone. Holiday rules apply
          to future generation. Preview existing work before moving it; started
          service and routed stops require dispatch review.
        </p>
        {data.zones.map((z: any) => (
          <article className="order" key={z.id}>
            <div>
              <h3>
                {z.name} · {z.active ? "Active" : "Inactive"}
              </h3>
              <p>{z.weekdays.map((d: number) => days[d]).join(", ")}</p>
              <small>{z.description}</small>
            </div>
            {edit && (
              <button className="secondary" onClick={() => setZone(z)}>
                Edit zone
              </button>
            )}
          </article>
        ))}
        {edit && (
          <form
            key={(zone?.id || "new") + ":" + String(zone?.version || 0)}
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(async () => {
                await api("/service-calendar/zones", {
                  ...(zone ? { id: zone.id, version: zone.version } : {}),
                  name: b.get("name"),
                  description: b.get("description"),
                  weekdays: b.getAll("weekdays").map(Number),
                  active: b.get("active") === "on",
                });
                setZone(null);
                setPreview(null);
                setMessage(
                  "Zone saved. Preview existing service if collection dates changed.",
                );
              });
            }}
          >
            <label>
              Zone name
              <input
                name="name"
                defaultValue={zone?.name || ""}
                required
                maxLength={120}
              />
            </label>
            <label>
              Description
              <input
                name="description"
                defaultValue={zone?.description || ""}
                maxLength={2000}
              />
            </label>
            <fieldset>
              <legend>Collection weekdays</legend>
              {days.map((day, d) => (
                <label className="check" key={day}>
                  <input
                    name="weekdays"
                    type="checkbox"
                    value={d}
                    defaultChecked={zone ? zone.weekdays.includes(d) : true}
                  />
                  {day}
                </label>
              ))}
            </fieldset>
            <label className="check">
              <input
                name="active"
                type="checkbox"
                defaultChecked={zone?.active ?? true}
              />
              Active zone
            </label>
            <div className="actions">
              <button disabled={busy}>
                {zone ? "Save zone changes" : "Create service zone"}
              </button>
              {zone && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setZone(null)}
                >
                  Cancel zone edit
                </button>
              )}
            </div>
          </form>
        )}
      </section>
      <section className="panel">
        <h2>Assign a location to a zone</h2>
        <form
          className="grid"
          onSubmit={(e) => {
            const b = fields(e);
            void act(async () => {
              await api("/service-calendar/locations", {
                customer_id: customer,
                location_id: b.get("location_id"),
                zone_id: b.get("zone_id") || null,
              });
              setPreview(null);
              setMessage(
                "Location zone saved. Existing orders retain their dates until calendar changes are reviewed.",
              );
            });
          }}
        >
          <label>
            Customer
            <select
              aria-label="Customer"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              required
            >
              <option value="">Select customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Location
            <select aria-label="Location" name="location_id" required>
              <option value="">Select service location</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.address}
                  {l.zone_id
                    ? " · " +
                      (data.zones.find((z: any) => z.id === l.zone_id)?.name ||
                        "Assigned zone")
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Service zone
            <select aria-label="Service zone" name="zone_id">
              {zoneOptions}
            </select>
          </label>
          <button disabled={busy || !customer}>Save location zone</button>
        </form>
      </section>
      <section className="panel">
        <h2>Holiday and collection date changes</h2>
        {data.changes.map((h: any) => (
          <article key={h.id} className="order">
            <div>
              <h3>
                {h.original_date} → {h.replacement_date}
              </h3>
              <p>
                {h.zone_name || "Company-wide"} · {h.reason}
              </p>
            </div>
            {edit && (
              <button className="secondary" onClick={() => setChange(h)}>
                Edit date change
              </button>
            )}
          </article>
        ))}
        {edit && (
          <form
            key={(change?.id || "new") + ":" + String(change?.version || 0)}
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(async () => {
                await api("/service-calendar/changes", {
                  ...(change ? { id: change.id, version: change.version } : {}),
                  zone_id: b.get("zone_id") || null,
                  original_date: b.get("original_date"),
                  replacement_date: b.get("replacement_date"),
                  reason: b.get("reason"),
                });
                setChange(null);
                setPreview(null);
                setMessage(
                  "Date rule saved. Preview existing orders before applying it.",
                );
              });
            }}
          >
            <label>
              Rule applies to
              <select
                aria-label="Rule applies to"
                name="zone_id"
                defaultValue={change?.zone_id || ""}
              >
                {zoneOptions}
              </select>
            </label>
            <label>
              Original collection date
              <input
                type="date"
                name="original_date"
                defaultValue={change?.original_date || ""}
                required
              />
            </label>
            <label>
              Replacement date
              <input
                type="date"
                name="replacement_date"
                defaultValue={change?.replacement_date || ""}
                required
              />
            </label>
            <label>
              Reason
              <input
                name="reason"
                defaultValue={change?.reason || ""}
                required
                maxLength={2000}
              />
            </label>
            <div className="actions">
              <button disabled={busy}>
                {change ? "Save date change" : "Create date change"}
              </button>
              {change && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setChange(null)}
                >
                  Cancel date edit
                </button>
              )}
            </div>
          </form>
        )}
      </section>
      <section className="panel">
        <h2>Review existing service changes</h2>
        <p>
          A preview covers original service occurrences. Applying preserves that
          occurrence and changes only the planned collection date. Customer
          notices are queued with the committed change.
        </p>
        <form
          className="grid"
          onSubmit={(e) => {
            const b = fields(e);
            const range = {
              from: String(b.get("from")),
              through: String(b.get("through")),
              ...(b.get("zone_id")
                ? { zone_id: String(b.get("zone_id")) }
                : {}),
            };
            void act(async () =>
              setPreview({
                ...(await api(
                  "/service-calendar/preview?" + new URLSearchParams(range),
                )),
                range,
              }),
            );
          }}
        >
          <label>
            Original service from
            <input type="date" name="from" required />
          </label>
          <label>
            Original service through
            <input type="date" name="through" required />
          </label>
          <label>
            Filter zone
            <select aria-label="Filter zone" name="zone_id">
              {zoneOptions}
            </select>
          </label>
          <button disabled={busy}>Preview service changes</button>
        </form>
        {preview && (
          <>
            <h3>{preview.items.length} affected orders</h3>
            {preview.items.map((o: any) => (
              <p key={o.id}>
                <b>{o.customer_name}</b> · {o.address}
                <small>
                  {o.scheduled_date} → {o.planned_date}
                  {o.blocked ? " · " + o.blocked : " · Ready for change"}
                </small>
              </p>
            ))}
            <button
              disabled={
                busy ||
                !preview.items.length ||
                preview.items.some((o: any) => o.blocked)
              }
              onClick={() =>
                void act(async () => {
                  const r = await api("/service-calendar/apply", {
                    ...preview.range,
                    preview_hash: preview.hash,
                  });
                  setPreview(null);
                  setMessage(
                    r.changed +
                      " service dates updated. Customer notices queued.",
                  );
                })
              }
            >
              Apply reviewed service changes
            </button>
          </>
        )}
      </section>
    </>
  );
}
