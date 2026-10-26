-- Contact messages (lib/contact.ts): what people send through /contact to the instance's site
-- administrators. A message from someone who isn't signed in is unconfirmed until its address follows
-- the emailed link; a signed-in person's arrives confirmed. Confirmed messages are new until a site
-- administrator marks them handled or spam. Only site administrators can read them; the audit log keeps
-- every change. Unconfirmed messages are deleted after 7 days, spam after 30, handled after 365.
CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,  -- where to reply: the address typed, or a signed-in sender's own
  name TEXT NOT NULL,
  topic TEXT NOT NULL,                 -- one of a fixed list
  message TEXT NOT NULL,
  account_id TEXT,                     -- the sender, when signed in
  sender_login TEXT,
  state TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (state IN ('unconfirmed', 'new', 'handled', 'spam')),
  confirm_hash TEXT,                   -- SHA-256 of the emailed confirmation token, until it is used
  confirm_expires_at TEXT,
  confirmed_at TEXT,
  note TEXT,                           -- the site administrators' latest note
  updated_by TEXT,                     -- the site administrator's login who last changed it
  handled_at TEXT,                     -- when it was marked handled or spam
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_messages_state ON contact_messages(state, created_at);
CREATE INDEX IF NOT EXISTS contact_messages_email ON contact_messages(email, state);
CREATE INDEX IF NOT EXISTS contact_messages_account ON contact_messages(account_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS contact_messages_confirm ON contact_messages(confirm_hash);

-- One row per form submission from someone who isn't signed in, for the daily limits only: hashes of
-- the sender's IP address and of the address typed, never either in the clear. Rows older than a day
-- are deleted.
CREATE TABLE IF NOT EXISTS contact_attempts (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  emailed INTEGER NOT NULL DEFAULT 0,  -- 1 when this submission sent an email
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_attempts_ip ON contact_attempts(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS contact_attempts_email ON contact_attempts(email_hash, created_at);
CREATE INDEX IF NOT EXISTS contact_attempts_at ON contact_attempts(created_at);
