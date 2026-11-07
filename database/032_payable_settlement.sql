ALTER TABLE expenses ADD COLUMN due_date date;
-- Preserve any manually entered legacy payable as due on its original bill date.
ALTER TABLE expenses DISABLE TRIGGER expenses_immutable;
UPDATE expenses SET due_date=expense_date WHERE payment_mode='payable';
ALTER TABLE expenses ENABLE TRIGGER expenses_immutable;
ALTER TABLE expenses ADD CONSTRAINT payable_due_date CHECK ((payment_mode='paid' AND due_date IS NULL) OR (payment_mode='payable' AND due_date IS NOT NULL AND due_date>=expense_date));
ALTER TABLE expense_payments ADD COLUMN method text NOT NULL DEFAULT 'check' CHECK(method IN ('cash','check','bank_transfer')),
 ADD COLUMN payment_date date;
ALTER TABLE expense_payments DISABLE TRIGGER expense_payments_immutable;
UPDATE expense_payments SET payment_date=paid_at::date;
ALTER TABLE expense_payments ENABLE TRIGGER expense_payments_immutable;
ALTER TABLE expense_payments ALTER COLUMN payment_date SET NOT NULL;
CREATE VIEW expense_balances AS
 SELECT e.*,CASE WHEN payment_mode='paid' THEN amount_cents ELSE COALESCE((SELECT sum(amount_cents) FROM expense_payments p WHERE p.expense_id=e.id),0) END::bigint AS paid_cents,
 CASE WHEN payment_mode='paid' THEN 0 ELSE amount_cents-COALESCE((SELECT sum(amount_cents) FROM expense_payments p WHERE p.expense_id=e.id),0) END::bigint AS balance_cents FROM expenses e;
