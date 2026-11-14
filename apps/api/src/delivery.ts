import { providerValue } from "./provider-runtime";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { fetch, EnvHttpProxyAgent } from "undici";
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly permanent = false,
    readonly ambiguous = false,
  ) {
    super(code);
  }
}
export type Delivery = {
  id: string;
  channel: "email" | "sms";
  destination: string;
  subject: string;
  body: string;
  first_attempt_at: Date;
};
export interface DeliveryAdapter {
  channel: "email" | "sms";
  idempotent: boolean;
  send: (message: Delivery) => Promise<string>;
}
const dispatcher = new EnvHttpProxyAgent();
export class ResendAdapter implements DeliveryAdapter {
  readonly channel = "email" as const;
  readonly idempotent = true;
  constructor(
    private key: string,
    private from: string,
  ) {}
  async send(m: Delivery) {
    let response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        dispatcher,
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: "Bearer " + this.key,
          "Content-Type": "application/json",
          "Idempotency-Key": "corewaste-notification-" + m.id,
        },
        body: JSON.stringify({
          from: this.from,
          to: [m.destination],
          subject: m.subject,
          text: m.body,
        }),
      });
    } catch {
      throw new DeliveryError("email_response_unknown", false, true);
    }
    if (!response.ok)
      throw new DeliveryError(
        "email_http_" + response.status,
        response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429 &&
          response.status !== 409,
        response.status === 409 || response.status >= 500,
      );
    const value = (await response.json()) as { id?: string };
    if (!value.id)
      throw new DeliveryError("email_missing_receipt", false, true);
    return value.id;
  }
}
export class TwilioAdapter implements DeliveryAdapter {
  readonly channel = "sms" as const;
  readonly idempotent = false;
  constructor(
    private sid: string,
    private token: string,
    private from: string,
  ) {}
  async send(m: Delivery) {
    let response;
    try {
      response = await fetch(
        "https://api.twilio.com/2010-04-01/Accounts/" +
          encodeURIComponent(this.sid) +
          "/Messages.json",
        {
          dispatcher,
          method: "POST",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization:
              "Basic " +
              Buffer.from(this.sid + ":" + this.token).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: m.destination,
            From: this.from,
            Body: m.body,
          }).toString(),
        },
      );
    } catch {
      throw new DeliveryError("sms_response_unknown", false, true);
    }
    if (!response.ok)
      throw new DeliveryError(
        "sms_http_" + response.status,
        response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429,
        response.status >= 500,
      );
    const value = (await response.json()) as { sid?: string };
    if (!value.sid) throw new DeliveryError("sms_missing_receipt", false, true);
    return value.sid;
  }
}
export function configuredAdapters() {
  const adapters: DeliveryAdapter[] = [];
  if (providerValue("RESEND_API_KEY") && providerValue("EMAIL_FROM"))
    adapters.push(
      new ResendAdapter(
        providerValue("RESEND_API_KEY")!,
        providerValue("EMAIL_FROM")!,
      ),
    );
  if (
    providerValue("TWILIO_ACCOUNT_SID") &&
    providerValue("TWILIO_AUTH_TOKEN") &&
    providerValue("SMS_FROM")
  )
    adapters.push(
      new TwilioAdapter(
        providerValue("TWILIO_ACCOUNT_SID")!,
        providerValue("TWILIO_AUTH_TOKEN")!,
        providerValue("SMS_FROM")!,
      ),
    );
  return adapters;
}
export async function deliverBatch(
  pool: Pool,
  adapters: DeliveryAdapter[],
  limit = 25,
  onlyIds?: string[],
) {
  const byChannel = new Map(adapters.map((a) => [a.channel, a]));
  if (!byChannel.size) return { processed: 0, providers_configured: false };
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const c = await pool.connect();
    let row: any;
    try {
      await c.query("BEGIN");
      await c.query(
        "UPDATE notification_outbox SET state=CASE WHEN channel='sms' OR first_attempt_at<now()-interval '23 hours' THEN 'uncertain' ELSE 'pending' END,last_error_code='delivery_lease_expired',lease_until=NULL,next_attempt_at=now() WHERE state='sending' AND lease_until<now()",
      );
      row = (
        await c.query(
          "SELECT o.*,n.subject,n.message,n.customer_id FROM notification_outbox o JOIN notifications n ON n.id=o.notification_id WHERE o.state='pending' AND o.next_attempt_at<=now() AND o.channel=ANY($1::text[]) AND ($2::uuid[] IS NULL OR o.id=ANY($2::uuid[])) ORDER BY o.next_attempt_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1",
          [[...byChannel.keys()], onlyIds || null],
        )
      ).rows[0];
      if (!row) {
        await c.query("COMMIT");
        break;
      }
      const contact = (
        await c.query(
          "SELECT c.email,c.phone,p.email_enabled,p.sms_enabled FROM customers c LEFT JOIN notification_preferences p ON p.customer_id=c.id WHERE c.id=$1",
          [row.customer_id],
        )
      ).rows[0];
      const optedOut =
        row.channel === "email"
          ? contact.email_enabled === false || contact.email !== row.destination
          : !contact.sms_enabled || contact.phone !== row.destination;
      if (optedOut) {
        await c.query(
          "UPDATE notification_outbox SET state='cancelled',last_error_code='recipient_preference_changed' WHERE id=$1",
          [row.id],
        );
        await c.query("COMMIT");
        continue;
      }
      const token = randomUUID();
      row = {
        ...row,
        delivery_token: token,
        attempts: row.attempts + 1,
        first_attempt_at: row.first_attempt_at || new Date(),
        subject: row.rendered_subject || row.subject,
        body: row.rendered_body || row.message,
      };
      await c.query(
        "UPDATE notification_outbox SET state='sending',attempts=attempts+1,delivery_token=$2,lease_until=now()+interval '2 minutes',first_attempt_at=COALESCE(first_attempt_at,now()),rendered_subject=$3,rendered_body=$4 WHERE id=$1",
        [row.id, token, row.subject, row.body],
      );
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
    const adapter = byChannel.get(row.channel)!;
    if (
      adapter.idempotent &&
      Date.now() - new Date(row.first_attempt_at).getTime() > 23 * 3600000
    ) {
      await pool.query(
        "UPDATE notification_outbox SET state='uncertain',last_error_code='provider_idempotency_window_expired',lease_until=NULL WHERE id=$1 AND delivery_token=$2",
        [row.id, row.delivery_token],
      );
      processed++;
      continue;
    }
    try {
      const providerId = await adapter.send(row);
      await pool.query(
        "UPDATE notification_outbox SET state='sent',provider_id=$3,lease_until=NULL,last_error_code=NULL WHERE id=$1 AND delivery_token=$2 AND state IN ('sending','uncertain')",
        [row.id, row.delivery_token, providerId],
      );
    } catch (error) {
      const e =
        error instanceof DeliveryError
          ? error
          : new DeliveryError("delivery_outcome_unknown", false, true);
      const uncertain =
          e.ambiguous && (!adapter.idempotent || row.attempts >= 6),
        state = uncertain
          ? "uncertain"
          : e.permanent || row.attempts >= 6
            ? "failed"
            : "pending";
      const delay = Math.min(3600, Math.pow(2, row.attempts - 1) * 60);
      await pool.query(
        "UPDATE notification_outbox SET state=$3,last_error_code=$4,lease_until=NULL,next_attempt_at=now()+$5::int*interval '1 second' WHERE id=$1 AND delivery_token=$2 AND state='sending'",
        [row.id, row.delivery_token, state, e.code, delay],
      );
    }
    processed++;
  }
  return { processed, providers_configured: true };
}
