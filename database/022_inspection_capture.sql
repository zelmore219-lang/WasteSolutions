ALTER TABLE vehicle_inspections ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT now();
