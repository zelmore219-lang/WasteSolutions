delete process.env.STRIPE_SECRET_KEY;
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import Stripe from "stripe";
import { Operations, Actor } from "../src/domain";
import { Finance } from "../src/finance";
import { Station } from "../src/station";
import { BillingControls } from "../src/billing-controls";
import { StripePayments } from "../src/stripe-payments";
import { StripeProfiles } from "../src/stripe-profiles";
import { Automation } from "../src/automation";
import { Workflows } from "../src/workflows";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  finance = new Finance(ops),
  station = new Station(ops),
  billing = new BillingControls(ops),
  payments = new StripePayments(ops, finance),
  profiles = new StripeProfiles(ops, (e, t) => payments.process(e, t)),
  wf = new Workflows(ops),
  automation = new Automation(ops, wf, billing, profiles);
payments.profileEvents = (e) => profiles.event(e);
const key = () => randomUUID();
let owner: Actor,
  customer: Actor,
  customerId: string,
  locationId: string,
  materialId: string;
before(async () => {
  owner = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Billing owner','owner') RETURNING *",
      [key(), "bill_" + key().slice(0, 8)],
    )
  ).rows[0];
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Billing controls fixture",
    kind: "commercial",
    email: "billing-control-" + key() + "@example.test",
    billing_address: "Billing control street",
  });
  customerId = c.id;
  customer = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,'Billing customer','customer',$3) RETURNING *",
      [key(), "bill_" + key().slice(0, 8), c.id],
    )
  ).rows[0];
  locationId = (
    (await ops.createLocation(owner, key(), c.id, {
      address: "Billing service street",
    })) as any
  ).id;
  materialId = (
    (await station.material(owner, key(), {
      name: "Billing material " + key(),
      category: "landfill",
      rate_cents_per_tonne: 10000,
      minimum_charge_cents: 0,
    })) as any
  ).id;
});
after(async () => {
  await pool.end();
});
async function invoice() {
  const t: any = await station.open(owner, key(), {
    customer_id: customerId,
    material_id: materialId,
    direction: "inbound",
    vehicle_number: "BILL-TEST",
    first_weight_kg: 8000,
    source_reference: "Manual test reading",
  });
  await station.weigh(owner, key(), t.id, {
    second_weight_kg: 7000,
    version: 1,
  });
  return (await station.invoice(owner, key(), t.id)) as any;
}
async function signed(event: Stripe.Event) {
  const secret =
    process.env.STRIPE_WEBHOOK_SECRET || randomBytes(32).toString("hex");
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  const payload = JSON.stringify(event);
  return payments.webhook(
    Buffer.from(payload),
    Stripe.webhooks.generateTestHeaderString({ payload, secret }),
  );
}
test("credit memo reduces receivables; paid excess becomes refundable account credit without negative invoice balance", async () => {
  const i = await invoice();
  await finance.payment(owner, key(), i.id, {
    amount_cents: 10000,
    method: "cash",
    reference: key(),
  });
  const result: any = await billing.creditInvoice(owner, key(), i.id, {
    amount_cents: 4000,
    reason: "Partial service adjustment",
  });
  assert.equal(result.balance_cents, 0);
  const view = (
    await pool.query("SELECT * FROM invoice_balances WHERE id=$1", [i.id])
  ).rows[0];
  assert.equal(Number(view.net_amount_cents), 6000);
  assert.equal(Number(view.credit_transferred_cents), 4000);
  const credit = (
    await pool.query("SELECT * FROM customer_credits WHERE id=$1", [
      result.credit_id,
    ])
  ).rows[0];
  assert.equal(credit.remaining_cents, 4000);
  await billing.refundCredit(owner, key(), credit.id, {
    amount_cents: 4000,
    method: "check",
    reference: key(),
    reason: "Customer account-credit refund already issued",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT remaining_cents FROM customer_credits WHERE id=$1",
        [credit.id],
      )
    ).rows[0].remaining_cents,
    0,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT balance_cents FROM invoice_balances WHERE id=$1",
          [i.id],
        )
      ).rows[0].balance_cents,
    ),
    0,
  );
  await assert.rejects(
    billing.creditInvoice(owner, key(), i.id, {
      amount_cents: 7000,
      reason: "Too large",
    }),
    /exceeds/,
  );
});
test("configured late fee applies once after grace period; disabled policy never charges fees", async () => {
  const settings = (
      await pool.query(
        "SELECT late_fee_cents,late_fee_grace_days FROM company_settings WHERE singleton",
      )
    ).rows[0],
    i = await invoice();
  try {
    await pool.query(
      "UPDATE company_settings SET late_fee_cents=0 WHERE singleton",
    );
    assert.equal(
      ((await billing.lateFee(owner, key(), i.id, "2030-01-01")) as any)
        .applied,
      false,
    );
    await pool.query(
      "UPDATE company_settings SET late_fee_cents=1250,late_fee_grace_days=3 WHERE singleton",
    );
    const [a, b]: any[] = await Promise.all([
      billing.lateFee(owner, key(), i.id, "2030-01-01"),
      billing.lateFee(owner, key(), i.id, "2030-01-01"),
    ]);
    assert.equal([a, b].filter((x) => x.applied).length, 1);
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT balance_cents FROM invoice_balances WHERE id=$1",
            [i.id],
          )
        ).rows[0].balance_cents,
      ),
      11250,
    );
  } finally {
    await pool.query(
      "UPDATE company_settings SET late_fee_cents=$1,late_fee_grace_days=$2 WHERE singleton",
      [settings.late_fee_cents, settings.late_fee_grace_days],
    );
  }
});
test("verified setup events save only provider tokens; withdrawn consent cannot be re-enabled by a late setup webhook", async () => {
  const provider = "cus_" + key();
  await pool.query(
    "INSERT INTO stripe_profiles(customer_id,provider_customer_id) VALUES($1,$2)",
    [customerId, provider],
  );
  const request = (
    await pool.query(
      "INSERT INTO payment_setup_requests(customer_id,actor_id,enable_autopay,max_charge_cents,settings_version) VALUES($1,$2,true,50000,1) RETURNING *",
      [customerId, customer.id],
    )
  ).rows[0];
  const event = {
    id: "evt_" + key(),
    type: "setup_intent.succeeded",
    data: {
      object: {
        id: "seti_" + key(),
        status: "succeeded",
        customer: provider,
        payment_method: "pm_" + key(),
        metadata: { corewaste_setup_request_id: request.id },
      },
    },
  } as unknown as Stripe.Event;
  await signed(event);
  assert.equal((await profiles.profile(customer)).autopay_enabled, true);
  assert.equal((await profiles.profile(customer)).method_saved, true);
  await profiles.settings(customer, key(), {
    enabled: false,
    max_charge_cents: 50000,
    consent: false,
  });
  const lateRequest = (
    await pool.query(
      "INSERT INTO payment_setup_requests(customer_id,actor_id,enable_autopay,max_charge_cents,settings_version) VALUES($1,$2,true,50000,1) RETURNING *",
      [customerId, customer.id],
    )
  ).rows[0];
  const late = {
    ...event,
    id: "evt_" + key(),
    data: {
      object: {
        ...event.data.object,
        metadata: { corewaste_setup_request_id: lateRequest.id },
      },
    },
  } as unknown as Stripe.Event;
  await signed(late);
  assert.equal((await profiles.profile(customer)).autopay_enabled, false);
  assert.equal(
    (
      await pool.query("SELECT state FROM payment_setup_requests WHERE id=$1", [
        lateRequest.id,
      ])
    ).rows[0].state,
    "cancelled",
  );
});
test("autopay payment-intent webhooks reconcile once and preserve their original provider event type", async () => {
  const i = await invoice(),
    intent = "pi_" + key();
  const attempt = (
    await pool.query(
      "INSERT INTO payment_attempts(invoice_id,amount_cents,provider_session_id,source) VALUES($1,$2,$3,'autopay') RETURNING *",
      [i.id, i.amount_cents, intent],
    )
  ).rows[0];
  const event = {
    id: "evt_" + key(),
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: intent,
        currency: "usd",
        amount: i.amount_cents,
        amount_received: i.amount_cents,
        status: "succeeded",
        metadata: { corewaste_attempt_id: attempt.id },
      },
    },
  } as unknown as Stripe.Event;
  await signed(event);
  await signed(event);
  assert.equal(
    (await pool.query("SELECT status FROM invoices WHERE id=$1", [i.id]))
      .rows[0].status,
    "paid",
  );
  assert.equal(
    (
      await pool.query("SELECT kind FROM provider_events WHERE id=$1", [
        event.id,
      ])
    ).rows[0].kind,
    "payment_intent.succeeded",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1",
        [i.id],
      )
    ).rows[0].n,
    1,
  );
});
test("scheduled billing generates recurring work and invoices completed service without duplicate invoices on rerun", async () => {
  await wf.agreement(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "commercial",
    price_cents: 8500,
    interval_days: 7,
    next_service_date: "2026-11-20",
  });
  const driver = (
      await pool.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Automation driver','driver') RETURNING *",
        [key(), "auto_" + key().slice(0, 8)],
      )
    ).rows[0],
    truck = (
      await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
        "AUTO-" + key(),
      ])
    ).rows[0];
  const o: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "pickup",
    scheduled_date: "2026-11-20",
    price_cents: 8500,
  });
  let assigned: any = await ops.assign(owner, key(), o.id, {
    driver_id: driver.id,
    truck_id: truck.id,
    version: 1,
  });
  assigned = await ops.transition(driver, key(), o.id, {
    status: "in_progress",
    version: assigned.version,
  });
  await ops.transition(driver, key(), o.id, {
    status: "completed",
    version: assigned.version,
  });
  const result: any = await automation.run(owner, "2026-11-20");
  assert.ok(result.summary.generated_orders >= 1);
  assert.equal(result.status, "completed");
  await automation.run(owner, "2026-11-20");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM invoices WHERE order_id=$1",
        [o.id],
      )
    ).rows[0].n,
    1,
  );
});
