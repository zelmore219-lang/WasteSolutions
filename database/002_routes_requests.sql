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
