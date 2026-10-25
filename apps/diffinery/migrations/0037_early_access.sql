-- Early access requests (lib/early-access.ts): what people send through /early-access while the
-- instance is invite-only. A request is unconfirmed until its email link is followed, then waits as
-- confirmed until a site administrator invites or declines it. Only site administrators can read
-- them; the audit log keeps every decision. Unconfirmed requests are deleted after 7 days, and anyone
-- can delete their own request through an emailed link (/early-access/remove).
CREATE TABLE IF NOT EXISTS early_access (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT,
  company TEXT,
  use_case TEXT,
  hosting TEXT,                        -- where they host code today, one of a fixed list
  state TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (state IN ('unconfirmed', 'confirmed', 'invited', 'declined')),
  confirm_hash TEXT,                   -- SHA-256 of the emailed confirmation token, until it is used
  confirm_expires_at TEXT,
  confirmed_at TEXT,
  remove_hash TEXT,                    -- SHA-256 of an emailed removal token, when the address asked to be removed
  remove_expires_at TEXT,
  invite_id TEXT,                      -- the site invitation sent from it
  decided_by TEXT,                     -- the site administrator's login
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS early_access_state ON early_access(state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS early_access_confirm ON early_access(confirm_hash);
CREATE UNIQUE INDEX IF NOT EXISTS early_access_remove ON early_access(remove_hash);

-- One row per form submission, for the daily limits only: hashes of the sender's IP address and of
-- the address typed, never either in the clear. Rows older than a day are deleted.
CREATE TABLE IF NOT EXISTS early_access_attempts (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  emailed INTEGER NOT NULL DEFAULT 0,  -- 1 when this submission sent an email
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS early_access_attempts_ip ON early_access_attempts(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS early_access_attempts_email ON early_access_attempts(email_hash, created_at);
CREATE INDEX IF NOT EXISTS early_access_attempts_at ON early_access_attempts(created_at);
