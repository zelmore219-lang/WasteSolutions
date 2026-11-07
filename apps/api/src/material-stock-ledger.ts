import { ConflictException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
export async function postStock(
  c: PoolClient,
  actorId: string,
  accountId: string,
  delta: number,
  kind: string,
  reason: string,
  ticketId: string | null = null,
  transferId: string | null = null,
) {
  const account = (
    await c.query(
      "SELECT * FROM material_stock_accounts WHERE id=$1 FOR UPDATE",
      [accountId],
    )
  ).rows[0];
  if (!account) throw new NotFoundException("Material stock account not found");
  if (!account.active)
    throw new ConflictException("Material stock account is inactive");
  const balance = BigInt(account.balance_kg) + BigInt(delta);
  if (balance < 0n)
    throw new ConflictException(
      "Insufficient material stock; verify receipts or a reviewed physical count before shipping",
    );
  if (balance > 1000000000000n)
    throw new ConflictException(
      "Material stock exceeds the supported account limit",
    );
  const movement = (
    await c.query(
      "INSERT INTO material_stock_movements(account_id,delta_kg,balance_after_kg,kind,scale_ticket_id,transfer_id,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        accountId,
        delta,
        balance.toString(),
        kind,
        ticketId,
        transferId,
        reason,
        actorId,
      ],
    )
  ).rows[0];
  const updated = (
    await c.query(
      "UPDATE material_stock_accounts SET balance_kg=$2,version=version+1 WHERE id=$1 RETURNING *",
      [accountId, balance.toString()],
    )
  ).rows[0];
  return { account: updated, movement };
}
