import { providerValue } from "./provider-runtime";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import type Stripe from "stripe";
import { Actor, Operations, FINANCE, parse, permit, uuid } from "./domain";
import { invoiceBalance } from "./finance";
import { notify } from "./notification-outbox";
import { stripeClient } from "./payment-runtime";
import {
  activeRefundStates,
  reservedCreditRefunds,
} from "./refund-reservations";
const providerId = z
  .string()
  .regex(/^re_[A-Za-z0-9_]+$/)
  .max(200);
const receiptSchema = z.object({
  id: providerId,
  payment_intent: z.string().regex(/^pi_[A-Za-z0-9_]+$/),
  currency: z.literal("usd"),
  amount: z.number().int().positive().max(100000000),
  status: z.enum([
    "pending",
    "requires_action",
    "succeeded",
    "failed",
    "canceled",
  ]),
  livemode: z.boolean(),
  metadata: z.record(z.string(), z.string()),
});
export interface RefundProvider {
  configured(): boolean;
  create(
    input: {
      payment_intent: string;
      amount: number;
      metadata: { corewaste_refund_request_id: string };
    },
    key: string,
  ): Promise<unknown>;
  retrieve(id: string): Promise<unknown>;
}
export class StripeRefundProvider implements RefundProvider {
  configured() {
    return (
      Boolean(providerValue("STRIPE_SECRET_KEY")) &&
      (process.env.NODE_ENV !== "production" ||
        providerValue("PAYMENTS_MODE") === "live")
    );
  }
  async create(
    input: {
      payment_intent: string;
      amount: number;
      metadata: { corewaste_refund_request_id: string };
    },
    key: string,
  ) {
    return stripeClient().refunds.create(input, {
      idempotencyKey: key,
      maxNetworkRetries: 0,
    });
  }
  async retrieve(id: string) {
    return stripeClient().refunds.retrieve(id);
  }
}
export class StripeRefunds {
  constructor(
    readonly ops: Operations,
    readonly provider: RefundProvider = new StripeRefundProvider(),
  ) {}
  private configuration() {
    if (!this.provider.configured())
      throw new ServiceUnavailableException(
        "Stripe refunds are not configured for this environment",
      );
  }
  async list(a: Actor, query: unknown = {}) {
    permit(a, FINANCE);
    const b = parse(
      z
        .object({ payment_id: uuid.optional(), credit_id: uuid.optional() })
        .strict(),
      query,
    );
    const requests = (
      await this.ops.pool.query(
        "SELECT r.*,c.name AS customer_name FROM stripe_refund_requests r JOIN customers c ON c.id=r.customer_id WHERE ($1::uuid IS NULL OR r.payment_id=$1) AND ($2::uuid IS NULL OR r.credit_id=$2) ORDER BY CASE WHEN r.state IN ('requested','sending','pending','review') THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC LIMIT 200",
        [b.payment_id || null, b.credit_id || null],
      )
    ).rows;
    const unmatched = (
      await this.ops.pool.query(
        "SELECT DISTINCT ON (o.provider_refund_id) o.* FROM stripe_refund_observations o WHERE o.request_id IS NULL AND NOT EXISTS(SELECT 1 FROM stripe_refund_requests linked WHERE linked.provider_refund_id=o.provider_refund_id) ORDER BY o.provider_refund_id,o.recorded_at DESC LIMIT 200",
      )
    ).rows;
    return { configured: this.provider.configured(), requests, unmatched };
  }
  private async lock(c: PoolClient, id: string) {
    const initial = (
      await c.query("SELECT * FROM stripe_refund_requests WHERE id=$1", [id])
    ).rows[0];
    if (!initial) throw new NotFoundException("Refund request not found");
    if (initial.invoice_id)
      await c.query("SELECT id FROM invoices WHERE id=$1 FOR UPDATE", [
        initial.invoice_id,
      ]);
    if (initial.credit_id)
      await c.query("SELECT id FROM customer_credits WHERE id=$1 FOR UPDATE", [
        initial.credit_id,
      ]);
    return (
      await c.query(
        "SELECT * FROM stripe_refund_requests WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
  }
  async request(
    a: Actor,
    key: string | undefined,
    target: "payment" | "credit",
    id: string,
    body: unknown,
  ) {
    return this.createRequest(a, key, target, id, body);
  }
  async adoptExternal(
    a: Actor,
    key: string | undefined,
    target: "payment" | "credit",
    id: string,
    body: unknown,
  ) {
    permit(a, FINANCE);
    parse(uuid, id);
    this.configuration();
    const b = parse(
      z
        .object({
          provider_refund_id: providerId,
          amount_cents: z.number().int().positive().max(100000000),
          reason: z.string().trim().min(1).max(2000),
          payment_id: uuid.optional(),
          confirm: z.string(),
        })
        .strict(),
      body,
    );
    if (b.confirm !== "RECONCILE " + b.provider_refund_id)
      throw new BadRequestException(
        "Confirm the exact existing Stripe refund receipt with RECONCILE followed by its ID",
      );
    const receipt = receiptSchema.safeParse(
      await this.provider.retrieve(b.provider_refund_id),
    );
    if (
      !receipt.success ||
      receipt.data.id !== b.provider_refund_id ||
      receipt.data.metadata.corewaste_refund_request_id
    )
      throw new ConflictException(
        "Choose an external Stripe receipt without another CoreWaste request identity",
      );
    const { provider_refund_id, confirm, ...request } = b;
    const row: any = await this.createRequest(
      a,
      key,
      target,
      id,
      request,
      receipt.data,
    );
    return this.accept(row.id, receipt.data);
  }
  private async createRequest(
    a: Actor,
    key: string | undefined,
    target: "payment" | "credit",
    id: string,
    body: unknown,
    externalReceipt?: z.infer<typeof receiptSchema>,
  ) {
    permit(a, FINANCE);
    parse(uuid, id);
    this.configuration();
    const b = parse(
      z
        .object({
          amount_cents: z.number().int().positive().max(100000000),
          reason: z.string().trim().min(1).max(2000),
          payment_id: uuid.optional(),
        })
        .strict(),
      body,
    );
    if (target === "payment" && b.payment_id)
      throw new BadRequestException("Payment target is already specified");
    return this.ops.command(
      a,
      key,
      externalReceipt
        ? ["stripe.refund.external", target, id, b, externalReceipt.id]
        : ["stripe.refund.request", target, id, b],
      async (c) => {
        let payment: any = null,
          credit: any = null,
          invoiceId: string | null = null,
          customerId: string,
          paymentIntent: string;
        if (target === "payment" || b.payment_id) {
          payment = (
            await c.query("SELECT * FROM payments WHERE id=$1", [
              target === "payment" ? id : b.payment_id,
            ])
          ).rows[0];
          if (
            !payment ||
            payment.method !== "stripe" ||
            !/^pi_[A-Za-z0-9_]+$/.test(payment.reference)
          )
            throw new BadRequestException("Choose a recorded Stripe payment");
          invoiceId = payment.invoice_id;
          await c.query("SELECT id FROM invoices WHERE id=$1 FOR UPDATE", [
            invoiceId,
          ]);
        }
        if (target === "credit") {
          // An invoice-funded credit must lock its source invoice before the credit, matching credit application/refund lock order.
          const transfer = (
            await c.query(
              "SELECT invoice_id FROM invoice_credit_transfers WHERE credit_id=$1",
              [id],
            )
          ).rows[0];
          if (transfer) {
            if (!payment || payment.invoice_id !== transfer.invoice_id)
              throw new BadRequestException(
                "Invoice-funded credit requires a Stripe payment ID from that same invoice",
              );
          }
          credit = (
            await c.query(
              "SELECT * FROM customer_credits WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
          if (!credit) throw new NotFoundException("Account credit not found");
          if (!transfer && !/^pi_[A-Za-z0-9_]+$/.test(credit.source_reference))
            throw new BadRequestException(
              "Account credit is not linked to captured Stripe funds",
            );
          if (!transfer && payment)
            throw new BadRequestException(
              "Captured account credit uses its own Stripe payment reference",
            );
          if (
            b.amount_cents >
            credit.remaining_cents - (await reservedCreditRefunds(c, credit.id))
          )
            throw new ConflictException(
              "Refund exceeds unreserved account credit",
            );
        }
        if (
          target === "payment" &&
          (
            await c.query(
              "SELECT 1 FROM invoice_credit_transfers WHERE invoice_id=$1",
              [invoiceId],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Payment funded account credit; refund the available credit and identify its original Stripe payment instead",
          );
        if (payment) {
          const used = Number(
            (
              await c.query(
                `SELECT COALESCE((SELECT sum(amount_cents) FROM refunds WHERE payment_id=$1),0)+COALESCE((SELECT sum(amount_cents) FROM stripe_refund_requests WHERE payment_id=$1 AND (state=ANY($2::text[]) OR (state='succeeded' AND credit_id IS NOT NULL))),0) AS amount`,
                [payment.id, activeRefundStates],
              )
            ).rows[0].amount,
          );
          if (b.amount_cents > payment.amount_cents - used)
            throw new ConflictException(
              "Refund exceeds unrefunded and unreserved Stripe payment",
            );
        }
        customerId = credit?.customer_id || payment.customer_id;
        paymentIntent = payment?.reference || credit.source_reference;
        if (
          externalReceipt &&
          (externalReceipt.payment_intent !== paymentIntent ||
            externalReceipt.amount !== b.amount_cents ||
            (providerValue("PAYMENTS_MODE") &&
              externalReceipt.livemode !==
                (providerValue("PAYMENTS_MODE") === "live")))
        )
          throw new ConflictException(
            "External Stripe receipt does not match the selected funds, amount or environment",
          );
        if (
          externalReceipt &&
          (
            await c.query(
              "SELECT 1 FROM stripe_refund_requests WHERE provider_refund_id=$1",
              [externalReceipt.id],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Stripe refund receipt is already reconciled to a request",
          );
        if (
          (
            await c.query(
              `SELECT 1 FROM (SELECT DISTINCT ON (provider_refund_id) provider_status FROM stripe_refund_observations WHERE request_id IS NULL AND payment_intent=$1 AND ($2::text IS NULL OR provider_refund_id<>$2) AND NOT EXISTS(SELECT 1 FROM stripe_refund_requests linked WHERE linked.provider_refund_id=stripe_refund_observations.provider_refund_id) ORDER BY provider_refund_id,recorded_at DESC) o LIMIT 1`,
              [paymentIntent, externalReceipt?.id || null],
            )
          ).rowCount
        )
          throw new ConflictException(
            "An unmatched provider refund needs finance reconciliation before another refund can be requested",
          );
        const row = (
          await c.query(
            "INSERT INTO stripe_refund_requests(payment_id,credit_id,invoice_id,customer_id,payment_intent,amount_cents,reason,actor_id,provider_refund_id,external_receipt,attempted_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10::boolean THEN now() ELSE NULL END,CASE WHEN $10::boolean THEN 'pending' ELSE 'requested' END) RETURNING *",
            [
              payment?.id || null,
              credit?.id || null,
              invoiceId,
              customerId,
              paymentIntent,
              b.amount_cents,
              b.reason,
              a.id,
              externalReceipt?.id || null,
              Boolean(externalReceipt),
            ],
          )
        ).rows[0];
        await this.ops.audit(c, a, "stripe.refund_requested", row.id, {
          target,
          target_id: id,
          amount_cents: b.amount_cents,
          reason: b.reason,
        });
        return row;
      },
    );
  }
  async cancel(a: Actor, key: string | undefined, id: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    return this.ops.command(a, key, ["stripe.refund.cancel", id], async (c) => {
      const row = await this.lock(c, id);
      if (row.state !== "requested" || row.attempted_at)
        throw new ConflictException(
          "Only a refund never submitted to Stripe can be cancelled locally",
        );
      const after = (
        await c.query(
          "UPDATE stripe_refund_requests SET state='cancelled',updated_at=now() WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await this.ops.audit(c, a, "stripe.refund_cancelled", id);
      return after;
    });
  }
  async submit(a: Actor, id: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    this.configuration();
    const c = await this.ops.pool.connect();
    let row: any;
    try {
      await c.query("BEGIN");
      row = await this.lock(c, id);
      if (row.state !== "requested" || row.attempted_at) {
        await c.query("COMMIT");
        return row;
      }
      row = (
        await c.query(
          "UPDATE stripe_refund_requests SET state='sending',attempted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await this.ops.audit(c, a, "stripe.refund_submission_claimed", id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    try {
      const receipt = await this.provider.create(
        {
          payment_intent: row.payment_intent,
          amount: row.amount_cents,
          metadata: { corewaste_refund_request_id: id },
        },
        "corewaste-refund-" + id,
      );
      return await this.accept(id, receipt);
    } catch {
      await this.ops.pool.query(
        "UPDATE stripe_refund_requests SET state='review',last_error='Provider delivery is uncertain or the receipt did not match. Reconcile an exact Stripe refund receipt; do not submit again.',updated_at=now() WHERE id=$1 AND state IN ('sending','pending','review')",
        [id],
      );
      return (
        await this.ops.pool.query(
          "SELECT * FROM stripe_refund_requests WHERE id=$1",
          [id],
        )
      ).rows[0];
    }
  }
  async reconcile(a: Actor, id: string, body: unknown) {
    permit(a, FINANCE);
    parse(uuid, id);
    this.configuration();
    const b = parse(
      z.object({ provider_refund_id: providerId }).strict(),
      body,
    );
    const row = (
      await this.ops.pool.query(
        "SELECT * FROM stripe_refund_requests WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Refund request not found");
    if (!row.attempted_at || ["requested", "cancelled"].includes(row.state))
      throw new ConflictException(
        "This request has not been submitted to Stripe",
      );
    if (
      row.provider_refund_id &&
      row.provider_refund_id !== b.provider_refund_id
    )
      throw new ConflictException(
        "Refund request already has a different provider receipt",
      );
    const receipt = await this.provider.retrieve(b.provider_refund_id);
    return this.accept(id, receipt);
  }
  private validateReceipt(row: any, raw: unknown) {
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success)
      throw new ConflictException(
        "Stripe refund receipt has unsupported or missing fields",
      );
    const r = parsed.data;
    if (
      (row.external_receipt
        ? Boolean(r.metadata.corewaste_refund_request_id)
        : r.metadata.corewaste_refund_request_id !== row.id) ||
      r.payment_intent !== row.payment_intent ||
      r.amount !== row.amount_cents ||
      (providerValue("PAYMENTS_MODE") &&
        r.livemode !== (providerValue("PAYMENTS_MODE") === "live"))
    )
      throw new ConflictException(
        "Stripe refund receipt does not exactly match this request",
      );
    return r;
  }
  private async accept(
    id: string,
    raw: unknown,
    event?: { id: string; kind: string },
  ) {
    const c = await this.ops.pool.connect();
    try {
      await c.query("BEGIN");
      if (event) {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "stripe-event:" + event.id,
        ]);
        if (
          (
            await c.query("SELECT 1 FROM provider_events WHERE id=$1", [
              event.id,
            ])
          ).rowCount
        ) {
          await c.query("COMMIT");
          return { received: true };
        }
      }
      const row = await this.lock(c, id),
        receipt = this.validateReceipt(row, raw);
      if (!row.attempted_at || row.state === "cancelled")
        throw new ConflictException(
          "Refund was not authorized for provider submission",
        );
      if (row.provider_refund_id && row.provider_refund_id !== receipt.id)
        throw new ConflictException("Refund provider reference changed");
      if (row.state !== "succeeded") {
        if (
          row.state === "failed" &&
          !["failed", "canceled"].includes(receipt.status)
        )
          throw new ConflictException(
            "Terminal provider failure cannot be overwritten; reconcile manually",
          );
        let state = ["failed", "canceled"].includes(receipt.status)
          ? "failed"
          : receipt.status === "succeeded"
            ? "succeeded"
            : "pending";
        let localRefundId: string | null = null,
          localCreditRefundId: string | null = null;
        if (state === "succeeded") {
          if (row.credit_id) {
            const credit = (
              await c.query("SELECT * FROM customer_credits WHERE id=$1", [
                row.credit_id,
              ])
            ).rows[0];
            if (credit.remaining_cents < row.amount_cents)
              throw new ConflictException(
                "Reserved account credit no longer reconciles",
              );
            const refund = (
              await c.query(
                "INSERT INTO customer_credit_refunds(credit_id,amount_cents,method,reference,reason,actor_id) VALUES($1,$2,'stripe',$3,$4,$5) RETURNING *",
                [
                  row.credit_id,
                  row.amount_cents,
                  receipt.id,
                  row.reason,
                  row.actor_id,
                ],
              )
            ).rows[0];
            localCreditRefundId = refund.id;
            await c.query(
              "UPDATE customer_credits SET remaining_cents=remaining_cents-$2 WHERE id=$1",
              [row.credit_id, row.amount_cents],
            );
            await c.query(
              "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id) VALUES('customer_credit','cash',$1,'credit_refund',$2)",
              [row.amount_cents, refund.id],
            );
          } else {
            const refund = (
              await c.query(
                "INSERT INTO refunds(payment_id,amount_cents,reason,reference,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
                [
                  row.payment_id,
                  row.amount_cents,
                  row.reason,
                  receipt.id,
                  row.actor_id,
                ],
              )
            ).rows[0];
            localRefundId = refund.id;
            await c.query(
              "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,'accounts_receivable','cash',$2,'refund',$3)",
              [row.invoice_id, row.amount_cents, refund.id],
            );
            const balance = await invoiceBalance(c, row.invoice_id);
            await c.query(
              "UPDATE invoices SET status=CASE WHEN $2=0 THEN 'paid' ELSE 'open' END WHERE id=$1",
              [row.invoice_id, balance],
            );
          }
          await notify(
            c,
            row.customer_id,
            "payment_refunded",
            "Stripe refund confirmed",
            "A refund of $" +
              (row.amount_cents / 100).toFixed(2) +
              " was confirmed. Contact the office with questions.",
            "stripe-refund:" + id,
          );
        }
        await c.query(
          "UPDATE stripe_refund_requests SET state=$2,provider_refund_id=$3,local_refund_id=COALESCE(local_refund_id,$4),local_credit_refund_id=COALESCE(local_credit_refund_id,$5),last_error=NULL,updated_at=now() WHERE id=$1",
          [id, state, receipt.id, localRefundId, localCreditRefundId],
        );
        await this.ops.audit(
          c,
          { id: row.actor_id, role: "accountant", customer_id: null },
          "stripe.refund_receipt",
          id,
          {
            provider_refund_id: receipt.id,
            state,
            amount_cents: row.amount_cents,
          },
        );
      }
      if (event) {
        await c.query(
          "INSERT INTO stripe_refund_observations(event_id,provider_refund_id,payment_intent,currency,amount_cents,provider_status,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            event.id,
            receipt.id,
            receipt.payment_intent,
            receipt.currency,
            receipt.amount,
            receipt.status,
            id,
          ],
        );
        await c.query(
          "INSERT INTO provider_events(id,kind,object_id) VALUES($1,$2,$3)",
          [event.id, event.kind, receipt.id],
        );
      }
      const after = (
        await c.query("SELECT * FROM stripe_refund_requests WHERE id=$1", [id])
      ).rows[0];
      await c.query("COMMIT");
      return after;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async event(event: Stripe.Event) {
    if (
      !["refund.created", "refund.updated", "refund.failed"].includes(
        event.type,
      )
    )
      return { received: true };
    const raw = event.data.object as any;
    const requestId = raw.metadata?.corewaste_refund_request_id;
    if (
      uuid.safeParse(requestId).success &&
      (
        await this.ops.pool.query(
          "SELECT 1 FROM stripe_refund_requests WHERE id=$1",
          [requestId],
        )
      ).rowCount
    )
      return this.accept(requestId, raw, { id: event.id, kind: event.type });
    const external = (
      await this.ops.pool.query(
        "SELECT id FROM stripe_refund_requests WHERE provider_refund_id=$1 AND external_receipt",
        [typeof raw.id === "string" ? raw.id : null],
      )
    ).rows[0];
    if (external)
      return this.accept(external.id, raw, { id: event.id, kind: event.type });
    // Preserve externally initiated/unknown receipts for review. Never guess their ledger treatment.
    const minimal = z
      .object({
        id: providerId,
        payment_intent: z.string().max(200).nullable(),
        currency: z.string().max(10),
        amount: z.number().int().positive().max(100000000),
        status: z.string().max(40),
      })
      .safeParse(raw);
    if (!minimal.success)
      throw new BadRequestException("Unsupported refund event");
    const r = minimal.data,
      c = await this.ops.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "stripe-event:" + event.id,
      ]);
      if (
        !(
          await c.query("SELECT 1 FROM provider_events WHERE id=$1", [event.id])
        ).rowCount
      ) {
        await c.query(
          "INSERT INTO stripe_refund_observations(event_id,provider_refund_id,payment_intent,currency,amount_cents,provider_status) VALUES($1,$2,$3,$4,$5,$6)",
          [event.id, r.id, r.payment_intent, r.currency, r.amount, r.status],
        );
        await c.query(
          "INSERT INTO provider_events(id,kind,object_id) VALUES($1,$2,$3)",
          [event.id, event.type, r.id],
        );
      }
      await c.query("COMMIT");
      return { received: true, review_required: true };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}
