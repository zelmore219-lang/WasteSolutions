import { FormEvent, useEffect, useRef, useState } from "react";
export function PublicSite() {
  const [company, setCompany] = useState<any>(null),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    void fetch("/api/public/company")
      .then(async (r) => {
        if (r.ok) setCompany(await r.json());
      })
      .catch(() => undefined);
  }, []);
  async function request(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const r = await fetch("/api/public/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...b, request_id: requestId.current }),
      });
      const value = await r.json();
      if (!r.ok)
        throw Error(
          typeof value.message === "string"
            ? value.message
            : "Your request could not be submitted",
        );
      setSuccess(
        "Your request has been sent to the CoreWaste office. Our team will review your service needs and contact you.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="public-site">
      <nav className="public-nav">
        <a className="brand" href="/">
          ◈ CORE<span>WASTE</span>
        </a>
        <div>
          <a href="#services">Our services</a>
          <a href="#request">Request service</a>
          <a className="public-account" href="/portal">
            Customer sign in ↗
          </a>
        </div>
      </nav>
      <main>
        <section className="public-hero">
          <div className="hero-copy">
            <span className="eyebrow">COREWASTE / WASTE & RECYCLING</span>
            <h1>
              Waste handled.
              <br />
              <em>Room for what’s next.</em>
            </h1>
            <p>
              Residential collection, commercial service, and roll-off
              containers. Connect with CoreWaste to find the service that fits
              your property or project.
            </p>
            <a className="public-cta" href="#request">
              Let’s plan your service <span>↗</span>
            </a>
            <a className="public-secondary" href="/portal">
              Already a customer? Manage your account →
            </a>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit" />
            <div className="art-truck">
              <div className="art-bin">
                <span>COREWASTE</span>
                <i />
                <i />
                <i />
              </div>
              <div className="art-cab" />
              <div className="art-wheel one" />
              <div className="art-wheel two" />
            </div>
            <span className="art-label">ONE CONNECTED SERVICE TEAM</span>
          </div>
        </section>
        <section id="services" className="public-services">
          <p className="eyebrow">SOLUTIONS FOR YOUR EVERYDAY</p>
          <h2>From your curb to your next big project.</h2>
          <div className="service-cards">
            {[
              {
                n: "01",
                title: "Residential collection",
                body: "Tell us about your household collection needs, service location, additional pickups, and bulky items.",
              },
              {
                n: "02",
                title: "Commercial waste",
                body: "Plan collection schedules and container service around your business, property, and operational needs.",
              },
              {
                n: "03",
                title: "Roll-off containers",
                body: "Discuss container size, delivery and pickup dates, exchanges, and disposal requirements for your project.",
              },
            ].map((s) => (
              <article key={s.n}>
                <span>{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <a href="#request">Discuss this service ↗</a>
              </article>
            ))}
          </div>
        </section>
        <section className="portal-promo">
          <div>
            <p className="eyebrow">YOUR ACCOUNT, SIMPLIFIED</p>
            <h2>
              Your service. Your schedule.
              <br />
              One place to stay connected.
            </h2>
            <p>
              Access service information, view invoices, submit requests, and
              follow account updates through your CoreWaste customer account.
            </p>
          </div>
          <a className="public-cta" href="/portal">
            Open customer portal ↗
          </a>
        </section>
        <section id="request" className="public-request">
          <div>
            <p className="eyebrow">LET’S GET STARTED</p>
            <h2>
              Tell us what
              <br />
              you need.
            </h2>
            <p>
              Our office reviews service requests, availability, and pricing
              before scheduling work.
            </p>
            {company?.phone && (
              <p>
                <b>Call CoreWaste</b>
                <br />
                {company.phone}
              </p>
            )}
            {company?.email && (
              <p>
                <b>Email our office</b>
                <br />
                {company.email}
              </p>
            )}
          </div>
          <form
            onSubmit={(e) => void request(e)}
            onChange={() => {
              if (success) {
                setSuccess("");
                requestId.current = crypto.randomUUID();
              }
            }}
          >
            <div className="grid">
              <label>
                Your name or business
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={200}
                />
              </label>
              <label>
                Email address
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                />
              </label>
              <label>
                Phone number
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  maxLength={40}
                />
              </label>
              <label>
                Service needed
                <select name="service_kind" aria-label="Service needed">
                  <option value="residential">Residential collection</option>
                  <option value="commercial">Commercial service</option>
                  <option value="roll_off">Roll-off container</option>
                  <option value="bulk">Bulk-item pickup</option>
                  <option value="other">Other service</option>
                </select>
              </label>
            </div>
            <label>
              Service address
              <input
                name="service_address"
                autoComplete="street-address"
                required
                maxLength={2000}
              />
            </label>
            <label>
              How can we help?
              <textarea name="message" rows={4} required maxLength={3000} />
            </label>
            <div className="honeypot" aria-hidden="true">
              <label>
                Website
                <input name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {success && (
              <p className="notice" role="status">
                {success}
              </p>
            )}
            <button disabled={busy || Boolean(success)}>
              Send service request ↗
            </button>
          </form>
        </section>
      </main>
      <footer className="public-footer">
        <div className="brand">
          ◈ CORE<span>WASTE</span>
        </div>
        <div>
          {company?.address && <p>{company.address}</p>}
          <p>CoreWaste · Waste management operations</p>
        </div>
        <a href="/office">Employee sign in</a>
      </footer>
    </div>
  );
}
