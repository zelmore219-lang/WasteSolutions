import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import Stripe from "stripe";
import { z } from "zod";
import { Actor, Operations, FINANCE, parse, permit, uuid } from "./domain";
import { invoiceBalance, notify, positiveCents } from "./finance";
import { stripeClient, paymentReturnOrigin } from "./payment-runtime";
export class StripeProfiles {
  constructor(
    readonly ops: Operations,
    private settle: (
      event: Stripe.Event,
      originalType?: string,
    ) => Promise<unknown>,
  ) {}
  async profile(a: Actor) {
    permit(a, ["customer"]);
    return (
      (
        await this.ops.pool.query(
          "SELECT autopay_enabled,max_charge_cents,consent_at,(default_payment_method_id IS NOT NULL) AS method_saved FROM stripe_profiles WHERE customer_id=$1",
          [a.customer_id],
        )
      ).rows[0] || {
        autopay_enabled: false,
        method_saved: false,
        max_charge_cents: 100000,
      }
    );
  }
  async setup(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["customer"]);
    const b = parse(
        z
          .object({
            enable_autopay: z.boolean(),
            max_charge_cents: positiveCents,
            consent: z.literal(true),
          })
          .strict(),
        body,
      ),
      stripe = stripeClient(),
      origin = paymentReturnOrigin();
    const existingProfile = (
      await this.ops.pool.query(
        "SELECT provider_customer_id FROM stripe_profiles WHERE customer_id=$1",
        [a.customer_id],
      )
    ).rows[0];
    const providerCustomer = existingProfile
      ? { id: existingProfile.provider_customer_id }
      : await stripe.customers.create(
          { metadata: { corewaste_customer_id: a.customer_id! } },
          { idempotencyKey: "corewaste-customer-" + a.customer_id },
        );
    const request: any = await this.ops.command(
      a,
      key,
      ["payment.setup", b],
      async (c) => {
        await c.query(
          "INSERT INTO stripe_profiles(customer_id,provider_customer_id) VALUES($1,$2) ON CONFLICT(customer_id) DO NOTHING",
          [a.customer_id, providerCustomer.id],
        );
        const profile = (
          await c.query(
            "SELECT * FROM stripe_profiles WHERE customer_id=$1 FOR UPDATE",
            [a.customer_id],
          )
        ).rows[0];
        if (profile.provider_customer_id !== providerCustomer.id)
          throw new ConflictException(
            "Provider customer identity does not match",
          );
        const version = profile.settings_version + 1;
        await c.query(
          "UPDATE stripe_profiles SET settings_version=$2 WHERE customer_id=$1",
          [a.customer_id, version],
        );
        return (
          await c.query(
            "INSERT INTO payment_setup_requests(customer_id,actor_id,enable_autopay,max_charge_cents,settings_version) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [
              a.customer_id,
              a.id,
              b.enable_autopay,
              b.max_charge_cents,
              version,
            ],
          )
        ).rows[0];
      },
    );
    const session = await stripe.checkout.sessions.create(
      {
        mode: "setup",
        customer: providerCustomer.id,
        currency: "usd",
        allowed_payment_method_types: ["card", "us_bank_account"],
        setup_intent_data: {
          metadata: { corewaste_setup_request_id: request.id },
        },
        metadata: { corewaste_setup_request_id: request.id },
        success_url: origin + "/portal?payment_setup=processing",
        cancel_url: origin + "/portal?payment_setup=cancelled",
      },
      { idempotencyKey: "corewaste-setup-" + request.id },
    );
    await this.ops.pool.query(
      "UPDATE payment_setup_requests SET provider_session_id=$2 WHERE id=$1 AND (provider_session_id IS NULL OR provider_session_id=$2)",
      [request.id, session.id],
    );
    if (!session.url)
      throw new ConflictException("Payment setup is unavailable");
    return { url: session.url };
  }
  async settings(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["customer"]);
    const b = parse(
      z
        .object({
          enabled: z.boolean(),
          max_charge_cents: positiveCents,
          consent: z.boolean(),
        })
        .strict(),
      body,
    );
    if (b.enabled && !b.consent)
      throw new BadRequestException(
        "Explicit autopay authorization is required",
      );
    return this.ops.command(a, key, ["autopay.settings", b], async (c) => {
      const p = (
        await c.query(
          "SELECT * FROM stripe_profiles WHERE customer_id=$1 FOR UPDATE",
          [a.customer_id],
        )
      ).rows[0];
      if (!p || (b.enabled && !p.default_payment_method_id))
        throw new ConflictException(
          "Save a payment method through secure payment setup first",
        );
      await c.query(
        "UPDATE stripe_profiles SET autopay_enabled=$2,max_charge_cents=$3,consent_at=CASE WHEN $2 THEN now() ELSE consent_at END,consent_actor_id=$4,consent_version=$5,settings_version=settings_version+1 WHERE customer_id=$1",
        [
          a.customer_id,
          b.enabled,
          b.max_charge_cents,
          a.id,
          b.enabled ? "autopay-v1" : p.consent_version,
        ],
      );
      await this.ops.audit(c, a, "autopay.settings_updated", a.customer_id!, {
        enabled: b.enabled,
        max_charge_cents: b.max_charge_cents,
      });
      return { customer_id: a.customer_id, autopay_enabled: b.enabled };
    });
  }
  async charge(a: Actor, invoiceId: string) {
    permit(a, FINANCE);
    parse(uuid, invoiceId);
    const eligible = (
      await this.ops.pool.query(
        "SELECT 1 FROM invoice_balances i JOIN stripe_profiles p ON p.customer_id=i.customer_id WHERE i.id=$1 AND i.status='open' AND i.balance_cents>0 AND p.autopay_enabled AND p.default_payment_method_id IS NOT NULL AND i.balance_cents<=p.max_charge_cents",
        [invoiceId],
      )
    ).rowCount;
    if (!eligible) return { attempted: false };
    const stripe = stripeClient();
    const attempt: any = await this.ops.command(
      a,
      "autopay-invoice-" + invoiceId,
      ["autopay.charge", invoiceId],
      async (c) => {
        const invoice = (
          await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [
            invoiceId,
          ])
        ).rows[0];
        if (!invoice || invoice.status !== "open")
          throw new ConflictException("Invoice changed before autopay");
        const balance = await invoiceBalance(c, invoiceId),
          profile = (
            await c.query(
              "SELECT * FROM stripe_profiles WHERE customer_id=$1 FOR SHARE",
              [invoice.customer_id],
            )
          ).rows[0];
        if (
          balance <= 0 ||
          !profile?.autopay_enabled ||
          !profile.default_payment_method_id ||
          balance > profile.max_charge_cents
        )
          throw new ConflictException(
            "Autopay settings changed before the attempt",
          );
        const old = (
          await c.query(
            "SELECT * FROM payment_attempts WHERE invoice_id=$1 AND source='autopay'",
            [invoiceId],
          )
        ).rows[0];
        if (old)
          return {
            ...old,
            provider_customer_id: profile.provider_customer_id,
            method_id: profile.default_payment_method_id,
          };
        const row = (
          await c.query(
            "INSERT INTO payment_attempts(invoice_id,amount_cents,source) VALUES($1,$2,'autopay') RETURNING *",
            [invoiceId, balance],
          )
        ).rows[0];
        return {
          ...row,
          provider_customer_id: profile.provider_customer_id,
          method_id: profile.default_payment_method_id,
        };
      },
    );
    if (attempt.skip || attempt.status !== "pending")
      return { attempted: false };
    const profile = (
      await this.ops.pool.query(
        "SELECT autopay_enabled FROM stripe_profiles WHERE provider_customer_id=$1",
        [attempt.provider_customer_id],
      )
    ).rows[0];
    if (!profile?.autopay_enabled) return { attempted: false };
    const intent = await stripe.paymentIntents.create(
      {
        amount: attempt.amount_cents,
        currency: "usd",
        customer: attempt.provider_customer_id,
        payment_method: attempt.method_id,
        off_session: true,
        confirm: true,
        metadata: { corewaste_attempt_id: attempt.id },
      },
      { idempotencyKey: "corewaste-autopay-" + attempt.id },
    );
    await this.ops.pool.query(
      "UPDATE payment_attempts SET provider_session_id=$2 WHERE id=$1 AND (provider_session_id IS NULL OR provider_session_id=$2)",
      [attempt.id, intent.id],
    );
    return { attempted: true, status: intent.status };
  }
  async event(event: Stripe.Event) {
    if (event.type === "setup_intent.succeeded") return this.setupEvent(event);
    if (
      !["payment_intent.succeeded", "payment_intent.payment_failed"].includes(
        event.type,
      )
    )
      return { received: true };
    const intent = event.data.object as Stripe.PaymentIntent,
      attemptId = intent.metadata?.corewaste_attempt_id;
    if (!attemptId || !z.uuid().safeParse(attemptId).success)
      return { received: true };
    const attempt = (
      await this.ops.pool.query(
        "SELECT * FROM payment_attempts WHERE id=$1 AND source='autopay'",
        [attemptId],
      )
    ).rows[0];
    if (!attempt) return { received: true };
    const success = event.type === "payment_intent.succeeded";
    const normalized = {
      ...event,
      type: success
        ? "checkout.session.async_payment_succeeded"
        : "checkout.session.async_payment_failed",
      data: {
        object: {
          id: intent.id,
          metadata: { corewaste_attempt_id: attempt.id },
          currency: intent.currency,
          amount_total: success ? intent.amount_received : intent.amount,
          payment_status: success ? "paid" : "unpaid",
          payment_intent: intent.id,
        },
      },
    } as unknown as Stripe.Event;
    return this.settle(normalized, event.type);
  }
  private async setupEvent(event: Stripe.Event) {
    const intent = event.data.object as Stripe.SetupIntent,
      id = intent.metadata?.corewaste_setup_request_id;
    if (!id || !z.uuid().safeParse(id).success) return { received: true };
    if (
      intent.status !== "succeeded" ||
      typeof intent.customer !== "string" ||
      typeof intent.payment_method !== "string"
    )
      throw new BadRequestException("Invalid completed payment setup");
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
      const request = (
        await c.query(
          "SELECT * FROM payment_setup_requests WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!request)
        throw new NotFoundException("Payment setup request not found");
      const profile = (
        await c.query(
          "SELECT * FROM stripe_profiles WHERE customer_id=$1 FOR UPDATE",
          [request.customer_id],
        )
      ).rows[0];
      if (!profile || profile.provider_customer_id !== intent.customer)
        throw new BadRequestException("Payment setup customer does not match");
      if (
        request.state === "pending" &&
        request.settings_version === profile.settings_version
      ) {
        await c.query(
          "UPDATE stripe_profiles SET default_payment_method_id=$2,autopay_enabled=$3,max_charge_cents=$4,consent_at=now(),consent_actor_id=$5,consent_version='autopay-v1' WHERE customer_id=$1",
          [
            request.customer_id,
            intent.payment_method,
            request.enable_autopay,
            request.max_charge_cents,
            request.actor_id,
          ],
        );
        await c.query(
          "UPDATE payment_setup_requests SET state='completed',completed_at=now() WHERE id=$1",
          [id],
        );
        await notify(
          c,
          request.customer_id,
          "payment_settings",
          "Payment settings updated",
          "Your secure payment method was saved. Autopay is " +
            (request.enable_autopay ? "enabled." : "disabled."),
          "payment-setup:" + id,
        );
      } else if (request.state === "pending")
        await c.query(
          "UPDATE payment_setup_requests SET state='cancelled',completed_at=now() WHERE id=$1",
          [id],
        );
      await c.query(
        "INSERT INTO provider_events(id,kind,object_id) VALUES($1,$2,$3)",
        [event.id, event.type, intent.id],
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
