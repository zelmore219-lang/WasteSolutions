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
import { postStock } from "./material-stock-ledger";
const warehouse = ["owner", "manager", "dispatcher"];
const quantity = z.number().int().min(0).max(1000000000000),
  note = z.string().trim().min(1).max(2000);
export class MaterialStock {
  constructor(readonly ops: Operations) {}
  async list(a: Actor) {
    permit(a, [...OFFICE, ...FINANCE]);
    return (
      await this.ops.pool.query(
        "SELECT a.*,m.name AS material_name,m.category FROM material_stock_accounts a JOIN materials m ON m.id=a.material_id ORDER BY a.site_name,m.name,a.id LIMIT 500",
      )
    ).rows;
  }
  async history(a: Actor, id: string) {
    permit(a, [...OFFICE, ...FINANCE]);
    parse(uuid, id);
    const account = (
      await this.ops.pool.query(
        "SELECT a.*,m.name AS material_name,COALESCE((SELECT jsonb_agg(entry ORDER BY entry.recorded_at DESC,entry.id DESC) FROM (SELECT s.*,t.number AS scale_ticket_number,e.display_name AS recorded_by FROM material_stock_movements s LEFT JOIN scale_tickets t ON t.id=s.scale_ticket_id JOIN employees e ON e.id=s.actor_id WHERE s.account_id=a.id ORDER BY s.recorded_at DESC,s.id DESC LIMIT 100) entry),'[]'::jsonb) AS movements FROM material_stock_accounts a JOIN materials m ON m.id=a.material_id WHERE a.id=$1",
        [id],
      )
    ).rows[0];
    if (!account)
      throw new NotFoundException("Material stock account not found");
    return account;
  }
  async create(a: Actor, key: string | undefined, body: unknown) {
    permit(a, warehouse);
    const b = parse(
      z
        .object({
          material_id: uuid,
          site_name: z.string().trim().min(1).max(120),
          opening_kg: quantity,
          reason: note,
        })
        .strict(),
      body,
    );
    return this.ops.command(a, key, ["material_stock.create", b], async (c) => {
      if (
        !(
          await c.query(
            "SELECT 1 FROM materials WHERE id=$1 AND active FOR SHARE",
            [b.material_id],
          )
        ).rowCount
      )
        throw new BadRequestException("Active material required");
      const account = (
        await c.query(
          "INSERT INTO material_stock_accounts(material_id,site_name,created_by) VALUES($1,$2,$3) RETURNING *",
          [b.material_id, b.site_name, a.id],
        )
      ).rows[0];
      const posted = await postStock(
        c,
        a.id,
        account.id,
        b.opening_kg,
        "opening_count",
        b.reason,
      );
      await this.ops.audit(c, a, "material_stock.opened", account.id, b);
      return posted.account;
    });
  }
  async count(a: Actor, key: string | undefined, id: string, body: unknown) {
    permit(a, warehouse);
    parse(uuid, id);
    const b = parse(
      z
        .object({
          counted_kg: quantity,
          version: z.number().int().positive(),
          reason: note,
        })
        .strict(),
      body,
    );
    return this.ops.command(
      a,
      key,
      ["material_stock.count", id, b],
      async (c) => {
        const current = (
          await c.query(
            "SELECT * FROM material_stock_accounts WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!current)
          throw new NotFoundException("Material stock account not found");
        if (current.version !== b.version)
          throw new ConflictException(
            "Material stock changed while counting; refresh and reconcile the physical count",
          );
        const posted = await postStock(
          c,
          a.id,
          id,
          b.counted_kg - Number(current.balance_kg),
          "count_adjustment",
          b.reason,
        );
        await this.ops.audit(c, a, "material_stock.counted", id, {
          before_kg: current.balance_kg,
          ...b,
          movement_id: posted.movement.id,
        });
        return posted.account;
      },
    );
  }
  async transfer(a: Actor, key: string | undefined, body: unknown) {
    permit(a, warehouse);
    const b = parse(
      z
        .object({
          from_id: uuid,
          to_id: uuid,
          quantity_kg: quantity.positive(),
          from_version: z.number().int().positive(),
          to_version: z.number().int().positive(),
          reason: note,
        })
        .strict(),
      body,
    );
    if (b.from_id === b.to_id)
      throw new BadRequestException("Choose two different stock sites");
    return this.ops.command(
      a,
      key,
      ["material_stock.transfer", b],
      async (c) => {
        const accounts = (
          await c.query(
            "SELECT * FROM material_stock_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
            [[b.from_id, b.to_id]],
          )
        ).rows;
        const from = accounts.find((r) => r.id === b.from_id),
          to = accounts.find((r) => r.id === b.to_id);
        if (!from || !to)
          throw new NotFoundException("Material stock account not found");
        if (from.material_id !== to.material_id)
          throw new BadRequestException(
            "Transfers require the same material at both sites",
          );
        if (from.version !== b.from_version || to.version !== b.to_version)
          throw new ConflictException(
            "Stock changed; refresh before transferring",
          );
        const transfer = (await c.query("SELECT gen_random_uuid() AS id"))
          .rows[0].id;
        const outbound = await postStock(
            c,
            a.id,
            from.id,
            -b.quantity_kg,
            "transfer_out",
            b.reason,
            null,
            transfer,
          ),
          inbound = await postStock(
            c,
            a.id,
            to.id,
            b.quantity_kg,
            "transfer_in",
            b.reason,
            null,
            transfer,
          );
        await this.ops.audit(c, a, "material_stock.transferred", transfer, b);
        return {
          transfer_id: transfer,
          from: outbound.account,
          to: inbound.account,
        };
      },
    );
  }
}
