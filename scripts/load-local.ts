import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Pool } from "pg";
const database = process.env.TEST_DATABASE_URL;
if (
  !database ||
  !new URL(database).pathname.endsWith("_test") ||
  !["127.0.0.1", "localhost"].includes(new URL(database).hostname)
)
  throw Error(
    "TEST_DATABASE_URL must identify a loopback disposable *_test database",
  );
const host = "http://127.0.0.1:9099",
  port = 3200,
  base = "http://127.0.0.1:" + port;
const directory = ".local/load-tests",
  id = randomUUID(),
  pool = new Pool({ connectionString: database });
await mkdir(directory, { recursive: true, mode: 0o700 });
const log = await open(directory + "/api-" + id + ".log", "w", 0o600);
let child: ReturnType<typeof spawn> | undefined,
  token: string | undefined,
  employeeId: string | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  // Refuse to take over an existing service; never benchmark an arbitrary supplied URL.
  let occupied = false;
  try {
    await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) });
    occupied = true;
  } catch {}
  if (occupied)
    throw Error(
      "Port 3200 is already in use; stop only the service you own before running this local check",
    );
  const signed = await fetch(
    host +
      "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-load-only",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "load-" + id + "@example.test",
        password: randomBytes(24).toString("base64url"),
        returnSecureToken: true,
      }),
    },
  );
  if (!signed.ok) throw Error("Local demo auth emulator signup failed");
  const identity = (await signed.json()) as any;
  token = identity.idToken;
  employeeId = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Local load acceptance fixture','accountant') RETURNING id",
      [identity.localId, "load_" + id.replaceAll("-", "")],
    )
  ).rows[0].id;
  child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_URL: database,
      FIREBASE_PROJECT_ID: "demo-corewaste",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      PAYMENTS_MODE: "test",
      QUICKBOOKS_CLIENT_ID: "",
      ROUTING_API_KEY: "",
      NOTIFICATIONS_WORKER_ENABLED: "false",
      STORAGE_DRIVER: "local",
      WEB_ORIGIN: "http://127.0.0.1:5173",
    },
    stdio: ["ignore", log.fd, log.fd],
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null)
      throw Error(
        "Local acceptance API exited; inspect its private startup log",
      );
    try {
      if (
        (
          await fetch(base + "/api/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (!ready) throw Error("Local acceptance API did not become ready");
  const today = (
    await pool.query(
      "SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM company_settings WHERE singleton",
    )
  ).rows[0].today;
  const paths = [
    "/api/customers?limit=50",
    "/api/expenses",
    "/api/provider-refunds",
    "/api/reports/profitability?from=" + today + "&to=" + today,
  ];
  const latencies: number[] = [],
    counts: Record<string, number> = {},
    failures: { path: string; status: number }[] = [];
  let index = 0;
  const requests = 240,
    concurrency = 8,
    start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (index < requests) {
        const i = index++,
          path = paths[i % paths.length],
          before = performance.now();
        const response = await fetch(base + path, {
          headers: { Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(15000),
        });
        // Consume and discard sensitive fixture data. Never store response bodies or tokens in results.
        await response.arrayBuffer();
        latencies.push(performance.now() - before);
        counts[String(response.status)] =
          (counts[String(response.status)] || 0) + 1;
        if (response.status !== 200)
          failures.push({ path, status: response.status });
      }
    }),
  );
  const elapsed = performance.now() - start;
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) =>
    Math.round(
      latencies[
        Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)
      ] * 100,
    ) / 100;
  const dataset = (
    await pool.query(
      "SELECT (SELECT count(*) FROM customers)::int AS customers,(SELECT count(*) FROM orders)::int AS orders,(SELECT count(*) FROM journal)::int AS journal_rows",
    )
  ).rows[0];
  const result = {
    scope: "loopback API + local PostgreSQL + demo Firebase auth emulator only",
    requests,
    concurrency,
    statuses: counts,
    elapsed_ms: Math.round(elapsed),
    requests_per_second: Math.round((requests / (elapsed / 1000)) * 100) / 100,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
    max_ms: percentile(1),
    dataset,
    failure_count: failures.length,
    failures: failures.slice(0, 10),
    node: process.version,
  };
  const resultPath = directory + "/result-" + id + ".json";
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...result, result_path: resultPath }, null, 2));
  if (failures.length)
    throw Error("Authenticated local load check had unsuccessful responses");
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      child!.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    for (
      let i = 0;
      i < 40 && child.exitCode === null && child.signalCode === null;
      i++
    )
      await sleep(100);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
  if (employeeId)
    await pool.query("UPDATE employees SET active=false WHERE id=$1", [
      employeeId,
    ]);
  if (token) {
    const removed = await fetch(
      host +
        "/identitytoolkit.googleapis.com/v1/accounts:delete?key=local-load-only",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token }),
      },
    );
    if (!removed.ok)
      console.error(
        "Only the generated load-fixture emulator identity needs cleanup",
      );
  }
  await pool.end();
  await log.close();
}
