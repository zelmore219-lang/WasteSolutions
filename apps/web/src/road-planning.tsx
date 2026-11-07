import { useEffect, useRef, useState, FormEvent } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
type Row = Record<string, any>;
type Api = (path: string, body?: unknown) => Promise<any>;
export function RoadMap({
  stops,
  result,
  input,
}: {
  stops: Row[];
  result?: Row;
  input?: Row;
}) {
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target.current) return;
    const map = L.map(target.current, { scrollWheelZoom: false }).setView(
      [39, -98],
      4,
    );
    const bounds = L.latLngBounds([]);
    const tileUrl = import.meta.env.VITE_MAP_TILE_URL;
    if (
      tileUrl &&
      tileUrl.startsWith("https://") &&
      ["{z}", "{x}", "{y}"].every((v) => tileUrl.includes(v)) &&
      import.meta.env.VITE_MAP_ATTRIBUTION
    ) {
      const attribution = document.createElement("span");
      attribution.textContent = import.meta.env.VITE_MAP_ATTRIBUTION;
      L.tileLayer(tileUrl, {
        attribution: attribution.innerHTML,
        maxZoom: 19,
      }).addTo(map);
    }
    const ids: string[] = result?.order_ids || stops.map((s) => s.id);
    for (const stop of stops)
      if (stop.longitude !== null && stop.latitude !== null) {
        const point: L.LatLngTuple = [stop.latitude, stop.longitude];
        bounds.extend(point);
        const text = document.createElement("span");
        text.textContent =
          ids.indexOf(stop.id) +
          1 +
          ". " +
          stop.customer_name +
          " · " +
          stop.address;
        L.marker(point, {
          icon: L.divIcon({
            className: "road-stop-pin",
            html: String(ids.indexOf(stop.id) + 1),
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
        })
          .bindPopup(text)
          .addTo(map);
      }
    if (input)
      for (const [label, point] of [
        ["Start depot", input.origin],
        ["End depot", input.destination],
      ] as [string, number[]][]) {
        const latlng: L.LatLngTuple = [point[1], point[0]];
        bounds.extend(latlng);
        L.circleMarker(latlng, { radius: 7, color: "#147d64" })
          .bindTooltip(label)
          .addTo(map);
      }
    if (result?.geometry)
      for (const leg of result.geometry) {
        const points: L.LatLngTuple[] = leg.map((p: number[]) => [p[1], p[0]]);
        L.polyline(points, { color: "#1765b3", weight: 4 }).addTo(map);
        for (const point of points) bounds.extend(point);
      }
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 16 });
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(target.current);
    return () => {
      observer.disconnect();
      map.remove();
    };
  }, [stops, result, input]);
  return (
    <>
      <div
        ref={target}
        className="road-map"
        aria-label="Service pins and road route map"
        role="region"
      />
      {!import.meta.env.VITE_MAP_TILE_URL && (
        <p className="muted">
          Street basemap is not configured. Verified pins and provider road
          geometry are shown at their geographic positions.
        </p>
      )}
    </>
  );
}
export function RoadPlanningPanel({
  routeId,
  actor,
  api,
  refresh,
  close,
}: {
  routeId: string;
  actor: Row;
  api: Api;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Row | null>(null);
  async function load() {
    setData(await api("/routes/" + routeId + "/road-planning"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [routeId]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
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
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  const plan =
    selected ||
    data?.plans.find(
      (p: Row) => p.status === "ready" || p.status === "applied",
    );
  const planCurrent = Boolean(
    plan &&
    data &&
    plan.snapshot &&
    plan.snapshot.timezone === data.timezone &&
    plan.snapshot.route.version + (plan.status === "applied" ? 1 : 0) ===
      data.route.version &&
    plan.snapshot.profile.version === data.truck.version &&
    plan.snapshot.stops.length === data.stops.length &&
    plan.snapshot.stops.every((s: Row) =>
      data.stops.some(
        (o: Row) =>
          o.id === s.id &&
          o.version === s.version &&
          ["new", "assigned"].includes(o.status),
      ),
    ) &&
    plan.snapshot.locations.every((l: Row) =>
      data.stops.some(
        (s: Row) =>
          s.location_id === l.id && s.routing_version === l.routing_version,
      ),
    ),
  );
  return (
    <section className="panel road-planning-panel">
      <div className="section-title">
        <h2>Map and road planning</h2>
        <button className="secondary" onClick={close}>
          Close map
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data ? (
        <p>Loading route…</p>
      ) : (
        <>
          <h3>
            {data.route.name} · {data.route.service_date}
          </h3>
          <p>
            Verify the service entrance for each stop and the loaded truck
            profile. Plans use road routing for a non-hazardous rigid truck
            without a trailer. Drivers must still follow posted restrictions and
            site instructions.
          </p>
          <RoadMap
            stops={data.stops}
            result={planCurrent ? plan?.result : undefined}
            input={planCurrent ? plan?.input : undefined}
          />
          <details>
            <summary>
              Verify service pins (
              {data.stops.filter((s: Row) => s.longitude !== null).length}/
              {data.stops.length})
            </summary>
            {[
              ...new Map<string, Row>(
                data.stops.map((s: Row) => [s.location_id, s]),
              ).values(),
            ].map((s) => (
              <form
                key={s.location_id + ":" + s.routing_version}
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(async () => {
                    await api("/locations/" + s.location_id + "/routing-pin", {
                      longitude: Number(b.longitude),
                      latitude: Number(b.latitude),
                      note: b.note,
                      version: s.routing_version,
                    });
                    setSelected(null);
                  });
                }}
              >
                <h4>
                  {s.customer_name} · {s.address}
                </h4>
                <label>
                  Entrance longitude
                  <input
                    name="longitude"
                    type="number"
                    step="any"
                    min="-180"
                    max="180"
                    defaultValue={s.longitude ?? ""}
                    required
                  />
                </label>
                <label>
                  Entrance latitude
                  <input
                    name="latitude"
                    type="number"
                    step="any"
                    min="-85"
                    max="85"
                    defaultValue={s.latitude ?? ""}
                    required
                  />
                </label>
                <label>
                  Verification source / note
                  <input
                    name="note"
                    maxLength={2000}
                    defaultValue={s.routing_note || ""}
                    required
                  />
                </label>
                <button disabled={busy}>Save verified pin</button>
              </form>
            ))}
          </details>
          <details>
            <summary>
              Truck routing profile · {data.truck.number}
              {data.truck.version ? " · verified" : " · missing"}
            </summary>
            {data.truck.version && (
              <p>
                Verified truck: {data.truck.height_cm} cm high ×{" "}
                {data.truck.width_cm} cm wide × {data.truck.length_cm} cm long ·
                gross weight at capacity{" "}
                {data.truck.gross_weight_kg.toLocaleString()} kg · heaviest axle{" "}
                {data.truck.weight_per_axle_kg.toLocaleString()} kg.
              </p>
            )}
            {["owner", "manager"].includes(actor.role) ? (
              <form
                key={data.truck.version || 0}
                className="grid"
                onSubmit={(e) => {
                  const b = fields(e);
                  void act(async () => {
                    await api("/trucks/" + data.truck.id + "/routing-profile", {
                      height_cm: Number(b.height_cm),
                      width_cm: Number(b.width_cm),
                      length_cm: Number(b.length_cm),
                      gross_weight_kg: Number(b.gross_weight_kg),
                      weight_per_axle_kg: Number(b.weight_per_axle_kg),
                      verification_note: b.verification_note,
                      non_hazardous_rigid_truck: true,
                      version: data.truck.version || 0,
                    });
                    setSelected(null);
                  });
                }}
              >
                {(
                  [
                    ["height_cm", "Loaded height (cm)", 100, 600],
                    ["width_cm", "Width (cm)", 100, 500],
                    ["length_cm", "Length (cm)", 200, 2000],
                    [
                      "gross_weight_kg",
                      "Gross weight at capacity (kg)",
                      1000,
                      100000,
                    ],
                    [
                      "weight_per_axle_kg",
                      "Heaviest axle weight (kg)",
                      500,
                      40000,
                    ],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <label key={key}>
                    {label}
                    <input
                      name={key}
                      type="number"
                      min={min}
                      max={max}
                      defaultValue={data.truck[key] ?? ""}
                      required
                    />
                  </label>
                ))}
                <label>
                  Verification note
                  <input
                    name="verification_note"
                    maxLength={2000}
                    defaultValue={data.truck.verification_note || ""}
                    required
                  />
                </label>
                <label>
                  <input type="checkbox" required />
                  Confirmed non-hazardous rigid truck, without a trailer
                </label>
                <button disabled={busy}>Save truck routing profile</button>
              </form>
            ) : (
              <p>
                Ask an owner or manager to verify the truck dimensions and
                loaded weights.
              </p>
            )}
          </details>
          <h3>Request a road preview</h3>
          {!data.configured && (
            <p className="notice">
              Road routing is not configured. A server routing key and region
              are required before requesting provider results.
            </p>
          )}
          <form
            className="grid"
            onSubmit={(e) => {
              const b = fields(e);
              void act(async () => {
                const result = await api("/routes/" + routeId + "/road-plans", {
                  version: data.route.version,
                  origin: [Number(b.origin_lon), Number(b.origin_lat)],
                  destination: [
                    Number(b.destination_lon),
                    Number(b.destination_lat),
                  ],
                  departure_time: new Date(
                    String(b.departure_time),
                  ).toISOString(),
                  verified_depots: true,
                  optimize: b.optimize === "on",
                });
                setSelected(result);
              });
            }}
          >
            {(
              [
                ["origin_lon", "Start depot longitude", -180, 180],
                ["origin_lat", "Start depot latitude", -85, 85],
                ["destination_lon", "End depot longitude", -180, 180],
                ["destination_lat", "End depot latitude", -85, 85],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  step="any"
                  min={min}
                  max={max}
                  name={key}
                  required
                />
              </label>
            ))}
            <label>
              Departure in your device timezone
              <input type="datetime-local" name="departure_time" required />
            </label>
            <label>
              <input type="checkbox" name="optimize" />
              Optimize stop order (unlinked work only)
            </label>
            <label>
              <input type="checkbox" required />I verified both depot
              coordinates and the truck configuration for this trip
            </label>
            <button disabled={busy || !data.configured}>
              Calculate road preview
            </button>
          </form>
          {plan && (
            <div className="road-preview">
              <h3>Road preview · {plan.status}</h3>
              {plan.status === "ready" && !planCurrent && (
                <p className="notice">
                  Route, pins, or truck details changed. Request a fresh road
                  preview.
                </p>
              )}
              {plan.error && <p role="alert">{plan.error}</p>}
              {plan.result && (
                <>
                  <p>
                    {(plan.result.distance_m / 1609.344).toFixed(1)} road miles
                    · {Math.ceil(plan.result.duration_s / 60)} minutes estimated
                    driving · Amazon Location
                  </p>
                  <p>
                    Driving time excludes work at stops; the timing table, when
                    available, adds saved service durations and arrival-window
                    waiting. Preview expires after 30 minutes.
                  </p>
                  {plan.result.schedule && (
                    <div>
                      <h4>Estimated service timing</h4>
                      <p>
                        Company timezone: {plan.result.timezone}. Includes
                        recorded service durations and waiting for arrival
                        windows; excludes breaks and unrecorded delays.
                      </p>
                      <table>
                        <thead>
                          <tr>
                            <th>Stop</th>
                            <th>Arrive</th>
                            <th>Start service</th>
                            <th>Leave</th>
                            <th>Wait</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.result.schedule.map((stop: Row) => (
                            <tr key={stop.order_id}>
                              <td>
                                {data.stops.find(
                                  (s: Row) => s.id === stop.order_id,
                                )?.customer_name || stop.order_id}
                              </td>
                              {[
                                stop.arrival_at,
                                stop.service_start_at,
                                stop.departure_at,
                              ].map((value, index) => (
                                <td key={index}>
                                  {new Date(value).toLocaleString(undefined, {
                                    timeZone: plan.result.timezone,
                                    timeZoneName: "short",
                                  })}
                                </td>
                              ))}
                              <td>{Math.ceil(stop.wait_seconds / 60)} min</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p>
                        Estimated return:{" "}
                        {new Date(plan.result.return_at).toLocaleString(
                          undefined,
                          {
                            timeZone: plan.result.timezone,
                            timeZoneName: "short",
                          },
                        )}{" "}
                        · {Math.ceil(plan.result.planning_duration_s / 60)}{" "}
                        minutes including planned work and waiting
                      </p>
                    </div>
                  )}
                  <ol>
                    {plan.result.order_ids.map((id: string) => (
                      <li key={id}>
                        {data.stops.find((s: Row) => s.id === id)
                          ?.customer_name || id}
                      </li>
                    ))}
                  </ol>
                  {plan.status === "ready" && planCurrent && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api("/road-plans/" + plan.id + "/apply", {});
                          setSelected({ ...plan, status: "applied" });
                        })
                      }
                    >
                      Apply preview stop order
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {data.plans
            .filter((p: Row) => p.status === "failed" || p.status === "pending")
            .map((p: Row) => (
              <p key={p.id}>
                {p.status === "pending"
                  ? "Road preview is pending. A stopped request is not automatically charged again; refresh or explicitly request a new preview."
                  : p.error}
              </p>
            ))}
        </>
      )}
    </section>
  );
}
