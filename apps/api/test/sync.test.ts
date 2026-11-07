import { test } from "node:test";
import assert from "node:assert/strict";
import { Command, SyncFailure, synchronize } from "../../driver/sync";
const make = (key: string, version: number): Command => ({
  key,
  orderId: "order-1",
  body: {
    status: version === 2 ? "in_progress" : "completed",
    version,
    note: "",
  },
});
test("offline replay preserves command order and stable idempotency keys", async () => {
  let queue = [make("start-key", 2), make("complete-key", 3)];
  const sent: string[] = [];
  const n = await synchronize(
    {
      list: async () => queue,
      remove: async (key) => {
        queue = queue.filter((c) => c.key !== key);
      },
    },
    async (c) => {
      sent.push(c.key);
    },
  );
  assert.equal(n, 2);
  assert.deepEqual(sent, ["start-key", "complete-key"]);
  assert.equal(queue.length, 0);
});
test("lost response retains the command for an identical retry and stops dependent writes", async () => {
  let queue = [make("stable-key", 2), make("dependent-key", 3)];
  const sent: string[] = [];
  const store = {
    list: async () => queue,
    remove: async (key: string) => {
      queue = queue.filter((c) => c.key !== key);
    },
  };
  await assert.rejects(
    synchronize(store, async (c) => {
      sent.push(c.key);
      throw new Error("Network lost");
    }),
    /Network lost/,
  );
  assert.equal(queue.length, 2);
  await synchronize(store, async (c) => {
    sent.push(c.key);
  });
  assert.deepEqual(sent, ["stable-key", "stable-key", "dependent-key"]);
});
test("version conflict remains queued for dispatch resolution; it is never silently overwritten", async () => {
  const queue = [make("conflict-key", 2)];
  let removed = false;
  await assert.rejects(
    synchronize(
      {
        list: async () => queue,
        remove: async () => {
          removed = true;
        },
      },
      async () => {
        throw new SyncFailure(409, "Order reassigned");
      },
    ),
    /Order reassigned/,
  );
  assert.equal(removed, false);
  assert.equal(queue.length, 1);
});

import {
  ActionStorage,
  queueAction,
  pendingActions,
  syncActions,
} from "../../driver/action-queue";
test("offline driver actions retain failed requests and preserve concurrent additions during acknowledgement", async () => {
  const values = new Map<string, string>();
  const store: ActionStorage = {
    getItem: async (k) => values.get(k) || null,
    setItem: async (k, v) => {
      values.set(k, v);
    },
  };
  const action = {
    kind: "message" as const,
    body: { recipient_id: "office", message: "Unable to dump; please advise" },
  };
  await Promise.all([
    queueAction(store, "driver", action, "first"),
    queueAction(store, "driver", action, "second"),
  ]);
  assert.equal((await pendingActions(store, "driver")).length, 2);
  await assert.rejects(
    syncActions(store, "driver", async () => {
      throw new SyncFailure(409, "Dispatch review needed");
    }),
    /review/,
  );
  assert.equal((await pendingActions(store, "driver")).length, 2);
  const sent: string[] = [];
  await syncActions(store, "driver", async (path, body, key) => {
    assert.equal(path, "/messages");
    sent.push(key);
    if (key === "first") await queueAction(store, "driver", action, "third");
  });
  assert.deepEqual(sent, ["first", "second"]);
  assert.deepEqual(
    (await pendingActions(store, "driver")).map((a) => a.key),
    ["third"],
  );
  assert.equal((await pendingActions(store, "other-driver")).length, 0);
  await syncActions(store, "driver", async (path, body, key) => {
    sent.push(key);
  });
  assert.deepEqual(sent, ["first", "second", "third"]);
  assert.equal((await pendingActions(store, "driver")).length, 0);
});
test("task and inspection actions can synchronize before dependent service completions", async () => {
  const values = new Map<string, string>();
  const store: ActionStorage = {
    getItem: async (k) => values.get(k) || null,
    setItem: async (k, v) => {
      values.set(k, v);
    },
  };
  await queueAction(
    store,
    "driver",
    {
      kind: "message",
      body: { recipient_id: "office", message: "Route update" },
    },
    "message",
  );
  await queueAction(
    store,
    "driver",
    {
      kind: "task",
      orderId: "order",
      taskId: "task",
      body: { version: 1, note: "", performed_at: new Date().toISOString() },
    },
    "task",
  );
  const paths: string[] = [];
  await syncActions(
    store,
    "driver",
    async (path) => {
      paths.push(path);
    },
    (a) => a.kind === "task" || a.kind === "inspection",
  );
  assert.deepEqual(paths, ["/orders/order/tasks/task/complete"]);
  assert.deepEqual(
    (await pendingActions(store, "driver")).map((a) => a.key),
    ["message"],
  );
});

import { disposalWork } from "../../driver/disposal-work";
test("offline disposal work is deterministic and does not reappear after a queued ticket or return to dispatch", () => {
  const jobs = [
    {
      id: "order",
      rental_id: "rental",
      rental_action: "pickup",
      status: "completed",
      customer_name: "Customer",
      container_number: "CW-42",
    },
  ];
  const failure: any = {
    kind: "unable_dump",
    key: "failure",
    loadId: "order",
    performed_at: new Date().toISOString(),
    body: {
      version: 1,
      reason: "Facility closed",
      returning_later: true,
      performed_at: new Date().toISOString(),
    },
  };
  assert.equal(disposalWork(jobs, [], [failure])[0].version, 2);
  assert.equal(
    disposalWork(jobs, [], [failure])[0].last_failure_reason,
    "Facility closed",
  );
  assert.equal(
    disposalWork(
      jobs,
      [],
      [{ ...failure, body: { ...failure.body, returning_later: false } }],
    ).length,
    0,
  );
  const ticket: any = {
    kind: "disposal",
    key: "ticket",
    rentalId: "rental",
    performed_at: new Date().toISOString(),
    body: {
      order_id: "order",
      facility: "Verified facility",
      ticket_number: "123",
      gross_kg: 9000,
      tare_kg: 7000,
      disposal_cost_cents: 12000,
    },
  };
  assert.equal(disposalWork(jobs, [], [failure, ticket]).length, 0);
  assert.equal(
    disposalWork([{ ...jobs[0], disposal_ticket_id: "received" }], [], [])
      .length,
    0,
  );
});

import {
  cacheToolSnapshot,
  cacheToolAcknowledgement,
} from "../../driver/driver-tool-cache";
test("driver tool cache preserves acknowledgements against stale refresh and clears disposed or reassigned loads", async () => {
  const values = new Map<string, string>(),
    store: ActionStorage = {
      getItem: async (k) => values.get(k) || null,
      setItem: async (k, v) => {
        values.set(k, v);
      },
    };
  const snapshot = {
    actor_id: "driver",
    messages: [
      { id: "message", created_at: new Date().toISOString(), read_at: null },
    ],
    tasks: [{ id: "task", version: 1, status: "assigned" }],
    loads: [
      {
        id: "load",
        order_id: "order",
        version: 1,
        assigned_driver_id: "driver",
      },
    ],
  };
  await cacheToolSnapshot(store, "uid", snapshot);
  await cacheToolAcknowledgement(store, "uid", "/driver-tasks/task/status", {
    id: "task",
    version: 2,
    status: "in_progress",
  });
  let merged = await cacheToolSnapshot(store, "uid", snapshot);
  assert.equal(merged.tasks[0].version, 2);
  await cacheToolAcknowledgement(store, "uid", "/messages/message/read", {
    id: "message",
    read_at: "2026-11-07T01:00:00.000Z",
  });
  merged = await cacheToolSnapshot(store, "uid", snapshot);
  assert.ok(merged.messages[0].read_at);
  await cacheToolAcknowledgement(store, "uid", "/disposal-loads/load/unable", {
    id: "load",
    order_id: "order",
    version: 2,
    assigned_driver_id: null,
    status: "disposal_failed",
  });
  merged = await cacheToolSnapshot(store, "uid", snapshot);
  assert.equal(merged.loads.length, 0);
  const reassigned = {
    ...snapshot,
    loads: [{ ...snapshot.loads[0], version: 3 }],
  };
  merged = await cacheToolSnapshot(store, "uid", reassigned);
  assert.equal(merged.loads.length, 1);
  await cacheToolAcknowledgement(store, "uid", "/rentals/rental/disposal", {
    id: "ticket",
    order_id: "order",
  });
  merged = await cacheToolSnapshot(store, "uid", reassigned);
  assert.equal(merged.loads.length, 0);
  const jobs = [
    {
      id: "order",
      driver_id: "driver",
      disposal_load_id: "load",
      disposal_driver_id: "relief",
      rental_id: "rental",
      rental_action: "pickup",
      status: "completed",
    },
  ];
  assert.equal(disposalWork(jobs, [], []).length, 0);
});

import { submitActionReview } from "../../driver/action-queue";
test("offline requests leave the sending queue only after durable review acknowledgement", async () => {
  const values = new Map<string, string>(),
    store: ActionStorage = {
      getItem: async (k) => values.get(k) || null,
      setItem: async (k, v) => {
        values.set(k, v);
      },
    };
  await queueAction(
    store,
    "driver",
    {
      kind: "driver_task",
      taskId: "task",
      body: {
        version: 2,
        status: "completed",
        note: "Done offline",
        performed_at: new Date().toISOString(),
      },
    },
    "stable-review-key",
  );
  const attempts: any[] = [];
  await assert.rejects(
    submitActionReview(
      store,
      "driver",
      "stable-review-key",
      async (path, body, key) => {
        attempts.push({ path, body, key });
        throw Error("Review response lost");
      },
    ),
    /lost/,
  );
  assert.equal((await pendingActions(store, "driver")).length, 1);
  await submitActionReview(
    store,
    "driver",
    "stable-review-key",
    async (path, body, key) => {
      attempts.push({ path, body, key });
    },
  );
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[0].key, "stable-review-key_review");
  assert.equal((await pendingActions(store, "driver")).length, 0);
  await assert.rejects(
    queueAction(
      store,
      "driver",
      {
        kind: "disposal",
        rentalId: "rental",
        body: {
          order_id: "order",
          facility: "Facility",
          ticket_number: "123",
          gross_kg: 0,
          tare_kg: 0,
          disposal_cost_cents: 0,
        },
      },
      "invalid-disposal",
    ),
    /valid kilogram/,
  );
  assert.equal((await pendingActions(store, "driver")).length, 0);
});

test("offline rental completion retains exact physical confirmation after failed replay and a durable reload", async () => {
  const command: Command = {
    key: "physical-proof-key",
    orderId: "rental-order",
    performed_at: "2026-11-07T12:00:00Z",
    body: {
      status: "completed",
      version: 4,
      note: "",
      performed_at: "2026-11-07T12:00:00Z",
      service_date: "2026-11-07",
      container_verification: {
        container_number: "ROLL-42",
        replacement_container_number: "ROLL-43",
      },
    },
  };
  let durable = JSON.stringify([command]);
  const store = {
    list: async () => JSON.parse(durable) as Command[],
    remove: async (key: string) => {
      durable = JSON.stringify(
        (JSON.parse(durable) as Command[]).filter((c) => c.key !== key),
      );
    },
  };
  await assert.rejects(
    synchronize(store, async () => {
      throw new SyncFailure(503, "Connection interrupted");
    }),
  );
  assert.deepEqual(JSON.parse(durable), [command]);
  let sent: Command | undefined;
  await synchronize(store, async (c) => {
    sent = c;
  });
  assert.deepEqual(sent, command);
  assert.deepEqual(JSON.parse(durable), []);
});

import { advanceRentalPickup } from "../../driver/rental-projection";
test("offline exchange handoff survives a cached reload and does not overwrite unrelated or already changed pickup equipment", () => {
  const exchange = {
    id: "exchange",
    status: "completed",
    rental_id: "rental-1",
    rental_action: "exchange",
    container_number: "OLD",
    replacement_container_number: "NEW",
    version: 4,
  };
  const pickup = {
    id: "pickup",
    status: "assigned",
    rental_id: "rental-1",
    rental_action: "pickup",
    container_number: "OLD",
    version: 2,
  };
  const unrelated = { ...pickup, id: "unrelated", rental_id: "rental-2" },
    changed = {
      ...pickup,
      id: "changed",
      container_number: "DISPATCH-CHANGED",
    },
    closed = { ...pickup, id: "closed", status: "completed" };
  const initial = [exchange, pickup, unrelated, changed, closed],
    projected = advanceRentalPickup(initial, exchange);
  assert.equal(projected[1].container_number, "NEW");
  assert.equal(projected[1].version, 2);
  assert.equal(initial[1].container_number, "OLD");
  assert.equal(projected[2].container_number, "OLD");
  assert.equal(projected[3].container_number, "DISPATCH-CHANGED");
  assert.equal(projected[4].container_number, "OLD");
  const reloaded = JSON.parse(JSON.stringify(projected));
  assert.deepEqual(advanceRentalPickup(reloaded, exchange), reloaded);
});
