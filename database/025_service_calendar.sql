CREATE TABLE service_zones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 120),
 description text NOT NULL DEFAULT '',weekdays integer[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6])
);
ALTER TABLE locations ADD COLUMN zone_id uuid REFERENCES service_zones(id);
ALTER TABLE orders ADD COLUMN zone_id uuid REFERENCES service_zones(id);
ALTER TABLE orders ADD COLUMN service_occurrence_date date;
UPDATE orders SET service_occurrence_date=scheduled_date WHERE agreement_id IS NOT NULL;
DROP INDEX agreement_service_date;
CREATE UNIQUE INDEX agreement_occurrence_once ON orders(agreement_id,service_occurrence_date) WHERE agreement_id IS NOT NULL;
CREATE TABLE service_calendar_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),zone_id uuid REFERENCES service_zones(id),
 original_date date NOT NULL,replacement_date date NOT NULL,reason text NOT NULL CHECK(length(trim(reason))>0),
 version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES employees(id),
 UNIQUE NULLS NOT DISTINCT(zone_id,original_date),
 CHECK(abs(replacement_date-original_date) BETWEEN 1 AND 14)
);
CREATE INDEX orders_zone_scheduled ON orders(zone_id,scheduled_date);
