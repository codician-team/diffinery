-- Organization base permission (GitHub's "base permissions"): the role every member gets on the
-- organization's repositories, one of none, read, write or admin. Owners and admins always get admin,
-- and per-repository grants add to it. New organizations start at read; existing ones keep the
-- write access their members already had.
ALTER TABLE accounts ADD COLUMN base_role TEXT;
UPDATE accounts SET base_role = 'write' WHERE kind = 'org';
