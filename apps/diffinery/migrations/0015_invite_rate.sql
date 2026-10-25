-- Invitations an inviter sent recently (the daily invitation limit).
CREATE INDEX IF NOT EXISTS invites_by ON invites(invited_by, created_at);
