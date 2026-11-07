import { ProviderRefundTools } from "./provider-refunds";
import { useEffect, useState, useRef, FormEvent } from "react";
type Row = Record<string, any>;
type Props = {
  tab: string;
  actor: Row;
  api: (p: string, b?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
};
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
function cents(v: unknown) {
  const s = String(v || "");
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw Error("Enter dollars with up to two decimal places");
  const [d, f = ""] = s.split(".");
  return Number(d) * 100 + Number(f.padEnd(2, "0"));
}
function form(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget));
}
export function BillingPanel({ tab, actor, api, refresh }: Props) {
  const sequence = useRef(0);
  const [expenseMode, setExpenseMode] = useState("paid"),
    [expenseDetail, setExpenseDetail] = useState<Row | null>(null);
  const [items, setItems] = useState<Row[]>([]),
    [detail, setDetail] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const finance = ["owner", "manager", "accountant"].includes(actor.role);
  const path =
    tab === "Expenses"
      ? "/expenses"
      : tab === "Credits"
        ? "/credits"
        : tab === "Notifications"
          ? "/notifications"
          : "/invoices";
  async function load() {
    const request = ++sequence.current;
    const rows = await api(path);
    const nextDetail = detail ? await api("/invoices/" + detail.id) : null;
    if (request !== sequence.current) return;
    setItems(rows);
    if (nextDetail) setDetail(nextDetail);
  }
  useEffect(() => {
    setDetail(null);
    setExpenseDetail(null);
  }, [tab, actor.id]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [tab, actor]);
  async function viewBill(id: string) {
    setBusy(true);
    setError("");
    try {
      setExpenseDetail(await api("/expenses/" + id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      await load();
      if (detail) setDetail(await api(`/invoices/${detail.id}`));
      if (expenseDetail)
        setExpenseDetail(await api("/expenses/" + expenseDetail.id));
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
      <section className="panel">
        <div className="section-title">
          <h2>{tab === "Invoices" ? "Invoice register" : tab}</h2>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void act(async () => {})}
          >
            Refresh
          </button>
        </div>
        {!items.length ? (
          <p className="empty">No {tab.toLowerCase()} yet.</p>
        ) : tab === "Invoices" ? (
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Total</th>
                <th>Balance due</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>CW-{String(i.number).padStart(6, "0")}</td>
                  <td>{i.customer_name}</td>
                  <td>{money(Number(i.net_amount_cents ?? i.amount_cents))}</td>
                  <td>{money(Number(i.balance_cents))}</td>
                  <td>
                    <span className="badge">{i.status}</span>
                  </td>
                  <td>
                    <button
                      className="secondary"
                      onClick={() =>
                        void act(async () => {
                          setDetail(await api(`/invoices/${i.id}`));
                        })
                      }
                    >
                      View invoice
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "Expenses" ? (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Vendor</th>
                <th>Category</th>
                <th>Truck</th>
                <th>Amount</th>
                <th>Reference</th>
                <th>Unpaid</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>{e.expense_date}</td>
                  <td>{e.vendor}</td>
                  <td>{e.category}</td>
                  <td>{e.truck_number || "—"}</td>
                  <td>{money(e.amount_cents)}</td>
                  <td>{e.reference}</td>
                  <td>
                    {money(Number(e.balance_cents))}
                    {e.due_date && <small>Due {e.due_date}</small>}
                  </td>
                  <td>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void viewBill(e.id)}
                    >
                      Review bill
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "Credits" ? (
          items.map((c) => (
            <article className="order" key={c.id}>
              <div>
                <h3>{c.customer_name}</h3>
                <p>
                  {money(c.remaining_cents)} remaining of{" "}
                  {money(c.original_cents)}
                </p>
                <small>{c.reason}</small>
              </div>
              {finance && (
                <ProviderRefundTools api={api} refresh={load} credit={c} />
              )}
              {finance && c.remaining_cents > 0 && (
                <form
                  className="actions"
                  onSubmit={(e) => {
                    const b = form(e);
                    void act(() =>
                      api(`/credits/${c.id}/apply`, {
                        invoice_id: b.invoice_id,
                        amount_cents: cents(b.amount_cents),
                      }),
                    );
                  }}
                >
                  <label>
                    Invoice ID
                    <input name="invoice_id" required />
                  </label>
                  <label>
                    Apply amount ($)
                    <input name="amount_cents" inputMode="decimal" required />
                  </label>
                  <button disabled={busy}>Apply credit</button>
                </form>
              )}
              {finance && c.remaining_cents > 0 && (
                <form
                  className="actions"
                  onSubmit={(e) => {
                    const b = form(e);
                    void act(() =>
                      api("/credits/" + c.id + "/refunds", {
                        ...b,
                        amount_cents: cents(b.amount_cents),
                      }),
                    );
                  }}
                >
                  <label>
                    Credit refund ($)
                    <input name="amount_cents" inputMode="decimal" required />
                  </label>
                  <label>
                    Refund method
                    <select name="method" aria-label="Refund method">
                      <option value="check">Check</option>
                      <option value="cash">Cash</option>
                    </select>
                  </label>
                  <label>
                    Refund receipt reference
                    <input name="reference" required />
                  </label>
                  <label>
                    Reason for credit refund
                    <input name="reason" required />
                  </label>
                  <button className="secondary" disabled={busy}>
                    Record account-credit refund already issued
                  </button>
                </form>
              )}
            </article>
          ))
        ) : (
          items.map((n) => (
            <article className="order" key={n.id}>
              <div>
                <span className="badge">{n.read_at ? "Read" : "Unread"}</span>
                <h3>{n.subject}</h3>
                <p>{n.message}</p>
                <small>{new Date(n.created_at).toLocaleString()}</small>
              </div>
              {actor.role === "customer" && !n.read_at && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() => api(`/notifications/${n.id}/read`, {}))
                  }
                >
                  Mark as read
                </button>
              )}
            </article>
          ))
        )}
      </section>
      {tab === "Expenses" && finance && (
        <section className="panel">
          <h2>Record business expense or vendor bill</h2>
          <form
            className="grid"
            onSubmit={(e) => {
              const b = form(e);
              void act(() =>
                api("/expenses", {
                  ...b,
                  amount_cents: cents(b.amount_cents),
                  order_id: b.order_id || undefined,
                  route_id: b.route_id || undefined,
                }),
              );
            }}
          >
            <label>
              Payment status
              <select
                name="payment_mode"
                aria-label="Payment status"
                value={expenseMode}
                onChange={(e) => setExpenseMode(e.target.value)}
              >
                <option value="paid">Already paid receipt</option>
                <option value="payable">Unpaid vendor bill</option>
              </select>
            </label>
            {expenseMode === "payable" && (
              <label>
                Bill due date
                <input name="due_date" type="date" required />
              </label>
            )}
            <label>
              Vendor
              <input name="vendor" required />
            </label>
            <label>
              Category
              <select name="category" aria-label="Category">
                {[
                  "fuel",
                  "repair",
                  "maintenance",
                  "disposal",
                  "office",
                  "other",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Expense date
              <input name="expense_date" type="date" required />
            </label>
            <label>
              Amount ($)
              <input name="amount_cents" inputMode="decimal" required />
            </label>
            <label>
              Receipt or reference
              <input name="reference" required />
            </label>
            <label>
              Service order ID (optional cost attribution)
              <input name="order_id" />
            </label>
            <label>
              Route ID (optional cost attribution)
              <input name="route_id" />
            </label>
            <p className="muted">
              Attribute this full expense to one service order or one route.
              Leave both blank for unallocated overhead. Vendor credits follow
              the original attribution. This does not create another expense or
              allocate costs by estimate.
            </p>
            <button disabled={busy}>Record expense</button>
          </form>
        </section>
      )}
      {expenseDetail && (
        <section className="panel">
          <div className="section-title">
            <h2>Vendor bill · {expenseDetail.vendor}</h2>
            <button
              className="secondary"
              onClick={() => setExpenseDetail(null)}
            >
              Close bill
            </button>
          </div>
          <p>
            {expenseDetail.reference} · {expenseDetail.expense_date} ·{" "}
            {expenseDetail.payment_mode === "paid"
              ? "Recorded as paid"
              : "Due " + expenseDetail.due_date}
          </p>
          <p>
            Original {money(expenseDetail.amount_cents)} · Credited{" "}
            {money(Number(expenseDetail.credited_cents || 0))} · Unpaid{" "}
            {money(Number(expenseDetail.balance_cents))}
          </p>
          {(expenseDetail.order_id || expenseDetail.route_id) && (
            <p>
              Cost attribution:{" "}
              {expenseDetail.order_id
                ? "Service order " + expenseDetail.order_id
                : "Route " + expenseDetail.route_id}
            </p>
          )}
          {expenseDetail.payments.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Payment date</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Correction</th>
                </tr>
              </thead>
              <tbody>
                {expenseDetail.payments.map((p: Row) => (
                  <tr key={p.id}>
                    <td>{p.payment_date}</td>
                    <td>{p.method}</td>
                    <td>{p.reference}</td>
                    <td>{money(p.amount_cents)}</td>
                    <td>
                      {p.reversal_id ? (
                        <span>
                          Reversed {p.reversal_date} · {p.reversal_reference} ·{" "}
                          {p.reversal_reason}
                        </span>
                      ) : (
                        <form
                          className="grid"
                          onSubmit={(e) => {
                            const b = form(e);
                            void act(() =>
                              api(
                                "/expenses/" +
                                  expenseDetail.id +
                                  "/payments/" +
                                  p.id +
                                  "/reverse",
                                b,
                              ),
                            );
                          }}
                        >
                          <label>
                            Payment reversal date
                            <input name="reversal_date" type="date" required />
                          </label>
                          <label>
                            Payment reversal reference
                            <input name="reference" maxLength={200} required />
                          </label>
                          <label>
                            Reason for payment reversal
                            <input name="reason" maxLength={2000} required />
                          </label>
                          <small>
                            Record a voided or returned payment. This reopens
                            the bill and records returned cash; it does not move
                            money.
                          </small>
                          <button className="secondary" disabled={busy}>
                            Record bill payment reversal
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {expenseDetail.credits?.length > 0 && (
            <div>
              <h3>Vendor credits</h3>
              {expenseDetail.credits.map((c: Row) => (
                <p key={c.id}>
                  {c.credit_date} · {money(c.amount_cents)} · {c.reference} ·{" "}
                  {c.reason}
                </p>
              ))}
            </div>
          )}
          {expenseDetail.payment_mode === "payable" &&
            Number(expenseDetail.balance_cents) > 0 && (
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = form(e);
                  void act(() =>
                    api("/expenses/" + expenseDetail.id + "/credits", {
                      ...b,
                      amount_cents: cents(b.amount_cents),
                    }),
                  );
                }}
              >
                <h3>Record vendor credit</h3>
                <label>
                  Vendor credit amount ($)
                  <input name="amount_cents" inputMode="decimal" required />
                </label>
                <label>
                  Vendor credit date
                  <input name="credit_date" type="date" required />
                </label>
                <label>
                  Vendor credit reference
                  <input name="reference" maxLength={200} required />
                </label>
                <label>
                  Reason for vendor credit
                  <input name="reason" maxLength={2000} required />
                </label>
                <p className="muted">
                  Reduces the unpaid bill and reverses its expense. Credits
                  cannot exceed the unpaid amount; this does not record a vendor
                  cash refund.
                </p>
                <button disabled={busy}>Record vendor credit</button>
              </form>
            )}
          {Number(expenseDetail.balance_cents) > 0 && (
            <form
              className="grid"
              onSubmit={(e) => {
                const b = form(e);
                void act(() =>
                  api("/expenses/" + expenseDetail.id + "/payments", {
                    ...b,
                    amount_cents: cents(b.amount_cents),
                  }),
                );
              }}
            >
              <label>
                Bill payment amount ($)
                <input name="amount_cents" inputMode="decimal" required />
              </label>
              <label>
                Bill payment date
                <input name="payment_date" type="date" required />
              </label>
              <label>
                Bill payment method
                <select name="method" aria-label="Bill payment method">
                  <option value="check">Check</option>
                  <option value="cash">Cash</option>
                  <option value="bank_transfer">Recorded bank transfer</option>
                </select>
              </label>
              <label>
                Bill payment reference
                <input name="reference" maxLength={200} required />
              </label>
              <p className="muted">
                Record a payment already made. This does not transfer money or
                send a check.
              </p>
              <button disabled={busy}>Record bill payment</button>
            </form>
          )}
        </section>
      )}
      {detail && (
        <section className="panel">
          <div className="section-title">
            <h2>
              Invoice CW-{String(detail.number).padStart(6, "0")} ·{" "}
              {detail.customer_name}
            </h2>
            <button className="secondary" onClick={() => setDetail(null)}>
              Close invoice
            </button>
          </div>
          <p>
            Total:{" "}
            <b>
              {money(Number(detail.net_amount_cents ?? detail.amount_cents))}
            </b>{" "}
            · Due: {detail.due_date} ·{" "}
            <span className="badge">{detail.status}</span>
          </p>
          <small>Invoice ID: {detail.id}</small>
          {detail.lines.map((l: Row) => (
            <p key={l.id}>
              {l.description} · {money(l.amount_cents)}
            </p>
          ))}
          {detail.adjustments?.map((adjustment: Row) => (
            <p key={adjustment.id}>
              {adjustment.kind === "credit" ? "Credit memo" : "Late fee"}:{" "}
              {money(adjustment.amount_cents)} · {adjustment.reason}
            </p>
          ))}
          {Number(detail.credit_transferred_cents) > 0 && (
            <p>
              Transferred to customer account credit:{" "}
              {money(Number(detail.credit_transferred_cents))}
            </p>
          )}
          {finance && detail.status !== "void" && (
            <>
              <h3>Issue invoice credit</h3>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = form(e);
                  void act(() =>
                    api("/invoices/" + detail.id + "/credits", {
                      amount_cents: cents(b.amount_cents),
                      reason: b.reason,
                    }),
                  );
                }}
              >
                <label>
                  Credit amount ($)
                  <input name="amount_cents" inputMode="decimal" required />
                </label>
                <label>
                  Credit reason
                  <input name="reason" required />
                </label>
                <button className="secondary" disabled={busy}>
                  Issue reviewed invoice credit
                </button>
              </form>
            </>
          )}
          <h3>Payment receipts</h3>
          {detail.payments.length === 0 ? (
            <p>No payments yet.</p>
          ) : (
            detail.payments.map((p: Row) => (
              <article className="order" key={p.id}>
                <div>
                  <p>
                    {money(p.amount_cents)} · {p.method} ·{" "}
                    {new Date(p.paid_at).toLocaleDateString()}
                  </p>
                  <small>
                    Reference: {p.reference} · Refunded:{" "}
                    {money(p.refunded_cents)}
                  </small>
                </div>
                {finance && p.method === "stripe" && (
                  <ProviderRefundTools
                    api={api}
                    refresh={async () => {
                      setDetail(await api("/invoices/" + detail.id));
                      await load();
                    }}
                    payment={p}
                  />
                )}
                {finance && <small>Recorded payment ID: {p.id}</small>}
                {finance &&
                  ["cash", "check"].includes(p.method) &&
                  p.amount_cents > p.refunded_cents && (
                    <form
                      className="actions"
                      onSubmit={(e) => {
                        const b = form(e);
                        void act(() =>
                          api(`/payments/${p.id}/refunds`, {
                            ...b,
                            amount_cents: cents(b.amount_cents),
                          }),
                        );
                      }}
                    >
                      <label>
                        Refund amount ($)
                        <input
                          name="amount_cents"
                          inputMode="decimal"
                          required
                        />
                      </label>
                      <label>
                        Reason
                        <input name="reason" required />
                      </label>
                      <label>
                        Refund reference
                        <input name="reference" required />
                      </label>
                      <button disabled={busy}>
                        Record refund already issued
                      </button>
                    </form>
                  )}
              </article>
            ))
          )}
          {finance && detail.status === "open" && (
            <>
              <h3>Record money already received</h3>
              <form
                className="grid"
                onSubmit={(e) => {
                  const b = form(e);
                  void act(() =>
                    api(`/invoices/${detail.id}/payments`, {
                      ...b,
                      amount_cents: cents(b.amount_cents),
                    }),
                  );
                }}
              >
                <label>
                  Amount received ($)
                  <input name="amount_cents" inputMode="decimal" required />
                </label>
                <label>
                  Method
                  <select name="method" aria-label="Method">
                    <option value="cash">Cash</option>
                    <option value="check">Check</option>
                  </select>
                </label>
                <label>
                  Receipt or check reference
                  <input name="reference" required />
                </label>
                <button disabled={busy}>Record payment</button>
              </form>
            </>
          )}
          {detail.status === "open" &&
            (finance || actor.role === "customer") && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await api("/payments/checkout", {
                      invoice_id: detail.id,
                    });
                    const destination = new URL(result.url);
                    if (
                      destination.protocol !== "https:" ||
                      destination.hostname !== "checkout.stripe.com"
                    )
                      throw Error("Unexpected payment destination");
                    window.location.assign(destination.href);
                  })
                }
              >
                Pay securely online
              </button>
            )}
        </section>
      )}
    </>
  );
}
