import type { Env } from "../env.js";

/**
 * A person's model usage across repositories (phase 5a), from the `agent_usage` ledger each repository's
 * ProjectDO writes when a run ends: for Settings → Model access and `GET /diffinery/model-usage`. Only the
 * payer's own runs: their tasks, their coordinator's, and reviews in repositories where they turned them on, paid
 * with their own keys or subscription. Runs an organization's key paid for (phase 5b) are in its own report
 * (orgUsageReport), for its owners.
 * Repositories are named as they were when each run ended, never by a later name the payer may not be able to read.
 */

export const USAGE_DAYS_DEFAULT = 30;
export const USAGE_DAYS_MAX = 90;

export interface UsageLine {
  repoId: string;
  /** owner/name when the runs ended (null if unknown then); a renamed repository shows a line per name. */
  repository: string | null;
  kind: "task" | "review" | "coordinator";
  runs: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Only Claude Code's own figures, added up; null when no run reported one. */
  costUsd: number | null;
  /** Runs counted from what the CLI in a terminal reported, not by the model proxy. */
  reportedRuns: number;
}

export interface UsageReport {
  days: number;
  since: string;
  lines: UsageLine[];
}

export const usageDays = (v: unknown): number => {
  const d = Math.floor(Number(v ?? USAGE_DAYS_DEFAULT));
  return Number.isFinite(d) ? Math.min(Math.max(d, 1), USAGE_DAYS_MAX) : USAGE_DAYS_DEFAULT;
};

export async function usageReport(env: Env, personId: string, days = USAGE_DAYS_DEFAULT): Promise<UsageReport> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT u.repo_id, u.repository, u.kind, count(*) AS runs, sum(u.requests) AS requests, sum(u.input_tokens) AS input,
       sum(u.output_tokens) AS output, sum(u.cache_read_tokens) AS cache_read, sum(u.cache_write_tokens) AS cache_write,
       sum(u.cost_usd) AS cost, sum(u.source = 'runtime') AS reported
     FROM agent_usage u
     WHERE u.person_id = ?1 AND u.ended_at >= ?2 AND (u.key_owner IS NULL OR u.key_owner = ?1)
     GROUP BY u.repo_id, u.repository, u.kind
     ORDER BY sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) DESC
     LIMIT 200`,
  )
    .bind(personId, since)
    .all<{ repo_id: string; repository: string; kind: UsageLine["kind"]; runs: number; requests: number; input: number; output: number; cache_read: number; cache_write: number; cost: number | null; reported: number }>();
  return {
    days,
    since,
    lines: results.map((x) => ({
      repoId: x.repo_id,
      repository: x.repository || null,
      kind: x.kind,
      runs: x.runs,
      requests: x.requests,
      input: x.input,
      output: x.output,
      cacheRead: x.cache_read,
      cacheWrite: x.cache_write,
      costUsd: x.cost,
      reportedRuns: x.reported,
    })),
  };
}

export const usageReportJson = (r: UsageReport) => ({
  days: r.days,
  since: r.since,
  repositories: r.lines.map((l) => ({
    repository: l.repository,
    kind: l.kind,
    runs: l.runs,
    reported_by_cli_runs: l.reportedRuns,
    requests: l.requests,
    input_tokens: l.input,
    output_tokens: l.output,
    cache_read_tokens: l.cacheRead,
    cache_write_tokens: l.cacheWrite,
    cost_usd: l.costUsd === null ? null : Math.round(l.costUsd * 10_000) / 10_000,
  })),
});

export interface OrgUsageLine extends UsageLine {
  personId: string;
  /** The person's login now (owners see their members); null for a deleted account. */
  person: string | null;
}

/** Phase 5b: the runs an organization's keys paid for, per repository, person and kind, for its owners. */
export async function orgUsageReport(env: Env, orgId: string, days = USAGE_DAYS_DEFAULT): Promise<{ days: number; since: string; lines: OrgUsageLine[] }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT u.repo_id, u.repository, u.person_id, CASE WHEN a.deleted_at IS NULL THEN a.login END AS person, u.kind, count(*) AS runs, sum(u.requests) AS requests, sum(u.input_tokens) AS input,
       sum(u.output_tokens) AS output, sum(u.cache_read_tokens) AS cache_read, sum(u.cache_write_tokens) AS cache_write,
       sum(u.cost_usd) AS cost, sum(u.source = 'runtime') AS reported
     FROM agent_usage u LEFT JOIN accounts a ON a.id = u.person_id
     WHERE u.key_owner = ? AND u.ended_at >= ?
     GROUP BY u.repo_id, u.repository, u.person_id, u.kind
     ORDER BY sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) DESC
     LIMIT 500`,
  )
    .bind(orgId, since)
    .all<{ repo_id: string; repository: string; person_id: string; person: string | null; kind: UsageLine["kind"]; runs: number; requests: number; input: number; output: number; cache_read: number; cache_write: number; cost: number | null; reported: number }>();
  return {
    days,
    since,
    lines: results.map((x) => ({
      repoId: x.repo_id,
      repository: x.repository || null,
      personId: x.person_id,
      person: x.person,
      kind: x.kind,
      runs: x.runs,
      requests: x.requests,
      input: x.input,
      output: x.output,
      cacheRead: x.cache_read,
      cacheWrite: x.cache_write,
      costUsd: x.cost,
      reportedRuns: x.reported,
    })),
  };
}

export const orgUsageReportJson = (r: { days: number; since: string; lines: OrgUsageLine[] }) => ({
  days: r.days,
  since: r.since,
  repositories: r.lines.map((l) => ({ ...usageReportJson({ days: r.days, since: r.since, lines: [l] }).repositories[0]!, person: l.person })),
});
