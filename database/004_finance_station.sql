CREATE TABLE materials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE CHECK(length(trim(name))>0),
 category text NOT NULL CHECK(category IN ('landfill','recycling','green_waste','construction','metal')),
 rate_cents_per_tonne integer NOT NULL CHECK(rate_cents_per_tonne BETWEEN 0 AND 10000000),
 minimum_charge_cents integer NOT NULL DEFAULT 0 CHECK(minimum_charge_cents BETWEEN 0 AND 100000000), active boolean NOT NULL DEFAULT true
);
CREATE TABLE scale_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 customer_id uuid NOT NULL REFERENCES customers(id), material_id uuid NOT NULL REFERENCES materials(id),
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')), vehicle_number text NOT NULL CHECK(length(trim(vehicle_number))>0),
 first_weight_kg integer NOT NULL CHECK(first_weight_kg BETWEEN 0 AND 1000000), second_weight_kg integer CHECK(second_weight_kg BETWEEN 0 AND 1000000),
 gross_kg integer GENERATED ALWAYS AS (CASE WHEN direction='inbound' THEN first_weight_kg ELSE second_weight_kg END) STORED,
 tare_kg integer GENERATED ALWAYS AS (CASE WHEN direction='inbound' THEN second_weight_kg ELSE first_weight_kg END) STORED,
 net_kg integer GENERATED ALWAYS AS (CASE WHEN direction='inbound' THEN first_weight_kg-second_weight_kg ELSE second_weight_kg-first_weight_kg END) STORED,
 rate_cents_per_tonne integer NOT NULL, minimum_charge_cents integer NOT NULL,
 source text NOT NULL CHECK(source IN ('manual','scale')), source_reference text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','weighed','invoiced','void')),
 version integer NOT NULL DEFAULT 1, actor_id uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(second_weight_kg IS NULL OR (direction='inbound' AND first_weight_kg>=second_weight_kg) OR (direction='outbound' AND second_weight_kg>=first_weight_kg)),
 CHECK((status='open' AND second_weight_kg IS NULL) OR status='void' OR (status IN ('weighed','invoiced') AND second_weight_kg IS NOT NULL))
);
ALTER TABLE invoices ADD COLUMN scale_ticket_id uuid UNIQUE REFERENCES scale_tickets(id);
ALTER TABLE invoices DROP CONSTRAINT invoices_check;
ALTER TABLE invoices ADD CHECK(num_nonnulls(order_id,rental_id,scale_ticket_id)=1);
ALTER TABLE invoices ADD COLUMN due_date date NOT NULL DEFAULT CURRENT_DATE+30;
ALTER TABLE journal DROP CONSTRAINT journal_invoice_id_key;
ALTER TABLE journal ALTER COLUMN invoice_id DROP NOT NULL;
ALTER TABLE journal ADD COLUMN source_kind text NOT NULL DEFAULT 'invoice';
ALTER TABLE journal ADD COLUMN source_id uuid;
CREATE UNIQUE INDEX journal_source_once ON journal(source_kind,source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX journal_invoice_once ON journal(invoice_id) WHERE source_kind='invoice';
CREATE TABLE payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES invoices(id),
 customer_id uuid NOT NULL REFERENCES customers(id), amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 method text NOT NULL CHECK(method IN ('cash','check','stripe')), reference text NOT NULL,
 actor_id uuid REFERENCES employees(id), paid_at timestamptz NOT NULL DEFAULT now(), UNIQUE(method,reference)
);
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL REFERENCES payments(id),
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000), reason text NOT NULL,
 reference text NOT NULL UNIQUE, actor_id uuid REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refunds_immutable BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE payment_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES invoices(id),
 amount_cents integer NOT NULL CHECK(amount_cents>0), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','expired','review')),
 provider_session_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE provider_events (
 id text PRIMARY KEY, kind text NOT NULL, object_id text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER provider_events_immutable BEFORE UPDATE OR DELETE ON provider_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category text NOT NULL CHECK(category IN ('fuel','repair','maintenance','disposal','office','other')),
 vendor text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 expense_date date NOT NULL, truck_id uuid REFERENCES trucks(id), reference text NOT NULL UNIQUE,
 actor_id uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER expenses_immutable BEFORE UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 kind text NOT NULL, subject text NOT NULL, message text NOT NULL, read_at timestamptz,
 source_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notification_id uuid NOT NULL REFERENCES notifications(id),
 channel text NOT NULL CHECK(channel IN ('email','sms')), destination text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed')), attempts integer NOT NULL DEFAULT 0,
 provider_id text, next_attempt_at timestamptz NOT NULL DEFAULT now(), UNIQUE(notification_id,channel)
);
