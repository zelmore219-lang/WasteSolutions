CREATE TABLE attachments (
 id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id), customer_id uuid REFERENCES customers(id),
 kind text NOT NULL CHECK(kind IN ('photo','document','signature')), filename text NOT NULL, content_type text NOT NULL,
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760), sha256 text NOT NULL,
 storage_driver text NOT NULL CHECK(storage_driver IN ('local','gcs')), storage_key text NOT NULL UNIQUE,
 visibility text NOT NULL CHECK(visibility IN ('office','customer')), actor_id uuid NOT NULL REFERENCES employees(id),
 signer_name text, signed_at timestamptz, consent_version text,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(num_nonnulls(order_id,customer_id)=1),
 CHECK(kind<>'signature' OR (signer_name IS NOT NULL AND signed_at IS NOT NULL AND consent_version IS NOT NULL))
);
CREATE TRIGGER attachments_immutable BEFORE UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE driver_locations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL REFERENCES employees(id),
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90), longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 accuracy_m double precision NOT NULL CHECK(accuracy_m>=0), recorded_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(driver_id,recorded_at)
);
CREATE INDEX driver_location_latest ON driver_locations(driver_id,recorded_at DESC);
ALTER TABLE order_events ADD COLUMN driver_id uuid REFERENCES employees(id);
ALTER TABLE order_events ADD COLUMN truck_id uuid REFERENCES trucks(id);
CREATE TABLE sync_exceptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL REFERENCES employees(id),
 order_id uuid NOT NULL REFERENCES orders(id), command_key text NOT NULL, original_version integer NOT NULL,
 reported_status text NOT NULL CHECK(reported_status IN ('in_progress','completed','failed')),
 note text NOT NULL, performed_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','rejected')),
 resolved_by uuid REFERENCES employees(id), resolution text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(driver_id,command_key)
);
