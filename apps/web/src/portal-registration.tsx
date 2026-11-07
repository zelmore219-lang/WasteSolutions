import { useEffect, useState, FormEvent } from "react";
import { User, sendEmailVerification } from "firebase/auth";
export function PortalRegistration({
  user,
  api,
  recheck,
}: {
  user: User;
  api: (p: string, b?: unknown) => Promise<any>;
  recheck: () => Promise<void>;
}) {
  const [status, setStatus] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api("/portal/registration")
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, [user.uid]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Activate your customer account</h2>
      <p>{user.email}</p>
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
      {!user.emailVerified ? (
        <>
          <p>
            Verify your email to request access to a CoreWaste customer account.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await sendEmailVerification(user);
                setMessage(
                  "Verification email requested. Open the link, then use Check verification.",
                );
              })
            }
          >
            Send customer verification email
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await user.reload();
                await user.getIdToken(true);
                setStatus(await api("/portal/registration"));
                setMessage(
                  user.emailVerified
                    ? "Email verified. Complete the account request below."
                    : "Email is not verified yet.",
                );
              })
            }
          >
            Check verification
          </button>
        </>
      ) : status?.status === "pending" ? (
        <>
          <p className="notice">
            Your verified request is waiting for office approval. Existing
            customer records remain protected until the office links your
            account.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setStatus(await api("/portal/registration"));
                await recheck();
              })
            }
          >
            Check approval status
          </button>
        </>
      ) : status?.status === "rejected" ? (
        <p>
          Your request was reviewed: {status.review_note}. Contact the CoreWaste
          office for help.
        </p>
      ) : status?.status === "approved" ? (
        <button disabled={busy} onClick={() => void act(recheck)}>
          Open approved customer account
        </button>
      ) : (
        <form
          className="grid"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const b = Object.fromEntries(new FormData(e.currentTarget));
            void act(async () => {
              setStatus(await api("/portal/registration", b));
            });
          }}
        >
          <label>
            Customer or business name
            <input name="name" required defaultValue={user.displayName || ""} />
          </label>
          <label>
            Account type
            <select name="kind">
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
          </label>
          <label>
            Phone
            <input name="phone" type="tel" maxLength={40} />
          </label>
          <label>
            Billing address
            <input name="billing_address" required />
          </label>
          <label>
            Service address
            <input name="service_address" required />
          </label>
          <button disabled={busy}>Request customer account access</button>
        </form>
      )}
    </section>
  );
}
