-- Phase 5b: organizations' agent policies and model keys.
--
-- An organization's model keys live in `model_keys` under the organization's id, like a person's under theirs;
-- `opted_in_by` is the owner who accepted the provider's terms for the organization (null for personal keys).
ALTER TABLE model_keys ADD COLUMN opted_in_by TEXT;

-- One JSON row per organization that set a policy: whose key pays, allowed runtimes and providers, most tasks
-- at once per repository, terminals, agent review, and the monthly token allowance per person on its keys.
CREATE TABLE org_agent_policies (
  org_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tokens each person spent on an organization's keys per calendar month (UTC, `2026-10`), weighted as budgets
-- weigh them, for the policy's monthly allowance. The model proxy books each request's estimate here before it
-- goes upstream, and settles it to what the provider reported.
CREATE TABLE org_key_spend (
  org_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  month TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (org_id, person_id, month)
);

-- Whose key paid for each run: the person's id, or the organization's when its key paid. Null for runs before 5b
-- and for runs on a subscription in a terminal, which are the person's own.
ALTER TABLE agent_usage ADD COLUMN key_owner TEXT;
CREATE INDEX agent_usage_key_owner ON agent_usage(key_owner, ended_at);

-- Model requests in flight that a limit counts (the model proxy's leases): a review's or budgeted run's
-- (`run:<repo>:<task>:<run>`), and a person's on an organization's keys while it sets an allowance
-- (`org:<org>:<person>`). Each row is one request, deleted when its answer is settled; a lease that outlives
-- that (a Worker that died mid-request) stops counting when it expires.
CREATE TABLE model_in_flight (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX model_in_flight_scope ON model_in_flight(scope, expires_at);
