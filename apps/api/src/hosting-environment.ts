export function configureHostingEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  const host = env.RENDER_EXTERNAL_HOSTNAME;
  if (host) {
    if (!/^[a-z0-9-]+\.onrender\.com$/.test(host))
      throw Error("Invalid managed service hostname");
    if (!env.WEB_ORIGIN) env.WEB_ORIGIN = "https://" + host;
    if (!env.PUBLIC_WEB_URL) env.PUBLIC_WEB_URL = env.WEB_ORIGIN;
  }
  if (env.NODE_ENV === "production" && env.DATABASE_URL) {
    let db: URL;
    try {
      db = new URL(env.DATABASE_URL);
    } catch {
      throw Error(
        "Enter a valid private PostgreSQL connection URL in Render DATABASE_URL.",
      );
    }
    if (
      db.hostname.endsWith(".pooler.supabase.com") &&
      db.searchParams.get("sslmode") !== "verify-full"
    )
      throw Error(
        "Use sslmode=verify-full for the private Supabase database connection.",
      );
    if (db.hostname.endsWith(".pooler.supabase.com") && db.port !== "5432")
      throw Error(
        "Use Supabase session pooling on port 5432; transaction pooling cannot support the live updates stream.",
      );
  }
}
export async function verifyHostedCredentials(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.NODE_ENV !== "production" || !env.RENDER_EXTERNAL_HOSTNAME) return;
  try {
    let raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      const { readFile } = await import("node:fs/promises");
      raw = await readFile(env.GOOGLE_APPLICATION_CREDENTIALS || "", "utf8");
    }
    const data = JSON.parse(raw);
    if (
      data.type !== "service_account" ||
      data.project_id !== env.FIREBASE_PROJECT_ID ||
      typeof data.client_email !== "string" ||
      typeof data.private_key !== "string"
    )
      throw Error();
    const { cert, getApps, initializeApp } = await import("firebase-admin/app");
    const existing = getApps().find((app) => app.name === "[DEFAULT]");
    if (existing && existing.options.projectId !== env.FIREBASE_PROJECT_ID)
      throw Error();
    if (!existing)
      initializeApp({
        projectId: env.FIREBASE_PROJECT_ID,
        credential: cert({
          projectId: data.project_id,
          clientEmail: data.client_email,
          privateKey: data.private_key,
        }),
      });
  } catch {
    throw Error(
      "Set the matching Firebase service-account JSON in Render's private FIREBASE_SERVICE_ACCOUNT_JSON environment field. Do not put it in the repository or chat.",
    );
  }
}
export async function verifyHostedDatabase(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.NODE_ENV !== "production" || !env.RENDER_EXTERNAL_HOSTNAME) return;
  const { Pool } = await import("pg"),
    { readdir } = await import("node:fs/promises"),
    { resolve } = await import("node:path");
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  try {
    const files = (await readdir(resolve(__dirname, "../../../database")))
      .filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n))
      .sort();
    const version = files.at(-1)?.slice(0, -4);
    if (!version) throw Error();
    const row = (
      await pool.query(
        "SELECT current_user AS role,EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) AS ready",
        [version],
      )
    ).rows[0];
    if (row.role !== "corewaste_app" || !row.ready) throw Error();
  } catch {
    throw Error(
      "Run the CoreWaste Supabase schema setup first, then connect Render using the restricted corewaste_app session-pooler login. Do not use the project administrator password.",
    );
  } finally {
    await pool.end();
  }
}
