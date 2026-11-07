ALTER TABLE orders ADD CONSTRAINT agreement_actual_date_once EXCLUDE USING gist
 (agreement_id WITH =,scheduled_date WITH =)
 WHERE (agreement_id IS NOT NULL AND status<>'cancelled')
 DEFERRABLE INITIALLY DEFERRED;
