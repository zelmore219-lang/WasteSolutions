import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { Actor, Operations, parse, permit, uuid } from "./domain";
import { renderTemplate } from "./notification-outbox";
export class Notifications {
  constructor(readonly ops: Operations) {}
  async preferences(a: Actor) {
    permit(a, ["customer"]);
    return (
      (
        await this.ops.pool.query(
          "SELECT email_enabled,sms_enabled,sms_consent_at FROM notification_preferences WHERE customer_id=$1",
          [a.customer_id],
        )
      ).rows[0] || { email_enabled: true, sms_enabled: false }
    );
  }
  async savePreferences(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["customer"]);
    const b = parse(
      z
        .object({
          email_enabled: z.boolean(),
          sms_enabled: z.boolean(),
          sms_consent: z.boolean(),
        })
        .strict(),
      body,
    );
    if (b.sms_enabled && !b.sms_consent)
      throw new BadRequestException("SMS opt-in consent is required");
    return this.ops.command(
      a,
      key,
      ["notifications.preferences", b],
      async (c) => {
        const customer = (
          await c.query("SELECT phone FROM customers WHERE id=$1", [
            a.customer_id,
          ])
        ).rows[0];
        if (b.sms_enabled && !/^\+[1-9][0-9]{7,14}$/.test(customer.phone))
          throw new BadRequestException(
            "Update your account phone to international format before enabling SMS",
          );
        const row = (
          await c.query(
            "INSERT INTO notification_preferences(customer_id,email_enabled,sms_enabled,sms_consent_at,updated_by) VALUES($1,$2,$3,CASE WHEN $3 THEN now() ELSE NULL END,$4) ON CONFLICT(customer_id) DO UPDATE SET email_enabled=$2,sms_enabled=$3,sms_consent_at=CASE WHEN $3 THEN now() ELSE notification_preferences.sms_consent_at END,updated_by=$4,updated_at=now() RETURNING *",
            [a.customer_id, b.email_enabled, b.sms_enabled, a.id],
          )
        ).rows[0];
        await c.query(
          "UPDATE notification_outbox o SET state='cancelled' FROM notifications n WHERE n.id=o.notification_id AND n.customer_id=$1 AND o.state='pending' AND ((o.channel='email' AND NOT $2) OR (o.channel='sms' AND NOT $3))",
          [a.customer_id, b.email_enabled, b.sms_enabled],
        );
        await this.ops.audit(
          c,
          a,
          "notification.preferences_updated",
          a.customer_id!,
        );
        return row;
      },
    );
  }
  async templates(a: Actor) {
    permit(a, ["owner", "manager"]);
    return (
      await this.ops.pool.query(
        "SELECT * FROM notification_templates ORDER BY kind",
      )
    ).rows;
  }
  async template(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager"]);
    const b = parse(
      z
        .object({
          kind: z.string().regex(/^[a-z_]{3,80}$/),
          subject: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^\r\n]*$/),
          message: z.string().min(1).max(2000),
          enabled: z.boolean(),
        })
        .strict(),
      body,
    );
    try {
      renderTemplate(b.subject, {
        company_name: "",
        customer_name: "",
        subject: "",
        message: "",
      });
      renderTemplate(b.message, {
        company_name: "",
        customer_name: "",
        subject: "",
        message: "",
      });
    } catch {
      throw new BadRequestException(
        "Use only company_name, customer_name, subject and message template fields",
      );
    }
    return this.ops.command(a, key, ["notification.template", b], async (c) => {
      const row = (
        await c.query(
          "INSERT INTO notification_templates(kind,subject,message,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(kind) DO UPDATE SET subject=$2,message=$3,enabled=$4,version=notification_templates.version+1 RETURNING *",
          [b.kind, b.subject, b.message, b.enabled],
        )
      ).rows[0];
      await this.ops.audit(c, a, "notification.template_updated", a.id, {
        kind: b.kind,
      });
      return row;
    });
  }
  async deliveries(a: Actor) {
    permit(a, ["owner", "manager"]);
    return (
      await this.ops.pool.query(
        "SELECT o.id,o.channel,o.destination,o.state,o.attempts,o.provider_id,o.next_attempt_at,o.last_error_code,n.subject,n.customer_id FROM notification_outbox o JOIN notifications n ON n.id=o.notification_id ORDER BY n.created_at DESC LIMIT 500",
      )
    ).rows;
  }
  async retry(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          confirmed_not_delivered: z.boolean(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["notification.retry", id, b],
      async (c) => {
        const row = (
          await c.query(
            "SELECT * FROM notification_outbox WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!row) throw new NotFoundException();
        if (!["failed", "uncertain"].includes(row.state))
          throw new ConflictException(
            "Only failed or uncertain deliveries may be requeued",
          );
        if (row.state === "uncertain" && !b.confirmed_not_delivered)
          throw new BadRequestException(
            "Check provider delivery evidence and confirm non-delivery before retrying an uncertain message",
          );
        await c.query(
          "UPDATE notification_outbox SET state='pending',attempts=0,next_attempt_at=now(),lease_until=NULL,delivery_token=NULL,last_error_code=NULL,first_attempt_at=NULL WHERE id=$1",
          [id],
        );
        await this.ops.audit(c, a, "notification.requeued", id, b);
        return { queued: true };
      },
    );
  }
}
