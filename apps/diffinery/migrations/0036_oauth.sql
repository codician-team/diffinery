-- OAuth 2.1 sign-in for MCP clients (auth/oauth.ts): claude.ai connectors, Claude Code, Codex,
-- Cursor and other apps connect to /mcp by sending the person through /oauth/authorize instead of
-- asking for a pasted token. Only hashes of codes, refresh tokens and client secrets are stored.

-- Apps that registered themselves (RFC 7591 dynamic registration, client_id "dfc_…") or that
-- identify by a client metadata document (client_id is the document's https URL, cached here).
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'metadata')),
  name TEXT NOT NULL,
  client_uri TEXT,
  redirect_uris TEXT NOT NULL,           -- JSON array
  auth_method TEXT NOT NULL DEFAULT 'none' CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  secret_hash TEXT,
  software TEXT,                         -- software_id and software_version as the app sent them
  created_at TEXT NOT NULL,
  fetched_at TEXT,                       -- metadata documents: when the document was last read
  used_at TEXT
);

-- One connection: a person allowed an app to act as them or as one of their agents. Its access
-- tokens are ordinary tokens (tokens.oauth_grant_id); revoking the connection revokes them.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,             -- as shown when the person approved it
  redirect_host TEXT NOT NULL,
  person_id TEXT NOT NULL,               -- who approved it
  account_id TEXT NOT NULL,              -- whom its tokens act as: the person or one of their agents
  scope TEXT NOT NULL,
  refresh_hash TEXT UNIQUE,
  prev_refresh_hash TEXT,                -- the refresh token it replaced, to spot a stolen one being reused
  refreshed_at TEXT,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_grants_person ON oauth_grants(person_id, revoked_at);
CREATE INDEX IF NOT EXISTS oauth_grants_prev ON oauth_grants(prev_refresh_hash);

-- Authorization codes: one use, a few minutes, bound to the PKCE challenge and redirect URI.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  person_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

ALTER TABLE tokens ADD COLUMN oauth_grant_id TEXT;
CREATE INDEX IF NOT EXISTS tokens_oauth_grant ON tokens(oauth_grant_id);
