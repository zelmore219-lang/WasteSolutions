ALTER TABLE equipment_deployments ADD COLUMN record_kind text NOT NULL DEFAULT 'placement' CHECK(record_kind IN ('placement','legacy_observation'));
CREATE OR REPLACE FUNCTION preserve_equipment_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Append-only equipment placement'; END IF;
 IF ROW(NEW.id,NEW.container_id,NEW.customer_id,NEW.location_id,NEW.order_id,NEW.placed_at,NEW.placed_by,NEW.record_kind) IS DISTINCT FROM ROW(OLD.id,OLD.container_id,OLD.customer_id,OLD.location_id,OLD.order_id,OLD.placed_at,OLD.placed_by,OLD.record_kind) OR OLD.recovered_at IS NOT NULL OR NEW.recovered_at IS NULL OR NEW.recovered_by IS NULL OR NEW.recovered_at<NEW.placed_at THEN RAISE EXCEPTION 'Immutable equipment placement; only its first recovery may be recorded'; END IF;
 RETURN NEW;
END $$;
