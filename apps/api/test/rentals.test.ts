import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Rentals } from "../src/rentals";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  rentals = new Rentals(ops);
const key = () => randomUUID();
let owner: Actor,
  driver: Actor,
  customerId: string,
  locationId: string,
  truckId: string;
before(async () => {
  for (const role of ["owner", "driver"]) {
    const r = (
      await pool.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$3) RETURNING *",
        [key(), "rental_" + key().slice(0, 8), role],
      )
    ).rows[0];
    if (role === "owner") owner = r;
    else driver = r;
  }
  const customer: any = await ops.createCustomer(owner, key(), {
    name: "Rental test account",
    kind: "commercial",
    email: "rental@example.test",
    billing_address: "1 Billing Road",
  });
  customerId = customer.id;
  locationId = (
    (await ops.createLocation(owner, key(), customerId, {
      address: "2 Delivery Road",
    })) as any
  ).id;
  truckId = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "R-" + key(),
    ])
  ).rows[0].id;
});
after(async () => {
  await pool.end();
});
async function container() {
  return (await rentals.createContainer(owner, key(), {
    number: "CW-" + key(),
    kind: "roll_off",
    capacity_yards: 20,
  })) as any;
}
async function reserve(
  containerId: string,
  extra: Record<string, unknown> = {},
) {
  return (await rentals.reserve(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    container_id: containerId,
    start_date: "2026-11-07",
    pickup_date: "2026-11-14",
    base_price_cents: 40000,
    extension_daily_cents: 2500,
    included_weight_kg: 2000,
    overweight_cents_per_tonne: 8000,
    ...extra,
  })) as any;
}
async function complete(id: string, date: string) {
  let o = (await pool.query("SELECT * FROM orders WHERE id=$1", [id])).rows[0];
  o = await ops.assign(owner, key(), id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: o.version,
  });
  o = await ops.transition(driver, key(), id, {
    status: "in_progress",
    version: o.version,
  });
  const proof = (
    await pool.query(
      "SELECT co.number AS container_number,re.number AS replacement_container_number FROM rental_jobs j JOIN containers co ON co.id=j.container_id LEFT JOIN containers re ON re.id=j.replacement_container_id WHERE j.order_id=$1",
      [id],
    )
  ).rows[0];
  return (await ops.transition(driver, key(), id, {
    status: "completed",
    version: o.version,
    service_date: date,
    container_verification: {
      ...proof,
      replacement_container_number:
        proof.replacement_container_number || undefined,
    },
  })) as any;
}
test("rental → delivery → exchange → pickup → disposal reconciliation → one itemized invoice", async () => {
  const original = await container(),
    replacement = await container();
  const r = await reserve(original.id);
  await complete(r.delivery_order_id, "2026-11-07");
  let live = (await pool.query("SELECT * FROM rentals WHERE id=$1", [r.id]))
    .rows[0];
  assert.equal(live.status, "delivered");
  const exchange: any = await rentals.exchange(owner, key(), r.id, {
    replacement_container_id: replacement.id,
    service_date: "2026-11-10",
    version: live.version,
  });
  await complete(exchange.id, "2026-11-10");
  await rentals.disposal(driver, key(), r.id, {
    order_id: exchange.id,
    facility: "Test facility",
    ticket_number: key(),
    gross_kg: 9000,
    tare_kg: 7000,
    disposal_cost_cents: 12000,
  });
  live = (await pool.query("SELECT * FROM rentals WHERE id=$1", [r.id]))
    .rows[0];
  assert.equal(live.current_container_id, replacement.id);
  const extended: any = await rentals.extend(owner, key(), r.id, {
    pickup_date: "2026-11-16",
    version: live.version,
  });
  assert.equal(extended.pickup_date, "2026-11-16");
  await complete(r.pickup_order_id, "2026-11-16");
  await assert.rejects(rentals.invoice(owner, key(), r.id), /disposal tickets/);
  await rentals.disposal(driver, key(), r.id, {
    order_id: r.pickup_order_id,
    facility: "Test facility",
    ticket_number: key(),
    gross_kg: 9500,
    tare_kg: 7000,
    disposal_cost_cents: 15000,
  });
  const [a, b]: any[] = await Promise.all([
    rentals.invoice(owner, key(), r.id),
    rentals.invoice(owner, key(), r.id),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.amount_cents, 65000); // $400 + 2*$25 + 2.5 metric tonnes*$80
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM container_movements WHERE rental_id=$1",
        [r.id],
      )
    ).rows[0].n,
    4,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT sum(amount_cents)::int AS n FROM invoice_lines WHERE invoice_id=$1",
        [a.id],
      )
    ).rows[0].n,
    65000,
  );
  assert.equal(
    (
      await pool.query("SELECT status FROM containers WHERE id=$1", [
        replacement.id,
      ])
    ).rows[0].status,
    "yard",
  );
  await assert.rejects(
    ops.invoice(owner, key(), r.pickup_order_id),
    /Invoice the rental/,
  );
});
test("concurrent reservations cannot overlap, including the pickup date; cancellation releases availability", async () => {
  const c = await container();
  const results = await Promise.allSettled([reserve(c.id), reserve(c.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const r = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  await assert.rejects(
    reserve(c.id, { start_date: "2026-11-14", pickup_date: "2026-11-15" }),
    /already booked/,
  );
  assert.ok(
    !(
      await rentals.availability(owner, {
        start_date: "2026-11-07",
        pickup_date: "2026-11-14",
      })
    ).some((x) => x.id === c.id),
  );
  await rentals.cancel(owner, key(), r.id, {
    version: r.version,
    reason: "Customer cancelled before delivery",
  });
  assert.ok(
    (
      await rentals.availability(owner, {
        start_date: "2026-11-07",
        pickup_date: "2026-11-14",
      })
    ).some((x) => x.id === c.id),
  );
  const status = (
    await pool.query("SELECT status FROM orders WHERE id=$1", [
      r.delivery_order_id,
    ])
  ).rows[0].status;
  assert.equal(status, "cancelled");
});
test("extension conflicts roll back pickup rescheduling and preserve the original booking", async () => {
  const c = await container(),
    r = await reserve(c.id);
  await reserve(c.id, { start_date: "2026-11-15", pickup_date: "2026-11-21" });
  await assert.rejects(
    rentals.extend(owner, key(), r.id, {
      pickup_date: "2026-11-16",
      version: r.version,
    }),
    /already booked/,
  );
  assert.equal(
    (await pool.query("SELECT pickup_date FROM rentals WHERE id=$1", [r.id]))
      .rows[0].pickup_date,
    "2026-11-14",
  );
  assert.equal(
    (
      await pool.query("SELECT scheduled_date FROM orders WHERE id=$1", [
        r.pickup_order_id,
      ])
    ).rows[0].scheduled_date,
    "2026-11-14",
  );
});
test("physical inventory, disposal validation and authorization reject invalid actions", async () => {
  const c = await container(),
    r = await reserve(c.id);
  let pickup: any = await ops.assign(owner, key(), r.pickup_order_id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  await assert.rejects(
    ops.transition(driver, key(), pickup.id, {
      status: "in_progress",
      version: pickup.version,
    }),
    /not deployed/,
  );
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [pickup.id]))
      .rows[0].status,
    "assigned",
  );
  await assert.rejects(
    ops.transition(driver, key(), pickup.id, {
      status: "completed",
      version: pickup.version,
      service_date: "2026-11-14",
    }),
    /Invalid order transition/,
  );
  await assert.rejects(
    rentals.createContainer(driver, key(), { number: "unauthorized" }),
    /Forbidden/,
  );
  await assert.rejects(
    rentals.disposal(owner, key(), r.id, {
      order_id: pickup.id,
      facility: "X",
      ticket_number: "X",
      gross_kg: 100,
      tare_kg: 200,
      disposal_cost_cents: 0,
    }),
    /Tare exceeds/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM container_movements WHERE rental_id=$1",
        [r.id],
      )
    ).rows[0].n,
    0,
  );
});

import { DisposalLoads } from "../src/disposal-loads";
import { Administration } from "../src/administration";
test("a collected loaded container remains unavailable through unable-to-dump reassignment until verified disposal", async () => {
  const loads = new DisposalLoads(ops),
    c = await container(),
    r = await reserve(c.id);
  await complete(r.delivery_order_id, "2026-11-07");
  await complete(r.pickup_order_id, "2026-11-14");
  assert.equal(
    (await pool.query("SELECT status FROM containers WHERE id=$1", [c.id]))
      .rows[0].status,
    "awaiting_disposal",
  );
  assert.ok(
    !(
      await rentals.availability(owner, {
        start_date: "2026-11-15",
        pickup_date: "2026-11-21",
      })
    ).some((x) => x.id === c.id),
  );
  await assert.rejects(
    reserve(c.id, { start_date: "2026-11-15", pickup_date: "2026-11-21" }),
    /Serviceable/,
  );
  const load = (await loads.list(driver)).find(
    (l) => l.order_id === r.pickup_order_id,
  );
  assert.ok(load);
  const note = {
      version: 1,
      reason: "Facility rejected this load",
      returning_later: false,
      performed_at: new Date().toISOString(),
    },
    failureKey = key();
  const failed: any = await loads.unable(driver, failureKey, load.id, note);
  assert.equal(failed.status, "disposal_failed");
  assert.equal(failed.assigned_driver_id, null);
  assert.deepEqual(
    await loads.unable(driver, failureKey, load.id, note),
    JSON.parse(JSON.stringify(failed)),
  );
  assert.ok(!(await loads.list(driver)).some((l) => l.id === load.id));
  const relief: Actor = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Relief disposal driver','driver') RETURNING *",
      [key(), "relief_" + key().slice(0, 8)],
    )
  ).rows[0];
  const reassigned: any = await loads.assign(owner, key(), load.id, {
    version: 2,
    driver_id: relief.id,
    truck_id: truckId,
  });
  assert.equal(reassigned.version, 3);
  await new Administration(ops).inspect(relief, key(), {
    truck_id: truckId,
    kind: "pre_trip",
    odometer_km: 12000,
    safe_to_operate: true,
    notes: "Disposal-only shift",
  });
  const ticketBody = {
    order_id: r.pickup_order_id,
    facility: "Relief disposal facility",
    ticket_number: key(),
    gross_kg: 9000,
    tare_kg: 7000,
    disposal_cost_cents: 12000,
  };
  await assert.rejects(
    rentals.disposal(driver, key(), r.id, ticketBody),
    /assigned disposal task/,
  );
  const ticketKey = key(),
    ticket: any = await rentals.disposal(relief, ticketKey, r.id, ticketBody);
  assert.deepEqual(
    await rentals.disposal(relief, ticketKey, r.id, ticketBody),
    JSON.parse(JSON.stringify(ticket)),
  );
  assert.equal(
    (await pool.query("SELECT status FROM containers WHERE id=$1", [c.id]))
      .rows[0].status,
    "yard",
  );
  assert.equal(
    (
      await pool.query("SELECT status FROM disposal_loads WHERE id=$1", [
        load.id,
      ])
    ).rows[0].status,
    "disposed",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM disposal_load_events WHERE load_id=$1 AND action='disposed'",
        [load.id],
      )
    ).rows[0].n,
    1,
  );
  assert.ok(
    (
      await rentals.availability(owner, {
        start_date: "2026-11-15",
        pickup_date: "2026-11-21",
      })
    ).some((x) => x.id === c.id),
  );
});

test("rental completion requires the actual container number and stores immutable once-only physical proof", async () => {
  const c = await container(),
    r = await reserve(c.id);
  let o: any = await ops.assign(owner, key(), r.delivery_order_id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  o = await ops.transition(driver, key(), o.id, {
    status: "in_progress",
    version: o.version,
  });
  const body = {
      status: "completed",
      version: o.version,
      service_date: "2026-11-07",
    },
    command = key(),
    performed = new Date().toISOString();
  await assert.rejects(
    ops.transition(driver, key(), o.id, body),
    /Physically verify/,
  );
  await assert.rejects(
    ops.transition(driver, key(), o.id, {
      ...body,
      container_verification: { container_number: "WRONG" },
    }),
    /Physically verify/,
  );
  assert.equal(
    (await pool.query("SELECT status FROM containers WHERE id=$1", [c.id]))
      .rows[0].status,
    "yard",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM container_verifications WHERE order_id=$1",
        [o.id],
      )
    ).rows[0].count,
    "0",
  );
  const completeBody = {
    ...body,
    performed_at: performed,
    container_verification: { container_number: c.number },
  };
  await ops.transition(driver, command, o.id, completeBody);
  await ops.transition(driver, command, o.id, completeBody);
  const proof = (
    await pool.query(
      "SELECT * FROM container_verifications WHERE order_id=$1",
      [o.id],
    )
  ).rows[0];
  assert.equal(proof.container_id, c.id);
  assert.equal(proof.container_number, c.number);
  assert.equal(proof.actor_id, driver.id);
  assert.equal(proof.verified_at.toISOString(), performed);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM container_movements WHERE order_id=$1",
        [o.id],
      )
    ).rows[0].count,
    "1",
  );
  await assert.rejects(
    pool.query(
      "UPDATE container_verifications SET container_number='OTHER' WHERE order_id=$1",
      [o.id],
    ),
    /Append-only/,
  );
});
test("exchange requires both collected and replacement numbers without committing a partial movement", async () => {
  const c = await container(),
    replacement = await container(),
    r = await reserve(c.id);
  await complete(r.delivery_order_id, "2026-11-07");
  const live = (
    await pool.query("SELECT version FROM rentals WHERE id=$1", [r.id])
  ).rows[0];
  const exchange: any = await rentals.exchange(owner, key(), r.id, {
    replacement_container_id: replacement.id,
    service_date: "2026-11-10",
    version: live.version,
  });
  let o: any = await ops.assign(owner, key(), exchange.id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  o = await ops.transition(driver, key(), o.id, {
    status: "in_progress",
    version: o.version,
  });
  const body = {
    status: "completed",
    version: o.version,
    service_date: "2026-11-10",
    container_verification: { container_number: c.number },
  };
  await assert.rejects(
    ops.transition(driver, key(), o.id, body),
    /replacement/,
  );
  assert.equal(
    (
      await pool.query("SELECT status FROM containers WHERE id=$1", [
        replacement.id,
      ])
    ).rows[0].status,
    "yard",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM disposal_loads WHERE order_id=$1",
        [o.id],
      )
    ).rows[0].count,
    "0",
  );
  await ops.transition(driver, key(), o.id, {
    ...body,
    container_verification: {
      container_number: c.number,
      replacement_container_number: replacement.number,
    },
  });
  const proof = (
    await pool.query(
      "SELECT * FROM container_verifications WHERE order_id=$1",
      [o.id],
    )
  ).rows[0];
  assert.equal(proof.replacement_container_id, replacement.id);
  assert.equal(proof.replacement_container_number, replacement.number);
});
test("zero-charge reconciled rental produces a settled invoice without a zero-value posting", async () => {
  const c = await container(),
    r = await reserve(c.id, {
      base_price_cents: 0,
      extension_daily_cents: 0,
      overweight_cents_per_tonne: 0,
    });
  await complete(r.delivery_order_id, "2026-11-07");
  await complete(r.pickup_order_id, "2026-11-14");
  await rentals.disposal(driver, key(), r.id, {
    order_id: r.pickup_order_id,
    facility: "Zero-charge test facility",
    ticket_number: key(),
    gross_kg: 100,
    tare_kg: 100,
    disposal_cost_cents: 0,
  });
  const i: any = await rentals.invoice(owner, key(), r.id);
  assert.equal(i.amount_cents, 0);
  assert.equal(i.status, "paid");
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM journal WHERE invoice_id=$1", [
        i.id,
      ])
    ).rows[0].count,
    "0",
  );
});
