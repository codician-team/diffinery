-- Kill switches (lib/killswitch.ts). A site administrator suspends Actions for one repository, or for
-- every repository an account owns: no new runs, queued jobs fail, no new agent sandboxes. NULL is not suspended.
ALTER TABLE repos ADD COLUMN actions_suspended_at TEXT;
ALTER TABLE repos ADD COLUMN actions_suspended_by TEXT;
ALTER TABLE repos ADD COLUMN actions_suspended_reason TEXT;
ALTER TABLE accounts ADD COLUMN actions_suspended_at TEXT;
ALTER TABLE accounts ADD COLUMN actions_suspended_by TEXT;
ALTER TABLE accounts ADD COLUMN actions_suspended_reason TEXT;

-- Instance-wide switches; a row is a switch that is on. `hosted_compute_paused` stops hosted Actions
-- jobs and agent sandboxes everywhere (self-hosted runners keep working); its value is the reason.
CREATE TABLE IF NOT EXISTS site_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- What is running now across the instance (pausing hosted compute stops it).
CREATE INDEX IF NOT EXISTS compute_usage_running ON compute_usage(ended_at, started_at);
