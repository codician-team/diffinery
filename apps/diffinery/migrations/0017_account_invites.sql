-- Invitations to an existing account by username: the person accepts them (Settings → Invitations, or
-- the API) before they join an organization or get access to a repository.
ALTER TABLE invites ADD COLUMN account_id TEXT REFERENCES accounts(id);
CREATE INDEX IF NOT EXISTS invites_account ON invites(account_id, accepted_at);
