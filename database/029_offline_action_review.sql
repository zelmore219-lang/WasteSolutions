CREATE TABLE driver_action_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),driver_id uuid NOT NULL REFERENCES employees(id),command_key text NOT NULL,
 original_action jsonb NOT NULL,performed_at timestamptz NOT NULL,entity_label text NOT NULL,
 already_committed boolean NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','rejected')),
 resolution text NOT NULL DEFAULT '',reviewed_by uuid REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(driver_id,command_key)
);
CREATE FUNCTION protect_driver_action_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.driver_id<>OLD.driver_id OR NEW.command_key<>OLD.command_key OR NEW.original_action<>OLD.original_action OR NEW.performed_at<>OLD.performed_at OR NEW.entity_label<>OLD.entity_label OR NEW.already_committed<>OLD.already_committed
 THEN RAISE EXCEPTION 'Offline evidence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER offline_action_proof_immutable BEFORE UPDATE ON driver_action_reviews FOR EACH ROW EXECUTE FUNCTION protect_driver_action_proof();
CREATE TRIGGER offline_action_proof_no_delete BEFORE DELETE ON driver_action_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
