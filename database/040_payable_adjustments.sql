CREATE TABLE expense_credits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),expense_id uuid NOT NULL REFERENCES expenses(id),
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),credit_date date NOT NULL,
 reference text NOT NULL UNIQUE CHECK(length(trim(reference)) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 actor_id uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expense_credits_bill ON expense_credits(expense_id,credit_date);
CREATE TRIGGER expense_credits_immutable BEFORE UPDATE OR DELETE ON expense_credits FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE expense_payment_reversals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_id uuid NOT NULL UNIQUE REFERENCES expense_payments(id),
 reversal_date date NOT NULL,reference text NOT NULL UNIQUE CHECK(length(trim(reference)) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 actor_id uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER expense_reversals_immutable BEFORE UPDATE OR DELETE ON expense_payment_reversals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE OR REPLACE VIEW expense_balances AS
 SELECT e.*,
 CASE WHEN payment_mode='paid' THEN amount_cents ELSE
 COALESCE((SELECT sum(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id AND NOT EXISTS(SELECT 1 FROM expense_payment_reversals r WHERE r.payment_id=p.id)),0) END::bigint AS paid_cents,
 CASE WHEN payment_mode='paid' THEN 0 ELSE amount_cents-
 COALESCE((SELECT sum(p.amount_cents) FROM expense_payments p WHERE p.expense_id=e.id AND NOT EXISTS(SELECT 1 FROM expense_payment_reversals r WHERE r.payment_id=p.id)),0)-
 COALESCE((SELECT sum(c.amount_cents) FROM expense_credits c WHERE c.expense_id=e.id),0) END::bigint AS balance_cents,
 COALESCE((SELECT sum(c.amount_cents) FROM expense_credits c WHERE c.expense_id=e.id),0)::bigint AS credited_cents,
 (amount_cents-COALESCE((SELECT sum(c.amount_cents) FROM expense_credits c WHERE c.expense_id=e.id),0))::bigint AS net_amount_cents
 FROM expenses e;
