import { useState, FormEvent } from "react";
import {
  User,
  multiFactor,
  sendEmailVerification,
  TotpMultiFactorGenerator,
  TotpSecret,
} from "firebase/auth";
export function SecurityPanel({ user }: { user: User }) {
  const [secret, setSecret] = useState<TotpSecret | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [factors, setFactors] = useState(multiFactor(user).enrolledFactors);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setFactors([...multiFactor(user).enrolledFactors]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Account security</h2>
      <p>{user.email}</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {!user.emailVerified && (
        <>
          <p>
            Verify your email before enrolling an authenticator. If Firebase
            requests a recent login, sign out and sign in again.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await sendEmailVerification(user);
                setMessage(
                  "Verification email requested. Open the link, then sign out and sign in again.",
                );
              })
            }
          >
            Send email verification
          </button>
        </>
      )}
      <h3>Enrolled authentication factors</h3>
      {!factors.length ? (
        <p>No second factors enrolled.</p>
      ) : (
        factors.map((f) => (
          <article className="order" key={f.uid}>
            <div>
              <b>{f.displayName || f.factorId}</b>
              <small>{f.factorId}</small>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await multiFactor(user).unenroll(f);
                  setMessage(
                    "Factor removed. Administrators must keep another factor enrolled to access operations.",
                  );
                })
              }
            >
              Remove this factor
            </button>
          </article>
        ))
      )}
      <h3>Enroll an authenticator app</h3>
      <p>
        Owners and managers must use multi-factor authentication. Your setup key
        is displayed only here for enrollment.
      </p>
      <button
        disabled={busy || !user.emailVerified}
        onClick={() =>
          void act(async () => {
            setSecret(
              await TotpMultiFactorGenerator.generateSecret(
                await multiFactor(user).getSession(),
              ),
            );
          })
        }
      >
        Generate authenticator setup key
      </button>
      {secret && (
        <>
          <p>
            Enter this setup key in your authenticator app:{" "}
            <code>{secret.secretKey}</code>
          </p>
          <form
            className="grid"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const code = String(new FormData(e.currentTarget).get("code"));
              void act(async () => {
                await multiFactor(user).enroll(
                  TotpMultiFactorGenerator.assertionForEnrollment(secret, code),
                  "CoreWaste authenticator",
                );
                setSecret(null);
                setMessage(
                  "Authenticator enrolled. Sign out and sign in again to complete your first MFA login.",
                );
              });
            }}
          >
            <label>
              Authenticator code
              <input
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                required
              />
            </label>
            <button disabled={busy}>Enroll authenticator</button>
          </form>
        </>
      )}
    </section>
  );
}
