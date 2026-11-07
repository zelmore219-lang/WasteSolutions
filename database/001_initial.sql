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
