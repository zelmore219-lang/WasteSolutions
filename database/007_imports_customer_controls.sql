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
