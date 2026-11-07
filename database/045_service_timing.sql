ALTER TABLE orders ADD COLUMN service_window_start time,ADD COLUMN service_window_end time,
 ADD COLUMN service_duration_minutes integer NOT NULL DEFAULT 0 CHECK(service_duration_minutes BETWEEN 0 AND 720),
 ADD CHECK((service_window_start IS NULL AND service_window_end IS NULL) OR (service_window_start IS NOT NULL AND service_window_end IS NOT NULL AND service_window_start<service_window_end));
