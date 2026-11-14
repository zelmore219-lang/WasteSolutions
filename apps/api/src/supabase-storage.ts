import { ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { providerValue } from "./provider-runtime";
const LIMIT = 10485760;
export function supabaseOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use the Supabase project HTTPS URL without a path or credentials",
    );
  return url.origin;
}
export class SupabasePrivateStorage {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private config() {
    try {
      const origin = supabaseOrigin(providerValue("SUPABASE_URL") || "");
      const bucket = providerValue("SUPABASE_BUCKET") || "";
      const key = providerValue("SUPABASE_SERVICE_ROLE_KEY") || "";
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(bucket) ||
        !key ||
        /[\r\n]/.test(key)
      )
        throw Error();
      return { origin, bucket, key };
    } catch {
      throw new ServiceUnavailableException(
        "Private Supabase storage is not configured",
      );
    }
  }
  private url(storageKey: string, authenticated: boolean) {
    if (!/^attachments\/[a-f0-9-]{36}$/.test(storageKey))
      throw new ServiceUnavailableException(
        "Invalid private attachment identifier",
      );
    const config = this.config();
    return {
      ...config,
      url:
        config.origin +
        "/storage/v1/object/" +
        (authenticated ? "authenticated/" : "") +
        encodeURIComponent(config.bucket) +
        "/" +
        storageKey.split("/").map(encodeURIComponent).join("/"),
    };
  }
  private async requirePrivateBucket() {
    const { origin, bucket, key } = this.config();
    try {
      const response = await this.transport(
        origin + "/storage/v1/bucket/" + encodeURIComponent(bucket),
        {
          headers: { apikey: key, Authorization: "Bearer " + key },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok || (await response.json()).public !== false)
        throw Error();
    } catch {
      throw new ServiceUnavailableException(
        "The Supabase bucket must exist and be private before storing or retrieving customer files",
      );
    }
  }
  async download(storageKey: string): Promise<Buffer> {
    await this.requirePrivateBucket();
    const { url, key } = this.url(storageKey, true);
    let response: Response;
    try {
      response = await this.transport(url, {
        headers: { apikey: key, Authorization: "Bearer " + key },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException(
        "Private attachment download was not confirmed",
      );
    }
    if (!response.ok || !response.body)
      throw new ServiceUnavailableException(
        "Private attachment download was not confirmed",
      );
    const reader = response.body.getReader(),
      parts: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > LIMIT) {
          await reader.cancel();
          throw Error();
        }
        parts.push(Buffer.from(next.value));
      }
    } catch {
      throw new ServiceUnavailableException(
        "Private attachment download was incomplete or exceeded the size limit",
      );
    }
    return Buffer.concat(parts);
  }
  async upload(
    storageKey: string,
    buffer: Buffer,
    contentType: string,
    sha256: string,
  ): Promise<void> {
    if (
      !buffer.length ||
      buffer.length > LIMIT ||
      createHash("sha256").update(buffer).digest("hex") !== sha256
    )
      throw new ServiceUnavailableException(
        "Invalid attachment upload content",
      );
    await this.requirePrivateBucket();
    const { url, key } = this.url(storageKey, false);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": contentType,
          "x-upsert": "false",
        },
        body: Uint8Array.from(buffer).buffer,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException(
        "Private attachment upload was not confirmed",
      );
    }
    if (response.ok) return;
    let duplicate = response.status === 409;
    if (response.status === 400) {
      try {
        const error = await response.json();
        duplicate =
          error.error === "Duplicate" || String(error.statusCode) === "409";
      } catch {}
    }
    if (!duplicate)
      throw new ServiceUnavailableException(
        "Private attachment upload was not confirmed",
      );
    // A lost response retries the same object. Never overwrite a different attachment.
    const existing = await this.download(storageKey);
    if (createHash("sha256").update(existing).digest("hex") !== sha256)
      throw new ServiceUnavailableException(
        "Private attachment checksum does not match",
      );
  }
}
