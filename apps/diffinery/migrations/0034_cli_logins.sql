-- Signing the CLI in through the browser (auth/cli-login.ts). A browser sign-in is approved on
-- /login/cli and hands the CLI's local callback a one-time code; a device sign-in is a code the
-- person types on /login/device while the CLI waits. Either way the CLI gets its token only by
-- trading the secret it kept (the PKCE verifier or the device code) at /-/cli/token, once.
-- Only hashes of the secrets are stored. Rows are deleted a day after they expire.
CREATE TABLE IF NOT EXISTS cli_logins (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL CHECK (flow IN ('browser', 'device')),
  secret_hash TEXT NOT NULL UNIQUE,     -- browser: the one-time code; device: the device code
  user_code TEXT UNIQUE,                -- device: what the person types, without the dash
  code_challenge TEXT,                  -- browser: the PKCE S256 challenge
  client TEXT NOT NULL,                 -- JSON {host, os, version} as the CLI reported them
  requested_scope TEXT NOT NULL,
  ip TEXT,                              -- device: where the CLI asked from
  location TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  account_id TEXT,                      -- who approved or denied it
  scope TEXT,                           -- the scope they chose
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  used_at TEXT,
  token_id TEXT
);
CREATE INDEX IF NOT EXISTS cli_logins_expires ON cli_logins(expires_at);

-- 'cli' marks a token a CLI sign-in created: listed as such in Settings → Access tokens, and
-- `diffinery logout` may revoke it with itself.
ALTER TABLE tokens ADD COLUMN client TEXT;
