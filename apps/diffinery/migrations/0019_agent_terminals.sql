-- Web terminals (phase 4, agentic/terminals.ts): a sandbox one person opened to work in
-- interactively, for example signed in to their own Claude or ChatGPT subscription. The
-- sandbox itself (and anything typed or shown in it) lives only in its container; this is the
-- index for limits, the list and expiry.
CREATE TABLE agent_terminals (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  status TEXT NOT NULL,
  sandbox_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX agent_terminals_person ON agent_terminals(person_id, status);
CREATE INDEX agent_terminals_repo ON agent_terminals(repo_id, status);

-- A person's opt-in to using their own provider subscription in a terminal, with the notice's version.
CREATE TABLE terminal_terms (
  account_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  opted_in_at TEXT NOT NULL
);
