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
