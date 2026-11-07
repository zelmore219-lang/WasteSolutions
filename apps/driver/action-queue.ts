export type Action =
  | {
      kind: "driver_task";
      taskId: string;
      body: {
        version: number;
        status: "in_progress" | "completed" | "failed";
        note: string;
        performed_at: string;
      };
    }
  | {
      kind: "unable_dump";
      loadId: string;
      body: {
        version: number;
        reason: string;
        returning_later: boolean;
        performed_at: string;
      };
    }
  | {
      kind: "task";
      orderId: string;
      taskId: string;
      body: { version: number; note: string; performed_at: string };
    }
  | { kind: "message"; body: { recipient_id: string; message: string } }
  | {
      kind: "inspection";
      body: {
        truck_id: string;
        kind: "pre_trip" | "post_trip";
        odometer_km: number;
        safe_to_operate: boolean;
        notes: string;
        recorded_at: string;
      };
    }
  | {
      kind: "disposal";
      rentalId: string;
      body: {
        order_id: string;
        facility: string;
        ticket_number: string;
        gross_kg: number;
        tare_kg: number;
        disposal_cost_cents: number;
      };
    }
  | { kind: "message_read"; messageId: string; body: Record<string, never> };
export type PendingAction = Action & { key: string; performed_at: string };
export type ActionStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};
const storageKey = (uid: string) => "driver-actions:" + uid;
export async function pendingActions(
  store: ActionStorage,
  uid: string,
): Promise<PendingAction[]> {
  return JSON.parse((await store.getItem(storageKey(uid))) || "[]");
}
const writes = new WeakMap<ActionStorage, Map<string, Promise<unknown>>>();
async function mutate<T>(
  store: ActionStorage,
  uid: string,
  fn: () => Promise<T>,
): Promise<T> {
  let entries = writes.get(store);
  if (!entries) {
    entries = new Map();
    writes.set(store, entries);
  }
  const previous = entries.get(uid) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  entries.set(uid, next);
  try {
    return await next;
  } finally {
    if (entries.get(uid) === next) entries.delete(uid);
  }
}
function validateAction(action: Action) {
  const integer = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  const text = (value: string, max: number) =>
    Boolean(value.trim()) && value.length <= max;
  if (
    action.kind === "disposal" &&
    (!text(action.body.facility, 200) ||
      !text(action.body.ticket_number, 100) ||
      !integer(action.body.gross_kg, 1, 1000000) ||
      !integer(action.body.tare_kg, 0, action.body.gross_kg) ||
      !integer(action.body.disposal_cost_cents, 0, 100000000))
  )
    throw Error(
      "Enter a facility, ticket, valid kilogram weights and a supported disposal cost",
    );
  if (
    action.kind === "inspection" &&
    (!integer(action.body.odometer_km, 0, 10000000) ||
      action.body.notes.length > 2000 ||
      (!action.body.safe_to_operate && !action.body.notes.trim()))
  )
    throw Error(
      "Enter a valid odometer reading and describe any safety defects",
    );
  if (action.kind === "message" && !text(action.body.message, 2000))
    throw Error("Enter a message of up to 2000 characters");
  if (
    action.kind === "unable_dump" &&
    (!text(action.body.reason, 2000) ||
      !integer(action.body.version, 1, 2147483647))
  )
    throw Error("Describe why the load could not be dumped");
  if (
    (action.kind === "task" || action.kind === "driver_task") &&
    (!integer(action.body.version, 1, 2147483647) ||
      action.body.note.length > 2000 ||
      (action.kind === "driver_task" &&
        action.body.status === "failed" &&
        !action.body.note.trim()))
  )
    throw Error("Enter valid task details and a reason for failed work");
}
export async function queueAction(
  store: ActionStorage,
  uid: string,
  action: Action,
  key: string,
) {
  validateAction(action);
  return mutate(store, uid, async () => {
    const queue = await pendingActions(store, uid);
    if (queue.length >= 40)
      throw Error(
        "Synchronize pending messages and inspections before adding more",
      );
    const value = { ...action, key, performed_at: new Date().toISOString() };
    await store.setItem(storageKey(uid), JSON.stringify([...queue, value]));
    return value;
  });
}
export function actionPath(action: Action) {
  switch (action.kind) {
    case "driver_task":
      return "/driver-tasks/" + encodeURIComponent(action.taskId) + "/status";
    case "unable_dump":
      return "/disposal-loads/" + encodeURIComponent(action.loadId) + "/unable";
    case "task":
      return (
        "/orders/" +
        encodeURIComponent(action.orderId) +
        "/tasks/" +
        encodeURIComponent(action.taskId) +
        "/complete"
      );
    case "message":
      return "/messages";
    case "inspection":
      return "/fleet/inspections";
    case "disposal":
      return "/rentals/" + encodeURIComponent(action.rentalId) + "/disposal";
    case "message_read":
      return "/messages/" + encodeURIComponent(action.messageId) + "/read";
  }
}
// Acknowledgement precedes removal. Transport errors and business conflicts retain the exact request.
const syncing = new WeakMap<ActionStorage, Set<string>>();
export async function syncActions(
  store: ActionStorage,
  uid: string,
  send: (path: string, body: unknown, key: string) => Promise<unknown>,
  select: (action: PendingAction) => boolean = () => true,
) {
  let owners = syncing.get(store);
  if (!owners) {
    owners = new Set();
    syncing.set(store, owners);
  }
  if (owners.has(uid))
    throw Error("Driver update synchronization is already running");
  owners.add(uid);
  try {
    let sent = 0;
    for (const action of (await pendingActions(store, uid)).filter(select)) {
      await send(actionPath(action), action.body, action.key);
      await mutate(store, uid, async () => {
        const queue = await pendingActions(store, uid);
        await store.setItem(
          storageKey(uid),
          JSON.stringify(queue.filter((a) => a.key !== action.key)),
        );
      });
      sent++;
    }
    return sent;
  } finally {
    owners.delete(uid);
  }
}

export async function submitActionReview(
  store: ActionStorage,
  uid: string,
  key: string,
  send: (path: string, body: unknown, key: string) => Promise<unknown>,
) {
  const pending = (await pendingActions(store, uid)).find((a) => a.key === key);
  if (!pending) throw Error("This update is no longer pending");
  const { key: command_key, performed_at, ...action } = pending;
  await send(
    "/driver-actions/review",
    { command_key, performed_at, action },
    command_key + "_review",
  );
  await mutate(store, uid, async () => {
    const queue = await pendingActions(store, uid);
    await store.setItem(
      storageKey(uid),
      JSON.stringify(queue.filter((a) => a.key !== key)),
    );
  });
}
