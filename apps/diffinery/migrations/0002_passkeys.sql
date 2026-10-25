-- Passkey (WebAuthn) sign-in, browser sessions and one-time sign-in links.

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                 -- credential id, base64url
  account_id TEXT NOT NULL REFERENCES accounts(id),
  public_key TEXT NOT NULL,            -- COSE public key, base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                     -- JSON array
  device_type TEXT NOT NULL,           -- singleDevice | multiDevice
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_account ON passkeys(account_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- sha256 of the cookie value
  account_id TEXT NOT NULL REFERENCES accounts(id),
  method TEXT NOT NULL,                -- passkey | access | link
  passkey_id TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,                 -- sha256 of the browser cookie value
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'register')),
  challenge TEXT NOT NULL,
  subject TEXT NOT NULL,               -- JSON: who the passkey is for
  expires_at TEXT NOT NULL
);

-- Admin-issued, single-use links that let someone add a passkey to an existing account.
CREATE TABLE signin_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
