import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { DecodedIdToken } from "firebase-admin/auth";
import { Actor, Operations } from "../src/domain";
import { Portal } from "../src/portal";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  portal = new Portal(ops);
const key = () => randomUUID();
let office: Actor;
before(async () => {
  office = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Portal office','office') RETURNING *",
      [key(), "portal_" + key().slice(0, 8)],
    )
  ).rows[0];
});
after(async () => {
  await pool.end();
});
const identity = (verified: boolean, email: string) =>
  ({ uid: key(), email, email_verified: verified }) as DecodedIdToken;
test("public inquiry retries cannot create duplicate work; honeypot submissions never create company records", async () => {
  const body = {
    request_id: key(),
    name: "Public inquiry test",
    email: "inquiry@example.test",
    phone: "",
    service_address: "Inquiry service road",
    service_kind: "roll_off",
    message: "Please review a container request",
  };
  const [a, b]: any[] = await Promise.all([
    portal.inquiry(body),
    portal.inquiry(body),
  ]);
  assert.equal(a.reference, b.reference);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM public_inquiries WHERE request_id=$1",
        [body.request_id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    portal.inquiry({ ...body, message: "Changed request" }),
    /reused/,
  );
  const honeypot = { ...body, request_id: key(), website: "bot-filled-field" };
  await portal.inquiry(honeypot);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM public_inquiries WHERE request_id=$1",
        [honeypot.request_id],
      )
    ).rows[0].n,
    0,
  );
});
test("verified registration waits for office approval and cannot claim a customer with another email", async () => {
  const email = "portal-" + key() + "@example.test",
    id = identity(true, email),
    body = {
      name: "New verified customer",
      kind: "residential",
      phone: "",
      billing_address: "Verified billing road",
      service_address: "Verified service road",
    };
  await assert.rejects(
    portal.registration({ ...id, email_verified: false }, body),
    /Verify your email/,
  );
  const reg: any = await portal.registration(id, body);
  assert.equal(reg.status, "pending");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM employees WHERE firebase_uid=$1",
        [id.uid],
      )
    ).rows[0].n,
    0,
  );
  const other: any = await ops.createCustomer(office, key(), {
    name: "Another customer",
    kind: "commercial",
    email: "other-" + key() + "@example.test",
    billing_address: "Another billing road",
  });
  await assert.rejects(
    portal.review(office, key(), reg.id, {
      decision: "approve",
      customer_id: other.id,
      review_note: "Incorrect link attempt",
    }),
    /match the verified email/,
  );
  const approved: any = await portal.review(office, key(), reg.id, {
    decision: "approve",
    review_note: "Verified request reviewed by office",
  });
  const account = (
    await pool.query("SELECT * FROM employees WHERE firebase_uid=$1", [id.uid])
  ).rows[0];
  assert.equal(account.role, "customer");
  assert.equal(account.customer_id, approved.customer_id);
  assert.equal((await ops.customers(account)).length, 1);
  await assert.rejects(
    portal.review(office, key(), reg.id, {
      decision: "approve",
      review_note: "Duplicate attempt",
    }),
    /already reviewed/,
  );
});
test("office converts a public inquiry into a connected service order only after account and pricing review", async () => {
  const c: any = await ops.createCustomer(office, key(), {
      name: "Reviewed public customer",
      kind: "commercial",
      email: "review-" + key() + "@example.test",
      billing_address: "Review billing road",
    }),
    l: any = await ops.createLocation(office, key(), c.id, {
      address: "Review service road",
    });
  const inquiry: any = await portal.inquiry({
    request_id: key(),
    name: c.name,
    email: c.email,
    phone: "",
    service_address: "Review service road",
    service_kind: "bulk",
    message: "Collect a bulky item after review",
  });
  const o: any = await portal.convert(office, key(), inquiry.reference, {
    customer_id: c.id,
    location_id: l.id,
    kind: "bulk",
    scheduled_date: "2026-11-20",
    price_cents: 15000,
  });
  assert.equal(o.customer_id, c.id);
  assert.equal(o.location_id, l.id);
  assert.equal(o.price_cents, 15000);
  await assert.rejects(
    portal.convert(office, key(), inquiry.reference, {
      customer_id: c.id,
      location_id: l.id,
      kind: "bulk",
      scheduled_date: "2026-11-20",
      price_cents: 15000,
    }),
    /not open/,
  );
});
