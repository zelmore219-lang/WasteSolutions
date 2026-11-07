CREATE TABLE notification_preferences (
 customer_id uuid PRIMARY KEY REFERENCES customers(id), email_enabled boolean NOT NULL DEFAULT true,
 sms_enabled boolean NOT NULL DEFAULT false, sms_consent_at timestamptz, updated_by uuid NOT NULL REFERENCES employees(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_templates (
 kind text PRIMARY KEY, subject text NOT NULL, message text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1
);
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_state_check;
ALTER TABLE notification_outbox ADD CHECK(state IN ('pending','sending','sent','failed','uncertain','cancelled'));
ALTER TABLE notification_outbox ADD COLUMN rendered_subject text;
ALTER TABLE notification_outbox ADD COLUMN rendered_body text;
ALTER TABLE notification_outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE notification_outbox ADD COLUMN delivery_token uuid;
ALTER TABLE notification_outbox ADD COLUMN first_attempt_at timestamptz;
ALTER TABLE notification_outbox ADD COLUMN last_error_code text;
