import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Operations, Actor } from "../src/domain";
import { DriverTasks } from "../src/driver-tasks";
import { Administration } from "../src/administration";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Dedicated test database required");
const pool = new Pool({ connectionString: url }),
  ops = new Operations(pool),
  tasks = new DriverTasks(ops);
const key = () => randomUUID();
let owner: Actor, driver: Actor, relief: Actor, truckId: string;
before(async () => {
  const actors = [];
  for (const role of ["owner", "driver", "driver"])
    actors.push(
      (
        await pool.query(
          "INSERT INTO employees(firebase_uid,username,display_name,role) VALUES($1,$2,$3,$3) RETURNING *",
          [key(), "task_" + key().slice(0, 8), role],
        )
      ).rows[0],
    );
  [owner, driver, relief] = actors;
  truckId = (
    await pool.query("INSERT INTO trucks(number) VALUES($1) RETURNING id", [
      "TASK-" + key(),
    ])
  ).rows[0].id;
});
after(async () => pool.end());
async function create(extra: any = {}) {
  return (await tasks.create(owner, key(), {
    title: "Visit service shop " + key(),
    description: "Collect the completed inspection paperwork",
    address: "Service shop street",
    scheduled_date: new Date().toISOString().slice(0, 10),
    priority: "high",
    ...extra,
  })) as any;
}
test("independent task assignments and driver completion do not create customer orders or financial postings", async () => {
  const before = (
    await pool.query(
      "SELECT (SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM journal) AS journal,(SELECT count(*) FROM orders) AS orders",
    )
  ).rows[0];
  let task = await create();
  task = await tasks.assign(owner, key(), task.id, {
    driver_id: driver.id,
    truck_id: truckId,
    version: 1,
  });
  assert.ok((await tasks.list(driver)).some((t) => t.id === task.id));
  assert.ok(!(await tasks.list(relief)).some((t) => t.id === task.id));
  await new Administration(ops).inspect(driver, key(), {
    truck_id: truckId,
    kind: "pre_trip",
    odometer_km: 1234,
    safe_to_operate: true,
    notes: "Independent task trip",
  });
  task = await tasks.status(driver, key(), task.id, {
    status: "in_progress",
    version: 2,
    note: "",
    performed_at: new Date().toISOString(),
  });
  const body = {
      status: "completed",
      version: 3,
      note: "Paperwork collected",
      performed_at: new Date().toISOString(),
    },
    doneKey = key();
  const done: any = await tasks.status(driver, doneKey, task.id, body);
  assert.equal(done.status, "completed");
  assert.deepEqual(
    await tasks.status(driver, doneKey, task.id, body),
    JSON.parse(JSON.stringify(done)),
  );
  const after = (
    await pool.query(
      "SELECT (SELECT count(*) FROM invoices) AS invoices,(SELECT count(*) FROM journal) AS journal,(SELECT count(*) FROM orders) AS orders",
    )
  ).rows[0];
  assert.deepEqual(after, before);
  await assert.rejects(
    pool.query(
      "UPDATE driver_task_events SET note='changed' WHERE task_id=$1",
      [task.id],
    ),
    /Append-only/,
  );
});
test("live task reassignment rejects the old driver and preserves failed-task reasons", async () => {
  let task = await create({ driver_id: driver.id });
  task = await tasks.status(driver, key(), task.id, {
    status: "in_progress",
    version: 1,
    note: "",
    performed_at: new Date().toISOString(),
  });
  task = await tasks.assign(owner, key(), task.id, {
    driver_id: relief.id,
    truck_id: null,
    version: 2,
  });
  assert.equal(task.status, "in_progress");
  await assert.rejects(
    tasks.status(driver, key(), task.id, {
      status: "completed",
      version: 3,
      note: "",
      performed_at: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    tasks.status(relief, key(), task.id, {
      status: "failed",
      version: 3,
      note: "",
      performed_at: new Date().toISOString(),
    }),
    /why/,
  );
  const failed: any = await tasks.status(relief, key(), task.id, {
    status: "failed",
    version: 3,
    note: "Shop closed",
    performed_at: new Date().toISOString(),
  });
  assert.equal(failed.completion_note, "Shop closed");
  await assert.rejects(
    tasks.assign(owner, key(), task.id, {
      driver_id: driver.id,
      truck_id: null,
      version: 3,
    }),
    /changed/,
  );
  const cancelled: any = await tasks.cancel(owner, key(), task.id, {
    version: 4,
    reason: "Rescheduled with service shop",
  });
  assert.equal(cancelled.status, "cancelled");
});
test("unsafe task trucks block work and overdue open tasks remain visible", async () => {
  const task = await create({
    driver_id: driver.id,
    truck_id: truckId,
    scheduled_date: "2020-01-01",
  });
  await pool.query("UPDATE trucks SET status='maintenance' WHERE id=$1", [
    truckId,
  ]);
  await assert.rejects(
    tasks.status(driver, key(), task.id, {
      status: "in_progress",
      version: 1,
      note: "",
      performed_at: new Date().toISOString(),
    }),
    /unavailable/,
  );
  assert.ok((await tasks.list(driver)).some((t) => t.id === task.id));
  await assert.rejects(tasks.create(driver, key(), {}));
  await assert.rejects(tasks.list({ ...driver, role: "customer" }));
  await pool.query("UPDATE trucks SET status='available' WHERE id=$1", [
    truckId,
  ]);
});

import { DriverActionReview } from "../src/driver-action-review";
test("stale task evidence is retained for office review without completing or reassigning the original task", async () => {
  const review = new DriverActionReview(ops);
  let task = await create({ driver_id: driver.id });
  task = await tasks.status(driver, key(), task.id, {
    status: "in_progress",
    version: 1,
    note: "",
    performed_at: new Date().toISOString(),
  });
  await tasks.assign(owner, key(), task.id, {
    driver_id: relief.id,
    truck_id: null,
    version: 2,
  });
  const commandKey = key(),
    performed_at = new Date().toISOString();
  const proof = {
    command_key: commandKey,
    performed_at,
    action: {
      kind: "driver_task",
      taskId: task.id,
      body: {
        status: "completed",
        version: 2,
        note: "Original offline work",
        performed_at,
      },
    },
  };
  const saved: any = await review.submit(driver, key(), proof);
  assert.equal(saved.status, "open");
  assert.equal(saved.already_committed, false);
  assert.equal(
    (await pool.query("SELECT status FROM driver_tasks WHERE id=$1", [task.id]))
      .rows[0].status,
    "in_progress",
  );
  assert.equal(
    ((await review.submit(driver, key(), proof)) as any).id,
    saved.id,
  );
  await assert.rejects(
    review.submit(driver, key(), {
      ...proof,
      performed_at: new Date(Date.parse(performed_at) - 1000).toISOString(),
    }),
    /different details/,
  );
  await assert.rejects(
    review.submit(driver, key(), {
      ...proof,
      action: {
        ...proof.action,
        body: { ...proof.action.body, note: "Altered evidence" },
      },
    }),
    /different details/,
  );
  await assert.rejects(
    review.submit({ ...driver, id: owner.id, role: "driver" }, key(), proof),
  );
  await assert.rejects(
    pool.query(
      "UPDATE driver_action_reviews SET original_action='{}' WHERE id=$1",
      [saved.id],
    ),
    /immutable/,
  );
  const decision: any = await review.resolve(owner, key(), saved.id, {
    status: "acknowledged",
    resolution:
      "Review service history with the relief driver before correcting the task",
  });
  assert.equal(decision.status, "acknowledged");
  assert.equal(
    (
      await pool.query("SELECT driver_id FROM driver_tasks WHERE id=$1", [
        task.id,
      ])
    ).rows[0].driver_id,
    relief.id,
  );
  await assert.rejects(
    review.resolve(owner, key(), saved.id, {
      status: "rejected",
      resolution: "Already reviewed",
    }),
    /already reviewed/,
  );
});
test("offline review identifies an already committed request and accepts older evidence without executing it", async () => {
  const review = new DriverActionReview(ops),
    task = await create({ driver_id: driver.id }),
    commandKey = key(),
    performed_at = new Date().toISOString();
  const body = { status: "in_progress", version: 1, note: "", performed_at };
  await tasks.status(driver, commandKey, task.id, body);
  const saved: any = await review.submit(driver, key(), {
    command_key: commandKey,
    performed_at,
    action: { kind: "driver_task", taskId: task.id, body },
  });
  assert.equal(saved.already_committed, true);
  const older = new Date(Date.now() - 8 * 86400000).toISOString();
  const olderProof: any = await review.submit(driver, key(), {
    command_key: key(),
    performed_at: older,
    action: {
      kind: "driver_task",
      taskId: task.id,
      body: { ...body, performed_at: older },
    },
  });
  assert.equal(olderProof.already_committed, false);
  assert.equal(
    (
      await pool.query("SELECT version FROM driver_tasks WHERE id=$1", [
        task.id,
      ])
    ).rows[0].version,
    2,
  );
});
