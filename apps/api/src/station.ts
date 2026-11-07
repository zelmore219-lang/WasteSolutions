import { postStock } from "./material-stock-ledger";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
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
import { notify } from "./finance";
const staff = [...OFFICE, ...FINANCE];
export class Station {
  constructor(readonly ops: Operations) {}
  async materials(a: Actor) {
    permit(a, staff);
    return (await this.ops.pool.query("SELECT * FROM materials ORDER BY name"))
      .rows;
  }
  async material(a: Actor, key: string | undefined, body: unknown) {
    permit(a, FINANCE);
    const b = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          category: z.enum([
            "landfill",
            "recycling",
            "green_waste",
            "construction",
            "metal",
          ]),
          rate_cents_per_tonne: z.number().int().min(0).max(10000000),
          minimum_charge_cents: z
            .number()
            .int()
            .min(0)
            .max(100000000)
            .default(0),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["material", b], async (c) => {
      const m = (
        await c.query(
          "INSERT INTO materials(name,category,rate_cents_per_tonne,minimum_charge_cents) VALUES($1,$2,$3,$4) RETURNING *",
          [b.name, b.category, b.rate_cents_per_tonne, b.minimum_charge_cents],
        )
      ).rows[0];
      await this.ops.audit(c, a, "material.created", m.id);
      return m;
    });
  }
  async tickets(a: Actor) {
    permit(a, staff);
    return (
      await this.ops.pool.query(
        "SELECT t.*,c.name AS customer_name,m.name AS material_name,a.site_name AS stock_site_name FROM scale_tickets t JOIN customers c ON c.id=t.customer_id JOIN materials m ON m.id=t.material_id LEFT JOIN material_stock_accounts a ON a.id=t.stock_account_id ORDER BY t.created_at DESC LIMIT 500",
      )
    ).rows;
  }
  async open(a: Actor, key: string | undefined, body: unknown) {
    permit(a, OFFICE);
    const b = parse(
      z
        .object({
          customer_id: uuid,
          material_id: uuid,
          direction: z.enum(["inbound", "outbound"]),
          vehicle_number: z.string().trim().min(1).max(80),
          first_weight_kg: z.number().int().min(0).max(1000000),
          source_reference: z.string().trim().min(1).max(300),
          stock_account_id: uuid.optional(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["station.open", b], async (c) => {
      const m = (
        await c.query(
          "SELECT * FROM materials WHERE id=$1 AND active FOR SHARE",
          [b.material_id],
        )
      ).rows[0];
      if (!m) throw new BadRequestException("Active material required");
      if (
        !(
          await c.query(
            "SELECT 1 FROM customers WHERE id=$1 AND status='active' FOR SHARE",
            [b.customer_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Active customer required");
      if (
        b.stock_account_id &&
        !(
          await c.query(
            "SELECT 1 FROM material_stock_accounts WHERE id=$1 AND material_id=$2 AND active FOR SHARE",
            [b.stock_account_id, b.material_id],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Choose an active stock site for this material",
        );
      const ticket = (
        await c.query(
          "INSERT INTO scale_tickets(customer_id,material_id,direction,vehicle_number,first_weight_kg,rate_cents_per_tonne,minimum_charge_cents,source,source_reference,actor_id,stock_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10) RETURNING *",
          [
            b.customer_id,
            b.material_id,
            b.direction,
            b.vehicle_number,
            b.first_weight_kg,
            m.rate_cents_per_tonne,
            m.minimum_charge_cents,
            b.source_reference,
            a.id,
            b.stock_account_id || null,
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "scale_ticket.opened", ticket.id);
      return ticket;
    });
  }
  async weigh(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, OFFICE);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          second_weight_kg: z.number().int().min(0).max(1000000),
          version: z.number().int().positive(),
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["station.weigh", id, b], async (c) => {
      const t = (
        await c.query("SELECT * FROM scale_tickets WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!t) throw new NotFoundException("Scale ticket not found");
      if (t.status !== "open" || t.version !== b.version)
        throw new ConflictException("Scale ticket changed or already weighed");
      if (
        (t.direction === "inbound" && b.second_weight_kg > t.first_weight_kg) ||
        (t.direction === "outbound" && b.second_weight_kg < t.first_weight_kg)
      )
        throw new BadRequestException(
          "Gross weight must be at least tare weight",
        );
      const result = (
        await c.query(
          "UPDATE scale_tickets SET second_weight_kg=$2,status='weighed',version=version+1 WHERE id=$1 RETURNING *",
          [id, b.second_weight_kg],
        )
      ).rows[0];
      if (t.stock_account_id)
        await postStock(
          c,
          a.id,
          t.stock_account_id,
          t.direction === "inbound" ? result.net_kg : -result.net_kg,
          t.direction === "inbound" ? "scale_inbound" : "scale_outbound",
          "Verified second weighing for scale ticket " + result.number,
          id,
        );
      await this.ops.audit(c, a, "scale_ticket.weighed", id);
      return result;
    });
  }
  async invoice(a: Actor, key: string | undefined, id: string) {
    permit(a, FINANCE);
    parse(uuid, id);
    return this.ops.command(a, key, ["station.invoice", id], async (c) => {
      const t = (
        await c.query("SELECT * FROM scale_tickets WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!t) throw new NotFoundException("Scale ticket not found");
      const previous = (
        await c.query("SELECT * FROM invoices WHERE scale_ticket_id=$1", [id])
      ).rows[0];
      if (previous) return previous;
      if (t.status !== "weighed")
        throw new ConflictException("Complete both weighings before invoicing");
      const total = Math.max(
        t.minimum_charge_cents,
        Number(
          (BigInt(t.net_kg) * BigInt(t.rate_cents_per_tonne) + 500n) / 1000n,
        ),
      );
      if (total > 100000000)
        throw new BadRequestException("Total exceeds supported limit");
      const i = (
        await c.query(
          "INSERT INTO invoices(customer_id,scale_ticket_id,amount_cents,status) VALUES($1,$2,$3,CASE WHEN $3::int=0 THEN 'paid' ELSE 'open' END) RETURNING *",
          [t.customer_id, id, total],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO invoice_lines(invoice_id,description,amount_cents) VALUES($1,$2,$3)",
        [
          i.id,
          `Scale ticket ${t.number}: ${t.net_kg} kg (${t.direction}); minimum charge applies`,
          total,
        ],
      );
      if (total > 0)
        await c.query(
          "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents) VALUES($1,'accounts_receivable','facility_revenue',$2)",
          [i.id, total],
        );
      await c.query(
        "UPDATE scale_tickets SET status='invoiced',version=version+1 WHERE id=$1",
        [id],
      );
      await this.ops.audit(c, a, "scale_ticket.invoiced", id);
      await notify(
        c,
        t.customer_id,
        "invoice_generated",
        "Facility invoice ready",
        `Invoice CW-${i.number} is ready for your ${t.net_kg} kg scale ticket.`,
        "invoice:" + i.id,
      );
      return i;
    });
  }
  async reconcile(a: Actor, date: string) {
    permit(a, FINANCE);
    parse(z.iso.date(), date);
    return {
      date,
      tonnage: (
        await this.ops.pool.query(
          "SELECT m.category,t.direction,sum(t.net_kg)::bigint AS net_kg,count(*)::int AS tickets FROM scale_tickets t JOIN materials m ON m.id=t.material_id WHERE (t.created_at AT TIME ZONE 'America/Chicago')::date=$1 AND t.status IN ('weighed','invoiced') GROUP BY m.category,t.direction",
          [date],
        )
      ).rows,
      receipts: (
        await this.ops.pool.query(
          "SELECT p.method,sum(p.amount_cents)::bigint AS amount_cents,count(*)::int AS receipts FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.scale_ticket_id IS NOT NULL AND (p.paid_at AT TIME ZONE 'America/Chicago')::date=$1 GROUP BY p.method",
          [date],
        )
      ).rows,
    };
  }
}
