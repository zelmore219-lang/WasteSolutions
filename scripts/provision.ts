import { Pool } from "pg";
import { z } from "zod";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
// Operator-only command, not an API endpoint. Uses existing ADC; never accepts passwords or keys.
const [kind, ...args] = process.argv.slice(2);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (kind === "truck") {
    const number = z.string().trim().min(1).max(40).parse(args[0]);
    const r = await pool.query(
      "INSERT INTO trucks(number) VALUES($1) RETURNING id,number",
      [number],
    );
    console.log(r.rows[0]);
  } else if (kind === "account") {
    const [uid, username, displayName, role, customerId] = args;
    z.string().min(1).parse(uid);
    z.string()
      .regex(/^[a-z0-9._-]{3,64}$/)
      .parse(username);
    z.string().trim().min(1).max(200).parse(displayName);
    z.enum([
      "owner",
      "manager",
      "dispatcher",
      "office",
      "accountant",
      "driver",
      "customer",
    ]).parse(role);
    if (role === "customer") z.uuid().parse(customerId);
    else if (customerId)
      throw new Error("Only customer accounts may have a customer ID");
    if (!process.env.FIREBASE_PROJECT_ID)
      throw new Error("FIREBASE_PROJECT_ID required");
    initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID,
      credential: applicationDefault(),
    });
    const identity = await getAuth().getUser(uid);
    const domain = process.env.VITE_EMPLOYEE_LOGIN_DOMAIN;
    if (
      role !== "customer" &&
      domain &&
      identity.email?.toLowerCase() !== `${username}@${domain}`.toLowerCase()
    )
      throw new Error(
        "Firebase employee email must match USERNAME at the configured company login domain",
      );
    if (identity.disabled) throw new Error("Firebase identity is disabled");
    if (
      ["owner", "manager"].includes(role) &&
      !identity.multiFactor?.enrolledFactors?.length
    )
      throw new Error("Enroll administrator MFA before provisioning");
    const r = await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,$3,$4,$5) RETURNING id,username,role",
      [uid, username, displayName, role, customerId || null],
    );
    console.log(r.rows[0]);
  } else
    throw new Error(
      "Usage: provision.ts truck NUMBER | account FIREBASE_UID USERNAME DISPLAY_NAME ROLE [CUSTOMER_UUID]",
    );
} finally {
  await pool.end();
}
