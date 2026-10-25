-- IndexNow (lib/indexnow.ts): the public pages Diffinery tells search engines about when they are added,
-- change or go away, and what it last told them.
--
-- One row per public URL path. `kind` is 'site' for the pages built into the Worker (the home page, the
-- product, comparison and company pages, the docs, their .md versions, llms.txt) or 'repo' for a public
-- repository's page. `hash` is the page's content hash ('site'), its last push time ('repo'), or '' once a
-- site page is gone. `sent_hash` is the hash last submitted: a row waits to be submitted while it differs.
CREATE TABLE IF NOT EXISTS indexnow_urls (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  sent_hash TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS indexnow_urls_kind ON indexnow_urls(kind);

-- Each submission to IndexNow, newest kept (Settings → Search engines). `status` is IndexNow's HTTP status,
-- NULL when it couldn't be reached; `paths` is JSON, the first paths submitted.
CREATE TABLE IF NOT EXISTS indexnow_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  urls INTEGER NOT NULL,
  status INTEGER,
  ms INTEGER NOT NULL,
  error TEXT,
  paths TEXT NOT NULL
);

-- Small state: the site's content fingerprint and the deploy it came from, when repositories were last
-- checked, and when to try again after IndexNow refused or couldn't be reached.
CREATE TABLE IF NOT EXISTS indexnow_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
