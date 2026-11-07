import type { ActionStorage } from "./action-queue";
const locks = new WeakMap<ActionStorage, Map<string, Promise<unknown>>>();
async function update(
  store: ActionStorage,
  uid: string,
  fn: (current: any) => any,
) {
  let entries = locks.get(store);
  if (!entries) {
    entries = new Map();
    locks.set(store, entries);
  }
  const key = "driver-tools:" + uid,
    previous = entries.get(uid) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const current = JSON.parse((await store.getItem(key)) || "null") || {
        messages: [],
        contacts: [],
        inspections: [],
        loads: [],
        tasks: [],
        closed_loads: [],
      };
      const result = fn(current);
      await store.setItem(key, JSON.stringify(result));
      return result;
    });
  entries.set(uid, next);
  try {
    return await next;
  } finally {
    if (entries.get(uid) === next) entries.delete(uid);
  }
}
export async function cacheToolSnapshot(
  store: ActionStorage,
  uid: string,
  snapshot: any,
) {
  return update(store, uid, (current) => {
    const closed = current.closed_loads || [];
    const messages = new Map(
      (current.messages || []).map((m: any) => [m.id, m]),
    );
    for (const m of snapshot.messages || []) {
      const old: any = messages.get(m.id);
      messages.set(m.id, {
        ...old,
        ...m,
        read_at: m.read_at || old?.read_at || null,
      });
    }
    return {
      ...snapshot,
      closed_loads: closed,
      messages: Array.from(messages.values())
        .sort(
          (a: any, b: any) =>
            Date.parse(b.created_at) - Date.parse(a.created_at),
        )
        .slice(0, 500),
      tasks: (snapshot.tasks || []).map((t: any) => {
        const old = (current.tasks || []).find((r: any) => r.id === t.id);
        return old && old.version > t.version ? old : t;
      }),
      loads: (snapshot.loads || [])
        .filter(
          (l: any) =>
            !closed.some((r: any) => r.id === l.id && r.version >= l.version),
        )
        .map((l: any) => {
          const old = (current.loads || []).find((r: any) => r.id === l.id);
          return old && old.version > l.version ? old : l;
        }),
    };
  });
}
export async function cacheToolAcknowledgement(
  store: ActionStorage,
  uid: string,
  path: string,
  result: any,
) {
  return update(store, uid, (current) => {
    const next = { ...current };
    if (path.startsWith("/driver-tasks/")) {
      const old = (current.tasks || []).find((t: any) => t.id === result.id);
      next.tasks = [
        ...(current.tasks || []).filter((t: any) => t.id !== result.id),
        { ...old, ...result },
      ];
    }
    if (path.startsWith("/disposal-loads/")) {
      const old = (current.loads || []).find((l: any) => l.id === result.id);
      if (result.assigned_driver_id === current.actor_id) {
        next.loads = [
          ...(current.loads || []).filter((l: any) => l.id !== result.id),
          { ...old, ...result },
        ];
      } else {
        next.loads = (current.loads || []).filter(
          (l: any) => l.id !== result.id,
        );
        next.closed_loads = [
          ...(current.closed_loads || []).filter(
            (l: any) => l.id !== result.id,
          ),
          { id: result.id, version: result.version },
        ].slice(-1000);
      }
    }
    if (path.startsWith("/rentals/") && path.endsWith("/disposal")) {
      const load = (current.loads || []).find(
        (l: any) => l.order_id === result.order_id,
      );
      next.loads = (current.loads || []).filter(
        (l: any) => l.order_id !== result.order_id,
      );
      if (load)
        next.closed_loads = [
          ...(current.closed_loads || []).filter(
            (l: any) => l.id !== (result.disposal_load_id || load.id),
          ),
          {
            id: result.disposal_load_id || load.id,
            version: result.disposal_load_version || load.version + 1,
          },
        ].slice(-1000);
    }
    if (path.startsWith("/messages/") && path.endsWith("/read"))
      next.messages = (current.messages || []).map((m: any) =>
        m.id === result.id ? { ...m, ...result } : m,
      );
    return next;
  });
}
