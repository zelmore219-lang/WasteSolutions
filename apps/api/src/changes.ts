import {
  Injectable,
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Pool, PoolClient } from "pg";
import {
  Subject,
  Observable,
  filter,
  map,
  merge,
  interval,
  takeUntil,
  timer,
} from "rxjs";
import type { Actor } from "./domain";
export type Change = { customer_id: string | null };
export function visibleChange(a: Actor, change: Change) {
  return a.role !== "customer" || change.customer_id === a.customer_id;
}
@Injectable()
export class Changes implements OnModuleInit, OnModuleDestroy {
  private client: PoolClient | null = null;
  private subject = new Subject<Change>();
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private pool: Pool) {}
  async onModuleInit() {
    await this.connect();
  }
  private async connect() {
    if (this.stopped) return;
    try {
      const client = await this.pool.connect();
      if (this.stopped) {
        client.release();
        return;
      }
      this.client = client;
      client.on("notification", (message) => {
        if (message.channel !== "corewaste_changes" || !message.payload) return;
        try {
          const data = JSON.parse(message.payload);
          this.subject.next({
            customer_id:
              typeof data.customer_id === "string" ? data.customer_id : null,
          });
        } catch {
          /* Invalid database notifications never become client data. */
        }
      });
      client.on("error", () => {
        if (this.client === client) {
          this.client = null;
          client.release(true);
          if (!this.stopped)
            this.reconnect = setTimeout(() => void this.connect(), 1000);
        }
      });
      await client.query("LISTEN corewaste_changes");
    } catch {
      const failed = this.client;
      this.client = null;
      if (failed) failed.release(true);
      if (!this.stopped)
        this.reconnect = setTimeout(() => void this.connect(), 1000);
    }
  }
  events(a: Actor): Observable<MessageEvent> {
    return merge(
      this.subject.pipe(
        filter((change) => visibleChange(a, change)),
        map(() => ({ type: "refresh", data: { refresh: true } })),
      ),
      interval(25000).pipe(
        map(() => ({ type: "heartbeat", data: { connected: true } })),
      ),
    ).pipe(takeUntil(timer(55000)));
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.subject.complete();
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.query("UNLISTEN corewaste_changes");
      } finally {
        client.release();
      }
    }
  }
}
