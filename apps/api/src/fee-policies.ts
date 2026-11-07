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
  permit,
  parse,
  uuid,
} from "./domain";
const fields = {
  name: z.string().trim().min(1).max(200),
  value: z.number().int().min(0).max(100000000),
  effective_from: z.iso.date(),
  effective_to: z.iso.date().nullable(),
  active: z.boolean(),
};
export class FeePolicies {
  constructor(readonly ops: Operations) {}
  async list(a: Actor, id: string) {
    permit(a, [...OFFICE, ...FINANCE]);
    parse(uuid, id);
    return (
      await this.ops.pool.query(
        "SELECT * FROM service_fee_policies WHERE customer_id=$1 ORDER BY kind,active DESC,name,id LIMIT 200",
        [id],
      )
    ).rows;
  }
  async create(a: Actor, key: string | undefined, body: unknown) {
    permit(a, FINANCE);
    const b = parse(
      z
        .object({
          ...fields,
          customer_id: uuid,
          kind: z.enum(["fuel", "handling"]),
          method: z.enum(["flat", "percent"]),
        })
        .strict(),
      body,
    );
    if (
      (b.method === "percent" && b.value > 10000) ||
      (b.effective_to && b.effective_to < b.effective_from)
    )
      throw new BadRequestException(
        "Percentage must be at most 100%; end must follow start",
      );
    return this.ops.command(a, key, ["fee_policy.create", b], async (c) => {
      if (
        !(
          await c.query(
            "SELECT 1 FROM customers WHERE id=$1 AND status='active' FOR SHARE",
            [b.customer_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Active customer required");
      const row = (
        await c.query(
          "INSERT INTO service_fee_policies(customer_id,kind,name,method,value,effective_from,effective_to,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            b.customer_id,
            b.kind,
            b.name,
            b.method,
            b.value,
            b.effective_from,
            b.effective_to,
            b.active,
            a.id,
          ],
        )
      ).rows[0];
      await this.ops.audit(c, a, "customer.fee_policy_created", row.id, b);
      return row;
    });
  }
  async update(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, FINANCE);
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
    return this.ops.command(a, key, ["fee_policy.update", id, b], async (c) => {
      const old = (
        await c.query(
          "SELECT * FROM service_fee_policies WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) throw new NotFoundException("Fee policy not found");
      if (old.version !== b.version)
        throw new ConflictException(
          "Fee policy changed; refresh before editing",
        );
      if (
        (old.method === "percent" && b.value > 10000) ||
        (b.effective_to && b.effective_to < b.effective_from)
      )
        throw new BadRequestException("Invalid fee value or effective dates");
      const row = (
        await c.query(
          "UPDATE service_fee_policies SET name=$2,value=$3,effective_from=$4,effective_to=$5,active=$6,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.name, b.value, b.effective_from, b.effective_to, b.active],
        )
      ).rows[0];
      await this.ops.audit(c, a, "customer.fee_policy_updated", id, {
        before: old,
        after: row,
        reason: b.reason,
      });
      return row;
    });
  }
}
