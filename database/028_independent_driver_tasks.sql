CREATE TABLE driver_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '',address text NOT NULL DEFAULT '',scheduled_date date NOT NULL,
 priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','assigned','in_progress','completed','failed','cancelled')),
 driver_id uuid REFERENCES employees(id),truck_id uuid REFERENCES trucks(id),version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,completed_at timestamptz,completion_note text NOT NULL DEFAULT '',
 CHECK(status IN ('new','cancelled') OR driver_id IS NOT NULL)
);
CREATE INDEX driver_tasks_schedule ON driver_tasks(driver_id,scheduled_date,status);
CREATE TABLE driver_task_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES driver_tasks(id),
 actor_id uuid NOT NULL REFERENCES employees(id),driver_id uuid REFERENCES employees(id),status text NOT NULL,
 note text NOT NULL DEFAULT '',performed_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER driver_task_events_immutable BEFORE UPDATE OR DELETE ON driver_task_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
