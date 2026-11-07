export type Command = {
  key: string;
  orderId: string;
  performed_at?: string;
  body: {
    status: "in_progress" | "arrived" | "completed" | "failed";
    version: number;
    note: string;
    service_date?: string;
    performed_at?: string;
    container_verification?: {
      container_number: string;
      replacement_container_number?: string;
    };
  };
};
export type QueueStore = {
  list: () => Promise<Command[]>;
  remove: (key: string) => Promise<void>;
};
export class SyncFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
// A failed or conflicting command remains in durable storage for explicit resolution.
// Stop after first failure: a later completion may depend on this command's version.
export async function synchronize(
  store: QueueStore,
  send: (command: Command) => Promise<void>,
) {
  let sent = 0;
  for (const command of await store.list()) {
    await send(command);
    await store.remove(command.key);
    sent++;
  }
  return sent;
}
