-- Account lifecycle (accounts/lifecycle.ts, accounts/export.ts): deleting your account, the cool-down on a
-- deleted account's username, and downloadable exports of an account's data.

-- When a person deleted their account (or a site administrator deleted it). Like a deleted organization, the
-- row stays, disabled under a placeholder login, because the audit log and import history refer to it.
ALTER TABLE accounts ADD COLUMN deleted_at TEXT;

-- Usernames freed by deleted accounts. Nobody can take one before available_at (90 days later), so links,
-- mentions and clones that pointed at the old account can't quietly lead to someone else.
CREATE TABLE IF NOT EXISTS released_logins (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  account_id TEXT NOT NULL,
  released_at TEXT NOT NULL,
  available_at TEXT NOT NULL
);

-- Exports of an account's data, built in the background (AccountWorkflow) as one tar archive in R2 under
-- exports/<id>/, downloadable from Settings → Account until expires_at (7 days after it is ready).
CREATE TABLE IF NOT EXISTS account_exports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  r2_key TEXT,
  size INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS account_exports_account ON account_exports(account_id, created_at);
