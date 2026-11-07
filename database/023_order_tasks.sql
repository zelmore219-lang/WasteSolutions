CREATE TABLE order_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id),
 label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 500),required boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES employees(id),created_at timestamptz NOT NULL DEFAULT now(),
 completed_by uuid REFERENCES employees(id),completed_at timestamptz,completion_note text NOT NULL DEFAULT '',
 CHECK((completed_by IS NULL)=(completed_at IS NULL))
);
CREATE INDEX order_tasks_order ON order_tasks(order_id);
