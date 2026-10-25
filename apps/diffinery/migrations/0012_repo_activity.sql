-- When each repository last had pull request, review, push, run or release activity
-- (agentic/today.ts). The Today view visits the recently active repositories first;
-- repos.pushed_at alone misses work done through the API and MCP.
CREATE TABLE repo_activity (
  repo_id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE INDEX repo_activity_at ON repo_activity(at);
