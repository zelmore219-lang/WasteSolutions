ALTER TABLE locations ADD COLUMN routing_longitude double precision,
 ADD COLUMN routing_latitude double precision,
 ADD COLUMN routing_note text,
 ADD COLUMN routing_verified_by uuid REFERENCES employees(id),
 ADD COLUMN routing_verified_at timestamptz,
 ADD COLUMN routing_version integer NOT NULL DEFAULT 1,
 ADD CONSTRAINT location_routing_pin CHECK (
 (routing_longitude IS NULL AND routing_latitude IS NULL AND routing_verified_at IS NULL) OR
 (routing_longitude IS NOT NULL AND routing_latitude IS NOT NULL AND routing_note IS NOT NULL AND routing_longitude BETWEEN -180 AND 180 AND routing_latitude BETWEEN -85 AND 85 AND routing_verified_at IS NOT NULL AND routing_verified_by IS NOT NULL AND length(trim(routing_note))>0));
CREATE FUNCTION invalidate_routing_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.address IS DISTINCT FROM OLD.address THEN
  NEW.routing_longitude=NULL; NEW.routing_latitude=NULL; NEW.routing_note=NULL;
  NEW.routing_verified_by=NULL; NEW.routing_verified_at=NULL;
  NEW.routing_version=OLD.routing_version+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER location_address_routing BEFORE UPDATE OF address ON locations FOR EACH ROW EXECUTE FUNCTION invalidate_routing_pin();
CREATE TABLE truck_routing_profiles (
 truck_id uuid PRIMARY KEY REFERENCES trucks(id),
 height_cm integer NOT NULL CHECK(height_cm BETWEEN 100 AND 600),
 width_cm integer NOT NULL CHECK(width_cm BETWEEN 100 AND 500),
 length_cm integer NOT NULL CHECK(length_cm BETWEEN 200 AND 2000),
 gross_weight_kg integer NOT NULL CHECK(gross_weight_kg BETWEEN 1000 AND 100000),
 weight_per_axle_kg integer NOT NULL CHECK(weight_per_axle_kg BETWEEN 500 AND 40000 AND weight_per_axle_kg<=gross_weight_kg),
 verification_note text NOT NULL CHECK(length(trim(verification_note))>0),
 verified_by uuid NOT NULL REFERENCES employees(id), verified_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1
);
CREATE TABLE road_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),route_id uuid NOT NULL REFERENCES routes(id),
 created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 provider text NOT NULL DEFAULT 'amazon-location-v2',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed','applied')),
 snapshot jsonb NOT NULL, input jsonb NOT NULL,result jsonb,error text,
 applied_at timestamptz,
 CHECK ((status IN ('ready','applied'))=(result IS NOT NULL))
);
CREATE INDEX road_plans_route ON road_plans(route_id,created_at DESC);
