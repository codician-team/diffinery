-- SHA-256 progress of a blob upload in progress (registry/upload.ts), so a chunked upload's
-- last request doesn't read the whole blob back to hash it.
ALTER TABLE registry_uploads ADD COLUMN hash_state TEXT;
