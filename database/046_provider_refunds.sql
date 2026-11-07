ALTER TABLE customer_credit_refunds DROP CONSTRAINT customer_credit_refunds_method_check;
ALTER TABLE customer_credit_refunds ADD CHECK(method IN ('cash','check','stripe'));
CREATE TABLE stripe_refund_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_id uuid REFERENCES payments(id),credit_id uuid REFERENCES customer_credits(id),
 invoice_id uuid REFERENCES invoices(id),customer_id uuid NOT NULL REFERENCES customers(id),
 payment_intent text NOT NULL CHECK(payment_intent LIKE 'pi\_%'),
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 actor_id uuid NOT NULL REFERENCES employees(id),state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','sending','pending','review','succeeded','failed','cancelled')),
 provider_refund_id text UNIQUE,local_refund_id uuid UNIQUE REFERENCES refunds(id),local_credit_refund_id uuid UNIQUE REFERENCES customer_credit_refunds(id),
 attempted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),last_error text,
 CHECK(payment_id IS NOT NULL OR credit_id IS NOT NULL),CHECK(num_nonnulls(local_refund_id,local_credit_refund_id)<=1),
 CHECK((credit_id IS NULL AND local_credit_refund_id IS NULL) OR (credit_id IS NOT NULL AND local_refund_id IS NULL))
);
CREATE INDEX stripe_refund_payment_reservations ON stripe_refund_requests(payment_id,state);
CREATE INDEX stripe_refund_credit_reservations ON stripe_refund_requests(credit_id,state);
CREATE FUNCTION preserve_stripe_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Refund requests cannot be deleted'; END IF;
 IF ROW(NEW.id,NEW.payment_id,NEW.credit_id,NEW.invoice_id,NEW.customer_id,NEW.payment_intent,NEW.amount_cents,NEW.reason,NEW.actor_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.payment_id,OLD.credit_id,OLD.invoice_id,OLD.customer_id,OLD.payment_intent,OLD.amount_cents,OLD.reason,OLD.actor_id,OLD.created_at) OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at) OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) OR (OLD.local_refund_id IS NOT NULL AND NEW.local_refund_id IS DISTINCT FROM OLD.local_refund_id) OR (OLD.local_credit_refund_id IS NOT NULL AND NEW.local_credit_refund_id IS DISTINCT FROM OLD.local_credit_refund_id) THEN RAISE EXCEPTION 'Immutable refund request identity and receipt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stripe_refund_identity BEFORE UPDATE OR DELETE ON stripe_refund_requests FOR EACH ROW EXECUTE FUNCTION preserve_stripe_refund_request();
CREATE TABLE stripe_refund_observations (
 event_id text PRIMARY KEY,provider_refund_id text NOT NULL,payment_intent text,currency text,amount_cents integer,
 provider_status text NOT NULL,request_id uuid REFERENCES stripe_refund_requests(id),recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_refund_observation_lookup ON stripe_refund_observations(payment_intent,recorded_at DESC);
CREATE TRIGGER stripe_refund_observations_immutable BEFORE UPDATE OR DELETE ON stripe_refund_observations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
