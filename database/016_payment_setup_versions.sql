ALTER TABLE stripe_profiles ADD COLUMN settings_version integer NOT NULL DEFAULT 1;
ALTER TABLE payment_setup_requests ADD COLUMN settings_version integer NOT NULL DEFAULT 1;
ALTER TABLE payment_setup_requests ADD COLUMN state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','cancelled'));
ALTER TABLE journal ADD COLUMN posting_date date;
