CREATE TABLE material_stock_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),material_id uuid NOT NULL REFERENCES materials(id),
 site_name text NOT NULL CHECK(length(trim(site_name)) BETWEEN 1 AND 120),
 balance_kg bigint NOT NULL DEFAULT 0 CHECK(balance_kg BETWEEN 0 AND 1000000000000),
 version integer NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES employees(id)
);
CREATE UNIQUE INDEX material_stock_site ON material_stock_accounts(material_id,lower(trim(site_name)));
ALTER TABLE scale_tickets ADD COLUMN stock_account_id uuid REFERENCES material_stock_accounts(id);
CREATE TABLE material_stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES material_stock_accounts(id),
 delta_kg bigint NOT NULL,balance_after_kg bigint NOT NULL CHECK(balance_after_kg BETWEEN 0 AND 1000000000000),
 kind text NOT NULL CHECK(kind IN ('opening_count','count_adjustment','scale_inbound','scale_outbound','transfer_in','transfer_out')),
 scale_ticket_id uuid UNIQUE REFERENCES scale_tickets(id),transfer_id uuid,
 reason text NOT NULL CHECK(length(trim(reason))>0),actor_id uuid NOT NULL REFERENCES employees(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind IN ('scale_inbound','scale_outbound'))=(scale_ticket_id IS NOT NULL)),
 CHECK((kind IN ('transfer_in','transfer_out'))=(transfer_id IS NOT NULL)),
 CHECK((kind IN ('scale_inbound','transfer_in') AND delta_kg>=0) OR (kind IN ('scale_outbound','transfer_out') AND delta_kg<=0) OR kind IN ('opening_count','count_adjustment'))
);
CREATE UNIQUE INDEX material_stock_transfer_once ON material_stock_movements(transfer_id,account_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX material_stock_history ON material_stock_movements(account_id,recorded_at DESC,id);
CREATE TRIGGER material_stock_movements_immutable BEFORE UPDATE OR DELETE ON material_stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
