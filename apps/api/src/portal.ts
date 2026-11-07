import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { DecodedIdToken } from "firebase-admin/auth";
import { randomUUID, createHash } from "node:crypto";
import { Actor, Operations, OFFICE, parse, permit, uuid } from "./domain";
export class Portal {
  constructor(readonly ops: Operations) {}
  async publicCompany() {
    return (
      await this.ops.pool.query(
        "SELECT name,email,phone,address FROM company_settings WHERE singleton",
      )
    ).rows[0];
  }
  async inquiry(body: unknown) {
    const b = parse(
      z
        .object({
          request_id: uuid,
          name: z.string().trim().min(1).max(200),
          email: z.email(),
          phone: z.string().max(40),
          service_address: z.string().trim().min(1).max(2000),
          service_kind: z.enum([
            "residential",
            "commercial",
            "roll_off",
            "bulk",
            "other",
          ]),
          message: z.string().trim().min(1).max(3000),
          website: z.string().max(200).default(""),
        })
        .strict(),
      body,
    );
    if (b.website) return { received: true };
    const hash = createHash("sha256").update(JSON.stringify(b)).digest("hex");
    const row = (
      await this.ops.pool.query(
        "INSERT INTO public_inquiries(name,email,phone,service_address,service_kind,message,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_id) DO NOTHING RETURNING id",
        [
          b.name,
          b.email,
          b.phone,
          b.service_address,
          b.service_kind,
          b.message,
          b.request_id,
          hash,
        ],
      )
    ).rows[0];
    if (row) return { received: true, reference: row.id };
    const prior = (
      await this.ops.pool.query(
        "SELECT id,request_hash FROM public_inquiries WHERE request_id=$1",
        [b.request_id],
      )
    ).rows[0];
    if (prior?.request_hash !== hash)
      throw new ConflictException(
        "Service request key was reused with different details",
      );
    return { received: true, reference: prior.id };
  }
  async inquiries(a: Actor) {
    permit(a, OFFICE);
    return (
      await this.ops.pool.query(
        "SELECT * FROM public_inquiries ORDER BY created_at DESC LIMIT 500",
      )
    ).rows;
  }
  async convert(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          customer_id: uuid,
          location_id: uuid,
          kind: z.enum(["delivery", "pickup", "extra_pickup", "bulk"]),
          scheduled_date: z.iso.date(),
          price_cents: z.number().int().min(0).max(100000000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["inquiry.convert", id, b], async (c) => {
      const inquiry = (
        await c.query("SELECT * FROM public_inquiries WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!inquiry || inquiry.status !== "open")
        throw new ConflictException("Inquiry is not open");
      if (
        !(
          await c.query(
            "SELECT 1 FROM customers c JOIN locations l ON l.customer_id=c.id WHERE c.id=$1 AND l.id=$2 AND l.active AND c.status='active' FOR SHARE OF c",
            [b.customer_id, b.location_id],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Active customer and matching service location required",
        );
      const o = (
        await c.query(
          "INSERT INTO orders(customer_id,location_id,kind,scheduled_date,price_cents,instructions) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            b.customer_id,
            b.location_id,
            b.kind,
            b.scheduled_date,
            b.price_cents,
            inquiry.message,
          ],
        )
      ).rows[0];
      await c.query(
        "UPDATE public_inquiries SET status='converted',order_id=$2 WHERE id=$1",
        [id, o.id],
      );
      await this.ops.event(
        c,
        a,
        o.id,
        "new",
        "Created from public service inquiry",
      );
      await this.ops.audit(c, a, "inquiry.converted", id, { order_id: o.id });
      return o;
    });
  }
  async registration(identity: DecodedIdToken, body: unknown) {
    if (!identity.email_verified || !identity.email)
      throw new ForbiddenException(
        "Verify your email before requesting customer access",
      );
    const b = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          kind: z.enum(["residential", "commercial"]),
          phone: z.string().max(40),
          billing_address: z.string().trim().min(1).max(2000),
          service_address: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    const c = await this.ops.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "portal:" + identity.uid,
      ]);
      if (
        (
          await c.query("SELECT 1 FROM employees WHERE firebase_uid=$1", [
            identity.uid,
          ])
        ).rowCount
      )
        throw new ConflictException("Identity already has company access");
      const prior = (
        await c.query(
          "SELECT id,status FROM portal_registrations WHERE firebase_uid=$1",
          [identity.uid],
        )
      ).rows[0];
      if (prior) {
        await c.query("COMMIT");
        return prior;
      }
      const row = (
        await c.query(
          "INSERT INTO portal_registrations(firebase_uid,email,name,kind,phone,billing_address,service_address) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status",
          [
            identity.uid,
            identity.email.toLowerCase(),
            b.name,
            b.kind,
            b.phone,
            b.billing_address,
            b.service_address,
          ],
        )
      ).rows[0];
      await c.query("SELECT pg_notify('corewaste_changes',$1)", [
        JSON.stringify({ customer_id: null }),
      ]);
      await c.query("COMMIT");
      return row;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async registrationStatus(identity: DecodedIdToken) {
    return (
      (
        await this.ops.pool.query(
          "SELECT id,status,review_note FROM portal_registrations WHERE firebase_uid=$1",
          [identity.uid],
        )
      ).rows[0] || { status: "not_requested" }
    );
  }
  async registrations(a: Actor) {
    permit(a, OFFICE);
    return (
      await this.ops.pool.query(
        "SELECT * FROM portal_registrations ORDER BY created_at DESC LIMIT 500",
      )
    ).rows;
  }
  async review(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          decision: z.enum(["approve", "reject"]),
          customer_id: uuid.optional(),
          review_note: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["portal.review", id, b], async (c) => {
      const r = (
        await c.query(
          "SELECT * FROM portal_registrations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!r || r.status !== "pending")
        throw new ConflictException("Registration already reviewed");
      if (b.decision === "reject") {
        await c.query(
          "UPDATE portal_registrations SET status='rejected',review_note=$2,reviewed_by=$3 WHERE id=$1",
          [id, b.review_note, a.id],
        );
        await this.ops.audit(c, a, "portal.registration_rejected", id);
        return { status: "rejected" };
      }
      let customerId = b.customer_id;
      if (customerId) {
        if (
          !(
            await c.query(
              "SELECT 1 FROM customers WHERE id=$1 AND lower(email)=lower($2) AND status='active' FOR SHARE",
              [customerId, r.email],
            )
          ).rowCount
        )
          throw new BadRequestException(
            "Existing customer must match the verified email and be active",
          );
      } else {
        if (
          (
            await c.query(
              "SELECT 1 FROM customers WHERE lower(email)=lower($1)",
              [r.email],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Customer email already exists; explicitly choose the matching customer account",
          );
        customerId = (
          await c.query(
            "INSERT INTO customers(name,kind,email,phone,billing_address) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [r.name, r.kind, r.email, r.phone, r.billing_address],
          )
        ).rows[0].id;
        const location = (
          await c.query(
            "INSERT INTO locations(customer_id,address) VALUES($1,$2) RETURNING id",
            [customerId, r.service_address],
          )
        ).rows[0];
        await this.ops.audit(c, a, "customer.created", customerId!);
        await this.ops.audit(c, a, "location.created", location.id);
      }
      await c.query(
        "INSERT INTO employees(firebase_uid,username,display_name,role,customer_id) VALUES($1,$2,$3,'customer',$4)",
        [
          r.firebase_uid,
          "portal_" + randomUUID().replaceAll("-", ""),
          r.name,
          customerId,
        ],
      );
      await c.query(
        "UPDATE portal_registrations SET status='approved',customer_id=$2,review_note=$3,reviewed_by=$4 WHERE id=$1",
        [id, customerId, b.review_note, a.id],
      );
      await this.ops.audit(c, a, "portal.registration_approved", id, {
        customer_id: customerId,
      });
      return { status: "approved", customer_id: customerId };
    });
  }
}
