CREATE TABLE customer_credit_refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), credit_id uuid NOT NULL REFERENCES customer_credits(id),
 amount_cents integer NOT NULL CHECK(amount_cents>0), method text NOT NULL CHECK(method IN ('cash','check')),
 reference text NOT NULL UNIQUE, reason text NOT NULL, actor_id uuid NOT NULL REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_credit_refunds_immutable BEFORE UPDATE OR DELETE ON customer_credit_refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
