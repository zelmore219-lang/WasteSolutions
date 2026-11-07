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
