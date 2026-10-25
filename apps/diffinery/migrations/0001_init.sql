-- Global directory: accounts (users, orgs, agents), repos, access, tokens, invites.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'org', 'agent')),
  name TEXT,
  email TEXT UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'disabled')),
  site_admin INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT REFERENCES accounts(id),
  agent_policy TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX accounts_owner ON accounts(owner_id);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES accounts(id),
  user_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members(user_id);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'internal', 'public')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pushed_at TEXT,
  UNIQUE (owner_id, name)
);

CREATE TABLE repo_access (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  PRIMARY KEY (repo_id, account_id)
);
CREATE INDEX repo_access_account ON repo_access(account_id);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  repo_ids TEXT,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX tokens_account ON tokens(account_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES accounts(id),
  repo_id TEXT REFERENCES repos(id),
  email TEXT COLLATE NOCASE,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_account ON notifications(account_id, read_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  actor_login TEXT,
  on_behalf_of TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX audit_at ON audit_log(at);

CREATE TABLE schedules (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  workflow_path TEXT NOT NULL,
  cron TEXT NOT NULL,
  PRIMARY KEY (repo_id, workflow_path, cron)
);

CREATE TABLE org_secrets (
  org_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, name)
);

CREATE TABLE access_requests (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  note TEXT,
  created_at TEXT NOT NULL
);
