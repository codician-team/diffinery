/** SQLite schema of a repository Durable Object. Applied idempotently on construction. */
export const REPO_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, oid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS objects (
  oid TEXT PRIMARY KEY, type INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB, r2 INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
-- Git LFS objects stored in R2 (repos/<id>/lfs/...), for the owner's storage quota (lib/quotas.ts).
CREATE TABLE IF NOT EXISTS lfs_objects (oid TEXT PRIMARY KEY, size INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS issues (
  number INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open', state_reason TEXT, author_id TEXT NOT NULL, author_login TEXT NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'user', assignees TEXT NOT NULL DEFAULT '[]', labels TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, locked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pulls (
  number INTEGER PRIMARY KEY, head_ref TEXT NOT NULL, head_sha TEXT NOT NULL, base_ref TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0, merged_at TEXT, merged_by TEXT,
  merge_commit TEXT, requested_reviewers TEXT NOT NULL DEFAULT '[]', intent TEXT
);
CREATE INDEX IF NOT EXISTS pulls_head ON pulls(head_ref);
-- The last mergeability check of an open pull request (repo/collab.ts), for the base and head it saw:
-- clean, conflicting, or in_base (its head is already part of the base branch). Today reads it (agentic/today-repo.ts).
CREATE TABLE IF NOT EXISTS pull_merge_state (number INTEGER PRIMARY KEY, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, author_id TEXT NOT NULL, author_login TEXT NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'user', body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  review_id TEXT, path TEXT, line INTEGER, side TEXT, commit_id TEXT, in_reply_to TEXT, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_number ON comments(number);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, author_id TEXT NOT NULL, author_login TEXT NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'user', state TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', commit_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_number ON reviews(number);
CREATE TABLE IF NOT EXISTS labels (name TEXT PRIMARY KEY, color TEXT NOT NULL, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS protections (pattern TEXT PRIMARY KEY, rules TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS variables (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, last_status INTEGER, last_delivery_at TEXT
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, sha TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, conclusion TEXT,
  run_id TEXT, job_id TEXT, details_url TEXT, output TEXT, app TEXT NOT NULL DEFAULT 'diffinery-actions',
  started_at TEXT, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS checks_sha ON checks(sha);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, run_number INTEGER NOT NULL, workflow_path TEXT NOT NULL, workflow_name TEXT NOT NULL,
  event TEXT NOT NULL, ref TEXT NOT NULL, sha TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
  conclusion TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pr_number INTEGER, attempt INTEGER NOT NULL DEFAULT 1,
  event_payload TEXT NOT NULL, inputs TEXT NOT NULL DEFAULT '{}', concurrency_group TEXT, display_title TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, job_key TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
  conclusion TEXT, matrix TEXT NOT NULL DEFAULT '{}', strategy TEXT NOT NULL DEFAULT '{}', started_at TEXT, completed_at TEXT,
  outputs TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', failure TEXT, token_hash TEXT, summary TEXT,
  container TEXT, timeout_minutes INTEGER NOT NULL DEFAULT 360, labels TEXT
);
CREATE INDEX IF NOT EXISTS jobs_run ON jobs(run_id);
CREATE TABLE IF NOT EXISTS logs (job_id TEXT NOT NULL, seq INTEGER NOT NULL, t TEXT NOT NULL, step INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (job_id, seq));
CREATE TABLE IF NOT EXISTS caches (key TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at TEXT NOT NULL, last_used TEXT NOT NULL);
-- Where older runners' artifacts were recorded before rt_artifacts; migrateRepoSchema moves them over.
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, name));
CREATE TABLE IF NOT EXISTS merge_queue (
  number INTEGER PRIMARY KEY, base_ref TEXT NOT NULL, seq INTEGER NOT NULL, head_sha TEXT NOT NULL, method TEXT NOT NULL,
  delete_branch INTEGER NOT NULL DEFAULT 0, enqueued_by TEXT NOT NULL, enqueued_at TEXT NOT NULL,
  parent_sha TEXT, group_sha TEXT, group_ref TEXT, built_at TEXT
);
CREATE TABLE IF NOT EXISTS sandboxes (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_by TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL);

-- Actions runtime services (repo/runtime.ts): the cache and artifact services the
-- official toolkit talks to, with numeric ids like GitHub's. Content lives in R2.
CREATE TABLE IF NOT EXISTS rt_caches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, version TEXT NOT NULL, scope TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, job_id TEXT, created_at TEXT NOT NULL, last_used TEXT NOT NULL,
  UNIQUE(key, version, scope)
);
CREATE INDEX IF NOT EXISTS rt_caches_used ON rt_caches(last_used);
CREATE TABLE IF NOT EXISTS rt_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, job_id TEXT NOT NULL, name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0, digest TEXT, mime_type TEXT NOT NULL DEFAULT 'application/zip', status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rt_artifacts_run ON rt_artifacts(run_id, name);
-- A partial re-run's attempt lists the artifacts of the jobs it kept by their job (repo/runtime.ts runArtifacts).
CREATE INDEX IF NOT EXISTS rt_artifacts_job ON rt_artifacts(job_id);
-- What a job's GITHUB_TOKEN may do, from the workflow's permissions (repo/runtime.ts).
CREATE TABLE IF NOT EXISTS job_grants (job_id TEXT PRIMARY KEY, role TEXT NOT NULL, permissions TEXT NOT NULL);
-- GitHub-compatible extras (see ./releases.ts, ./statuses.ts, ./deployments.ts, ./social.ts).
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tag_name TEXT NOT NULL, target_commitish TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '', draft INTEGER NOT NULL DEFAULT 0, prerelease INTEGER NOT NULL DEFAULT 0,
  author_id TEXT NOT NULL, author_login TEXT NOT NULL, author_kind TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL, published_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS releases_tag ON releases(tag_name);
CREATE TABLE IF NOT EXISTS release_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'starter', download_count INTEGER NOT NULL DEFAULT 0,
  uploader_id TEXT, uploader_login TEXT, uploader_kind TEXT, r2_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (release_id, name)
);
CREATE TABLE IF NOT EXISTS statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT NOT NULL, state TEXT NOT NULL, context TEXT NOT NULL, description TEXT, target_url TEXT,
  creator_id TEXT NOT NULL, creator_login TEXT NOT NULL, creator_kind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS statuses_sha ON statuses(sha, context);
CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT NOT NULL, ref TEXT NOT NULL, task TEXT NOT NULL DEFAULT 'deploy', environment TEXT NOT NULL,
  original_environment TEXT NOT NULL, description TEXT, payload TEXT NOT NULL DEFAULT '{}', transient INTEGER NOT NULL DEFAULT 0,
  production INTEGER NOT NULL DEFAULT 0, creator_id TEXT NOT NULL, creator_login TEXT NOT NULL, creator_kind TEXT NOT NULL,
  job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployments_env ON deployments(environment);
CREATE TABLE IF NOT EXISTS deployment_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id INTEGER NOT NULL, state TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL, environment_url TEXT NOT NULL DEFAULT '', log_url TEXT NOT NULL DEFAULT '',
  creator_id TEXT NOT NULL, creator_login TEXT NOT NULL, creator_kind TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_statuses_dep ON deployment_statuses(deployment_id);
CREATE TABLE IF NOT EXISTS environments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, branch_policy TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Required reviewers' decisions on a run's environments (repo/deployments.ts): one approval per run and environment is enough.
CREATE TABLE IF NOT EXISTS deployment_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, environment TEXT NOT NULL COLLATE NOCASE, state TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL, user_login TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_reviews_run ON deployment_reviews(run_id);
CREATE TABLE IF NOT EXISTS environment_secrets (environment TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (environment, name));
CREATE TABLE IF NOT EXISTS environment_variables (environment TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (environment, name));
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, content TEXT NOT NULL, user_id TEXT NOT NULL, user_login TEXT NOT NULL,
  user_kind TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (subject, content, user_id)
);
CREATE TABLE IF NOT EXISTS issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER NOT NULL, event TEXT NOT NULL, actor_id TEXT NOT NULL, actor_login TEXT NOT NULL,
  actor_kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_events_number ON issue_events(number);
-- Who last moved each ref: tags made by agents never match environment tag patterns
-- (./deployments.ts), and runs of code an agent pushed act as the agent (./token-policy.ts).
CREATE TABLE IF NOT EXISTS ref_actors (ref TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, updated_at TEXT NOT NULL);
-- Commits an agent pushed that aren't on the default branch yet: a run of code that includes one acts
-- as an agent, whoever pushed last or made the tag (./token-policy.ts). Dropped once they land.
CREATE TABLE IF NOT EXISTS agent_commits (oid TEXT PRIMARY KEY, pushed_at TEXT NOT NULL);
-- GitHub imports and milestones (see ./imports.ts).
CREATE TABLE IF NOT EXISTS milestones (
  number INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
  due_on TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, creator TEXT
);
CREATE TABLE IF NOT EXISTS issue_milestones (number INTEGER PRIMARY KEY, milestone INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS issue_milestones_milestone ON issue_milestones(milestone);
CREATE TABLE IF NOT EXISTS import_findings (blob TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (blob, kind));
-- Refs a running import wrote, with the oid it set, so a retry only moves refs it owns (never a ref people adopted).
CREATE TABLE IF NOT EXISTS import_refs (ref TEXT PRIMARY KEY, oid TEXT NOT NULL, import_id TEXT NOT NULL);
-- A copy of the owning organization's Actions variables (D1 org_variables), kept in sync by the Directory.
CREATE TABLE IF NOT EXISTS org_variables (name TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Self-hosted runners registered with a registration token (repo/actions.ts registerRunner). A runner
-- claims jobs with its own token, never a person's; an ephemeral one's token ends with its first job.
CREATE TABLE IF NOT EXISTS runners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, labels TEXT NOT NULL, token_hash TEXT, ephemeral INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT);
CREATE TABLE IF NOT EXISTS runner_registrations (token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires_at TEXT NOT NULL);
`;

/** Columns added after a table was first created; added with ALTER TABLE when missing. */
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  // The commit a run reports its checks on: the PR head for pull_request runs, whose
  // GITHUB_SHA is the test merge commit. Null means the run's own sha.
  ["runs", "head_sha", "TEXT"],
  // 1 when a webhook's secret is an encrypted envelope (repo/collab.ts); older rows hold it in plaintext until their next delivery.
  ["webhooks", "secret_encrypted", "INTEGER NOT NULL DEFAULT 0"],
  // 1 when the code a run executes came from an agent (repo/actions.ts agentOrigin): its jobs act as an agent.
  ["runs", "agent_origin", "INTEGER NOT NULL DEFAULT 0"],
  // The repository a pull request's head branch lives in, when it is not this one (a fork).
  ["pulls", "head_repo_id", "TEXT"],
  // Bytes an upload in progress has staged (counted against the budgets), and the
  // committed object's etag (a later overwrite of the object is refused).
  ["rt_caches", "staged", "INTEGER NOT NULL DEFAULT 0"],
  ["rt_caches", "etag", "TEXT"],
  ["rt_artifacts", "staged", "INTEGER NOT NULL DEFAULT 0"],
  ["rt_artifacts", "etag", "TEXT"],
  // 1 for an artifact an older runner uploaded through the runner API: a tarball at its legacy key (repo/runtime.ts).
  ["rt_artifacts", "legacy", "INTEGER NOT NULL DEFAULT 0"],
  // Who created a check run over the REST API (null for Diffinery Actions), and GitHub's numeric id.
  ["checks", "creator_id", "TEXT"],
  ["checks", "creator_login", "TEXT"],
  ["checks", "creator_kind", "TEXT"],
  ["checks", "seq", "INTEGER"],
  // Per matrix leg: job-level continue-on-error, and the job-level concurrency group with its cancel-in-progress.
  ["jobs", "continue_on_error", "INTEGER NOT NULL DEFAULT 0"],
  ["jobs", "concurrency_group", "TEXT"],
  ["jobs", "concurrency_cancel", "INTEGER NOT NULL DEFAULT 0"],
  // Characters of log text stored so far (repo/actions.ts MAX_JOB_LOG).
  ["jobs", "log_chars", "INTEGER NOT NULL DEFAULT 0"],
  // 1 while a queued job waits for one of the repository's hosted runner slots (an account's share, lib/quotas.ts fleetLimits).
  ["jobs", "fleet_held", "INTEGER NOT NULL DEFAULT 0"],
  // Times the platform stopped the job's container before its runner started (repo/actions.ts QUICK_RETRY_SECONDS).
  ["jobs", "early_stops", "INTEGER NOT NULL DEFAULT 0"],
  // Runners on the previous image turned away during a rollout, and when the job starts again (repo/actions.ts STALE_IMAGE_TRIES).
  ["jobs", "stale_tries", "INTEGER NOT NULL DEFAULT 0"],
  ["jobs", "image_retry_at", "INTEGER"],
  // The registered self-hosted runner that claimed the job (null for hosted jobs and personal-token claims).
  ["jobs", "runner_id", "INTEGER"],
  // Times a hosted job's container couldn't get a machine and the job went back in line (repo/actions.ts MAX_PLACEMENT_TRIES).
  ["jobs", "placement_tries", "INTEGER NOT NULL DEFAULT 0"],
  // What the runner reported when it fetched the job (JSON RunnerInfo: image, location, instance), for investigations.
  ["jobs", "runner_info", "TEXT"],
  // Times the platform replaced a hosted job's runner before its steps ran and the job started again (repo/actions.ts MAX_RUNNER_RESTARTS).
  ["jobs", "restarts", "INTEGER NOT NULL DEFAULT 0"],
  // Hosted runner size (runner/sizes.ts): the one runs-on asks for (null: chosen from the job's earlier runs),
  // the log line saying which size the job got and why, and what the job used of its runner (JSON JobUsage).
  ["jobs", "runner_size", "TEXT"],
  ["jobs", "size_note", "TEXT"],
  ["jobs", "usage", "TEXT"],
  // When a running hosted job was cancelled and why, while its runner runs the steps that run after a cancel (repo/actions.ts CANCEL_STOP_MS).
  ["jobs", "cancel_at", "INTEGER"],
  ["jobs", "cancel_reason", "TEXT"],
  // The GitHub import that wrote this row (null for everything else); a retry may only overwrite its own rows.
  ["issues", "imported", "TEXT"],
  ["pulls", "imported", "TEXT"],
  ["comments", "imported", "TEXT"],
  ["reviews", "imported", "TEXT"],
  ["labels", "imported", "TEXT"],
  ["milestones", "imported", "TEXT"],
  ["protections", "imported", "TEXT"],
  // Auto-merge while it is on (repo/auto-merge.ts AutoMergeState as JSON); null when off.
  ["pulls", "auto_merge", "TEXT"],
  // The base branch's commit when the pull request was merged (GitHub's base.sha for an imported one):
  // a merged pull request's commits and files are counted from it (repo/collab.ts diffBase).
  ["pulls", "merged_base", "TEXT"],
  ["releases", "imported", "TEXT"],
  // "task" for an agent task's sandbox (agentic/): no public sandbox call reaches it, and its git
  // credential also needs the person who started the task (task_person) to still be allowed.
  ["sandboxes", "kind", "TEXT NOT NULL DEFAULT 'api'"],
  ["sandboxes", "task_person", "TEXT"],
  // Environment protection rules (repo/deployments.ts): required reviewers as JSON [{type: "User", id, login}],
  // a wait timer in minutes, and whether whoever started a run may approve it.
  ["environments", "reviewers", "TEXT"],
  ["environments", "wait_timer", "INTEGER NOT NULL DEFAULT 0"],
  ["environments", "prevent_self_review", "INTEGER NOT NULL DEFAULT 0"],
  // The job's `environment:` name, evaluated when it is launched; runnerSpec uses this, never a second evaluation.
  ["jobs", "environment", "TEXT"],
  // While a job waits on its environment's protection rules: when it started waiting, and "released" once they passed.
  ["jobs", "gate_since", "TEXT"],
  ["jobs", "gate_state", "TEXT"],
  // Logins that started earlier attempts of a re-run (JSON list): prevent_self_review covers them too.
  ["runs", "prior_actors", "TEXT"],
  // What a partial re-run (failed jobs, or one job) keeps from the attempt it re-runs (JSON RerunCarry in
  // repo/actions.ts): per job key, the earlier attempt's job rows copied into this one instead of running.
  ["runs", "rerun_carry", "TEXT"],
  // Commits a run's remote reusable workflow calls resolved to at plan time (JSON, "repoId@ref" → sha).
  ["runs", "call_refs", "TEXT"],
  // A job copied unchanged from an earlier attempt by a partial re-run: the job that actually ran, whose log it shows.
  ["jobs", "carried_from", "TEXT"],
  // Bytes an object takes as stored (compressed, in SQLite or R2); null in objects stored before it was kept.
  ["objects", "stored", "INTEGER"],
  // A comment hidden (minimized) by someone with write access: GitHub's reason (spam, abuse, off_topic, outdated,
  // duplicate, resolved), who hid it and when (lib/moderation.ts). Null while it is shown.
  ["comments", "minimized_reason", "TEXT"],
  ["comments", "minimized_by", "TEXT"],
  ["comments", "minimized_at", "TEXT"],
  // When the job's current token was issued (repo/actions.ts jobTokenExpiry); a job not yet started counts from it.
  ["jobs", "token_at", "TEXT"],
];

export function migrateRepoSchema(sql: SqlStorage): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const has = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`, column).one().n > 0;
    if (has) continue;
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    // Job tokens issued before token_at was recorded count from this upgrade, so they still expire.
    if (table === "jobs" && column === "token_at") sql.exec("UPDATE jobs SET token_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash IS NOT NULL");
  }
  // Older runners' artifacts were first recorded in `artifacts`, which the REST API didn't list: they
  // move to rt_artifacts, kept for 90 days from their upload. One shadowed by an artifact service
  // upload of the same name was never shown and is dropped (its object goes with the bucket's age rule).
  sql.exec(
    `INSERT INTO rt_artifacts (run_id, job_id, name, size, mime_type, status, created_at, updated_at, expires_at, legacy)
     SELECT a.run_id, '', a.name, a.size, 'application/gzip', 'ready', a.created_at, a.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', a.created_at, '+90 days'), 1 FROM artifacts a
     WHERE NOT EXISTS (SELECT 1 FROM rt_artifacts r WHERE r.run_id = a.run_id AND r.name = a.name)`,
  );
  sql.exec("DELETE FROM artifacts");
}
