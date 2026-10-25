-- The status page (lib/status.ts): incidents site administrators open at /status, each with the
-- components it affects and its updates. An incident is investigating, identified, monitoring or
-- resolved; while it isn't resolved, its impact sets the status of each component it names.
CREATE TABLE IF NOT EXISTS status_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('minor', 'major', 'critical', 'maintenance')),
  components TEXT NOT NULL,            -- JSON array of component ids, e.g. ["web","git"]
  state TEXT NOT NULL CHECK (state IN ('investigating', 'identified', 'monitoring', 'resolved')),
  created_by TEXT,                     -- the administrator's login
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT                     -- set while the state is resolved
);
CREATE INDEX IF NOT EXISTS status_incidents_at ON status_incidents(created_at);
CREATE INDEX IF NOT EXISTS status_incidents_state ON status_incidents(state, resolved_at);

-- What was said about an incident, newest last; the first is written with the incident.
CREATE TABLE IF NOT EXISTS status_incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('investigating', 'identified', 'monitoring', 'resolved')),
  body TEXT NOT NULL,
  author_login TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS status_incident_updates_incident ON status_incident_updates(incident_id, created_at);
