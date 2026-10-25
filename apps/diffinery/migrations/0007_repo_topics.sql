-- Repository topics (GitHub's `topics`), shown in repository JSON and searchable with `topic:`.
ALTER TABLE repos ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
