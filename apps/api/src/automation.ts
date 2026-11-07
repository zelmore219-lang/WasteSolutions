import { MonthlyBilling } from "./monthly-billing";
import { Rentals } from "./rentals";
import { Station } from "./station";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { Actor, Operations, parse, permit } from "./domain";
import { Workflows } from "./workflows";
import { BillingControls } from "./billing-controls";
import { StripeProfiles } from "./stripe-profiles";
export class Automation {
  constructor(
    readonly ops: Operations,
    private workflows: Workflows,
    private billing: BillingControls,
    private profiles: StripeProfiles,
  ) {}
  async history(a: Actor) {
    permit(a, ["owner", "manager", "accountant"]);
    return (
      await this.ops.pool.query(
        "SELECT * FROM automation_runs ORDER BY job_date DESC LIMIT 100",
      )
    ).rows;
  }
  async run(a: Actor, date: string) {
    permit(a, ["owner", "manager"]);
    parse(z.iso.date(), date);
    const lock = await this.ops.pool.connect();
    const lockName = "corewaste-automation:" + date;
    let held = false;
    try {
      held = (
        await lock.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",
          [lockName],
        )
      ).rows[0].held;
      if (!held)
        throw new ConflictException(
          "Automation for this business date is already running",
        );
      const run = (
        await lock.query(
          "INSERT INTO automation_runs(job_date,actor_id,status) VALUES($1,$2,'running') ON CONFLICT(job_date) DO UPDATE SET status='running',actor_id=$2,attempts=automation_runs.attempts+1,started_at=now(),completed_at=NULL RETURNING *",
          [date, a.id],
        )
      ).rows[0];
      const summary = {
        generated_orders: 0,
        service_invoices: 0,
        monthly_invoices: 0,
        contract_revenue_recognitions: 0,
        rental_invoices: 0,
        facility_invoices: 0,
        late_fees: 0,
        provider_attempts: 0,
        errors: [] as { record_id: string; stage: string }[],
      };
      try {
        for (let batch = 0; batch < 10000; batch++) {
          const result: any = await this.workflows.generate(
            a,
            "auto-generate-" + run.id + "-" + run.attempts + "-" + batch,
            { through_date: date },
          );
          summary.generated_orders += result.generated;
          if (!result.has_more) break;
          if (batch === 9999) throw Error("Generation batch limit reached");
        }
        const monthly = new MonthlyBilling(this.ops);
        for (const agreement of await monthly.due(a)) {
          let month = agreement.next_billing_month;
          for (let batch = 0; batch < 120; batch++) {
            if (
              (
                await this.ops.pool.query(
                  "SELECT CASE WHEN $6='advance' THEN GREATEST($1::date,$4::date)>$5::date ELSE contract_cycle_next($1,$2,$3,$4)-1 >= $5::date END AS open",
                  [
                    month,
                    agreement.billing_alignment,
                    agreement.billing_cycle_months,
                    agreement.contract_start_date,
                    date,
                    agreement.billing_timing,
                  ],
                )
              ).rows[0].open ||
              (agreement.contract_end_date &&
                month > agreement.contract_end_date)
            )
              break;
            try {
              await monthly.invoice(
                a,
                "auto-monthly-" + agreement.id + "-" + month,
                agreement.id,
                { period_start: month },
              );
              summary.monthly_invoices++;
              month = (
                await this.ops.pool.query(
                  "SELECT next_billing_month FROM service_agreements WHERE id=$1",
                  [agreement.id],
                )
              ).rows[0].next_billing_month;
            } catch {
              summary.errors.push({
                record_id: agreement.id,
                stage: "monthly_invoice",
              });
              break;
            }
          }
        }
        for (const period of await monthly.pendingRecognition(a)) {
          try {
            await monthly.recognize(
              a,
              "auto-contract-recognition-" + period.id,
              period.id,
            );
            summary.contract_revenue_recognitions++;
          } catch {
            summary.errors.push({
              record_id: period.id,
              stage: "contract_revenue_recognition",
            });
          }
        }
        const completed = (
          await this.ops.pool.query(
            "SELECT o.id FROM orders o LEFT JOIN rental_jobs j ON j.order_id=o.id LEFT JOIN service_agreements a ON a.id=o.agreement_id WHERE o.status='completed' AND j.order_id IS NULL AND COALESCE(a.billing_mode,'per_service')='per_service'  ORDER BY o.id",
          )
        ).rows;
        for (const o of completed)
          try {
            await this.ops.invoice(a, "auto-invoice-" + o.id, o.id);
            summary.service_invoices++;
          } catch {
            summary.errors.push({ record_id: o.id, stage: "service_invoice" });
          }
        const rentals = (
          await this.ops.pool.query(
            "SELECT r.id FROM rentals r WHERE r.status='collected' AND NOT EXISTS(SELECT 1 FROM rental_jobs j JOIN orders o ON o.id=j.order_id LEFT JOIN disposal_tickets t ON t.order_id=j.order_id WHERE j.rental_id=r.id AND j.action IN ('exchange','pickup') AND o.status='completed' AND t.id IS NULL) ORDER BY r.id",
          )
        ).rows;
        for (const r of rentals)
          try {
            await new Rentals(this.ops).invoice(
              a,
              "auto-rental-invoice-" + r.id,
              r.id,
            );
            summary.rental_invoices++;
          } catch {
            summary.errors.push({ record_id: r.id, stage: "rental_invoice" });
          }
        const facility = (
          await this.ops.pool.query(
            "SELECT id FROM scale_tickets WHERE status='weighed' ORDER BY id",
          )
        ).rows;
        for (const t of facility)
          try {
            await new Station(this.ops).invoice(
              a,
              "auto-facility-invoice-" + t.id,
              t.id,
            );
            summary.facility_invoices++;
          } catch {
            summary.errors.push({ record_id: t.id, stage: "facility_invoice" });
          }
        const open = (
          await this.ops.pool.query(
            "SELECT id FROM invoices WHERE status='open' AND due_date<=$1 ORDER BY id",
            [date],
          )
        ).rows;
        for (const i of open) {
          try {
            const fee: any = await this.billing.lateFee(
              a,
              "auto-late-" + i.id + "-" + date,
              i.id,
              date,
            );
            if (fee.applied) summary.late_fees++;
          } catch {
            summary.errors.push({ record_id: i.id, stage: "late_fee" });
          }
          if (process.env.STRIPE_SECRET_KEY)
            try {
              const result = await this.profiles.charge(a, i.id);
              if (result.attempted) summary.provider_attempts++;
            } catch {
              summary.errors.push({
                record_id: i.id,
                stage: "provider_attempt",
              });
            }
        }
        await lock.query(
          "UPDATE automation_runs SET status=$2,summary=$3,completed_at=now() WHERE id=$1",
          [
            run.id,
            summary.errors.length ? "failed" : "completed",
            JSON.stringify(summary),
          ],
        );
        return {
          ...run,
          status: summary.errors.length ? "failed" : "completed",
          summary,
        };
      } catch (error) {
        await lock.query(
          "UPDATE automation_runs SET status='failed',summary=$2,completed_at=now() WHERE id=$1",
          [run.id, JSON.stringify({ ...summary, interrupted: true })],
        );
        throw error;
      }
    } finally {
      if (held)
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          lockName,
        ]);
      lock.release();
    }
  }
  async today() {
    return (
      await this.ops.pool.query(
        "SELECT (now() AT TIME ZONE timezone)::date::text AS date FROM company_settings WHERE singleton",
      )
    ).rows[0].date as string;
  }
}
