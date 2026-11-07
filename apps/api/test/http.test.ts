import { test } from "node:test";
import assert from "node:assert/strict";
test("Nest HTTP health checks PostgreSQL and business endpoints require Firebase identity", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error("Dedicated test database required");
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = "test";
  process.env.NOTIFICATIONS_WORKER_ENABLED = "false";
  delete process.env.STRIPE_SECRET_KEY;
  const { createApp, pool } = await import("../src/app");
  const app = await createApp();
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const r = await fetch(base + "/api/health");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, "ok");
    for (const path of [
      "/api/customers",
      "/api/orders",
      "/api/invoices",
      "/api/routes",
      "/api/requests",
      "/api/agreements",
      "/api/accounting/quickbooks",
      "/api/accounting/quickbooks/accounts",
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 401, path);
    }
    const response = await fetch(base + "/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
  } finally {
    await app.close();
    await pool.end();
  }
});
