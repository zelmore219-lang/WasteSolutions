import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import { Actor, Operations, FINANCE, parse, permit, uuid } from "./domain";
const positiveCents = z.number().int().positive().max(100000000);
// A backdated payment must not spend capacity released by a later reversal.
// Evaluate each business-date balance, grouping simultaneous postings before checking it.
export async function assertPayableHistory(c: PoolClient, expenseId: string) {
  const result = (
    await c.query(
      `WITH movements AS (
    SELECT payment_date AS date,amount_cents AS settled FROM expense_payments WHERE expense_id=$1
    UNION ALL SELECT credit_date,amount_cents FROM expense_credits WHERE expense_id=$1
    UNION ALL SELECT r.reversal_date,-p.amount_cents FROM expense_payment_reversals r JOIN expense_payments p ON p.id=r.payment_id WHERE p.expense_id=$1
  ), daily AS (SELECT date,sum(settled) AS settled FROM movements GROUP BY date), running AS (
    SELECT date,sum(settled) OVER(ORDER BY date) AS settled FROM daily
  ) SELECT 1 FROM running WHERE settled<0 OR settled>(SELECT amount_cents FROM expenses WHERE id=$1) LIMIT 1`,
      [expenseId],
    )
  ).rowCount;
  if (result)
    throw new ConflictException(
      "This posting would overpay the bill on a historical date; review the payment, credit and reversal dates",
    );
}
const reference = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(1).max(2000);
export class PayableAdjustments {
  constructor(readonly ops: Operations) {}
  async credit(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, FINANCE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          amount_cents: positiveCents,
          credit_date: z.iso.date(),
          reference,
          reason,
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["expense.credit", id, b], async (c) => {
      const expense = (
        await c.query("SELECT * FROM expenses WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!expense) throw new NotFoundException("Vendor bill not found");
      if (expense.payment_mode !== "payable")
        throw new ConflictException(
          "Credits apply to unpaid vendor bills; a paid receipt needs a separately reviewed vendor refund",
        );
      const today = (
        await c.query(
          "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
        )
      ).rows[0].today;
      if (b.credit_date < expense.expense_date || b.credit_date > today)
        throw new BadRequestException(
          "Credit date must fall between the bill date and today",
        );
      if (
        (
          await c.query("SELECT 1 FROM expense_credits WHERE reference=$1", [
            b.reference,
          ])
        ).rowCount
      )
        throw new ConflictException("Vendor credit reference already recorded");
      const balance = Number(
        (
          await c.query(
            "SELECT balance_cents FROM expense_balances WHERE id=$1",
            [id],
          )
        ).rows[0].balance_cents,
      );
      if (b.amount_cents > balance)
        throw new ConflictException(
          "Credit exceeds the unpaid bill balance; review prior payments before recording a vendor refund",
        );
      const credit = (
        await c.query(
          "INSERT INTO expense_credits(expense_id,amount_cents,credit_date,reference,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [id, b.amount_cents, b.credit_date, b.reference, b.reason, a.id],
        )
      ).rows[0];
      await assertPayableHistory(c, id);
      await c.query(
        "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id,posting_date) VALUES('accounts_payable',$1,$2,'expense_credit',$3,$4)",
        [
          "expense:" + expense.category,
          b.amount_cents,
          credit.id,
          b.credit_date,
        ],
      );
      await this.ops.audit(c, a, "expense.credited", id, {
        credit_id: credit.id,
        ...b,
      });
      return { ...credit, balance_cents: balance - b.amount_cents };
    });
  }
  async reversePayment(
    a: Actor,
    key: string | undefined,
    id: string,
    paymentId: string,
    body: unknown,
  ) {
    permit(a, FINANCE);
    parse(uuid, id);
    parse(uuid, paymentId);
    const b = parse(
      z.object({ reversal_date: z.iso.date(), reference, reason }).strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["expense.payment.reverse", id, paymentId, b],
      async (c) => {
        const expense = (
          await c.query("SELECT * FROM expenses WHERE id=$1 FOR UPDATE", [id])
        ).rows[0];
        if (!expense || expense.payment_mode !== "payable")
          throw new NotFoundException("Vendor bill not found");
        const payment = (
          await c.query(
            "SELECT * FROM expense_payments WHERE id=$1 AND expense_id=$2",
            [paymentId, id],
          )
        ).rows[0];
        if (!payment) throw new NotFoundException("Bill payment not found");
        if (
          (
            await c.query(
              "SELECT 1 FROM expense_payment_reversals WHERE payment_id=$1 OR reference=$2",
              [paymentId, b.reference],
            )
          ).rowCount
        )
          throw new ConflictException(
            "Payment reversal or reference already recorded; review the bill history",
          );
        const today = (
          await c.query(
            "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
          )
        ).rows[0].today;
        if (b.reversal_date < payment.payment_date || b.reversal_date > today)
          throw new BadRequestException(
            "Reversal date must fall between the original payment date and today",
          );
        const reversal = (
          await c.query(
            "INSERT INTO expense_payment_reversals(payment_id,reversal_date,reference,reason,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [paymentId, b.reversal_date, b.reference, b.reason, a.id],
          )
        ).rows[0];
        await assertPayableHistory(c, id);
        await c.query(
          "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id,posting_date) VALUES('cash','accounts_payable',$1,'expense_payment_reversal',$2,$3)",
          [payment.amount_cents, reversal.id, b.reversal_date],
        );
        await this.ops.audit(c, a, "expense.payment_reversed", id, {
          payment_id: paymentId,
          reversal_id: reversal.id,
          ...b,
        });
        const balance = Number(
          (
            await c.query(
              "SELECT balance_cents FROM expense_balances WHERE id=$1",
              [id],
            )
          ).rows[0].balance_cents,
        );
        return {
          ...reversal,
          amount_cents: payment.amount_cents,
          balance_cents: balance,
        };
      },
    );
  }
}
