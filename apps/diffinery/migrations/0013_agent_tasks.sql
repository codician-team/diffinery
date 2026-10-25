-- People's own model API keys for agent tasks (agentic/keys.ts), encrypted per
-- account and provider. Write-only: nothing ever returns `ciphertext` decrypted
-- except the model proxy, while a task of that person runs.
CREATE TABLE model_keys (
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  hint TEXT NOT NULL,
  opted_in_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
);

-- An index of agent tasks across repositories (each repository's ProjectDO holds
-- the tasks themselves), for Today and task lists.
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  runtime TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  started_by TEXT NOT NULL,
  state TEXT NOT NULL,
  pr_number INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_tasks_person ON agent_tasks(started_by, updated_at);
CREATE INDEX agent_tasks_agent ON agent_tasks(agent_id, updated_at);
CREATE UNIQUE INDEX agent_tasks_repo ON agent_tasks(repo_id, number);
