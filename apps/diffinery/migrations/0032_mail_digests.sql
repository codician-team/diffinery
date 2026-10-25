-- The morning digest (phase 5c, mail/digest.ts): when each person who turned it on gets their next
-- one. Their choices (hour, time zone, weekends) live in notification_prefs; this row is only the
-- schedule, written whenever those settings are saved and moved on by the cron after each send.
CREATE TABLE IF NOT EXISTS mail_digests (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  next_at TEXT NOT NULL,               -- the next send, UTC ISO
  last_sent_at TEXT                    -- the last one queued; the next digest covers what happened since
);
CREATE INDEX IF NOT EXISTS mail_digests_next ON mail_digests(next_at);
