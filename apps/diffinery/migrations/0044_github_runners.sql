-- Diffinery runners for GitHub repositories (github-runners/): an instance's GitHub App is installed on a
-- GitHub user or organization, the installation is linked to the Diffinery account that pays, and jobs whose
-- runs-on asks for a Diffinery runner run in hosted runner containers with GitHub's own runner.

-- A GitHub App installation linked to a Diffinery account. Its id is GitHub's installation id.
CREATE TABLE IF NOT EXISTS github_installations (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,              -- the Diffinery person or organization whose hosted minutes it uses
  github_login TEXT NOT NULL,            -- the GitHub user or organization it is installed on
  github_type TEXT NOT NULL,             -- "User" or "Organization"
  linked_by TEXT NOT NULL,               -- the Diffinery account that linked it
  linked_at TEXT NOT NULL,
  suspended_at TEXT                      -- suspended on GitHub: no runners start for it meanwhile
);
CREATE INDEX IF NOT EXISTS github_installations_account ON github_installations(account_id);

-- One runner started (or waiting to start) for a queued GitHub job. GitHub hands a runner any queued job
-- of the repository whose labels it has, so the job a runner runs (ran_job_id) may not be the one that
-- asked for it (github_job_id).
CREATE TABLE IF NOT EXISTS github_runner_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repo TEXT NOT NULL,                    -- owner/name on GitHub
  github_job_id INTEGER NOT NULL,
  run_id INTEGER,
  workflow_name TEXT,
  job_name TEXT,
  html_url TEXT,
  labels TEXT NOT NULL,                  -- JSON: the job's runs-on labels, which the runner registers with
  size TEXT NOT NULL,                    -- runner/sizes.ts
  status TEXT NOT NULL,                  -- queued, starting, running, completed, skipped, failed
  tries INTEGER NOT NULL DEFAULT 0,
  runner_name TEXT,
  github_runner_id INTEGER,
  container TEXT,
  ran_job_id INTEGER,
  ran_job_name TEXT,
  conclusion TEXT,                       -- the GitHub job's conclusion, once GitHub reports it
  message TEXT,                          -- why it waits, was skipped or failed
  stop_reason TEXT,                      -- set when Diffinery stopped the runner itself
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  picked_at TEXT,
  ended_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS github_runner_jobs_job ON github_runner_jobs(installation_id, github_job_id);
CREATE INDEX IF NOT EXISTS github_runner_jobs_account ON github_runner_jobs(account_id, status, created_at);
CREATE INDEX IF NOT EXISTS github_runner_jobs_installation ON github_runner_jobs(installation_id, created_at);
CREATE INDEX IF NOT EXISTS github_runner_jobs_runner ON github_runner_jobs(runner_name);
