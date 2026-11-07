import { ProviderRefundPanel } from "./provider-refunds";
import { ServiceTimingPanel } from "./service-timing";
import { EquipmentStoragePanel } from "./equipment-storage";
import { ContainerVerificationFields } from "./container-verification";
import { MaterialStockPanel } from "./material-stock";
import { FeePicker } from "./service-fees";
import { PricebooksPanel } from "./pricebooks";
import { DispatchCalendar } from "./dispatch-calendar";
import { ParentOrderField } from "./parent-order";
import { DriverTaskPanel } from "./driver-tasks";
import { DisposalLoadsPanel } from "./disposal-loads";
import { ServiceCalendarPanel } from "./service-calendar";
import { OrderTaskPanel } from "./order-tasks";
import { QuickBooksPanel } from "./quickbooks";
import { NotificationSettings } from "./notification-settings";
import { AutopayPanel } from "./autopay";
import { AutomationPanel } from "./automation";
import { dollarsToCents } from "./money-input";
import { PublicSite } from "./public-site";
import { PortalRegistration } from "./portal-registration";
import { IntakePanel } from "./intake";
import { AttachmentPanel } from "./attachments";
import { DispatchMonitor } from "./dispatch-monitor";
import { watchChanges } from "./live-updates";
import React, { useEffect, useState, useRef, FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  User,
  getMultiFactorResolver,
  MultiFactorResolver,
  TotpMultiFactorGenerator,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
} from "firebase/auth";
import "./style.css";
import { ImportPanel } from "./importing";
import { CustomerAccount } from "./customer-account";
import { SecurityPanel } from "./security";
import { AdminPanel } from "./admin";
import { ReportingPanel } from "./reporting";
import { StationPanel } from "./station";
import { BillingPanel } from "./billing";
import { RentalsPanel } from "./rentals";
import { WorkflowPanel } from "./workflows";
type Row = Record<string, any>;
const configured = Boolean(
  import.meta.env.VITE_FIREBASE_PROJECT_ID &&
  import.meta.env.VITE_FIREBASE_API_KEY,
);
const auth = configured
  ? getAuth(
      initializeApp({
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      }),
    )
  : null;
if (import.meta.env.VITE_USE_AUTH_EMULATOR === "true") {
  if (
    !import.meta.env.DEV ||
    !import.meta.env.VITE_FIREBASE_PROJECT_ID?.startsWith("demo-")
  )
    throw new Error(
      "Auth emulator is restricted to development and demo projects",
    );
  if (auth) connectAuthEmulator(auth, "http://127.0.0.1:9099");
}
const loginDomain = import.meta.env.VITE_EMPLOYEE_LOGIN_DOMAIN;
const pendingCommands = new Map<string, string>();
const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
function App() {
  const liveLoad = useRef<() => Promise<void>>(async () => {});
  const loadSequence = useRef(0),
    orderOffset = useRef(0),
    locationSequence = useRef(0);
  const [orderPage, setOrderPage] = useState(0);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const captcha = useRef<RecaptchaVerifier | null>(null);
  const [attachmentTarget, setAttachmentTarget] = useState<{
    kind: "order" | "customer";
    id: string;
  } | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<Row | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Row | null>(null);
  const [customerSearch, setCustomerSearch] = useState(""),
    [orderSearch, setOrderSearch] = useState(""),
    [orderStatus, setOrderStatus] = useState(""),
    [serviceDate, setServiceDate] = useState("");
  const [dispatchView, setDispatchView] = useState("list");
  const [orderPriority, setOrderPriority] = useState(""),
    [orderSort, setOrderSort] = useState("newest");
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [user, setUser] = useState<User | null>(null),
    [actor, setActor] = useState<Row | null>(null),
    [tab, setTab] = useState("Orders");
  const [customers, setCustomers] = useState<Row[]>([]),
    [orders, setOrders] = useState<Row[]>([]),
    [invoices, setInvoices] = useState<Row[]>([]),
    [resources, setResources] = useState<{ drivers: Row[]; trucks: Row[] }>({
      drivers: [],
      trucks: [],
    });
  const [locations, setLocations] = useState<Row[]>([]),
    [customerId, setCustomerId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const office = ["owner", "manager", "dispatcher", "office"].includes(
      actor?.role,
    ),
    finance = ["owner", "manager", "accountant"].includes(actor?.role),
    dispatch = ["owner", "manager", "dispatcher"].includes(actor?.role);
  async function api(path: string, body?: unknown) {
    const token = await user?.getIdToken();
    const command = path + JSON.stringify(body);
    if (body !== undefined && !pendingCommands.has(command))
      pendingCommands.set(command, crypto.randomUUID());
    const r = await fetch("/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(body === undefined
          ? {}
          : { "Idempotency-Key": pendingCommands.get(command)! }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok)
      throw new Error(
        typeof data.message === "string"
          ? data.message
          : JSON.stringify(data.message),
      );
    pendingCommands.delete(command);
    return data;
  }
  async function sendMfaSms() {
    const hint = resolver?.hints.find(
      (h) => h.factorId === PhoneMultiFactorGenerator.FACTOR_ID,
    );
    if (!hint || !resolver) return;
    setError("");
    try {
      if (!captcha.current)
        captcha.current = new RecaptchaVerifier(auth!, "mfa-recaptcha", {
          size: "invisible",
        });
      const id = await new PhoneAuthProvider(auth!).verifyPhoneNumber(
        { multiFactorHint: hint, session: resolver.session },
        captcha.current,
      );
      setVerificationId(id);
    } catch (e) {
      setError((e as Error).message);
      captcha.current?.clear();
      captcha.current = null;
    }
  }
  async function upload(form: FormData, key: string) {
    const r = await fetch("/api/attachments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await user?.getIdToken()}`,
        "Idempotency-Key": key,
      },
      body: form,
    });
    const data = await r.json();
    if (!r.ok)
      throw new Error(
        typeof data.message === "string"
          ? data.message
          : "Attachment upload failed",
      );
    return data;
  }
  async function download(path: string) {
    const r = await fetch("/api" + path, {
      headers: { Authorization: `Bearer ${await user?.getIdToken()}` },
    });
    if (!r.ok) throw new Error("Report export failed");
    const blob = await r.blob(),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download =
      r.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ||
      "CoreWaste-report";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  useEffect(() => (auth ? onAuthStateChanged(auth, setUser) : undefined), []);
  async function load(resetFilters = false) {
    const sequence = ++loadSequence.current;
    const uid = user?.uid;
    const a = await api("/me");
    const filters = new URLSearchParams({
      limit: "50",
      offset: String(resetFilters ? 0 : orderOffset.current),
      search: resetFilters ? "" : orderSearch,
      ...(!resetFilters && orderStatus ? { status: orderStatus } : {}),
      ...(!resetFilters && serviceDate ? { date: serviceDate } : {}),
      ...(!resetFilters && orderPriority ? { priority: orderPriority } : {}),
      sort: resetFilters ? "newest" : orderSort,
    });
    const work = await api("/orders?" + filters);
    const clients =
      a.role === "driver"
        ? []
        : await api(
            "/customers?" +
              new URLSearchParams({
                search: resetFilters ? "" : customerSearch,
              }),
          );
    const billing = a.role === "driver" ? [] : await api("/invoices");
    const assignment = ["owner", "manager", "dispatcher"].includes(a.role)
      ? await api("/resources")
      : { drivers: [], trucks: [] };
    if (auth?.currentUser?.uid !== uid || sequence !== loadSequence.current)
      return;
    setActor(a);
    setOrders(work);
    setCustomers(clients);
    setInvoices(billing);
    setResources(assignment);
  }
  useEffect(() => {
    loadSequence.current++;
    locationSequence.current++;
    orderOffset.current = 0;
    setOrderPage(0);
    setActor(null);
    setCustomers([]);
    setOrders([]);
    setInvoices([]);
    setLocations([]);
    setCustomerId("");
    setResources({ drivers: [], trucks: [] });
    setError("");
    setMessage("");
    setTab("Orders");
    setDispatchView("list");
    setSelectedCustomer(null);
    setAssignmentDraft(null);
    setAttachmentTarget(null);
    setCustomerSearch("");
    setOrderSearch("");
    setOrderStatus("");
    setServiceDate("");
    setOrderPriority("");
    setOrderSort("newest");
    pendingCommands.clear();
    if (user)
      void load(true).catch((e) => {
        if (auth?.currentUser?.uid === user.uid) setError(e.message);
      });
  }, [user]);
  liveLoad.current = () => load();
  useEffect(() => {
    if (!user || !actor) return;
    const controller = new AbortController();
    void watchChanges(
      () => user.getIdToken(),
      () => liveLoad.current(),
      controller.signal,
    );
    return () => controller.abort();
  }, [user?.uid, actor?.id, actor?.role]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      await load();
      setMessage("Saved successfully.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function selectCustomer(id: string) {
    const sequence = ++locationSequence.current;
    setCustomerId(id);
    setLocations([]);
    if (id)
      try {
        const locations = await api(`/customers/${id}/locations`);
        if (
          auth?.currentUser?.uid === user?.uid &&
          sequence === locationSequence.current
        )
          setLocations(locations);
      } catch (e) {
        setError((e as Error).message);
      }
  }
  function form(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget));
  }
  if (window.location.pathname === "/") return <PublicSite />;
  if (!user)
    return (
      <main className="login">
        <div className="brand">
          ◈ CORE<span>WASTE</span>
        </div>
        <h1>Operations, connected.</h1>
        <p>One place for your customers, dispatch, and billing.</p>
        {!configured ? (
          <div className="notice">
            Firebase setup is required. Configure the environment variables
            described in the setup guide to enable secure sign-in.
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              const b = form(e);
              setError("");
              const login = String(b.email).trim().toLowerCase();
              if (!login.includes("@") && !loginDomain) {
                setError(
                  "Employee login domain is not configured; use your work email.",
                );
                return;
              }
              const authenticate = creatingAccount
                ? createUserWithEmailAndPassword
                : signInWithEmailAndPassword;
              void authenticate(
                auth!,
                login.includes("@") ? login : `${login}@${loginDomain}`,
                String(b.password),
              ).catch((e) => {
                if (e.code === "auth/multi-factor-auth-required")
                  setResolver(getMultiFactorResolver(auth!, e));
                else setError(e.message);
              });
            }}
          >
            <label>
              Work email or employee username
              <input
                name="email"
                type="text"
                required
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
            <button>
              {creatingAccount ? "Create customer sign-in" : "Sign in"}
            </button>
            {!creatingAccount && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const email = window.prompt(
                    "Enter your work email or configured employee username",
                  );
                  if (!email) return;
                  const value = email.trim().toLowerCase(),
                    address = value.includes("@")
                      ? value
                      : loginDomain
                        ? value + "@" + loginDomain
                        : "";
                  if (!address) {
                    setError("Use your full work email address.");
                    return;
                  }
                  setError("");
                  void sendPasswordResetEmail(auth!, address)
                    .then(() =>
                      setMessage(
                        "If this address has an account, a password setup or recovery email has been requested.",
                      ),
                    )
                    .catch(() =>
                      setMessage(
                        "If this address has an account, a password setup or recovery email has been requested.",
                      ),
                    );
                }}
              >
                Set up or reset password
              </button>
            )}

            {window.location.pathname === "/portal" && (
              <button
                type="button"
                className="secondary"
                onClick={() => setCreatingAccount(!creatingAccount)}
              >
                {creatingAccount
                  ? "Use an existing sign-in"
                  : "Create a customer sign-in"}
              </button>
            )}
          </form>
        )}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {resolver && (
          <form
            onSubmit={(e) => {
              const b = form(e),
                totp = resolver.hints.find(
                  (h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID,
                );
              if (!totp && !verificationId) {
                setError("Request a verification code first.");
                return;
              }
              const assertion = totp
                ? TotpMultiFactorGenerator.assertionForSignIn(
                    totp.uid,
                    String(b.code),
                  )
                : PhoneMultiFactorGenerator.assertion(
                    PhoneAuthProvider.credential(
                      verificationId!,
                      String(b.code),
                    ),
                  );
              void resolver
                .resolveSignIn(assertion)
                .then(() => {
                  setResolver(null);
                  setVerificationId(null);
                  captcha.current?.clear();
                  captcha.current = null;
                })
                .catch((e) => setError(e.message));
            }}
          >
            {!resolver.hints.some(
              (h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID,
            ) && (
              <button type="button" onClick={() => void sendMfaSms()}>
                Send verification code
              </button>
            )}
            <label>
              Verification code
              <input
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                required
              />
            </label>
            <button>Verify and sign in</button>
          </form>
        )}
        <div id="mfa-recaptcha" />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <small>CoreWaste · Company operations</small>
      </main>
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          ◈ CORE<span>WASTE</span>
        </div>
        <p className="eyebrow">OPERATIONS WORKSPACE</p>
        <nav>
          {[
            "Orders",
            ...([
              "owner",
              "manager",
              "dispatcher",
              "office",
              "accountant",
              "driver",
            ].includes(actor?.role)
              ? ["Disposal loads"]
              : []),
            ...([
              "owner",
              "manager",
              "dispatcher",
              "office",
              "accountant",
            ].includes(actor?.role)
              ? ["Customer pricing"]
              : []),
            ...([
              "owner",
              "manager",
              "dispatcher",
              "office",
              "accountant",
            ].includes(actor?.role)
              ? ["Material stock"]
              : []),
            ...([
              "owner",
              "manager",
              "dispatcher",
              "office",
              "accountant",
            ].includes(actor?.role)
              ? ["Equipment stock"]
              : []),
            "Account security",
            ...(["owner", "manager", "customer"].includes(actor?.role)
              ? ["Notification settings"]
              : []),
            ...(actor?.role === "customer" ? ["Payment settings"] : []),
            ...(["owner", "manager", "accountant"].includes(actor?.role)
              ? ["Scheduled work"]
              : []),
            ...(["owner", "manager", "dispatcher", "office"].includes(
              actor?.role,
            )
              ? ["Service inquiries", "Portal access", "Service calendar"]
              : []),
            ...(["owner", "manager", "dispatcher"].includes(actor?.role)
              ? ["Dispatch monitor"]
              : []),
            ...(["owner", "manager", "accountant"].includes(actor?.role)
              ? ["Imports"]
              : []),
            ...(["owner", "manager", "dispatcher", "office", "driver"].includes(
              actor?.role,
            )
              ? ["Messages", "Driver tasks"]
              : []),
            ...([
              "owner",
              "manager",
              "dispatcher",
              "office",
              "accountant",
              "driver",
            ].includes(actor?.role)
              ? ["Fleet"]
              : []),
            ...(["owner", "manager", "dispatcher", "office"].includes(
              actor?.role,
            )
              ? ["Maintenance"]
              : []),
            ...(["owner", "manager", "accountant"].includes(actor?.role)
              ? ["Reports", "QuickBooks", "Provider refunds"]
              : []),
            ...(["owner", "manager"].includes(actor?.role)
              ? ["Company", "Employees", "Audit log"]
              : []),
            ...(actor?.role === "accountant" ? [] : ["Routes"]),
            ...(actor?.role === "driver"
              ? []
              : [
                  "Customers",
                  "Invoices",
                  ...(actor?.role === "customer" ? [] : ["Transfer station"]),
                  ...(["owner", "manager", "accountant", "customer"].includes(
                    actor?.role,
                  )
                    ? ["Credits"]
                    : []),
                  ...(["owner", "manager", "accountant"].includes(actor?.role)
                    ? ["Expenses"]
                    : []),
                  "Notifications",
                  "Rentals",
                  ...(actor?.role === "customer" ? [] : ["Containers"]),
                  ...(["accountant"].includes(actor?.role) ? [] : ["Requests"]),
                  "Agreements",
                ]),
          ].map((t) => (
            <button
              key={t}
              className={t === tab ? "selected" : ""}
              onClick={() => setTab(t)}
            >
              {t === "Orders" ? "▤" : t === "Customers" ? "◉" : "▧"} {t}
            </button>
          ))}
        </nav>
        <div className="account">
          <p>{user.email}</p>
          <small>{actor?.role || "Verifying account…"}</small>
          <button onClick={() => void signOut(auth!)}>Sign out</button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">COREWASTE / {tab.toUpperCase()}</p>
            <h1>{tab === "Orders" ? "Service operations" : tab}</h1>
            <p className="muted">
              {tab === "Orders"
                ? "Manage work from the first request to the final invoice."
                : tab === "Customers"
                  ? "Customer accounts and connected service locations."
                  : "Invoices generated from completed service."}
            </p>
          </div>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            Refresh
          </button>
        </header>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {message && (
          <div role="status" className="notice">
            {message}
          </div>
        )}
        <section className="stats">
          <article>
            <span>Active work</span>
            <strong>
              {
                orders.filter(
                  (o) =>
                    !["completed", "invoiced", "failed"].includes(o.status),
                ).length
              }
            </strong>
          </article>
          <article>
            <span>Completed services</span>
            <strong>
              {
                orders.filter((o) =>
                  ["completed", "invoiced"].includes(o.status),
                ).length
              }
            </strong>
          </article>
          {actor?.role !== "driver" && (
            <article>
              <span>Open receivables</span>
              <strong>
                {money(
                  invoices
                    .filter((i) => i.status === "open")
                    .reduce(
                      (s, i) => s + Number(i.balance_cents ?? i.amount_cents),
                      0,
                    ),
                )}
              </strong>
            </article>
          )}
        </section>
        {tab === "Customers" && (
          <>
            <section className="panel">
              <h2>Customer directory</h2>
              <form
                className="searchbar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {});
                }}
              >
                <label>
                  Search customers
                  <input
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Name, email, phone or billing address"
                  />
                </label>
                <button className="secondary" disabled={busy}>
                  Search customers
                </button>
              </form>
              {!customers.length ? (
                <p>No customer accounts yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Contact</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Locations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <b>{c.name}</b>
                          <small>{c.billing_address}</small>
                        </td>
                        <td>
                          {c.email}
                          <small>{c.phone}</small>
                        </td>
                        <td>{c.kind}</td>
                        <td>
                          <span className="badge">{c.status}</span>
                        </td>
                        <td>
                          <button
                            className="secondary"
                            onClick={() => void selectCustomer(c.id)}
                          >
                            View locations
                          </button>
                          <button
                            className="secondary"
                            onClick={() => setSelectedCustomer(c)}
                          >
                            Manage account
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            {office && (
              <section className="panel">
                <h2>Add customer</h2>
                <form
                  className="grid"
                  onSubmit={(e) => {
                    const b = form(e);
                    void run(() => api("/customers", b));
                  }}
                >
                  <label>
                    Company or customer name
                    <input name="name" required maxLength={200} />
                  </label>
                  <label>
                    Service type
                    <select name="kind">
                      <option value="residential">Residential</option>
                      <option value="commercial">Commercial</option>
                    </select>
                  </label>
                  <label>
                    Email
                    <input name="email" type="email" required />
                  </label>
                  <label>
                    Phone
                    <input name="phone" maxLength={40} />
                  </label>
                  <label>
                    Billing address
                    <input name="billing_address" required />
                  </label>
                  <button disabled={busy}>Create customer</button>
                </form>
              </section>
            )}
            {customerId && (
              <section className="panel">
                <h2>
                  Service locations ·{" "}
                  {customers.find((c) => c.id === customerId)?.name}
                </h2>
                {locations.map((l) => (
                  <p key={l.id}>
                    {l.address} <small>{l.instructions}</small>
                  </p>
                ))}
                {!locations.length && <p>No locations yet.</p>}
                {office && (
                  <form
                    className="grid"
                    onSubmit={(e) => {
                      const b = form(e);
                      void run(async () => {
                        await api(`/customers/${customerId}/locations`, b);
                        await selectCustomer(customerId);
                      });
                    }}
                  >
                    <label>
                      Service address
                      <input name="address" required />
                    </label>
                    <label>
                      Driver instructions
                      <input name="instructions" />
                    </label>
                    <button disabled={busy}>Add service location</button>
                  </form>
                )}
              </section>
            )}
          </>
        )}
        {tab === "Orders" && office && (
          <div className="actions">
            <button
              className={dispatchView === "list" ? "" : "secondary"}
              onClick={() => setDispatchView("list")}
            >
              Service list view
            </button>
            <button
              className={dispatchView === "calendar" ? "" : "secondary"}
              onClick={() => setDispatchView("calendar")}
            >
              Calendar dispatch view
            </button>
          </div>
        )}
        {tab === "Orders" && office && dispatchView === "calendar" && actor && (
          <DispatchCalendar
            actor={actor}
            resources={resources}
            api={api}
            refresh={load}
          />
        )}
        {tab === "Orders" && dispatchView === "list" && (
          <>
            <section className="panel">
              <form
                className="searchbar"
                onSubmit={(e) => {
                  e.preventDefault();
                  orderOffset.current = 0;
                  setOrderPage(0);
                  void run(async () => {});
                }}
              >
                <label>
                  Search service work
                  <input
                    value={orderSearch}
                    onChange={(e) => setOrderSearch(e.target.value)}
                  />
                </label>
                <label>
                  Order status
                  <select
                    value={orderStatus}
                    onChange={(e) => setOrderStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {[
                      "new",
                      "assigned",
                      "in_progress",
                      "completed",
                      "failed",
                      "invoiced",
                      "cancelled",
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Service date filter
                  <input
                    type="date"
                    value={serviceDate}
                    onChange={(e) => setServiceDate(e.target.value)}
                  />
                </label>
                <label>
                  Priority filter
                  <select
                    aria-label="Priority filter"
                    value={orderPriority}
                    onChange={(e) => setOrderPriority(e.target.value)}
                  >
                    <option value="">All priorities</option>
                    {["urgent", "high", "normal", "low"].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Sort service work
                  <select
                    aria-label="Sort service work"
                    value={orderSort}
                    onChange={(e) => setOrderSort(e.target.value)}
                  >
                    <option value="newest">Newest orders</option>
                    <option value="date">Service date</option>
                    <option value="priority">Priority and service date</option>
                  </select>
                </label>
                <button className="secondary" disabled={busy}>
                  Filter work
                </button>
              </form>
              <div className="section-title">
                <h2>
                  {actor?.role === "driver"
                    ? "Your assigned work"
                    : "Dispatch board"}
                </h2>
                <div className="actions">
                  <span>
                    Page {orderPage + 1} · {orders.length} orders
                  </span>
                  <button
                    className="secondary"
                    disabled={busy || orderPage === 0}
                    onClick={() => {
                      orderOffset.current = Math.max(
                        0,
                        orderOffset.current - 50,
                      );
                      setOrderPage((p) => Math.max(0, p - 1));
                      void run(async () => {});
                    }}
                  >
                    Previous orders
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || orders.length < 50}
                    onClick={() => {
                      orderOffset.current += 50;
                      setOrderPage((p) => p + 1);
                      void run(async () => {});
                    }}
                  >
                    Next orders
                  </button>
                </div>
              </div>
              {!orders.length ? (
                <div className="empty">
                  No service orders yet.
                  {office ? " Create an order below to begin." : ""}
                </div>
              ) : (
                orders.map((o) => (
                  <article className="order" key={o.id}>
                    <div>
                      <span className={"badge " + o.status}>
                        {o.status.replace("_", " ")}
                      </span>
                      <h3>
                        {o.customer_name}{" "}
                        <span className="muted">
                          / {o.kind.replace("_", " ")}
                        </span>
                      </h3>
                      <p>{o.address}</p>
                      <small>
                        {"CW-O" + String(o.number).padStart(6, "0")} · Priority:{" "}
                        {o.priority}
                      </small>
                      {o.parent_order_id && (
                        <small>
                          Related parent:{" "}
                          {"CW-O" +
                            String(o.parent_order_number).padStart(6, "0")}{" "}
                          · {o.parent_status.replaceAll("_", " ")}
                          {o.depends_on_parent ? " · Must complete first" : ""}
                        </small>
                      )}
                      <small>
                        {String(o.scheduled_date).slice(0, 10)} ·{" "}
                        {o.driver_name || "Unassigned"} ·{" "}
                        {o.truck_number || "No truck"} ·{" "}
                        {money(o.price_cents + (o.fee_total_cents || 0))}
                        {o.fee_total_cents > 0 &&
                          " (includes " + money(o.fee_total_cents) + " fees)"}
                      </small>
                      {o.instructions && <p>Instructions: {o.instructions}</p>}
                      <ServiceTimingPanel
                        order={o}
                        actor={actor}
                        api={api}
                        refresh={load}
                      />
                      <OrderTaskPanel
                        order={o}
                        actor={actor}
                        api={api}
                        refresh={load}
                      />
                      {o.arrived_at && (
                        <small>
                          Arrival: {new Date(o.arrived_at).toLocaleString()}
                        </small>
                      )}
                    </div>
                    <div className="actions">
                      {dispatch &&
                        !["completed", "invoiced", "cancelled"].includes(
                          o.status,
                        ) && (
                          <details>
                            <summary>Change order priority</summary>
                            <form
                              onSubmit={(e) => {
                                const b = form(e);
                                void run(() =>
                                  api("/orders/" + o.id + "/priority", {
                                    ...b,
                                    version: o.version,
                                  }),
                                );
                              }}
                            >
                              <label>
                                Change service priority
                                <select
                                  name="priority"
                                  aria-label="Change service priority"
                                  defaultValue={o.priority}
                                >
                                  {["urgent", "high", "normal", "low"].map(
                                    (p) => (
                                      <option key={p}>{p}</option>
                                    ),
                                  )}
                                </select>
                              </label>
                              <label>
                                Priority change reason
                                <input
                                  name="reason"
                                  required
                                  maxLength={2000}
                                />
                              </label>
                              <button disabled={busy}>
                                Save service priority
                              </button>
                            </form>
                          </details>
                        )}
                      {office &&
                        !o.rental_id &&
                        ["new", "assigned", "failed"].includes(o.status) && (
                          <details>
                            <summary>Cancel service order</summary>
                            <form
                              onSubmit={(e) => {
                                const b = form(e);
                                void run(() =>
                                  api("/orders/" + o.id + "/cancel", {
                                    ...b,
                                    version: o.version,
                                  }),
                                );
                              }}
                            >
                              <label>
                                Service cancellation reason
                                <input
                                  name="reason"
                                  required
                                  maxLength={2000}
                                />
                              </label>
                              <button className="secondary" disabled={busy}>
                                Cancel service with reason
                              </button>
                            </form>
                          </details>
                        )}
                      <button
                        className="secondary"
                        onClick={() =>
                          setAttachmentTarget({ kind: "order", id: o.id })
                        }
                      >
                        Photos and documents
                      </button>
                      {dispatch &&
                        ["new", "assigned", "in_progress"].includes(o.status) &&
                        (assignmentDraft && assignmentDraft.id === o.id ? (
                          <form
                            key={o.id + ":" + assignmentDraft.version}
                            onSubmit={(e) => {
                              const b = form(e);
                              void run(async () => {
                                await api("/orders/" + o.id + "/assign", {
                                  ...b,
                                  version: assignmentDraft!.version,
                                });
                                setAssignmentDraft(null);
                              });
                            }}
                          >
                            {o.version !== assignmentDraft.version && (
                              <p className="notice">
                                This order changed while you were editing.
                                Reload its current assignment before saving.
                              </p>
                            )}
                            <select
                              name="driver_id"
                              aria-label="Driver"
                              required
                              defaultValue={assignmentDraft.driver_id || ""}
                            >
                              <option value="" disabled>
                                Select driver
                              </option>
                              {resources.drivers.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.display_name}
                                </option>
                              ))}
                            </select>
                            <select
                              name="truck_id"
                              aria-label="Truck"
                              required
                              defaultValue={assignmentDraft.truck_id || ""}
                            >
                              <option value="" disabled>
                                Select truck
                              </option>
                              {resources.trucks.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.number}
                                </option>
                              ))}
                            </select>
                            <button
                              disabled={
                                busy || o.version !== assignmentDraft.version
                              }
                            >
                              Save driver assignment
                            </button>
                            {o.version !== assignmentDraft.version && (
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => setAssignmentDraft({ ...o })}
                              >
                                Reload current assignment
                              </button>
                            )}
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setAssignmentDraft(null)}
                            >
                              Cancel assignment edit
                            </button>
                          </form>
                        ) : (
                          <button
                            className="secondary"
                            onClick={() => setAssignmentDraft({ ...o })}
                          >
                            {o.driver_id
                              ? "Change driver and truck"
                              : "Assign driver and truck"}
                          </button>
                        ))}
                      {["owner", "manager", "driver"].includes(actor?.role) &&
                        ["assigned", "in_progress"].includes(o.status) && (
                          <>
                            {o.status === "in_progress" && !o.arrived_at && (
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    api("/orders/" + o.id + "/status", {
                                      status: "arrived",
                                      version: o.version,
                                      note: "",
                                      performed_at: new Date().toISOString(),
                                    }),
                                  )
                                }
                              >
                                Record arrival
                              </button>
                            )}
                            <form
                              onSubmit={(e) => {
                                const b = form(e);
                                void run(() =>
                                  api(`/orders/${o.id}/status`, {
                                    ...b,
                                    container_verification:
                                      b.container_verification
                                        ? JSON.parse(
                                            String(b.container_verification),
                                          )
                                        : undefined,
                                    status:
                                      o.status === "assigned"
                                        ? "in_progress"
                                        : "completed",
                                    version: o.version,
                                    note: "",
                                  }),
                                );
                              }}
                            >
                              {o.status === "in_progress" && (
                                <label>
                                  Service date
                                  <input
                                    type="date"
                                    name="service_date"
                                    defaultValue={new Intl.DateTimeFormat(
                                      "en-CA",
                                      { timeZone: "America/Chicago" },
                                    ).format(new Date())}
                                    required
                                  />
                                </label>
                              )}
                              {o.status === "in_progress" &&
                                o.rental_action && (
                                  <ContainerVerificationFields
                                    key={o.id}
                                    number={o.container_number}
                                    replacement={o.replacement_container_number}
                                  />
                                )}
                              <button disabled={busy}>
                                {o.status === "assigned"
                                  ? "Start service"
                                  : "Complete service"}
                              </button>
                            </form>
                            <form
                              onSubmit={(e) => {
                                const b = form(e);
                                void run(() =>
                                  api(`/orders/${o.id}/status`, {
                                    ...b,
                                    status: "failed",
                                    version: o.version,
                                  }),
                                );
                              }}
                            >
                              <input
                                name="note"
                                placeholder="Failure reason"
                                aria-label="Failure reason"
                                required
                              />
                              <button className="secondary" disabled={busy}>
                                Report failure
                              </button>
                            </form>
                          </>
                        )}
                      {finance && o.status === "completed" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(() => api(`/orders/${o.id}/invoice`, {}))
                          }
                        >
                          Generate invoice
                        </button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </section>
            {office && (
              <section className="panel">
                <h2>New service order</h2>
                <form
                  className="grid"
                  onSubmit={(e) => {
                    const b = form(e);
                    void run(() =>
                      api("/orders", {
                        ...b,
                        price_cents: dollarsToCents(b.price_cents),
                        fee_policies: JSON.parse(
                          String(b.fee_policies || "[]"),
                        ),
                        parent_order_id: b.parent_order_id || undefined,
                        depends_on_parent:
                          Boolean(b.parent_order_id) &&
                          b.depends_on_parent === "on",
                      }),
                    );
                  }}
                >
                  <label>
                    Service priority
                    <select
                      name="priority"
                      aria-label="Service priority"
                      defaultValue="normal"
                    >
                      {["normal", "low", "high", "urgent"].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <ParentOrderField customerId={customerId} api={api} />
                  <FeePicker customerId={customerId} api={api} />
                  <label>
                    Customer
                    <select
                      name="customer_id"
                      aria-label="Customer"
                      required
                      value={customerId}
                      onChange={(e) => void selectCustomer(e.target.value)}
                    >
                      <option value="" disabled>
                        Select customer
                      </option>
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
                    Service location
                    <select
                      key={customerId}
                      name="location_id"
                      aria-label="Service location"
                      required
                    >
                      <option value="">Select location</option>
                      {locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.address}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Service
                    <select name="kind">
                      {[
                        "pickup",
                        "delivery",
                        "exchange",
                        "relocation",
                        "live_load",
                        "extra_pickup",
                        "bulk",
                        "disposal",
                        "recurring",
                      ].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Scheduled date
                    <input type="date" name="scheduled_date" required />
                  </label>
                  <label>
                    Agreed price ($)
                    <input
                      type="number"
                      name="price_cents"
                      min="0"
                      max="1000000"
                      step="0.01"
                      required
                    />
                  </label>
                  <label>
                    Driver instructions
                    <input name="instructions" />
                  </label>
                  <button disabled={busy}>Create service order</button>
                </form>
              </section>
            )}
          </>
        )}
        {actor &&
          ["Invoices", "Expenses", "Credits", "Notifications"].includes(
            tab,
          ) && (
            <BillingPanel
              key={tab}
              tab={tab}
              actor={actor}
              api={api}
              refresh={load}
            />
          )}
        {actor && ["Routes", "Requests", "Agreements"].includes(tab) && (
          <WorkflowPanel
            key={tab}
            tab={tab}
            actor={actor}
            customers={customers}
            orders={orders}
            resources={resources}
            api={api}
            refresh={load}
          />
        )}
        {actor && ["Rentals", "Containers"].includes(tab) && (
          <RentalsPanel
            key={tab}
            tab={tab}
            actor={actor}
            customers={customers}
            api={api}
          />
        )}
        {actor && tab === "Customer pricing" && (
          <PricebooksPanel
            actor={actor}
            customers={customers}
            api={api}
            refresh={load}
          />
        )}
        {actor && tab === "Equipment stock" && (
          <EquipmentStoragePanel
            actor={actor}
            customers={customers}
            api={api}
          />
        )}
        {actor && tab === "Material stock" && (
          <MaterialStockPanel actor={actor} api={api} />
        )}
        {actor && tab === "Transfer station" && (
          <StationPanel actor={actor} customers={customers} api={api} />
        )}
        {actor &&
          [
            "Company",
            "Employees",
            "Audit log",
            "Fleet",
            "Maintenance",
            "Messages",
          ].includes(tab) && (
            <AdminPanel key={tab} tab={tab} actor={actor} api={api} />
          )}
        {actor && tab === "Driver tasks" && (
          <DriverTaskPanel actor={actor} resources={resources} api={api} />
        )}
        {actor && tab === "Disposal loads" && (
          <DisposalLoadsPanel actor={actor} resources={resources} api={api} />
        )}
        {actor && tab === "Service calendar" && (
          <ServiceCalendarPanel
            actor={actor}
            customers={customers}
            api={api}
            refresh={load}
          />
        )}
        {actor && finance && tab === "Provider refunds" && (
          <ProviderRefundPanel api={api} refresh={load} />
        )}
        {actor && tab === "QuickBooks" && (
          <QuickBooksPanel actor={actor} api={api} />
        )}
        {actor && tab === "Reports" && (
          <ReportingPanel api={api} download={download} />
        )}
        {tab === "Account security" && <SecurityPanel user={user} />}
        {actor && selectedCustomer && (
          <CustomerAccount
            key={selectedCustomer.id}
            customer={selectedCustomer}
            actor={actor}
            api={api}
            onClose={() => setSelectedCustomer(null)}
            onSaved={load}
          />
        )}
        {actor && tab === "Imports" && <ImportPanel api={api} />}
        {actor && attachmentTarget && (
          <AttachmentPanel
            key={attachmentTarget.id}
            entityKind={attachmentTarget.kind}
            entityId={attachmentTarget.id}
            api={api}
            upload={upload}
            download={download}
          />
        )}
        {actor && tab === "Dispatch monitor" && <DispatchMonitor api={api} />}
        {user && !actor && window.location.pathname === "/portal" && (
          <PortalRegistration user={user} api={api} recheck={load} />
        )}
        {actor && ["Service inquiries", "Portal access"].includes(tab) && (
          <IntakePanel
            key={tab}
            tab={tab}
            customers={customers}
            api={api}
            refresh={load}
          />
        )}
        {actor && tab === "Payment settings" && <AutopayPanel api={api} />}
        {actor && tab === "Scheduled work" && (
          <AutomationPanel actor={actor} api={api} refresh={load} />
        )}
        {actor && tab === "Notification settings" && (
          <NotificationSettings actor={actor} api={api} />
        )}
        <footer>CoreWaste · Company operations</footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
