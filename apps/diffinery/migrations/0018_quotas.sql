-- Hosted compute an account pays for (the owner of the repository): Actions jobs on hosted runners
-- and agent sandboxes. A row is open until the job or sandbox ends (lib/quotas.ts).
CREATE TABLE IF NOT EXISTS compute_usage (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS compute_usage_open ON compute_usage(account_id, kind, ended_at);
CREATE INDEX IF NOT EXISTS compute_usage_started ON compute_usage(account_id, started_at);

-- A site administrator's per-account overrides of the default quotas; NULL keeps the default, -1 is unlimited.
CREATE TABLE IF NOT EXISTS account_quotas (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  hosted_minutes INTEGER,
  hosted_jobs INTEGER,
  sandboxes INTEGER,
  repositories INTEGER,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
