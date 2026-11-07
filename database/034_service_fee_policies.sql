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
