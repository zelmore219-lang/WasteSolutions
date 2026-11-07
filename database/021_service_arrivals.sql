ALTER TABLE orders ADD COLUMN arrived_at timestamptz;
ALTER TABLE order_events ADD COLUMN performed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sync_exceptions DROP CONSTRAINT sync_exceptions_reported_status_check;
ALTER TABLE sync_exceptions ADD CHECK(reported_status IN ('in_progress','arrived','completed','failed'));
