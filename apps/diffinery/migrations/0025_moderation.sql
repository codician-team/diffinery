-- Moderation (lib/moderation.ts): suspended accounts, blocked users and reports to site administrators.

-- A site administrator suspended this person: accounts.status is 'disabled' while it lasts (nothing signs in,
-- no token, session, agent or runner works) and their repositories, profile and conversations are hidden from
-- everyone else. Unlike disabling, suspending keeps their tokens, so unsuspending restores everything. NULL is not suspended.
ALTER TABLE accounts ADD COLUMN suspended_at TEXT;
ALTER TABLE accounts ADD COLUMN suspended_by TEXT;
ALTER TABLE accounts ADD COLUMN suspended_reason TEXT;

-- A person, or an organization (by one of its owners), blocked a person: in the blocker's repositories the
-- blocked person can't open issues or pull requests, comment, review or react, and the two can't invite each other.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT NOT NULL REFERENCES accounts(id),
  blocked_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  created_by TEXT,                      -- the organization owner who blocked; the person themselves otherwise
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked ON user_blocks(blocked_id);

-- Reports of abusive content, the queue site administrators work through. `excerpt` keeps what was reported
-- as it was then, so editing or deleting it afterwards hides nothing from the administrators.
CREATE TABLE IF NOT EXISTS abuse_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,                   -- user, repository, issue, pull_request or comment
  target TEXT NOT NULL,                 -- login, owner/name, owner/name#12, or owner/name#12 and the comment id
  url TEXT NOT NULL,
  account_id TEXT,                      -- the person reported, or who wrote the content
  repo_id TEXT,
  excerpt TEXT,
  reason TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',   -- open or resolved
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS abuse_reports_state ON abuse_reports(state, created_at);
CREATE INDEX IF NOT EXISTS abuse_reports_reporter ON abuse_reports(reporter_id, created_at);
