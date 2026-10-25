-- Phase 3e: when a workflow run or a commit status finishes, find whether the repository has agent tasks with a
-- pull request to verify, without waking its project.
CREATE INDEX IF NOT EXISTS agent_tasks_repo ON agent_tasks(repo_id, state);
