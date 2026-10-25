-- Organization secrets choose which repositories get them, as on GitHub: every repository (`all`),
-- private and internal ones (`private`), or the ones listed in org_secret_repos (`selected`).
ALTER TABLE org_secrets ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';
CREATE TABLE org_secret_repos (
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (org_id, name, repo_id)
);
