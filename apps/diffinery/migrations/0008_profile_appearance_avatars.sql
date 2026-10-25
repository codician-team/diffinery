-- Profile pictures, the Appearance setting, and no more "internal" visibility.

-- Profile pictures for people and organizations. The WebP files live in R2 under
-- avatars/<account id>/<version>/<size>.webp; NULL means the generated initials.
ALTER TABLE accounts ADD COLUMN avatar_version INTEGER;

-- Appearance: 'light', 'dark' or NULL (follow the system setting).
ALTER TABLE accounts ADD COLUMN appearance TEXT;

-- Repositories and packages are public or private. "Internal" meant private to the
-- organization, which private already covers, so existing internal ones become private.
UPDATE repos SET visibility = 'private' WHERE visibility = 'internal';
UPDATE packages SET visibility = 'private' WHERE visibility = 'internal';
