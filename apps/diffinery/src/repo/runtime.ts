import type { Env } from "../env.js";
import { uuidPattern } from "../http/gh.js";
import { dropStaged, finalKey, runComposeStep, stagingPrefix, stepKeys, type BlobBucket, type ComposeStep } from "../lib/blob-store.js";
import { READ_ALL, roleForPermissions, type JobPermissions } from "../lib/job-permissions.js";
import { legacyArtifactKeys } from "../lib/storage-keys.js";
import { HttpError, now } from "../lib/util.js";
import type { RepoDO } from "./RepoDO.js";
import type { Role } from "./types.js";

/**
 * Metadata for the Actions runtime services: GitHub's cache service (keys,
 * versions and branch scopes) and artifact service (per-run artifacts with
 * numeric ids and retention). The Worker (http/actions-runtime.ts) handles the
 * wire protocols and moves the bytes; this module decides what may be read or
 * written. Every call made with a runtime token names the job, and works only
 * while that job is running.
 *
 * Artifacts that older runners upload through the runner API (a tarball per
 * name, stored at its legacy key) are recorded here too, as `legacy` rows, so
 * they get numeric ids, are listed, counted, expired and deleted like the
 * others. The toolkit's own listing leaves them out, as GitHub's v4 service
 * leaves out v3 artifacts.
 */

export type CacheEntry = { id: number; key: string; version: string; scope: string; size: number; createdAt: string; lastUsed: string; etag: string | null };
export type ArtifactEntry = { id: number; runId: string; runNumber: number; headBranch: string; headSha: string; jobId: string; name: string; size: number; digest: string | null; mimeType: string; createdAt: string; updatedAt: string; expiresAt: string; expired: boolean; etag: string | null; legacy: boolean };

export type JobScope = {
  runId: string;
  jobId: string;
  /** Cache scopes the job may read: its own ref first (also writable), then the PR base and the default branch. */
  scopes: string[];
};

type CacheRow = { id: number; key: string; version: string; scope: string; size: number; status: string; job_id: string | null; created_at: string; last_used: string; staged: number; etag: string | null };
type ArtifactRow = { id: number; run_id: string; job_id: string; name: string; size: number; digest: string | null; mime_type: string; status: string; created_at: string; updated_at: string; expires_at: string; staged: number; etag: string | null; legacy: number };

/** Per-repository cache budget, and how long an unused entry is kept (GitHub's limits). */
export const CACHE_LIMIT_BYTES = 10 * 1024 ** 3;
export const CACHE_IDLE_MS = 7 * 24 * 3600_000;
/** Artifact retention: `retention-days` is clamped to 1..90 days, GitHub's default maximum. */
export const MAX_RETENTION_DAYS = 90;
/** How long an expired artifact stays listed (as `expired: true`) after its content is deleted. */
const EXPIRED_LISTED_DAYS = 90;
/** Artifact storage per repository unless ARTIFACT_QUOTA_BYTES says otherwise. */
export const DEFAULT_ARTIFACT_QUOTA = 10 * 1024 ** 3;
/** Largest block, chunk or single-request upload accepted. */
export const MAX_UPLOAD_PART = 256 * 1024 * 1024;

const toCache = (r: CacheRow): CacheEntry => ({ id: r.id, key: r.key, version: r.version, scope: r.scope, size: r.size, createdAt: r.created_at, lastUsed: r.last_used, etag: r.etag });

/** Where an artifact's content is: its object, or an older runner's tarball (the current key, then the old layout's). */
export function artifactObjectKeys(repo: string, a: Pick<ArtifactEntry, "id" | "runId" | "name" | "legacy">): string[] {
  return a.legacy ? legacyArtifactKeys(repo, a.runId, a.name) : [finalKey({ repo, kind: "artifact", id: a.id })];
}

/** The file an artifact downloads as: a zip, a single unarchived file, or an older runner's tarball. */
export function artifactFileName(a: Pick<ArtifactEntry, "name" | "mimeType" | "legacy">): string {
  return a.legacy ? `${a.name}.tar.gz` : a.mimeType === "application/zip" ? `${a.name}.zip` : a.name;
}

export class Runtime {
  constructor(
    private repo: RepoDO,
    private env: Env,
  ) {}

  private get sql() {
    return this.repo.sql;
  }

  private get bucket(): BlobBucket {
    return this.env.BUCKET as unknown as BlobBucket;
  }

  private get repoId(): string {
    return this.repo.meta.repoId;
  }

  /** Artifact storage this repository may use (live artifacts plus uploads in progress). */
  get artifactQuota(): number {
    const n = Number(this.env.ARTIFACT_QUOTA_BYTES);
    return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_ARTIFACT_QUOTA;
  }

  // ---------------------------------------------------------------- jobs

  /** The job a runtime token names, if it is still running. */
  job(jobId: string, runId?: string): JobScope {
    const j = this.sql
      .exec<{ status: string; run_id: string; ref: string; event_payload: string }>("SELECT j.status, j.run_id, r.ref, r.event_payload FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.id = ?", jobId)
      .toArray()[0];
    if (!j || j.status !== "in_progress" || (runId && runId !== j.run_id)) throw new HttpError(401, "the job is not running");
    // Pull requests also read their base branch's caches, and merge groups their target branch's.
    let base: string | undefined;
    try {
      const p = JSON.parse(j.event_payload) as { pull_request?: { base?: { ref?: string } }; merge_group?: { base_ref?: string } };
      base = p.pull_request?.base?.ref ?? p.merge_group?.base_ref?.replace(/^refs\/heads\//, "");
    } catch {
      /* no payload */
    }
    const scopes = [j.ref, ...(base ? [`refs/heads/${base}`] : []), `refs/heads/${this.repo.meta.defaultBranch}`];
    return { runId: j.run_id, jobId, scopes: [...new Set(scopes)] };
  }

  /** Records what the job token may do (its effective `permissions:`, set when the job starts). */
  grant(jobId: string, perms: JobPermissions): void {
    this.sql.exec("INSERT OR REPLACE INTO job_grants (job_id, role, permissions) VALUES (?, ?, ?)", jobId, roleForPermissions(perms), JSON.stringify(perms));
  }

  /** What a job token may do; read-only for a job that has not started. */
  grantFor(jobId: string): { role: Role; permissions: JobPermissions } {
    const r = this.sql.exec<{ role: Role; permissions: string }>("SELECT role, permissions FROM job_grants WHERE job_id = ?", jobId).toArray()[0];
    return r ? { role: r.role, permissions: { ...READ_ALL, ...(JSON.parse(r.permissions) as Partial<JobPermissions>) } } : { role: "read", permissions: { ...READ_ALL } };
  }

  // ---------------------------------------------------------------- cache

  /**
   * GitHub's lookup order: in each scope (own ref, PR base, default branch),
   * an exact match of the primary key, then the newest entry whose key starts
   * with it, then the same for each restore key. The version must match.
   */
  cacheLookup(jobId: string, keys: string[], version: string): CacheEntry | null {
    const { scopes } = this.job(jobId);
    for (const scope of scopes) {
      for (const key of keys) {
        const exact = this.sql.exec<CacheRow>("SELECT * FROM rt_caches WHERE key = ? AND version = ? AND scope = ? AND status = 'ready'", key, version, scope).toArray()[0];
        const hit =
          exact ??
          this.sql
            .exec<CacheRow>("SELECT * FROM rt_caches WHERE substr(key, 1, ?) = ? AND version = ? AND scope = ? AND status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 1", key.length, key, version, scope)
            .toArray()[0];
        if (hit) {
          this.sql.exec("UPDATE rt_caches SET last_used = ? WHERE id = ?", now(), hit.id);
          return toCache(hit);
        }
      }
    }
    return null;
  }

  /** Reserves `key` in the job's own scope. Returns null when an entry already exists there. */
  async cacheReserve(jobId: string, key: string, version: string): Promise<{ id: number } | null> {
    const { scopes } = this.job(jobId);
    if (!key || key.length > 512 || key.includes(",")) throw new HttpError(400, "invalid cache key");
    if (!/^[0-9a-f]{1,128}$/i.test(version)) throw new HttpError(400, "invalid cache version");
    const scope = scopes[0]!;
    const existing = this.sql.exec<CacheRow>("SELECT * FROM rt_caches WHERE key = ? AND version = ? AND scope = ?", key, version, scope).toArray()[0];
    if (existing) {
      // A reservation abandoned by a job that has finished can be taken over.
      const holder = existing.job_id ? this.sql.exec<{ status: string }>("SELECT status FROM jobs WHERE id = ?", existing.job_id).toArray()[0] : undefined;
      if (existing.status === "ready" || holder?.status === "in_progress") return null;
      this.sql.exec("DELETE FROM rt_caches WHERE id = ?", existing.id);
      await this.dropObjects("cache", [existing.id]);
    }
    await this.evictCaches();
    const t = now();
    this.sql.exec("INSERT INTO rt_caches (key, version, scope, size, status, job_id, created_at, last_used) VALUES (?, ?, ?, 0, 'reserved', ?, ?, ?)", key, version, scope, jobId, t, t);
    return { id: this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id };
  }

  /** The job's own reservation, by id or by key and version. */
  cacheReservation(jobId: string, ref: { id?: number; key?: string; version?: string }): CacheEntry | null {
    const row =
      ref.id !== undefined
        ? this.sql.exec<CacheRow>("SELECT * FROM rt_caches WHERE id = ?", ref.id).toArray()[0]
        : this.sql.exec<CacheRow>("SELECT * FROM rt_caches WHERE key = ? AND version = ? AND job_id = ? AND status = 'reserved' ORDER BY id DESC LIMIT 1", ref.key ?? "", ref.version ?? "", jobId).toArray()[0];
    if (!row || row.job_id !== jobId || row.status !== "reserved") return null;
    this.job(jobId);
    return toCache(row);
  }

  /** Whether entry `id`'s content may still be written (it is reserved by a running job). */
  cacheWritable(id: number): boolean {
    const r = this.sql.exec<{ status: string; job: string | null }>("SELECT c.status, j.status AS job FROM rt_caches c LEFT JOIN jobs j ON j.id = c.job_id WHERE c.id = ?", id).toArray()[0];
    return !!r && r.status === "reserved" && r.job === "in_progress";
  }

  /** Bytes of committed entries plus everything staged by uploads in progress. */
  private cacheBytes(): number {
    return this.sql.exec<{ n: number | null }>("SELECT sum(CASE WHEN status = 'ready' THEN size ELSE staged END) AS n FROM rt_caches").one().n ?? 0;
  }

  /** Bytes of live artifacts (from both upload paths) plus everything staged by uploads in progress. */
  private artifactBytes(): number {
    return this.sql.exec<{ n: number | null }>("SELECT sum(CASE WHEN status = 'ready' THEN size ELSE staged END) AS n FROM rt_artifacts WHERE status != 'ready' OR expires_at > ?", now()).one().n ?? 0;
  }

  /**
   * Accounts for `bytes` an upload is about to stage (a block, a chunk or a whole
   * blob), before they are written. The upload must belong to a running job and
   * stay within the repository's budget: for caches, the least recently used
   * entries are evicted to make room; artifacts have a quota and are refused beyond it.
   */
  async stage(kind: "cache" | "artifact", id: number, bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new HttpError(400, "invalid length");
    if (bytes > MAX_UPLOAD_PART) throw new HttpError(413, `a single upload request may carry at most ${MAX_UPLOAD_PART} bytes`);
    if (kind === "cache") {
      if (!this.cacheWritable(id)) throw new HttpError(409, "this upload is finished or its job is no longer running");
      const own = this.sql.exec<{ staged: number }>("SELECT staged FROM rt_caches WHERE id = ?", id).one().staged;
      if (own + bytes > CACHE_LIMIT_BYTES) throw new HttpError(413, `a cache entry may be at most ${CACHE_LIMIT_BYTES} bytes`);
      if (this.cacheBytes() + bytes > CACHE_LIMIT_BYTES) await this.evictCaches(bytes);
      if (this.cacheBytes() + bytes > CACHE_LIMIT_BYTES) throw new HttpError(413, "uploads in progress use the repository's whole cache budget");
      this.sql.exec("UPDATE rt_caches SET staged = staged + ? WHERE id = ?", bytes, id);
      return;
    }
    if (!this.artifactWritable(id)) throw new HttpError(409, "this upload is finished or its job is no longer running");
    await this.expireArtifacts();
    if (this.artifactBytes() + bytes > this.artifactQuota) throw new HttpError(413, `the repository's artifact storage quota (${this.artifactQuota} bytes) is used up; delete artifacts or wait for them to expire`);
    this.sql.exec("UPDATE rt_artifacts SET staged = staged + ? WHERE id = ?", bytes, id);
  }

  /** Gives back what `stage` counted for a write that then failed, so a failed upload doesn't hold quota. */
  unstage(kind: "cache" | "artifact", id: number, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.sql.exec(`UPDATE ${kind === "cache" ? "rt_caches" : "rt_artifacts"} SET staged = max(0, staged - ?) WHERE id = ?`, bytes, id);
  }

  /** Bytes an older runner's artifact upload may still store under the quota. */
  async artifactRoom(): Promise<number> {
    await this.expireArtifacts();
    return Math.max(0, this.artifactQuota - this.artifactBytes());
  }

  /** Whether `size` committed bytes for upload `id` fit the budget (evicting caches to make room). */
  async checkCommitSize(kind: "cache" | "artifact", id: number, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "invalid size");
    if (kind === "cache") {
      if (size > CACHE_LIMIT_BYTES) throw new HttpError(413, `a cache entry may be at most ${CACHE_LIMIT_BYTES} bytes`);
      const own = this.sql.exec<{ staged: number }>("SELECT staged FROM rt_caches WHERE id = ?", id).toArray()[0]?.staged ?? 0;
      if (this.cacheBytes() - own + size > CACHE_LIMIT_BYTES) await this.evictCaches(size - own);
      if (this.cacheBytes() - own + size > CACHE_LIMIT_BYTES) throw new HttpError(413, "the repository's cache budget is used up by uploads in progress");
      return;
    }
    const own = this.sql.exec<{ staged: number }>("SELECT staged FROM rt_artifacts WHERE id = ?", id).toArray()[0]?.staged ?? 0;
    if (this.artifactBytes() - own + size > this.artifactQuota) throw new HttpError(413, `the repository's artifact storage quota (${this.artifactQuota} bytes) is used up`);
  }

  /** Commits a reservation; `etag` is the object's, so a later overwrite is detected and refused. */
  async cacheCommit(jobId: string, id: number, size: number, etag: string): Promise<CacheEntry> {
    const r = this.cacheReservation(jobId, { id });
    if (!r) throw new HttpError(404, "cache reservation not found");
    try {
      await this.checkCommitSize("cache", id, size);
    } catch (e) {
      this.sql.exec("DELETE FROM rt_caches WHERE id = ?", id);
      await this.dropObjects("cache", [id]);
      throw e;
    }
    const t = now();
    this.sql.exec("UPDATE rt_caches SET status = 'ready', size = ?, staged = 0, etag = ?, created_at = ?, last_used = ? WHERE id = ?", size, etag, t, t, id);
    return { ...r, size, etag, createdAt: t, lastUsed: t };
  }

  cacheGet(id: number): CacheEntry | null {
    const r = this.sql.exec<CacheRow>("SELECT * FROM rt_caches WHERE id = ? AND status = 'ready'", id).toArray()[0];
    return r ? toCache(r) : null;
  }

  /** An entry whose object is gone: forget it, so lookups move on to the next match. */
  async cacheMissing(id: number): Promise<void> {
    await this.deleteCacheIds([id]);
  }

  /**
   * Drops entries unused for a week, then the least recently used ones until
   * committed entries and uploads in progress fit the budget with `room` to spare.
   */
  private async evictCaches(room = 0): Promise<void> {
    const stale = this.sql.exec<{ id: number }>("SELECT id FROM rt_caches WHERE status = 'ready' AND last_used < ?", new Date(Date.now() - CACHE_IDLE_MS).toISOString()).toArray().map((r) => r.id);
    let total = this.cacheBytes() + room;
    const over: number[] = [];
    for (const r of this.sql.exec<{ id: number; size: number }>("SELECT id, size FROM rt_caches WHERE status = 'ready' ORDER BY last_used, id").toArray()) {
      if (stale.includes(r.id)) total -= r.size;
      else if (total > CACHE_LIMIT_BYTES) {
        over.push(r.id);
        total -= r.size;
      }
    }
    await this.deleteCacheIds([...stale, ...over]);
  }

  private async deleteCacheIds(ids: number[]): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) this.sql.exec("DELETE FROM rt_caches WHERE id = ?", id);
    await this.dropObjects("cache", ids, false);
  }

  /** Deletes the objects of dropped rows: the final object and, for unfinished uploads, what they staged. */
  private async dropObjects(kind: "cache" | "artifact", ids: number[], staged = true): Promise<void> {
    const keys = ids.map((id) => finalKey({ repo: this.repoId, kind, id }));
    for (let i = 0; i < keys.length; i += 1000) await this.bucket.delete(keys.slice(i, i + 1000));
    // A page of staged objects per upload; the lifecycle rule on actions-staging/ takes any rest.
    if (staged) for (const id of ids.slice(0, 20)) await dropStaged(this.bucket, { repo: this.repoId, kind, id });
  }

  /** Deletes older runners' tarballs (both layouts' keys). */
  private async dropLegacyArtifacts(rows: Array<{ runId: string; name: string }>): Promise<void> {
    const keys = rows.flatMap((r) => legacyArtifactKeys(this.repoId, r.runId, r.name));
    for (let i = 0; i < keys.length; i += 1000) await this.bucket.delete(keys.slice(i, i + 1000));
  }

  /**
   * When a job ends, its unfinished uploads go: their rows, so they stop counting
   * against the budgets, and their objects.
   */
  async sweepJob(jobId: string, o: { restart?: boolean } = {}): Promise<void> {
    // A job starting again from the beginning (the platform replaced its runner) drops what it finished uploading too.
    const caches = this.sql.exec<{ id: number }>(`SELECT id FROM rt_caches WHERE job_id = ?${o.restart ? "" : " AND status = 'reserved'"}`, jobId).toArray().map((r) => r.id);
    const artifacts = this.sql.exec<{ id: number }>(`SELECT id FROM rt_artifacts WHERE job_id = ?${o.restart ? "" : " AND status = 'uploading'"}`, jobId).toArray().map((r) => r.id);
    for (const id of caches) this.sql.exec("DELETE FROM rt_caches WHERE id = ?", id);
    for (const id of artifacts) this.sql.exec("DELETE FROM rt_artifacts WHERE id = ?", id);
    if (caches.length) await this.dropObjects("cache", caches);
    if (artifacts.length) await this.dropObjects("artifact", artifacts);
    await this.expireArtifacts();
  }

  /**
   * One step of composing an upload (lib/blob-store.ts), run here so that it gets
   * an invocation, and subrequests, of its own. It may only touch this upload's
   * staging area and final object, while the upload is in progress.
   */
  async composeStep(ref: { kind: "cache" | "artifact"; id: number }, step: ComposeStep, contentType?: string): Promise<Array<{ partNumber: number; etag: string }>> {
    const writable = ref.kind === "cache" ? this.cacheWritable(ref.id) : this.artifactWritable(ref.id);
    if (!writable) throw new HttpError(409, "this upload is finished or its job is no longer running");
    const b = { repo: this.repoId, kind: ref.kind, id: ref.id };
    if (!stepKeys(step).every((k) => k === finalKey(b) || k.startsWith(stagingPrefix(b)))) throw new HttpError(400, "the step names objects outside this upload");
    return runComposeStep(this.bucket, step, contentType);
  }

  /** REST: GET /actions/caches (newest first). */
  listCaches(o: { key?: string; ref?: string; sort?: string; direction?: string; page?: number; perPage?: number }): { total: number; caches: CacheEntry[] } {
    const where = ["status = 'ready'"];
    const args: unknown[] = [];
    if (o.key) {
      where.push("substr(key, 1, ?) = ?");
      args.push(o.key.length, o.key);
    }
    if (o.ref) {
      where.push("scope = ?");
      args.push(o.ref);
    }
    const col = o.sort === "size_in_bytes" ? "size" : o.sort === "created_at" ? "created_at" : "last_used";
    const dir = o.direction === "asc" ? "ASC" : "DESC";
    const w = `WHERE ${where.join(" AND ")}`;
    const total = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM rt_caches ${w}`, ...args).one().n;
    const per = Math.min(Math.max(o.perPage ?? 30, 1), 100);
    const rows = this.sql.exec<CacheRow>(`SELECT * FROM rt_caches ${w} ORDER BY ${col} ${dir}, id ${dir} LIMIT ? OFFSET ?`, ...args, per, (Math.max(o.page ?? 1, 1) - 1) * per).toArray();
    return { total, caches: rows.map(toCache) };
  }

  /** REST: DELETE /actions/caches?key=&ref= or /actions/caches/:id. */
  async deleteCaches(o: { id?: number; key?: string; ref?: string }): Promise<CacheEntry[]> {
    const rows =
      o.id !== undefined
        ? this.sql.exec<CacheRow>("SELECT * FROM rt_caches WHERE id = ? AND status = 'ready'", o.id).toArray()
        : this.sql.exec<CacheRow>("SELECT * FROM rt_caches WHERE key = ? AND status = 'ready'" + (o.ref ? " AND scope = ?" : ""), ...(o.ref ? [o.key ?? "", o.ref] : [o.key ?? ""])).toArray();
    await this.deleteCacheIds(rows.map((r) => r.id));
    return rows.map(toCache);
  }

  cacheUsage(): { count: number; size: number } {
    const r = this.sql.exec<{ n: number; s: number | null }>("SELECT count(*) AS n, sum(size) AS s FROM rt_caches WHERE status = 'ready'").one();
    return { count: r.n, size: r.s ?? 0 };
  }

  // ---------------------------------------------------------------- artifacts

  private toArtifact = (r: ArtifactRow): ArtifactEntry => {
    const run = this.sql.exec<{ n: number; ref: string; sha: string }>("SELECT run_number AS n, ref, sha FROM runs WHERE id = ?", r.run_id).toArray()[0];
    return {
      id: r.id,
      runId: r.run_id,
      runNumber: run?.n ?? 0,
      headBranch: (run?.ref ?? "").replace(/^refs\/(heads|tags)\//, ""),
      headSha: run?.sha ?? "",
      jobId: r.job_id,
      name: r.name,
      size: r.size,
      digest: r.digest,
      mimeType: r.mime_type,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
      expired: r.status === "expired" || r.expires_at <= now(),
      etag: r.etag,
      legacy: r.legacy === 1,
    };
  };

  async artifactCreate(jobId: string, name: string, mimeType: string | undefined, expiresAt: string | undefined): Promise<{ id: number }> {
    const { runId } = this.job(jobId);
    if (!name || name.length > 256 || /[":<>|*?\\/\r\n]/.test(name)) throw new HttpError(400, `invalid artifact name: ${name}`);
    await this.expireArtifacts();
    const existing = this.sql.exec<ArtifactRow>("SELECT * FROM rt_artifacts WHERE run_id = ? AND name = ?", runId, name).toArray();
    if (existing.some((a) => a.status === "ready")) throw new HttpError(409, `an artifact with this name already exists on the workflow run`);
    // Unfinished uploads (a crashed earlier attempt) are replaced, objects and all.
    for (const a of existing) this.sql.exec("DELETE FROM rt_artifacts WHERE id = ?", a.id);
    if (existing.length) await this.dropObjects("artifact", existing.map((a) => a.id));
    const maxExpiry = Date.now() + MAX_RETENTION_DAYS * 86400_000;
    const requested = expiresAt ? Date.parse(expiresAt) : NaN;
    const expiry = new Date(Number.isFinite(requested) ? Math.min(Math.max(requested, Date.now() + 86400_000), maxExpiry) : maxExpiry).toISOString();
    const t = now();
    this.sql.exec(
      "INSERT INTO rt_artifacts (run_id, job_id, name, size, mime_type, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, 0, ?, 'uploading', ?, ?, ?)",
      runId,
      jobId,
      name,
      mimeType || "application/zip",
      t,
      t,
      expiry,
    );
    return { id: this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id };
  }

  /** The job's unfinished upload of artifact `name`. */
  artifactUpload(jobId: string, name: string): ArtifactEntry | null {
    const { runId } = this.job(jobId);
    const r = this.sql.exec<ArtifactRow>("SELECT * FROM rt_artifacts WHERE run_id = ? AND name = ? AND job_id = ? AND status = 'uploading' ORDER BY id DESC LIMIT 1", runId, name, jobId).toArray()[0];
    return r ? this.toArtifact(r) : null;
  }

  artifactWritable(id: number): boolean {
    const r = this.sql.exec<{ status: string; job: string | null }>("SELECT a.status, j.status AS job FROM rt_artifacts a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.id = ?", id).toArray()[0];
    return !!r && r.status === "uploading" && r.job === "in_progress";
  }

  /** Finishes an upload; `etag` is the object's, so a later overwrite is detected and refused. */
  async artifactFinalize(jobId: string, name: string, size: number, digest: string | undefined, etag: string): Promise<ArtifactEntry> {
    const a = this.artifactUpload(jobId, name);
    if (!a) throw new HttpError(404, `no upload of artifact '${name}' in progress`);
    try {
      await this.checkCommitSize("artifact", a.id, size);
    } catch (e) {
      this.sql.exec("DELETE FROM rt_artifacts WHERE id = ?", a.id);
      await this.dropObjects("artifact", [a.id]);
      throw e;
    }
    this.sql.exec("UPDATE rt_artifacts SET status = 'ready', size = ?, staged = 0, digest = ?, etag = ?, updated_at = ? WHERE id = ?", size, digest ?? null, etag, now(), a.id);
    return this.artifactGet(a.id)!;
  }

  /**
   * Refuses an older runner's upload of `name` when the artifact service already
   * has an artifact of that name in the run (names are unique in a run). The
   * runner's own earlier upload of the name is replaced instead.
   */
  legacyArtifactCheck(runId: string, name: string): void {
    const taken = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM rt_artifacts WHERE run_id = ? AND name = ? AND legacy = 0 AND status = 'ready' AND expires_at > ?", runId, name, now()).one().n;
    if (taken) throw new HttpError(409, "an artifact with this name already exists on the workflow run");
  }

  /** Records an older runner's upload, already stored at its legacy key; kept for the longest retention. */
  legacyArtifactSaved(runId: string, jobId: string, name: string, size: number): ArtifactEntry {
    this.legacyArtifactCheck(runId, name);
    // The new tarball was written over the earlier one's, so only the earlier row goes.
    this.sql.exec("DELETE FROM rt_artifacts WHERE run_id = ? AND name = ? AND legacy = 1", runId, name);
    const t = now();
    const expires = new Date(Date.now() + MAX_RETENTION_DAYS * 86400_000).toISOString();
    this.sql.exec("INSERT INTO rt_artifacts (run_id, job_id, name, size, mime_type, status, created_at, updated_at, expires_at, legacy) VALUES (?, ?, ?, ?, 'application/gzip', 'ready', ?, ?, ?, 1)", runId, jobId, name, size, t, t, expires);
    return this.artifactGet(this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id)!;
  }

  /** A finished artifact; with `includeExpired` (the REST API), also one past its retention. */
  artifactGet(id: number, o: { includeExpired?: boolean } = {}): ArtifactEntry | null {
    const r = o.includeExpired
      ? this.sql.exec<ArtifactRow>("SELECT * FROM rt_artifacts WHERE id = ? AND status IN ('ready', 'expired')", id).toArray()[0]
      : this.sql.exec<ArtifactRow>("SELECT * FROM rt_artifacts WHERE id = ? AND status = 'ready' AND expires_at > ?", id, now()).toArray()[0];
    return r ? this.toArtifact(r) : null;
  }

  /**
   * Finished, unexpired artifacts of a run (latest first), optionally by name or id;
   * with `includeExpired` (the REST API), expired ones too; with `legacy: false`,
   * not those uploaded by older runners.
   * A numeric run id (github.run_id, the run number) covers all of the run's attempts; the REST
   * API's 16-digit run id (http/gh.ts uuidNumber) is one attempt.
   */
  runArtifacts(runId: string, filter: { name?: string; id?: number; includeExpired?: boolean; legacy?: false } = {}): ArtifactEntry[] {
    const pattern = uuidPattern(runId);
    if (pattern) runId = this.sql.exec<{ id: string }>("SELECT id FROM runs WHERE id GLOB ? ORDER BY created_at DESC LIMIT 1", pattern).toArray()[0]?.id ?? "-";
    const numeric = /^\d+$/.test(runId);
    // An attempt also has the artifacts of the jobs a partial re-run kept from an earlier attempt, as on GitHub.
    const where = [
      numeric ? "run_id IN (SELECT id FROM runs WHERE run_number = ?)" : "(run_id = ? OR job_id IN (SELECT carried_from FROM jobs WHERE run_id = ? AND carried_from IS NOT NULL))",
      ...(filter.includeExpired ? ["status IN ('ready', 'expired')"] : ["status = 'ready'", "expires_at > ?"]),
    ];
    const args: unknown[] = [...(numeric ? [Number(runId)] : [runId, runId]), ...(filter.includeExpired ? [] : [now()])];
    if (filter.name !== undefined) {
      where.push("name = ?");
      args.push(filter.name);
    }
    if (filter.id !== undefined) {
      where.push("id = ?");
      args.push(filter.id);
    }
    if (filter.legacy === false) where.push("legacy = 0");
    return this.sql.exec<ArtifactRow>(`SELECT * FROM rt_artifacts WHERE ${where.join(" AND ")} ORDER BY id DESC`, ...args).toArray().map(this.toArtifact);
  }

  /** The artifacts the artifact service uploaded to a running job's own run (the toolkit's ListArtifacts and GetSignedArtifactURL). */
  jobArtifacts(jobId: string, filter: { name?: string; id?: number } = {}): ArtifactEntry[] {
    return this.runArtifacts(this.job(jobId).runId, { ...filter, legacy: false });
  }

  /** REST: GET /actions/artifacts, expired artifacts included (as GitHub lists them). */
  repoArtifacts(o: { name?: string; page?: number; perPage?: number }): { total: number; artifacts: ArtifactEntry[] } {
    const where = ["status IN ('ready', 'expired')"];
    const args: unknown[] = [];
    if (o.name) {
      where.push("name = ?");
      args.push(o.name);
    }
    const w = `WHERE ${where.join(" AND ")}`;
    const total = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM rt_artifacts ${w}`, ...args).one().n;
    const per = Math.min(Math.max(o.perPage ?? 30, 1), 100);
    const rows = this.sql.exec<ArtifactRow>(`SELECT * FROM rt_artifacts ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, per, (Math.max(o.page ?? 1, 1) - 1) * per).toArray();
    return { total, artifacts: rows.map(this.toArtifact) };
  }

  /** Deletes an artifact (REST, or the toolkit's DeleteArtifact for `overwrite: true`). */
  async artifactDelete(id: number): Promise<ArtifactEntry | null> {
    const a = this.artifactGet(id, { includeExpired: true });
    this.sql.exec("DELETE FROM rt_artifacts WHERE id = ?", id);
    if (a?.legacy) await this.dropLegacyArtifacts([a]);
    else await this.dropObjects("artifact", [id], false);
    return a;
  }

  /** The job's own run's artifact `name`, for the toolkit's DeleteArtifact. */
  async artifactDeleteByName(jobId: string, name: string): Promise<ArtifactEntry | null> {
    const { runId } = this.job(jobId);
    const a = this.runArtifacts(runId, { name })[0];
    return a ? this.artifactDelete(a.id) : null;
  }

  /**
   * Artifacts past their retention: the content is deleted and the artifact stays
   * listed as expired (GitHub's `expired: true`; downloads get 410) for a while;
   * unfinished uploads past it go entirely. Runs when uploads start and jobs end.
   */
  async expireArtifacts(): Promise<void> {
    const t = now();
    const due = this.sql
      .exec<{ id: number; status: string; legacy: number; run_id: string; name: string }>("SELECT id, status, legacy, run_id, name FROM rt_artifacts WHERE expires_at <= ? AND status != 'expired' LIMIT 500", t)
      .toArray();
    const ready = due.filter((a) => a.status === "ready" && !a.legacy).map((a) => a.id);
    const legacy = due.filter((a) => a.status === "ready" && a.legacy).map((a) => ({ id: a.id, runId: a.run_id, name: a.name }));
    const unfinished = due.filter((a) => a.status !== "ready").map((a) => a.id);
    for (const id of [...ready, ...legacy.map((a) => a.id)]) this.sql.exec("UPDATE rt_artifacts SET status = 'expired', staged = 0 WHERE id = ?", id);
    for (const id of unfinished) this.sql.exec("DELETE FROM rt_artifacts WHERE id = ?", id);
    if (ready.length) await this.dropObjects("artifact", ready, false);
    if (legacy.length) await this.dropLegacyArtifacts(legacy);
    if (unfinished.length) await this.dropObjects("artifact", unfinished);
    const forgotten = new Date(Date.now() - EXPIRED_LISTED_DAYS * 86400_000).toISOString();
    this.sql.exec("DELETE FROM rt_artifacts WHERE status = 'expired' AND expires_at <= ?", forgotten);
  }
}
