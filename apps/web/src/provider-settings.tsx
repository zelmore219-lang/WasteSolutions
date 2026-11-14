import { useEffect, useState, FormEvent } from "react";
type Field = {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  options?: string[];
  value?: string;
  configured?: boolean;
  stored?: boolean;
};
type Provider = {
  id: string;
  source: "saved" | "deployment";
  label: string;
  help: string;
  version: number;
  enabled: boolean;
  fields: Field[];
};
type Settings = {
  secure_storage_ready: boolean;
  can_edit: boolean;
  providers: Provider[];
};
export function ProviderSettingsPanel({
  api,
}: {
  api: (path: string, body?: unknown) => Promise<any>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => setSettings(await api("/settings/providers"));
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function save(event: FormEvent<HTMLFormElement>, provider: Provider) {
    event.preventDefault();
    const element = event.currentTarget,
      data = new FormData(element),
      values: Record<string, string> = {},
      clear_secrets: string[] = [];
    for (const field of provider.fields) {
      const value = String(data.get(field.name) || "");
      if (!field.secret || value) values[field.name] = value;
      if (data.get("clear:" + field.name) === "on")
        clear_secrets.push(field.name);
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/settings/providers/" + provider.id, {
        version: provider.version,
        enabled: data.get("enabled") === "on",
        values,
        clear_secrets,
      });
      element.reset();
      await load();
      setMessage(
        provider.label +
          " configuration saved. Connection has not been verified; no provider action was sent.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel">
        <h2>Providers</h2>
        <p>
          Configure services here. Saving keys does not verify a connection,
          send a message, charge a payment or activate Firebase hosting.
        </p>
        <p>
          Secret fields are write-only and encrypted on the server. Leave a
          secret blank to keep it.
        </p>
        {settings && !settings.can_edit && (
          <p className="notice">
            Only the company owner can change provider configuration.
          </p>
        )}
        {settings && !settings.secure_storage_ready && (
          <p className="notice">
            Secret storage is not configured yet. Your deployment operator must
            connect the secure encryption key before you can save provider
            secrets. Public settings can still be saved.
          </p>
        )}
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {settings?.providers.map((provider) => (
        <section className="panel" key={provider.id}>
          <h2>{provider.label}</h2>
          <p>{provider.help}</p>
          <p className="muted">
            {provider.source === "deployment"
              ? "No settings saved here; deployment settings may apply"
              : provider.enabled
                ? "Saved configuration enabled"
                : "Saved configuration disabled"}{" "}
            · Connection not verified
          </p>
          <form
            className="grid"
            key={provider.id + ":" + provider.version}
            onSubmit={(e) => void save(e, provider)}
          >
            <fieldset
              disabled={busy || !settings.can_edit}
              style={{ display: "contents" }}
            >
              {provider.fields.map((field) => (
                <div key={field.name}>
                  <label>
                    {field.label}
                    {field.secret ? (
                      <input
                        type="password"
                        name={field.name}
                        autoComplete="new-password"
                        placeholder={
                          field.configured
                            ? "Configured — leave blank to keep"
                            : "Not configured"
                        }
                        disabled={!settings.secure_storage_ready}
                        maxLength={4096}
                      />
                    ) : field.options ? (
                      <select
                        name={field.name}
                        defaultValue={field.value || field.options[0]}
                      >
                        {field.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        name={field.name}
                        defaultValue={field.value || ""}
                        maxLength={4096}
                        autoComplete="off"
                      />
                    )}
                  </label>
                  {field.secret && field.stored && (
                    <label className="check">
                      <input type="checkbox" name={"clear:" + field.name} />
                      Remove saved secret
                    </label>
                  )}
                </div>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={provider.enabled}
                />
                Use saved configuration
              </label>
              <button disabled={busy || !settings.can_edit}>
                Save {provider.label} configuration
              </button>
            </fieldset>
          </form>
        </section>
      ))}
    </>
  );
}
