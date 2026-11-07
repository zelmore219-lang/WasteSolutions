import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import {
  Actor,
  Operations,
  OFFICE,
  FINANCE,
  parse,
  permit,
  uuid,
  customerInput,
} from "./domain";
export class Customers {
  constructor(readonly ops: Operations) {}
  async update(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, [...OFFICE, "customer"]);
    parse(uuid, id);
    if (a.role === "customer" && a.customer_id !== id)
      throw new ForbiddenException();
    const schema =
      a.role === "customer"
        ? z
            .object({
              phone: z.string().max(40),
              billing_address: z.string().trim().min(1).max(2000),
              version: z.number().int().positive(),
            })
            .strict()
        : customerInput.extend({
            status: z.enum(["active", "suspended"]),
            version: z.number().int().positive(),
          });
    const b = parse(schema, body);
    return this.ops.command(a, key, ["customer.update", id, b], async (c) => {
      const old = (
        await c.query("SELECT * FROM customers WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!old) throw new NotFoundException("Customer not found");
      if (old.version !== b.version)
        throw new ConflictException(
          "Customer record changed; refresh before saving",
        );
      const full = { ...old, ...b };
      const r = (
        await c.query(
          "UPDATE customers SET name=$2,kind=$3,email=$4,phone=$5,billing_address=$6,status=$7,version=version+1 WHERE id=$1 RETURNING *",
          [
            id,
            full.name,
            full.kind,
            full.email,
            full.phone,
            full.billing_address,
            full.status,
          ],
        )
      ).rows[0];
      if (old.phone !== r.phone) {
        await c.query(
          "UPDATE notification_preferences SET sms_enabled=false,updated_by=$2,updated_at=now() WHERE customer_id=$1",
          [id, a.id],
        );
        await c.query(
          "UPDATE notification_outbox o SET state='cancelled' FROM notifications n WHERE n.id=o.notification_id AND n.customer_id=$1 AND o.channel='sms' AND o.state='pending'",
          [id],
        );
      }
      await this.ops.audit(c, a, "customer.updated", id, { status: r.status });
      return r;
    });
  }
  async notes(a: Actor, id: string) {
    permit(a, [...OFFICE, ...FINANCE]);
    parse(uuid, id);
    return (
      await this.ops.pool.query(
        "SELECT n.*,e.display_name AS actor_name FROM customer_notes n JOIN employees e ON e.id=n.actor_id WHERE customer_id=$1 ORDER BY created_at DESC",
        [id],
      )
    ).rows;
  }
  async note(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z.object({ note: z.string().trim().min(1).max(5000) }).strict(),
      body,
    );
    return this.ops.command(a, key, ["customer.note", id, b], async (c) => {
      const n = (
        await c.query(
          "INSERT INTO customer_notes(customer_id,note,actor_id) VALUES($1,$2,$3) RETURNING *",
          [id, b.note, a.id],
        )
      ).rows[0];
      await this.ops.audit(c, a, "customer.note_added", id);
      return n;
    });
  }
}
