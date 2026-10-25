import type { Env } from "../env.js";
import { HttpError, now } from "./util.js";

/**
 * Per-account quotas on what Diffinery runs and keeps for an account. The account that pays is the
 * owner of the repository (a person or an organization), whoever started the work.
 *
 * - hosted_minutes: minutes of hosted Actions jobs and agent sandboxes per calendar month (UTC).
 * - hosted_jobs: hosted Actions jobs running at once across the account's repositories; more wait.
 * - sandboxes: agent sandboxes open at once across the account's repositories.
 * - repositories: repositories the account owns.
 * - storage_bytes: bytes the account stores: its repositories' git objects, Git LFS objects and release
 *   assets, and its packages' blobs and manifests. Actions artifacts and caches don't count: each
 *   repository has its own caps on them, and they expire.
 *
 * Defaults come from the environment (QUOTA_*) and otherwise DEFAULT_QUOTAS; a site administrator
 * can override them per account (account_quotas). -1 means unlimited. Accounts run by a site
 * administrator (one, or an organization with one as owner) have no quotas, so the instance's own
 * work never stops on them.
 *
 * Over every account, the instance runs at most fleetLimits().total hosted jobs at once, and one account
 * at most half of them, exempt accounts included: the fleet stays under the runner container classes'
 * max_instances, and no account can keep the others' jobs from starting.
 */
export type QuotaKey = "hosted_minutes" | "hosted_jobs" | "sandboxes" | "repositories" | "storage_bytes";
export const QUOTA_KEYS: readonly QuotaKey[] = ["hosted_minutes", "hosted_jobs", "sandboxes", "repositories", "storage_bytes"];
export type Quotas = Record<QuotaKey, number>;

export const DEFAULT_QUOTAS: Quotas = { hosted_minutes: 3000, hosted_jobs: 20, sandboxes: 5, repositories: 500, storage_bytes: 10 * 1024 ** 3 };
const ENV_KEYS: Record<QuotaKey, string> = { hosted_minutes: "QUOTA_HOSTED_MINUTES", hosted_jobs: "QUOTA_HOSTED_JOBS", sandboxes: "QUOTA_SANDBOXES", repositories: "QUOTA_REPOSITORIES", storage_bytes: "QUOTA_STORAGE_BYTES" };
/** The largest quota a site administrator can set: storage is in bytes, the rest are counts. */
const MAX_QUOTA: Record<QuotaKey, number> = { hosted_minutes: 1e9, hosted_jobs: 1e9, sandboxes: 1e9, repositories: 1e9, storage_bytes: 2 ** 50 };

/**
 * The longest a job or sandbox can run (a job's 6 hours plus start-up, a sandbox's 24-hour token):
 * a row still open after that is counted as ended then, so a lost end can't hold a slot forever.
 */
export const MAX_RUN_MS: Record<"job" | "sandbox", number> = { job: 7 * 3600_000, sandbox: 24 * 3600_000 };

const UNLIMITED: Quotas = { hosted_minutes: -1, hosted_jobs: -1, sandboxes: -1, repositories: -1, storage_bytes: -1 };

function envDefault(env: Env, k: QuotaKey): number {
  const raw = (env as unknown as Record<string, string | undefined>)[ENV_KEYS[k]];
  const n = raw === undefined || raw === "" ? NaN : Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= -1 ? n : DEFAULT_QUOTAS[k];
}

/** Whether the account is run by a site administrator (itself, or an organization with one as owner). */
async function adminRun(env: Env, accountId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "SELECT 1 FROM accounts a WHERE a.id = ? AND (a.site_admin = 1 OR EXISTS (SELECT 1 FROM org_members m JOIN accounts o ON o.id = m.user_id WHERE m.org_id = a.id AND m.role = 'owner' AND o.site_admin = 1 AND o.status = 'active'))",
  )
    .bind(accountId)
    .first();
  return !!r;
}

/** The quotas that apply to an account, and whether they're its own (overridden) or the defaults. */
export async function quotasFor(env: Env, accountId: string): Promise<Quotas & { exempt: boolean }> {
  if (await adminRun(env, accountId)) return { ...UNLIMITED, exempt: true };
  const o = await env.DB.prepare("SELECT * FROM account_quotas WHERE account_id = ?").bind(accountId).first<Record<QuotaKey, number | null>>();
  const q = {} as Quotas;
  for (const k of QUOTA_KEYS) q[k] = o?.[k] ?? envDefault(env, k);
  return { ...q, exempt: false };
}

/** Start of the current calendar month (UTC). */
export function monthStart(at = new Date()): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}

export interface Usage {
  /** Whole minutes of hosted jobs and sandboxes this month, rounded up per job or sandbox. */
  hosted_minutes: number;
  hosted_jobs: number;
  sandboxes: number;
  repositories: number;
  storage_bytes: number;
}

/** What an account uses now. */
export async function usageOf(env: Env, accountId: string, at = new Date()): Promise<Usage> {
  const [compute, repos, storage] = await Promise.all([computeUsage(env, accountId, at), env.DB.prepare("SELECT count(*) AS n FROM repos WHERE owner_id = ?").bind(accountId).first<{ n: number }>(), storedBytes(env, accountId)]);
  return { ...compute, repositories: repos?.n ?? 0, storage_bytes: storage };
}

/** The hosted minutes, jobs and sandboxes an account uses now: all a job or sandbox start needs to know. */
export async function computeUsage(env: Env, accountId: string, at = new Date()): Promise<Pick<Usage, "hosted_minutes" | "hosted_jobs" | "sandboxes">> {
  const t = at.getTime();
  const month = monthStart(at);
  // Anything that started earlier ended before the month began (or is counted as ended by then).
  const rows = await env.DB.prepare("SELECT kind, started_at, ended_at FROM compute_usage WHERE account_id = ? AND started_at >= ?")
    .bind(accountId, new Date(Math.min(Date.parse(month), t) - MAX_RUN_MS.sandbox).toISOString())
    .all<{ kind: "job" | "sandbox"; started_at: string; ended_at: string | null }>();
  let minutes = 0;
  let jobs = 0;
  let sandboxes = 0;
  for (const r of rows.results) {
    const start = Date.parse(r.started_at);
    const cap = start + MAX_RUN_MS[r.kind];
    const end = Math.min(r.ended_at ? Date.parse(r.ended_at) : t, cap);
    const from = Math.max(start, Date.parse(month));
    if (end > from) minutes += Math.ceil((end - from) / 60_000);
    if (!r.ended_at && t < cap) {
      if (r.kind === "job") jobs++;
      else sandboxes++;
    }
  }
  return { hosted_minutes: minutes, hosted_jobs: jobs, sandboxes };
}

/** Repositories not measured yet (made before storage was counted) measured by one check. */
const MEASURE_AT_ONCE = 25;

/**
 * Bytes the account stores: what its repositories last reported (repo_storage) and its packages' blobs
 * and manifests (a blob several of its packages use counts once). `live` is a repository counting its
 * own bytes, which are fresher than its report. Repositories that never reported are asked first, a
 * few per call, so storage made before it was counted is found without listing R2.
 */
export async function storedBytes(env: Env, accountId: string, live?: { repoId: string; bytes: number }): Promise<number> {
  const unmeasured = await env.DB.prepare("SELECT r.id FROM repos r LEFT JOIN repo_storage s ON s.repo_id = r.id WHERE r.owner_id = ? AND s.repo_id IS NULL AND r.id != ? LIMIT ?")
    .bind(accountId, live?.repoId ?? "", MEASURE_AT_ONCE)
    .all<{ id: string }>();
  await Promise.all(unmeasured.results.map((r) => env.REPO.get(env.REPO.idFromName(r.id)).reportStorage().catch((e: unknown) => console.error("could not measure a repository's storage", r.id, e))));
  const row = await env.DB.prepare(
    `SELECT (SELECT coalesce(sum(s.bytes), 0) FROM repo_storage s JOIN repos r ON r.id = s.repo_id WHERE r.owner_id = ?1 AND r.id != ?2)
      + (SELECT coalesce(sum(b.size), 0) FROM registry_blobs b WHERE b.digest IN (SELECT pb.digest FROM package_blobs pb JOIN packages p ON p.id = pb.package_id WHERE p.owner_id = ?1))
      + (SELECT coalesce(sum(m.size), 0) FROM package_manifests m JOIN packages p ON p.id = m.package_id WHERE p.owner_id = ?1) AS n`,
  )
    .bind(accountId, live?.repoId ?? "")
    .first<{ n: number }>();
  return (row?.n ?? 0) + (live?.bytes ?? 0);
}

/**
 * Why a write of `adding` more bytes (0 when not known in advance) must be refused, or null: it would
 * take the account past its storage quota. Reads and deletes never ask, so an account past its quota
 * can always get back under it.
 */
export async function storageRefusal(env: Env, accountId: string, login: string, adding = 0, live?: { repoId: string; bytes: number }): Promise<string | null> {
  const q = await quotasFor(env, accountId);
  if (q.exempt || q.storage_bytes < 0) return null;
  if ((await storedBytes(env, accountId, live)) + adding <= q.storage_bytes) return null;
  return `${login} has reached its storage limit of ${q.storage_bytes} bytes (git objects, Git LFS objects, release assets and packages); delete some or ask a site administrator to raise it`;
}

/** Bytes the account may still store: Infinity when it has no limit. */
export async function storageHeadroom(env: Env, accountId: string): Promise<number> {
  const q = await quotasFor(env, accountId);
  if (q.exempt || q.storage_bytes < 0) return Infinity;
  return Math.max(0, q.storage_bytes - (await storedBytes(env, accountId)));
}

/** Refuse a write past the account's storage quota (see storageRefusal). */
export async function checkStorageQuota(env: Env, accountId: string, login: string, adding = 0): Promise<void> {
  const refused = await storageRefusal(env, accountId, login, adding);
  if (refused) throw new HttpError(403, refused);
}

const within = (limit: number, used: number) => limit < 0 || used < limit;

/**
 * Hosted jobs the instance runs at once by default. Under the runner container classes' max_instances
 * (100) with room to spare: repositories start jobs side by side, each counting before the others' starts
 * are recorded, so a burst can pass the limit by a few.
 */
export const HOSTED_JOBS_LIMIT = 80;

/** Hosted jobs at once: `total` over the whole instance (HOSTED_JOBS_LIMIT), `share` for one account (half of it). */
export function fleetLimits(env: Env): { total: number; share: number } {
  const n = Math.trunc(Number(env.HOSTED_JOBS_LIMIT));
  const total = Number.isFinite(n) && n >= 2 ? n : HOSTED_JOBS_LIMIT;
  return { total, share: Math.floor(total / 2) };
}

/** Hosted jobs running now, the instance's or one account's (a row left open past MAX_RUN_MS no longer counts, as in computeUsage). */
async function runningJobs(env: Env, accountId?: string): Promise<number> {
  const since = new Date(Date.now() - MAX_RUN_MS.job).toISOString();
  const q = accountId
    ? env.DB.prepare("SELECT count(*) AS n FROM compute_usage WHERE account_id = ? AND kind = 'job' AND ended_at IS NULL AND started_at > ?").bind(accountId, since)
    : env.DB.prepare("SELECT count(*) AS n FROM compute_usage WHERE ended_at IS NULL AND started_at > ? AND kind = 'job'").bind(since);
  return (await q.first<{ n: number }>())?.n ?? 0;
}

/**
 * Whether the account may start a hosted job or a sandbox now: "ok", "wait" (a job waits for one of
 * the account's running jobs to end), or an error message (minutes used up, or too many sandboxes).
 */
export async function mayStart(env: Env, accountId: string, kind: "job" | "sandbox"): Promise<{ ok: true } | { ok: false; wait: boolean; message: string }> {
  const q = await quotasFor(env, accountId);
  let running: number | null = null;
  if (!q.exempt) {
    // Not usageOf: a start doesn't need the repository count or the storage total (up to 25 repositories asked).
    const u = await computeUsage(env, accountId);
    if (!within(q.hosted_minutes, u.hosted_minutes))
      return { ok: false, wait: false, message: `this account has used its ${q.hosted_minutes} hosted minutes for this month (Actions jobs on hosted runners and agent sandboxes); they renew on the 1st (UTC). Self-hosted runners still work` };
    if (kind === "job" && !within(q.hosted_jobs, u.hosted_jobs)) return { ok: false, wait: true, message: `waiting for one of this account's ${q.hosted_jobs} hosted jobs to finish` };
    if (kind === "sandbox" && !within(q.sandboxes, u.sandboxes)) return { ok: false, wait: false, message: `this account already has ${q.sandboxes} agent sandboxes open; close one or wait for one to finish` };
    running = u.hosted_jobs;
  }
  if (kind === "job") {
    // The fleet's limits hold for every account, exempt ones too.
    const fleet = fleetLimits(env);
    if ((running ?? (await runningJobs(env, accountId))) >= fleet.share) return { ok: false, wait: true, message: `waiting for one of this account's hosted jobs to finish: one account runs at most ${fleet.share} at once, half of this Diffinery's hosted runners` };
    if ((await runningJobs(env)) >= fleet.total) return { ok: false, wait: true, message: `waiting for a hosted runner: all ${fleet.total} of this Diffinery's hosted runners are busy` };
  }
  return { ok: true };
}

/** Record that a hosted job or sandbox started; `id` is the job or sandbox id. */
export async function startCompute(env: Env, row: { id: string; accountId: string; repoId: string; kind: "job" | "sandbox" }): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO compute_usage (id, account_id, repo_id, kind, started_at) VALUES (?, ?, ?, ?, ?)").bind(row.id, row.accountId, row.repoId, row.kind, now()).run();
}

/** Record that a hosted job or sandbox ended (idempotent). */
export async function endCompute(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE compute_usage SET ended_at = ? WHERE id = ? AND ended_at IS NULL").bind(now(), id).run();
}

/** Refuse a new repository past the owner's quota. */
export async function checkRepositoryQuota(env: Env, ownerId: string, ownerLogin: string): Promise<void> {
  const q = await quotasFor(env, ownerId);
  if (q.exempt || q.repositories < 0) return;
  const n = (await env.DB.prepare("SELECT count(*) AS n FROM repos WHERE owner_id = ?").bind(ownerId).first<{ n: number }>())?.n ?? 0;
  if (n >= q.repositories) throw new HttpError(403, `${ownerLogin} has reached its limit of ${q.repositories} repositories; delete one or ask a site administrator to raise it`);
}

/** A site administrator's overrides for an account; null clears one back to the default. */
export async function setQuotas(env: Env, accountId: string, patch: Partial<Record<QuotaKey, number | null>>, by: string): Promise<void> {
  for (const [k, v] of Object.entries(patch)) {
    if (!QUOTA_KEYS.includes(k as QuotaKey)) throw new HttpError(422, `unknown quota ${k}; use ${QUOTA_KEYS.join(", ")}`);
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < -1 || v > MAX_QUOTA[k as QuotaKey])) throw new HttpError(422, `${k} must be a whole number, -1 for unlimited, or null for the default`);
  }
  const cur = (await env.DB.prepare("SELECT * FROM account_quotas WHERE account_id = ?").bind(accountId).first<Record<QuotaKey, number | null>>()) ?? null;
  const next = Object.fromEntries(QUOTA_KEYS.map((k) => [k, k in patch ? (patch[k] ?? null) : (cur?.[k] ?? null)])) as Record<QuotaKey, number | null>;
  await env.DB.prepare(
    "INSERT INTO account_quotas (account_id, hosted_minutes, hosted_jobs, sandboxes, repositories, storage_bytes, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET hosted_minutes = excluded.hosted_minutes, hosted_jobs = excluded.hosted_jobs, sandboxes = excluded.sandboxes, repositories = excluded.repositories, storage_bytes = excluded.storage_bytes, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  )
    .bind(accountId, next.hosted_minutes, next.hosted_jobs, next.sandboxes, next.repositories, next.storage_bytes, now(), by)
    .run();
}
