import { useEffect, useState } from "react";
export function ParentOrderField({
  customerId,
  api,
}: {
  customerId: string;
  api: (p: string, b?: unknown) => Promise<any>;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [search, setSearch] = useState(""),
    [parent, setParent] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setParent(null);
    setSearch("");
    setRows([]);
  }, [customerId]);
  useEffect(() => {
    let active = true;
    if (!customerId) return;
    const timer = setTimeout(
      () =>
        void api(
          "/orders?" +
            new URLSearchParams({
              customer_id: customerId,
              search,
              limit: "100",
            }),
        )
          .then((items) => {
            if (active) {
              setRows(
                items.filter(
                  (o: any) => o.status !== "cancelled" && !o.rental_id,
                ),
              );
              setError("");
            }
          })
          .catch((e) => {
            if (active) setError(e.message);
          }),
      200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [customerId, search]);
  if (!customerId)
    return (
      <p className="muted">Select a customer to link related service work.</p>
    );
  const options =
    parent && !rows.some((r) => r.id === parent.id) ? [parent, ...rows] : rows;
  return (
    <fieldset>
      <legend>Related service (optional)</legend>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        Find parent service
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Order reference or service address"
        />
      </label>
      <label>
        Related parent order
        <select
          aria-label="Related parent order"
          name="parent_order_id"
          value={parent?.id || ""}
          onChange={(e) =>
            setParent(options.find((o) => o.id === e.target.value) || null)
          }
        >
          <option value="">Independent service order</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {"CW-O" + String(o.number).padStart(6, "0")} ·{" "}
              {o.kind.replaceAll("_", " ")} · {o.scheduled_date} · {o.address}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input
          name="depends_on_parent"
          type="checkbox"
          defaultChecked
          disabled={!parent}
        />
        Complete the parent service before this order can start
      </label>
      <small>Each service has its own agreed price and billing record.</small>
    </fieldset>
  );
}
