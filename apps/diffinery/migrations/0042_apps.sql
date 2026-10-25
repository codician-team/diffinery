-- GitHub-compatible apps (apps/store.ts): integrations such as deploy, CI and code review services
-- register an app, people install it on their account or organization for all or some repositories,
-- and the app signs in with a JWT made with its private key and trades it for short-lived installation
-- tokens, as with GitHub Apps. Only public keys and hashes of tokens and client secrets are stored.

-- One app. Its id is a number, as GitHub's are (clients parse it as one); client_id identifies it too.
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  owner_id TEXT NOT NULL,                -- the person or organization that owns it
  description TEXT NOT NULL DEFAULT '',
  homepage_url TEXT NOT NULL,
  setup_url TEXT,                        -- where people go after installing (with installation_id)
  callback_urls TEXT NOT NULL DEFAULT '[]',
  webhook_url TEXT,
  webhook_secret TEXT,                   -- sealed with MASTER_KEY (lib/crypto.ts), scope "app-webhook"
  webhook_active INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL DEFAULT '{}', -- JSON: GitHub permission name -> "read" | "write"
  events TEXT NOT NULL DEFAULT '[]',     -- JSON: webhook events it subscribes to
  public INTEGER NOT NULL DEFAULT 0,     -- others may install it; otherwise only its owner's accounts
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_delivery_at TEXT,
  last_delivery_status INTEGER
);
CREATE INDEX IF NOT EXISTS apps_owner ON apps(owner_id);

-- An app's public keys (SPKI, base64). Its private keys are only ever with the app's developers.
CREATE TABLE IF NOT EXISTS app_keys (
  id TEXT PRIMARY KEY,
  app_id INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,             -- "SHA256:<base64>", as GitHub shows it
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS app_keys_app ON app_keys(app_id);

-- An app installed on one account: a person or an organization, all of its repositories or some.
-- It keeps the permissions and events the app had when it was installed.
CREATE TABLE IF NOT EXISTS app_installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions TEXT NOT NULL,
  events TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  suspended_at TEXT,
  suspended_by TEXT,
  UNIQUE (app_id, account_id)
);
CREATE INDEX IF NOT EXISTS app_installations_account ON app_installations(account_id);

-- The repositories of an installation with repository_selection 'selected'.
CREATE TABLE IF NOT EXISTS app_installation_repos (
  installation_id INTEGER NOT NULL,
  repo_id TEXT NOT NULL,
  PRIMARY KEY (installation_id, repo_id)
);
CREATE INDEX IF NOT EXISTS app_installation_repos_repo ON app_installation_repos(repo_id);

-- Installation access tokens ("dia_…"): an hour each, possibly narrowed to some repositories and permissions.
CREATE TABLE IF NOT EXISTS app_installation_tokens (
  token_hash TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  repo_ids TEXT,                         -- JSON array, or NULL for everything the installation covers
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS app_installation_tokens_installation ON app_installation_tokens(installation_id);
CREATE INDEX IF NOT EXISTS app_installation_tokens_expiry ON app_installation_tokens(expires_at);
