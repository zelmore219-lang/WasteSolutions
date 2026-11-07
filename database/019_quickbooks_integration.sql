CREATE TABLE quickbooks_oauth_states (
 state_hash text PRIMARY KEY, actor_id uuid NOT NULL REFERENCES employees(id),
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quickbooks_connection (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), realm_id text NOT NULL,
 company_name text NOT NULL, mode text NOT NULL CHECK(mode IN ('sandbox','production')),
 status text NOT NULL CHECK(status IN ('pending_review','active','needs_reauthorization')),
 encrypted_tokens text NOT NULL, expires_at timestamptz NOT NULL, connected_by uuid NOT NULL REFERENCES employees(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quickbooks_account_mappings (
 local_account text PRIMARY KEY, remote_account_id text NOT NULL, remote_account_name text NOT NULL,
 remote_account_type text NOT NULL, updated_by uuid NOT NULL REFERENCES employees(id)
);
CREATE TABLE quickbooks_customers (
 customer_id uuid PRIMARY KEY REFERENCES customers(id), remote_id text NOT NULL UNIQUE
);
CREATE TABLE quickbooks_exports (
 journal_id uuid PRIMARY KEY REFERENCES journal(id), remote_id text NOT NULL UNIQUE, realm_id text NOT NULL,
 exported_by uuid NOT NULL REFERENCES employees(id), exported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER quickbooks_exports_immutable BEFORE UPDATE OR DELETE ON quickbooks_exports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
