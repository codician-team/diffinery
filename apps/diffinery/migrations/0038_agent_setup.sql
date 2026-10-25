-- Agent setup (lib/agent-setup.ts): Settings → Agent setup gives each person, per repository, an agent
-- that can only ever reach that repository, and tokens for it to paste into a cloud agent environment.
-- One row per such agent. The agent itself is an ordinary agent account (accounts.kind = 'agent', owned
-- by the person); its policy names the repository, and lib/directory.ts roleFor refuses every other one.
CREATE TABLE IF NOT EXISTS agent_setups (
  agent_id TEXT PRIMARY KEY REFERENCES accounts(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  person_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, person_id)
);
CREATE INDEX IF NOT EXISTS agent_setups_repo ON agent_setups(repo_id);

-- The latest report from the hosted setup script's self-test (/<owner>/<repo>/agent-setup.sh), per
-- repository: what the page's Check shows. `checks` is the JSON list of { name, ok, message } lines.
-- `first_ok_at` is when a report first passed, and stays.
CREATE TABLE IF NOT EXISTS agent_setup_checks (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  token_id TEXT,
  checks TEXT NOT NULL,
  cli_version TEXT,
  first_ok_at TEXT
);
