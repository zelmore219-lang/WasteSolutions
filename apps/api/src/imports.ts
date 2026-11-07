import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { parse as parseCsv } from "csv-parse/sync";
import { PoolClient } from "pg";
import { z } from "zod";
import {
  Actor,
  Operations,
  OFFICE,
  parse,
  permit,
  uuid,
  customerInput,
  locationInput,
  orderInput,
} from "./domain";
const external = z.string().trim().min(1).max(100);
const cents = z
  .string()
  .regex(/^[0-9]+$/, "Enter an integer number of cents")
  .transform(Number)
  .pipe(z.number().int().min(0).max(100000000));
const schemas = {
  customers: customerInput.extend({ external_id: external }),
  locations: locationInput.extend({ external_id: external, customer_id: uuid }),
  containers: z
    .object({
      external_id: external,
      number: z.string().trim().min(1).max(80),
      kind: z.enum(["roll_off", "commercial", "cart", "trailer"]),
      capacity_yards: z.coerce.number().positive().max(1000),
    })
    .strict(),
  agreements: z
    .object({
      external_id: external,
      customer_id: uuid,
      location_id: uuid,
      kind: z.enum(["residential", "commercial"]),
      price_cents: cents,
      interval_days: z.coerce.number().int().min(1).max(366),
      next_service_date: z.iso.date(),
    })
    .strict(),
  orders: orderInput
    .omit({ price_cents: true })
    .extend({ external_id: external, price_cents: cents }),
  routes: z
    .object({
      external_id: external,
      name: z.string().trim().min(1).max(200),
      service_date: z.iso.date(),
      driver_id: uuid,
      truck_id: uuid,
      order_ids: z
        .string()
        .transform((v) => v.split("|").map((x) => x.trim()))
        .pipe(z.array(uuid).min(1).max(250)),
    })
    .strict(),
  legacy_transactions: z
    .object({
      external_id: external,
      source_system: external,
      source_reference: external,
      transaction_kind: z.enum([
        "invoice",
        "payment",
        "refund",
        "credit",
        "expense",
      ]),
      transaction_date: z.iso.date(),
      amount_cents: cents.pipe(z.number().positive()),
      currency: z.literal("USD"),
      customer_id: z
        .union([uuid, z.literal("")])
        .optional()
        .transform((v) => v || null),
      vendor: z.string().trim().max(200).default(""),
      related_reference: z.string().trim().max(100).default(""),
      memo: z.string().trim().max(2000).default(""),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.transaction_kind === "expense" ? !v.vendor : !v.customer_id)
        ctx.addIssue({
          code: "custom",
          message:
            "Customer transactions require a customer; expenses require a vendor",
        });
    }),
  opening_balances: z
    .object({
      external_id: external,
      customer_id: uuid,
      amount_cents: z.coerce.number().int().positive().max(100000000),
      balance_date: z.iso.date(),
      due_date: z.iso.date(),
      source_reference: external,
    })
    .strict(),
};
type Kind = keyof typeof schemas;
const access = (a: Actor) => permit(a, ["owner", "manager", "accountant"]);
export class Imports {
  constructor(readonly ops: Operations) {}
  async list(a: Actor) {
    access(a);
    return (
      await this.ops.pool.query(
        "SELECT b.*,count(r.id)::int AS rows FROM import_batches b LEFT JOIN import_rows r ON r.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100",
      )
    ).rows;
  }
  async detail(a: Actor, id: string) {
    access(a);
    parse(uuid, id);
    const b = (
      await this.ops.pool.query("SELECT * FROM import_batches WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (!b) throw new NotFoundException();
    return {
      ...b,
      rows: (
        await this.ops.pool.query(
          "SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY row_number",
          [id],
        )
      ).rows,
    };
  }
  async validate(c: PoolClient, kind: Kind, p: any) {
    const errors: string[] = [];
    if (
      (
        await c.query(
          "SELECT 1 FROM imported_refs WHERE kind=$1 AND external_id=$2",
          [kind, p.external_id],
        )
      ).rowCount
    )
      errors.push("External ID was already imported");
    if (
      kind === "customers" &&
      (
        await c.query("SELECT 1 FROM customers WHERE lower(email)=lower($1)", [
          p.email,
        ])
      ).rowCount
    )
      errors.push(
        "A customer with this email already exists; reconcile manually before import",
      );
    if (
      p.customer_id &&
      !(
        await c.query(
          "SELECT 1 FROM customers WHERE id=$1 AND (status='active' OR $2::boolean) FOR SHARE",
          [p.customer_id, kind === "legacy_transactions"],
        )
      ).rowCount
    )
      errors.push("Active customer not found");
    if (
      p.location_id &&
      !(
        await c.query(
          "SELECT 1 FROM locations WHERE id=$1 AND customer_id=$2 AND active FOR SHARE",
          [p.location_id, p.customer_id],
        )
      ).rowCount
    )
      errors.push("Service location does not belong to active customer");
    if (
      kind === "containers" &&
      (await c.query("SELECT 1 FROM containers WHERE number=$1", [p.number]))
        .rowCount
    )
      errors.push("Container number already exists");
    if (
      kind === "opening_balances" &&
      (
        await c.query(
          "SELECT 1 FROM migration_balances WHERE source_reference=$1",
          [p.source_reference],
        )
      ).rowCount
    )
      errors.push("Balance source reference already exists");
    if (kind === "legacy_transactions") {
      const today = (
        await c.query(
          "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
        )
      ).rows[0].today;
      if (p.transaction_date > today)
        errors.push("Historical transaction date cannot be in the future");
      if (
        (
          await c.query(
            "SELECT 1 FROM legacy_transactions WHERE source_system=$1 AND transaction_kind=$2 AND source_reference=$3",
            [p.source_system, p.transaction_kind, p.source_reference],
          )
        ).rowCount
      )
        errors.push(
          "Source transaction already imported, including archived rollback history",
        );
    }
    if (kind === "opening_balances") {
      const today = (
        await c.query(
          "SELECT (now() AT TIME ZONE timezone)::date AS today FROM company_settings WHERE singleton",
        )
      ).rows[0].today;
      if (p.balance_date > today)
        errors.push("Opening balance date cannot be in the future");
    }
    if (kind === "routes") {
      if (new Set(p.order_ids).size !== p.order_ids.length)
        errors.push("Duplicate stop IDs");
      if (
        !(
          await c.query(
            "SELECT 1 FROM employees WHERE id=$1 AND role='driver' AND active",
            [p.driver_id],
          )
        ).rowCount
      )
        errors.push("Active driver not found");
      if (
        !(
          await c.query(
            "SELECT 1 FROM trucks WHERE id=$1 AND status='available'",
            [p.truck_id],
          )
        ).rowCount
      )
        errors.push("Available truck not found");
      const jobs = (
        await c.query(
          "SELECT o.* FROM orders o LEFT JOIN route_stops s ON s.order_id=o.id WHERE o.id=ANY($1::uuid[]) AND o.status IN ('new','assigned') AND o.scheduled_date=$2 AND s.order_id IS NULL",
          [p.order_ids, p.service_date],
        )
      ).rows;
      if (jobs.length !== p.order_ids.length)
        errors.push(
          "Each stop must be unstarted, unrouted work on the selected date",
        );
    }
    return errors;
  }
  async preview(a: Actor, key: string | undefined, body: unknown) {
    access(a);
    const b = parse(
      z
        .object({
          kind: z.enum([
            "customers",
            "locations",
            "containers",
            "agreements",
            "orders",
            "routes",
            "opening_balances",
            "legacy_transactions",
          ]),
          csv: z.string().min(1).max(50000),
        })
        .strict(),
      body,
    );
    if (Buffer.byteLength(b.csv) > 50000)
      throw new BadRequestException("CSV must be at most 50 KB");
    let records: Record<string, string>[];
    try {
      records = parseCsv(b.csv, {
        columns: (headers: string[]) => {
          if (
            headers.some((h) => !h) ||
            new Set(headers).size !== headers.length
          )
            throw new Error("CSV headers must be nonempty and unique");
          return headers;
        },
        bom: true,
        skip_empty_lines: true,
        trim: true,
        max_record_size: 5000,
      });
    } catch {
      throw new BadRequestException(
        "CSV could not be parsed; check header, quoting and record sizes",
      );
    }
    if (!records.length || records.length > 500)
      throw new BadRequestException(
        "CSV must contain between 1 and 500 data rows",
      );
    return this.ops.command(a, key, ["import.preview", b], async (c) => {
      const batch = (
        await c.query(
          "INSERT INTO import_batches(kind,actor_id) VALUES($1,$2) RETURNING *",
          [b.kind, a.id],
        )
      ).rows[0];
      const externalIds = new Set<string>(),
        naturalKeys = new Set<string>();
      let errorsCount = 0;
      for (const [i, raw] of records.entries()) {
        const parsed = schemas[b.kind].safeParse(raw);
        const errors = parsed.success
          ? await this.validate(c, b.kind, parsed.data)
          : parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`);
        const p = parsed.success ? parsed.data : raw;
        if (externalIds.has(p.external_id))
          errors.push("External ID repeated in this CSV");
        externalIds.add(p.external_id);
        const natural =
          b.kind === "customers"
            ? String(raw.email).toLowerCase()
            : b.kind === "containers"
              ? raw.number
              : b.kind === "opening_balances"
                ? raw.source_reference
                : b.kind === "legacy_transactions"
                  ? JSON.stringify([
                      raw.source_system,
                      raw.transaction_kind,
                      raw.source_reference,
                    ])
                  : undefined;
        if (natural) {
          if (naturalKeys.has(natural))
            errors.push("Natural key repeated in this CSV");
          naturalKeys.add(natural);
        }
        if (errors.length) errorsCount++;
        await c.query(
          "INSERT INTO import_rows(batch_id,row_number,payload,errors) VALUES($1,$2,$3,$4)",
          [batch.id, i + 2, JSON.stringify(p), JSON.stringify(errors)],
        );
      }
      await this.ops.audit(c, a, "import.previewed", batch.id, {
        kind: b.kind,
        rows: records.length,
      });
      return { ...batch, rows: records.length, invalid_rows: errorsCount };
    });
  }
  async apply(a: Actor, key: string | undefined, id: string, body: unknown) {
    access(a);
    parse(uuid, id);
    const b = parse(z.object({ confirm: z.string() }).strict(), body);
    if (b.confirm !== `APPLY ${id}`)
      throw new BadRequestException(
        "Confirm the exact previewed batch with APPLY followed by its ID",
      );
    return this.ops.command(a, key, ["import.apply", id], async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('corewaste-imports'))",
      );
      const batch = (
        await c.query("SELECT * FROM import_batches WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!batch || batch.status !== "preview")
        throw new ConflictException("Import batch is not pending");
      const rows = (
        await c.query(
          "SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY row_number",
          [id],
        )
      ).rows;
      for (const row of rows) {
        if (row.errors.length)
          throw new ConflictException(
            "Fix invalid preview rows before applying",
          );
        const errors = await this.validate(c, batch.kind, row.payload);
        if (errors.length)
          throw new ConflictException(
            `Row ${row.row_number}: ${errors.join("; ")}`,
          );
      }
      for (const row of rows) {
        const p = row.payload;
        let entity: any;
        if (batch.kind === "customers")
          entity = (
            await c.query(
              "INSERT INTO customers(name,kind,email,phone,billing_address) VALUES($1,$2,$3,$4,$5) RETURNING id",
              [p.name, p.kind, p.email, p.phone, p.billing_address],
            )
          ).rows[0];
        if (batch.kind === "locations")
          entity = (
            await c.query(
              "INSERT INTO locations(customer_id,address,instructions) VALUES($1,$2,$3) RETURNING id",
              [p.customer_id, p.address, p.instructions],
            )
          ).rows[0];
        if (batch.kind === "containers")
          entity = (
            await c.query(
              "INSERT INTO containers(number,kind,capacity_yards) VALUES($1,$2,$3) RETURNING id",
              [p.number, p.kind, p.capacity_yards],
            )
          ).rows[0];
        if (batch.kind === "agreements")
          entity = (
            await c.query(
              "INSERT INTO service_agreements(customer_id,location_id,kind,price_cents,interval_days,next_service_date) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
              [
                p.customer_id,
                p.location_id,
                p.kind,
                p.price_cents,
                p.interval_days,
                p.next_service_date,
              ],
            )
          ).rows[0];
        if (batch.kind === "orders") {
          entity = (
            await c.query(
              "INSERT INTO orders(customer_id,location_id,kind,scheduled_date,instructions,price_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
              [
                p.customer_id,
                p.location_id,
                p.kind,
                p.scheduled_date,
                p.instructions,
                p.price_cents,
              ],
            )
          ).rows[0];
          await this.ops.event(
            c,
            a,
            entity.id,
            "new",
            "Imported service order",
          );
        }
        if (batch.kind === "routes") {
          const before = (
            await c.query(
              "SELECT * FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
              [p.order_ids],
            )
          ).rows;
          await c.query("UPDATE import_rows SET before_state=$2 WHERE id=$1", [
            row.id,
            JSON.stringify(before),
          ]);
          const errors = await this.validate(c, batch.kind, p);
          if (errors.length) throw new ConflictException(errors.join("; "));
          entity = (
            await c.query(
              "INSERT INTO routes(name,service_date,driver_id,truck_id) VALUES($1,$2,$3,$4) RETURNING id",
              [p.name, p.service_date, p.driver_id, p.truck_id],
            )
          ).rows[0];
          for (const [i, orderId] of p.order_ids.entries()) {
            await c.query(
              "INSERT INTO route_stops(route_id,order_id,position) VALUES($1,$2,$3)",
              [entity.id, orderId, i + 1],
            );
            await c.query(
              "UPDATE orders SET driver_id=$2,truck_id=$3,status='assigned',version=version+1 WHERE id=$1",
              [orderId, p.driver_id, p.truck_id],
            );
            await this.ops.event(
              c,
              a,
              orderId,
              "assigned",
              "Imported route assignment",
            );
          }
        }
        if (batch.kind === "opening_balances") {
          entity = (
            await c.query(
              "INSERT INTO migration_balances(customer_id,batch_id,amount_cents,balance_date,due_date,source_reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
              [
                p.customer_id,
                id,
                p.amount_cents,
                p.balance_date,
                p.due_date,
                p.source_reference,
              ],
            )
          ).rows[0];
          const invoice = (
            await c.query(
              "INSERT INTO invoices(customer_id,migration_balance_id,amount_cents,due_date) VALUES($1,$2,$3,$4) RETURNING id",
              [p.customer_id, entity.id, p.amount_cents, p.due_date],
            )
          ).rows[0];
          await c.query(
            "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,posting_date) VALUES($1,'accounts_receivable','opening_equity',$2,$3)",
            [invoice.id, p.amount_cents, p.balance_date],
          );
        }
        if (batch.kind === "legacy_transactions") {
          entity = (
            await c.query(
              "INSERT INTO legacy_transactions(batch_id,source_system,source_reference,transaction_kind,transaction_date,amount_cents,currency,customer_id,vendor,related_reference,memo) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
              [
                id,
                p.source_system,
                p.source_reference,
                p.transaction_kind,
                p.transaction_date,
                p.amount_cents,
                p.currency,
                p.customer_id,
                p.vendor,
                p.related_reference,
                p.memo,
              ],
            )
          ).rows[0];
        }
        await c.query(
          "INSERT INTO imported_refs(kind,external_id,entity_id,batch_id) VALUES($1,$2,$3,$4)",
          [batch.kind, p.external_id, entity.id, id],
        );
        await c.query("UPDATE import_rows SET entity_id=$2 WHERE id=$1", [
          row.id,
          entity.id,
        ]);
      }
      await c.query(
        "UPDATE import_batches SET status='applied',applied_at=now() WHERE id=$1",
        [id],
      );
      await this.ops.audit(c, a, "import.applied", id, { rows: rows.length });
      return { batch_id: id, applied: rows.length };
    });
  }
  async rollback(a: Actor, key: string | undefined, id: string, body: unknown) {
    access(a);
    parse(uuid, id);
    const b = parse(z.object({ confirm: z.string() }).strict(), body);
    if (b.confirm !== `ROLLBACK ${id}`)
      throw new BadRequestException("Confirm rollback of this exact batch");
    return this.ops.command(a, key, ["import.rollback", id], async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('corewaste-imports'))",
      );
      const batch = (
        await c.query("SELECT * FROM import_batches WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!batch || batch.status !== "applied")
        throw new ConflictException("Only an applied batch can be rolled back");
      const rows = (
        await c.query(
          "SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY row_number DESC",
          [id],
        )
      ).rows;
      for (const row of rows) {
        const entityId = row.entity_id;
        if (batch.kind === "customers") {
          const linked = (
            await c.query(
              "SELECT 1 FROM orders WHERE customer_id=$1 AND status<>'cancelled' UNION ALL SELECT 1 FROM locations WHERE customer_id=$1 AND active UNION ALL SELECT 1 FROM invoices WHERE customer_id=$1 AND status<>'void' UNION ALL SELECT 1 FROM employees WHERE customer_id=$1 AND active UNION ALL SELECT 1 FROM service_agreements WHERE customer_id=$1 AND active UNION ALL SELECT 1 FROM rentals WHERE customer_id=$1 AND status IN ('reserved','delivered')",
              [entityId],
            )
          ).rowCount;
          if (linked)
            throw new ConflictException(
              "Imported customer has linked business activity; rollback dependent batches first",
            );
          await c.query("UPDATE customers SET status='suspended' WHERE id=$1", [
            entityId,
          ]);
        }
        if (batch.kind === "locations") {
          if (
            (
              await c.query(
                "SELECT 1 FROM orders WHERE location_id=$1 AND status<>'cancelled' UNION ALL SELECT 1 FROM service_agreements WHERE location_id=$1 AND active UNION ALL SELECT 1 FROM containers WHERE location_id=$1 AND status IN ('deployed','awaiting_disposal') UNION ALL SELECT 1 FROM rentals WHERE location_id=$1 AND status IN ('reserved','delivered')",
                [entityId],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Imported location has business activity",
            );
          await c.query("UPDATE locations SET active=false WHERE id=$1", [
            entityId,
          ]);
        }
        if (batch.kind === "containers") {
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtext('corewaste-container-scheduling'))",
          );
          if (
            (
              await c.query(
                "SELECT 1 FROM container_bookings WHERE container_id=$1 AND NOT released",
                [entityId],
              )
            ).rowCount
          )
            throw new ConflictException("Imported container has reservations");
          const equipment = (
            await c.query("SELECT * FROM containers WHERE id=$1 FOR UPDATE", [
              entityId,
            ])
          ).rows[0];
          if (
            !equipment ||
            equipment.version !== 1 ||
            equipment.status !== "yard" ||
            equipment.yard_id ||
            equipment.carried_by_truck_id ||
            (
              await c.query(
                "SELECT 1 FROM equipment_storage_events WHERE container_id=$1 UNION ALL SELECT 1 FROM equipment_deployments WHERE container_id=$1",
                [entityId],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Imported equipment has physical activity; reconcile its inventory history before rollback",
            );
          await c.query(
            "UPDATE containers SET status='retired',location_id=NULL,version=version+1 WHERE id=$1",
            [entityId],
          );
        }
        if (batch.kind === "agreements") {
          if (
            (
              await c.query("SELECT 1 FROM orders WHERE agreement_id=$1", [
                entityId,
              ])
            ).rowCount
          )
            throw new ConflictException("Agreement already generated orders");
          await c.query(
            "UPDATE service_agreements SET active=false WHERE id=$1",
            [entityId],
          );
        }
        if (batch.kind === "orders") {
          const o = await this.ops.locked(c, entityId);
          if (
            o.status !== "new" ||
            o.version !== 1 ||
            (
              await c.query("SELECT 1 FROM route_stops WHERE order_id=$1", [
                entityId,
              ])
            ).rowCount
          )
            throw new ConflictException(
              "Imported order is assigned or started",
            );
          await c.query(
            "UPDATE orders SET status='cancelled',version=version+1 WHERE id=$1",
            [entityId],
          );
          await this.ops.event(c, a, entityId, "cancelled", "Import rollback");
        }
        if (batch.kind === "routes") {
          await c.query("SELECT id FROM routes WHERE id=$1 FOR UPDATE", [
            entityId,
          ]);
          const jobs = (
            await c.query(
              "SELECT o.* FROM route_stops s JOIN orders o ON o.id=s.order_id WHERE s.route_id=$1 ORDER BY o.id FOR UPDATE OF o",
              [entityId],
            )
          ).rows;
          const before = row.before_state as any[];
          if (
            !before ||
            jobs.length !== before.length ||
            jobs.some((o) => {
              const old = before.find((v) => v.id === o.id);
              return (
                !old ||
                o.status !== "assigned" ||
                o.version !== old.version + 1 ||
                o.driver_id !== row.payload.driver_id ||
                o.truck_id !== row.payload.truck_id
              );
            })
          )
            throw new ConflictException(
              "Route work changed after import; reconcile dispatch before rollback",
            );
          for (const old of before) {
            await c.query(
              "UPDATE orders SET status=$2,driver_id=$3,truck_id=$4,version=version+1 WHERE id=$1",
              [old.id, old.status, old.driver_id, old.truck_id],
            );
            await this.ops.event(
              c,
              a,
              old.id,
              old.status,
              "Import route rollback restored previous assignment",
            );
          }
          await c.query("DELETE FROM route_stops WHERE route_id=$1", [
            entityId,
          ]);
          await c.query(
            "UPDATE routes SET archived=true,version=version+1 WHERE id=$1",
            [entityId],
          );
        }
        if (batch.kind === "opening_balances") {
          const invoice = (
            await c.query(
              "SELECT * FROM invoices WHERE migration_balance_id=$1 FOR UPDATE",
              [entityId],
            )
          ).rows[0];
          if (
            (
              await c.query(
                "SELECT 1 FROM payments WHERE invoice_id=$1 UNION ALL SELECT 1 FROM invoice_adjustments WHERE invoice_id=$1 UNION ALL SELECT 1 FROM invoice_credit_transfers WHERE invoice_id=$1 UNION ALL SELECT 1 FROM payment_attempts WHERE invoice_id=$1 UNION ALL SELECT 1 FROM stripe_refund_requests WHERE invoice_id=$1",
                [invoice.id],
              )
            ).rowCount
          )
            throw new ConflictException(
              "Opening balance already has financial activity; reconcile it before rollback",
            );
          await c.query(
            "INSERT INTO journal(invoice_id,debit_account,credit_account,amount_cents,source_kind,source_id) VALUES($1,'opening_equity','accounts_receivable',$2,'import_reversal',$3)",
            [invoice.id, invoice.amount_cents, entityId],
          );
          await c.query("UPDATE invoices SET status='void' WHERE id=$1", [
            invoice.id,
          ]);
        }
      }
      await c.query(
        "UPDATE import_batches SET status='rolled_back',rolled_back_at=now() WHERE id=$1",
        [id],
      );
      await this.ops.audit(c, a, "import.rolled_back", id);
      return { batch_id: id, rolled_back: rows.length, records_deleted: 0 };
    });
  }
}
