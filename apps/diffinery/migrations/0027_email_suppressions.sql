-- Email suppressions (mail/suppression.ts): addresses Diffinery no longer sends any email to, because
-- mail to them bounced for good, their owner reported an email as spam, or a site administrator added
-- them. Every send checks this list first. One row per address; a newer event replaces the row.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY,              -- lower case
  reason TEXT NOT NULL CHECK (reason IN ('hard-bounce', 'complaint', 'manual')),
  detail TEXT,                         -- the provider's words (an SMTP reply) or the administrator's note
  source TEXT NOT NULL,                -- 'cloudflare' (Event Subscriptions queue), 'webhook' (signed intake) or 'admin'
  created_by TEXT,                     -- the administrator's login, for manual ones
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_suppressions_at ON email_suppressions(created_at);
