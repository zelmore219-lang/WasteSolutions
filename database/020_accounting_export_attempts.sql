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
