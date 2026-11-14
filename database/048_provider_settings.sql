CREATE TABLE provider_settings (
 provider text PRIMARY KEY CHECK(provider IN ('firebase','stripe','quickbooks','email','sms','routing','storage')),
 enabled boolean NOT NULL DEFAULT false,
 config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(config)='object'),
 secrets jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(secrets)='object'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid NOT NULL REFERENCES employees(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
