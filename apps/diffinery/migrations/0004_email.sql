-- Email notifications: per-person settings, watching, thread subscriptions,
-- recognised sign-in devices and a log of every email sent.

-- One row per person who changed a default. JSON, see src/mail/prefs.ts.
CREATE TABLE notification_prefs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  prefs TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Watching a repository: 'all' (every issue, pull request and failed run),
-- 'participating' (the default: only threads you take part in) or 'ignore'.
CREATE TABLE repo_watches (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('all', 'participating', 'ignore')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, repo_id)
);
CREATE INDEX repo_watches_repo ON repo_watches(repo_id, level);

-- Subscribe to (1) or mute (0) one issue or pull request.
CREATE TABLE thread_subscriptions (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  subscribed INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, repo_id, number)
);
CREATE INDEX thread_subscriptions_thread ON thread_subscriptions(repo_id, number);

-- Browsers and passkeys someone has signed in with, so only new ones raise an alert.
CREATE TABLE known_devices (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  fingerprint TEXT NOT NULL,
  label TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (account_id, fingerprint)
);

-- Every email Diffinery tried to send (whole messages are kept only in local development).
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  to_addr TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  detail TEXT,
  message_id TEXT,
  dev_copy TEXT,               -- the whole message, kept only in local development
  created_at TEXT NOT NULL
);
CREATE INDEX email_log_at ON email_log(created_at);
CREATE INDEX email_log_account ON email_log(account_id, created_at);

-- Reminders sent once per token, a week before it expires.
ALTER TABLE tokens ADD COLUMN expiry_notified_at TEXT;
