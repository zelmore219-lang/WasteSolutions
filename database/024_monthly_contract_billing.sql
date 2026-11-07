ALTER TABLE service_agreements ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE service_agreements ADD COLUMN billing_mode text NOT NULL DEFAULT 'per_service' CHECK(billing_mode IN ('per_service','monthly'));
ALTER TABLE service_agreements ADD COLUMN monthly_rate_cents integer CHECK(monthly_rate_cents BETWEEN 0 AND 100000000);
ALTER TABLE service_agreements ADD COLUMN contract_start_date date;
ALTER TABLE service_agreements ADD COLUMN contract_end_date date;
ALTER TABLE service_agreements ADD COLUMN next_billing_month date;
ALTER TABLE service_agreements ADD CHECK(billing_mode='per_service' OR (monthly_rate_cents IS NOT NULL AND contract_start_date IS NOT NULL AND next_billing_month IS NOT NULL));
ALTER TABLE service_agreements ADD CHECK(contract_end_date IS NULL OR contract_end_date>=contract_start_date);
CREATE TABLE monthly_billing_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agreement_id uuid NOT NULL REFERENCES service_agreements(id),
 period_start date NOT NULL,period_end date NOT NULL,active_from date NOT NULL,active_through date NOT NULL,
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 0 AND 100000000),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(agreement_id,period_start),
 CHECK(period_start<=active_from AND active_from<=active_through AND active_through<=period_end)
);
CREATE TRIGGER monthly_billing_immutable BEFORE UPDATE OR DELETE ON monthly_billing_periods FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE invoices ADD COLUMN monthly_period_id uuid UNIQUE REFERENCES monthly_billing_periods(id);
ALTER TABLE invoices DROP CONSTRAINT invoices_check;
ALTER TABLE invoices ADD CHECK(num_nonnulls(order_id,rental_id,scale_ticket_id,migration_balance_id,monthly_period_id)=1);
CREATE TABLE monthly_invoice_orders (
 invoice_id uuid NOT NULL REFERENCES invoices(id),order_id uuid PRIMARY KEY REFERENCES orders(id)
);
CREATE TRIGGER monthly_invoice_orders_immutable BEFORE UPDATE OR DELETE ON monthly_invoice_orders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP VIEW invoice_balances;
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
