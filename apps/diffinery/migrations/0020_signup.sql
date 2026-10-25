-- Open sign-up (SIGNUP=open): emailed one-time codes and the tickets that let a verified
-- address create its account with a passkey. Only hashes are stored.

-- One row per code request. An address that already has an account gets a row too (its code is
-- never sent), so the daily limits count every sign-up email and wrong codes answer the same.
CREATE TABLE signup_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,                 -- lower case
  ip TEXT NOT NULL,
  code_hash TEXT NOT NULL,             -- HMAC of the 6-digit code
  attempts INTEGER NOT NULL DEFAULT 0, -- codes entered, right or wrong
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX signup_codes_email ON signup_codes(email, created_at);
CREATE INDEX signup_codes_ip ON signup_codes(ip, created_at);

-- A verified address may create its account (pick a username, create a passkey) once.
CREATE TABLE signup_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 of the token in the browser's form
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
