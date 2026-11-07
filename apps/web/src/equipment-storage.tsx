import { FormEvent, useEffect, useState } from "react";
type Row = Record<string, any>;
type Api = (path: string, body?: unknown) => Promise<any>;
const position = (c: Row) =>
  c.status === "on_truck"
    ? "Truck " + (c.carrier_number || c.carried_by_truck_id)
    : c.status === "deployed"
      ? c.address || "Customer location"
      : c.status === "awaiting_disposal"
        ? "Loaded disposal hold"
        : c.yard_name || "Unspecified yard — reconcile location";
export function EquipmentStoragePanel({
  actor,
  customers,
  api,
}: {
  actor: Row;
  customers: Row[];
  api: Api;
}) {
  const [yards, setYards] = useState<Row[]>([]),
    [containers, setContainers] = useState<Row[]>([]),
    [trucks, setTrucks] = useState<Row[]>([]),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Row | null>(null),
    [customer, setCustomer] = useState(""),
    [locations, setLocations] = useState<Row[]>([]),
    [editingYard, setEditingYard] = useState<Row | null>(null),
    [destination, setDestination] = useState("yard"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const canEdit = ["owner", "manager", "dispatcher"].includes(actor.role),
    canRetire = ["owner", "manager"].includes(actor.role);
  async function load() {
    const [yards, stock, fleet] = await Promise.all([
      api("/equipment/yards"),
      api("/containers"),
      api("/fleet/trucks"),
    ]);
    setYards(yards);
    setContainers(stock);
    setTrucks(fleet);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [actor.id]);
  useEffect(() => {
    let current = true;
    setDetail(null);
    if (selected)
      void api("/equipment/" + selected + "/history")
        .then((d) => {
          if (current) setDetail(d);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [selected]);
  useEffect(() => {
    let current = true;
    setLocations([]);
    if (customer)
      void api("/customers/" + customer + "/locations")
        .then((d) => {
          if (current) setLocations(d);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [customer]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      if (selected) setDetail(await api("/equipment/" + selected + "/history"));
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
  function physical(b: Record<string, FormDataEntryValue>) {
    return {
      version: detail!.version,
      observed_number: b.observed_number,
      reason: b.reason,
    };
  }
  function target(b: Record<string, FormDataEntryValue>) {
    return {
      yard_id: destination === "yard" ? b.destination_id : null,
      truck_id: destination === "truck" ? b.destination_id : null,
    };
  }
  const destinations = (
    <>
      <label>
        Destination type
        <select
          aria-label="Equipment destination type"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="yard">Company yard</option>
          <option value="truck">Truck stock</option>
        </select>
      </label>
      <label>
        Equipment destination
        <select
          key={destination}
          aria-label="Equipment destination"
          name="destination_id"
          required
        >
          <option value="">Choose the actual destination</option>
          {(destination === "yard"
            ? yards.filter((y) => y.active)
            : trucks.filter((t) => t.status === "available")
          ).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name || d.number}
            </option>
          ))}
        </select>
      </label>
    </>
  );
  const confirmation = (
    <>
      <label>
        Observed equipment number
        <input
          name="observed_number"
          maxLength={80}
          required
          autoComplete="off"
        />
      </label>
      <label>
        Equipment movement reason
        <input name="reason" maxLength={2000} required />
      </label>
    </>
  );
  return (
    <>
      <section className="panel">
        <div className="section-title">
          <h2>Equipment yards and truck stock</h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(async () => {})}
          >
            Refresh equipment stock
          </button>
        </div>
        <p>
          Record actual empty-equipment movements and cart/commercial
          placements. Roll-off delivery, pickup and loaded disposal holds stay
          in their rental workflows. Older equipment without a recorded yard
          remains unspecified until physically reconciled.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <label>
          Review equipment
          <select
            aria-label="Review equipment"
            value={selected}
            disabled={busy}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a container, cart or trailer</option>
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} · {c.kind} · {c.status}
              </option>
            ))}
          </select>
        </label>
        {detail && (
          <>
            <h3>
              {detail.number} · {detail.kind}
            </h3>
            <p>
              {detail.status} · {position(detail)} · version {detail.version}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Recorded</th>
                  <th>Movement</th>
                  <th>Observed number</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {detail.events.map((e: Row) => (
                  <tr key={e.id}>
                    <td>{new Date(e.recorded_at).toLocaleString()}</td>
                    <td>{e.action}</td>
                    <td>
                      {e.observed_number || "No separate number observation"}
                    </td>
                    <td>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.next_cursor && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const page = await api(
                        "/equipment/" +
                          detail.id +
                          "/events?before=" +
                          detail.next_cursor,
                      );
                      setDetail((current) =>
                        current && current.id === detail.id
                          ? {
                              ...current,
                              events: [...current.events, ...page.events],
                              next_cursor: page.next_cursor,
                            }
                          : current,
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                Load older equipment events
              </button>
            )}
            <p className="muted">
              Immutable storage events, newest first. The latest 50 placement
              records are shown below; older placements remain in the movement
              history. Original rental service proof remains in the rental
              history.
            </p>
            {detail.deployments.map((d: Row) => (
              <p key={d.id}>
                {d.record_kind === "legacy_observation"
                  ? "Legacy placement observed"
                  : "Placement"}{" "}
                {new Date(d.placed_at).toLocaleDateString()} ·{" "}
                {d.recovered_at
                  ? "recovered " + new Date(d.recovered_at).toLocaleDateString()
                  : "currently deployed"}
                {d.order_id ? " · Linked service " + d.order_id : ""}
              </p>
            ))}
          </>
        )}
      </section>
      {detail && canEdit && (
        <>
          {canRetire &&
            ["cart", "commercial"].includes(detail.kind) &&
            detail.status === "deployed" &&
            !detail.deployments.some((d: Row) => !d.recovered_at) && (
              <section className="panel">
                <h2>Verify an existing legacy placement</h2>
                <p>
                  Physically confirm this equipment is at {position(detail)}.
                  This records today's observation and preserves the unknown
                  original installation date. It does not move equipment or
                  create a charge. A verified observation permits subsequent
                  recovery.
                </p>
                <form
                  className="grid"
                  key={detail.id + ":" + detail.version + ":observe"}
                  onSubmit={(e) => {
                    const b = fields(e);
                    void act(() =>
                      api("/equipment/" + detail.id + "/observe-legacy", {
                        ...physical(b),
                        confirm_location_id: detail.location_id,
                      }),
                    );
                  }}
                >
                  {confirmation}
                  <button disabled={busy}>
                    Record legacy placement observation
                  </button>
                </form>
              </section>
            )}
          {["yard", "on_truck", "maintenance", "retired"].includes(
            detail.status,
          ) && (
            <section className="panel">
              <h2>Record equipment relocation</h2>
              <form
                key={detail.id + ":" + detail.version + ":move"}
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/equipment/" + detail.id + "/move", {
                      ...physical(b),
                      ...target(b),
                    }),
                  );
                }}
              >
                {confirmation}
                {destinations}
                <button disabled={busy}>Record equipment move</button>
              </form>
            </section>
          )}
          {["cart", "commercial"].includes(detail.kind) &&
            ["yard", "on_truck"].includes(detail.status) && (
              <section className="panel">
                <h2>Record actual cart/commercial placement</h2>
                <p>
                  This records inventory placement; it does not create a charge
                  or a service invoice. An optional linked order must already be
                  completed for this same customer and address.
                </p>
                <form
                  key={detail.id + ":" + detail.version + ":place"}
                  className="grid"
                  onSubmit={(e) => {
                    const b = fields(e);
                    void act(() =>
                      api("/equipment/" + detail.id + "/place", {
                        ...physical(b),
                        customer_id: customer,
                        location_id: b.location_id,
                        order_id: b.order_id || undefined,
                      }),
                    );
                  }}
                >
                  {confirmation}
                  <label>
                    Placement customer
                    <select
                      aria-label="Placement customer"
                      required
                      value={customer}
                      onChange={(e) => setCustomer(e.target.value)}
                    >
                      <option value="">Choose an active customer</option>
                      {customers
                        .filter((c) => c.status === "active")
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Placement service location
                    <select
                      key={customer}
                      aria-label="Placement service location"
                      name="location_id"
                      required
                    >
                      <option value="">Choose a service location</option>
                      {locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.address}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Completed service ID (optional)
                    <input name="order_id" />
                  </label>
                  <button disabled={busy}>Record equipment placement</button>
                </form>
              </section>
            )}
          {["cart", "commercial"].includes(detail.kind) &&
            detail.status === "deployed" && (
              <section className="panel">
                <h2>Record cart/commercial recovery</h2>
                <form
                  key={detail.id + ":" + detail.version + ":recover"}
                  className="grid"
                  onSubmit={(e) => {
                    const b = fields(e);
                    void act(() =>
                      api("/equipment/" + detail.id + "/recover", {
                        ...physical(b),
                        ...target(b),
                      }),
                    );
                  }}
                >
                  {confirmation}
                  {destinations}
                  <button disabled={busy}>Record equipment recovery</button>
                </form>
              </section>
            )}
          {["yard", "maintenance", "retired"].includes(detail.status) && (
            <section className="panel">
              <h2>Equipment maintenance and retirement</h2>
              <form
                key={detail.id + ":" + detail.version + ":status"}
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(() =>
                    api("/equipment/" + detail.id + "/status", {
                      ...physical(b),
                      status: b.status,
                    }),
                  );
                }}
              >
                {confirmation}
                <label>
                  Equipment availability
                  <select name="status" aria-label="Equipment availability">
                    <option value="yard">Return to available yard stock</option>
                    <option value="maintenance">Hold for maintenance</option>
                    {canRetire && (
                      <option value="retired">Retire equipment</option>
                    )}
                  </select>
                </label>
                <p>
                  Existing rental reservations must be reviewed and released
                  first. Retirement and reactivation require an owner or
                  manager.
                </p>
                <button disabled={busy}>Save equipment availability</button>
              </form>
            </section>
          )}
        </>
      )}
      <section className="panel">
        <h2>Company equipment yards</h2>
        {yards.map((y) => (
          <article className="order" key={y.id}>
            <div>
              <h3>{y.name}</h3>
              <p>
                {y.address} · {y.active ? "Active" : "Inactive"}
              </p>
            </div>
            {canEdit && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setEditingYard(y)}
              >
                Edit equipment yard
              </button>
            )}
          </article>
        ))}
        {canEdit && (
          <form
            key={editingYard?.id + ":" + editingYard?.version}
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(async () => {
                if (editingYard)
                  await api("/equipment/yards/" + editingYard.id + "/update", {
                    name: b.name,
                    address: b.address,
                    active: b.active === "on",
                    version: editingYard.version,
                    reason: b.reason,
                  });
                else
                  await api("/equipment/yards", {
                    name: b.name,
                    address: b.address,
                  });
                setEditingYard(null);
              });
            }}
          >
            <h3>{editingYard ? "Edit yard" : "Create equipment yard"}</h3>
            <label>
              Equipment yard name
              <input
                name="name"
                maxLength={200}
                required
                defaultValue={editingYard?.name || ""}
              />
            </label>
            <label>
              Equipment yard address
              <input
                name="address"
                maxLength={2000}
                required
                defaultValue={editingYard?.address || ""}
              />
            </label>
            {editingYard && (
              <>
                <label>
                  <input
                    type="checkbox"
                    name="active"
                    defaultChecked={editingYard.active}
                  />
                  Yard active
                </label>
                <label>
                  Yard change reason
                  <input name="reason" maxLength={2000} required />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditingYard(null)}
                >
                  Cancel yard edit
                </button>
              </>
            )}
            <button disabled={busy}>Save equipment yard</button>
          </form>
        )}
      </section>
    </>
  );
}
