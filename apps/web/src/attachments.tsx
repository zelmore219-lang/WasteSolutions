import { useEffect, useRef, useState, FormEvent } from "react";
type Props = {
  entityKind: "order" | "customer";
  entityId: string;
  api: (p: string, b?: unknown) => Promise<any>;
  upload: (form: FormData, key: string) => Promise<unknown>;
  download: (p: string) => Promise<void>;
};
export function AttachmentPanel({
  entityKind,
  entityId,
  api,
  upload,
  download,
}: Props) {
  const [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const command = useRef(crypto.randomUUID());
  const section = useRef<HTMLElement | null>(null);
  useEffect(
    () => section.current?.scrollIntoView({ behavior: "smooth" }),
    [entityId],
  );
  async function load() {
    setItems(await api(`/attachments/entity/${entityKind}/${entityId}`));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [entityId]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    data.set("entity_kind", entityKind);
    data.set("entity_id", entityId);
    setError("");
    setBusy(true);
    try {
      await upload(data, command.current);
      command.current = crypto.randomUUID();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" ref={section}>
      <h2>Service photographs and documents</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!items.length ? (
        <p>No attachments yet.</p>
      ) : (
        items.map((i) => (
          <article className="order" key={i.id}>
            <div>
              <b>{i.filename}</b>
              <small>
                {i.kind} ·{" "}
                {i.visibility === "customer"
                  ? "Customer visible"
                  : "Office and assigned driver"}{" "}
                · {Math.ceil(i.size_bytes / 1024)} KB
              </small>
              {i.signer_name && (
                <small>
                  Service acknowledgment: {i.signer_name} ·{" "}
                  {new Date(i.signed_at).toLocaleString()}
                </small>
              )}
            </div>
            <button
              className="secondary"
              onClick={() =>
                void download(`/attachments/${i.id}/download`).catch((e) =>
                  setError(e.message),
                )
              }
            >
              Download attachment
            </button>
          </article>
        ))
      )}
      <form
        className="grid"
        onSubmit={(e) => void submit(e)}
        onChange={() => {
          command.current = crypto.randomUUID();
        }}
      >
        <label>
          File
          <input
            type="file"
            name="file"
            accept="image/jpeg,image/png,application/pdf"
            required
          />
        </label>
        <label>
          Attachment type
          <select name="kind" aria-label="Attachment type">
            <option value="photo">Photograph</option>
            <option value="document">Document</option>
          </select>
        </label>
        <label>
          Visibility
          <select name="visibility">
            <option value="office">Office and assigned driver</option>
            <option value="customer">Customer visible</option>
          </select>
        </label>
        <button disabled={busy}>Upload attachment</button>
      </form>
      <small>
        JPEG, PNG, or PDF · 10 MB maximum · Photographs are normalized and
        location metadata is removed.
      </small>
    </section>
  );
}
