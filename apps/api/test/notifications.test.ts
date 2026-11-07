import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Operations, Actor } from "../src/domain";
import { Notifications } from "../src/notifications";
import { notify } from "../src/notification-outbox";
import { deliverBatch, DeliveryError, DeliveryAdapter } from "../src/delivery";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  notifications = new Notifications(ops);
const key = () => randomUUID();
let owner: Actor, customer: Actor, customerId: string;
before(async () => {
  owner = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Notification owner','owner') RETURNING *",
      [key(), "notice_" + key().slice(0, 8)],
    )
  ).rows[0];
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Notification fixture",
    kind: "residential",
    email: "notice-" + key() + "@example.test",
    phone: "+15555550123",
    billing_address: "Notice street",
  });
  customerId = c.id;
  customer = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,'Notice customer','customer',$3) RETURNING *",
      [key(), "notice_" + key().slice(0, 8), c.id],
    )
  ).rows[0];
});
after(async () => {
  await pool.end();
});
async function queued(channel: "email" | "sms" = "email") {
  const c = await pool.connect(),
    source = key();
  try {
    await c.query("BEGIN");
    await notify(
      c,
      customerId,
      "payment_received",
      "Test payment receipt",
      "Test notification body",
      source,
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  return (
    await pool.query(
      "SELECT o.* FROM notification_outbox o JOIN notifications n ON n.id=o.notification_id WHERE n.source_key=$1 AND o.channel=$2",
      [source, channel],
    )
  ).rows[0];
}
test("concurrent delivery workers claim once and preserve exact rendered message snapshots", async () => {
  await notifications.template(owner, key(), {
    kind: "payment_received",
    subject: "{{company_name}} receipt",
    message: "Hello {{customer_name}}. {{message}}",
    enabled: true,
  });
  const row = await queued(),
    calls: string[] = [];
  const adapter: DeliveryAdapter = {
    channel: "email",
    idempotent: true,
    send: async (m) => {
      calls.push(m.id);
      assert.equal(m.subject, "CoreWaste receipt");
      assert.match(m.body, /Notification fixture/);
      return "email-receipt-" + m.id;
    },
  };
  await Promise.all([
    deliverBatch(pool, [adapter], 1, [row.id]),
    deliverBatch(pool, [adapter], 1, [row.id]),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await pool.query("SELECT state FROM notification_outbox WHERE id=$1", [
        row.id,
      ])
    ).rows[0].state,
    "sent",
  );
});
test("unknown SMS delivery is not retried automatically and requires explicit provider reconciliation", async () => {
  await notifications.savePreferences(customer, key(), {
    email_enabled: true,
    sms_enabled: true,
    sms_consent: true,
  });
  const row = await queued("sms");
  const adapter: DeliveryAdapter = {
    channel: "sms",
    idempotent: false,
    send: async () => {
      throw new DeliveryError("sms_response_unknown", false, true);
    },
  };
  await deliverBatch(pool, [adapter], 1, [row.id]);
  assert.equal(
    (
      await pool.query("SELECT state FROM notification_outbox WHERE id=$1", [
        row.id,
      ])
    ).rows[0].state,
    "uncertain",
  );
  await assert.rejects(
    notifications.retry(owner, key(), row.id, {
      confirmed_not_delivered: false,
      reason: "Not checked",
    }),
    /confirm non-delivery/,
  );
  await notifications.retry(owner, key(), row.id, {
    confirmed_not_delivered: true,
    reason: "Provider evidence confirms the message was not accepted",
  });
  assert.equal(
    (
      await pool.query("SELECT state FROM notification_outbox WHERE id=$1", [
        row.id,
      ])
    ).rows[0].state,
    "pending",
  );
});
test("idempotent email errors retain the same message key and retry with backoff", async () => {
  const row = await queued();
  const observed: string[] = [];
  let fail = true;
  const adapter: DeliveryAdapter = {
    channel: "email",
    idempotent: true,
    send: async (m) => {
      observed.push(m.id);
      if (fail) throw new DeliveryError("email_timeout", false, true);
      return "accepted";
    },
  };
  await deliverBatch(pool, [adapter], 1, [row.id]);
  assert.equal(
    (
      await pool.query("SELECT state FROM notification_outbox WHERE id=$1", [
        row.id,
      ])
    ).rows[0].state,
    "pending",
  );
  await pool.query(
    "UPDATE notification_outbox SET next_attempt_at=now() WHERE id=$1",
    [row.id],
  );
  fail = false;
  await deliverBatch(pool, [adapter], 1, [row.id]);
  assert.deepEqual(observed, [row.id, row.id]);
  assert.equal(
    (
      await pool.query("SELECT state FROM notification_outbox WHERE id=$1", [
        row.id,
      ])
    ).rows[0].state,
    "sent",
  );
});
test("SMS opt-out cancels pending messages before dispatch and invalid template fields are rejected", async () => {
  const row = await queued("sms");
  await notifications.savePreferences(customer, key(), {
    email_enabled: true,
    sms_enabled: false,
    sms_consent: false,
  });
  let sent = false;
  await deliverBatch(
    pool,
    [
      {
        channel: "sms",
        idempotent: false,
        send: async () => {
          sent = true;
          return "must-not-send";
        },
      },
    ],
    1,
    [row.id],
  );
  assert.equal(sent, false);
  assert.equal(
    (
      await pool.query("SELECT state FROM notification_outbox WHERE id=$1", [
        row.id,
      ])
    ).rows[0].state,
    "cancelled",
  );
  await assert.rejects(
    notifications.template(owner, key(), {
      kind: "invalid_template",
      subject: "{{secret}}",
      message: "Bad field",
      enabled: true,
    }),
    /Use only/,
  );
});
