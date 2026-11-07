import { useEffect, useState, useRef } from "react";
const add = (date: string, days: number) =>
  new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
function weekOf(date: string) {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  return add(date, -((day + 6) % 7));
}
export function DispatchCalendar({
  actor,
  resources,
  api,
  refresh,
}: {
  actor: any;
  resources: { drivers: any[]; trucks: any[] };
  api: (p: string, b?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const sequence = useRef(0),
    weekChanged = useRef(false),
    dragSnapshot = useRef<any>(null);
  const [week, setWeek] = useState(
      weekOf(new Date().toISOString().slice(0, 10)),
    ),
    [orders, setOrders] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [mode, setMode] = useState("keep"),
    [driver, setDriver] = useState(""),
    [truck, setTruck] = useState(""),
    [drag, setDrag] = useState<string | null>(null);
  const dispatch = ["owner", "manager", "dispatcher"].includes(actor.role);
  const days = Array.from({ length: 7 }, (_, d) => add(week, d));
  async function load() {
    const request = ++sequence.current;
    const rows = await api(
      "/orders?" +
        new URLSearchParams({
          from_date: week,
          through_date: add(week, 6),
          limit: "500",
          sort: "date",
        }),
    );
    if (request === sequence.current) setOrders(rows);
  }
  useEffect(() => {
    let active = true;
    void api("/company")
      .then((c) => {
        if (active && !weekChanged.current)
          setWeek(
            weekOf(
              new Intl.DateTimeFormat("en-CA", { timeZone: c.timezone }).format(
                new Date(),
              ),
            ),
          );
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [actor.id]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [week, actor]);
  async function move(order: any, date: string) {
    if (!dispatch || busy) return;
    const driverId =
        mode === "keep"
          ? order.driver_id
          : mode === "unassign"
            ? null
            : driver || null,
      truckId =
        mode === "keep"
          ? order.truck_id
          : mode === "unassign"
            ? null
            : truck || null;
    if (mode === "assign" && (!driverId || !truckId)) {
      setError("Select a driver and truck for the calendar move.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/orders/" + order.id + "/calendar-move", {
        scheduled_date: date,
        driver_id: driverId,
        truck_id: truckId,
        version: order.version,
      });
      await refresh();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setDrag(null);
    }
  }
  return (
    <section className="panel">
      <div className="section-title">
        <h2>Dispatch calendar</h2>
        <div className="actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              weekChanged.current = true;
              setWeek(add(week, -7));
            }}
          >
            Previous service week
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              weekChanged.current = true;
              setWeek(add(week, 7));
            }}
          >
            Next service week
          </button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="grid">
        <label>
          Week containing
          <input
            type="date"
            value={week}
            onChange={(e) => {
              if (e.target.value) {
                weekChanged.current = true;
                setWeek(weekOf(e.target.value));
              }
            }}
          />
        </label>
        {dispatch && (
          <>
            <label>
              Calendar assignment
              <select
                aria-label="Calendar assignment"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="keep">Keep existing driver and truck</option>
                <option value="unassign">Return to unassigned work</option>
                <option value="assign">Assign selected driver and truck</option>
              </select>
            </label>
            {mode === "assign" && (
              <>
                <label>
                  Calendar driver
                  <select
                    aria-label="Calendar driver"
                    value={driver}
                    onChange={(e) => setDriver(e.target.value)}
                  >
                    <option value="">Choose driver</option>
                    {resources.drivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Calendar truck
                  <select
                    aria-label="Calendar truck"
                    value={truck}
                    onChange={(e) => setTruck(e.target.value)}
                  >
                    <option value="">Choose truck</option>
                    {resources.trucks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.number}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </>
        )}
      </div>
      <p className="muted">
        Drag unstarted service to a date, or use its Move service controls. The
        date and assignment are saved together. Rental dates and routed stops
        use their respective workflows.
      </p>
      {orders.length === 500 && (
        <p className="notice">
          Showing up to 500 service orders for this week. Use the list's search
          and filters for additional work.
        </p>
      )}
      <div className="dispatch-calendar">
        {days.map((date) => (
          <section
            className={"calendar-day" + (drag ? " drop-target" : "")}
            key={date}
            data-date={date}
            onDragOver={(e) => {
              if (dispatch) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain");
              const order =
                dragSnapshot.current?.id === id ? dragSnapshot.current : null;
              if (order) void move(order, date);
            }}
          >
            <h3>
              {new Intl.DateTimeFormat("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              }).format(new Date(date + "T12:00:00Z"))}
            </h3>
            {dispatch && (
              <div
                className="calendar-drop-zone"
                aria-label={"Drop service on " + date}
              >
                Drop service here
              </div>
            )}
            <small>
              {orders.filter((o) => o.scheduled_date === date).length} service
              orders
            </small>
            {orders
              .filter((o) => o.scheduled_date === date)
              .map((o) => {
                const movable =
                  dispatch &&
                  !o.rental_id &&
                  !o.route_id &&
                  ["new", "assigned", "failed"].includes(o.status);
                return (
                  <article
                    className="calendar-order"
                    key={o.id}
                    draggable={movable && !busy}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", o.id);
                      dragSnapshot.current = { ...o };
                      setDrag(o.id);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      dragSnapshot.current = null;
                    }}
                  >
                    {movable && (
                      <div className="calendar-drag-handle" draggable={!busy}>
                        ⠿ Drag service card
                      </div>
                    )}
                    <span className="badge">
                      {o.status.replaceAll("_", " ")}
                    </span>
                    <h4>{o.customer_name}</h4>
                    <p>
                      {o.kind.replaceAll("_", " ")} · {o.priority}
                    </p>
                    <small>{o.address}</small>
                    <small>
                      {o.driver_name || "Unassigned"} ·{" "}
                      {o.truck_number || "No truck"}
                    </small>
                    <small>{"CW-O" + String(o.number).padStart(6, "0")}</small>
                    {o.route_id && (
                      <small>Routed stop — edit through its route</small>
                    )}
                    {movable && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void move(
                            o,
                            String(new FormData(e.currentTarget).get("date")),
                          );
                        }}
                      >
                        <label>
                          Move to service day
                          <select
                            aria-label="Move to service day"
                            name="date"
                            defaultValue={o.scheduled_date}
                          >
                            {days.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button className="secondary" disabled={busy}>
                          Move service
                        </button>
                      </form>
                    )}
                  </article>
                );
              })}
          </section>
        ))}
      </div>
    </section>
  );
}
