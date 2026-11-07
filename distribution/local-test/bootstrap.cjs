const fs = require("node:fs/promises");
const { randomBytes, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
async function main() {
  const db = new URL(process.env.DATABASE_URL || "");
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.FIREBASE_PROJECT_ID !== "demo-corewaste" ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" ||
    db.hostname !== "postgres" ||
    db.pathname !== "/corewaste_local_test"
  )
    throw Error(
      "This initializer only supports the isolated local-test Compose database and demo identity emulator",
    );
  const state = "/app/kit-state";
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const file = state + "/logins.json";
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const pool = new Pool({ connectionString: db.href, max: 2 }),
    lock = await pool.connect();
  try {
    await lock.query(
      "SELECT pg_advisory_lock(hashtext('corewaste-local-test-bootstrap'))",
    );
    const exists = (
      await lock.query(
        "SELECT to_regclass('corewaste_local_test.installation') AS marker,to_regclass('public.employees') AS employees",
      )
    ).rows[0];
    if (exists.marker) {
      const marker = (
        await lock.query(
          "SELECT installation_id FROM corewaste_local_test.installation WHERE singleton",
        )
      ).rows[0];
      if (!saved || marker.installation_id !== saved.installation_id)
        throw Error(
          "Restore the original local-test .state folder for this existing database. No data was reset.",
        );
    } else if (
      exists.employees &&
      (await lock.query("SELECT 1 FROM employees LIMIT 1")).rowCount
    )
      throw Error(
        "Existing employee data found without a local-test marker. Initializer refuses to modify it.",
      );
    if (!saved) {
      saved = {
        installation_id: randomUUID(),
        accounts: ["owner", "dispatcher", "accountant", "driver"].map(
          (role) => ({
            role,
            email: role + "@corewaste.local.test",
            password: randomBytes(24).toString("base64url"),
            ...(role === "owner" ? { phone: "+16505550123" } : {}),
          }),
        ),
      };
      await fs.writeFile(file, JSON.stringify(saved, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    }
    if (
      !Array.isArray(saved.accounts) ||
      saved.accounts.length !== 4 ||
      !["owner", "dispatcher", "accountant", "driver"].every((role) =>
        saved.accounts.some(
          (a) =>
            a.role === role &&
            a.email === role + "@corewaste.local.test" &&
            typeof a.password === "string" &&
            a.password.length >= 24,
        ),
      )
    )
      throw Error(
        "Invalid saved local-test identity configuration; restore .state without resetting the database",
      );
    execFileSync(process.execPath, ["apps/api/dist/migrate.js"], {
      cwd: "/app",
      stdio: "inherit",
    });
    await lock.query("CREATE SCHEMA IF NOT EXISTS corewaste_local_test");
    await lock.query(
      "CREATE TABLE IF NOT EXISTS corewaste_local_test.installation(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),installation_id uuid NOT NULL,truck_id uuid REFERENCES public.trucks(id))",
    );
    await lock.query(
      "CREATE TABLE IF NOT EXISTS corewaste_local_test.accounts(role text PRIMARY KEY,employee_id uuid NOT NULL REFERENCES public.employees(id))",
    );
    await lock.query(
      "INSERT INTO corewaste_local_test.installation(installation_id) VALUES($1) ON CONFLICT(singleton) DO NOTHING",
      [saved.installation_id],
    );
    initializeApp({ projectId: "demo-corewaste" });
    const auth = getAuth();
    for (const account of saved.accounts) {
      const mapping = (
        await lock.query(
          "SELECT e.* FROM corewaste_local_test.accounts a JOIN employees e ON e.id=a.employee_id WHERE a.role=$1",
          [account.role],
        )
      ).rows[0];
      if (mapping && (!mapping.active || mapping.role !== account.role))
        throw Error(
          "A local test account was disabled or changed; resolve it through administration. Bootstrap does not reset permissions.",
        );
      let user;
      try {
        user = await auth.getUserByEmail(account.email);
      } catch (e) {
        if (e.code !== "auth/user-not-found") throw e;
        user = await auth.createUser({
          email: account.email,
          password: account.password,
          emailVerified: true,
          displayName: "Local test " + account.role,
        });
        if (account.role === "owner")
          user = await auth.updateUser(user.uid, {
            multiFactor: {
              enrolledFactors: [
                {
                  uid: "local-test-owner-sms",
                  factorId: "phone",
                  phoneNumber: account.phone,
                  displayName: "Local emulator sign-in code",
                },
              ],
            },
          });
      }
      if (mapping) {
        if (mapping.firebase_uid !== user.uid)
          await lock.query("UPDATE employees SET firebase_uid=$2 WHERE id=$1", [
            mapping.id,
            user.uid,
          ]);
      } else {
        const employee = (
          await lock.query(
            "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$4) RETURNING id",
            [
              user.uid,
              "local_test_" + account.role,
              "Local test " + account.role,
              account.role,
            ],
          )
        ).rows[0];
        await lock.query(
          "INSERT INTO corewaste_local_test.accounts(role,employee_id) VALUES($1,$2)",
          [account.role, employee.id],
        );
      }
    }
    const marker = (
      await lock.query(
        "SELECT truck_id FROM corewaste_local_test.installation WHERE singleton",
      )
    ).rows[0];
    if (!marker.truck_id) {
      const truck = (
        await lock.query(
          "INSERT INTO trucks(number) VALUES('LOCAL-TEST-01') RETURNING id",
        )
      ).rows[0];
      await lock.query(
        "UPDATE corewaste_local_test.installation SET truck_id=$1 WHERE singleton",
        [truck.id],
      );
    }
    console.log(
      "Local test initialization complete. Sign-ins are stored privately in the kit .state folder. No customers, jobs or financial transactions were seeded.",
    );
  } finally {
    await lock.query(
      "SELECT pg_advisory_unlock(hashtext('corewaste-local-test-bootstrap'))",
    );
    lock.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Local test initialization failed. Existing data was retained. Check the saved .state folder and local container status.",
  );
  process.exitCode = 1;
});
