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
  orderInput,
} from "./domain";
const fields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(""),
  price_cents: z.number().int().min(0).max(100000000),
  effective_from: z.iso.date(),
  effective_to: z.iso.date().nullable(),
  active: z.boolean(),
};
export class Pricebooks {
  constructor(readonly ops: Operations) {}
  async list(a: Actor, customerId: string) {
    permit(a, [...OFFICE, ...FINANCE]);
    parse(uuid, customerId);
    return (
      await this.ops.pool.query(
        "SELECT p.*,l.address FROM customer_pricebooks p LEFT JOIN locations l ON l.id=p.location_id WHERE p.customer_id=$1 ORDER BY p.active DESC,p.name,p.id LIMIT 500",
        [customerId],
      )
    ).rows;
  }
  async create(a: Actor, key: string | undefined, body: unknown) {
    permit(a, ["owner", "manager", "accountant"]);
    const b = parse(
      z
        .object({
          ...fields,
          customer_id: uuid,
          location_id: uuid.nullable(),
          kind: orderInput.shape.kind,
        })
        .strict(),
      body,
    );
    if (b.effective_to && b.effective_to < b.effective_from)
      throw new BadRequestException("Rate end must follow its effective start");
    return this.ops.command(a, key, ["pricebook.create", b], async (c) => {
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
        b.location_id &&
        !(
          await c.query(
            "SELECT 1 FROM locations WHERE id=$1 AND customer_id=$2 AND active FOR SHARE",
            [b.location_id, b.customer_id],
          )
        ).rowCount
      )
        throw new BadRequestException(
          "Choose an active service location for this customer",
        );
      const row = (
        await c.query(
          "INSERT INTO customer_pricebooks(customer_id,location_id,kind,name,description,price_cents,effective_from,effective_to,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            b.customer_id,
            b.location_id,
            b.kind,
            b.name,
            b.description,
            b.price_cents,
            b.effective_from,
            b.effective_to,
            b.active,
            a.id,
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "customer.pricebook_created", row.id, b);
      return row;
    });
  }
  async update(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, ["owner", "manager", "accountant"]);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          ...fields,
          version: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      body,
    );
    if (b.effective_to && b.effective_to < b.effective_from)
      throw new BadRequestException("Rate end must follow its effective start");
    return this.ops.command(a, key, ["pricebook.update", id, b], async (c) => {
      const old = (
        await c.query(
          "SELECT * FROM customer_pricebooks WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException("Rate not found");
      if (old.version !== b.version)
        throw new ConflictException(
          "Customer rate changed; refresh before editing",
        );
      const row = (
        await c.query(
          "UPDATE customer_pricebooks SET name=$2,description=$3,price_cents=$4,effective_from=$5,effective_to=$6,active=$7,version=version+1 WHERE id=$1 RETURNING *",
          [
            id,
            b.name,
            b.description,
            b.price_cents,
            b.effective_from,
            b.effective_to,
            b.active,
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "customer.pricebook_updated", id, {
        before: old,
        after: row,
        reason: b.reason,
      });
      return row;
    });
  }
}
