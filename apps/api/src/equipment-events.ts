import type { PoolClient } from "pg";
export async function recordStorageEvent(
  c: PoolClient,
  actorId: string,
  before: any,
  after: any,
  action: string,
  reason: string,
  options: {
    observed_number?: string;
    order_id?: string;
    deployment_id?: string;
    performed_at?: string;
  } = {},
) {
  return (
    await c.query(
      "INSERT INTO equipment_storage_events(container_id,actor_id,action,observed_number,reason,before_state,after_state,order_id,deployment_id,performed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz,now())) RETURNING id",
      [
        after.id,
        actorId,
        action,
        options.observed_number || null,
        reason,
        JSON.stringify(before),
        JSON.stringify(after),
        options.order_id || null,
        options.deployment_id || null,
        options.performed_at || null,
      ],
    )
  ).rows[0];
}
