-- Generated from the numbered CoreWaste migrations. Review before running.
-- Use a NEW dedicated Supabase project. Back up existing records before any upgrade.
BEGIN;
SET LOCAL search_path=public,extensions;
SELECT pg_advisory_xact_lock(hashtext('corewaste-migrations'));
DO $corewaste_fresh$ BEGIN IF to_regclass('public.schema_migrations') IS NULL AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e')) THEN RAISE EXCEPTION 'Use a new dedicated CoreWaste project; existing public tables were found.'; END IF; END $corewaste_fresh$;
DO $corewaste_existing$ BEGIN IF to_regclass('public.schema_migrations') IS NOT NULL THEN IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='001_initial') THEN RAISE EXCEPTION 'This migration history is not a CoreWaste installation. Use a dedicated project.'; END IF; END IF; END $corewaste_existing$;
CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());

-- 001_initial.sql
DO $corewaste_step_0$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='001_initial') THEN
 EXECUTE $corewaste_sql_0$
CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE employees (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), firebase_uid text NOT NULL UNIQUE,
 username text NOT NULL UNIQUE CHECK(username ~ '^[a-z0-9._-]{3,64}$'),
 display_name text NOT NULL, role text NOT NULL CHECK(role IN ('owner','manager','dispatcher','office','accountant','driver','customer')),
 customer_id uuid, active boolean NOT NULL DEFAULT true,
 CHECK ((role='customer') = (customer_id IS NOT NULL))
);
CREATE TABLE customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(trim(name))>0),
 kind text NOT NULL CHECK(kind IN ('residential','commercial')), email text NOT NULL,
 phone text NOT NULL DEFAULT '', billing_address text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE employees ADD FOREIGN KEY(customer_id) REFERENCES customers(id);
CREATE TABLE locations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 address text NOT NULL CHECK(length(trim(address))>0), instructions text NOT NULL DEFAULT '',
 UNIQUE(id,customer_id)
);
CREATE TABLE trucks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','maintenance','retired'))
);
CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 location_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('delivery','pickup','exchange','relocation','live_load','extra_pickup','bulk','disposal','recurring')),
 scheduled_date date NOT NULL, instructions text NOT NULL DEFAULT '', price_cents integer NOT NULL CHECK(price_cents>=0),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','assigned','in_progress','completed','failed','invoiced')),
 driver_id uuid REFERENCES employees(id), truck_id uuid REFERENCES trucks(id),
 version integer NOT NULL DEFAULT 1, completion_note text, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(location_id,customer_id) REFERENCES locations(id,customer_id),
 CHECK(status='new' OR (driver_id IS NOT NULL AND truck_id IS NOT NULL))
);
CREATE INDEX orders_driver_date ON orders(driver_id,scheduled_date);
CREATE TABLE order_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
 actor_id uuid NOT NULL REFERENCES employees(id), status text NOT NULL,
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 customer_id uuid NOT NULL REFERENCES customers(id), order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 amount_cents integer NOT NULL CHECK(amount_cents>=0), currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','void')),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Each journal row is a balanced posting, in integer USD cents. Append reversals; never edit history.
CREATE TABLE journal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),
 debit_account text NOT NULL, credit_account text NOT NULL,
 amount_cents integer NOT NULL CHECK(amount_cents>=0),
 CHECK(debit_account<>credit_account), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL REFERENCES employees(id),
 action text NOT NULL, entity_id uuid NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append-only record'; END $$;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON journal FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE commands (
 actor_id uuid NOT NULL REFERENCES employees(id), key text NOT NULL,
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,key)
);

$corewaste_sql_0$;
 INSERT INTO schema_migrations(version) VALUES('001_initial');
 END IF;
END $corewaste_step_0$;

-- 002_routes_requests.sql
DO $corewaste_step_1$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='002_routes_requests') THEN
 EXECUTE $corewaste_sql_1$
CREATE TABLE routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 service_date date NOT NULL, driver_id uuid NOT NULL REFERENCES employees(id), truck_id uuid NOT NULL REFERENCES trucks(id),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE route_stops (
 route_id uuid NOT NULL REFERENCES routes(id), order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 position integer NOT NULL CHECK(position>0), PRIMARY KEY(route_id,position)
);
CREATE TABLE service_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 location_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('extra_pickup','bulk','delivery','missed_pickup','support')),
 description text NOT NULL CHECK(length(trim(description))>0),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','converted','closed')),
 order_id uuid UNIQUE REFERENCES orders(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(location_id,customer_id) REFERENCES locations(id,customer_id)
);
CREATE TABLE service_agreements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 location_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('residential','commercial')),
 price_cents integer NOT NULL CHECK(price_cents>=0), interval_days integer NOT NULL CHECK(interval_days BETWEEN 1 AND 366),
 next_service_date date NOT NULL, active boolean NOT NULL DEFAULT true,
 FOREIGN KEY(location_id,customer_id) REFERENCES locations(id,customer_id)
);
ALTER TABLE orders ADD COLUMN agreement_id uuid REFERENCES service_agreements(id);
CREATE UNIQUE INDEX agreement_service_date ON orders(agreement_id,scheduled_date) WHERE agreement_id IS NOT NULL;

$corewaste_sql_1$;
 INSERT INTO schema_migrations(version) VALUES('002_routes_requests');
 END IF;
END $corewaste_step_1$;

-- 003_inventory_rentals.sql
DO $corewaste_step_2$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='003_inventory_rentals') THEN
 EXECUTE $corewaste_sql_2$
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE containers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number text NOT NULL UNIQUE CHECK(length(trim(number)) BETWEEN 1 AND 80),
 kind text NOT NULL CHECK(kind IN ('roll_off','commercial','cart','trailer')),
 capacity_yards numeric(6,2) NOT NULL CHECK(capacity_yards>0),
 status text NOT NULL DEFAULT 'yard' CHECK(status IN ('yard','deployed','maintenance','retired')),
 location_id uuid REFERENCES locations(id), version integer NOT NULL DEFAULT 1,
 CHECK((status='deployed')=(location_id IS NOT NULL)), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rentals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 location_id uuid NOT NULL, current_container_id uuid NOT NULL REFERENCES containers(id),
 start_date date NOT NULL, original_pickup_date date NOT NULL, pickup_date date NOT NULL,
 actual_pickup_date date, base_price_cents integer NOT NULL CHECK(base_price_cents BETWEEN 0 AND 100000000),
 extension_daily_cents integer NOT NULL CHECK(extension_daily_cents BETWEEN 0 AND 10000000),
 included_weight_kg integer NOT NULL CHECK(included_weight_kg>=0), overweight_cents_per_tonne integer NOT NULL CHECK(overweight_cents_per_tonne BETWEEN 0 AND 10000000),
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','delivered','collected','invoiced','cancelled')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(location_id,customer_id) REFERENCES locations(id,customer_id), CHECK(start_date<=original_pickup_date AND original_pickup_date<=pickup_date)
);
CREATE TABLE container_bookings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), container_id uuid NOT NULL REFERENCES containers(id),
 rental_id uuid NOT NULL REFERENCES rentals(id), start_date date NOT NULL, end_date_exclusive date NOT NULL,
 released boolean NOT NULL DEFAULT false, CHECK(start_date<end_date_exclusive),
 EXCLUDE USING gist(container_id WITH =, daterange(start_date,end_date_exclusive,'[)') WITH &&) WHERE (NOT released)
);
CREATE TABLE rental_jobs (
 order_id uuid PRIMARY KEY REFERENCES orders(id), rental_id uuid NOT NULL REFERENCES rentals(id),
 action text NOT NULL CHECK(action IN ('delivery','exchange','pickup')),
 container_id uuid NOT NULL REFERENCES containers(id), replacement_container_id uuid REFERENCES containers(id),
 CHECK((action='exchange')=(replacement_container_id IS NOT NULL)),
 CHECK(replacement_container_id IS NULL OR replacement_container_id<>container_id)
);
CREATE UNIQUE INDEX rental_one_delivery ON rental_jobs(rental_id) WHERE action='delivery';
CREATE UNIQUE INDEX rental_one_pickup ON rental_jobs(rental_id) WHERE action='pickup';
CREATE TABLE container_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), container_id uuid NOT NULL REFERENCES containers(id),
 rental_id uuid NOT NULL REFERENCES rentals(id), order_id uuid NOT NULL REFERENCES orders(id),
 action text NOT NULL CHECK(action IN ('delivered','collected')), location_id uuid NOT NULL REFERENCES locations(id),
 actor_id uuid NOT NULL REFERENCES employees(id), service_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,container_id,action)
);
CREATE TRIGGER container_movements_immutable BEFORE UPDATE OR DELETE ON container_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE disposal_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rental_id uuid NOT NULL REFERENCES rentals(id),
 order_id uuid NOT NULL UNIQUE REFERENCES orders(id), facility text NOT NULL, ticket_number text NOT NULL,
 gross_kg integer NOT NULL CHECK(gross_kg>0), tare_kg integer NOT NULL CHECK(tare_kg>=0 AND tare_kg<=gross_kg),
 net_kg integer GENERATED ALWAYS AS (gross_kg-tare_kg) STORED,
 disposal_cost_cents integer NOT NULL CHECK(disposal_cost_cents>=0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(facility,ticket_number)
);
CREATE TRIGGER disposal_tickets_immutable BEFORE UPDATE OR DELETE ON disposal_tickets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE invoices ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN rental_id uuid UNIQUE REFERENCES rentals(id);
ALTER TABLE invoices ADD CHECK(num_nonnulls(order_id,rental_id)=1);
CREATE TABLE invoice_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES invoices(id),
 description text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents>=0),
 UNIQUE(invoice_id,description)
);
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN ('new','assigned','in_progress','completed','failed','invoiced','cancelled'));
ALTER TABLE orders DROP CONSTRAINT orders_check;
ALTER TABLE orders ADD CHECK(status IN ('new','cancelled') OR (driver_id IS NOT NULL AND truck_id IS NOT NULL));

$corewaste_sql_2$;
 INSERT INTO schema_migrations(version) VALUES('003_inventory_rentals');
 END IF;
END $corewaste_step_2$;

-- 004_finance_station.sql
DO $corewaste_step_3$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='004_finance_station') THEN
 EXECUTE $corewaste_sql_3$
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

$corewaste_sql_3$;
 INSERT INTO schema_migrations(version) VALUES('004_finance_station');
 END IF;
END $corewaste_step_3$;

-- 005_customer_credits.sql
DO $corewaste_step_4$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='005_customer_credits') THEN
 EXECUTE $corewaste_sql_4$
CREATE TABLE customer_credits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 original_cents integer NOT NULL CHECK(original_cents>0), remaining_cents integer NOT NULL CHECK(remaining_cents>=0 AND remaining_cents<=original_cents),
 source_reference text NOT NULL UNIQUE, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CHECK(method IN ('cash','check','stripe','credit'));

$corewaste_sql_4$;
 INSERT INTO schema_migrations(version) VALUES('005_customer_credits');
 END IF;
END $corewaste_step_4$;

-- 006_administration_fleet.sql
DO $corewaste_step_5$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='006_administration_fleet') THEN
 EXECUTE $corewaste_sql_5$
CREATE TABLE company_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), name text NOT NULL DEFAULT 'CoreWaste',
 email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
 timezone text NOT NULL DEFAULT 'America/Chicago', invoice_terms_days integer NOT NULL DEFAULT 30 CHECK(invoice_terms_days BETWEEN 0 AND 365),
 version integer NOT NULL DEFAULT 1
);
INSERT INTO company_settings(singleton) VALUES(true);
CREATE TABLE vehicle_inspections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid NOT NULL REFERENCES trucks(id),
 driver_id uuid NOT NULL REFERENCES employees(id), kind text NOT NULL CHECK(kind IN ('pre_trip','post_trip')),
 odometer_km integer NOT NULL CHECK(odometer_km>=0), safe_to_operate boolean NOT NULL,
 notes text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(safe_to_operate OR length(trim(notes))>0)
);
CREATE TRIGGER vehicle_inspections_immutable BEFORE UPDATE OR DELETE ON vehicle_inspections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE maintenance_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), truck_id uuid NOT NULL REFERENCES trucks(id),
 description text NOT NULL, due_date date NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
 completion_notes text, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE driver_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid NOT NULL REFERENCES employees(id),
 recipient_id uuid NOT NULL REFERENCES employees(id), message text NOT NULL CHECK(length(trim(message))>0),
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(sender_id<>recipient_id)
);
CREATE FUNCTION initial_invoice_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.amount_cents=0 THEN NEW.status:='paid'; END IF;
 NEW.due_date:=CURRENT_DATE+(SELECT invoice_terms_days FROM company_settings WHERE singleton);
 RETURN NEW;
END $$;
CREATE TRIGGER invoices_initial_state BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION initial_invoice_state();

$corewaste_sql_5$;
 INSERT INTO schema_migrations(version) VALUES('006_administration_fleet');
 END IF;
END $corewaste_step_5$;

-- 007_imports_customer_controls.sql
DO $corewaste_step_6$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='007_imports_customer_controls') THEN
 EXECUTE $corewaste_sql_6$
ALTER TABLE locations ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE routes ADD COLUMN archived boolean NOT NULL DEFAULT false;
CREATE TABLE customer_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 note text NOT NULL CHECK(length(trim(note))>0), actor_id uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_notes_immutable BEFORE UPDATE OR DELETE ON customer_notes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE import_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('customers','locations','containers','agreements','orders','routes','opening_balances')),
 status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','applied','rolled_back')),
 actor_id uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz, rolled_back_at timestamptz
);
CREATE TABLE import_rows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES import_batches(id),
 row_number integer NOT NULL, payload jsonb NOT NULL, errors jsonb NOT NULL DEFAULT '[]', entity_id uuid, UNIQUE(batch_id,row_number)
);
CREATE TABLE imported_refs (
 kind text NOT NULL, external_id text NOT NULL, entity_id uuid NOT NULL, batch_id uuid NOT NULL REFERENCES import_batches(id), PRIMARY KEY(kind,external_id)
);
CREATE TABLE migration_balances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 batch_id uuid NOT NULL REFERENCES import_batches(id), amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 balance_date date NOT NULL, due_date date NOT NULL, source_reference text NOT NULL UNIQUE
);
ALTER TABLE invoices ADD COLUMN migration_balance_id uuid UNIQUE REFERENCES migration_balances(id);
ALTER TABLE invoices DROP CONSTRAINT invoices_check;
ALTER TABLE invoices ADD CHECK(num_nonnulls(order_id,rental_id,scale_ticket_id,migration_balance_id)=1);
ALTER TABLE invoices ALTER COLUMN due_date DROP DEFAULT;
CREATE OR REPLACE FUNCTION initial_invoice_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.amount_cents=0 THEN NEW.status:='paid'; END IF;
 NEW.due_date:=COALESCE(NEW.due_date,(SELECT (now() AT TIME ZONE timezone)::date+invoice_terms_days FROM company_settings WHERE singleton));
 RETURN NEW;
END $$;

$corewaste_sql_6$;
 INSERT INTO schema_migrations(version) VALUES('007_imports_customer_controls');
 END IF;
END $corewaste_step_6$;

-- 008_import_rollback_state.sql
DO $corewaste_step_7$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='008_import_rollback_state') THEN
 EXECUTE $corewaste_sql_7$
ALTER TABLE import_rows ADD COLUMN before_state jsonb;

$corewaste_sql_7$;
 INSERT INTO schema_migrations(version) VALUES('008_import_rollback_state');
 END IF;
END $corewaste_step_7$;

-- 009_customer_versions.sql
DO $corewaste_step_8$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='009_customer_versions') THEN
 EXECUTE $corewaste_sql_8$
ALTER TABLE customers ADD COLUMN version integer NOT NULL DEFAULT 1;

$corewaste_sql_8$;
 INSERT INTO schema_migrations(version) VALUES('009_customer_versions');
 END IF;
END $corewaste_step_8$;

-- 010_media_and_driver_locations.sql
DO $corewaste_step_9$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='010_media_and_driver_locations') THEN
 EXECUTE $corewaste_sql_9$
CREATE TABLE attachments (
 id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id), customer_id uuid REFERENCES customers(id),
 kind text NOT NULL CHECK(kind IN ('photo','document','signature')), filename text NOT NULL, content_type text NOT NULL,
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760), sha256 text NOT NULL,
 storage_driver text NOT NULL CHECK(storage_driver IN ('local','gcs')), storage_key text NOT NULL UNIQUE,
 visibility text NOT NULL CHECK(visibility IN ('office','customer')), actor_id uuid NOT NULL REFERENCES employees(id),
 signer_name text, signed_at timestamptz, consent_version text,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(num_nonnulls(order_id,customer_id)=1),
 CHECK(kind<>'signature' OR (signer_name IS NOT NULL AND signed_at IS NOT NULL AND consent_version IS NOT NULL))
);
CREATE TRIGGER attachments_immutable BEFORE UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE driver_locations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL REFERENCES employees(id),
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90), longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 accuracy_m double precision NOT NULL CHECK(accuracy_m>=0), recorded_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(driver_id,recorded_at)
);
CREATE INDEX driver_location_latest ON driver_locations(driver_id,recorded_at DESC);
ALTER TABLE order_events ADD COLUMN driver_id uuid REFERENCES employees(id);
ALTER TABLE order_events ADD COLUMN truck_id uuid REFERENCES trucks(id);
CREATE TABLE sync_exceptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL REFERENCES employees(id),
 order_id uuid NOT NULL REFERENCES orders(id), command_key text NOT NULL, original_version integer NOT NULL,
 reported_status text NOT NULL CHECK(reported_status IN ('in_progress','completed','failed')),
 note text NOT NULL, performed_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','rejected')),
 resolved_by uuid REFERENCES employees(id), resolution text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(driver_id,command_key)
);

$corewaste_sql_9$;
 INSERT INTO schema_migrations(version) VALUES('010_media_and_driver_locations');
 END IF;
END $corewaste_step_9$;

-- 011_capture_timestamps.sql
DO $corewaste_step_10$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='011_capture_timestamps') THEN
 EXECUTE $corewaste_sql_10$
ALTER TABLE attachments ADD COLUMN captured_at timestamptz;

$corewaste_sql_10$;
 INSERT INTO schema_migrations(version) VALUES('011_capture_timestamps');
 END IF;
END $corewaste_step_10$;

-- 012_public_site_portal_registration.sql
DO $corewaste_step_11$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='012_public_site_portal_registration') THEN
 EXECUTE $corewaste_sql_11$
CREATE TABLE public_inquiries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL, phone text NOT NULL,
 service_address text NOT NULL, service_kind text NOT NULL CHECK(service_kind IN ('residential','commercial','roll_off','bulk','other')),
 message text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','converted','closed')),
 order_id uuid REFERENCES orders(id), resolution text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE portal_registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), firebase_uid text NOT NULL UNIQUE, email text NOT NULL,
 name text NOT NULL, kind text NOT NULL CHECK(kind IN ('residential','commercial')), phone text NOT NULL,
 billing_address text NOT NULL, service_address text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 customer_id uuid REFERENCES customers(id), reviewed_by uuid REFERENCES employees(id), review_note text, created_at timestamptz NOT NULL DEFAULT now()
);

$corewaste_sql_11$;
 INSERT INTO schema_migrations(version) VALUES('012_public_site_portal_registration');
 END IF;
END $corewaste_step_11$;

-- 013_public_inquiry_idempotency.sql
DO $corewaste_step_12$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='013_public_inquiry_idempotency') THEN
 EXECUTE $corewaste_sql_12$
ALTER TABLE public_inquiries ADD COLUMN request_id uuid UNIQUE;
ALTER TABLE public_inquiries ADD COLUMN request_hash text;

$corewaste_sql_12$;
 INSERT INTO schema_migrations(version) VALUES('013_public_inquiry_idempotency');
 END IF;
END $corewaste_step_12$;

-- 014_billing_controls.sql
DO $corewaste_step_13$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='014_billing_controls') THEN
 EXECUTE $corewaste_sql_13$
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

$corewaste_sql_13$;
 INSERT INTO schema_migrations(version) VALUES('014_billing_controls');
 END IF;
END $corewaste_step_13$;

-- 015_customer_credit_refunds.sql
DO $corewaste_step_14$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='015_customer_credit_refunds') THEN
 EXECUTE $corewaste_sql_14$
CREATE TABLE customer_credit_refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), credit_id uuid NOT NULL REFERENCES customer_credits(id),
 amount_cents integer NOT NULL CHECK(amount_cents>0), method text NOT NULL CHECK(method IN ('cash','check')),
 reference text NOT NULL UNIQUE, reason text NOT NULL, actor_id uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_credit_refunds_immutable BEFORE UPDATE OR DELETE ON customer_credit_refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

$corewaste_sql_14$;
 INSERT INTO schema_migrations(version) VALUES('015_customer_credit_refunds');
 END IF;
END $corewaste_step_14$;

-- 016_payment_setup_versions.sql
DO $corewaste_step_15$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='016_payment_setup_versions') THEN
 EXECUTE $corewaste_sql_15$
ALTER TABLE stripe_profiles ADD COLUMN settings_version integer NOT NULL DEFAULT 1;
ALTER TABLE payment_setup_requests ADD COLUMN settings_version integer NOT NULL DEFAULT 1;
ALTER TABLE payment_setup_requests ADD COLUMN state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','cancelled'));
ALTER TABLE journal ADD COLUMN posting_date date;

$corewaste_sql_15$;
 INSERT INTO schema_migrations(version) VALUES('016_payment_setup_versions');
 END IF;
END $corewaste_step_15$;

-- 017_operation_indexes.sql
DO $corewaste_step_16$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='017_operation_indexes') THEN
 EXECUTE $corewaste_sql_16$
CREATE INDEX payments_invoice ON payments(invoice_id);
CREATE INDEX refunds_payment ON refunds(payment_id);
CREATE INDEX adjustments_invoice ON invoice_adjustments(invoice_id);
CREATE INDEX transfers_invoice ON invoice_credit_transfers(invoice_id);
CREATE INDEX expense_payments_expense ON expense_payments(expense_id);
CREATE INDEX orders_customer_date ON orders(customer_id,scheduled_date);
CREATE INDEX orders_status_date ON orders(status,scheduled_date);
CREATE INDEX invoices_customer_created ON invoices(customer_id,created_at);
CREATE INDEX notifications_customer_created ON notifications(customer_id,created_at DESC);
CREATE INDEX outbox_pending_delivery ON notification_outbox(state,next_attempt_at);
CREATE INDEX customer_notes_account ON customer_notes(customer_id,created_at DESC);
CREATE INDEX messages_recipient_created ON driver_messages(recipient_id,created_at DESC);
CREATE INDEX journal_invoice ON journal(invoice_id);
CREATE INDEX journal_created ON journal(created_at);

$corewaste_sql_16$;
 INSERT INTO schema_migrations(version) VALUES('017_operation_indexes');
 END IF;
END $corewaste_step_16$;

-- 018_notification_delivery.sql
DO $corewaste_step_17$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='018_notification_delivery') THEN
 EXECUTE $corewaste_sql_17$
CREATE TABLE notification_preferences (
 customer_id uuid PRIMARY KEY REFERENCES customers(id), email_enabled boolean NOT NULL DEFAULT true,
 sms_enabled boolean NOT NULL DEFAULT false, sms_consent_at timestamptz, updated_by uuid NOT NULL REFERENCES employees(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_templates (
 kind text PRIMARY KEY, subject text NOT NULL, message text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1
);
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_state_check;
ALTER TABLE notification_outbox ADD CHECK(state IN ('pending','sending','sent','failed','uncertain','cancelled'));
ALTER TABLE notification_outbox ADD COLUMN rendered_subject text;
ALTER TABLE notification_outbox ADD COLUMN rendered_body text;
ALTER TABLE notification_outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE notification_outbox ADD COLUMN delivery_token uuid;
ALTER TABLE notification_outbox ADD COLUMN first_attempt_at timestamptz;
ALTER TABLE notification_outbox ADD COLUMN last_error_code text;

$corewaste_sql_17$;
 INSERT INTO schema_migrations(version) VALUES('018_notification_delivery');
 END IF;
END $corewaste_step_17$;

-- 019_quickbooks_integration.sql
DO $corewaste_step_18$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='019_quickbooks_integration') THEN
 EXECUTE $corewaste_sql_18$
CREATE TABLE quickbooks_oauth_states (
 state_hash text PRIMARY KEY, actor_id uuid NOT NULL REFERENCES employees(id),
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quickbooks_connection (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), realm_id text NOT NULL,
 company_name text NOT NULL, mode text NOT NULL CHECK(mode IN ('sandbox','production')),
 status text NOT NULL CHECK(status IN ('pending_review','active','needs_reauthorization')),
 encrypted_tokens text NOT NULL, expires_at timestamptz NOT NULL, connected_by uuid NOT NULL REFERENCES employees(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quickbooks_account_mappings (
 local_account text PRIMARY KEY, remote_account_id text NOT NULL, remote_account_name text NOT NULL,
 remote_account_type text NOT NULL, updated_by uuid NOT NULL REFERENCES employees(id)
);
CREATE TABLE quickbooks_customers (
 customer_id uuid PRIMARY KEY REFERENCES customers(id), remote_id text NOT NULL UNIQUE
);
CREATE TABLE quickbooks_exports (
 journal_id uuid PRIMARY KEY REFERENCES journal(id), remote_id text NOT NULL UNIQUE, realm_id text NOT NULL,
 exported_by uuid NOT NULL REFERENCES employees(id), exported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER quickbooks_exports_immutable BEFORE UPDATE OR DELETE ON quickbooks_exports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

$corewaste_sql_18$;
 INSERT INTO schema_migrations(version) VALUES('019_quickbooks_integration');
 END IF;
END $corewaste_step_18$;

-- 020_accounting_export_attempts.sql
DO $corewaste_step_19$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='020_accounting_export_attempts') THEN
 EXECUTE $corewaste_sql_19$
CREATE TABLE quickbooks_export_attempts (
 journal_id uuid PRIMARY KEY REFERENCES journal(id), realm_id text NOT NULL,
 document jsonb NOT NULL, attempted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_export_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.journal_id<>OLD.journal_id OR NEW.realm_id<>OLD.realm_id OR NEW.document<>OLD.document
 THEN RAISE EXCEPTION 'Accounting export document is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER export_document_immutable BEFORE UPDATE ON quickbooks_export_attempts FOR EACH ROW EXECUTE FUNCTION protect_export_document();

$corewaste_sql_19$;
 INSERT INTO schema_migrations(version) VALUES('020_accounting_export_attempts');
 END IF;
END $corewaste_step_19$;

-- 021_service_arrivals.sql
DO $corewaste_step_20$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='021_service_arrivals') THEN
 EXECUTE $corewaste_sql_20$
ALTER TABLE orders ADD COLUMN arrived_at timestamptz;
ALTER TABLE order_events ADD COLUMN performed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sync_exceptions DROP CONSTRAINT sync_exceptions_reported_status_check;
ALTER TABLE sync_exceptions ADD CHECK(reported_status IN ('in_progress','arrived','completed','failed'));

$corewaste_sql_20$;
 INSERT INTO schema_migrations(version) VALUES('021_service_arrivals');
 END IF;
END $corewaste_step_20$;

-- 022_inspection_capture.sql
DO $corewaste_step_21$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='022_inspection_capture') THEN
 EXECUTE $corewaste_sql_21$
ALTER TABLE vehicle_inspections ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT now();

$corewaste_sql_21$;
 INSERT INTO schema_migrations(version) VALUES('022_inspection_capture');
 END IF;
END $corewaste_step_21$;

-- 023_order_tasks.sql
DO $corewaste_step_22$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='023_order_tasks') THEN
 EXECUTE $corewaste_sql_22$
CREATE TABLE order_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id),
 label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 500),required boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 completed_by uuid REFERENCES employees(id),completed_at timestamptz,completion_note text NOT NULL DEFAULT '',
 CHECK((completed_by IS NULL)=(completed_at IS NULL))
);
CREATE INDEX order_tasks_order ON order_tasks(order_id);

$corewaste_sql_22$;
 INSERT INTO schema_migrations(version) VALUES('023_order_tasks');
 END IF;
END $corewaste_step_22$;

-- 024_monthly_contract_billing.sql
DO $corewaste_step_23$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='024_monthly_contract_billing') THEN
 EXECUTE $corewaste_sql_23$
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

$corewaste_sql_23$;
 INSERT INTO schema_migrations(version) VALUES('024_monthly_contract_billing');
 END IF;
END $corewaste_step_23$;

-- 025_service_calendar.sql
DO $corewaste_step_24$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='025_service_calendar') THEN
 EXECUTE $corewaste_sql_24$
CREATE TABLE service_zones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 120),
 description text NOT NULL DEFAULT '',weekdays integer[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6])
);
ALTER TABLE locations ADD COLUMN zone_id uuid REFERENCES service_zones(id);
ALTER TABLE orders ADD COLUMN zone_id uuid REFERENCES service_zones(id);
ALTER TABLE orders ADD COLUMN service_occurrence_date date;
UPDATE orders SET service_occurrence_date=scheduled_date WHERE agreement_id IS NOT NULL;
DROP INDEX agreement_service_date;
CREATE UNIQUE INDEX agreement_occurrence_once ON orders(agreement_id,service_occurrence_date) WHERE agreement_id IS NOT NULL;
CREATE TABLE service_calendar_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),zone_id uuid REFERENCES service_zones(id),
 original_date date NOT NULL,replacement_date date NOT NULL,reason text NOT NULL CHECK(length(trim(reason))>0),
 version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES employees(id),
 UNIQUE NULLS NOT DISTINCT(zone_id,original_date),
 CHECK(abs(replacement_date-original_date) BETWEEN 1 AND 14)
);
CREATE INDEX orders_zone_scheduled ON orders(zone_id,scheduled_date);

$corewaste_sql_24$;
 INSERT INTO schema_migrations(version) VALUES('025_service_calendar');
 END IF;
END $corewaste_step_24$;

-- 026_service_date_conflicts.sql
DO $corewaste_step_25$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='026_service_date_conflicts') THEN
 EXECUTE $corewaste_sql_25$
ALTER TABLE orders ADD CONSTRAINT agreement_actual_date_once EXCLUDE USING gist
 (agreement_id WITH =,scheduled_date WITH =)
 WHERE (agreement_id IS NOT NULL AND status<>'cancelled')
 DEFERRABLE INITIALLY DEFERRED;

$corewaste_sql_25$;
 INSERT INTO schema_migrations(version) VALUES('026_service_date_conflicts');
 END IF;
END $corewaste_step_25$;

-- 027_loaded_container_disposal.sql
DO $corewaste_step_26$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='027_loaded_container_disposal') THEN
 EXECUTE $corewaste_sql_26$
ALTER TABLE containers DROP CONSTRAINT containers_status_check;
ALTER TABLE containers ADD CHECK(status IN ('yard','deployed','awaiting_disposal','maintenance','retired'));
CREATE TABLE disposal_loads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 rental_id uuid NOT NULL REFERENCES rentals(id),container_id uuid NOT NULL REFERENCES containers(id),
 assigned_driver_id uuid REFERENCES employees(id),assigned_truck_id uuid REFERENCES trucks(id),
 status text NOT NULL DEFAULT 'awaiting_disposal' CHECK(status IN ('awaiting_disposal','disposal_failed','review_required','disposed')),
 version integer NOT NULL DEFAULT 1,last_failure_reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),
 disposed_at timestamptz,disposal_ticket_id uuid UNIQUE REFERENCES disposal_tickets(id)
);
CREATE TABLE disposal_load_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),load_id uuid NOT NULL REFERENCES disposal_loads(id),
 actor_id uuid NOT NULL REFERENCES employees(id),action text NOT NULL,note text NOT NULL DEFAULT '',
 performed_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER disposal_load_events_immutable BEFORE UPDATE OR DELETE ON disposal_load_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
INSERT INTO disposal_loads(order_id,rental_id,container_id,assigned_driver_id,assigned_truck_id,status)
 SELECT j.order_id,j.rental_id,j.container_id,o.driver_id,o.truck_id,
 CASE WHEN c.status='deployed' THEN 'review_required' ELSE 'awaiting_disposal' END
 FROM rental_jobs j JOIN orders o ON o.id=j.order_id JOIN containers c ON c.id=j.container_id
 WHERE j.action IN ('exchange','pickup') AND o.status IN ('completed','invoiced')
 AND NOT EXISTS(SELECT 1 FROM disposal_tickets t WHERE t.order_id=j.order_id);
UPDATE containers c SET status='awaiting_disposal',version=version+1
 WHERE c.status='yard' AND EXISTS(SELECT 1 FROM disposal_loads d WHERE d.container_id=c.id AND d.status<>'disposed');
CREATE INDEX disposal_load_assignee_status ON disposal_loads(assigned_driver_id,status);

$corewaste_sql_26$;
 INSERT INTO schema_migrations(version) VALUES('027_loaded_container_disposal');
 END IF;
END $corewaste_step_26$;

-- 028_independent_driver_tasks.sql
DO $corewaste_step_27$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='028_independent_driver_tasks') THEN
 EXECUTE $corewaste_sql_27$
CREATE TABLE driver_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '',address text NOT NULL DEFAULT '',scheduled_date date NOT NULL,
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','assigned','in_progress','completed','failed','cancelled')),
 driver_id uuid REFERENCES employees(id),truck_id uuid REFERENCES trucks(id),version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,completed_at timestamptz,completion_note text NOT NULL DEFAULT '',
 CHECK(status IN ('new','cancelled') OR driver_id IS NOT NULL)
);
CREATE INDEX driver_tasks_schedule ON driver_tasks(driver_id,scheduled_date,status);
CREATE TABLE driver_task_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES driver_tasks(id),
 actor_id uuid NOT NULL REFERENCES employees(id),driver_id uuid REFERENCES employees(id),status text NOT NULL,
 note text NOT NULL DEFAULT '',performed_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER driver_task_events_immutable BEFORE UPDATE OR DELETE ON driver_task_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

$corewaste_sql_27$;
 INSERT INTO schema_migrations(version) VALUES('028_independent_driver_tasks');
 END IF;
END $corewaste_step_27$;

-- 029_offline_action_review.sql
DO $corewaste_step_28$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='029_offline_action_review') THEN
 EXECUTE $corewaste_sql_28$
CREATE TABLE driver_action_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),driver_id uuid NOT NULL REFERENCES employees(id),command_key text NOT NULL,
 original_action jsonb NOT NULL,performed_at timestamptz NOT NULL,entity_label text NOT NULL,
 already_committed boolean NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','rejected')),
 resolution text NOT NULL DEFAULT '',reviewed_by uuid REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(driver_id,command_key)
);
CREATE FUNCTION protect_driver_action_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.driver_id<>OLD.driver_id OR NEW.command_key<>OLD.command_key OR NEW.original_action<>OLD.original_action OR NEW.performed_at<>OLD.performed_at OR NEW.entity_label<>OLD.entity_label OR NEW.already_committed<>OLD.already_committed
 THEN RAISE EXCEPTION 'Offline evidence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER offline_action_proof_immutable BEFORE UPDATE ON driver_action_reviews FOR EACH ROW EXECUTE FUNCTION protect_driver_action_proof();
CREATE TRIGGER offline_action_proof_no_delete BEFORE DELETE ON driver_action_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

$corewaste_sql_28$;
 INSERT INTO schema_migrations(version) VALUES('029_offline_action_review');
 END IF;
END $corewaste_step_28$;

-- 030_linked_priority_orders.sql
DO $corewaste_step_29$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='030_linked_priority_orders') THEN
 EXECUTE $corewaste_sql_29$
ALTER TABLE orders ADD COLUMN number bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE orders ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent'));
ALTER TABLE orders ADD COLUMN parent_order_id uuid;
ALTER TABLE orders ADD COLUMN depends_on_parent boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD UNIQUE(id,customer_id);
ALTER TABLE orders ADD FOREIGN KEY(parent_order_id,customer_id) REFERENCES orders(id,customer_id);
ALTER TABLE orders ADD CHECK(parent_order_id IS NULL OR parent_order_id<>id);
ALTER TABLE orders ADD CHECK(NOT depends_on_parent OR parent_order_id IS NOT NULL);
CREATE INDEX orders_parent ON orders(parent_order_id) WHERE parent_order_id IS NOT NULL;
CREATE INDEX orders_priority_date ON orders(priority,scheduled_date,status);

$corewaste_sql_29$;
 INSERT INTO schema_migrations(version) VALUES('030_linked_priority_orders');
 END IF;
END $corewaste_step_29$;

-- 031_road_planning.sql
DO $corewaste_step_30$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='031_road_planning') THEN
 EXECUTE $corewaste_sql_30$
ALTER TABLE locations ADD COLUMN routing_longitude double precision,
 ADD COLUMN routing_latitude double precision,
 ADD COLUMN routing_note text,
 ADD COLUMN routing_verified_by uuid REFERENCES employees(id),
 ADD COLUMN routing_verified_at timestamptz,
 ADD COLUMN routing_version integer NOT NULL DEFAULT 1,
 ADD CONSTRAINT location_routing_pin CHECK (
 (routing_longitude IS NULL AND routing_latitude IS NULL AND routing_verified_at IS NULL) OR
 (routing_longitude IS NOT NULL AND routing_latitude IS NOT NULL AND routing_note IS NOT NULL AND routing_longitude BETWEEN -180 AND 180 AND routing_latitude BETWEEN -85 AND 85 AND routing_verified_at IS NOT NULL AND routing_verified_by IS NOT NULL AND length(trim(routing_note))>0));
CREATE FUNCTION invalidate_routing_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.address IS DISTINCT FROM OLD.address THEN
  NEW.routing_longitude=NULL; NEW.routing_latitude=NULL; NEW.routing_note=NULL;
  NEW.routing_verified_by=NULL; NEW.routing_verified_at=NULL;
  NEW.routing_version=OLD.routing_version+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER location_address_routing BEFORE UPDATE OF address ON locations FOR EACH ROW EXECUTE FUNCTION invalidate_routing_pin();
CREATE TABLE truck_routing_profiles (
 truck_id uuid PRIMARY KEY REFERENCES trucks(id),
 height_cm integer NOT NULL CHECK(height_cm BETWEEN 100 AND 600),
 width_cm integer NOT NULL CHECK(width_cm BETWEEN 100 AND 500),
 length_cm integer NOT NULL CHECK(length_cm BETWEEN 200 AND 2000),
 gross_weight_kg integer NOT NULL CHECK(gross_weight_kg BETWEEN 1000 AND 100000),
 weight_per_axle_kg integer NOT NULL CHECK(weight_per_axle_kg BETWEEN 500 AND 40000 AND weight_per_axle_kg<=gross_weight_kg),
 verification_note text NOT NULL CHECK(length(trim(verification_note))>0),
 verified_by uuid NOT NULL REFERENCES employees(id), verified_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1
);
CREATE TABLE road_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),route_id uuid NOT NULL REFERENCES routes(id),
 created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 provider text NOT NULL DEFAULT 'amazon-location-v2',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed','applied')),
 snapshot jsonb NOT NULL, input jsonb NOT NULL,result jsonb,error text,
 applied_at timestamptz,
 CHECK ((status IN ('ready','applied'))=(result IS NOT NULL))
);
CREATE INDEX road_plans_route ON road_plans(route_id,created_at DESC);

$corewaste_sql_30$;
 INSERT INTO schema_migrations(version) VALUES('031_road_planning');
 END IF;
END $corewaste_step_30$;

-- 032_payable_settlement.sql
DO $corewaste_step_31$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='032_payable_settlement') THEN
 EXECUTE $corewaste_sql_31$
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

$corewaste_sql_31$;
 INSERT INTO schema_migrations(version) VALUES('032_payable_settlement');
 END IF;
END $corewaste_step_31$;

-- 033_customer_pricebooks.sql
DO $corewaste_step_32$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='033_customer_pricebooks') THEN
 EXECUTE $corewaste_sql_32$
CREATE TABLE customer_pricebooks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES customers(id),
 location_id uuid,kind text NOT NULL CHECK(kind IN ('delivery','pickup','exchange','relocation','live_load','extra_pickup','bulk','disposal','recurring')),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),description text NOT NULL DEFAULT '',
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 0 AND 100000000),
 effective_from date NOT NULL,effective_to date CHECK(effective_to IS NULL OR effective_to>=effective_from),
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,customer_id),
 FOREIGN KEY(location_id,customer_id) REFERENCES locations(id,customer_id)
);
CREATE INDEX customer_pricebooks_account ON customer_pricebooks(customer_id,active,effective_from);
ALTER TABLE orders ADD COLUMN pricebook_id uuid, ADD COLUMN pricing_snapshot jsonb,
 ADD FOREIGN KEY(pricebook_id,customer_id) REFERENCES customer_pricebooks(id,customer_id),
 ADD CONSTRAINT order_price_snapshot CHECK((pricebook_id IS NULL AND pricing_snapshot IS NULL) OR (pricebook_id IS NOT NULL AND pricing_snapshot IS NOT NULL AND jsonb_typeof(pricing_snapshot)='object' AND pricing_snapshot ?& ARRAY['id','version','kind','price_cents'] AND pricing_snapshot->>'id'=pricebook_id::text AND pricing_snapshot->>'kind'=kind AND pricing_snapshot->>'price_cents'=price_cents::text));

$corewaste_sql_32$;
 INSERT INTO schema_migrations(version) VALUES('033_customer_pricebooks');
 END IF;
END $corewaste_step_32$;

-- 034_service_fee_policies.sql
DO $corewaste_step_33$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='034_service_fee_policies') THEN
 EXECUTE $corewaste_sql_33$
CREATE TABLE service_fee_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES customers(id),
 kind text NOT NULL CHECK(kind IN ('fuel','handling')),name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 method text NOT NULL CHECK(method IN ('flat','percent')),value integer NOT NULL CHECK(value>=0),
 effective_from date NOT NULL,effective_to date CHECK(effective_to IS NULL OR effective_to>=effective_from),
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((method='flat' AND value<=100000000) OR (method='percent' AND value<=10000))
);
CREATE INDEX service_fee_policies_customer ON service_fee_policies(customer_id,kind);
ALTER TABLE orders ADD COLUMN fee_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN fee_total_cents integer NOT NULL DEFAULT 0 CHECK(fee_total_cents BETWEEN 0 AND 100000000),
 ADD CHECK(jsonb_typeof(fee_snapshot)='array' AND jsonb_array_length(fee_snapshot)<=2),
 ADD CHECK(price_cents::bigint+fee_total_cents<=100000000);

$corewaste_sql_33$;
 INSERT INTO schema_migrations(version) VALUES('034_service_fee_policies');
 END IF;
END $corewaste_step_33$;

-- 035_material_stock_ledger.sql
DO $corewaste_step_34$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='035_material_stock_ledger') THEN
 EXECUTE $corewaste_sql_34$
CREATE TABLE material_stock_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),material_id uuid NOT NULL REFERENCES materials(id),
 site_name text NOT NULL CHECK(length(trim(site_name)) BETWEEN 1 AND 120),
 balance_kg bigint NOT NULL DEFAULT 0 CHECK(balance_kg BETWEEN 0 AND 1000000000000),
 version integer NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES employees(id)
);
CREATE UNIQUE INDEX material_stock_site ON material_stock_accounts(material_id,lower(trim(site_name)));
ALTER TABLE scale_tickets ADD COLUMN stock_account_id uuid REFERENCES material_stock_accounts(id);
CREATE TABLE material_stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES material_stock_accounts(id),
 delta_kg bigint NOT NULL,balance_after_kg bigint NOT NULL CHECK(balance_after_kg BETWEEN 0 AND 1000000000000),
 kind text NOT NULL CHECK(kind IN ('opening_count','count_adjustment','scale_inbound','scale_outbound','transfer_in','transfer_out')),
 scale_ticket_id uuid UNIQUE REFERENCES scale_tickets(id),transfer_id uuid,
 reason text NOT NULL CHECK(length(trim(reason))>0),actor_id uuid NOT NULL REFERENCES employees(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind IN ('scale_inbound','scale_outbound'))=(scale_ticket_id IS NOT NULL)),
 CHECK((kind IN ('transfer_in','transfer_out'))=(transfer_id IS NOT NULL)),
 CHECK((kind IN ('scale_inbound','transfer_in') AND delta_kg>=0) OR (kind IN ('scale_outbound','transfer_out') AND delta_kg<=0) OR kind IN ('opening_count','count_adjustment'))
);
CREATE UNIQUE INDEX material_stock_transfer_once ON material_stock_movements(transfer_id,account_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX material_stock_history ON material_stock_movements(account_id,recorded_at DESC,id);
CREATE TRIGGER material_stock_movements_immutable BEFORE UPDATE OR DELETE ON material_stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

$corewaste_sql_34$;
 INSERT INTO schema_migrations(version) VALUES('035_material_stock_ledger');
 END IF;
END $corewaste_step_34$;

-- 036_container_verification.sql
DO $corewaste_step_35$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='036_container_verification') THEN
 EXECUTE $corewaste_sql_35$
CREATE TABLE container_verifications (
 order_id uuid PRIMARY KEY REFERENCES orders(id),actor_id uuid NOT NULL REFERENCES employees(id),
 container_id uuid NOT NULL REFERENCES containers(id),container_number text NOT NULL,
 replacement_container_id uuid REFERENCES containers(id),replacement_container_number text,
 method text NOT NULL DEFAULT 'manual_number' CHECK(method='manual_number'),
 verified_at timestamptz NOT NULL,
 CHECK((replacement_container_id IS NULL)=(replacement_container_number IS NULL))
);
CREATE TRIGGER container_verifications_immutable BEFORE UPDATE OR DELETE ON container_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE sync_exceptions ADD COLUMN original_body jsonb;
CREATE FUNCTION preserve_sync_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Append-only service evidence'; END IF;
 IF ROW(NEW.driver_id,NEW.order_id,NEW.command_key,NEW.original_version,NEW.reported_status,NEW.note,NEW.performed_at,NEW.original_body,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.driver_id,OLD.order_id,OLD.command_key,OLD.original_version,OLD.reported_status,OLD.note,OLD.performed_at,OLD.original_body,OLD.created_at) THEN RAISE EXCEPTION 'Immutable service evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_evidence_immutable BEFORE UPDATE OR DELETE ON sync_exceptions FOR EACH ROW EXECUTE FUNCTION preserve_sync_evidence();

$corewaste_sql_35$;
 INSERT INTO schema_migrations(version) VALUES('036_container_verification');
 END IF;
END $corewaste_step_35$;

-- 037_contract_billing_cycles.sql
DO $corewaste_step_36$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='037_contract_billing_cycles') THEN
 EXECUTE $corewaste_sql_36$
ALTER TABLE service_agreements ADD COLUMN billing_alignment text NOT NULL DEFAULT 'calendar' CHECK(billing_alignment IN ('calendar','anniversary')),
 ADD COLUMN billing_cycle_months integer NOT NULL DEFAULT 1 CHECK(billing_cycle_months IN (1,3,12)),
 ADD CHECK(billing_mode='monthly' OR (billing_alignment='calendar' AND billing_cycle_months=1)),
 ADD CHECK(monthly_rate_cents IS NULL OR monthly_rate_cents::bigint*billing_cycle_months<=100000000);
ALTER TABLE monthly_billing_periods ADD COLUMN billing_alignment text NOT NULL DEFAULT 'calendar',
 ADD COLUMN billing_cycle_months integer NOT NULL DEFAULT 1,
 ADD COLUMN full_period_cents integer CHECK(full_period_cents BETWEEN 0 AND 100000000);
-- Keep the original anniversary day, including across February and leap years.
CREATE FUNCTION contract_cycle_next(period_start date,alignment text,cycle_length integer,anchor date) RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $$
 WITH target AS (SELECT (date_trunc('month',period_start::timestamp)+make_interval(months=>cycle_length))::date AS first_day)
 SELECT first_day + LEAST(CASE WHEN alignment='calendar' THEN 1 ELSE EXTRACT(day FROM anchor)::integer END,EXTRACT(day FROM (first_day+interval '1 month - 1 day'))::integer)-1 FROM target
$$;

$corewaste_sql_36$;
 INSERT INTO schema_migrations(version) VALUES('037_contract_billing_cycles');
 END IF;
END $corewaste_step_36$;

-- 038_equipment_storage.sql
DO $corewaste_step_37$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='038_equipment_storage') THEN
 EXECUTE $corewaste_sql_37$
-- Date-only period arithmetic must not depend on the database session time zone.
CREATE OR REPLACE FUNCTION contract_cycle_next(period_start date,alignment text,cycle_length integer,anchor date) RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $$
 WITH target AS (SELECT (date_trunc('month',period_start::timestamp)+make_interval(months=>cycle_length))::date AS first_day)
 SELECT first_day + LEAST(CASE WHEN alignment='calendar' THEN 1 ELSE EXTRACT(day FROM anchor)::integer END,EXTRACT(day FROM (first_day+interval '1 month - 1 day'))::integer)-1 FROM target
$$;
CREATE TABLE equipment_yards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 address text NOT NULL CHECK(length(trim(address)) BETWEEN 1 AND 2000),active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX equipment_yard_name ON equipment_yards(lower(trim(name)));
ALTER TABLE containers ADD COLUMN yard_id uuid REFERENCES equipment_yards(id), ADD COLUMN carried_by_truck_id uuid REFERENCES trucks(id);
ALTER TABLE containers DROP CONSTRAINT containers_status_check;
ALTER TABLE containers ADD CONSTRAINT containers_status_check CHECK(status IN ('yard','on_truck','deployed','awaiting_disposal','maintenance','retired'));
ALTER TABLE containers ADD CONSTRAINT container_storage_state CHECK(
 (status IN ('yard','maintenance','retired') AND carried_by_truck_id IS NULL) OR
 (status='on_truck' AND yard_id IS NULL AND carried_by_truck_id IS NOT NULL) OR
 (status IN ('deployed','awaiting_disposal') AND yard_id IS NULL AND carried_by_truck_id IS NULL));
CREATE INDEX containers_by_yard ON containers(yard_id) WHERE yard_id IS NOT NULL;
CREATE INDEX containers_by_carrier ON containers(carried_by_truck_id) WHERE carried_by_truck_id IS NOT NULL;
CREATE TABLE equipment_deployments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),container_id uuid NOT NULL REFERENCES containers(id),
 customer_id uuid NOT NULL REFERENCES customers(id),location_id uuid NOT NULL,order_id uuid REFERENCES orders(id),
 placed_at timestamptz NOT NULL DEFAULT now(),placed_by uuid NOT NULL REFERENCES employees(id),
 recovered_at timestamptz,recovered_by uuid REFERENCES employees(id),
 FOREIGN KEY(location_id,customer_id) REFERENCES locations(id,customer_id),
 CHECK((recovered_at IS NULL)=(recovered_by IS NULL))
);
CREATE UNIQUE INDEX equipment_one_active_placement ON equipment_deployments(container_id) WHERE recovered_at IS NULL;
CREATE TABLE equipment_storage_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),container_id uuid NOT NULL REFERENCES containers(id),
 actor_id uuid NOT NULL REFERENCES employees(id),action text NOT NULL,observed_number text,
 reason text NOT NULL CHECK(length(trim(reason))>0),before_state jsonb NOT NULL,after_state jsonb NOT NULL,
 order_id uuid REFERENCES orders(id),deployment_id uuid REFERENCES equipment_deployments(id),
 performed_at timestamptz NOT NULL DEFAULT now(),recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX equipment_job_movement_once ON equipment_storage_events(order_id,container_id,action) WHERE order_id IS NOT NULL;
CREATE INDEX equipment_storage_history ON equipment_storage_events(container_id,recorded_at DESC,id);
CREATE TRIGGER equipment_storage_events_immutable BEFORE UPDATE OR DELETE ON equipment_storage_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION preserve_equipment_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Append-only equipment placement'; END IF;
 IF ROW(NEW.id,NEW.container_id,NEW.customer_id,NEW.location_id,NEW.order_id,NEW.placed_at,NEW.placed_by) IS DISTINCT FROM ROW(OLD.id,OLD.container_id,OLD.customer_id,OLD.location_id,OLD.order_id,OLD.placed_at,OLD.placed_by) OR OLD.recovered_at IS NOT NULL OR NEW.recovered_at IS NULL OR NEW.recovered_by IS NULL OR NEW.recovered_at<NEW.placed_at THEN RAISE EXCEPTION 'Immutable equipment placement; only its first recovery may be recorded'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER equipment_placement_immutable BEFORE UPDATE OR DELETE ON equipment_deployments FOR EACH ROW EXECUTE FUNCTION preserve_equipment_placement();

$corewaste_sql_37$;
 INSERT INTO schema_migrations(version) VALUES('038_equipment_storage');
 END IF;
END $corewaste_step_37$;

-- 039_advance_contract_billing.sql
DO $corewaste_step_38$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='039_advance_contract_billing') THEN
 EXECUTE $corewaste_sql_38$
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

$corewaste_sql_38$;
 INSERT INTO schema_migrations(version) VALUES('039_advance_contract_billing');
 END IF;
END $corewaste_step_38$;

-- 040_payable_adjustments.sql
DO $corewaste_step_39$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='040_payable_adjustments') THEN
 EXECUTE $corewaste_sql_39$
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

$corewaste_sql_39$;
 INSERT INTO schema_migrations(version) VALUES('040_payable_adjustments');
 END IF;
END $corewaste_step_39$;

-- 041_equipment_observation.sql
DO $corewaste_step_40$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='041_equipment_observation') THEN
 EXECUTE $corewaste_sql_40$
ALTER TABLE equipment_deployments ADD COLUMN record_kind text NOT NULL DEFAULT 'placement' CHECK(record_kind IN ('placement','legacy_observation'));
CREATE OR REPLACE FUNCTION preserve_equipment_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Append-only equipment placement'; END IF;
 IF ROW(NEW.id,NEW.container_id,NEW.customer_id,NEW.location_id,NEW.order_id,NEW.placed_at,NEW.placed_by,NEW.record_kind) IS DISTINCT FROM ROW(OLD.id,OLD.container_id,OLD.customer_id,OLD.location_id,OLD.order_id,OLD.placed_at,OLD.placed_by,OLD.record_kind) OR OLD.recovered_at IS NOT NULL OR NEW.recovered_at IS NULL OR NEW.recovered_by IS NULL OR NEW.recovered_at<NEW.placed_at THEN RAISE EXCEPTION 'Immutable equipment placement; only its first recovery may be recorded'; END IF;
 RETURN NEW;
END $$;

$corewaste_sql_40$;
 INSERT INTO schema_migrations(version) VALUES('041_equipment_observation');
 END IF;
END $corewaste_step_40$;

-- 042_legacy_transaction_archive.sql
DO $corewaste_step_41$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='042_legacy_transaction_archive') THEN
 EXECUTE $corewaste_sql_41$
ALTER TABLE import_batches DROP CONSTRAINT import_batches_kind_check;
ALTER TABLE import_batches ADD CHECK(kind IN ('customers','locations','containers','agreements','orders','routes','opening_balances','legacy_transactions'));
-- Source history is preserved for lookup. It never posts to the current ledger or doubles cutover balances.
CREATE TABLE legacy_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL REFERENCES import_batches(id),
 source_system text NOT NULL CHECK(length(trim(source_system)) BETWEEN 1 AND 100),
 source_reference text NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 100),
 transaction_kind text NOT NULL CHECK(transaction_kind IN ('invoice','payment','refund','credit','expense')),
 transaction_date date NOT NULL,amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 currency text NOT NULL CHECK(currency='USD'),customer_id uuid REFERENCES customers(id),
 vendor text NOT NULL DEFAULT '',related_reference text NOT NULL DEFAULT '',memo text NOT NULL DEFAULT '',
 imported_at timestamptz NOT NULL DEFAULT now(),
 CHECK((transaction_kind='expense' AND length(trim(vendor))>0) OR (transaction_kind<>'expense' AND customer_id IS NOT NULL)),
 UNIQUE(source_system,transaction_kind,source_reference)
);
CREATE INDEX legacy_transactions_date ON legacy_transactions(transaction_date,id);
CREATE INDEX legacy_transactions_customer ON legacy_transactions(customer_id,transaction_date);
CREATE TRIGGER legacy_transactions_immutable BEFORE UPDATE OR DELETE ON legacy_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

$corewaste_sql_41$;
 INSERT INTO schema_migrations(version) VALUES('042_legacy_transaction_archive');
 END IF;
END $corewaste_step_41$;

-- 043_expense_service_attribution.sql
DO $corewaste_step_42$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='043_expense_service_attribution') THEN
 EXECUTE $corewaste_sql_42$
ALTER TABLE expenses ADD COLUMN order_id uuid REFERENCES orders(id),ADD COLUMN route_id uuid REFERENCES routes(id),
 ADD CHECK(num_nonnulls(order_id,route_id)<=1);
CREATE INDEX expense_order_attribution ON expenses(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX expense_route_attribution ON expenses(route_id) WHERE route_id IS NOT NULL;

$corewaste_sql_42$;
 INSERT INTO schema_migrations(version) VALUES('043_expense_service_attribution');
 END IF;
END $corewaste_step_42$;

-- 044_expense_attribution_view.sql
DO $corewaste_step_43$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='044_expense_attribution_view') THEN
 EXECUTE $corewaste_sql_43$
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

$corewaste_sql_43$;
 INSERT INTO schema_migrations(version) VALUES('044_expense_attribution_view');
 END IF;
END $corewaste_step_43$;

-- 045_service_timing.sql
DO $corewaste_step_44$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='045_service_timing') THEN
 EXECUTE $corewaste_sql_44$
ALTER TABLE orders ADD COLUMN service_window_start time,ADD COLUMN service_window_end time,
 ADD COLUMN service_duration_minutes integer NOT NULL DEFAULT 0 CHECK(service_duration_minutes BETWEEN 0 AND 720),
 ADD CHECK((service_window_start IS NULL AND service_window_end IS NULL) OR (service_window_start IS NOT NULL AND service_window_end IS NOT NULL AND service_window_start<service_window_end));

$corewaste_sql_44$;
 INSERT INTO schema_migrations(version) VALUES('045_service_timing');
 END IF;
END $corewaste_step_44$;

-- 046_provider_refunds.sql
DO $corewaste_step_45$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='046_provider_refunds') THEN
 EXECUTE $corewaste_sql_45$
ALTER TABLE customer_credit_refunds DROP CONSTRAINT customer_credit_refunds_method_check;
ALTER TABLE customer_credit_refunds ADD CHECK(method IN ('cash','check','stripe'));
CREATE TABLE stripe_refund_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_id uuid REFERENCES payments(id),credit_id uuid REFERENCES customer_credits(id),
 invoice_id uuid REFERENCES invoices(id),customer_id uuid NOT NULL REFERENCES customers(id),
 payment_intent text NOT NULL CHECK(payment_intent LIKE 'pi\_%'),
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 actor_id uuid NOT NULL REFERENCES employees(id),state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','sending','pending','review','succeeded','failed','cancelled')),
 provider_refund_id text UNIQUE,local_refund_id uuid UNIQUE REFERENCES refunds(id),local_credit_refund_id uuid UNIQUE REFERENCES customer_credit_refunds(id),
 attempted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),last_error text,
 CHECK(payment_id IS NOT NULL OR credit_id IS NOT NULL),CHECK(num_nonnulls(local_refund_id,local_credit_refund_id)<=1),
 CHECK((credit_id IS NULL AND local_credit_refund_id IS NULL) OR (credit_id IS NOT NULL AND local_refund_id IS NULL))
);
CREATE INDEX stripe_refund_payment_reservations ON stripe_refund_requests(payment_id,state);
CREATE INDEX stripe_refund_credit_reservations ON stripe_refund_requests(credit_id,state);
CREATE FUNCTION preserve_stripe_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Refund requests cannot be deleted'; END IF;
 IF ROW(NEW.id,NEW.payment_id,NEW.credit_id,NEW.invoice_id,NEW.customer_id,NEW.payment_intent,NEW.amount_cents,NEW.reason,NEW.actor_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.payment_id,OLD.credit_id,OLD.invoice_id,OLD.customer_id,OLD.payment_intent,OLD.amount_cents,OLD.reason,OLD.actor_id,OLD.created_at) OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at) OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) OR (OLD.local_refund_id IS NOT NULL AND NEW.local_refund_id IS DISTINCT FROM OLD.local_refund_id) OR (OLD.local_credit_refund_id IS NOT NULL AND NEW.local_credit_refund_id IS DISTINCT FROM OLD.local_credit_refund_id) THEN RAISE EXCEPTION 'Immutable refund request identity and receipt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stripe_refund_identity BEFORE UPDATE OR DELETE ON stripe_refund_requests FOR EACH ROW EXECUTE FUNCTION preserve_stripe_refund_request();
CREATE TABLE stripe_refund_observations (
 event_id text PRIMARY KEY,provider_refund_id text NOT NULL,payment_intent text,currency text,amount_cents integer,
 provider_status text NOT NULL,request_id uuid REFERENCES stripe_refund_requests(id),recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_refund_observation_lookup ON stripe_refund_observations(payment_intent,recorded_at DESC);
CREATE TRIGGER stripe_refund_observations_immutable BEFORE UPDATE OR DELETE ON stripe_refund_observations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

$corewaste_sql_45$;
 INSERT INTO schema_migrations(version) VALUES('046_provider_refunds');
 END IF;
END $corewaste_step_45$;

-- 047_external_refund_receipts.sql
DO $corewaste_step_46$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='047_external_refund_receipts') THEN
 EXECUTE $corewaste_sql_46$
ALTER TABLE stripe_refund_requests ADD COLUMN external_receipt boolean NOT NULL DEFAULT false,
 ADD CHECK(NOT external_receipt OR (attempted_at IS NOT NULL AND provider_refund_id IS NOT NULL));
CREATE OR REPLACE FUNCTION preserve_stripe_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Refund requests cannot be deleted'; END IF;
 IF ROW(NEW.id,NEW.payment_id,NEW.credit_id,NEW.invoice_id,NEW.customer_id,NEW.payment_intent,NEW.amount_cents,NEW.reason,NEW.actor_id,NEW.created_at,NEW.external_receipt) IS DISTINCT FROM ROW(OLD.id,OLD.payment_id,OLD.credit_id,OLD.invoice_id,OLD.customer_id,OLD.payment_intent,OLD.amount_cents,OLD.reason,OLD.actor_id,OLD.created_at,OLD.external_receipt) OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at) OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) OR (OLD.local_refund_id IS NOT NULL AND NEW.local_refund_id IS DISTINCT FROM OLD.local_refund_id) OR (OLD.local_credit_refund_id IS NOT NULL AND NEW.local_credit_refund_id IS DISTINCT FROM OLD.local_credit_refund_id) THEN RAISE EXCEPTION 'Immutable refund request identity and receipt'; END IF;
 RETURN NEW;
END $$;

$corewaste_sql_46$;
 INSERT INTO schema_migrations(version) VALUES('047_external_refund_receipts');
 END IF;
END $corewaste_step_46$;

-- 048_provider_settings.sql
DO $corewaste_step_47$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='048_provider_settings') THEN
 EXECUTE $corewaste_sql_47$
CREATE TABLE provider_settings (
 provider text PRIMARY KEY CHECK(provider IN ('firebase','stripe','quickbooks','email','sms','routing','storage')),
 enabled boolean NOT NULL DEFAULT false,
 config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(config)='object'),
 secrets jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(secrets)='object'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL REFERENCES employees(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);

$corewaste_sql_47$;
 INSERT INTO schema_migrations(version) VALUES('048_provider_settings');
 END IF;
END $corewaste_step_47$;

-- 049_supabase_private_storage.sql
DO $corewaste_step_48$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='049_supabase_private_storage') THEN
 EXECUTE $corewaste_sql_48$
ALTER TABLE attachments DROP CONSTRAINT attachments_storage_driver_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_storage_driver_check CHECK(storage_driver IN ('local','gcs','supabase'));

$corewaste_sql_48$;
 INSERT INTO schema_migrations(version) VALUES('049_supabase_private_storage');
 END IF;
END $corewaste_step_48$;

-- Prevent the public Supabase Data API from exposing business tables/views/RPCs.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC,anon,authenticated;
DO $corewaste_role$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corewaste_app') THEN
 CREATE ROLE corewaste_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $corewaste_role$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,corewaste_app;
GRANT USAGE ON SCHEMA public TO corewaste_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO corewaste_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO corewaste_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO corewaste_app;
REVOKE INSERT,UPDATE,DELETE ON schema_migrations FROM corewaste_app;
REVOKE UPDATE,DELETE ON audit_log,commands FROM corewaste_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO corewaste_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO corewaste_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO corewaste_app;
-- No anon/authenticated policies: only the private API database role gets access.
DO $corewaste_rls$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tableowner=current_user AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_depend d ON d.objid=c.oid WHERE n.nspname='public' AND c.relname=tablename AND d.deptype='e') LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t.tablename);
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t.tablename AND policyname='corewaste_private_api') THEN
 EXECUTE format('CREATE POLICY corewaste_private_api ON public.%I FOR ALL TO corewaste_app USING(true) WITH CHECK(true)',t.tablename);
 END IF;
 END LOOP;
END $corewaste_rls$;
COMMIT;
-- Returns a NEW private runtime password once, only in your SQL Editor result.
-- Store it privately. A second run refuses to rotate an existing login.
CREATE OR REPLACE FUNCTION pg_temp.corewaste_runtime_password() RETURNS text LANGUAGE plpgsql AS $corewaste_password$
DECLARE generated text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='corewaste_app' AND rolcanlogin) THEN
 RAISE EXCEPTION 'Runtime login already configured. Its password was not changed. Use your saved password or deliberately rotate it in database administration.';
 END IF;
 generated=replace(pg_catalog.gen_random_uuid()::text||pg_catalog.gen_random_uuid()::text,'-','');
 EXECUTE format('ALTER ROLE corewaste_app LOGIN PASSWORD %L',generated);
 RETURN generated;
END $corewaste_password$;
SELECT pg_temp.corewaste_runtime_password() AS copy_this_private_runtime_password_to_render;
