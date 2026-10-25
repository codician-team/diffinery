-- Container registry (OCI distribution API at /v2/). Blob and manifest bytes live in R2;
-- this is the index: packages, which blobs and manifests each one holds, tags, and uploads.

-- A package is an image name below an owner: diffinery.com/<owner>/<name>.
-- Linked to a repository, it shares that repository's permissions (like ghcr.io).
CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL COLLATE NOCASE,
  repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'internal', 'public')),
  description TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, name)
);
CREATE INDEX packages_repo ON packages(repo_id);

-- Content-addressed blobs, stored once however many packages use them.
CREATE TABLE registry_blobs (
  digest TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE package_blobs (
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (package_id, digest)
);
CREATE INDEX package_blobs_digest ON package_blobs(digest);

CREATE TABLE package_manifests (
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  artifact_type TEXT,
  subject TEXT,
  annotations TEXT,
  size INTEGER NOT NULL,
  total_size INTEGER NOT NULL DEFAULT 0,
  platforms TEXT,
  pushed_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (package_id, digest)
);
CREATE INDEX package_manifests_subject ON package_manifests(package_id, subject);
CREATE INDEX package_manifests_digest ON package_manifests(digest);

CREATE TABLE package_tags (
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (package_id, tag)
);

-- Blob uploads in progress: an R2 object (small uploads) or multipart upload, plus a tail
-- object holding bytes that don't fill a whole part yet.
CREATE TABLE registry_uploads (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  multipart_id TEXT,
  parts TEXT NOT NULL DEFAULT '[]',
  size INTEGER NOT NULL DEFAULT 0,
  tail INTEGER NOT NULL DEFAULT 0,
  digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX registry_uploads_updated ON registry_uploads(updated_at);

-- Which blobs each manifest uses, so blobs a package no longer needs can be dropped.
CREATE TABLE package_manifest_blobs (
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  manifest TEXT NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (package_id, manifest, digest)
);
CREATE INDEX package_manifest_blobs_digest ON package_manifest_blobs(package_id, digest);
