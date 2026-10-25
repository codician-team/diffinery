-- Model usage of each agent run that used any (phase 5a), written by the repository's ProjectDO when the run
-- ends, for the 30-day view in Settings → Model access. `person_id` is who pays: the task's person, or for an
-- agent review the admin who turned reviews on. `source` is `proxy` (counted by Diffinery from the provider's
-- answers) or `runtime` (what the CLI reported, in a terminal on a subscription); `cost_usd` is only ever the
-- CLI's own figure. `repository` is the repository's owner/name when the run ended, shown as it was then: the
-- payer may have lost access since, and a later name could reveal what they can no longer read.
CREATE TABLE agent_usage (
  repo_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  task INTEGER NOT NULL,
  run INTEGER NOT NULL,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  runtime TEXT NOT NULL,
  providers TEXT NOT NULL,
  source TEXT NOT NULL,
  requests INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL,
  ended_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, task, run)
);
CREATE INDEX agent_usage_person ON agent_usage(person_id, ended_at);
