ALTER TABLE public_inquiries ADD COLUMN request_id uuid UNIQUE;
ALTER TABLE public_inquiries ADD COLUMN request_hash text;
