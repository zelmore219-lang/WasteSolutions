-- Date-only period arithmetic must not depend on the database session time zone.
CREATE OR REPLACE FUNCTION contract_cycle_next(period_start date,alignment text,cycle_length integer,anchor date) RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $$
 WITH target AS (SELECT (date_trunc('month',period_start::timestamp)+make_interval(months=>cycle_length))::date AS first_day)
 SELECT first_day + LEAST(CASE WHEN alignment='calendar' THEN 1 ELSE EXTRACT(day FROM anchor)::integer END,EXTRACT(day FROM (first_day+interval '1 month - 1 day'))::integer)-1 FROM target
$$;
CREATE TABLE equipment_yards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 address text NOT NULL CHECK(length(trim(address)) BETWEEN 1 AND 2000),active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX equipment_yard_name ON equipment_yards(lower(trim(name)));
ALTER TABLE containers ADD COLUMN yard_id uuid REFERENCES equipment_yards(id), ADD COLUMN carried_by_truck_id uuid REFERENCES trucks(id);
ALTER TABLE containers DROP CONSTRAINT containers_status_check;
ALTER TABLE containers ADD CONSTRAINT containers_status_check CHECK(status IN ('yard','on_truck','deployed','awaiting_disposal','maintenance','retired'));
ALTER TABLE containers ADD CONSTRAINT container_storage_state CHECK(
 (status IN ('yard','maintenance','retired') AND carried_by_truck_id IS NULL) OR
 (status='on_truck' AND yard_id IS NULL AND carried_by_truck_id IS NOT NULL) OR
 (status IN ('deployed','awaiting_disposal') AND yard_id IS NULL AND carried_by_truck_id IS NULL));
CREATE INDEX containers_by_yard ON containers(yard_id) WHERE yard_id IS NOT NULL;
CREATE INDEX containers_by_carrier ON containers(carried_by_truck_id) WHERE carried_by_truck_id IS NOT NULL;
CREATE TABLE equipment_deployments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),container_id uuid NOT NULL REFERENCES containers(id),
 customer_id uuid NOT NULL REFERENCES customers(id),location_id uuid NOT NULL,order_id uuid REFERENCES orders(id),
 placed_at timestamptz NOT NULL DEFAULT now(),placed_by uuid NOT NULL REFERENCES employees(id),
 recovered_at timestamptz,recovered_by uuid REFERENCES employees(id),
 FOREIGN KEY(location_id,customer_id) REFERENCES locations(id,customer_id),
 CHECK((recovered_at IS NULL)=(recovered_by IS NULL))
);
CREATE UNIQUE INDEX equipment_one_active_placement ON equipment_deployments(container_id) WHERE recovered_at IS NULL;
CREATE TABLE equipment_storage_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),container_id uuid NOT NULL REFERENCES containers(id),
 actor_id uuid NOT NULL REFERENCES employees(id),action text NOT NULL,observed_number text,
 reason text NOT NULL CHECK(length(trim(reason))>0),before_state jsonb NOT NULL,after_state jsonb NOT NULL,
 order_id uuid REFERENCES orders(id),deployment_id uuid REFERENCES equipment_deployments(id),
 performed_at timestamptz NOT NULL DEFAULT now(),recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX equipment_job_movement_once ON equipment_storage_events(order_id,container_id,action) WHERE order_id IS NOT NULL;
CREATE INDEX equipment_storage_history ON equipment_storage_events(container_id,recorded_at DESC,id);
CREATE TRIGGER equipment_storage_events_immutable BEFORE UPDATE OR DELETE ON equipment_storage_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION preserve_equipment_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Append-only equipment placement'; END IF;
 IF ROW(NEW.id,NEW.container_id,NEW.customer_id,NEW.location_id,NEW.order_id,NEW.placed_at,NEW.placed_by) IS DISTINCT FROM ROW(OLD.id,OLD.container_id,OLD.customer_id,OLD.location_id,OLD.order_id,OLD.placed_at,OLD.placed_by) OR OLD.recovered_at IS NOT NULL OR NEW.recovered_at IS NULL OR NEW.recovered_by IS NULL OR NEW.recovered_at<NEW.placed_at THEN RAISE EXCEPTION 'Immutable equipment placement; only its first recovery may be recorded'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER equipment_placement_immutable BEFORE UPDATE OR DELETE ON equipment_deployments FOR EACH ROW EXECUTE FUNCTION preserve_equipment_placement();
