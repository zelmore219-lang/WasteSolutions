import type { PoolClient } from "pg";
export const activeRefundStates = ["requested", "sending", "pending", "review"];
export async function reservedCreditRefunds(c: PoolClient, creditId: string) {
  return Number(
    (
      await c.query(
        "SELECT COALESCE(sum(amount_cents),0)::bigint AS amount FROM stripe_refund_requests WHERE credit_id=$1 AND state=ANY($2::text[])",
        [creditId, activeRefundStates],
      )
    ).rows[0].amount,
  );
}
