CREATE TABLE public_inquiries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL, phone text NOT NULL,
 service_address text NOT NULL, service_kind text NOT NULL CHECK(service_kind IN ('residential','commercial','roll_off','bulk','other')),
 message text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','converted','closed')),
 order_id uuid REFERENCES orders(id), resolution text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE portal_registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), firebase_uid text NOT NULL UNIQUE, email text NOT NULL,
 name text NOT NULL, kind text NOT NULL CHECK(kind IN ('residential','commercial')), phone text NOT NULL,
 billing_address text NOT NULL, service_address text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 customer_id uuid REFERENCES customers(id), reviewed_by uuid REFERENCES employees(id), review_note text, created_at timestamptz NOT NULL DEFAULT now()
);
