import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import {
  Actor,
  Operations,
  FINANCE,
  OFFICE,
  parse,
  permit,
  uuid,
} from "./domain";
import { notify } from "./notification-outbox";
export class MonthlyBilling {
  constructor(readonly ops: Operations) {}
  async invoice(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, FINANCE);
    parse(uuid, id);
    const b = parse(z.object({ period_start: z.iso.date() }).strict(), body);
    return this.ops.command(a, key, ["monthly.invoice", id, b], async (c) => {
      const agreement = (
        await c.query(
          "SELECT * FROM service_agreements WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!agreement || agreement.billing_mode !== "monthly")
        throw new NotFoundException("Monthly agreement not found");
      if (
        agreement.billing_alignment === "calendar" &&
        !b.period_start.endsWith("-01")
      )
        throw new BadRequestException(
          "Calendar billing periods begin on the first day of a month",
        );
      const prior = (
        await c.query(
          "SELECT i.* FROM invoices i JOIN monthly_billing_periods p ON p.id=i.monthly_period_id WHERE p.agreement_id=$1 AND p.period_start=$2",
          [id, b.period_start],
        )
      ).rows[0];
      if (prior) return prior;
      if (agreement.next_billing_month !== b.period_start)
        throw new ConflictException(
          "Bill the next unbilled contract period in order",
        );
      const dates = (
        await c.query(
          "SELECT contract_cycle_next($1::date,$4,$5,$2::date)-1 AS period_end,contract_cycle_next($1::date,$4,$5,$2::date) AS next_start,GREATEST($1::date,$2::date) AS active_from,LEAST(contract_cycle_next($1::date,$4,$5,$2::date)-1,COALESCE($3::date,'infinity'::date)) AS active_through,(now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
          [
            b.period_start,
            agreement.contract_start_date,
            agreement.contract_end_date,
            agreement.billing_alignment,
            agreement.billing_cycle_months,
          ],
        )
      ).rows[0];
      const advance = agreement.billing_timing === "advance";
      if (!advance && dates.period_end >= dates.today)
        throw new ConflictException(
          agreement.billing_alignment === "calendar" &&
            agreement.billing_cycle_months === 1
            ? "Monthly billing requires a fully closed calendar month"
            : "Contract billing requires a fully closed billing period",
        );
      if (advance && dates.today < dates.active_from)
        throw new ConflictException(
          "Advance billing starts when contract coverage begins",
        );
      if (dates.active_from > dates.active_through)
        throw new ConflictException(
          "The contract is not active in this period",
        );
      if (!advance && agreement.next_service_date <= dates.active_through)
        throw new ConflictException(
          "Generate all service occurrences for this period before billing",
        );
      const work = (
        await c.query(
          "SELECT * FROM orders WHERE agreement_id=$1 AND COALESCE(service_occurrence_date,scheduled_date) BETWEEN $2 AND $3 ORDER BY id FOR UPDATE",
          [id, dates.active_from, dates.active_through],
        )
      ).rows;
      if (
        !advance &&
        (!work.length || work.some((o) => o.status !== "completed"))
      )
        throw new ConflictException(
          "Review and complete all contracted service before monthly billing",
        );
      const days = (
        await c.query(
          "SELECT ($2::date-$1::date+1)::int AS active_days,($3::date-$4::date+1)::int AS month_days",
          [
            dates.active_from,
            dates.active_through,
            dates.period_end,
            b.period_start,
          ],
        )
      ).rows[0];
      const amount = Number(
        (BigInt(agreement.monthly_rate_cents) *
          BigInt(agreement.billing_cycle_months) *
          BigInt(days.active_days) +
          BigInt(Math.floor(days.month_days / 2))) /
          BigInt(days.month_days),
      );
      const period = (
        await c.query(
          "INSERT INTO monthly_billing_periods(agreement_id,period_start,period_end,active_from,active_through,amount_cents,billing_alignment,billing_cycle_months,full_period_cents,billing_timing) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            id,
            b.period_start,
            dates.period_end,
            dates.active_from,
            dates.active_through,
            amount,
            agreement.billing_alignment,
            agreement.billing_cycle_months,
            agreement.monthly_rate_cents * agreement.billing_cycle_months,
            agreement.billing_timing,
          ],
        )
      ).rows[0];
      const invoice = (
        await c.query(
          "INSERT INTO invoices(customer_id,monthly_period_id,amount_cents,status) VALUES($1,$2,$3,CASE WHEN $3::int=0 THEN 'paid' ELSE 'open' END) RETURNING *",
          [agreement.customer_id, period.id, amount],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO invoice_lines(invoice_id,description,amount_cents) VALUES($1,$2,$3)",
        [
          invoice.id,
          (advance ? "Reserved contract service (" : "Contracted service (") +
            agreement.billing_cycle_months +
            "-month " +
            agreement.billing_alignment +
            " cycle) " +
            dates.active_from +
            " through " +
            dates.active_through +
            " (" +
            days.active_days +
            "/" +
            days.month_days +
            " calendar days; " +
            (advance
              ? "service billed in advance"
              : work.length + " completed visits") +
            ")",
          amount,
        ],
      );
      if (amount > 0)
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,posting_date) VALUES($1,'accounts_receivable',$4,$2,$3)",
          [
            invoice.id,
            amount,
            advance ? dates.today : dates.period_end,
            advance ? "deferred_revenue" : "service_revenue",
          ],
        );
      for (const order of advance ? [] : work) {
        await c.query(
          "INSERT INTO monthly_invoice_orders(invoice_id,order_id) VALUES($1,$2)",
          [invoice.id, order.id],
        );
        await c.query(
          "UPDATE orders SET status='invoiced',version=version+1 WHERE id=$1",
          [order.id],
        );
        await this.ops.event(
          c,
          a,
          order.id,
          "invoiced",
          "Contract period invoice",
        );
      }
      await c.query(
        "UPDATE service_agreements SET next_billing_month=$2 WHERE id=$1",
        [id, dates.next_start],
      );
      await this.ops.audit(c, a, "monthly.invoiced", invoice.id, {
        agreement_id: id,
        period_start: b.period_start,
        active_days: days.active_days,
        month_days: days.month_days,
        order_ids: work.map((o) => o.id),
      });
      await notify(
        c,
        agreement.customer_id,
        "invoice_generated",
        "Your contract invoice is ready",
        "Invoice " +
          invoice.number +
          " for " +
          dates.active_from +
          " through " +
          dates.active_through +
          " is available in your customer portal.",
        "invoice:" + invoice.id,
      );
      return invoice;
    });
  }
  async end(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          end_date: z.iso.date(),
          version: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["agreement.end", id, b], async (c) => {
      const agreement = (
        await c.query(
          "SELECT * FROM service_agreements WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!agreement) throw new NotFoundException();
      if (agreement.version !== b.version)
        throw new ConflictException(
          "Agreement changed; reload before changing its end date",
        );
      if (
        agreement.contract_end_date &&
        b.end_date > agreement.contract_end_date
      )
        throw new ConflictException(
          "A shortened agreement cannot be extended; create a reviewed replacement agreement",
        );
      const today = (
        await c.query(
          "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
        )
      ).rows[0].today;
      if (
        b.end_date < today ||
        (agreement.contract_start_date &&
          b.end_date < agreement.contract_start_date)
      )
        throw new BadRequestException(
          "End date must be today or later and cannot precede the contract start",
        );
      const prepaid = (
        await c.query(
          "SELECT p.*,COALESCE((SELECT sum(CASE WHEN j.credit_account='deferred_revenue' THEN j.amount_cents ELSE 0 END-CASE WHEN j.debit_account='deferred_revenue' THEN j.amount_cents ELSE 0 END) FROM journal j WHERE j.invoice_id=i.id),0)::bigint AS remaining_contract_cents FROM monthly_billing_periods p JOIN invoices i ON i.monthly_period_id=p.id WHERE p.agreement_id=$1 AND p.billing_timing='advance' AND p.active_through>$2 ORDER BY p.period_start",
          [id, b.end_date],
        )
      ).rows;
      for (const period of prepaid) {
        const days = (
          await c.query(
            "SELECT GREATEST(0,LEAST($2::date,$3::date)-$1::date+1)::int AS active_days,($4::date-$5::date+1)::int AS period_days",
            [
              period.active_from,
              b.end_date,
              period.active_through,
              period.period_end,
              period.period_start,
            ],
          )
        ).rows[0];
        const revised = Number(
          (BigInt(period.full_period_cents) * BigInt(days.active_days) +
            BigInt(Math.floor(days.period_days / 2))) /
            BigInt(days.period_days),
        );
        if (Number(period.remaining_contract_cents) > revised)
          throw new ConflictException(
            "Finance must credit prepaid coverage beyond the new end date before shortening this contract",
          );
      }
      const later = (
        await c.query(
          "SELECT o.* FROM orders o WHERE agreement_id=$1 AND COALESCE(service_occurrence_date,scheduled_date)>$2 ORDER BY id FOR UPDATE",
          [id, b.end_date],
        )
      ).rows;
      if (
        later.some((o) =>
          ["in_progress", "completed", "invoiced"].includes(o.status),
        )
      )
        throw new ConflictException(
          "Later service has already started; review it before ending the agreement",
        );
      if (
        later.length &&
        (
          await c.query(
            "SELECT 1 FROM route_stops WHERE order_id=ANY($1::uuid[])",
            [later.map((o) => o.id)],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Remove later stops from their routes before ending the agreement",
        );
      for (const order of later.filter((o) => o.status !== "cancelled")) {
        await c.query(
          "UPDATE orders SET status='cancelled',version=version+1 WHERE id=$1",
          [order.id],
        );
        await this.ops.event(c, a, order.id, "cancelled", b.reason);
      }
      const updated = (
        await c.query(
          "UPDATE service_agreements SET contract_end_date=$2,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.end_date],
        )
      ).rows[0];
      await this.ops.audit(c, a, "agreement.end_date_changed", id, b);
      await notify(
        c,
        agreement.customer_id,
        "service_changed",
        "Your recurring service has changed",
        "Your recurring service agreement ends on " +
          b.end_date +
          ". Contact the office with questions.",
        "agreement-end:" + id + ":" + updated.version,
      );
      return updated;
    });
  }
  async pendingRecognition(a: Actor) {
    permit(a, FINANCE);
    return (
      await this.ops.pool.query(
        "SELECT p.*,i.id AS invoice_id,i.number AS invoice_number,a.customer_id,c.name AS customer_name FROM monthly_billing_periods p JOIN service_agreements a ON a.id=p.agreement_id JOIN customers c ON c.id=a.customer_id JOIN invoices i ON i.monthly_period_id=p.id LEFT JOIN contract_revenue_recognitions r ON r.period_id=p.id WHERE p.billing_timing='advance' AND r.id IS NULL AND p.period_end<(now() AT TIME ZONE (SELECT timezone FROM company_settings WHERE singleton))::date ORDER BY p.period_end,p.id LIMIT 500",
      )
    ).rows;
  }
  async recognize(a: Actor, key: string | undefined, id: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    return this.ops.command(a, key, ["contract.recognize", id], async (c) => {
      const period = (
        await c.query("SELECT * FROM monthly_billing_periods WHERE id=$1", [id])
      ).rows[0];
      if (!period || period.billing_timing !== "advance")
        throw new NotFoundException("Prepaid contract period not found");
      const agreement = (
        await c.query(
          "SELECT * FROM service_agreements WHERE id=$1 FOR UPDATE",
          [period.agreement_id],
        )
      ).rows[0];
      const invoice = (
        await c.query(
          "SELECT * FROM invoices WHERE monthly_period_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      const prior = (
        await c.query(
          "SELECT * FROM contract_revenue_recognitions WHERE period_id=$1",
          [id],
        )
      ).rows[0];
      if (prior) return prior;
      const dates = (
        await c.query(
          "SELECT (now() AT TIME ZONE timezone)::date AS today,LEAST($1::date,COALESCE($2::date,'infinity'::date)) AS through FROM company_settings WHERE singleton",
          [period.active_through, agreement.contract_end_date],
        )
      ).rows[0];
      if (period.period_end >= dates.today)
        throw new ConflictException(
          "Revenue recognition requires a fully closed billing period",
        );
      const deferred = Number(
        (
          await c.query(
            "SELECT COALESCE(sum(CASE WHEN credit_account='deferred_revenue' THEN amount_cents ELSE 0 END-CASE WHEN debit_account='deferred_revenue' THEN amount_cents ELSE 0 END),0)::bigint AS amount FROM journal WHERE invoice_id=$1",
            [invoice.id],
          )
        ).rows[0].amount,
      );
      if (deferred < 0 || deferred > period.amount_cents)
        throw new ConflictException(
          "Prepaid balance does not reconcile; review its journal",
        );
      const work =
        dates.through < period.active_from
          ? []
          : (
              await c.query(
                "SELECT * FROM orders WHERE agreement_id=$1 AND COALESCE(service_occurrence_date,scheduled_date) BETWEEN $2 AND $3 ORDER BY id FOR UPDATE",
                [agreement.id, period.active_from, dates.through],
              )
            ).rows;
      if (
        dates.through >= period.active_from &&
        (agreement.next_service_date <= dates.through ||
          !work.length ||
          work.some((o) => o.status !== "completed"))
      )
        throw new ConflictException(
          "Generate and complete every covered service before recognizing prepaid revenue",
        );
      if (dates.through < period.active_from && deferred !== 0)
        throw new ConflictException(
          "Fully cancelled coverage must be fully credited before closing",
        );
      const recognition = (
        await c.query(
          "INSERT INTO contract_revenue_recognitions(period_id,invoice_id,amount_cents,credited_cents,active_through,posting_date,order_ids,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            id,
            invoice.id,
            deferred,
            period.amount_cents - deferred,
            dates.through,
            dates.today,
            work.map((o) => o.id),
            a.id,
          ],
        )
      ).rows[0];
      if (deferred > 0)
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id,posting_date) VALUES($1,'deferred_revenue','service_revenue',$2,'contract_revenue',$3,$4)",
          [invoice.id, deferred, recognition.id, dates.today],
        );
      for (const order of work) {
        await c.query(
          "INSERT INTO monthly_invoice_orders(invoice_id,order_id) VALUES($1,$2)",
          [invoice.id, order.id],
        );
        await c.query(
          "UPDATE orders SET status='invoiced',version=version+1 WHERE id=$1",
          [order.id],
        );
        await this.ops.event(
          c,
          a,
          order.id,
          "invoiced",
          "Verified prepaid contract service",
        );
      }
      await this.ops.audit(
        c,
        a,
        "contract.revenue_recognized",
        recognition.id,
        {
          period_id: id,
          invoice_id: invoice.id,
          amount_cents: deferred,
          order_ids: work.map((o) => o.id),
        },
      );
      return recognition;
    });
  }
  async due(a: Actor) {
    permit(a, FINANCE);
    return (
      await this.ops.pool.query(
        "SELECT a.*,c.name AS customer_name,contract_cycle_next(a.next_billing_month,a.billing_alignment,a.billing_cycle_months,a.contract_start_date)-1 AS billing_period_end FROM service_agreements a JOIN customers c ON c.id=a.customer_id WHERE a.billing_mode='monthly' AND ((a.billing_timing='arrears' AND contract_cycle_next(a.next_billing_month,a.billing_alignment,a.billing_cycle_months,a.contract_start_date)-1<(now() AT TIME ZONE (SELECT timezone FROM company_settings WHERE singleton))::date) OR (a.billing_timing='advance' AND GREATEST(a.next_billing_month,a.contract_start_date)<=(now() AT TIME ZONE (SELECT timezone FROM company_settings WHERE singleton))::date)) AND (a.contract_end_date IS NULL OR a.next_billing_month<=a.contract_end_date) ORDER BY next_billing_month,a.id LIMIT 500",
      )
    ).rows;
  }
}
