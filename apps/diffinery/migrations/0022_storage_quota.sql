-- What each repository stores for its owner's storage quota (lib/quotas.ts): git objects, Git LFS objects
-- and release assets, in bytes, as the repository's Durable Object last reported it. No row: not measured yet.
CREATE TABLE IF NOT EXISTS repo_storage (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE account_quotas ADD COLUMN storage_bytes INTEGER;

