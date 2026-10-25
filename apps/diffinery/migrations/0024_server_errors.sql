-- Unexpected server errors (lib/server-errors.ts): the newest 500 answers with a 5xx status, for
-- site administrators. `id` is the request id the answer carried. No request bodies, query
-- strings or headers are kept.
CREATE TABLE IF NOT EXISTS server_errors (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  message TEXT NOT NULL,
  stack TEXT
);
CREATE INDEX IF NOT EXISTS server_errors_at ON server_errors(at);
