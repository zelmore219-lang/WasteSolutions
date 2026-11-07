CREATE TABLE invoice_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES invoices(id),
 kind text NOT NULL CHECK(kind IN ('credit','late_fee')), amount_cents integer NOT NULL CHECK(amount_cents<>0 AND amount_cents BETWEEN -100000000 AND 100000000),
 reason text NOT NULL, actor_id uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='credit' AND amount_cents<0) OR (kind='late_fee' AND amount_cents>0))
);
CREATE UNIQUE INDEX invoice_one_late_fee ON invoice_adjustments(invoice_id) WHERE kind='late_fee';
CREATE TRIGGER adjustments_immutable BEFORE UPDATE OR DELETE ON invoice_adjustments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE invoice_credit_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES invoices(id),
 adjustment_id uuid NOT NULL UNIQUE REFERENCES invoice_adjustments(id), credit_id uuid NOT NULL UNIQUE REFERENCES customer_credits(id),
 amount_cents integer NOT NULL CHECK(amount_cents>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER credit_transfers_immutable BEFORE UPDATE OR DELETE ON invoice_credit_transfers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE VIEW invoice_balances AS
 SELECT i.*,
 i.amount_cents+COALESCE((SELECT sum(amount_cents) FROM invoice_adjustments WHERE invoice_id=i.id),0) AS net_amount_cents,
 COALESCE((SELECT sum(amount_cents) FROM payments WHERE invoice_id=i.id),0) AS received_cents,
 COALESCE((SELECT sum(r.amount_cents) FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.invoice_id=i.id),0) AS refunded_cents,
 COALESCE((SELECT sum(amount_cents) FROM invoice_credit_transfers WHERE invoice_id=i.id),0) AS credit_transferred_cents,
 i.amount_cents+COALESCE((SELECT sum(amount_cents) FROM invoice_adjustments WHERE invoice_id=i.id),0)
 -COALESCE((SELECT sum(amount_cents) FROM payments WHERE invoice_id=i.id),0)
 +COALESCE((SELECT sum(r.amount_cents) FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.invoice_id=i.id),0)
 +COALESCE((SELECT sum(amount_cents) FROM invoice_credit_transfers WHERE invoice_id=i.id),0) AS balance_cents
 FROM invoices i;
ALTER TABLE expenses ADD COLUMN payment_mode text NOT NULL DEFAULT 'paid' CHECK(payment_mode IN ('paid','payable'));
CREATE TABLE expense_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), expense_id uuid NOT NULL REFERENCES expenses(id), amount_cents integer NOT NULL CHECK(amount_cents>0),
 reference text NOT NULL UNIQUE, actor_id uuid NOT NULL REFERENCES employees(id), paid_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER expense_payments_immutable BEFORE UPDATE OR DELETE ON expense_payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE company_settings ADD COLUMN late_fee_cents integer NOT NULL DEFAULT 0 CHECK(late_fee_cents BETWEEN 0 AND 10000000);
ALTER TABLE company_settings ADD COLUMN late_fee_grace_days integer NOT NULL DEFAULT 0 CHECK(late_fee_grace_days BETWEEN 0 AND 365);
CREATE TABLE stripe_profiles (
 customer_id uuid PRIMARY KEY REFERENCES customers(id), provider_customer_id text NOT NULL UNIQUE,
 default_payment_method_id text, autopay_enabled boolean NOT NULL DEFAULT false,
 consent_at timestamptz, consent_actor_id uuid REFERENCES employees(id), consent_version text, max_charge_cents integer NOT NULL DEFAULT 100000 CHECK(max_charge_cents BETWEEN 1 AND 100000000)
);
CREATE TABLE payment_setup_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id), actor_id uuid NOT NULL REFERENCES employees(id),
 enable_autopay boolean NOT NULL, max_charge_cents integer NOT NULL, provider_session_id text UNIQUE, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payment_attempts ADD COLUMN source text NOT NULL DEFAULT 'checkout' CHECK(source IN ('checkout','autopay'));
CREATE UNIQUE INDEX invoice_one_autopay_attempt ON payment_attempts(invoice_id) WHERE source='autopay';
CREATE TABLE automation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_date date NOT NULL UNIQUE, actor_id uuid NOT NULL REFERENCES employees(id),
 status text NOT NULL CHECK(status IN ('running','completed','failed')), attempts integer NOT NULL DEFAULT 1,
 summary jsonb NOT NULL DEFAULT '{}', started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE FUNCTION validate_invoice_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE net bigint;
BEGIN
 SELECT amount_cents INTO net FROM invoices WHERE id=NEW.invoice_id FOR UPDATE;
 SELECT net+COALESCE(sum(amount_cents),0) INTO net FROM invoice_adjustments WHERE invoice_id=NEW.invoice_id;
 IF net+NEW.amount_cents<0 OR net+NEW.amount_cents>100000000 THEN RAISE EXCEPTION 'Invoice adjustment exceeds supported amount' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_adjustment BEFORE INSERT ON invoice_adjustments FOR EACH ROW EXECUTE FUNCTION validate_invoice_adjustment();
