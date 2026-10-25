-- Redirects left behind by repository transfers and renames, and by renamed accounts, like GitHub's.
-- The old owner/name keeps working (a 301 for pages and API reads, a 307 for other API calls, Git
-- served from the new location) for anyone who can read the repository, until a repository is
-- created at the old name again.

-- An old owner login and repository name, pointing at the repository's id. The login is kept as
-- text so the redirect outlives a deleted or renamed owner.
CREATE TABLE repo_redirects (
  owner_login TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL COLLATE NOCASE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_login, name)
);
CREATE INDEX repo_redirects_repo ON repo_redirects(repo_id);

-- A renamed user's or organization's earlier logins. They apply only while no account has that login.
CREATE TABLE login_redirects (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX login_redirects_account ON login_redirects(account_id);

-- Container images that moved to another owner with their repository: the old image name
-- (diffinery.com/<owner_login>/<name>) keeps resolving to the package.
CREATE TABLE package_redirects (
  owner_login TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL COLLATE NOCASE,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_login, name)
);
CREATE INDEX package_redirects_package ON package_redirects(package_id);
