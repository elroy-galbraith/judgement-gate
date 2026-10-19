-- Drop the legacy email column from users. Existing data is discarded.
ALTER TABLE users DROP COLUMN legacy_email;
DROP TABLE IF EXISTS users_legacy_backup;
