import { FormEvent, useEffect, useState } from "react";
import { dollarsToCents } from "./money-input";
export function AutopayPanel({
  api,
}: {
  api: (p: string, b?: unknown) => Promise<any>;
}) {
  const [profile, setProfile] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setProfile(await api("/payments/profile"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Secure payment settings</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {profile && (
        <>
          <p>
            Saved payment method:{" "}
            <b>{profile.method_saved ? "Available" : "Not configured"}</b> ·
            Autopay: <b>{profile.autopay_enabled ? "Enabled" : "Disabled"}</b>
          </p>
          <p className="muted">
            Payment details are collected and stored by the payment provider.
            CoreWaste stores a provider reference. Pending authorized charges
            may finish after autopay is disabled.
          </p>
          <form
            className="grid"
            key={
              String(profile.max_charge_cents) + String(profile.autopay_enabled)
            }
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const b = new FormData(e.currentTarget);
              void act(async () => {
                const result = await api("/payments/setup", {
                  enable_autopay: b.get("enabled") === "on",
                  max_charge_cents: dollarsToCents(b.get("maximum")),
                  consent: b.get("consent") === "on",
                });
                const url = new URL(result.url);
                if (
                  url.protocol !== "https:" ||
                  url.hostname !== "checkout.stripe.com"
                )
                  throw Error("Unexpected payment setup destination");
                window.location.assign(url.href);
              });
            }}
          >
            <label>
              Maximum automatic charge ($)
              <input
                name="maximum"
                inputMode="decimal"
                defaultValue={(profile.max_charge_cents / 100).toFixed(2)}
                required
              />
            </label>
            <label className="check">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={profile.autopay_enabled}
              />
              Enable autopay for due invoices within this limit
            </label>
            <label className="check">
              <input name="consent" type="checkbox" required />I authorize
              saving this payment method and any autopay selection above.
            </label>
            <button disabled={busy}>Open secure payment setup</button>
          </form>
          {profile.method_saved && (
            <form
              className="grid"
              onSubmit={(e) => {
                e.preventDefault();
                const b = new FormData(e.currentTarget);
                void act(async () => {
                  await api("/payments/autopay", {
                    enabled: b.get("enabled") === "on",
                    max_charge_cents: dollarsToCents(b.get("maximum")),
                    consent: b.get("consent") === "on",
                  });
                });
              }}
            >
              <label>
                Maximum automatic charge ($)
                <input
                  name="maximum"
                  inputMode="decimal"
                  defaultValue={(profile.max_charge_cents / 100).toFixed(2)}
                  required
                />
              </label>
              <label className="check">
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={profile.autopay_enabled}
                />
                Autopay enabled
              </label>
              <label className="check">
                <input name="consent" type="checkbox" />I authorize automatic
                collection of due CoreWaste invoices within this limit.
              </label>
              <button className="secondary" disabled={busy}>
                Update autopay authorization
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
