import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { Actor, Operations, FINANCE, parse, permit } from "./domain";
export const reportNames = [
  "revenue",
  "legacy_transactions",
  "expenses",
  "material_stock",
  "accounts_payable",
  "profitability",
  "service_profitability",
  "route_profitability",
  "accounts_receivable",
  "customer_balances",
  "collections",
  "drivers",
  "routes",
  "fleet",
  "containers",
  "disposal_tonnage",
  "recycling",
  "customer_growth",
  "service_completion",
  "missed_pickups",
  "trial_balance",
] as const;
const contributionPostings = `WITH attributed AS (
 SELECT j.*,COALESCE(j.posting_date,(j.created_at AT TIME ZONE $3)::date) AS date,
   CASE WHEN i.rental_id IS NOT NULL THEN 'roll_off' WHEN i.scale_ticket_id IS NOT NULL THEN 'transfer_station' ELSE COALESCE(a.kind,oa.kind,o.kind,'unallocated') END AS revenue_service,
   ir.route_id AS revenue_route_id,
   COALESCE(e.route_id,es.route_id) AS expense_route_id,
   CASE WHEN ej.rental_id IS NOT NULL THEN 'roll_off' WHEN e.order_id IS NOT NULL THEN COALESCE(ea.kind,eo.kind) ELSE 'unallocated' END AS expense_service
 FROM journal j LEFT JOIN invoices i ON i.id=j.invoice_id
 LEFT JOIN orders o ON o.id=i.order_id
 LEFT JOIN service_agreements oa ON oa.id=o.agreement_id
 LEFT JOIN monthly_billing_periods bp ON bp.id=i.monthly_period_id
 LEFT JOIN service_agreements a ON a.id=bp.agreement_id
 LEFT JOIN LATERAL (
   SELECT CASE WHEN count(*)>0 AND count(rs.route_id)=count(*) AND count(DISTINCT rs.route_id)=1 THEN min(rs.route_id::text)::uuid ELSE NULL END AS route_id
   FROM (SELECT i.order_id AS id WHERE i.order_id IS NOT NULL UNION SELECT m.order_id FROM monthly_invoice_orders m WHERE m.invoice_id=i.id UNION SELECT rj.order_id FROM rental_jobs rj WHERE rj.rental_id=i.rental_id) linked
   LEFT JOIN route_stops rs ON rs.order_id=linked.id
 ) ir ON true
 LEFT JOIN expense_credits ec ON j.source_kind='expense_credit' AND ec.id=j.source_id
 LEFT JOIN expenses e ON e.id=CASE WHEN j.source_kind='expense' THEN j.source_id ELSE ec.expense_id END
 LEFT JOIN orders eo ON eo.id=e.order_id LEFT JOIN service_agreements ea ON ea.id=eo.agreement_id LEFT JOIN rental_jobs ej ON ej.order_id=eo.id
 LEFT JOIN route_stops es ON es.order_id=e.order_id
 ), revenue AS (
 SELECT *,CASE WHEN credit_account IN ('service_revenue','rental_revenue','facility_revenue','fee_revenue') THEN amount_cents ELSE 0 END-CASE WHEN debit_account IN ('service_revenue','rental_revenue','facility_revenue','fee_revenue') THEN amount_cents ELSE 0 END AS revenue_cents,
 CASE WHEN debit_account LIKE 'expense:%' THEN amount_cents ELSE 0 END-CASE WHEN credit_account LIKE 'expense:%' THEN amount_cents ELSE 0 END AS expense_cents FROM attributed WHERE date BETWEEN $1 AND $2
 )`;
const queries: Record<(typeof reportNames)[number], string> = {
  legacy_transactions: `SELECT t.transaction_date,t.source_system,t.source_reference,t.transaction_kind,c.name AS customer,t.vendor,t.amount_cents,t.currency,t.related_reference,t.memo,'source archive only; no ledger posting' AS accounting_treatment FROM legacy_transactions t JOIN import_batches b ON b.id=t.batch_id LEFT JOIN customers c ON c.id=t.customer_id WHERE b.status='applied' AND t.transaction_date BETWEEN $1 AND $2 AND $3::text IS NOT NULL ORDER BY t.transaction_date,t.source_system,t.source_reference,t.id`,
  service_profitability:
    contributionPostings +
    `, entries AS (SELECT revenue_service AS service,revenue_cents,0 AS expense_cents FROM revenue WHERE revenue_cents<>0 UNION ALL SELECT expense_service,0,expense_cents FROM revenue WHERE expense_cents<>0) SELECT service,sum(revenue_cents)::bigint AS revenue_cents,sum(expense_cents)::bigint AS expense_cents,(sum(revenue_cents)-sum(expense_cents))::bigint AS contribution_cents FROM entries GROUP BY service ORDER BY service`,
  route_profitability:
    contributionPostings +
    `, entries AS (SELECT revenue_route_id AS route_id,revenue_cents,0 AS expense_cents FROM revenue WHERE revenue_cents<>0 UNION ALL SELECT expense_route_id,0,expense_cents FROM revenue WHERE expense_cents<>0), totals AS (SELECT route_id,sum(revenue_cents)::bigint AS revenue_cents,sum(expense_cents)::bigint AS expense_cents FROM entries GROUP BY route_id) SELECT COALESCE(r.name,'Unallocated / mixed routes') AS route,r.service_date,t.revenue_cents,t.expense_cents,(t.revenue_cents-t.expense_cents)::bigint AS contribution_cents FROM totals t LEFT JOIN routes r ON r.id=t.route_id ORDER BY r.service_date NULLS LAST,r.name NULLS LAST,t.route_id`,
  material_stock: `SELECT a.site_name,m.name AS material,m.category,COALESCE(sum(s.delta_kg),0)::bigint AS stock_kg FROM material_stock_accounts a JOIN materials m ON m.id=a.material_id LEFT JOIN material_stock_movements s ON s.account_id=a.id AND (s.recorded_at AT TIME ZONE $3)::date<=$2::date WHERE (a.created_at AT TIME ZONE $3)::date<=$2::date AND $1::date IS NOT NULL GROUP BY a.id,m.id ORDER BY a.site_name,m.name,a.id`,
  accounts_payable: `SELECT e.expense_date,e.due_date,e.vendor,e.reference,e.amount_cents,COALESCE(cr.credited_cents,0)::bigint AS credited_cents,(e.amount_cents-COALESCE(p.paid_cents,0)-COALESCE(cr.credited_cents,0))::bigint AS balance_cents,GREATEST(0,$2::date-e.due_date)::int AS overdue_days FROM expenses e LEFT JOIN LATERAL (SELECT sum(p.amount_cents) AS paid_cents FROM expense_payments p WHERE p.expense_id=e.id AND p.payment_date<=$2::date AND NOT EXISTS(SELECT 1 FROM expense_payment_reversals r WHERE r.payment_id=p.id AND r.reversal_date<=$2::date)) p ON true LEFT JOIN LATERAL (SELECT sum(c.amount_cents) AS credited_cents FROM expense_credits c WHERE c.expense_id=e.id AND c.credit_date<=$2::date) cr ON true WHERE e.payment_mode='payable' AND e.expense_date<=$2::date AND e.amount_cents>COALESCE(p.paid_cents,0)+COALESCE(cr.credited_cents,0) AND $1::date IS NOT NULL AND $3::text IS NOT NULL ORDER BY e.due_date,e.vendor,e.id`,
  revenue:
    "WITH postings AS (SELECT COALESCE(posting_date,(created_at AT TIME ZONE $3)::date) AS date,credit_account AS source,amount_cents AS revenue_cents,invoice_id FROM journal WHERE credit_account IN ('service_revenue','rental_revenue','facility_revenue','fee_revenue') UNION ALL SELECT COALESCE(posting_date,(created_at AT TIME ZONE $3)::date),debit_account,-amount_cents,invoice_id FROM journal WHERE debit_account IN ('service_revenue','rental_revenue','facility_revenue','fee_revenue')) SELECT date,source,count(DISTINCT invoice_id)::int AS invoices,sum(revenue_cents)::bigint AS revenue_cents FROM postings WHERE date BETWEEN $1 AND $2 GROUP BY date,source ORDER BY date,source",
  expenses: `SELECT expense_date,category,vendor,amount_cents,reference,'expense' AS entry FROM expenses WHERE expense_date BETWEEN $1 AND $2 AND $3::text IS NOT NULL UNION ALL SELECT c.credit_date,e.category,e.vendor,-c.amount_cents,c.reference,'vendor_credit' FROM expense_credits c JOIN expenses e ON e.id=c.expense_id WHERE c.credit_date BETWEEN $1 AND $2 ORDER BY expense_date,reference`,
  profitability:
    "WITH entries AS (SELECT debit_account AS account,amount_cents AS debit_cents,0 AS credit_cents FROM journal WHERE COALESCE(posting_date,(created_at AT TIME ZONE $3)::date) BETWEEN $1 AND $2 UNION ALL SELECT credit_account,0,amount_cents FROM journal WHERE COALESCE(posting_date,(created_at AT TIME ZONE $3)::date) BETWEEN $1 AND $2) SELECT COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account IN ('service_revenue','rental_revenue','facility_revenue','fee_revenue')),0)::bigint AS revenue_cents,COALESCE(sum(debit_cents-credit_cents) FILTER(WHERE account LIKE 'expense:%'),0)::bigint AS expense_cents FROM entries",
  accounts_receivable: `WITH ledger AS (SELECT invoice_id,sum(CASE WHEN debit_account='accounts_receivable' THEN amount_cents ELSE 0 END-CASE WHEN credit_account='accounts_receivable' THEN amount_cents ELSE 0 END)::bigint AS balance_cents FROM journal WHERE invoice_id IS NOT NULL AND COALESCE(posting_date,(created_at AT TIME ZONE $3)::date)<=$2::date GROUP BY invoice_id) SELECT 'CW-'||i.number AS invoice,c.name AS customer,i.due_date,i.amount_cents,b.balance_cents,CASE WHEN i.due_date<$2::date THEN 'overdue' ELSE 'current' END AS age,GREATEST(0,$2::date-i.due_date)::int AS overdue_days FROM ledger b JOIN invoices i ON i.id=b.invoice_id JOIN customers c ON c.id=i.customer_id WHERE b.balance_cents>0 AND $1::date IS NOT NULL ORDER BY i.due_date,i.number`,
  customer_balances: `WITH attributed AS (
    SELECT COALESCE(i.customer_id,cr.customer_id,rc.customer_id) AS customer_id,
      CASE WHEN j.debit_account='accounts_receivable' THEN j.amount_cents ELSE 0 END-CASE WHEN j.credit_account='accounts_receivable' THEN j.amount_cents ELSE 0 END AS receivable,
      CASE WHEN j.credit_account='customer_credit' THEN j.amount_cents ELSE 0 END-CASE WHEN j.debit_account='customer_credit' THEN j.amount_cents ELSE 0 END AS credit
    FROM journal j LEFT JOIN invoices i ON i.id=j.invoice_id
    LEFT JOIN customer_credits cr ON j.source_kind='credit_receipt' AND cr.id=j.source_id
    LEFT JOIN customer_credit_refunds rf ON j.source_kind='credit_refund' AND rf.id=j.source_id
    LEFT JOIN customer_credits rc ON rc.id=rf.credit_id
    WHERE COALESCE(j.posting_date,(j.created_at AT TIME ZONE $3)::date)<=$2::date
  ), balances AS (SELECT customer_id,sum(receivable)::bigint AS balance_cents,sum(credit)::bigint AS credit_cents FROM attributed WHERE customer_id IS NOT NULL GROUP BY customer_id)
  SELECT c.name AS customer,COALESCE(b.balance_cents,0)::bigint AS balance_cents,COALESCE(b.credit_cents,0)::bigint AS credit_cents FROM customers c LEFT JOIN balances b ON b.customer_id=c.id WHERE ((c.created_at AT TIME ZONE $3)::date<=$2::date OR b.customer_id IS NOT NULL) AND $1::date IS NOT NULL ORDER BY c.name,c.id`,
  collections: `SELECT method,count(*)::int AS receipts,sum(amount_cents)::bigint AS received_cents FROM payments WHERE (paid_at AT TIME ZONE $3)::date BETWEEN $1 AND $2 GROUP BY method ORDER BY method`,
  drivers: `SELECT e.display_name AS driver,count(o.id)::int AS assigned,count(o.id) FILTER(WHERE o.status IN ('completed','invoiced'))::int AS completed,count(o.id) FILTER(WHERE o.status='failed')::int AS failed FROM employees e LEFT JOIN orders o ON o.driver_id=e.id AND o.scheduled_date BETWEEN $1 AND $2 WHERE e.role='driver' AND $3::text IS NOT NULL GROUP BY e.id ORDER BY driver`,
  routes: `SELECT r.name AS route,r.service_date,count(o.id)::int AS stops,count(o.id) FILTER(WHERE o.status IN ('completed','invoiced'))::int AS completed,COALESCE(sum(o.price_cents),0)::bigint AS agreed_service_cents,COALESCE(sum(o.fee_total_cents),0)::bigint AS agreed_fee_cents,COALESCE(sum(o.price_cents+o.fee_total_cents),0)::bigint AS agreed_total_cents FROM routes r LEFT JOIN route_stops s ON s.route_id=r.id LEFT JOIN orders o ON o.id=s.order_id WHERE r.service_date BETWEEN $1 AND $2 AND $3::text IS NOT NULL GROUP BY r.id ORDER BY r.service_date,r.name`,
  fleet: `SELECT t.number AS truck,t.status,count(o.id)::int AS assigned_jobs,count(DISTINCT o.scheduled_date)::int AS scheduled_days,count(o.id) FILTER(WHERE o.status IN ('completed','invoiced'))::int AS completed_jobs FROM trucks t LEFT JOIN orders o ON o.truck_id=t.id AND o.scheduled_date BETWEEN $1 AND $2 WHERE $3::text IS NOT NULL GROUP BY t.id ORDER BY truck`,
  containers: `SELECT c.number,c.kind,c.status,COALESCE(sum(LEAST(b.end_date_exclusive,$2::date+1)-GREATEST(b.start_date,$1::date)),0)::int AS reserved_days FROM containers c LEFT JOIN container_bookings b ON b.container_id=c.id AND NOT b.released AND b.start_date<=$2 AND b.end_date_exclusive>$1 WHERE $3::text IS NOT NULL GROUP BY c.id ORDER BY c.number`,
  disposal_tonnage: `SELECT facility,count(*)::int AS loads,sum(net_kg)::bigint AS net_kg,sum(disposal_cost_cents)::bigint AS disposal_cost_cents FROM disposal_tickets WHERE (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2 GROUP BY facility ORDER BY facility`,
  recycling: `SELECT m.name AS material,m.category,t.direction,sum(t.net_kg)::bigint AS net_kg,count(*)::int AS loads FROM scale_tickets t JOIN materials m ON m.id=t.material_id WHERE m.category IN ('recycling','metal') AND t.status IN ('weighed','invoiced') AND (t.created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2 GROUP BY m.name,m.category,t.direction ORDER BY material,t.direction`,
  customer_growth: `SELECT to_char(created_at AT TIME ZONE $3,'YYYY-MM') AS month,kind,count(*)::int AS new_customers FROM customers WHERE (created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2 GROUP BY 1,2 ORDER BY 1,2`,
  service_completion: `SELECT scheduled_date,kind,status,count(*)::int AS services FROM orders WHERE scheduled_date BETWEEN $1 AND $2 AND $3::text IS NOT NULL GROUP BY scheduled_date,kind,status ORDER BY scheduled_date,kind,status`,
  missed_pickups: `SELECT o.scheduled_date,c.name AS customer,l.address,o.kind,o.completion_note AS failure_reason FROM orders o JOIN customers c ON c.id=o.customer_id JOIN locations l ON l.id=o.location_id WHERE o.status='failed' AND o.scheduled_date BETWEEN $1 AND $2 AND $3::text IS NOT NULL ORDER BY o.scheduled_date`,
  trial_balance: `WITH entries AS (SELECT debit_account AS account,amount_cents AS debit_cents,0 AS credit_cents FROM journal WHERE COALESCE(posting_date,(created_at AT TIME ZONE $3)::date) BETWEEN $1 AND $2 UNION ALL SELECT credit_account,0,amount_cents FROM journal WHERE COALESCE(posting_date,(created_at AT TIME ZONE $3)::date) BETWEEN $1 AND $2) SELECT account,sum(debit_cents)::bigint AS debit_cents,sum(credit_cents)::bigint AS credit_cents,(sum(debit_cents)-sum(credit_cents))::bigint AS net_debit_cents FROM entries GROUP BY account ORDER BY account`,
};
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+@-]/.test(text) && typeof value !== "number") text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export class Reports {
  constructor(readonly ops: Operations) {}
  async run(a: Actor, name: string, query: unknown) {
    permit(a, FINANCE);
    const report = parse(z.enum(reportNames), name),
      b = parse(
        z.object({ from: z.iso.date(), to: z.iso.date() }).strict(),
        query,
      );
    if (
      b.to < b.from ||
      new Date(b.to).getTime() - new Date(b.from).getTime() > 366 * 86400000
    )
      throw new BadRequestException(
        "Choose a date range of at most 367 calendar days",
      );
    const timezone = (
      await this.ops.pool.query(
        "SELECT timezone FROM company_settings WHERE singleton",
      )
    ).rows[0].timezone;
    const rows = (
      await this.ops.pool.query(queries[report], [b.from, b.to, timezone])
    ).rows;
    return { name: report, ...b, timezone, rows };
  }
  async pdf(report: {
    name: string;
    from: string;
    to: string;
    rows: Record<string, unknown>[];
  }) {
    return await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: "A4" }),
        chunks: Buffer[] = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc
        .fontSize(20)
        .text("CoreWaste")
        .fontSize(14)
        .text(report.name.replaceAll("_", " "))
        .fontSize(10)
        .text(
          report.name === "material_stock"
            ? `Material stock as of ${report.to}`
            : [
                  "accounts_payable",
                  "accounts_receivable",
                  "customer_balances",
                ].includes(report.name)
              ? `Open balances as of ${report.to}`
              : `${report.from} through ${report.to}`,
        )
        .moveDown();
      if (!report.rows.length) doc.text("No records in this period.");
      for (const [index, row] of report.rows.entries()) {
        if (doc.y > 690) doc.addPage();
        doc
          .fontSize(10)
          .text(
            `${index + 1}. ${Object.entries(row)
              .map(([k, v]) => `${k.replaceAll("_", " ")}: ${v ?? "—"}`)
              .join(" | ")}`,
            { width: 510 },
          )
          .moveDown(0.5);
      }
      doc.end();
    });
  }
  csv(rows: Record<string, unknown>[]) {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    return (
      cols.map(csvCell).join(",") +
      "\r\n" +
      rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\r\n") +
      "\r\n"
    );
  }
}
