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
