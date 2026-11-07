CREATE TABLE container_verifications (
 order_id uuid PRIMARY KEY REFERENCES orders(id),actor_id uuid NOT NULL REFERENCES employees(id),
 container_id uuid NOT NULL REFERENCES containers(id),container_number text NOT NULL,
 replacement_container_id uuid REFERENCES containers(id),replacement_container_number text,
 method text NOT NULL DEFAULT 'manual_number' CHECK(method='manual_number'),
 verified_at timestamptz NOT NULL,
 CHECK((replacement_container_id IS NULL)=(replacement_container_number IS NULL))
);
CREATE TRIGGER container_verifications_immutable BEFORE UPDATE OR DELETE ON container_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE sync_exceptions ADD COLUMN original_body jsonb;
CREATE FUNCTION preserve_sync_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Append-only service evidence'; END IF;
 IF ROW(NEW.driver_id,NEW.order_id,NEW.command_key,NEW.original_version,NEW.reported_status,NEW.note,NEW.performed_at,NEW.original_body,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.driver_id,OLD.order_id,OLD.command_key,OLD.original_version,OLD.reported_status,OLD.note,OLD.performed_at,OLD.original_body,OLD.created_at) THEN RAISE EXCEPTION 'Immutable service evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_evidence_immutable BEFORE UPDATE OR DELETE ON sync_exceptions FOR EACH ROW EXECUTE FUNCTION preserve_sync_evidence();
