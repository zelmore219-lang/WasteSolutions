ALTER TABLE service_agreements ADD COLUMN billing_timing text NOT NULL DEFAULT 'arrears' CHECK(billing_timing IN ('arrears','advance')),
 ADD CHECK(billing_mode='monthly' OR billing_timing='arrears');
ALTER TABLE monthly_billing_periods ADD COLUMN billing_timing text NOT NULL DEFAULT 'arrears' CHECK(billing_timing IN ('arrears','advance'));
CREATE TABLE contract_revenue_recognitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),period_id uuid NOT NULL UNIQUE REFERENCES monthly_billing_periods(id),
 invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 0 AND 100000000),
 credited_cents integer NOT NULL CHECK(credited_cents>=0),active_through date NOT NULL,
 posting_date date NOT NULL,order_ids uuid[] NOT NULL,actor_id uuid NOT NULL REFERENCES employees(id),recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER contract_recognition_immutable BEFORE UPDATE OR DELETE ON contract_revenue_recognitions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
