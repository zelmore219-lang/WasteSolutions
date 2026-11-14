import { Pool } from "pg";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
export function assertDemoEnvironment(env: NodeJS.ProcessEnv) {
  const db = new URL(env.DATABASE_URL || "invalid:");
  if (
    env.NODE_ENV !== "test" ||
    env.FIREBASE_PROJECT_ID !== "demo-corewaste" ||
    env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" ||
    !["127.0.0.1", "localhost", "postgres"].includes(db.hostname) ||
    ![
      "/corewaste_local_test",
      "/corewaste_preview_test",
      "/corewaste_demo_test",
    ].includes(db.pathname)
  )
    throw Error(
      "The public demo account is restricted to the isolated demo emulator and dedicated demo databases.",
    );
}
export async function provisionDemoAccount() {
  assertDemoEnvironment(process.env);
  const app =
    getApps().find((a) => a.name === "isolated-demo-account") ||
    initializeApp({ projectId: "demo-corewaste" }, "isolated-demo-account");
  if (app.options.projectId !== "demo-corewaste")
    throw Error("Unexpected demo identity project");
  const auth = getAuth(app),
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('corewaste-demo-account'))",
    );
    const existing = (
      await c.query("SELECT * FROM employees WHERE username='demo' FOR UPDATE")
    ).rows[0];
    if (existing && (existing.role !== "dispatcher" || !existing.active))
      throw Error(
        "The demo account was disabled or its role changed; provisioning will not reset its permissions.",
      );
    let identity;
    try {
      identity = await auth.getUserByEmail("demo@corewaste.local.test");
    } catch (e: any) {
      if (e.code !== "auth/user-not-found") throw e;
      identity = await auth.createUser({
        email: "demo@corewaste.local.test",
        password: "password1",
        emailVerified: true,
        displayName: "Demo",
      });
    }
    if (existing && existing.firebase_uid !== identity.uid) {
      const collision = (
        await c.query(
          "SELECT id FROM employees WHERE firebase_uid=$1 AND id<>$2",
          [identity.uid, existing.id],
        )
      ).rowCount;
      if (collision)
        throw Error("Demo identity already belongs to another employee");
    }
    await auth.updateUser(identity.uid, {
      password: "password1",
      emailVerified: true,
    });
    if (existing)
      await c.query("UPDATE employees SET firebase_uid=$1 WHERE id=$2", [
        identity.uid,
        existing.id,
      ]);
    else
      await c.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,'demo','Demo','dispatcher')",
        [identity.uid],
      );
    await c.query("COMMIT");
    return {
      username: "demo",
      email: "demo@corewaste.local.test",
      role: "dispatcher",
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
