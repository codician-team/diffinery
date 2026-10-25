-- Indexes for D1 queries that scanned whole tables as they grew (scalability evaluation, 2026-10-14).
-- Suspended people, read on every issue and pull request page (lib/moderation.ts suspendedIds).
CREATE INDEX IF NOT EXISTS accounts_suspended ON accounts(suspended_at) WHERE suspended_at IS NOT NULL;
-- Pending invitations by address, read at every sign-up and sign-in (lib/directory.ts).
CREATE INDEX IF NOT EXISTS invites_email ON invites(email);
-- An owner's imports in progress (lib/directory.ts), and the cron that expires drafts.
CREATE INDEX IF NOT EXISTS imports_target_owner ON imports(target_owner_id, status);
CREATE INDEX IF NOT EXISTS imports_status ON imports(status, created_at);
-- Token expiry reminders (mail/notify.ts mailCron, every five minutes).
CREATE INDEX IF NOT EXISTS tokens_expires ON tokens(expires_at);
-- Container registry cleanup (registry/store.ts, every five minutes).
CREATE INDEX IF NOT EXISTS registry_blobs_created ON registry_blobs(created_at);
CREATE INDEX IF NOT EXISTS package_blobs_created ON package_blobs(created_at);
-- Retention (lib/retention.ts): expired sessions and old notifications are deleted.
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at);
