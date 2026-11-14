import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  SupabasePrivateStorage,
  supabaseOrigin,
} from "../src/supabase-storage";
import { configureHostingEnvironment } from "../src/hosting-environment";
import { setProviderRuntime } from "../src/provider-runtime";
const key = "attachments/" + randomUUID(),
  bytes = Buffer.from("private-test-document"),
  digest = createHash("sha256").update(bytes).digest("hex");
function configured() {
  setProviderRuntime({
    SUPABASE_URL: "https://exampleproject.supabase.co",
    SUPABASE_BUCKET: "corewaste-private",
    SUPABASE_SERVICE_ROLE_KEY: "private-server-test-key",
  });
}
test("free host derives only a trusted Render origin and rejects transaction pooling", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    RENDER_EXTERNAL_HOSTNAME: "corewaste-example.onrender.com",
    DATABASE_URL:
      "postgresql://app:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
  };
  configureHostingEnvironment(env);
  assert.equal(env.WEB_ORIGIN, "https://corewaste-example.onrender.com");
  assert.equal(env.PUBLIC_WEB_URL, env.WEB_ORIGIN);
  assert.throws(
    () =>
      configureHostingEnvironment({
        ...env,
        DATABASE_URL: env.DATABASE_URL!.replace(":5432", ":6543"),
      }),
    /session/,
  );
  assert.throws(
    () =>
      configureHostingEnvironment({
        ...env,
        RENDER_EXTERNAL_HOSTNAME: "evil.example",
      }),
    /hostname/,
  );
});
test("private storage accepts only the project HTTPS origin", () => {
  assert.equal(
    supabaseOrigin("https://exampleproject.supabase.co/"),
    "https://exampleproject.supabase.co",
  );
  for (const url of [
    "http://exampleproject.supabase.co",
    "https://exampleproject.supabase.co.evil.test",
    "https://user:pass@exampleproject.supabase.co",
    "https://exampleproject.supabase.co/path",
    "https://exampleproject.supabase.co:444",
  ])
    assert.throws(() => supabaseOrigin(url));
});
test("upload verifies private bucket, authenticates server-side and forbids overwrite/redirects", async () => {
  configured();
  let uploads = 0;
  const driver = new SupabasePrivateStorage(async (url, init) => {
    assert.equal(init!.redirect, "error");
    assert.ok(init!.signal);
    assert.equal(
      (init!.headers as Record<string, string>).Authorization,
      "Bearer private-server-test-key",
    );
    if (String(url).includes("/bucket/"))
      return Response.json({ public: false });
    uploads++;
    assert.equal(init!.method, "POST");
    assert.equal(
      (init!.headers as Record<string, string>)["x-upsert"],
      "false",
    );
    assert.deepEqual(Buffer.from(init!.body as ArrayBuffer), bytes);
    return Response.json({ Key: key });
  });
  await driver.upload(key, bytes, "application/pdf", digest);
  assert.equal(uploads, 1);
  setProviderRuntime({});
});
test("lost upload responses can recover identical bytes but never replace different bytes", async () => {
  configured();
  let different = false;
  const driver = new SupabasePrivateStorage(async (url, init) => {
    if (String(url).includes("/bucket/"))
      return Response.json({ public: false });
    if (init!.method === "POST")
      return Response.json({ error: "Duplicate" }, { status: 400 });
    assert.ok(String(url).includes("/authenticated/"));
    return new Response(different ? "other bytes" : bytes);
  });
  await driver.upload(key, bytes, "application/pdf", digest);
  different = true;
  await assert.rejects(
    driver.upload(key, bytes, "application/pdf", digest),
    /checksum/,
  );
  setProviderRuntime({});
});
test("public buckets, permission failures and oversized downloads fail closed", async () => {
  configured();
  let writes = 0;
  const publicDriver = new SupabasePrivateStorage(async (_url, init) => {
    if (init?.method === "POST") writes++;
    return Response.json({ public: true });
  });
  await assert.rejects(
    publicDriver.upload(key, bytes, "application/pdf", digest),
    /private/,
  );
  assert.equal(writes, 0);
  const unauthorized = new SupabasePrivateStorage(
    async () => new Response("secret remote details", { status: 403 }),
  );
  await assert.rejects(
    unauthorized.download(key),
    (e) => !String(e).includes("secret remote details"),
  );
  const oversized = new SupabasePrivateStorage(async (url) =>
    String(url).includes("/bucket/")
      ? Response.json({ public: false })
      : new Response(new Uint8Array(10485761)),
  );
  await assert.rejects(oversized.download(key), /size limit/);
  setProviderRuntime({});
});
test("Render credentials are validated privately without leaking malformed input", async () => {
  const { verifyHostedCredentials } =
    await import("../src/hosting-environment");
  const env = {
    NODE_ENV: "production",
    RENDER_EXTERNAL_HOSTNAME: "corewaste-example.onrender.com",
    FIREBASE_PROJECT_ID: "wastesoloutions",
    FIREBASE_SERVICE_ACCOUNT_JSON: "never_print_this_invalid_private_input",
  };
  await assert.rejects(
    verifyHostedCredentials(env),
    (error) =>
      String(error).includes("private FIREBASE_SERVICE_ACCOUNT_JSON") &&
      !String(error).includes("never_print_this"),
  );
  const { generateKeyPairSync } = await import("node:crypto"),
    { getApps, deleteApp } = await import("firebase-admin/app");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    type: "service_account",
    project_id: "wastesoloutions",
    client_email: "fixture@wastesoloutions.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  await verifyHostedCredentials({
    ...env,
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
  });
  const app = getApps().find((a) => a.name === "[DEFAULT]");
  assert.equal(app?.options.projectId, "wastesoloutions");
  if (app) await deleteApp(app);
});
