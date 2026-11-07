import { reservedCreditRefunds } from "./refund-reservations";
import { assertPayableHistory } from "./payable-adjustments";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PoolClient } from "pg";
import { z } from "zod";
import {
  Actor,
  Operations,
  OFFICE,
  FINANCE,
  parse,
  permit,
  uuid,
} from "./domain";
export const positiveCents = z.number().int().positive().max(100000000);
export async function invoiceBalance(c: PoolClient, id: string) {
  return Number(
    (
      await c.query(
        "SELECT balance_cents AS balance FROM invoice_balances WHERE id=$1",
        [id],
      )
    ).rows[0].balance,
  );
}
export { notify } from "./notification-outbox";
import { notify } from "./notification-outbox";
export class Finance {
  constructor(readonly ops: Operations) {}
  async detail(a: Actor, id: string) {
    permit(a, [...OFFICE, ...FINANCE, "customer"]);
    parse(uuid, id);
    const i = (
      await this.ops.pool.query(
        "SELECT i.*,c.name AS customer_name FROM invoice_balances i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND ($2::uuid IS NULL OR i.customer_id=$2)",
        [id, a.role === "customer" ? a.customer_id : null],
      )
    ).rows[0];
    if (!i) throw new NotFoundException("Invoice not found");
    return {
      ...i,
      lines: (
        await this.ops.pool.query(
          "SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id",
          [id],
        )
      ).rows,
      adjustments: (
        await this.ops.pool.query(
          "SELECT * FROM invoice_adjustments WHERE invoice_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows,
      payments: (
        await this.ops.pool.query(
          "SELECT p.*,(COALESCE((SELECT sum(amount_cents) FROM refunds WHERE payment_id=p.id),0)+COALESCE((SELECT sum(amount_cents) FROM stripe_refund_requests WHERE payment_id=p.id AND credit_id IS NOT NULL AND state='succeeded'),0))::int AS refunded_cents FROM payments p WHERE invoice_id=$1 ORDER BY paid_at",
          [id],
        )
      ).rows,
    };
  }
  async receive(
    c: PoolClient,
    invoice: any,
    amount: number,
    method: string,
    reference: string,
    actorId: string | null,
    debitAccount = "cash",
  ) {
    if (invoice.status === "void")
      throw new ConflictException("Invoice is void");
    const duplicate = (
      await c.query("SELECT * FROM payments WHERE method=$1 AND reference=$2", [
        method,
        reference,
      ])
    ).rows[0];
    if (duplicate) {
      if (
        duplicate.invoice_id !== invoice.id ||
        duplicate.amount_cents !== amount
      )
        throw new ConflictException(
          "Payment reference already belongs to another transaction",
        );
      return duplicate;
    }
    const balance = await invoiceBalance(c, invoice.id);
    if (amount > balance)
      throw new ConflictException("Payment exceeds remaining invoice balance");
    const payment = (
      await c.query(
        "INSERT INTO payments(invoice_id,customer_id,amount_cents,method,reference,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [invoice.id, invoice.customer_id, amount, method, reference, actorId],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,$4,'accounts_receivable',$2,'payment',$3)",
      [invoice.id, amount, payment.id, debitAccount],
    );
    await c.query(
      "UPDATE invoices SET status=CASE WHEN $2=0 THEN 'paid' ELSE 'open' END WHERE id=$1",
      [invoice.id, balance - amount],
    );
    await notify(
      c,
      invoice.customer_id,
      "payment_received",
      "Payment received",
      `We received $${(amount / 100).toFixed(2)} for invoice CW-${invoice.number}.`,
      "payment:" + payment.id,
    );
    return payment;
  }
  async payment(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, FINANCE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          amount_cents: positiveCents,
          method: z.enum(["cash", "check"]),
          reference: z.string().trim().min(1).max(200),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["payment", id, b], async (c) => {
      const i = (
        await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!i) throw new NotFoundException("Invoice not found");
      const payment = await this.receive(
        c,
        i,
        b.amount_cents,
        b.method,
        b.reference,
        a.id,
      );
      await this.ops.audit(c, a, "payment.recorded", payment.id);
      return payment;
    });
  }
  async refund(
    a: Actor,
    key: string | undefined,
    paymentId: string,
    body: unknown,
  ) {
    permit(a, FINANCE);
    parse(uuid, paymentId);
    const b = parse(
      z
        .object({
          amount_cents: positiveCents,
          reason: z.string().trim().min(1).max(2000),
          reference: z.string().trim().min(1).max(200),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["refund", paymentId, b], async (c) => {
      const p = (
        await c.query("SELECT * FROM payments WHERE id=$1", [paymentId])
      ).rows[0];
      if (!p) throw new NotFoundException("Payment not found");
      if (["stripe", "credit"].includes(p.method))
        throw new BadRequestException(
          "Provider refunds must be requested through the payment provider integration",
        );
      await c.query("SELECT id FROM invoices WHERE id=$1 FOR UPDATE", [
        p.invoice_id,
      ]);
      if (
        (
          await c.query(
            "SELECT 1 FROM invoice_credit_transfers WHERE invoice_id=$1",
            [p.invoice_id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "This receipt funded account credit; record the refund against the available customer credit instead",
        );
      const refunded = Number(
        (
          await c.query(
            "SELECT COALESCE(sum(amount_cents),0) AS total FROM refunds WHERE payment_id=$1",
            [paymentId],
          )
        ).rows[0].total,
      );
      if (b.amount_cents > p.amount_cents - refunded)
        throw new ConflictException("Refund exceeds unrefunded payment");
      const refund = (
        await c.query(
          "INSERT INTO refunds(payment_id,amount_cents,reason,reference,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [paymentId, b.amount_cents, b.reason, b.reference, a.id],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,'accounts_receivable','cash',$2,'refund',$3)",
        [p.invoice_id, b.amount_cents, refund.id],
      );
      await c.query("UPDATE invoices SET status='open' WHERE id=$1", [
        p.invoice_id,
      ]);
      await this.ops.audit(c, a, "refund.recorded", refund.id, b);
      return refund;
    });
  }
  async expenses(a: Actor) {
    permit(a, FINANCE);
    return (
      await this.ops.pool.query(
        "SELECT e.*,t.number AS truck_number FROM expense_balances e LEFT JOIN trucks t ON t.id=e.truck_id ORDER BY expense_date DESC LIMIT 500",
      )
    ).rows;
  }
  async expense(a: Actor, key: string | undefined, body: unknown) {
    permit(a, FINANCE);
    const b = parse(
      z
        .object({
          category: z.enum([
            "fuel",
            "repair",
            "maintenance",
            "disposal",
            "office",
            "other",
          ]),
          vendor: z.string().trim().min(1).max(200),
          amount_cents: positiveCents,
          expense_date: z.iso.date(),
          payment_mode: z.enum(["paid", "payable"]).default("paid"),
          due_date: z.iso.date().optional(),
          truck_id: uuid.optional(),
          order_id: uuid.optional(),
          route_id: uuid.optional(),
          reference: z.string().trim().min(1).max(200),
        })
        .strict(),
      body,
    );
    if (b.order_id && b.route_id)
      throw new BadRequestException(
        "Attribute an expense to one service order or one route, not both",
      );
    if (
      (b.payment_mode === "payable") !== Boolean(b.due_date) ||
      (b.due_date && b.due_date < b.expense_date)
    )
      throw new BadRequestException(
        "Unpaid bills require a due date on or after the expense date; paid receipts have no due date",
      );
    return this.ops.command(a, key, ["expense", b], async (c) => {
      const today = (
        await c.query(
          "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings",
        )
      ).rows[0].today;
      if (b.expense_date > today)
        throw new BadRequestException("Expense date cannot be in the future");
      if (b.order_id) {
        const order = (
          await c.query("SELECT * FROM orders WHERE id=$1 FOR SHARE", [
            b.order_id,
          ])
        ).rows[0];
        if (!order || order.status === "cancelled")
          throw new BadRequestException(
            "Choose an existing non-cancelled service order for expense attribution",
          );
        if (b.truck_id && order.truck_id && b.truck_id !== order.truck_id)
          throw new BadRequestException(
            "Expense truck does not match the service order",
          );
      }
      if (b.route_id) {
        const route = (
          await c.query("SELECT * FROM routes WHERE id=$1 FOR SHARE", [
            b.route_id,
          ])
        ).rows[0];
        if (!route || route.archived)
          throw new BadRequestException(
            "Choose an existing active route for expense attribution",
          );
        if (b.truck_id && b.truck_id !== route.truck_id)
          throw new BadRequestException(
            "Expense truck does not match the route",
          );
      }
      const e = (
        await c.query(
          "INSERT INTO expenses(category,vendor,amount_cents,expense_date,truck_id,reference,actor_id,payment_mode,due_date,order_id,route_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            b.category,
            b.vendor,
            b.amount_cents,
            b.expense_date,
            b.truck_id || null,
            b.reference,
            a.id,
            b.payment_mode,
            b.due_date || null,
            b.order_id || null,
            b.route_id || null,
          ],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id,posting_date) VALUES($1,$4,$2,'expense',$3,$5)",
        [
          "expense:" + b.category,
          b.amount_cents,
          e.id,
          b.payment_mode === "payable" ? "accounts_payable" : "cash",
          b.expense_date,
        ],
      );
      await this.ops.audit(c, a, "expense.recorded", e.id);
      return e;
    });
  }
  async expensePayment(
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
          reference: z.string().trim().min(1).max(200),
          method: z.enum(["cash", "check", "bank_transfer"]),
          payment_date: z.iso.date(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["expense.payment", id, b], async (c) => {
      const expense = (
        await c.query("SELECT * FROM expenses WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!expense) throw new NotFoundException("Expense not found");
      if (expense.payment_mode !== "payable")
        throw new ConflictException(
          "This receipt was already recorded as paid",
        );
      const today = (
        await c.query(
          "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings",
        )
      ).rows[0].today;
      if (b.payment_date < expense.expense_date || b.payment_date > today)
        throw new BadRequestException(
          "Payment date must fall between the expense date and today",
        );
      const duplicate = (
        await c.query("SELECT * FROM expense_payments WHERE reference=$1", [
          b.reference,
        ])
      ).rows[0];
      if (duplicate)
        throw new ConflictException(
          "Payment reference already recorded; review the bill history",
        );
      const balance = Number(
        (
          await c.query(
            "SELECT balance_cents FROM expense_balances WHERE id=$1",
            [id],
          )
        ).rows[0].balance_cents,
      );
      if (b.amount_cents > balance)
        throw new ConflictException("Payment exceeds the unpaid bill balance");
      const payment = (
        await c.query(
          "INSERT INTO expense_payments(expense_id,amount_cents,reference,actor_id,method,payment_date) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [id, b.amount_cents, b.reference, a.id, b.method, b.payment_date],
        )
      ).rows[0];
      await assertPayableHistory(c, id);
      await c.query(
        "INSERT INTO journal(debit_account,credit_account,amount_cents,source_kind,source_id,posting_date) VALUES('accounts_payable','cash',$1,'expense_payment',$2,$3)",
        [b.amount_cents, payment.id, b.payment_date],
      );
      await this.ops.audit(c, a, "expense.payment_recorded", id, {
        payment_id: payment.id,
        ...b,
      });
      return { ...payment, balance_cents: balance - b.amount_cents };
    });
  }
  async expenseHistory(a: Actor, id: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    const expense = (
      await this.ops.pool.query("SELECT * FROM expense_balances WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (!expense) throw new NotFoundException("Expense not found");
    return {
      ...expense,
      payments: (
        await this.ops.pool.query(
          "SELECT p.*,r.id AS reversal_id,r.reversal_date,r.reference AS reversal_reference,r.reason AS reversal_reason FROM expense_payments p LEFT JOIN expense_payment_reversals r ON r.payment_id=p.id WHERE p.expense_id=$1 ORDER BY p.payment_date,p.paid_at,p.id",
          [id],
        )
      ).rows,
      credits: (
        await this.ops.pool.query(
          "SELECT * FROM expense_credits WHERE expense_id=$1 ORDER BY credit_date,created_at,id",
          [id],
        )
      ).rows,
    };
  }
  async statement(a: Actor, customerId: string) {
    permit(a, [...OFFICE, ...FINANCE, "customer"]);
    parse(uuid, customerId);
    if (a.role === "customer" && a.customer_id !== customerId)
      throw new ForbiddenException();
    return (
      await this.ops.pool.query(
        `SELECT i.* FROM invoice_balances i WHERE customer_id=$1 AND status<>'void' ORDER BY created_at`,
        [customerId],
      )
    ).rows;
  }
  async credits(a: Actor) {
    permit(a, [...FINANCE, "customer"]);
    return (
      await this.ops.pool.query(
        "SELECT cr.*,c.name AS customer_name FROM customer_credits cr JOIN customers c ON c.id=cr.customer_id WHERE ($1::uuid IS NULL OR cr.customer_id=$1) ORDER BY cr.created_at DESC LIMIT 500",
        [a.role === "customer" ? a.customer_id : null],
      )
    ).rows;
  }
  async applyCredit(
    a: Actor,
    key: string | undefined,
    id: string,
    body: unknown,
  ) {
    permit(a, FINANCE);
    parse(uuid, id);
    const b = parse(
      z.object({ invoice_id: uuid, amount_cents: positiveCents }).strict(),
      body,
    );
    return this.ops.command(a, key, ["credit.apply", id, b], async (c) => {
      const i = (
        await c.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [
          b.invoice_id,
        ])
      ).rows[0];
      if (!i) throw new NotFoundException("Invoice not found");
      const cr = (
        await c.query("SELECT * FROM customer_credits WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!cr || cr.customer_id !== i.customer_id)
        throw new BadRequestException("Matching customer credit required");
      if (
        b.amount_cents >
        cr.remaining_cents - (await reservedCreditRefunds(c, cr.id))
      )
        throw new ConflictException(
          "Insufficient unreserved customer credit; review pending provider refunds",
        );
      const p = await this.receive(
        c,
        i,
        b.amount_cents,
        "credit",
        id + ":" + key,
        a.id,
        "customer_credit",
      );
      await c.query(
        "UPDATE customer_credits SET remaining_cents=remaining_cents-$2 WHERE id=$1",
        [id, b.amount_cents],
      );
      await this.ops.audit(c, a, "credit.applied", id, { payment_id: p.id });
      return p;
    });
  }
  async notifications(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE, "customer"]);
    return (
      await this.ops.pool.query(
        "SELECT * FROM notifications WHERE ($1::uuid IS NULL OR customer_id=$1) ORDER BY created_at DESC LIMIT 200",
        [a.role === "customer" ? a.customer_id : null],
      )
    ).rows;
  }
  async markRead(a: Actor, key: string | undefined, id: string) {
    parse(uuid, id);
    permit(a, ["customer"]);
    return this.ops.command(a, key, ["notification.read", id], async (c) => {
      const n = (
        await c.query(
          "UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND customer_id=$2 RETURNING *",
          [id, a.customer_id],
        )
      ).rows[0];
      if (!n) throw new NotFoundException();
      return n;
    });
  }
}
