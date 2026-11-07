CREATE TABLE customer_credits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES customers(id),
 original_cents integer NOT NULL CHECK(original_cents>0), remaining_cents integer NOT NULL CHECK(remaining_cents>=0 AND remaining_cents<=original_cents),
 source_reference text NOT NULL UNIQUE, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CHECK(method IN ('cash','check','stripe','credit'));
