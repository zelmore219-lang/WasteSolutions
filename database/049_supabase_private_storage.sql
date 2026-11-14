ALTER TABLE attachments DROP CONSTRAINT attachments_storage_driver_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_storage_driver_check CHECK(storage_driver IN ('local','gcs','supabase'));
