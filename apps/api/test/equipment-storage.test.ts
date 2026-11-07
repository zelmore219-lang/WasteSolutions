import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { Workflows } from "../src/workflows";
import { EquipmentStorage } from "../src/equipment-storage";
import { Rentals } from "../src/rentals";
import { Finance } from "../src/finance";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const key = () => randomUUID();
let adminPool: Pool,
  pool: Pool,
  schema: string,
  ops: Operations,
  wf: Workflows,
  stock: EquipmentStorage,
  rentals: Rentals,
  owner: Actor,
  driver: Actor,
  customerId: string,
  locationId: string,
  truckId: string;
beforeEach(async () => {
  schema = "monthly_" + key().replaceAll("-", "");
  adminPool = new Pool({ connectionString: url });
  await adminPool.query('CREATE SCHEMA "' + schema + '"');
  pool = new Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
  });
  const dir = new URL("../../../database/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort())
    await pool.query(await readFile(new URL(name, dir), "utf8"));
  ops = new Operations(pool);
  wf = new Workflows(ops);
  stock = new EquipmentStorage(ops);
  rentals = new Rentals(ops);
  owner = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Monthly owner','owner') RETURNING *",
      [key(), "month_" + key().slice(0, 8)],
    )
  ).rows[0];
  driver = (
    await pool.query(
      "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,'Monthly driver','driver') RETURNING *",
      [key(), "month_" + key().slice(0, 8)],
    )
  ).rows[0];
  const c: any = await ops.createCustomer(owner, key(), {
    name: "Monthly fixture",
    kind: "commercial",
    email: "monthly@example.test",
    billing_address: "Monthly billing",
  });
  customerId = c.id;
  locationId = (
    (await ops.createLocation(owner, key(), c.id, {
      address: "Monthly service",
    })) as any
  ).id;
  truckId = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "MONTH-" + key(),
    ])
  ).rows[0].id;
});
afterEach(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA "' + schema + '" CASCADE');
  await adminPool.end();
});
async function yard(name = "Yard " + key()) {
  return (await stock.createYard(owner, key(), {
    name,
    address: "Verified physical facility",
  })) as any;
}
async function equipment(kind = "cart", yardId?: string) {
  return (await rentals.createContainer(owner, key(), {
    number: "EQUIP-" + key(),
    kind,
    capacity_yards: kind === "cart" ? 1 : 20,
    yard_id: yardId,
  })) as any;
}
const proof = (
  c: any,
  reason = "Verified actual physical equipment movement",
) => ({ version: c.version, observed_number: c.number, reason });
async function reserve(c: any) {
  return (await rentals.reserve(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    container_id: c.id,
    start_date: "2026-11-07",
    pickup_date: "2026-11-14",
    base_price_cents: 40000,
    extension_daily_cents: 1000,
    included_weight_kg: 2000,
    overweight_cents_per_tonne: 5000,
  })) as any;
}
test("yard/truck relocation is versioned and proof-bound, retry-safe and preserves immutable history", async () => {
  const a = await yard(),
    b = await yard(),
    c = await equipment("cart", a.id),
    command = key(),
    body = { ...proof(c), yard_id: null, truck_id: truckId };
  const loaded: any = await stock.move(owner, command, c.id, body);
  assert.equal(loaded.status, "on_truck");
  assert.equal(loaded.carried_by_truck_id, truckId);
  assert.equal(loaded.yard_id, null);
  assert.equal(
    ((await stock.move(owner, command, c.id, body)) as any).version,
    loaded.version,
  );
  await assert.rejects(
    stock.move(owner, key(), c.id, {
      ...proof(c),
      yard_id: b.id,
      truck_id: null,
    }),
    /changed/,
  );
  await assert.rejects(
    stock.move(owner, key(), c.id, {
      ...proof(loaded),
      observed_number: "WRONG",
      yard_id: b.id,
      truck_id: null,
    }),
    /Observed/,
  );
  const unloaded: any = await stock.move(owner, key(), c.id, {
    ...proof(loaded),
    yard_id: b.id,
    truck_id: null,
  });
  assert.equal(unloaded.status, "yard");
  assert.equal(unloaded.yard_id, b.id);
  assert.equal(unloaded.carried_by_truck_id, null);
  const history = await stock.history(owner, c.id);
  assert.equal(history.events.length, 2);
  assert.equal(history.events[0].before_state.carried_by_truck_id, truckId);
  assert.equal(history.events[0].after_state.yard_id, b.id);
  await assert.rejects(
    pool.query("DELETE FROM equipment_storage_events WHERE container_id=$1", [
      c.id,
    ]),
    /Append-only/,
  );
});
test("cart/commercial placement and recovery link the customer address without creating billing records", async () => {
  const y = await yard(),
    c = await equipment("commercial", y.id);
  const placed: any = await stock.place(owner, key(), c.id, {
    ...proof(c),
    customer_id: customerId,
    location_id: locationId,
  });
  assert.equal(placed.status, "deployed");
  assert.equal(placed.location_id, locationId);
  assert.equal(placed.yard_id, null);
  await assert.rejects(
    stock.move(owner, key(), c.id, {
      ...proof(placed),
      yard_id: y.id,
      truck_id: null,
    }),
    /recover|relocated/,
  );
  await assert.rejects(
    stock.place(owner, key(), c.id, {
      ...proof(placed),
      customer_id: customerId,
      location_id: locationId,
    }),
    /available stock/,
  );
  const recovered: any = await stock.recover(owner, key(), c.id, {
    ...proof(placed),
    yard_id: null,
    truck_id: truckId,
  });
  assert.equal(recovered.status, "on_truck");
  assert.equal(recovered.location_id, null);
  const history = await stock.history(owner, c.id);
  assert.equal(history.deployments.length, 1);
  assert.ok(history.deployments[0].recovered_at);
  assert.equal(history.events.length, 2);
  assert.equal(
    (await pool.query("SELECT count(*) FROM invoices")).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM orders")).rows[0].count,
    "0",
  );
  await assert.rejects(
    pool.query("UPDATE equipment_deployments SET location_id=$2 WHERE id=$1", [
      placed.deployment_id,
      key(),
    ]),
    /Immutable/,
  );
});
test("placements reject mismatched customer/service evidence and roll-offs cannot bypass rental/disposal workflows", async () => {
  const y = await yard(),
    cart = await equipment("cart", y.id),
    other: any = await ops.createCustomer(owner, key(), {
      name: "Other account",
      kind: "commercial",
      email: "other@example.test",
      billing_address: "Other billing",
    });
  await assert.rejects(
    stock.place(owner, key(), cart.id, {
      ...proof(cart),
      customer_id: other.id,
      location_id: locationId,
    }),
    /matching/,
  );
  const order: any = await ops.createOrder(owner, key(), {
    customer_id: customerId,
    location_id: locationId,
    kind: "delivery",
    scheduled_date: "2026-11-07",
    price_cents: 100,
  });
  await assert.rejects(
    stock.place(owner, key(), cart.id, {
      ...proof(cart),
      customer_id: customerId,
      location_id: locationId,
      order_id: order.id,
    }),
    /completed/,
  );
  const roll = await equipment("roll_off", y.id),
    r = await reserve(roll);
  await assert.rejects(
    stock.place(owner, key(), roll.id, {
      ...proof(roll),
      customer_id: customerId,
      location_id: locationId,
    }),
    /rental workflow/,
  );
  await assert.rejects(
    stock.status(owner, key(), roll.id, {
      ...proof(roll),
      status: "maintenance",
    }),
    /reservations/,
  );
  await ops.assign(owner, key(), r.delivery_order_id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  await ops.transition(driver, key(), r.delivery_order_id, {
    status: "in_progress",
    version: 2,
  });
  await ops.transition(driver, key(), r.delivery_order_id, {
    status: "completed",
    version: 3,
    service_date: "2026-11-07",
    container_verification: { container_number: roll.number },
  });
  const deployed = (
    await pool.query("SELECT * FROM containers WHERE id=$1", [roll.id])
  ).rows[0];
  await assert.rejects(
    stock.recover(owner, key(), roll.id, {
      ...proof(deployed),
      yard_id: y.id,
      truck_id: null,
    }),
    /rental pickup/,
  );
  assert.equal(deployed.yard_id, null);
  assert.equal(deployed.carried_by_truck_id, null);
  assert.equal(
    (await stock.history(owner, roll.id)).events[0].action,
    "rental_delivered",
  );
});
test("rental delivery uses only its assigned carrying truck, and loading for another active assignment is refused", async () => {
  const y = await yard(),
    roll = await equipment("roll_off", y.id),
    r = await reserve(roll),
    otherTruck = (
      await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING *", [
        "OTHER-" + key(),
      ])
    ).rows[0];
  const loaded: any = await stock.move(owner, key(), roll.id, {
    ...proof(roll),
    yard_id: null,
    truck_id: truckId,
  });
  await ops.assign(owner, key(), r.delivery_order_id, {
    driver_id: driver.id,
    truck_id: otherTruck.id,
    version: 1,
  });
  await assert.rejects(
    ops.transition(driver, key(), r.delivery_order_id, {
      status: "in_progress",
      version: 2,
    }),
    /not ready/,
  );
  const transferred: any = await stock.move(owner, key(), roll.id, {
    ...proof(loaded),
    yard_id: null,
    truck_id: otherTruck.id,
  });
  await assert.rejects(
    stock.move(owner, key(), roll.id, {
      ...proof(transferred),
      yard_id: null,
      truck_id: truckId,
    }),
    /another truck/,
  );
  await ops.transition(driver, key(), r.delivery_order_id, {
    status: "in_progress",
    version: 2,
  });
  await ops.transition(driver, key(), r.delivery_order_id, {
    status: "completed",
    version: 3,
    service_date: "2026-11-07",
    container_verification: { container_number: roll.number },
  });
  assert.equal(
    (await pool.query("SELECT status FROM containers WHERE id=$1", [roll.id]))
      .rows[0].status,
    "deployed",
  );
});
test("maintenance remains quarantined during yard relocation; occupied yards, unsafe trucks and unauthorized writes are blocked", async () => {
  const a = await yard(),
    b = await yard(),
    c = await equipment("cart", a.id);
  await assert.rejects(
    stock.updateYard(owner, key(), a.id, {
      name: a.name,
      address: a.address,
      active: false,
      version: a.version,
      reason: "Attempt deactivation",
    }),
    /Move all/,
  );
  const maintenance: any = await stock.status(owner, key(), c.id, {
    ...proof(c),
    status: "maintenance",
  });
  await assert.rejects(
    stock.move(owner, key(), c.id, {
      ...proof(maintenance),
      yard_id: null,
      truck_id: truckId,
    }),
    /Quarantined/,
  );
  const moved: any = await stock.move(owner, key(), c.id, {
    ...proof(maintenance),
    yard_id: b.id,
    truck_id: null,
  });
  assert.equal(moved.status, "maintenance");
  await stock.updateYard(owner, key(), a.id, {
    name: a.name,
    address: a.address,
    active: false,
    version: a.version,
    reason: "All physical stock moved",
  });
  await assert.rejects(
    stock.move(owner, key(), c.id, {
      ...proof(moved),
      yard_id: a.id,
      truck_id: null,
    }),
    /Active destination/,
  );
  for (const role of ["driver", "customer", "office", "accountant"])
    await assert.rejects(
      stock.move({ ...owner, role }, key(), c.id, {
        ...proof(moved),
        yard_id: null,
        truck_id: truckId,
      }),
      /Forbidden/,
    );
  const ready: any = await stock.status(owner, key(), c.id, {
    ...proof(moved),
    status: "yard",
  });
  await pool.query("UPDATE trucks SET status='maintenance' WHERE id=$1", [
    truckId,
  ]);
  await assert.rejects(
    stock.move(owner, key(), c.id, {
      ...proof(ready),
      yard_id: null,
      truck_id: truckId,
    }),
    /Available destination truck/,
  );
  await assert.rejects(
    stock.status({ ...owner, role: "dispatcher" }, key(), c.id, {
      ...proof(ready),
      status: "retired",
    }),
    /Owner or manager/,
  );
});

test("legacy equipment can be observed at its existing location before recovery without fabricating installation history", async () => {
  const cart = await equipment(),
    destination = await yard();
  // An imported pre-existing deployed cart has a known location but no installation record.
  await pool.query(
    "UPDATE containers SET status='deployed',location_id=$2,version=version+1 WHERE id=$1",
    [cart.id, locationId],
  );
  const proof = {
    version: 2,
    observed_number: cart.number,
    reason:
      "Physical inventory count confirms the imported cart remains at its recorded address",
    confirm_location_id: locationId,
  };
  await assert.rejects(
    stock.recover(owner, key(), cart.id, {
      version: 2,
      observed_number: cart.number,
      reason: "Recover imported cart",
      yard_id: destination.id,
      truck_id: null,
    }),
    /recorded/,
  );
  await assert.rejects(
    stock.observeLegacyPlacement(
      { ...owner, role: "dispatcher" },
      key(),
      cart.id,
      proof,
    ),
    /Forbidden/,
  );
  await assert.rejects(
    stock.observeLegacyPlacement(owner, key(), cart.id, {
      ...proof,
      observed_number: "WRONG",
    }),
    /Observed/,
  );
  await assert.rejects(
    stock.observeLegacyPlacement(owner, key(), cart.id, {
      ...proof,
      confirm_location_id: key(),
    }),
    /recorded location/,
  );
  const command = key();
  const observed: any = await stock.observeLegacyPlacement(
    owner,
    command,
    cart.id,
    proof,
  );
  assert.equal(observed.status, "deployed");
  assert.equal(observed.location_id, locationId);
  assert.equal(observed.version, 3);
  assert.equal(
    (
      (await stock.observeLegacyPlacement(
        owner,
        command,
        cart.id,
        proof,
      )) as any
    ).deployment_id,
    observed.deployment_id,
  );
  const history = await stock.history(owner, cart.id);
  assert.equal(history.deployments.length, 1);
  assert.equal(history.deployments[0].record_kind, "legacy_observation");
  assert.equal(history.deployments[0].customer_id, customerId);
  assert.equal(history.deployments[0].order_id, null);
  assert.equal(history.events[0].action, "legacy_placement_observed");
  await assert.rejects(
    pool.query(
      "UPDATE equipment_deployments SET record_kind='placement' WHERE id=$1",
      [observed.deployment_id],
    ),
    /Immutable/,
  );
  await assert.rejects(
    stock.observeLegacyPlacement(owner, key(), cart.id, {
      ...proof,
      version: 3,
    }),
    /already has/,
  );
  const recovered: any = await stock.recover(owner, key(), cart.id, {
    version: 3,
    observed_number: cart.number,
    reason: "Physically recovered after observation",
    yard_id: destination.id,
    truck_id: null,
  });
  assert.equal(recovered.status, "yard");
  assert.equal(recovered.yard_id, destination.id);
  assert.ok((await stock.history(owner, cart.id)).deployments[0].recovered_at);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n,
    0,
  );
});

test("equipment event pagination is stable across timestamp ties and refuses another asset cursor", async () => {
  const cart = await equipment(),
    other = await equipment();
  await pool.query(
    "INSERT INTO equipment_storage_events(container_id,actor_id,action,observed_number,reason,before_state,after_state) SELECT $1,$2,'counted',$3,'Test count snapshot','{}'::jsonb,'{}'::jsonb FROM generate_series(1,105)",
    [cart.id, owner.id, cart.number],
  );
  await pool.query(
    "INSERT INTO equipment_storage_events(container_id,actor_id,action,observed_number,reason,before_state,after_state) VALUES($1,$2,'counted',$3,'Other equipment','{}','{}')",
    [other.id, owner.id, other.number],
  );
  const first = await stock.history(owner, cart.id);
  assert.equal(first.events.length, 50);
  assert.ok(first.next_cursor);
  const second = await stock.events(owner, cart.id, {
    before: first.next_cursor,
  });
  assert.equal(second.events.length, 50);
  assert.ok(second.next_cursor);
  const third = await stock.events(owner, cart.id, {
    before: second.next_cursor,
  });
  assert.equal(third.events.length, 5);
  assert.equal(third.next_cursor, null);
  assert.equal(
    new Set(
      [...first.events, ...second.events, ...third.events].map((x) => x.id),
    ).size,
    105,
  );
  await assert.rejects(
    stock.events(owner, other.id, { before: first.next_cursor }),
    /belong to this equipment/,
  );
  await assert.rejects(
    stock.events({ ...owner, role: "customer" }, cart.id, {}),
    /Forbidden/,
  );
});
