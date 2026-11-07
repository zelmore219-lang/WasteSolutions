import {
  activeRefundStates,
  reservedCreditRefunds,
} from "./refund-reservations";
import { postAllocatedCredit } from "./service-fees";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { Actor, Operations, FINANCE, parse, permit, uuid } from "./domain";
import { invoiceBalance, notify, positiveCents } from "./finance";
export class BillingControls {
  constructor(readonly ops: Operations) {}
  async creditInvoice(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, FINANCE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          amount_cents: positiveCents,
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["invoice.credit", id, b], async (c) => {
      const i = (
        await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!i || i.status === "void")
        throw new NotFoundException("Active invoice not found");
      if (
        (
          await c.query(
            "SELECT 1 FROM stripe_refund_requests WHERE invoice_id=$1 AND state=ANY($2::text[]) LIMIT 1",
            [id, activeRefundStates],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Resolve pending provider refunds before issuing another invoice credit",
        );
      const net = Number(
        (
          await c.query(
            "SELECT net_amount_cents FROM invoice_balances WHERE id=$1",
            [id],
          )
        ).rows[0].net_amount_cents,
      );
      if (b.amount_cents > net)
        throw new ConflictException("Credit exceeds invoice net charges");
      const balance = await invoiceBalance(c, id),
        surplus = Math.max(0, b.amount_cents - balance);
      const adjustment = (
        await c.query(
          "INSERT INTO invoice_adjustments(invoice_id,kind,amount_cents,reason,actor_id) VALUES($1,'credit',$2,$3,$4) RETURNING *",
          [id, -b.amount_cents, b.reason, a.id],
        )
      ).rows[0];
      await postAllocatedCredit(c, id, b.amount_cents, adjustment.id, net);
      let creditId: string | null = null;
      if (surplus > 0) {
        const credit = (
          await c.query(
            "INSERT INTO customer_credits(customer_id,original_cents,remaining_cents,source_reference,reason) VALUES($1,$2,$2,$3,$4) RETURNING *",
            [
              i.customer_id,
              surplus,
              "invoice-credit:" + adjustment.id,
              b.reason,
            ],
          )
        ).rows[0];
        creditId = credit.id;
        const transfer = (
          await c.query(
            "INSERT INTO invoice_credit_transfers(invoice_id,adjustment_id,credit_id,amount_cents) VALUES($1,$2,$3,$4) RETURNING id",
            [id, adjustment.id, credit.id, surplus],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,'accounts_receivable','customer_credit',$2,'credit_transfer',$3)",
          [id, surplus, transfer.id],
        );
      }
      const remaining = await invoiceBalance(c, id);
      await c.query(
        "UPDATE invoices SET status=CASE WHEN $2=0 THEN 'paid' ELSE 'open' END WHERE id=$1",
        [id, remaining],
      );
      await this.ops.audit(c, a, "invoice.credited", id, {
        amount_cents: b.amount_cents,
        credit_id: creditId,
      });
      await notify(
        c,
        i.customer_id,
        "customer_credit",
        "Invoice credit recorded",
        "A credit of $" +
          (b.amount_cents / 100).toFixed(2) +
          " was recorded for invoice CW-" +
          i.number +
          ".",
        "credit-memo:" + adjustment.id,
      );
      return {
        adjustment,
        customer_id: i.customer_id,
        credit_id: creditId,
        balance_cents: remaining,
      };
    });
  }
  async refundCredit(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, FINANCE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          amount_cents: positiveCents,
          method: z.enum(["cash", "check"]),
          reference: z.string().trim().min(1).max(200),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["credit.refund", id, b], async (c) => {
      const credit = (
        await c.query("SELECT * FROM customer_credits WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!credit) throw new NotFoundException("Customer credit not found");
      if (
        b.amount_cents >
        credit.remaining_cents - (await reservedCreditRefunds(c, credit.id))
      )
        throw new ConflictException(
          "Refund exceeds unreserved account credit; review pending provider refunds",
        );
      const refund = (
        await c.query(
          "INSERT INTO customer_credit_refunds(credit_id,amount_cents,method,reference,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [id, b.amount_cents, b.method, b.reference, b.reason, a.id],
        )
      ).rows[0];
      await c.query(
        "UPDATE customer_credits SET remaining_cents=remaining_cents-$2 WHERE id=$1",
        [id, b.amount_cents],
      );
      await c.query(
        "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id) VALUES('customer_credit','cash',$1,'credit_refund',$2)",
        [b.amount_cents, refund.id],
      );
      await this.ops.audit(c, a, "customer_credit.refunded", id, {
        refund_id: refund.id,
      });
      return refund;
    });
  }
  async lateFee(a: Actor, key: string | undefined, id: string, date: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    parse(z.iso.date(), date);
    return this.ops.command(
      a,
      key,
      ["invoice.late_fee", id, date],
      async (c) => {
        const settings = (
          await c.query(
            "SELECT late_fee_cents,late_fee_grace_days FROM company_settings WHERE singleton",
          )
        ).rows[0];
        if (settings.late_fee_cents === 0) return { applied: false };
        const i = (
          await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [id])
        ).rows[0];
        if (!i || i.status !== "open" || (await invoiceBalance(c, id)) <= 0)
          return { applied: false };
        if (
          (
            await c.query(
              "SELECT 1 FROM invoice_adjustments WHERE invoice_id=$1 AND kind='late_fee'",
              [id],
            )
          ).rowCount
        )
          return { applied: false };
        if (
          !(
            await c.query("SELECT 1 WHERE $1::date>$2::date+$3::int", [
              date,
              i.due_date,
              settings.late_fee_grace_days,
            ])
          ).rowCount
        )
          return { applied: false };
        const adjustment = (
          await c.query(
            "INSERT INTO invoice_adjustments(invoice_id,kind,amount_cents,reason,actor_id) VALUES($1,'late_fee',$2,'Configured overdue invoice fee',$3) RETURNING *",
            [id, settings.late_fee_cents, a.id],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,'accounts_receivable','fee_revenue',$2,'late_fee',$3)",
          [id, settings.late_fee_cents, adjustment.id],
        );
        await this.ops.audit(c, a, "invoice.late_fee_applied", id);
        await notify(
          c,
          i.customer_id,
          "overdue_invoice",
          "Invoice overdue",
          "A configured late fee of $" +
            (settings.late_fee_cents / 100).toFixed(2) +
            " was applied to invoice CW-" +
            i.number +
            ".",
          "late-fee:" + id,
        );
        return {
          applied: true,
          customer_id: i.customer_id,
          amount_cents: settings.late_fee_cents,
        };
      },
    );
  }
}
