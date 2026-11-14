import { supabaseOrigin } from "./supabase-storage";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";
import { z } from "zod";
import { Actor, Operations, parse, permit, OFFICE, FINANCE } from "./domain";
import { PROVIDERS, setProviderRuntime } from "./provider-runtime";
function masterKey() {
  const input = process.env.PROVIDER_SETTINGS_KEY || "";
  const seed = process.env.PROVIDER_SETTINGS_SEED || "";
  if (!input && /^[A-Za-z0-9_+=\/-]{32,256}$/.test(seed))
    return Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(seed),
        Buffer.from("CoreWaste provider settings v1"),
        Buffer.from("stored-provider-credentials"),
        32,
      ),
    );
  const key = Buffer.from(input, "base64");
  if (key.length !== 32 || key.toString("base64") !== input)
    throw new ServiceUnavailableException(
      "Secure provider storage is not configured. The deployment operator must connect the encryption key first.",
    );
  return key;
}
export function sealProviderSecret(
  provider: string,
  name: string,
  value: string,
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  cipher.setAAD(Buffer.from(provider + ":" + name));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString("base64"))
    .join(".");
}
export function openProviderSecret(
  provider: string,
  name: string,
  value: string,
) {
  try {
    const parts = value.split(".");
    if (parts.length !== 3) throw Error("Invalid encrypted field");
    const [iv, tag, data] = parts.map((v) => Buffer.from(v, "base64"));
    if (iv.length !== 12 || tag.length !== 16)
      throw Error("Invalid encrypted field");
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
    decipher.setAAD(Buffer.from(provider + ":" + name));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new ServiceUnavailableException(
      "Saved provider credentials are locked. Restore the correct server encryption key.",
    );
  }
}
export class ProviderSettings {
  private refreshed = 0;
  private inFlight?: Promise<void>;
  constructor(readonly ops: Operations) {}
  async publicClientConfig() {
    if (
      process.env.FIREBASE_AUTH_EMULATOR_HOST &&
      process.env.FIREBASE_PROJECT_ID === "demo-corewaste"
    )
      return {
        projectId: "demo-corewaste",
        apiKey: "local-demo-only",
        authDomain: "demo-corewaste.firebaseapp.com",
      };
    const row = (
      await this.ops.pool.query(
        "SELECT config,enabled FROM provider_settings WHERE provider='firebase'",
      )
    ).rows[0];
    const values = row?.enabled ? row.config : {};
    const names: Record<string, string> = {
      apiKey: "VITE_FIREBASE_API_KEY",
      authDomain: "VITE_FIREBASE_AUTH_DOMAIN",
      appId: "VITE_FIREBASE_APP_ID",
      storageBucket: "VITE_FIREBASE_STORAGE_BUCKET",
    };
    const result: Record<string, string> = {};
    if (process.env.FIREBASE_PROJECT_ID)
      result.projectId = process.env.FIREBASE_PROJECT_ID;
    for (const [name, key] of Object.entries(names)) {
      const value = values[key] ?? process.env[key];
      if (typeof value === "string" && value) result[name] = value;
    }
    return result;
  }
  async list(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE]);
    const rows = (
      await this.ops.pool.query(
        "SELECT * FROM provider_settings ORDER BY provider",
      )
    ).rows;
    let secure_storage_ready = true;
    try {
      masterKey();
    } catch {
      secure_storage_ready = false;
    }
    return {
      secure_storage_ready,
      can_edit: a.role === "owner",
      providers: Object.entries(PROVIDERS).map(([id, def]) => {
        const row = rows.find((r) => r.provider === id);
        return {
          id,
          ...def,
          source: row ? "saved" : "deployment",
          enabled: row?.enabled || false,
          version: row?.version || 0,
          connection_verified: false,
          fields: def.fields.map((field) => ({
            ...field,
            value: field.secret
              ? undefined
              : (row?.config[field.name] ?? process.env[field.name] ?? ""),
            stored: Boolean(row?.secrets[field.name]),
            configured: field.secret
              ? Boolean(row?.secrets[field.name] || process.env[field.name])
              : undefined,
          })),
        };
      }),
    };
  }
  async save(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner"]);
    const definition = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : undefined;
    if (!definition) throw new BadRequestException("Unknown provider");
    const b = parse(
      z
        .object({
          version: z.number().int().min(0),
          enabled: z.boolean(),
          values: z.record(z.string(), z.string().max(4096)),
          clear_secrets: z.array(z.string()).default([]),
        })
        .strict(),
      body,
    );
    for (const name of [...Object.keys(b.values), ...b.clear_secrets])
      if (!definition.fields.some((f) => f.name === name))
        throw new BadRequestException("Unsupported provider setting");
    for (const name of b.clear_secrets)
      if (!definition.fields.some((f) => f.name === name && f.secret))
        throw new BadRequestException(
          "Only saved secret fields may be cleared",
        );
    for (const field of definition.fields) {
      const value = b.values[field.name];
      if (value === undefined) continue;
      if (/[\r\n\0]/.test(value) || value.includes("PRIVATE KEY"))
        throw new BadRequestException(
          "Use a provider value, not a credential file or private key",
        );
      if (field.options && !field.options.includes(value))
        throw new BadRequestException("Choose a supported provider mode");
      if (
        (field.name.endsWith("_URI") || field.name === "PUBLIC_WEB_URL") &&
        value
      ) {
        let url;
        try {
          url = new URL(value);
        } catch {
          throw new BadRequestException("Enter a valid HTTPS address");
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          throw new BadRequestException(
            "Use HTTPS without credentials, query strings or fragments",
          );
        if (
          field.name === "PUBLIC_WEB_URL" &&
          url.origin !==
            new URL(process.env.WEB_ORIGIN || "https://invalid.local").origin
        )
          throw new BadRequestException(
            "Payment return website must match the configured company website",
          );
      }
      if (
        field.name === "FIREBASE_PROJECT_ID" &&
        value !== process.env.FIREBASE_PROJECT_ID
      )
        throw new BadRequestException(
          "Firebase project must match the backend’s configured identity project",
        );
      if (
        field.name === "ROUTING_REGION" &&
        !/^[a-z]{2}-[a-z]+-\d$/.test(value)
      )
        throw new BadRequestException("Enter a valid AWS region");
      if (field.name === "SMS_FROM" && !/^\+[1-9][0-9]{6,14}$/.test(value))
        throw new BadRequestException(
          "Use an international sender phone number",
        );
      if (field.name === "SUPABASE_URL" && value) {
        try {
          supabaseOrigin(value);
        } catch {
          throw new BadRequestException("Use the Supabase project HTTPS URL");
        }
      }
      if (
        field.name === "STORAGE_DRIVER" &&
        process.env.NODE_ENV === "production" &&
        !["gcs", "supabase"].includes(value)
      )
        throw new BadRequestException(
          "Production attachments require private cloud storage",
        );
    }
    if (
      process.env.FIREBASE_AUTH_EMULATOR_HOST &&
      b.enabled &&
      id !== "firebase"
    )
      throw new BadRequestException(
        "Live providers cannot be activated in the isolated demo. Save configuration disabled.",
      );
    const response = await this.ops.command(
      a,
      key,
      ["providers.update", id, b],
      async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "provider-settings:" + id,
        ]);
        const old = (
          await c.query(
            "SELECT * FROM provider_settings WHERE provider=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if ((old?.version || 0) !== b.version)
          throw new ConflictException(
            "Provider settings changed; reload before saving",
          );
        const config = { ...old?.config },
          secrets = { ...old?.secrets };
        // Refuse partial re-encryption under a replacement/wrong master key.
        for (const [name, value] of Object.entries(secrets))
          openProviderSecret(id, name, value as string);
        for (const field of definition.fields)
          if (Object.hasOwn(b.values, field.name)) {
            if (field.secret) {
              if (b.values[field.name])
                secrets[field.name] = sealProviderSecret(
                  id,
                  field.name,
                  b.values[field.name],
                );
            } else config[field.name] = b.values[field.name].trim();
          }
        for (const name of b.clear_secrets) delete secrets[name];
        if (b.enabled)
          for (const f of definition.fields)
            if (
              f.required &&
              !(f.secret
                ? secrets[f.name] || process.env[f.name]
                : config[f.name] || process.env[f.name])
            )
              throw new BadRequestException(
                "Complete required provider fields before activation",
              );
        if (b.enabled && id === "storage") {
          const driver = config.STORAGE_DRIVER || process.env.STORAGE_DRIVER;
          const required =
            driver === "supabase"
              ? ["SUPABASE_URL", "SUPABASE_BUCKET", "SUPABASE_SERVICE_ROLE_KEY"]
              : driver === "gcs"
                ? ["GCS_BUCKET"]
                : [];
          for (const name of required)
            if (!(config[name] || secrets[name] || process.env[name]))
              throw new BadRequestException(
                "Complete the selected private storage provider fields",
              );
        }
        const row = (
          await c.query(
            "INSERT INTO provider_settings(provider,enabled,config,secrets,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,config=EXCLUDED.config,secrets=EXCLUDED.secrets,updated_by=EXCLUDED.updated_by,updated_at=now(),version=provider_settings.version+1 RETURNING provider,enabled,version",
            [id, b.enabled, config, secrets, a.id],
          )
        ).rows[0];
        await this.ops.audit(c, a, "provider.settings.updated", a.id, {
          provider: id,
          fields: Object.keys(b.values),
          cleared: b.clear_secrets,
          enabled: b.enabled,
        });
        return row;
      },
    );
    await this.refreshRuntime(true);
    return response;
  }
  async refreshRuntime(force = false): Promise<void> {
    if (!force && Date.now() - this.refreshed < 2000) return;
    if (this.inFlight) {
      await this.inFlight;
      if (!force) return;
    }
    const task = (async () => {
      const rows = (
        await this.ops.pool.query("SELECT * FROM provider_settings")
      ).rows;
      const values: Record<string, string | undefined> = {};
      for (const row of rows) {
        if (row.provider === "firebase") continue; // Backend identity remains deployment-managed.
        const fields = PROVIDERS[row.provider]?.fields || [];
        let unlocked = true;
        const decrypted: Record<string, string> = {};
        try {
          for (const [name, data] of Object.entries(row.secrets))
            decrypted[name] = openProviderSecret(
              row.provider,
              name,
              data as string,
            );
        } catch {
          unlocked = false;
        }
        for (const field of fields) {
          const receiptSecret = [
            "STRIPE_WEBHOOK_SECRET",
            "PAYMENTS_MODE",
          ].includes(field.name);
          values[field.name] =
            ((row.enabled && !process.env.FIREBASE_AUTH_EMULATOR_HOST) ||
              receiptSecret) &&
            unlocked
              ? field.secret
                ? (decrypted[field.name] ?? process.env[field.name])
                : (row.config[field.name] ?? process.env[field.name])
              : undefined;
        }
      }
      setProviderRuntime(values);
      this.refreshed = Date.now();
    })();
    this.inFlight = task;
    try {
      await task;
    } finally {
      if (this.inFlight === task) this.inFlight = undefined;
    }
  }
}
