ALTER TABLE stripe_refund_requests ADD COLUMN external_receipt boolean NOT NULL DEFAULT false,
 ADD CHECK(NOT external_receipt OR (attempted_at IS NOT NULL AND provider_refund_id IS NOT NULL));
CREATE OR REPLACE FUNCTION preserve_stripe_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Refund requests cannot be deleted'; END IF;
 IF ROW(NEW.id,NEW.payment_id,NEW.credit_id,NEW.invoice_id,NEW.customer_id,NEW.payment_intent,NEW.amount_cents,NEW.reason,NEW.actor_id,NEW.created_at,NEW.external_receipt) IS DISTINCT FROM ROW(OLD.id,OLD.payment_id,OLD.credit_id,OLD.invoice_id,OLD.customer_id,OLD.payment_intent,OLD.amount_cents,OLD.reason,OLD.actor_id,OLD.created_at,OLD.external_receipt) OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at) OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) OR (OLD.local_refund_id IS NOT NULL AND NEW.local_refund_id IS DISTINCT FROM OLD.local_refund_id) OR (OLD.local_credit_refund_id IS NOT NULL AND NEW.local_credit_refund_id IS DISTINCT FROM OLD.local_credit_refund_id) THEN RAISE EXCEPTION 'Immutable refund request identity and receipt'; END IF;
 RETURN NEW;
END $$;
