import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import {
  ProviderSettings,
  sealProviderSecret,
  openProviderSecret,
} from "../src/provider-settings";
import { providerValue, setProviderRuntime } from "../src/provider-runtime";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  settings = new ProviderSettings(new Operations(pool));
const previousKey = process.env.PROVIDER_SETTINGS_KEY,
  previousEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
let owner: Actor, dispatcher: Actor, backup: any;
const secret = "test_secret_" + randomUUID();
before(async () => {
  process.env.PROVIDER_SETTINGS_KEY = randomBytes(32).toString("base64");
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  backup = (
    await pool.query("SELECT * FROM provider_settings WHERE provider='email'")
  ).rows[0];
  await pool.query("DELETE FROM provider_settings WHERE provider='email'");
  for (const role of ["owner", "dispatcher"]) {
    const r = (
      await pool.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Provider settings fixture',$3) RETURNING *",
        [randomUUID(), "provider_" + randomUUID(), role],
      )
    ).rows[0];
    if (role === "owner") owner = r;
    else dispatcher = r;
  }
});
after(async () => {
  await pool.query("DELETE FROM provider_settings WHERE provider='email'");
  if (backup)
    await pool.query(
      "INSERT INTO provider_settings(provider,enabled,config,secrets,version,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        backup.provider,
        backup.enabled,
        backup.config,
        backup.secrets,
        backup.version,
        backup.updated_by,
        backup.updated_at,
      ],
    );
  if (previousKey === undefined) delete process.env.PROVIDER_SETTINGS_KEY;
  else process.env.PROVIDER_SETTINGS_KEY = previousKey;
  if (previousEmulator === undefined)
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = previousEmulator;
  setProviderRuntime({});
  await pool.end();
});
test("provider secrets use authenticated field-bound encryption", () => {
  const encrypted = sealProviderSecret("email", "RESEND_API_KEY", secret);
  assert.equal(
    openProviderSecret("email", "RESEND_API_KEY", encrypted),
    secret,
  );
  assert.throws(
    () => openProviderSecret("email", "RESEND_API_KEY", encrypted + ".extra"),
    /locked/,
  );
  assert.notEqual(
    encrypted,
    sealProviderSecret("email", "RESEND_API_KEY", secret),
  );
  assert.throws(
    () => openProviderSecret("sms", "RESEND_API_KEY", encrypted),
    /locked/,
  );
  assert.throws(
    () => openProviderSecret("email", "OTHER_FIELD", encrypted),
    /locked/,
  );
});
test("only owner can save; secret values never reach settings, command responses, or audit history", async () => {
  const body = {
    version: 0,
    enabled: false,
    values: { RESEND_API_KEY: secret, EMAIL_FROM: "demo@example.test" },
  };
  await assert.rejects(settings.save(dispatcher, randomUUID(), "email", body));
  const key = randomUUID(),
    saved: any = await settings.save(owner, key, "email", body);
  assert.deepEqual(await settings.save(owner, key, "email", body), saved);
  assert.equal(saved.version, 1);
  assert.ok(!JSON.stringify(saved).includes(secret));
  const listing = await settings.list(dispatcher);
  assert.ok(!JSON.stringify(listing).includes(secret));
  const field = listing.providers
    .find((p) => p.id === "email")!
    .fields.find((f) => f.name === "RESEND_API_KEY")!;
  assert.equal(field.configured, true);
  assert.equal(field.stored, true);
  assert.equal(field.value, undefined);
  const row = (
    await pool.query("SELECT * FROM provider_settings WHERE provider='email'")
  ).rows[0];
  assert.ok(!JSON.stringify(row).includes(secret));
  const history = (
    await pool.query("SELECT detail FROM audit_log WHERE actor_id=$1", [
      owner.id,
    ])
  ).rows;
  assert.ok(!JSON.stringify(history).includes(secret));
  assert.equal(providerValue("RESEND_API_KEY"), undefined);
});
test("saved config powers adapters, survives blank secret updates and rejects stale versions", async () => {
  await settings.save(owner, randomUUID(), "email", {
    version: 1,
    enabled: true,
    values: { RESEND_API_KEY: "", EMAIL_FROM: "verified@example.test" },
  });
  assert.equal(providerValue("RESEND_API_KEY"), secret);
  assert.equal(providerValue("EMAIL_FROM"), "verified@example.test");
  await assert.rejects(
    settings.save(owner, randomUUID(), "email", {
      version: 1,
      enabled: false,
      values: {},
    }),
    /changed/,
  );
  await settings.save(owner, randomUUID(), "email", {
    version: 2,
    enabled: false,
    values: {},
    clear_secrets: ["RESEND_API_KEY"],
  });
  assert.equal(providerValue("RESEND_API_KEY"), undefined);
});
test("missing encryption key prevents secret writes and isolated demo prevents live activation", async () => {
  const valid = process.env.PROVIDER_SETTINGS_KEY;
  delete process.env.PROVIDER_SETTINGS_KEY;
  await assert.rejects(
    settings.save(owner, randomUUID(), "email", {
      version: 3,
      enabled: false,
      values: { RESEND_API_KEY: secret },
    }),
    /storage/,
  );
  process.env.PROVIDER_SETTINGS_KEY = valid;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
  await assert.rejects(
    settings.save(owner, randomUUID(), "email", {
      version: 3,
      enabled: true,
      values: { RESEND_API_KEY: secret, EMAIL_FROM: "verified@example.test" },
    }),
    /isolated demo/,
  );
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  await assert.rejects(
    settings.save(owner, randomUUID(), "email", {
      version: 3,
      enabled: false,
      values: { ARBITRARY_KEY: "value" },
    }),
    /Unsupported/,
  );
});
test("public Firebase configuration stays isolated in emulator mode and exposes no provider secrets", async () => {
  const oldProject = process.env.FIREBASE_PROJECT_ID,
    oldEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  try {
    process.env.FIREBASE_PROJECT_ID = "demo-corewaste";
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    const value = await settings.publicClientConfig();
    assert.deepEqual(value, {
      projectId: "demo-corewaste",
      apiKey: "local-demo-only",
      authDomain: "demo-corewaste.firebaseapp.com",
    });
    assert.ok(!JSON.stringify(value).includes(secret));
  } finally {
    if (oldProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = oldProject;
    if (oldEmulator === undefined)
      delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = oldEmulator;
  }
});
