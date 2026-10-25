-- Importing repositories from GitHub (one repository, or many from an organization or user).

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES imports(id),      -- bulk imports fan out into one child per repository
  kind TEXT NOT NULL CHECK (kind IN ('repo', 'bulk')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  api_url TEXT NOT NULL,                      -- GitHub REST API base, e.g. https://api.github.com
  source TEXT NOT NULL,                       -- owner/name, or the owner for bulk imports
  target_owner_id TEXT NOT NULL REFERENCES accounts(id),
  target_name TEXT,                           -- repository imports only
  repo_id TEXT,                               -- the repository this import created
  request TEXT NOT NULL,                      -- JSON: visibility, options, selection
  steps TEXT NOT NULL DEFAULT '{}',           -- JSON: per-step status and progress (written by the workflow)
  git TEXT,                                   -- JSON: the Git transfer's progress and result (written by the agent)
  summary TEXT NOT NULL DEFAULT '{}',         -- JSON: counts, secret names, findings
  warnings TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  token_ciphertext TEXT,                      -- the GitHub token, encrypted; deleted when the import finishes
  push_token_id TEXT,                         -- the short-lived Diffinery token used for the Git transfer
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX imports_creator ON imports(created_by, created_at);
CREATE INDEX imports_parent ON imports(parent_id);

-- Temporary tokens minted for an import's Git transfer carry its id.
ALTER TABLE tokens ADD COLUMN import_id TEXT;

-- Verified links between Diffinery accounts and GitHub accounts, used to attribute imported work.
CREATE TABLE account_links (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  api_base TEXT NOT NULL,                      -- full normalised REST base, e.g. https://api.github.com or https://ghe.example.com/api/v3
  external_id TEXT NOT NULL,
  external_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, api_base, external_id)
);
CREATE INDEX account_links_account ON account_links(account_id);

-- Actions variables shared by an organization's repositories.
CREATE TABLE org_variables (
  org_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, name)
);

ALTER TABLE repos ADD COLUMN homepage TEXT NOT NULL DEFAULT '';
