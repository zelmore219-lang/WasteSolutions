import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { assertIdentityConfiguration } from "../apps/api/src/identity-config";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = url;
process.env.FIREBASE_PROJECT_ID = "demo-corewaste";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
test("emulator configuration cannot be enabled in production or for a real Firebase project", () => {
  assert.throws(
    () =>
      assertIdentityConfiguration({
        NODE_ENV: "production",
        FIREBASE_PROJECT_ID: "demo-corewaste",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      }),
    /restricted|requires/,
  );
  assert.throws(
    () =>
      assertIdentityConfiguration({
        NODE_ENV: "test",
        FIREBASE_PROJECT_ID: "real-project",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      }),
    /requires/,
  );
  assert.throws(
    () =>
      assertIdentityConfiguration({
        NODE_ENV: "test",
        FIREBASE_PROJECT_ID: "demo-corewaste",
        FIREBASE_AUTH_EMULATOR_HOST: "example.com:9099",
      }),
    /requires/,
  );
});
test("Firebase emulator identities pass real HTTP role, ownership, MFA and revocation enforcement", async () => {
  const { createApp, pool } = await import("../apps/api/src/app");
  const { getAuth } = await import("firebase-admin/auth");
  const app = await createApp();
  const signup = async () => {
    const r = await fetch(
      "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=local-test-key",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `identity-${randomUUID()}@example.test`,
          password: randomBytes(24).toString("base64url"),
          returnSecureToken: true,
        }),
      },
    );
    assert.equal(r.status, 200);
    return await r.json();
  };
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const dispatcher = await signup();
    let r = await fetch(base + "/api/me", {
      headers: { Authorization: `Bearer ${dispatcher.idToken}` },
    });
    assert.equal(r.status, 403, "unprovisioned identities denied");
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Identity test dispatcher','dispatcher')",
      [dispatcher.localId, "id_" + randomUUID().slice(0, 8)],
    );
    const request = (path: string, token: string, body?: unknown) =>
      fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    r = await request("/api/me", dispatcher.idToken);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).role, "dispatcher");
    r = await request("/api/customers", dispatcher.idToken, {
      name: "Authenticated customer",
      kind: "residential",
      email: "auth-customer@example.test",
      billing_address: "1 Real Test Road",
    });
    assert.equal(r.status, 201);
    const c = await r.json();
    const identity = await signup();
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,'Identity test customer','customer',$3)",
      [identity.localId, "id_" + randomUUID().slice(0, 8), c.id],
    );
    r = await request("/api/customers", identity.idToken);
    assert.equal(r.status, 200);
    assert.deepEqual(
      (await r.json()).map((x: any) => x.id),
      [c.id],
    );
    r = await request("/api/customers", identity.idToken, {
      name: "Unauthorized",
    });
    assert.equal(r.status, 403);
    const administrator = await signup();
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Identity test owner','owner')",
      [administrator.localId, "id_" + randomUUID().slice(0, 8)],
    );
    r = await request("/api/me", administrator.idToken);
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /MFA/);
    const streamController = new AbortController();
    const stream = await fetch(base + "/api/events", {
      headers: { Authorization: `Bearer ${identity.idToken}` },
      signal: streamController.signal,
    });
    assert.equal(stream.status, 200);
    let events = "";
    const reader = stream.body!.getReader();
    const listen = (async () => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          events += decoder.decode(chunk.value, { stream: true });
        }
      } catch (error) {
        if (!streamController.signal.aborted) throw error;
      }
    })();
    try {
      const unrelated = await request("/api/customers", dispatcher.idToken, {
        name: "Unrelated SSE account",
        kind: "commercial",
        email: "unrelated-sse@example.test",
        billing_address: "Other account street",
      });
      assert.equal(unrelated.status, 201);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        events.includes("event: refresh"),
        false,
        "customer cannot observe another account change",
      );
      const location = await request(
        `/api/customers/${c.id}/locations`,
        dispatcher.idToken,
        { address: "SSE customer location" },
      );
      assert.equal(location.status, 201);
      const end = Date.now() + 3000;
      while (!events.includes("event: refresh") && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(
        events.includes("event: refresh"),
        "PostgreSQL commit delivers scoped live refresh",
      );
    } finally {
      streamController.abort();
      await listen;
    }
    await getAuth().updateUser(identity.localId, { disabled: true });
    r = await request("/api/me", identity.idToken);
    assert.equal(r.status, 401);
    r = await request("/api/me", "tampered-token");
    assert.equal(r.status, 401);
  } finally {
    await app.close();
    await pool.end();
  }
});
