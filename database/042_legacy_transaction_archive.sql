ALTER TABLE import_batches DROP CONSTRAINT import_batches_kind_check;
ALTER TABLE import_batches ADD CHECK(kind IN ('customers','locations','containers','agreements','orders','routes','opening_balances','legacy_transactions'));
-- Source history is preserved for lookup. It never posts to the current ledger or doubles cutover balances.
CREATE TABLE legacy_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL REFERENCES import_batches(id),
 source_system text NOT NULL CHECK(length(trim(source_system)) BETWEEN 1 AND 100),
 source_reference text NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 100),
 transaction_kind text NOT NULL CHECK(transaction_kind IN ('invoice','payment','refund','credit','expense')),
 transaction_date date NOT NULL,amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 currency text NOT NULL CHECK(currency='USD'),customer_id uuid REFERENCES customers(id),
 vendor text NOT NULL DEFAULT '',related_reference text NOT NULL DEFAULT '',memo text NOT NULL DEFAULT '',
 imported_at timestamptz NOT NULL DEFAULT now(),
 CHECK((transaction_kind='expense' AND length(trim(vendor))>0) OR (transaction_kind<>'expense' AND customer_id IS NOT NULL)),
 UNIQUE(source_system,transaction_kind,source_reference)
);
CREATE INDEX legacy_transactions_date ON legacy_transactions(transaction_date,id);
CREATE INDEX legacy_transactions_customer ON legacy_transactions(customer_id,transaction_date);
CREATE TRIGGER legacy_transactions_immutable BEFORE UPDATE OR DELETE ON legacy_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
