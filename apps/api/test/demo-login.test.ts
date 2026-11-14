import { test } from "node:test";
import assert from "node:assert/strict";
import { loginIdentifier } from "../../web/src/login-identifier";
import { assertDemoEnvironment } from "../src/demo-account";
test("demo username resolves only inside the isolated demo", () => {
  assert.equal(
    loginIdentifier(" Demo ", undefined, true),
    "demo@corewaste.local.test",
  );
  assert.throws(() => loginIdentifier("demo", undefined, false), /domain/);
  assert.equal(
    loginIdentifier("demo", "company.example", false),
    "demo@company.example",
  );
  assert.equal(
    loginIdentifier("dispatcher@example.test", undefined, true),
    "dispatcher@example.test",
  );
});
test("public demo credential cannot be provisioned against production, real Firebase, or business databases", () => {
  const env = {
    NODE_ENV: "test",
    FIREBASE_PROJECT_ID: "demo-corewaste",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    DATABASE_URL: "postgresql://local@127.0.0.1/corewaste_demo_test",
  };
  assert.doesNotThrow(() => assertDemoEnvironment(env));
  for (const change of [
    { NODE_ENV: "production" },
    { FIREBASE_PROJECT_ID: "wastesoloutions" },
    { FIREBASE_AUTH_EMULATOR_HOST: undefined },
    {
      DATABASE_URL: "postgresql://local@production.example/corewaste_demo_test",
    },
    { DATABASE_URL: "postgresql://local@127.0.0.1/corewaste" },
  ])
    assert.throws(() => assertDemoEnvironment({ ...env, ...change }));
});
