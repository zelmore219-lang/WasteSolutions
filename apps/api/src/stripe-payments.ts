import { stripeClient } from "./payment-runtime";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import Stripe from "stripe";
import { z } from "zod";
import { Actor, Operations, FINANCE, parse, permit, uuid } from "./domain";
import { Finance, invoiceBalance, notify } from "./finance";
export class StripePayments {
  constructor(
    readonly ops: Operations,
    readonly finance: Finance,
  ) {}
  profileEvents?: (event: Stripe.Event) => Promise<unknown>;
  refundEvents?: (event: Stripe.Event) => Promise<unknown>;
  private client() {
    return stripeClient();
  }
  async checkout(a: Actor, key: string | undefined, body: unknown) {
    permit(a, [...FINANCE, "customer"]);
    const b = parse(z.object({ invoice_id: uuid }).strict(), body);
    const stripe = this.client();
    const origin = process.env.PUBLIC_WEB_URL;
    if (!origin)
      throw new ServiceUnavailableException(
        "Payment return address is not configured",
      );
    const address = new URL(origin);
    if (
      address.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1"].includes(address.hostname)
      )
    )
      throw new ServiceUnavailableException(
        "Payment return address must use HTTPS",
      );
    const attempt: any = await this.ops.command(
      a,
      key,
      ["stripe.checkout", b],
      async (c) => {
        const i = (
          await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [
            b.invoice_id,
          ])
        ).rows[0];
        if (!i) throw new NotFoundException("Invoice not found");
        if (a.role === "customer" && a.customer_id !== i.customer_id)
          throw new ForbiddenException();
        const balance = await invoiceBalance(c, i.id);
        if (i.status !== "open" || balance <= 0)
          throw new ConflictException("Invoice has no payable balance");
        const pending = (
          await c.query(
            "SELECT * FROM payment_attempts WHERE invoice_id=$1 AND amount_cents=$2 AND source='checkout' AND status='pending' AND created_at>now()-interval '23 hours' ORDER BY created_at DESC LIMIT 1",
            [i.id, balance],
          )
        ).rows[0];
        if (pending) return pending;
        return (
          await c.query(
            "INSERT INTO payment_attempts(invoice_id,amount_cents) VALUES($1,$2) RETURNING *",
            [i.id, balance],
          )
        ).rows[0];
      },
    );
    // A stable attempt ID survives a lost provider response. Provider I/O occurs outside the database transaction.
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        allowed_payment_method_types: ["card", "us_bank_account"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "CoreWaste invoice payment" },
              unit_amount: attempt.amount_cents,
            },
            quantity: 1,
          },
        ],
        metadata: { corewaste_attempt_id: attempt.id },
        payment_intent_data: { metadata: { corewaste_attempt_id: attempt.id } },
        success_url: new URL("/portal?payment=processing", address.origin).href,
        cancel_url: new URL("/portal?payment=cancelled", address.origin).href,
      },
      { idempotencyKey: "corewaste-checkout-" + attempt.id },
    );
    await this.ops.pool.query(
      "UPDATE payment_attempts SET provider_session_id=$2 WHERE id=$1 AND (provider_session_id IS NULL OR provider_session_id=$2)",
      [attempt.id, session.id],
    );
    if (!session.url)
      throw new ServiceUnavailableException("Payment checkout is unavailable");
    return { url: session.url, attempt_id: attempt.id };
  }
  async webhook(body: Buffer, signature: string | undefined) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret)
      throw new ServiceUnavailableException(
        "Payment webhook is not configured",
      );
    if (!signature) throw new BadRequestException("Missing payment signature");
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(body, signature, secret);
    } catch {
      throw new BadRequestException("Invalid payment signature");
    }
    if (
      process.env.NODE_ENV === "production" &&
      process.env.PAYMENTS_MODE !== "live"
    )
      throw new ServiceUnavailableException(
        "Production payments require explicit live mode",
      );
    if (
      process.env.PAYMENTS_MODE &&
      event.livemode !== (process.env.PAYMENTS_MODE === "live")
    )
      throw new BadRequestException(
        "Payment event mode does not match this environment",
      );
    if (
      this.refundEvents &&
      ["refund.created", "refund.updated", "refund.failed"].includes(event.type)
    )
      return this.refundEvents(event);
    if (
      this.profileEvents &&
      [
        "setup_intent.succeeded",
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
      ].includes(event.type)
    )
      return this.profileEvents(event);
    return this.process(event);
  }
  async process(event: Stripe.Event, originalType: string = event.type) {
    const relevant = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
    ];
    if (!relevant.includes(event.type)) return { received: true };
    const session = event.data.object as Stripe.Checkout.Session;
    const attemptId = session.metadata?.corewaste_attempt_id;
    if (!attemptId || !z.uuid().safeParse(attemptId).success)
      return { received: true };
    const c = await this.ops.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "stripe-event:" + event.id,
      ]);
      if (
        (await c.query("SELECT 1 FROM provider_events WHERE id=$1", [event.id]))
          .rowCount
      ) {
        await c.query("COMMIT");
        return { received: true };
      }
      const initial = (
        await c.query("SELECT * FROM payment_attempts WHERE id=$1", [attemptId])
      ).rows[0];
      if (!initial) throw new ConflictException("Payment attempt not found");
      const invoice = (
        await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [
          initial.invoice_id,
        ])
      ).rows[0];
      const attempt = (
        await c.query("SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE", [
          attemptId,
        ])
      ).rows[0];
      if (
        attempt.provider_session_id &&
        attempt.provider_session_id !== session.id
      )
        throw new ConflictException(
          "Checkout session does not match payment attempt",
        );
      const succeeded =
        [
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
        ].includes(event.type) && session.payment_status === "paid";
      if (succeeded) {
        const amount = session.amount_total;
        if (
          typeof amount !== "number" ||
          session.currency !== "usd" ||
          amount !== attempt.amount_cents ||
          typeof session.payment_intent !== "string"
        )
          throw new BadRequestException(
            "Payment currency, amount or reference does not match",
          );
        const reference = session.payment_intent;
        const existing = (
          await c.query(
            "SELECT 1 FROM payments WHERE method='stripe' AND reference=$1 UNION ALL SELECT 1 FROM customer_credits WHERE source_reference=$1",
            [reference],
          )
        ).rowCount;
        if (!existing) {
          const balance = await invoiceBalance(c, invoice.id);
          if (invoice.status !== "void" && amount <= balance) {
            await this.finance.receive(
              c,
              invoice,
              amount,
              "stripe",
              reference,
              null,
            );
            await c.query(
              "UPDATE payment_attempts SET status='succeeded',provider_session_id=$2 WHERE id=$1",
              [attempt.id, session.id],
            );
          } else {
            // Actual captured funds are accounted for as a liability when an intervening payment changed the balance.
            const credit = (
              await c.query(
                "INSERT INTO customer_credits(customer_id,original_cents,remaining_cents,source_reference,reason) VALUES($1,$2,$2,$3,$4) RETURNING *",
                [
                  invoice.customer_id,
                  amount,
                  reference,
                  "Provider payment requires reconciliation because invoice balance changed",
                ],
              )
            ).rows[0];
            await c.query(
              "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id) VALUES('cash','customer_credit',$1,'credit_receipt',$2)",
              [credit.original_cents, credit.id],
            );
            await c.query(
              "UPDATE payment_attempts SET status='review',provider_session_id=$2 WHERE id=$1",
              [attempt.id, session.id],
            );
            await notify(
              c,
              invoice.customer_id,
              "payment_received",
              "Payment received as account credit",
              "Your payment was received and added as account credit for reconciliation.",
              "credit:" + credit.id,
            );
          }
        }
      } else if (
        event.type === "checkout.session.async_payment_failed" ||
        event.type === "checkout.session.expired"
      ) {
        if (!["succeeded", "review"].includes(attempt.status)) {
          await c.query(
            "UPDATE payment_attempts SET status=$2,provider_session_id=$3 WHERE id=$1",
            [
              attempt.id,
              event.type.endsWith("expired") ? "expired" : "failed",
              session.id,
            ],
          );
          if (event.type.endsWith("failed"))
            await notify(
              c,
              invoice.customer_id,
              "payment_failed",
              "Payment could not be completed",
              "Your bank payment failed. Your invoice balance remains due. Please review your payment details.",
              "payment-failed:" + attempt.id,
            );
        }
      }
      await c.query(
        "INSERT INTO provider_events(id,kind,object_id) VALUES($1,$2,$3)",
        [event.id, originalType, session.id],
      );
      await c.query("COMMIT");
      return { received: true };
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
}
