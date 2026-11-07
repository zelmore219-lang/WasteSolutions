ALTER TABLE containers DROP CONSTRAINT containers_status_check;
ALTER TABLE containers ADD CHECK(status IN ('yard','deployed','awaiting_disposal','maintenance','retired'));
CREATE TABLE disposal_loads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 rental_id uuid NOT NULL REFERENCES rentals(id),container_id uuid NOT NULL REFERENCES containers(id),
 assigned_driver_id uuid REFERENCES employees(id),assigned_truck_id uuid REFERENCES trucks(id),
 status text NOT NULL DEFAULT 'awaiting_disposal' CHECK(status IN ('awaiting_disposal','disposal_failed','review_required','disposed')),
 version integer NOT NULL DEFAULT 1,last_failure_reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),
 disposed_at timestamptz,disposal_ticket_id uuid UNIQUE REFERENCES disposal_tickets(id)
);
CREATE TABLE disposal_load_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),load_id uuid NOT NULL REFERENCES disposal_loads(id),
 actor_id uuid NOT NULL REFERENCES employees(id),action text NOT NULL,note text NOT NULL DEFAULT '',
 performed_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER disposal_load_events_immutable BEFORE UPDATE OR DELETE ON disposal_load_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
INSERT INTO disposal_loads(order_id,rental_id,container_id,assigned_driver_id,assigned_truck_id,status)
 SELECT j.order_id,j.rental_id,j.container_id,o.driver_id,o.truck_id,
 CASE WHEN c.status='deployed' THEN 'review_required' ELSE 'awaiting_disposal' END
 FROM rental_jobs j JOIN orders o ON o.id=j.order_id JOIN containers c ON c.id=j.container_id
 WHERE j.action IN ('exchange','pickup') AND o.status IN ('completed','invoiced')
 AND NOT EXISTS(SELECT 1 FROM disposal_tickets t WHERE t.order_id=j.order_id);
UPDATE containers c SET status='awaiting_disposal',version=version+1
 WHERE c.status='yard' AND EXISTS(SELECT 1 FROM disposal_loads d WHERE d.container_id=c.id AND d.status<>'disposed');
CREATE INDEX disposal_load_assignee_status ON disposal_loads(assigned_driver_id,status);
