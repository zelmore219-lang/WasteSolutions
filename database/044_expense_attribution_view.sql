-- Preserve existing view column order and append the new attribution columns.
CREATE OR REPLACE VIEW expense_balances AS
 SELECT e.id,e.category,e.vendor,e.amount_cents,e.expense_date,e.truck_id,e.reference,e.actor_id,e.created_at,e.payment_mode,e.due_date,
 CASE WHEN payment_mode='paid' THEN amount_cents ELSE
 COALESCE((SELECT sum(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id AND NOT EXISTS(SELECT 1 FROM expense_payment_reversals r WHERE r.payment_id=p.id)),0) END::bigint AS paid_cents,
 CASE WHEN payment_mode='paid' THEN 0 ELSE amount_cents-
 COALESCE((SELECT sum(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id AND NOT EXISTS(SELECT 1 FROM expense_payment_reversals r WHERE r.payment_id=p.id)),0)-
 COALESCE((SELECT sum(c.amount_cents) FROM expense_credits c WHERE c.expense_id=e.id),0) END::bigint AS balance_cents,
 COALESCE((SELECT sum(c.amount_cents) FROM expense_credits c WHERE c.expense_id=e.id),0)::bigint AS credited_cents,
 (amount_cents-COALESCE((SELECT sum(c.amount_cents) FROM expense_credits c WHERE c.expense_id=e.id),0))::bigint AS net_amount_cents,
 e.order_id,e.route_id FROM expenses e;
