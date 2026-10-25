-- Private security reports (lib/security-reports.ts): what people send through /security/report, the
-- contact security.txt names first. Only site administrators can read them. A report is new, triaged
-- or resolved; the audit log keeps every change.
CREATE TABLE IF NOT EXISTS security_reports (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  area TEXT,                           -- the affected URL or area, when given
  reply_to TEXT,                       -- where to answer: the address given, or the reporter's own
  account_id TEXT,                     -- the reporter, when signed in
  reporter_login TEXT,
  ip_hash TEXT,                        -- SHA-256 of the sender's IP address, for the daily limits only
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'triaged', 'resolved')),
  note TEXT,                           -- the administrator's latest note
  updated_by TEXT,                     -- the administrator's login
  updated_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS security_reports_at ON security_reports(created_at);
CREATE INDEX IF NOT EXISTS security_reports_ip ON security_reports(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS security_reports_account ON security_reports(account_id, created_at);
