import { DurableObject } from "cloudflare:workers";
import { normalizeCheckSources, requiredCheck } from "./required.js";
import { REVIEW_APP, REVIEW_CHECK } from "../agentic/review.js";
import { unsafeTreePath } from "../lib/tree-names.js";
import {
  CODE_TYPES,
  EMPTY_TREE_OID,
  ZERO_OID,
  applyChanges,
  DiffBudget,
  diffTrees,
  fileDiff,
  formatUnified,
  fromUtf8,
  isAncestor,
  isBinary,
  isOid,
  isTreeMode,
  mergeBase,
  parseCommit,
  packStream,
  parsePack,
  parseTree,
  planFetch,
  peelToCommit,
  readCommit,
  readTree,
  resolvePath,
  TooMuchMemory,
  MAX_HELD_BYTES,
  serializeCommit,
  walkCommits,
  type Commit,
  type FileChange,
  type Signature,
  utf8,
} from "@diffinery/git-core";
import type { DiffineryEvent } from "@diffinery/shared";
import type { Env } from "../env.js";
import {
  advertiseReceivePack,
  advertiseUploadPackV2,
  errorPacket,
  handleUploadPackV2,
  parseReceivePack,
  reportStatus,
  type ReceiveRequest,
  resetByDeploy,
  unpackFailure,
  type RefEntry,
  type RefResult,
} from "../git/protocol.js";
import { memorySource, packedContents, readStagedHead, repositoryBases, stagedContents, streamedContents, type PushContents } from "../git/push-contents.js";
import { scanForSecrets, secretBypassReason, type SecretHit } from "../git/secret-scan.js";
import { Directory } from "../lib/directory.js";
import { GHOST, HttpError, isValidRefName, noreplyEmail, now } from "../lib/util.js";
import { R2Sink } from "../lib/r2-sink.js";
import { archivePrefix, deletePrefixes, pushBodyKey, repoPrefixes, type SpilledBody } from "../lib/storage-keys.js";
import { MemoryPool, type Lease } from "../lib/memory-pool.js";
import { storageRefusal } from "../lib/quotas.js";
import { Actions } from "./actions.js";
import { AutoMerge, isPerson } from "./auto-merge.js";
import { Collab } from "./collab.js";
import { Deployments } from "./deployments.js";
import { triggerWorkflows } from "./extra-triggers.js";
import { GitData } from "./gitdata.js";
import { IMPORT_REF_PREFIX, RepoImports } from "./imports.js";
import { RepoObjectStore } from "./objects.js";
import { MergeQueue, QUEUE_BRANCH_PREFIX, normalizeMergeQueue } from "./queue.js";
import { Releases } from "./releases.js";
import { REPO_SCHEMA, migrateRepoSchema } from "./schema.js";
import { Runtime } from "./runtime.js";
import { TokenPolicy } from "./token-policy.js";
import { searchIssues } from "./search.js";
import { MERGE_CHECKS_PER_SUMMARY, needsMergeCheck, repoToday } from "../agentic/today-repo.js";
import { Social } from "./social.js";
import { Statuses } from "./statuses.js";
import { MAX_LOG_DEPTH, atLeast, globToRegExp, type AutoMergeAgent, type Caller, type ProtectionRules, type ProtectionRulesInput, type RepoMeta } from "./types.js";

const MAX_PUSH_BYTES = 100 * 1024 * 1024;
/** Agents one branch rule may auto-merge pull requests from (ProtectionRules.autoMergeAgents). */
const MAX_AUTO_MERGE_AGENTS = 20;
/** Pushed blobs this large are hashed, scanned and stored from their compressed bytes, never held inflated. */
const LARGE_OBJECT_BYTES = 4 * 1024 * 1024;
/**
 * What pushes may hold at once in this object while they unpack: one push may hold MAX_HELD_BYTES, besides
 * a body of up to 16 MiB passed in memory (http/git.ts IN_MEMORY_PUSH), and the object has 128 MB. Without
 * it, two large pushes unpacking at once could go past that, and the reset drops every request in flight
 * here, other pushes and fetches included. Each push reserves what it may hold and waits its turn.
 */
const PUSH_MEMORY_BYTES = MAX_HELD_BYTES + 16 * 1024 * 1024;
/** A push with a body this small unpacks within SMALL_PUSH_HELD, beside others; one that needs more waits for a full share. */
const SMALL_PUSH_BYTES = 1024 * 1024;
const SMALL_PUSH_HELD = 8 * 1024 * 1024;
/** A purge walks every reachable commit and tree while holding the repository: bounded so it finishes in time. */
export const MAX_PURGE_OBJECTS = 300_000;
/** Storage key that marks a deleted repository whose R2 objects are still being deleted. */
const PURGE_KEY = "purge";
/** How often jobs waiting on the account's hosted-job quota are retried. */
const HELD_RETRY_MS = 60_000;

export type TreeItem = {
  name: string;
  path: string;
  type: "tree" | "blob" | "commit";
  mode: string;
  oid: string;
  size?: number;
};

export type CommitInfo = {
  sha: string;
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
  signed: boolean;
};

/**
 * One Durable Object per repository. It is the single writer for the repo's
 * refs, Git objects, issues, pull requests, reviews, checks and workflow runs,
 * which gives strongly consistent ref updates and merges without locks.
 */
/** How long a live-update socket lives before the page must reconnect and pass the access check again. */
const LIVE_REAUTH_MS = 10 * 60 * 1000;
/** The close code that asks a page to reconnect at once (not a failure: no backoff, no reload). */
export const LIVE_REAUTH_CODE = 4001;

/** A row of what someone wrote (RepoDO.authoredBy): column name to value. */
type AuthoredRow = Record<string, string | number | null>;

export class RepoDO extends DurableObject<Env> {
  readonly sql: SqlStorage;
  store!: RepoObjectStore;
  readonly collab: Collab;
  readonly actions: Actions;
  readonly queue: MergeQueue;
  readonly autoMerge: AutoMerge;
  readonly runtime: Runtime;
  readonly policy: TokenPolicy;
  private metaCache: RepoMeta | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(REPO_SCHEMA);
    migrateRepoSchema(this.sql);
    const meta = this.readMeta();
    if (meta) this.store = new RepoObjectStore(this.sql, env.BUCKET, meta.repoId, () => this.storageChanged());
    this.collab = new Collab(this, env);
    this.actions = new Actions(this, env);
    this.queue = new MergeQueue(this);
    this.autoMerge = new AutoMerge(this, env);
    this.runtime = new Runtime(this, env);
    this.policy = new TokenPolicy(this);
  }

  // ---------------------------------------------------------------- meta

  private readMeta(): RepoMeta | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'meta'").toArray()[0];
    this.metaCache = row ? (JSON.parse(row.value) as RepoMeta) : null;
    return this.metaCache;
  }

  /** The noreply address of an account's commits made here (lib/util.ts noreplyEmail). */
  noreply(login: string): string {
    return noreplyEmail(this.env.PUBLIC_URL, login);
  }

  get meta(): RepoMeta {
    const m = this.metaCache ?? this.readMeta();
    if (!m) throw new HttpError(404, "repository not initialised");
    return m;
  }

  async init(meta: RepoMeta): Promise<void> {
    // A repository created now (not one whose meta is updated) starts with read-only workflow tokens.
    if (!this.readMeta()) this.policy.initNewRepo();
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('meta', ?)", JSON.stringify(meta));
    this.metaCache = meta;
    this.store = new RepoObjectStore(this.sql, this.env.BUCKET, meta.repoId, () => this.storageChanged());
  }

  async updateMeta(patch: Partial<RepoMeta>): Promise<RepoMeta> {
    const next = { ...this.meta, ...patch };
    await this.init(next);
    return next;
  }

  /**
   * Whether the repository is archived (read-only). The Worker refuses writes to an archived
   * repository, but work this object does by itself (auto-merge, the merge queue) must ask here.
   */
  async isArchived(): Promise<boolean> {
    const known = this.meta.archived;
    if (typeof known === "boolean") return known;
    const row = await this.env.DB.prepare("SELECT archived FROM repos WHERE id = ?").bind(this.meta.repoId).first<{ archived: number }>();
    // setArchived may have run while D1 answered; what it set wins.
    if (typeof this.meta.archived === "boolean") return this.meta.archived;
    const archived = !!row?.archived;
    await this.updateMeta({ archived });
    return archived;
  }

  /** The repository was archived or unarchived (D1 already says so). Archiving ends auto-merge and empties the merge queues. */
  async setArchived(archived: boolean): Promise<void> {
    await this.updateMeta({ archived });
    if (!archived) return;
    await this.autoMerge.repositoryArchived();
    await this.queue.repositoryArchived();
  }

  /**
   * Wipe all storage (repository deletion), then its R2 objects: git objects, LFS, release
   * assets, caches, artifacts, logs and archives. One call can't delete more than about
   * 450,000 objects, so the alarm keeps going until they are all gone.
   */
  async destroy(): Promise<void> {
    const repoId = this.readMeta()?.repoId;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.metaCache = null;
    if (!repoId) return;
    await this.ctx.storage.put(PURGE_KEY, repoId);
    await this.purge(repoId);
  }

  /** Delete a deleted repository's R2 objects; returns false while some remain (the alarm retries). */
  private async purge(repoId: string): Promise<void> {
    const done = await deletePrefixes(this.env.BUCKET, repoPrefixes(repoId)).catch((e) => {
      console.error("could not delete the repository's objects", repoId, e);
      return false;
    });
    if (done) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }

  async stats(): Promise<{ objects: number; bytes: number; refs: number; openIssues: number; openPulls: number }> {
    const q = (s: string) => this.sql.exec<{ n: number }>(s).one().n;
    return {
      objects: this.store.count(),
      bytes: this.store.sizeBytes(),
      refs: q("SELECT count(*) AS n FROM refs"),
      openIssues: q("SELECT count(*) AS n FROM issues WHERE kind = 'issue' AND state = 'open'"),
      openPulls: q("SELECT count(*) AS n FROM issues WHERE kind = 'pull' AND state = 'open'"),
    };
  }

  // ---------------------------------------------------------------- deleted and exported accounts (accounts/)

  /**
   * After an account is deleted its work here stays, attributed to the `ghost` user as on GitHub: issues and
   * pull requests, comments, reviews, releases, statuses, deployments, events, workflow runs and reactions.
   * Self-hosted runners it registered here (by login) are removed. Returns how many rows changed.
   */
  async forgetAccounts(ids: string[], logins: string[]): Promise<number> {
    if (!ids.length) return 0;
    const inIds = ids.map(() => "?").join(", ");
    let changed = 0;
    const run = (q: string, ...b: unknown[]) => void (changed += this.sql.exec(q, ...b).rowsWritten);
    const people: Array<[table: string, prefix: string]> = [
      ["issues", "author"],
      ["comments", "author"],
      ["reviews", "author"],
      ["releases", "author"],
      ["statuses", "creator"],
      ["deployments", "creator"],
      ["deployment_statuses", "creator"],
      ["issue_events", "actor"],
      ["checks", "creator"],
      ["release_assets", "uploader"],
      ["reactions", "user"],
    ];
    for (const [table, p] of people) {
      // Reactions are one per person: where the ghost already reacted the same way, the deleted account's goes.
      run(`UPDATE OR IGNORE ${table} SET ${p}_id = ?, ${p}_login = ?, ${p}_kind = ? WHERE ${p}_id IN (${inIds})`, GHOST.id, GHOST.login, GHOST.kind, ...ids);
    }
    run(`DELETE FROM reactions WHERE user_id IN (${inIds})`, ...ids);
    run(`UPDATE deployment_reviews SET user_id = ?, user_login = ? WHERE user_id IN (${inIds})`, GHOST.id, GHOST.login, ...ids);
    run(`UPDATE runs SET actor = json_object('id', ?, 'login', ?, 'kind', ?) WHERE json_extract(actor, '$.id') IN (${inIds})`, GHOST.id, GHOST.login, GHOST.kind, ...ids);
    if (logins.length) {
      const lower = logins.map((l) => l.toLowerCase());
      const inLogins = lower.map(() => "?").join(", ");
      run(`UPDATE pulls SET merged_by = ? WHERE lower(merged_by) IN (${inLogins})`, GHOST.login, ...lower);
      run(`DELETE FROM runners WHERE lower(created_by) IN (${inLogins})`, ...lower);
      run(`DELETE FROM runner_registrations WHERE lower(created_by) IN (${inLogins})`, ...lower);
    }
    return changed;
  }

  /** What these accounts wrote here, for an account export: issues and pull requests they opened, their comments and reviews (at most `limit` of each). */
  async authoredBy(ids: string[], limit = 5000): Promise<{ issues: AuthoredRow[]; comments: AuthoredRow[]; reviews: AuthoredRow[] }> {
    if (!ids.length || !this.readMeta()) return { issues: [], comments: [], reviews: [] };
    const inIds = ids.map(() => "?").join(", ");
    const rows = (q: string) => this.sql.exec<AuthoredRow>(q, ...ids, limit).toArray();
    return {
      issues: rows(`SELECT number, kind, title, body, state, state_reason, created_at, updated_at, closed_at FROM issues WHERE author_id IN (${inIds}) ORDER BY number LIMIT ?`),
      comments: rows(`SELECT id, number, body, path, line, created_at, updated_at FROM comments WHERE author_id IN (${inIds}) ORDER BY created_at LIMIT ?`),
      reviews: rows(`SELECT id, number, state, body, commit_id, submitted_at FROM reviews WHERE author_id IN (${inIds}) ORDER BY submitted_at LIMIT ?`),
    };
  }

  /**
   * Write a Git bundle (version 2) of the repository's branches and tags to R2 at `key`, for an account export.
   * The pack streams out one object at a time, as a clone's does. Null for an empty repository; a bundle past
   * `limit` bytes is refused with a 413 and nothing is kept.
   */
  async writeBundle(key: string, limit: number): Promise<{ size: number; refs: number } | null> {
    if (!this.readMeta()) return null;
    const refs = this.refs().filter((r) => r.name.startsWith("refs/heads/") || r.name.startsWith("refs/tags/"));
    if (!refs.length) return null;
    const plan = await planFetch(this.store, [...new Set(refs.map((r) => r.oid))], []);
    const head = this.getRef(this.headRef);
    const sink = new R2Sink(this.env.BUCKET, key, "application/x-git-bundle", limit, "the repository is too large to bundle");
    const store = this.store;
    async function* entries() {
      for await (const raw of store.readRawAll(plan.oids)) yield { type: raw.type, size: raw.size, deflated: raw.deflated };
    }
    try {
      await sink.write(utf8(`# v2 git bundle\n${head ? `${head} HEAD\n` : ""}${refs.map((r) => `${r.oid} ${r.name}\n`).join("")}\n`));
      for await (const part of packStream(plan.oids.length, entries())) await sink.write(part);
      return { size: await sink.close(), refs: refs.length };
    } catch (e) {
      await sink.abort();
      throw e;
    }
  }

  /** Keep the object alive for work that finishes after the current request. */
  background(p: Promise<unknown>): void {
    this.ctx.waitUntil(p.catch((e) => console.error("background task failed", e)));
  }

  /**
   * Set (or with null, clear) the object's single alarm. The merge queue uses it for check timeouts;
   * while jobs wait on the account's hosted-job quota it also fires every minute to retry them, and it
   * fires at the earliest running job's deadline (Actions.enforceJobDeadlines).
   */
  armAlarm(at: number | null): void {
    const next = this.earliest(at, this.actions.hasAccountHeldJobs() ? Date.now() + HELD_RETRY_MS : null, this.actions.nextJobDeadline(), this.actions.nextStuckRunCheck(), this.actions.nextImageRetry());
    this.ctx.waitUntil(next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(next));
  }

  /** Make sure the alarm fires by `at`, keeping an earlier one. */
  alarmBy(at: number): void {
    this.ctx.waitUntil(
      (async () => {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > at) await this.ctx.storage.setAlarm(at);
      })(),
    );
  }

  private earliest(...times: Array<number | null>): number | null {
    const set = times.filter((t): t is number => t !== null);
    return set.length ? Math.min(...set) : null;
  }

  override async alarm(): Promise<void> {
    const purging = await this.ctx.storage.get<string>(PURGE_KEY);
    if (purging) return this.purge(purging);
    await this.queue.process();
    if (this.actions.hasAccountHeldJobs()) await this.actions.releaseAccountHeld();
    await this.actions.relaunchImageHeld();
    await this.actions.enforceJobDeadlines();
    await this.actions.repairStuckRuns();
    // Wake up again for held jobs, rollout waits, running jobs' deadlines and stuck runs, keeping the queue's own alarm if it set an earlier one.
    const want = this.earliest(this.actions.hasAccountHeldJobs() ? Date.now() + HELD_RETRY_MS : null, this.actions.nextJobDeadline(), this.actions.nextStuckRunCheck(), this.actions.nextImageRetry());
    if (want !== null) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current <= Date.now() || current > want) await this.ctx.storage.setAlarm(want);
    }
  }

  /** Queue an event (webhooks, notifications) and show it live to open pages; `live: false` skips the pages (e.g. draft releases, which readers can't see). */
  emit(event: DiffineryEvent, opts?: { live?: boolean }): void {
    this.ctx.waitUntil(this.env.EVENTS.send(event).catch((e) => console.error("event send failed", e)));
    // Open pages only learn that something changed and fetch it with the viewer's own access: the event
    // itself (an audit entry's detail, a dispatch's payload) is not every reader's to see.
    if (opts?.live !== false && event.type !== "audit") this.broadcast("repo", { kind: "event", type: event.type });
  }

  // ---------------------------------------------------------------- purging unreachable objects

  /** Bumped by every purge; a push that started before one refuses its ref updates. */
  private purgeEpoch = 0;

  /**
   * Delete every object no ref reaches, so a secret force-pushed away can't be fetched by its SHA any
   * more (git keeps them until a gc, and so did Diffinery, forever). Also kept: the commits of open
   * pull requests, of the merge queue and of unfinished workflow runs. Runs with every other request
   * held, so nothing writes a ref meanwhile.
   */
  async purgeUnreachable(caller: Caller): Promise<{ objects: number; bytes: number }> {
    if (caller.kind !== "user" || caller.permissions || !atLeast(caller.role, "admin")) throw new HttpError(403, "only repository admins can purge unreachable objects");
    this.checkPurgeSize();
    return this.ctx.blockConcurrencyWhile(() => this.purgeHeld());
  }

  /**
   * Start over with fresh history: delete every closed and merged pull request (its conversation,
   * reviews, review comments, events, reactions and refs/pull/<n>/* refs), then purge what nothing
   * reaches any more. Without it, refs/pull keeps every old commit fetchable after the branches were
   * rewritten. Issues, open pull requests (and those in the merge queue), branches, tags and workflow
   * runs stay, and numbers are never reused. Runs with every other request held, like a purge.
   */
  async deleteClosedPullRequests(caller: Caller): Promise<{ pullRequests: number; objects: number; bytes: number }> {
    if (caller.kind !== "user" || caller.permissions || !atLeast(caller.role, "admin")) throw new HttpError(403, "only repository admins can delete closed pull requests");
    this.checkPurgeSize();
    return this.ctx.blockConcurrencyWhile(async () => {
      const numbers = this.sql
        .exec<{ number: number }>("SELECT number FROM issues WHERE kind = 'pull' AND state = 'closed' AND number NOT IN (SELECT number FROM merge_queue) ORDER BY number")
        .toArray()
        .map((r) => r.number);
      for (const n of numbers) this.forgetPull(n);
      const purged = await this.purgeHeld();
      return { pullRequests: numbers.length, ...purged };
    });
  }

  /** Every row and ref a pull request left behind. */
  private forgetPull(n: number): void {
    const comments = this.sql.exec<{ id: string; review_id: string | null }>("SELECT id, review_id FROM comments WHERE number = ?", n).toArray();
    for (const c of comments) this.sql.exec("DELETE FROM reactions WHERE subject = ?", `${c.review_id ? "review_comment" : "comment"}:${c.id}`);
    this.sql.exec("DELETE FROM reactions WHERE subject = ?", `issue:${n}`);
    for (const table of ["comments", "reviews", "issue_events", "issue_milestones", "pull_merge_state", "pulls", "issues"]) this.sql.exec(`DELETE FROM ${table} WHERE number = ?`, n);
    this.sql.exec("DELETE FROM refs WHERE name >= ? AND name < ?", `refs/pull/${n}/`, `refs/pull/${n}/￿`);
  }

  private checkPurgeSize(): void {
    const total = this.store.count();
    if (total > MAX_PURGE_OBJECTS) throw new HttpError(422, `this repository has ${total} objects; purging works for up to ${MAX_PURGE_OBJECTS}. Ask a site administrator`);
  }

  /** The purge itself; the caller holds every other request (blockConcurrencyWhile). */
  private async purgeHeld(): Promise<{ objects: number; bytes: number }> {
    const roots = [
      ...this.sql.exec<{ oid: string }>("SELECT oid FROM refs").toArray().map((r) => r.oid),
      ...this.sql.exec<{ oid: string }>("SELECT head_sha AS oid FROM pulls UNION SELECT head_sha FROM merge_queue UNION SELECT group_sha FROM merge_queue WHERE group_sha IS NOT NULL UNION SELECT parent_sha FROM merge_queue WHERE parent_sha IS NOT NULL").toArray().map((r) => r.oid),
      ...this.sql.exec<{ oid: string }>("SELECT sha AS oid FROM runs WHERE status != 'completed' UNION SELECT head_sha FROM runs WHERE status != 'completed' AND head_sha IS NOT NULL").toArray().map((r) => r.oid),
    ];
    const keep = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const oid = stack.pop()!;
      if (keep.has(oid)) continue;
      const row = this.sql.exec<{ type: number }>("SELECT type FROM objects WHERE oid = ?", oid).toArray()[0];
      if (!row) continue;
      keep.add(oid);
      const type = CODE_TYPES[row.type];
      if (type === "blob") continue;
      const obj = await this.store.read(oid);
      if (!obj) continue;
      if (type === "commit") {
        const c = parseCommit(obj.content);
        stack.push(c.tree, ...c.parents);
      } else if (type === "tree") {
        // A gitlink (160000) names a commit in another repository.
        for (const e of parseTree(obj.content)) if (e.mode !== "160000") stack.push(e.oid);
      } else if (type === "tag") {
        const target = /^object ([0-9a-f]{40})/.exec(fromUtf8(obj.content))?.[1];
        if (target) stack.push(target);
      }
    }
    const doomed = this.sql.exec<{ oid: string; r2: number; size: number }>("SELECT oid, r2, size FROM objects").toArray().filter((r) => !keep.has(r.oid));
    for (let i = 0; i < doomed.length; i += 100) {
      const chunk = doomed.slice(i, i + 100).map((r) => r.oid);
      this.sql.exec(`DELETE FROM objects WHERE oid IN (${chunk.map(() => "?").join(",")})`, ...chunk);
    }
    this.store.forget();
    this.store.recount();
    this.storageChanged();
    this.purgeEpoch++;
    const r2 = doomed.filter((r) => r.r2).map((r) => this.store.r2KeyOf(r.oid));
    for (let i = 0; i < r2.length; i += 1000) await this.env.BUCKET.delete(r2.slice(i, i + 1000));
    // Cached zipballs and tarballs are rebuilt from what's left on the next download.
    await deletePrefixes(this.env.BUCKET, [archivePrefix(this.meta.repoId)], 50);
    return { objects: doomed.length, bytes: doomed.reduce((n, r) => n + r.size, 0) };
  }

  // ---------------------------------------------------------------- storage (the owner's storage quota, lib/quotas.ts)

  /** The report to D1 waiting to run, and the last one started: reports run one at a time. */
  private storageNext: Promise<void> | null = null;
  private storageLast: Promise<void> = Promise.resolve();

  /** Bytes the repository stores for its owner: git objects, Git LFS objects and release assets. */
  async storageBytes(): Promise<number> {
    await this.listLfs();
    const q = (s: string) => this.sql.exec<{ n: number }>(s).one().n;
    return this.store.sizeBytes() + q("SELECT coalesce(sum(size), 0) AS n FROM lfs_objects") + q("SELECT coalesce(sum(size), 0) AS n FROM release_assets");
  }

  /**
   * Tell D1 what the repository stores now (repo_storage), where the owner's quota adds it up. Calls
   * made while a report waits to run share it; one made while a report is under way gets the next.
   */
  reportStorage(): Promise<void> {
    this.storageNext ??= this.storageLast.then(async () => {
      this.storageNext = null;
      const bytes = await this.storageBytes();
      await this.env.DB.prepare("INSERT INTO repo_storage (repo_id, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(repo_id) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at")
        .bind(this.meta.repoId, bytes, now())
        .run();
    });
    const next = this.storageNext;
    this.storageLast = next.catch(() => {});
    return next;
  }

  /** What the repository stores changed: report it in the background. */
  storageChanged(): void {
    this.background(this.reportStorage());
  }

  /** Why storing `adding` more bytes here must be refused (past the owner's storage quota), or null. */
  async storageRefusal(adding = 0): Promise<string | null> {
    const m = this.meta;
    return storageRefusal(this.env, m.ownerId, m.owner, adding, { repoId: m.repoId, bytes: await this.storageBytes() });
  }

  /** Refuse storing `adding` more bytes past the owner's storage quota. */
  async checkStorage(adding = 0): Promise<void> {
    const refused = await this.storageRefusal(adding);
    if (refused) throw new HttpError(403, refused);
  }

  /** A Git LFS object was stored in R2 (http/git.ts). */
  recordLfs(oid: string, size: number): void {
    if (this.sql.exec("INSERT OR IGNORE INTO lfs_objects (oid, size) VALUES (?, ?) RETURNING oid", oid, size).toArray().length) this.storageChanged();
  }

  /** Git LFS objects stored before lfs_objects existed: listed from R2, once. */
  private async listLfs(): Promise<void> {
    if (this.sql.exec("SELECT 1 FROM counters WHERE name = 'lfs_listed'").toArray().length) return;
    let cursor: string | undefined;
    do {
      const page = await this.env.BUCKET.list({ prefix: `repos/${this.meta.repoId}/lfs/`, cursor, limit: 1000 });
      for (const o of page.objects) this.sql.exec("INSERT OR IGNORE INTO lfs_objects (oid, size) VALUES (?, ?)", o.key.slice(o.key.lastIndexOf("/") + 1), o.size);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.sql.exec("INSERT OR IGNORE INTO counters (name, value) VALUES ('lfs_listed', 1)");
  }

  // ---------------------------------------------------------------- refs

  refs(prefix = "refs/"): RefEntry[] {
    return this.sql.exec<RefEntry>("SELECT name, oid FROM refs WHERE name >= ? AND name < ? ORDER BY name", prefix, `${prefix}￿`).toArray();
  }

  getRef(name: string): string | null {
    return this.sql.exec<{ oid: string }>("SELECT oid FROM refs WHERE name = ?", name).toArray()[0]?.oid ?? null;
  }

  /** Compare-and-swap a ref. `expected` = ZERO_OID means "must not exist". */
  casRef(name: string, expected: string | null, next: string | null): boolean {
    const current = this.getRef(name);
    if (expected !== null && (current ?? ZERO_OID) !== expected) return false;
    if (next === null || next === ZERO_OID) this.sql.exec("DELETE FROM refs WHERE name = ?", name);
    else this.sql.exec("INSERT OR REPLACE INTO refs (name, oid) VALUES (?, ?)", name, next);
    return true;
  }

  get headRef(): string {
    return `refs/heads/${this.meta.defaultBranch}`;
  }

  /** Resolve a branch, tag, full ref, HEAD or (abbreviated) SHA to a commit SHA. */
  async resolve(rev: string | undefined | null): Promise<string | null> {
    const r = rev && rev.length ? rev : "HEAD";
    // Ancestry suffixes, as git takes them: `main~2` (first parents back), `HEAD^2` (the second parent), `v1.0^`.
    // Ref names can't hold `~` or `^`, so whatever is before the first one names the commit.
    const at = r.search(/[~^]/);
    if (at > 0) {
      const ops = r.slice(at);
      if (!/^([~^]\d{0,4})+$/.test(ops)) return null;
      let oid = await this.resolve(r.slice(0, at));
      for (const [, op, n] of ops.matchAll(/([~^])(\d*)/g)) {
        const count = n === "" ? 1 : Number(n);
        for (let i = 0; oid && i < (op === "~" ? count : 1); i++) {
          if (op === "^" && count === 0) break;
          const parents: string[] = (await readCommit(this.store, oid).catch(() => null))?.parents ?? [];
          oid = (op === "~" ? parents[0] : parents[count - 1]) ?? null;
        }
      }
      return oid;
    }
    let oid: string | null = null;
    if (r === "HEAD") oid = this.getRef(this.headRef);
    else if (isOid(r)) oid = this.store.has(r) ? r : null;
    else if (r.startsWith("refs/")) oid = this.getRef(r);
    else oid = this.getRef(`refs/heads/${r}`) ?? this.getRef(`refs/tags/${r}`);
    if (!oid && /^[0-9a-f]{7,39}$/.test(r)) {
      const rows = this.sql.exec<{ oid: string }>("SELECT oid FROM objects WHERE oid >= ? AND oid < ? LIMIT 2", r, `${r}g`).toArray();
      if (rows.length === 1) oid = rows[0]!.oid;
    }
    if (!oid) return null;
    return peelToCommit(this.store, oid);
  }

  async branches(): Promise<Array<{ name: string; sha: string; protected: boolean; isDefault: boolean }>> {
    return this.refs("refs/heads/").map((r) => {
      const name = r.name.slice(11);
      return { name, sha: r.oid, protected: !!this.protectionFor(name), isDefault: name === this.meta.defaultBranch };
    });
  }

  async tags(): Promise<Array<{ name: string; sha: string; target: string }>> {
    const out = [];
    for (const r of this.refs("refs/tags/")) out.push({ name: r.name.slice(10), sha: r.oid, target: await peelToCommit(this.store, r.oid).catch(() => r.oid) });
    return out;
  }

  // ---------------------------------------------------------------- git smart HTTP

  async gitInfoRefs(service: "git-upload-pack" | "git-receive-pack"): Promise<Uint8Array> {
    if (service === "git-upload-pack") return advertiseUploadPackV2();
    // Like GitHub, pull request refs are hidden from pushes (so `git push --mirror` leaves them alone).
    return advertiseReceivePack(this.refs().filter((r) => !r.name.startsWith("refs/pull/")));
  }

  /** The response streams: the pack is read and sent one object at a time, as the client takes it. */
  async gitUploadPack(body: Uint8Array): Promise<ReadableStream<Uint8Array>> {
    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    let started = false;
    const sink = (b: Uint8Array) => ((started = true), writer.write(b));
    const ctx = { store: this.store, refs: this.refs(), headTarget: this.headRef };
    void handleUploadPackV2(body, ctx, sink)
      .catch((e) => (started ? undefined : writer.write(errorPacket((e as Error).message))))
      .then(
        () => writer.close(),
        () => writer.abort(),
      )
      .catch(() => {}); // the client went away
    return readable;
  }

  /**
   * `moved`: the push came in under an old name (a transfer or rename), so say where the repository
   * lives now, like GitHub. `retry`: the Worker hands over a push a deploy cut off (http/git.ts
   * receiveWithRetry), which may already have moved some refs. A body staged in R2 is the Worker's
   * to delete: deleted here, a push cut off after this point would find it gone on its retry.
   */
  async gitReceivePack(input: Uint8Array | SpilledBody, caller: Caller, o: { moved?: boolean; retry?: boolean } = {}): Promise<Uint8Array> {
    const size = input instanceof Uint8Array ? input.length : input.size;
    const held = size <= SMALL_PUSH_BYTES ? SMALL_PUSH_HELD : MAX_HELD_BYTES;
    // A large body that has to wait goes to R2 meanwhile, so pushes waiting their turn don't hold their bodies.
    let staged: string | null = null;
    if (input instanceof Uint8Array && size > SMALL_PUSH_BYTES && !this.pushMemory.fits(size + held)) {
      staged = pushBodyKey(this.meta.repoId);
      await this.env.BUCKET.put(staged, input);
      input = { spilled: staged, size };
    }
    const body = input instanceof Uint8Array ? size : 0;
    const lease = await this.pushMemory.take(body + held);
    try {
      return await this.receivePack(input, caller, o, { held, grow: () => lease.grow(body + MAX_HELD_BYTES) });
    } finally {
      lease.release();
      if (staged) await this.env.BUCKET.delete(staged).catch(() => {});
    }
  }

  /** What pushes in flight here hold while they unpack (see PUSH_MEMORY_BYTES). */
  private readonly pushMemory = new MemoryPool(PUSH_MEMORY_BYTES);

  /** `memory`: what this push may hold while it unpacks, and how to wait for a full share when a small push needs more. */
  private async receivePack(input: Uint8Array | SpilledBody, caller: Caller, o: { moved?: boolean; retry?: boolean }, memory: { held: number; grow: () => Promise<void> }): Promise<Uint8Array> {
    const size = input instanceof Uint8Array ? input.length : input.size;
    if (size > MAX_PUSH_BYTES) {
      const req = { commands: [], capabilities: new Set<string>(), pushOptions: [], pack: null };
      return reportStatus(req, "push exceeds 100 MB; split it into smaller pushes", []);
    }
    // A push the Worker staged in R2 (over 16 MB) is read in ranges, never whole: its objects are
    // unpacked one at a time (git/push-contents.ts), so its size doesn't decide the memory it takes.
    let req: ReceiveRequest;
    let packAt = 0;
    if (input instanceof Uint8Array) req = parseReceivePack(input);
    else {
      try {
        const head = await readStagedHead(this.env.BUCKET, input.spilled, input.size);
        req = head.req;
        packAt = head.packOffset;
      } catch (e) {
        // A deploy that stops this object mid-push is the Worker's to retry (http/git.ts receiveWithRetry).
        if (resetByDeploy(e)) throw e;
        return reportStatus({ commands: [], capabilities: new Set<string>(), pushOptions: [], pack: null }, unpackFailure(e), []);
      }
    }
    // A purge of unreachable objects that ran while this push was in flight may have deleted objects
    // the push counted on the repository having: refuse rather than point a ref at them.
    const epoch = this.purgeEpoch;
    // `git push -o diffinery-import` from a GitHub import's own token: no workflows, webhooks,
    // pull request syncs or notifications (see apps/diffinery/src/imports).
    const importMode = !!caller.importId && req.pushOptions.some((o) => o.trim() === "diffinery-import");
    // H2: while an import holds the repository, only that import may push. Everything else waits
    // until the import finalises, so protection, guardrails, CI and webhooks are never bypassed.
    const lockHolder = this.importLockHolder();
    if (lockHolder && (!importMode || caller.importId !== lockHolder)) {
      const denied = req.commands.map((c) => ({ ref: c.ref, ok: false as const, reason: "repository is locked by an import in progress" }));
      return reportStatus(req, "repository is locked by an import in progress", denied);
    }
    const messages: string[] = o.moved ? ["This repository moved. Please use the new location:", `  ${this.env.PUBLIC_URL}/${this.meta.owner}/${this.meta.name}.git`] : [];
    let unpackError: string | null = null;
    // Like git's quarantine: nothing from the pack is stored until push protection passes,
    // so a blocked push leaves no objects behind for a retry to build on.
    let contents: PushContents = packedContents(this.store, [], 0);
    const unpack = async (maxHeldBytes: number): Promise<PushContents> => {
      const opts = { largeObjectBytes: LARGE_OBJECT_BYTES, maxHeldBytes };
      if (!(input instanceof Uint8Array)) return packAt < input.size ? stagedContents(this.store, this.env.BUCKET, input.spilled, packAt, input.size - packAt, opts) : contents;
      const pack = req.pack;
      if (!pack?.length) return contents;
      return parsePack(pack, repositoryBases(this.store), opts).then(
        (objects) => packedContents(this.store, objects, pack.length),
        // Parsed whole, a pack holds every object at once: one that can't, such as a long history
        // of a large file, is unpacked in pieces instead, holding only the objects in use.
        (e: unknown) => {
          if (!(e instanceof TooMuchMemory)) throw e;
          return streamedContents(this.store, memorySource(pack), opts);
        },
      );
    };
    try {
      try {
        contents = await unpack(memory.held);
      } catch (e) {
        // A small push that needs more than its small share waits for a full one.
        if (!(e instanceof TooMuchMemory) || memory.held >= MAX_HELD_BYTES) throw e;
        await memory.grow();
        contents = await unpack(MAX_HELD_BYTES);
      }
    } catch (e) {
      if (resetByDeploy(e)) throw e;
      unpackError = unpackFailure(e);
    }
    const results: RefResult[] = [];
    if (unpackError) {
      for (const c of req.commands) results.push({ ref: c.ref, ok: false, reason: "unpacker error" });
      return reportStatus(req, unpackError, results);
    }
    // Like GitHub's receive.fsckObjects: no tree a git client would refuse, or that writes outside the work tree.
    const bad = contents.fsck();
    if (bad) {
      for (const c of req.commands) results.push({ ref: c.ref, ok: false, reason: "fsck failed" });
      return reportStatus(req, `fsck error: ${bad}`, results, [`Push refused: ${bad}`]);
    }

    const marked: SecretHit[] = [];
    // Commit and tag messages are scanned too, not only files.
    const leaks = contents.scan(marked);
    // A file can opt out with `diffinery:allow-secret`; that it did is on the record.
    if (marked.length) this.emit({ type: "audit", action: "push.secret_marked", actor: caller, target: `${this.meta.owner}/${this.meta.name}`, detail: { kinds: [...new Set(marked.map((l) => l.kind))], blobs: marked.slice(0, 50).map((l) => l.oid), refs: req.commands.map((c) => c.ref) }, at: now() });
    if (leaks.length) {
      const kinds = leaks.map((l) => l.kind);
      const target = `${this.meta.owner}/${this.meta.name}`;
      // Like GitHub's push protection bypass: a human repository admin may push anyway by
      // giving a reason (`git push -o allow-secrets=<reason>`), and every bypass is audited.
      const reason = secretBypassReason(req.pushOptions);
      if (reason && caller.role === "admin" && caller.kind === "user") {
        messages.push(`Push protection bypassed by ${caller.login}: ${reason}`);
        for (const l of leaks.slice(0, 10)) messages.push(`  ${l.kind} in blob ${l.oid.slice(0, 10)}`);
        this.emit({ type: "audit", action: "push.secret_bypassed", actor: caller, target, detail: { kinds, reason, refs: req.commands.map((c) => c.ref), ...(importMode ? { import: caller.importId, blobs: leaks.slice(0, 50).map((l) => l.oid) } : {}) }, at: now() });
        if (importMode) this.importsModule.recordFindings(leaks);
      } else {
        messages.push("Push blocked: possible secrets detected.");
        for (const l of leaks.slice(0, 10)) messages.push(`  ${l.kind} in blob ${l.oid.slice(0, 10)}`);
        messages.push("Remove the secret from your commits, or rotate it and contact an admin.");
        if (reason) messages.push("Only repository admins (people, not agents) can bypass push protection.");
        for (const c of req.commands) results.push({ ref: c.ref, ok: false, reason: "secret detected (push protection)" });
        this.emit({ type: "audit", action: "push.blocked_secret", actor: caller, target, detail: { kinds, refs: req.commands.map((c) => c.ref) }, at: now() });
        return reportStatus(req, null, results, messages);
      }
    }

    // Past the owner's storage quota nothing new is stored; a push that only deletes or moves refs still works.
    const full = contents.anyNew() ? await this.storageRefusal(contents.bytes) : null;
    if (full) {
      for (const c of req.commands) results.push({ ref: c.ref, ok: false, reason: "storage limit reached" });
      return reportStatus(req, null, results, [...messages, `Push refused: ${full}`]);
    }

    try {
      await contents.write();
    } catch (e) {
      if (resetByDeploy(e)) throw e;
      for (const c of req.commands) results.push({ ref: c.ref, ok: false, reason: "unpacker error" });
      return reportStatus(req, unpackFailure(e), results);
    }

    // Validate every command before applying any, so `atomic` is honoured.
    const checks: Array<RefResult & { cmd: (typeof req.commands)[number] }> = [];
    for (const cmd of req.commands) checks.push({ cmd, ...(await this.checkRefUpdate(cmd.ref, cmd.oldOid, cmd.newOid, caller, importMode)) });
    const atomic = req.capabilities.has("atomic");
    const anyFailed = checks.some((c) => !c.ok);
    let imported = 0;
    for (const c of checks) {
      if (!c.ok) {
        results.push({ ref: c.ref, ok: false, reason: c.reason });
        continue;
      }
      if (atomic && anyFailed) {
        results.push({ ref: c.ref, ok: false, reason: "atomic transaction failed" });
        continue;
      }
      if (epoch !== this.purgeEpoch) {
        results.push({ ref: c.ref, ok: false, reason: "the repository's unreachable objects were purged during this push; push again" });
        continue;
      }
      // On a retry, a ref the cut-off attempt already moved is where the push wants it: that is a
      // success, not stale info. Its push event goes out (again), as the cut-off attempt may have
      // stopped before sending it: a missing one would leave a pull request without its checks.
      const applied = this.casRef(c.cmd.ref, c.cmd.oldOid, c.cmd.newOid) || (!!o.retry && (this.getRef(c.cmd.ref) ?? ZERO_OID) === c.cmd.newOid);
      results.push(applied ? { ref: c.ref, ok: true } : { ref: c.ref, ok: false, reason: "fetch first (stale info)" });
      if (applied && importMode) {
        imported++;
        // Record provenance so a later push may move this ref only if the import still owns it.
        if (c.cmd.newOid === ZERO_OID) this.sql.exec("DELETE FROM import_refs WHERE ref = ?", c.cmd.ref);
        else this.importsModule.recordImportRef(c.cmd.ref, c.cmd.newOid, caller.importId!);
      } else if (applied) await this.afterRefUpdate(c.cmd.ref, c.cmd.oldOid, c.cmd.newOid, caller, messages);
    }
    // One audit entry per import push instead of push events.
    if (imported) this.emit({ type: "audit", action: "import.push", actor: caller, target: `${this.meta.owner}/${this.meta.name}`, detail: { import: caller.importId, refs: imported }, at: now() });
    return reportStatus(req, null, results, messages);
  }

  /** As on GitHub: a rule naming the branch exactly wins; otherwise the oldest matching pattern. */
  protectionFor(branch: string): ProtectionRules | null {
    return this.protectionRuleFor(branch)?.rules ?? null;
  }

  /** The rule that applies to `branch`, with its pattern: an exact name first, else the first matching pattern. */
  protectionRuleFor(branch: string): { pattern: string; rules: ProtectionRules } | null {
    const rows = this.sql.exec<{ pattern: string; rules: string }>("SELECT pattern, rules FROM protections ORDER BY rowid").toArray();
    const row = rows.find((r) => r.pattern === branch) ?? rows.find((r) => globToRegExp(r.pattern).test(branch));
    return row ? { pattern: row.pattern, rules: JSON.parse(row.rules) as ProtectionRules } : null;
  }

  /**
   * Server-side rules for a ref update: permissions, protection, fast-forward, agent guardrails.
   * `importMode`: a GitHub import filling the repository it created, which is the only writer
   * until it finishes, so branch rules (copied from GitHub at its end) don't apply to it.
   */
  async checkRefUpdate(ref: string, oldOid: string, newOid: string, caller: Caller, importMode = false): Promise<RefResult> {
    if (!isValidRefName(ref)) return { ref, ok: false, reason: "invalid ref name" };
    if (!atLeast(caller.role, "write")) return { ref, ok: false, reason: "permission denied" };
    const deleting = newOid === ZERO_OID;
    if (ref.startsWith("refs/pull/")) return { ref, ok: false, reason: "refs/pull/ is managed by Diffinery for pull requests" };
    if (ref.startsWith(`refs/heads/${QUEUE_BRANCH_PREFIX}`)) return { ref, ok: false, reason: "merge queue branches are read-only" };
    if (!deleting && !this.store.has(newOid)) return { ref, ok: false, reason: "missing objects" };
    if (ref.startsWith(IMPORT_REF_PREFIX) && !importMode) return { ref, ok: false, reason: `${IMPORT_REF_PREFIX} is reserved for GitHub imports` };
    if (importMode) {
      if (!/^refs\/(heads|tags|diffinery-import)\//.test(ref)) return { ref, ok: false, reason: "imports write branches and tags only" };
      // H2: create a ref, or move one this import previously wrote — never a ref adopted since.
      const current = this.getRef(ref);
      if (current && !deleting) {
        const owned = this.importsModule.importRefOid(ref, caller.importId!);
        if (owned !== current) return { ref, ok: false, reason: "import may not overwrite a ref it did not write" };
      }
      return { ref, ok: true };
    }
    // A workflow's GITHUB_TOKEN never adds or changes workflow files (GitHub's `workflows` permission).
    const workflowEdit = await this.policy.refuseWorkflowEdit(caller, oldOid, newOid);
    if (workflowEdit) return { ref, ok: false, reason: workflowEdit };
    if (!ref.startsWith("refs/heads/")) {
      if (ref.startsWith("refs/tags/") && oldOid !== ZERO_OID && !atLeast(caller.role, "maintain")) return { ref, ok: false, reason: "only maintainers may move tags" };
      return { ref, ok: true };
    }
    const branch = ref.slice(11);
    const rules = this.protectionFor(branch);
    const isDefault = branch === this.meta.defaultBranch;
    // An empty repository's first commit: an agent that created a repository (or was given an empty one) may
    // start its default branch, as GitHub's auto_init would; from then on it works through pull requests.
    // A protection rule covering the branch still applies, and the commit may not add workflow files: those reach
    // the default branch only through a pull request a person merges, as with auto-merge.
    const seeding = caller.kind === "agent" && isDefault && !rules && oldOid === ZERO_OID && !this.sql.exec("SELECT 1 FROM refs WHERE name LIKE 'refs/heads/%' LIMIT 1").toArray().length;
    if (seeding) {
      const workflow = await this.policy.changedWorkflow(ZERO_OID, newOid);
      if (workflow) return { ref, ok: false, reason: `an agent's first commit to an empty repository can't add workflow file \`${workflow}\`; push it without workflows, then add them in a pull request a person merges` };
    }
    if (caller.kind === "agent" && (isDefault || rules) && !rules?.agentsMayPush && !seeding) {
      return { ref, ok: false, reason: "agents may not push to protected or default branches; open a pull request" };
    }
    if (deleting && isDefault) return { ref, ok: false, reason: "cannot delete the default branch" };
    if (!rules) return { ref, ok: true };
    const bypass = caller.role === "admin" && !rules.enforceAdmins;
    if (bypass) return { ref, ok: true };
    if (deleting) return rules.allowDeletion ? { ref, ok: true } : { ref, ok: false, reason: "protected branch: deletion not allowed" };
    if (rules.requirePullRequest) return { ref, ok: false, reason: "protected branch: changes must be made through a pull request" };
    // As on GitHub, required checks gate direct pushes too: the commit must already have passed them.
    for (const name of rules.requiredChecks ?? []) {
      const c = requiredCheck(name, [...this.collab.checks(newOid), ...this.statuses.asChecks(newOid)], rules.requiredCheckSources?.[name]);
      if (c.state !== "success") {
        const why = c.state === "missing" ? "has not run" : c.state === "pending" ? "has not finished" : `ended with ${c.conclusion}`;
        return { ref, ok: false, reason: `protected branch: required check '${name}' ${why} on ${newOid.slice(0, 7)}; push to another branch and open a pull request` };
      }
    }
    if (oldOid !== ZERO_OID && !rules.allowForcePush && !(await isAncestor(this.store, oldOid, newOid))) {
      return { ref, ok: false, reason: "protected branch: force push not allowed" };
    }
    if (rules.requireLinearHistory) {
      const fresh = await walkCommits(this.store, [newOid], { stop: new Set(oldOid === ZERO_OID ? [] : [oldOid]), limit: 1000 });
      if (fresh.some((c) => c.commit.parents.length > 1)) return { ref, ok: false, reason: "protected branch: merge commits not allowed (linear history)" };
    }
    return { ref, ok: true };
  }

  /** Side effects after a ref moved: events, PR sync, workflow triggers. */
  async afterRefUpdate(ref: string, oldOid: string, newOid: string, caller: Caller, messages: string[] = []): Promise<void> {
    const at = now();
    const forced = oldOid !== ZERO_OID && newOid !== ZERO_OID && !(await isAncestor(this.store, oldOid, newOid));
    const ev: DiffineryEvent = {
      type: "push",
      repoId: this.meta.repoId,
      owner: this.meta.owner,
      repo: this.meta.name,
      ref,
      before: oldOid,
      after: newOid,
      actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf },
      forced,
      created: oldOid === ZERO_OID,
      deleted: newOid === ZERO_OID,
      at,
    };
    this.emit(ev);
    this.policy.recordPush(ref, newOid, caller);
    await this.policy.trackAgentCommits(ref, oldOid, newOid, caller).catch((e) => console.error("could not record an agent's commits", ref, e));
    this.deploys.noteRefUpdate(ref, newOid, caller);
    if (ref.startsWith("refs/heads/") && newOid !== ZERO_OID) {
      const branch = ref.slice(11);
      const synced = await this.collab.syncPullsForBranch(branch, newOid, caller);
      for (const n of synced) messages.push(`Updated pull request #${n}: ${this.env.PUBLIC_URL}/${this.meta.owner}/${this.meta.name}/pull/${n}`);
      if (oldOid === ZERO_OID && branch !== this.meta.defaultBranch && synced.length === 0) {
        messages.push(`Create a pull request for '${branch}':`);
        messages.push(`  ${this.env.PUBLIC_URL}/${this.meta.owner}/${this.meta.name}/compare/${encodeURIComponent(branch)}`);
      }
    }
    if (newOid !== ZERO_OID) await this.actions.onPush(ev, caller).catch((e) => messages.push(`Workflow trigger error: ${(e as Error).message}`));
    // A base branch that moved (outside the queue, or by it) needs its merge groups checked,
    // and pull requests into it waiting to auto-merge may now be up to date.
    if (ref.startsWith("refs/heads/") && this.queue.hasEntries(ref.slice(11))) this.queue.schedule(ref.slice(11));
    if (ref.startsWith("refs/heads/") && newOid !== ZERO_OID) this.autoMerge.schedule({ base: ref.slice(11) });
  }

  // ---------------------------------------------------------------- browsing

  async commitInfo(sha: string): Promise<CommitInfo> {
    const c = await readCommit(this.store, sha);
    return toInfo(sha, c);
  }

  async tree(rev: string, path = ""): Promise<{ sha: string; items: TreeItem[] } | null> {
    const sha = await this.resolve(rev);
    if (!sha) return null;
    const c = await readCommit(this.store, sha);
    const entry = await resolvePath(this.store, c.tree, path);
    if (!entry || !isTreeMode(entry.mode)) return null;
    const items: TreeItem[] = [];
    for (const e of await readTree(this.store, entry.oid)) {
      const type = isTreeMode(e.mode) ? "tree" : e.mode === "160000" ? "commit" : "blob";
      const raw = type === "blob" ? this.sql.exec<{ size: number }>("SELECT size FROM objects WHERE oid = ?", e.oid).toArray()[0] : undefined;
      items.push({ name: e.name, path: path ? `${path}/${e.name}` : e.name, type, mode: e.mode, oid: e.oid, size: raw?.size });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
    return { sha, items };
  }

  async blob(rev: string, path: string): Promise<{ sha: string; oid: string; mode: string; size: number; binary: boolean; content: Uint8Array } | null> {
    const sha = await this.resolve(rev);
    if (!sha) return null;
    const c = await readCommit(this.store, sha);
    const entry = await resolvePath(this.store, c.tree, path);
    if (!entry || isTreeMode(entry.mode)) return null;
    const o = await this.store.read(entry.oid);
    if (!o) return null;
    return { sha, oid: entry.oid, mode: entry.mode, size: o.content.length, binary: isBinary(o.content), content: o.content };
  }

  async log(rev: string, opts: { path?: string; limit?: number; skip?: number } = {}): Promise<CommitInfo[]> {
    const sha = await this.resolve(rev);
    if (!sha) return [];
    const limit = Math.min(opts.limit ?? 30, 100);
    const skip = Math.max(opts.skip ?? 0, 0);
    if (!opts.path) {
      // Paging past MAX_LOG_DEPTH lists nothing rather than walking the whole history for one page.
      if (skip >= MAX_LOG_DEPTH) return [];
      const commits = await walkCommits(this.store, [sha], { limit: Math.min(limit + skip, MAX_LOG_DEPTH) });
      return commits.slice(skip).map((c) => toInfo(c.oid, c.commit));
    }
    // Path history: commits whose tree entry at `path` differs from their first parent's.
    const out: CommitInfo[] = [];
    let skipped = 0;
    for (const c of await walkCommits(this.store, [sha], { limit: 2000 })) {
      if (!(await this.changes(c.commit, opts.path))) continue;
      if (skipped++ < skip) continue;
      out.push(toInfo(c.oid, c.commit));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** How many commits `log` lists from a commit: up to MAX_LOG_DEPTH, or with `path`, those of the first 2000 that changed it. */
  async logCount(rev: string, path?: string): Promise<number> {
    const sha = await this.resolve(rev);
    if (!sha) return 0;
    if (!path) return (await walkCommits(this.store, [sha], { limit: MAX_LOG_DEPTH })).length;
    let n = 0;
    for (const c of await walkCommits(this.store, [sha], { limit: 2000 })) if (await this.changes(c.commit, path)) n++;
    return n;
  }

  /** Whether a commit's tree entry at `path` differs from its first parent's. */
  private async changes(c: Commit, path: string): Promise<boolean> {
    const mine = await resolvePath(this.store, c.tree, path);
    const parent = c.parents[0] ? await readCommit(this.store, c.parents[0]).catch(() => null) : null;
    const theirs = parent ? await resolvePath(this.store, parent.tree, path) : null;
    return (mine?.oid ?? null) !== (theirs?.oid ?? null);
  }

  /** Diff between two commits (or a commit and its first parent). */
  async diff(baseSha: string | null, headSha: string, opts: { patch?: boolean; maxFiles?: number } = {}) {
    const head = await readCommit(this.store, headSha);
    const baseTree = baseSha ? (await readCommit(this.store, baseSha)).tree : null;
    const changes = await diffTrees(this.store, baseTree, head.tree);
    const max = opts.maxFiles ?? 300;
    const files = [];
    const budget = new DiffBudget();
    for (const ch of changes.slice(0, max)) {
      const d = await fileDiff(this.store, ch, 3, budget);
      files.push({ ...d, patch: opts.patch === false ? undefined : formatUnified(d) });
    }
    return {
      files,
      totalFiles: changes.length,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      truncated: changes.length > max,
    };
  }

  async commitWithDiff(rev: string) {
    const sha = await this.resolve(rev);
    if (!sha) throw new HttpError(404, "commit not found");
    const info = await this.commitInfo(sha);
    return { ...info, ...(await this.diff(info.parents[0] ?? null, sha)) };
  }

  async compare(base: string, head: string) {
    const b = await this.resolve(base);
    const h = await this.resolve(head);
    if (!b || !h) throw new HttpError(404, "unknown base or head");
    const mb = await mergeBase(this.store, b, h);
    const commits = (await walkCommits(this.store, [h], { stop: new Set(mb ? (await walkCommits(this.store, [mb], { limit: 100000 })).map((c) => c.oid) : []), limit: 250 })).map((c) => toInfo(c.oid, c.commit));
    const ahead = commits.length;
    const behind = mb ? (await walkCommits(this.store, [b], { stop: new Set([mb]), limit: 1000 })).filter((c) => c.oid !== mb).length : 0;
    return { baseSha: b, headSha: h, mergeBase: mb, aheadBy: ahead, behindBy: behind, commits: commits.reverse(), ...(await this.diff(mb, h)) };
  }

  /**
   * Push protection for commits made without a Git client: the same scan as `git push`, so the
   * web editor, the contents and commits APIs and MCP cannot be used to slip a credential in.
   */
  private protectCommit(changes: readonly FileChange[], allowSecrets: string | undefined, caller: Caller, message = ""): void {
    const blobs = changes.filter((ch) => !ch.delete && ch.content).map((ch) => ({ oid: ch.path, content: ch.content! }));
    if (message) blobs.push({ oid: "(commit message)", content: utf8(message) });
    const marked: SecretHit[] = [];
    const leaks = scanForSecrets(blobs, marked);
    const target = `${this.meta.owner}/${this.meta.name}`;
    if (marked.length) this.emit({ type: "audit", action: "api.secret_marked", actor: caller, target, detail: { kinds: [...new Set(marked.map((l) => l.kind))], paths: [...new Set(marked.map((l) => l.oid))].slice(0, 10) }, at: now() });
    if (!leaks.length) return;
    const kinds = [...new Set(leaks.map((l) => l.kind))];
    const paths = [...new Set(leaks.map((l) => l.oid))].slice(0, 10);
    const reason = allowSecrets?.trim().slice(0, 200);
    if (reason && caller.role === "admin" && caller.kind === "user") {
      this.emit({ type: "audit", action: "api.secret_bypassed", actor: caller, target, detail: { kinds, paths, reason }, at: now() });
      return;
    }
    this.emit({ type: "audit", action: "api.blocked_secret", actor: caller, target, detail: { kinds, paths }, at: now() });
    const hint = reason ? " Only repository admins (people, not agents) can bypass push protection." : "";
    throw new HttpError(422, `push protection: possible secret detected (${kinds.join(", ")}) in ${paths.join(", ")}. Remove it, or rotate it and ask an admin.${hint}`);
  }

  /**
   * Create a commit from file changes without a Git client (used by the web
   * editor, the REST contents API and AI agents through MCP).
   */
  async commitFiles(input: {
    branch: string;
    message: string;
    changes: FileChange[];
    expectedHeadSha?: string;
    createBranchFrom?: string;
    author?: { name: string; email: string };
    committer?: { name: string; email: string };
    /** A human admin's reason for committing a detected secret anyway (like `git push -o allow-secrets=`). */
    allowSecrets?: string;
  }, caller: Caller): Promise<{ sha: string; branch: string }> {
    const ref = `refs/heads/${input.branch}`;
    let parent = this.getRef(ref);
    if (!parent) {
      if (input.createBranchFrom) parent = await this.resolve(input.createBranchFrom);
      else if (this.refs("refs/heads/").length > 0) throw new HttpError(404, `branch ${input.branch} not found`);
    }
    if (input.expectedHeadSha && parent !== input.expectedHeadSha) throw new HttpError(409, "branch moved; refresh and retry", { currentSha: parent });
    for (const ch of input.changes) {
      const why = ch.delete ? null : unsafeTreePath(ch.path);
      if (why) throw new HttpError(422, `invalid path ${JSON.stringify(ch.path)}: ${why}`);
    }
    const adding = input.changes.reduce((n, ch) => n + (ch.content?.length ?? 0), 0);
    if (adding) await this.checkStorage(adding);
    this.protectCommit(input.changes, input.allowSecrets, caller, input.message);
    const baseTree = parent ? (await readCommit(this.store, parent)).tree : null;
    const tree = await applyChanges(this.store, baseTree, input.changes);
    const ts = Math.floor(Date.now() / 1000);
    const committer = input.committer
      ? { ...input.committer, timestamp: ts, timezone: "+0000" }
      : { name: caller.login, email: this.noreply(caller.login), timestamp: ts, timezone: "+0000" };
    const author = input.author ? { ...input.author, timestamp: ts, timezone: "+0000" } : committer;
    const extra: [string, string][] = caller.kind === "agent" ? [["diffinery-agent", `${caller.login}${caller.onBehalfOf ? ` on-behalf-of ${caller.onBehalfOf}` : ""}`]] : [];
    const sha = await this.store.write(
      "commit",
      serializeCommit({ tree: tree === EMPTY_TREE_OID ? tree : tree, parents: parent ? [parent] : [], author, committer, message: input.message.endsWith("\n") ? input.message : `${input.message}\n`, extraHeaders: extra }),
    );
    const old = parent && this.getRef(ref) ? parent : ZERO_OID;
    const check = await this.checkRefUpdate(ref, old, sha, caller);
    if (!check.ok) throw new HttpError(403, check.reason ?? "rejected");
    if (!this.casRef(ref, old, sha)) throw new HttpError(409, "branch moved; refresh and retry");
    await this.afterRefUpdate(ref, old, sha, caller);
    return { sha, branch: input.branch };
  }

  async createRef(ref: string, sha: string, caller: Caller): Promise<void> {
    if (!this.store.has(sha)) throw new HttpError(422, "object does not exist");
    const check = await this.checkRefUpdate(ref, ZERO_OID, sha, caller);
    if (!check.ok) throw new HttpError(403, check.reason ?? "rejected");
    if (!this.casRef(ref, ZERO_OID, sha)) throw new HttpError(422, "reference already exists");
    await this.afterRefUpdate(ref, ZERO_OID, sha, caller);
  }

  async updateRef(ref: string, sha: string, force: boolean, caller: Caller): Promise<void> {
    const old = this.getRef(ref);
    if (!old) throw new HttpError(404, "reference not found");
    if (!force && !(await isAncestor(this.store, old, sha))) throw new HttpError(422, "update is not a fast-forward");
    const check = await this.checkRefUpdate(ref, old, sha, caller);
    if (!check.ok) throw new HttpError(403, check.reason ?? "rejected");
    if (!this.casRef(ref, old, sha)) throw new HttpError(409, "reference moved");
    await this.afterRefUpdate(ref, old, sha, caller);
  }

  async deleteRef(ref: string, caller: Caller): Promise<void> {
    const old = this.getRef(ref);
    if (!old) throw new HttpError(404, "reference not found");
    const check = await this.checkRefUpdate(ref, old, ZERO_OID, caller);
    if (!check.ok) throw new HttpError(403, check.reason ?? "rejected");
    this.casRef(ref, old, null);
    await this.afterRefUpdate(ref, old, ZERO_OID, caller);
  }

  // ---------------------------------------------------------------- protections

  /**
   * What Settings → Merge on green (web/merge-on-green.tsx) suggests: the checks reported on the heads of the
   * latest pull requests, which are the names a required check must match, and the agents that opened pull
   * requests here. `latest`: the check ran on each of the last three pull requests that had checks, so
   * requiring it won't hold up a pull request whose workflows skip it. Reports by agents never count.
   */
  mergeOnGreenHints(): { pulls: number; checks: Array<{ name: string; pulls: number; latest: boolean }>; agents: Array<{ id: string; login: string }> } {
    const heads = this.sql.exec<{ head_sha: string }>("SELECT head_sha FROM pulls ORDER BY number DESC LIMIT 20").toArray();
    const count = new Map<string, number>();
    const recent: Array<Set<string>> = [];
    let pulls = 0;
    for (const h of heads) {
      const names = new Set([...this.collab.checks(h.head_sha), ...this.statuses.asChecks(h.head_sha)].filter((c) => c.creatorKind !== "agent").map((c) => c.name));
      if (!names.size) continue;
      pulls++;
      if (recent.length < 3) recent.push(names);
      for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
    }
    const checks = [...count]
      .map(([name, n]) => ({ name, pulls: n, latest: recent.every((r) => r.has(name)) }))
      .sort((a, b) => Number(b.latest) - Number(a.latest) || b.pulls - a.pulls || a.name.localeCompare(b.name))
      .slice(0, 50);
    const agents: Array<{ id: string; login: string }> = [];
    for (const a of this.sql.exec<{ author_id: string; author_login: string }>("SELECT author_id, author_login FROM issues WHERE kind = 'pull' AND author_kind = 'agent' ORDER BY number DESC LIMIT 200").toArray()) {
      if (agents.length >= 20) break;
      if (!agents.some((x) => x.id === a.author_id)) agents.push({ id: a.author_id, login: a.author_login });
    }
    return { pulls, checks, agents };
  }

  listProtections(): Array<{ pattern: string; rules: ProtectionRules }> {
    return this.sql.exec<{ pattern: string; rules: string }>("SELECT pattern, rules FROM protections ORDER BY pattern").toArray().map((r) => ({ pattern: r.pattern, rules: JSON.parse(r.rules) }));
  }

  /**
   * Create, replace or (with null) delete a rule. Only people who administer the repository change
   * branch protection: never agents, never a workflow's token. Turning `allowAgentAutoMerge`,
   * `agentAutoMergeWithoutApproval` or `autoMergeAgents` on or off is audited on its own, since they let
   * agents land changes.
   */
  async setProtection(pattern: string, input: ProtectionRulesInput | null, caller: Caller): Promise<void> {
    if (!isPerson(caller) || caller.role !== "admin") throw new HttpError(403, caller.kind === "agent" ? "agents cannot change branch protection" : "only people who administer the repository can change branch protection");
    let rules = input ? await this.resolveAutoMergeAgents(input) : null;
    if (rules?.mergeQueue) {
      const asked = typeof rules.mergeQueue === "object" ? rules.mergeQueue.method : undefined;
      const mergeQueue = normalizeMergeQueue(rules.mergeQueue);
      // A queue that makes merge commits could never merge into a branch that refuses them.
      if (rules.requireLinearHistory && mergeQueue.method === "merge") {
        if (asked !== undefined) throw new HttpError(422, "this branch requires linear history, so its merge queue must squash or rebase (mergeQueue.method), not create merge commits");
        mergeQueue.method = "squash";
      }
      rules = { ...rules, mergeQueue };
    }
    if (rules?.requiredCheckSources) rules = { ...rules, requiredCheckSources: normalizeCheckSources(rules.requiredCheckSources) };
    // A required "Agent review" means Diffinery's own check (agentic/review.ts), not one anyone with write access could post.
    if (rules?.requiredChecks?.includes(REVIEW_CHECK) && !rules.requiredCheckSources?.[REVIEW_CHECK]) rules = { ...rules, requiredCheckSources: { ...rules.requiredCheckSources, [REVIEW_CHECK]: REVIEW_APP } };
    if (rules && rules.allowAgentAutoMerge !== undefined && typeof rules.allowAgentAutoMerge !== "boolean") throw new HttpError(422, "allowAgentAutoMerge must be a boolean");
    if (rules && rules.agentAutoMergeWithoutApproval !== undefined && typeof rules.agentAutoMergeWithoutApproval !== "boolean") throw new HttpError(422, "agentAutoMergeWithoutApproval must be a boolean");
    if (rules?.agentAutoMergeWithoutApproval && !rules.allowAgentAutoMerge) throw new HttpError(422, "agentAutoMergeWithoutApproval needs allowAgentAutoMerge: it only applies to what Diffinery lands for agents");
    if (rules?.autoMergeAgents?.length && !rules.allowAgentAutoMerge) throw new HttpError(422, "autoMergeAgents needs allowAgentAutoMerge: Diffinery turns on auto-merge as those agents, under the same rules as their own");
    if (rules?.autoMergeMethod !== undefined && !(["merge", "squash", "rebase"] as const).includes(rules.autoMergeMethod)) throw new HttpError(422, "autoMergeMethod must be merge, squash or rebase");
    if (rules?.autoMergeMethod === "merge" && rules.requireLinearHistory) throw new HttpError(422, "this branch requires linear history, so autoMergeMethod must be squash or rebase");
    if (rules && !rules.allowAgentAutoMerge) {
      const { allowAgentAutoMerge: _, agentAutoMergeWithoutApproval: _w, autoMergeAgents: _a, autoMergeMethod: _m, ...rest } = rules;
      rules = rest;
    }
    if (rules && !rules.agentAutoMergeWithoutApproval) {
      const { agentAutoMergeWithoutApproval: _, ...rest } = rules;
      rules = rest;
    }
    if (rules && !rules.autoMergeAgents?.length) {
      const { autoMergeAgents: _, autoMergeMethod: _m, ...rest } = rules;
      rules = rest;
    }
    const before = this.sql.exec<{ rules: string }>("SELECT rules FROM protections WHERE pattern = ?", pattern).toArray()[0];
    const old = before ? (JSON.parse(before.rules) as ProtectionRules) : null;
    const was = !!old?.allowAgentAutoMerge;
    const waived = !!old?.agentAutoMergeWithoutApproval;
    const agentsKey = (r: ProtectionRules | null) => (r?.autoMergeAgents?.length ? `${r.autoMergeAgents.map((a) => a.id).join(",")}|${r.autoMergeMethod ?? ""}` : "");
    if (rules) this.sql.exec("INSERT INTO protections (pattern, rules) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET rules = excluded.rules", pattern, JSON.stringify(rules));
    else this.sql.exec("DELETE FROM protections WHERE pattern = ?", pattern);
    if (was !== !!rules?.allowAgentAutoMerge) {
      const m = this.meta;
      this.emit({ type: "audit", action: "repo.protection.agent_auto_merge", actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf }, target: `${m.owner}/${m.name}`, detail: { pattern, enabled: !!rules?.allowAgentAutoMerge, requiredChecks: rules?.requiredChecks ?? [] }, at: now() });
    }
    if (waived !== !!rules?.agentAutoMergeWithoutApproval) {
      const m = this.meta;
      this.emit({ type: "audit", action: "repo.protection.agent_approval_waiver", actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf }, target: `${m.owner}/${m.name}`, detail: { pattern, enabled: !!rules?.agentAutoMergeWithoutApproval, requiredChecks: rules?.requiredChecks ?? [] }, at: now() });
    }
    if (agentsKey(old) !== agentsKey(rules)) {
      const m = this.meta;
      this.emit({
        type: "audit",
        action: "repo.protection.agent_auto_merge_rule",
        actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf },
        target: `${m.owner}/${m.name}`,
        detail: { pattern, enabled: !!rules?.autoMergeAgents?.length, agents: (rules?.autoMergeAgents ?? []).map((a) => a.login), method: rules?.autoMergeMethod ?? null, withoutApproval: !!rules?.agentAutoMergeWithoutApproval, requiredChecks: rules?.requiredChecks ?? [] },
        at: now(),
      });
    }
    // Turning a queue off (or changing its checks) affects what is queued, and what may auto-merge.
    this.queue.schedule();
    this.autoMerge.schedule();
  }

  /** `autoMergeAgents` names agent accounts, by login or as stored ({ id, login }); store them by id, with the login as it is now. */
  private async resolveAutoMergeAgents(input: ProtectionRulesInput): Promise<ProtectionRules> {
    const { autoMergeAgents: names, ...rest } = input;
    if (names === undefined || names === null) return rest;
    if (!Array.isArray(names)) throw new HttpError(422, "autoMergeAgents must be a list of agent logins");
    if (names.length > MAX_AUTO_MERGE_AGENTS) throw new HttpError(422, `autoMergeAgents can name at most ${MAX_AUTO_MERGE_AGENTS} agents`);
    const dir = new Directory(this.env);
    const agents: AutoMergeAgent[] = [];
    for (const n of names) {
      const login = typeof n === "string" ? n.trim().replace(/^@/, "") : n && typeof n === "object" && typeof n.login === "string" ? n.login : null;
      if (!login) throw new HttpError(422, "autoMergeAgents must be a list of agent logins");
      const account = typeof n === "object" && typeof n.id === "string" ? ((await dir.account(n.id)) ?? (await dir.accountByLogin(login))) : await dir.accountByLogin(login);
      if (!account) throw new HttpError(422, `autoMergeAgents: there is no account named ${login}`);
      if (account.kind !== "agent") throw new HttpError(422, `autoMergeAgents: ${account.login} is not an agent; only agents' pull requests can be auto-merged by a rule`);
      if (!agents.some((a) => a.id === account.id)) agents.push({ id: account.id, login: account.login });
    }
    return agents.length ? { ...rest, autoMergeAgents: agents } : rest;
  }

  // ---------------------------------------------------------------- RPC passthroughs (collab + actions)
  // Workers RPC only exposes methods on the class itself, so the sub-modules are wrapped here.

  issues(...a: Parameters<Collab["list"]>) {
    return this.collab.list(...a);
  }
  issue(...a: Parameters<Collab["get"]>) {
    return this.collab.get(...a);
  }
  createIssue(...a: Parameters<Collab["createIssue"]>) {
    return this.collab.createIssue(...a);
  }
  updateIssue(...a: Parameters<Collab["update"]>) {
    return this.collab.update(...a);
  }
  setPullDraft(...a: Parameters<Collab["setDraft"]>) {
    return this.collab.setDraft(...a);
  }
  addComment(...a: Parameters<Collab["addComment"]>) {
    return this.collab.addComment(...a);
  }
  editComment(...a: Parameters<Collab["editComment"]>) {
    return this.collab.editComment(...a);
  }
  minimizeComment(...a: Parameters<Collab["minimizeComment"]>) {
    return this.collab.minimizeComment(...a);
  }
  createPull(...a: Parameters<Collab["createPull"]>) {
    return this.collab.createPull(...a);
  }
  pullFiles(...a: Parameters<Collab["pullFiles"]>) {
    return this.collab.pullFiles(...a);
  }
  pullCommits(...a: Parameters<Collab["pullCommits"]>) {
    return this.collab.pullCommits(...a);
  }
  pullStats(...a: Parameters<Collab["pullStats"]>) {
    return this.collab.pullStats(...a);
  }
  reviewState(...a: Parameters<Collab["reviewState"]>) {
    return this.collab.reviewState(...a);
  }
  submitReview(...a: Parameters<Collab["submitReview"]>) {
    return this.collab.submitReview(...a);
  }
  resolveThread(...a: Parameters<Collab["resolveThread"]>) {
    return this.collab.resolveThread(...a);
  }
  mergeability(...a: Parameters<Collab["mergeability"]>) {
    return this.collab.mergeability(...a);
  }
  mergePull(...a: Parameters<Collab["merge"]>) {
    return this.collab.merge(...a);
  }
  requestReviewers(...a: Parameters<Collab["requestReviewers"]>) {
    return this.collab.requestReviewers(...a);
  }
  labels(...a: Parameters<Collab["labels"]>) {
    return this.collab.labels(...a);
  }
  setLabel(...a: Parameters<Collab["setLabel"]>) {
    return this.collab.setLabel(...a);
  }
  checks(...a: Parameters<Collab["checks"]>) {
    return this.collab.checks(...a);
  }
  upsertCheck(...a: Parameters<Collab["upsertCheck"]>) {
    return this.collab.upsertCheck(...a);
  }
  webhooks(...a: Parameters<Collab["webhooks"]>) {
    return this.collab.webhooks(...a);
  }
  deliverableWebhooks(...a: Parameters<Collab["deliverableWebhooks"]>) {
    return this.collab.deliverableWebhooks(...a);
  }
  createWebhook(url: string, events: string[], secret?: string) {
    return this.collab.createWebhook(url, events, secret, new URL(this.env.PUBLIC_URL).hostname);
  }
  deleteWebhook(...a: Parameters<Collab["deleteWebhook"]>) {
    return this.collab.deleteWebhook(...a);
  }
  recordDelivery(...a: Parameters<Collab["recordDelivery"]>) {
    return this.collab.recordDelivery(...a);
  }

  enqueuePull(...a: Parameters<MergeQueue["enqueue"]>) {
    return this.queue.enqueue(...a);
  }
  dequeuePull(...a: Parameters<MergeQueue["dequeue"]>) {
    return this.queue.dequeue(...a);
  }
  mergeQueue(...a: Parameters<MergeQueue["list"]>) {
    return this.queue.list(...a);
  }
  mergeQueueSettings(...a: Parameters<MergeQueue["settings"]>) {
    return this.queue.settings(...a);
  }
  /** A caller's own auto-merge; only the server turns one on for a branch rule (AutoMerge.applyRule). */
  enableAutoMerge(number: number, input: Parameters<AutoMerge["enable"]>[1], caller: Caller) {
    return this.autoMerge.enable(number, input, caller);
  }
  disableAutoMerge(...a: Parameters<AutoMerge["disable"]>) {
    return this.autoMerge.disable(...a);
  }

  runs(...a: Parameters<Actions["listRuns"]>) {
    return this.actions.listRuns(...a);
  }
  run(...a: Parameters<Actions["getRun"]>) {
    return this.actions.getRun(...a);
  }
  runJobs(...a: Parameters<Actions["jobs"]>) {
    return this.actions.jobs(...a);
  }
  claimJobAsRunner(...a: Parameters<Actions["claimJobAsRunner"]>) {
    return this.actions.claimJobAsRunner(...a);
  }
  runnerRegistrationToken(...a: Parameters<Actions["runnerRegistrationToken"]>) {
    return this.actions.runnerRegistrationToken(...a);
  }
  registerRunner(...a: Parameters<Actions["registerRunner"]>) {
    return this.actions.registerRunner(...a);
  }
  runners(...a: Parameters<Actions["runners"]>) {
    return this.actions.runners(...a);
  }
  deleteRunner(...a: Parameters<Actions["deleteRunner"]>) {
    return this.actions.deleteRunner(...a);
  }
  jobStatus(jobId: string): string {
    return this.actions.getJob(jobId).status;
  }
  job(...a: Parameters<Actions["getJob"]>) {
    return this.actions.getJob(...a);
  }
  jobLogs(...a: Parameters<Actions["logs"]>) {
    return this.actions.logs(...a);
  }
  cancelRun(...a: Parameters<Actions["cancel"]>) {
    return this.actions.cancel(...a);
  }
  deleteRunLogs(...a: Parameters<Actions["deleteLogs"]>) {
    return this.actions.deleteLogs(...a);
  }
  rerun(...a: Parameters<Actions["rerun"]>) {
    return this.actions.rerun(...a);
  }
  rerunJob(...a: Parameters<Actions["rerunJob"]>) {
    return this.actions.rerunJob(...a);
  }
  dispatchWorkflow(...a: Parameters<Actions["dispatch"]>) {
    return this.actions.dispatch(...a);
  }
  scheduleTick(...a: Parameters<Actions["schedule"]>) {
    return this.actions.schedule(...a);
  }
  onPullRequestEvent(...a: Parameters<Actions["onPullRequest"]>) {
    return this.actions.onPullRequest(...a);
  }
  workflows(...a: Parameters<Actions["listWorkflows"]>) {
    return this.actions.listWorkflows(...a);
  }
  runPlan(...a: Parameters<Actions["plan"]>) {
    return this.actions.plan(...a);
  }
  startJobKey(...a: Parameters<Actions["startJobKey"]>) {
    return this.actions.startJobKey(...a);
  }
  jobGate(...a: Parameters<Actions["jobGate"]>) {
    return this.actions.jobGate(...a);
  }
  pendingDeployments(...a: Parameters<Actions["pendingDeployments"]>) {
    return this.actions.pendingDeployments(...a);
  }
  reviewDeployments(...a: Parameters<Actions["reviewDeployments"]>) {
    return this.actions.reviewDeployments(...a);
  }
  deploymentReviews(...a: Parameters<Actions["deploymentReviews"]>) {
    return this.actions.deploymentReviews(...a);
  }
  jobTimedOut(...a: Parameters<Actions["jobTimedOut"]>) {
    return this.actions.jobTimedOut(...a);
  }
  finishRun(...a: Parameters<Actions["finishRun"]>) {
    return this.actions.finishRun(...a);
  }
  oidcClaims(...a: Parameters<Actions["oidcClaims"]>) {
    return this.actions.oidcClaims(...a);
  }
  runnerSpec(...a: Parameters<Actions["runnerSpec"]>) {
    return this.actions.runnerSpec(...a);
  }
  runnerLogs(...a: Parameters<Actions["runnerLogs"]>) {
    return this.actions.runnerLogs(...a);
  }
  runnerStep(...a: Parameters<Actions["runnerStep"]>) {
    return this.actions.runnerStep(...a);
  }
  runnerComplete(...a: Parameters<Actions["runnerComplete"]>) {
    return this.actions.runnerComplete(...a);
  }
  packagesPermission(...a: Parameters<Actions["packagesPermission"]>) {
    return this.actions.packagesPermission(...a);
  }
  runnerAuth(...a: Parameters<Actions["runnerAuth"]>) {
    return this.actions.runnerAuth(...a);
  }
  containerStopped(...a: Parameters<Actions["containerStopped"]>) {
    return this.actions.containerStopped(...a);
  }
  relaunchJob(...a: Parameters<Actions["relaunchJob"]>) {
    return this.actions.relaunchJob(...a);
  }
  setSecret(...a: Parameters<Actions["setSecret"]>) {
    return this.actions.setSecret(...a);
  }
  deleteSecret(...a: Parameters<Actions["deleteSecret"]>) {
    return this.actions.deleteSecret(...a);
  }
  secretNames(...a: Parameters<Actions["secretNames"]>) {
    return this.actions.secretNames(...a);
  }
  setVariable(...a: Parameters<Actions["setVariable"]>) {
    return this.actions.setVariable(...a);
  }
  variables(...a: Parameters<Actions["variables"]>) {
    return this.actions.variables(...a);
  }
  cacheLookup(...a: Parameters<Actions["cacheLookup"]>) {
    return this.actions.cacheLookup(...a);
  }
  cacheSaved(...a: Parameters<Actions["cacheSaved"]>) {
    return this.actions.cacheSaved(...a);
  }
  artifactUploadKeys(...a: Parameters<Actions["artifactUploadKeys"]>) {
    return this.actions.artifactUploadKeys(...a);
  }
  artifactSaved(...a: Parameters<Actions["artifactSaved"]>) {
    return this.actions.artifactSaved(...a);
  }
  artifacts(...a: Parameters<Actions["artifacts"]>) {
    return this.actions.artifacts(...a);
  }
  createSandbox(...a: Parameters<Actions["createSandbox"]>) {
    return this.actions.createSandbox(...a);
  }
  sandbox(...a: Parameters<Actions["getSandbox"]>) {
    return this.actions.getSandbox(...a);
  }
  closeSandbox(...a: Parameters<Actions["closeSandbox"]>) {
    return this.actions.closeSandbox(...a);
  }
  closeTaskSandbox(...a: Parameters<Actions["closeTaskSandbox"]>) {
    return this.actions.closeTaskSandbox(...a);
  }
  /** A kill switch was turned on (lib/killswitch.ts): stop what runs here now. */
  stopActions(...a: Parameters<Actions["stopActions"]>) {
    return this.actions.stopActions(...a);
  }

  plannedRunError(runId: string, message: string) {
    return this.actions.plannedError(runId, message);
  }
  cacheSaveKeys(...a: Parameters<Actions["cacheSaveKeys"]>) {
    return this.actions.cacheSaveKeys(...a);
  }
  cacheReadKeys(...a: Parameters<Actions["cacheReadKeys"]>) {
    return this.actions.cacheReadKeys(...a);
  }
  artifactKeysFor(...a: Parameters<Actions["artifactKeysFor"]>) {
    return this.actions.artifactKeysFor(...a);
  }
  requireRunningJob(...a: Parameters<Actions["requireRunningJob"]>) {
    return this.actions.requireRunningJob(...a);
  }
  artifactQuota() {
    return this.runtime.artifactQuota;
  }

  // ---------------------------------------------------------------- RPC passthroughs (Actions runtime services)
  // The cache and artifact services of repo/runtime.ts, called by http/actions-runtime.ts
  // with the job named by a runtime token, and by the REST caches/artifacts routes.

  rtJob(...a: Parameters<Runtime["job"]>) {
    return this.runtime.job(...a);
  }
  rtGrantFor(...a: Parameters<Runtime["grantFor"]>) {
    return this.runtime.grantFor(...a);
  }
  rtCacheLookup(...a: Parameters<Runtime["cacheLookup"]>) {
    return this.runtime.cacheLookup(...a);
  }
  rtCacheReserve(...a: Parameters<Runtime["cacheReserve"]>) {
    return this.runtime.cacheReserve(...a);
  }
  rtCacheReservation(...a: Parameters<Runtime["cacheReservation"]>) {
    return this.runtime.cacheReservation(...a);
  }
  rtCacheWritable(...a: Parameters<Runtime["cacheWritable"]>) {
    return this.runtime.cacheWritable(...a);
  }
  rtCacheCommit(...a: Parameters<Runtime["cacheCommit"]>) {
    return this.runtime.cacheCommit(...a);
  }
  rtCacheGet(...a: Parameters<Runtime["cacheGet"]>) {
    return this.runtime.cacheGet(...a);
  }
  rtListCaches(...a: Parameters<Runtime["listCaches"]>) {
    return this.runtime.listCaches(...a);
  }
  rtDeleteCaches(...a: Parameters<Runtime["deleteCaches"]>) {
    return this.runtime.deleteCaches(...a);
  }
  rtCacheUsage(...a: Parameters<Runtime["cacheUsage"]>) {
    return this.runtime.cacheUsage(...a);
  }
  rtArtifactCreate(...a: Parameters<Runtime["artifactCreate"]>) {
    return this.runtime.artifactCreate(...a);
  }
  rtArtifactUpload(...a: Parameters<Runtime["artifactUpload"]>) {
    return this.runtime.artifactUpload(...a);
  }
  rtArtifactWritable(...a: Parameters<Runtime["artifactWritable"]>) {
    return this.runtime.artifactWritable(...a);
  }
  rtArtifactFinalize(...a: Parameters<Runtime["artifactFinalize"]>) {
    return this.runtime.artifactFinalize(...a);
  }
  rtArtifactGet(...a: Parameters<Runtime["artifactGet"]>) {
    return this.runtime.artifactGet(...a);
  }
  rtJobArtifacts(...a: Parameters<Runtime["jobArtifacts"]>) {
    return this.runtime.jobArtifacts(...a);
  }
  rtRunArtifacts(...a: Parameters<Runtime["runArtifacts"]>) {
    return this.runtime.runArtifacts(...a);
  }
  rtRepoArtifacts(...a: Parameters<Runtime["repoArtifacts"]>) {
    return this.runtime.repoArtifacts(...a);
  }
  rtArtifactDelete(...a: Parameters<Runtime["artifactDelete"]>) {
    return this.runtime.artifactDelete(...a);
  }
  rtArtifactDeleteByName(...a: Parameters<Runtime["artifactDeleteByName"]>) {
    return this.runtime.artifactDeleteByName(...a);
  }
  workflowSettings() {
    return this.policy.settings();
  }
  setWorkflowSettings(...a: Parameters<TokenPolicy["setSettings"]>) {
    return this.policy.setSettings(...a);
  }
  rtStage(...a: Parameters<Runtime["stage"]>) {
    return this.runtime.stage(...a);
  }
  rtUnstage(...a: Parameters<Runtime["unstage"]>) {
    return this.runtime.unstage(...a);
  }
  rtCheckCommitSize(...a: Parameters<Runtime["checkCommitSize"]>) {
    return this.runtime.checkCommitSize(...a);
  }
  rtCacheMissing(...a: Parameters<Runtime["cacheMissing"]>) {
    return this.runtime.cacheMissing(...a);
  }
  rtComposeStep(...a: Parameters<Runtime["composeStep"]>) {
    return this.runtime.composeStep(...a);
  }

  // ---------------------------------------------------------------- RPC passthroughs (GitHub-compatible extras)
  // Releases, commit statuses, deployments and environments, issue sub-resources
  // (labels, reactions, events, locking), the Git data API, search and misc.
  // The modules are created on first use.

  private extras: { releases?: Releases; statuses?: Statuses; deploys?: Deployments; social?: Social; gitdata?: GitData } = {};
  get releases(): Releases {
    return (this.extras.releases ??= new Releases(this, this.env));
  }
  get statuses(): Statuses {
    return (this.extras.statuses ??= new Statuses(this));
  }
  get deploys(): Deployments {
    return (this.extras.deploys ??= new Deployments(this, this.env));
  }
  get social(): Social {
    return (this.extras.social ??= new Social(this));
  }
  get gitdata(): GitData {
    return (this.extras.gitdata ??= new GitData(this, this.env));
  }

  listReleases(...a: Parameters<Releases["list"]>) {
    return this.releases.list(...a);
  }
  getRelease(...a: Parameters<Releases["get"]>) {
    return this.releases.get(...a);
  }
  releaseByTag(...a: Parameters<Releases["byTag"]>) {
    return this.releases.byTag(...a);
  }
  latestRelease() {
    return this.releases.latest();
  }
  releaseSummary(...a: Parameters<Releases["summary"]>) {
    return this.releases.summary(...a);
  }
  createRelease(...a: Parameters<Releases["create"]>) {
    return this.releases.create(...a);
  }
  updateRelease(...a: Parameters<Releases["update"]>) {
    return this.releases.update(...a);
  }
  deleteRelease(...a: Parameters<Releases["remove"]>) {
    return this.releases.remove(...a);
  }
  generateReleaseNotes(...a: Parameters<Releases["generateNotes"]>) {
    return this.releases.generateNotes(...a);
  }
  releaseAssets(...a: Parameters<Releases["assets"]>) {
    return this.releases.assets(...a);
  }
  releaseAsset(...a: Parameters<Releases["asset"]>) {
    return this.releases.asset(...a);
  }
  updateReleaseAsset(...a: Parameters<Releases["updateAsset"]>) {
    return this.releases.updateAsset(...a);
  }
  deleteReleaseAsset(...a: Parameters<Releases["deleteAsset"]>) {
    return this.releases.deleteAsset(...a);
  }
  startReleaseAsset(...a: Parameters<Releases["startAsset"]>) {
    return this.releases.startAsset(...a);
  }
  finishReleaseAsset(...a: Parameters<Releases["finishAsset"]>) {
    return this.releases.finishAsset(...a);
  }
  abortReleaseAsset(...a: Parameters<Releases["abortAsset"]>) {
    return this.releases.abortAsset(...a);
  }
  releaseDownload(...a: Parameters<Releases["download"]>) {
    return this.releases.download(...a);
  }
  /** For the GitHub importer: a release with its original dates and author (no tag, events or workflows). */
  importRelease(...a: Parameters<Releases["importRelease"]>) {
    return this.releases.importRelease(...a);
  }
  /** For the GitHub importer: an asset copied from a public https URL, or from an R2 key under this repository's prefix. */
  importReleaseAsset(...a: Parameters<Releases["importAsset"]>) {
    return this.releases.importAsset(...a);
  }

  createStatus(...a: Parameters<Statuses["create"]>) {
    return this.statuses.create(...a);
  }
  commitStatuses(...a: Parameters<Statuses["list"]>) {
    return this.statuses.list(...a);
  }
  combinedStatus(...a: Parameters<Statuses["combined"]>) {
    return this.statuses.combined(...a);
  }
  /** Check runs and commit statuses together, as pull request and commit pages show them. */
  checksAndStatuses(sha: string) {
    return [...this.collab.checks(sha), ...this.statuses.asChecks(sha)];
  }

  /** This repository's part of the Today view (agentic/today.ts): open pull requests and what landed or failed since `since`. */
  /** Pull requests whose mergeability a Today summary is checking in the background. */
  private todayMergeChecks = new Set<number>();

  todaySummary(since: string) {
    // Agents' auto-merges wait for a person's approval unless the base branch's rule waives it (repo/collab.ts mergeability).
    const waived = (base: string) => {
      const rules = this.protectionFor(base);
      return !!rules?.agentAutoMergeWithoutApproval && !rules.agentsMayMerge;
    };
    const summary = repoToday(this.sql, (sha) => this.checksAndStatuses(sha), since, waived);
    // After answering, find out whether agents' pull requests that may be waiting for a person conflict
    // or are already in their base, so the next Today leaves those out of "needs you".
    const unchecked = summary.pulls.filter((p) => needsMergeCheck(p) && !this.todayMergeChecks.has(p.number)).slice(0, MERGE_CHECKS_PER_SUMMARY);
    for (const p of unchecked) this.todayMergeChecks.add(p.number);
    if (unchecked.length)
      this.background(
        (async () => {
          for (const p of unchecked) {
            await this.collab.mergeability(p.number).catch((e) => console.error("today: mergeability check failed", p.number, e));
            this.todayMergeChecks.delete(p.number);
          }
        })(),
      );
    return summary;
  }

  createDeployment(...a: Parameters<Deployments["create"]>) {
    return this.deploys.create(...a);
  }
  deployments(...a: Parameters<Deployments["list"]>) {
    return this.deploys.list(...a);
  }
  deployment(...a: Parameters<Deployments["get"]>) {
    return this.deploys.get(...a);
  }
  deleteDeployment(...a: Parameters<Deployments["remove"]>) {
    return this.deploys.remove(...a);
  }
  createDeploymentStatus(...a: Parameters<Deployments["createStatus"]>) {
    return this.deploys.createStatus(...a);
  }
  deploymentStatuses(...a: Parameters<Deployments["statuses"]>) {
    return this.deploys.statuses(...a);
  }
  deploymentStatus(...a: Parameters<Deployments["status"]>) {
    return this.deploys.status(...a);
  }
  environments() {
    return this.deploys.environments();
  }
  environment(...a: Parameters<Deployments["environment"]>) {
    return this.deploys.environment(...a);
  }
  upsertEnvironment(...a: Parameters<Deployments["upsertEnvironment"]>) {
    return this.deploys.upsertEnvironment(...a);
  }
  deleteEnvironment(...a: Parameters<Deployments["deleteEnvironment"]>) {
    return this.deploys.deleteEnvironment(...a);
  }
  addEnvironmentBranchPattern(...a: Parameters<Deployments["addBranchPattern"]>) {
    return this.deploys.addBranchPattern(...a);
  }
  removeEnvironmentBranchPattern(...a: Parameters<Deployments["removeBranchPattern"]>) {
    return this.deploys.removeBranchPattern(...a);
  }
  setEnvironmentSecret(...a: Parameters<Deployments["setSecret"]>) {
    return this.deploys.setSecret(...a);
  }
  deleteEnvironmentSecret(...a: Parameters<Deployments["deleteSecret"]>) {
    return this.deploys.deleteSecret(...a);
  }
  environmentSecretNames(...a: Parameters<Deployments["secretNames"]>) {
    return this.deploys.secretNames(...a);
  }
  setEnvironmentVariable(...a: Parameters<Deployments["setVariable"]>) {
    return this.deploys.setVariable(...a);
  }
  environmentVariables(...a: Parameters<Deployments["variables"]>) {
    return this.deploys.variables(...a);
  }

  /** What the GitHub JSON builders need for a set of issues: label rows, reaction counts and lock reasons. */
  issueExtras(numbers: number[], subjects: string[] = []) {
    const lockReasons: Record<number, string | null> = {};
    for (const n of numbers) lockReasons[n] = this.social.lockReason(n);
    return { labels: this.social.labelRows(), reactions: this.social.reactionCounts([...numbers.map((n) => `issue:${n}`), ...subjects]), lockReasons };
  }
  issueEvents(...a: Parameters<Social["events"]>) {
    return this.social.events(...a);
  }
  repoIssueEvents(...a: Parameters<Social["repoEvents"]>) {
    return this.social.repoEvents(...a);
  }
  issueEvent(...a: Parameters<Social["event"]>) {
    return this.social.event(...a);
  }
  issueTimeline(...a: Parameters<Social["timeline"]>) {
    return this.social.timeline(...a);
  }
  labelRows() {
    return this.social.labelRows();
  }
  label(...a: Parameters<Social["label"]>) {
    return this.social.label(...a);
  }
  createLabel(...a: Parameters<Social["createLabel"]>) {
    return this.social.createLabel(...a);
  }
  updateLabel(...a: Parameters<Social["updateLabel"]>) {
    return this.social.updateLabel(...a);
  }
  deleteLabel(...a: Parameters<Social["deleteLabel"]>) {
    return this.social.deleteLabel(...a);
  }
  issueLabels(...a: Parameters<Social["issueLabels"]>) {
    return this.social.issueLabels(...a);
  }
  addIssueLabels(...a: Parameters<Social["addLabels"]>) {
    return this.social.addLabels(...a);
  }
  setIssueLabels(...a: Parameters<Social["setLabels"]>) {
    return this.social.setLabels(...a);
  }
  removeIssueLabel(...a: Parameters<Social["removeLabel"]>) {
    return this.social.removeLabel(...a);
  }
  assignIssue(...a: Parameters<Social["assign"]>) {
    return this.social.assign(...a);
  }
  lockIssue(...a: Parameters<Social["lock"]>) {
    return this.social.lock(...a);
  }
  unlockIssue(...a: Parameters<Social["unlock"]>) {
    return this.social.unlock(...a);
  }
  comment(...a: Parameters<Social["comment"]>) {
    return this.social.comment(...a);
  }
  deleteComment(...a: Parameters<Social["deleteComment"]>) {
    return this.social.deleteComment(...a);
  }
  repoComments(...a: Parameters<Social["repoComments"]>) {
    return this.social.repoComments(...a);
  }
  createReviewComment(...a: Parameters<Social["createReviewComment"]>) {
    return this.social.createReviewComment(...a);
  }
  review(...a: Parameters<Social["review"]>) {
    return this.social.review(...a);
  }
  dismissReview(...a: Parameters<Social["dismissReview"]>) {
    return this.social.dismissReview(...a);
  }
  removeReviewers(...a: Parameters<Social["removeReviewers"]>) {
    return this.social.removeReviewers(...a);
  }
  updatePullBranch(...a: Parameters<Social["updateBranch"]>) {
    return this.social.updateBranch(...a);
  }
  pullsForCommit(...a: Parameters<Social["pullsForCommit"]>) {
    return this.social.pullsForCommit(...a);
  }
  pullsForCommits(...a: Parameters<Social["pullsForCommits"]>) {
    return this.social.pullsForCommits(...a);
  }
  reactions(...a: Parameters<Social["reactions"]>) {
    return this.social.reactions(...a);
  }
  react(...a: Parameters<Social["react"]>) {
    return this.social.react(...a);
  }
  unreact(...a: Parameters<Social["unreact"]>) {
    return this.social.unreact(...a);
  }
  searchIssues(query: Parameters<typeof searchIssues>[1], limit: number) {
    return searchIssues(this, query, limit);
  }
  /** The issues for one page of search hits, in the order given (missing numbers are skipped). */
  issuesByNumber(numbers: number[], hide?: string[]) {
    return numbers.slice(0, 100).flatMap((n) => {
      try {
        return [this.collab.get(n, hide).issue];
      } catch {
        return [];
      }
    });
  }

  objectType(...a: Parameters<GitData["objectType"]>) {
    return this.gitdata.objectType(...a);
  }
  refsWithTypes(...a: Parameters<GitData["refsWithTypes"]>) {
    return this.gitdata.refsWithTypes(...a);
  }
  createBlob(content: Uint8Array, caller: Caller) {
    return this.gitdata.createBlob(content, caller);
  }
  getBlob(...a: Parameters<GitData["getBlob"]>) {
    return this.gitdata.getBlob(...a);
  }
  createTree(...a: Parameters<GitData["createTree"]>) {
    return this.gitdata.createTree(...a);
  }
  getTree(...a: Parameters<GitData["getTree"]>) {
    return this.gitdata.getTree(...a);
  }
  createGitCommit(...a: Parameters<GitData["createCommit"]>) {
    return this.gitdata.createCommit(...a);
  }
  gitCommit(...a: Parameters<GitData["gitCommit"]>) {
    return this.gitdata.gitCommit(...a);
  }
  createGitTag(...a: Parameters<GitData["createTag"]>) {
    return this.gitdata.createTag(...a);
  }
  gitTag(...a: Parameters<GitData["getTag"]>) {
    return this.gitdata.getTag(...a);
  }
  putContents(...a: Parameters<GitData["putContents"]>) {
    return this.gitdata.putContents(...a);
  }
  deleteContents(...a: Parameters<GitData["deleteContents"]>) {
    return this.gitdata.deleteContents(...a);
  }
  readme(...a: Parameters<GitData["readme"]>) {
    return this.gitdata.readme(...a);
  }
  mergeBranches(...a: Parameters<GitData["merge"]>) {
    return this.gitdata.merge(...a);
  }
  languages() {
    return this.gitdata.languages();
  }
  archiveKey(...a: Parameters<GitData["archiveKey"]>) {
    return this.gitdata.archiveKey(...a);
  }
  buildArchive(...a: Parameters<GitData["buildArchive"]>) {
    return this.gitdata.buildArchive(...a);
  }
  runLogsZip(...a: Parameters<GitData["runLogsZip"]>) {
    return this.gitdata.runLogsZip(...a);
  }
  runAttemptId(...a: Parameters<GitData["runAttemptId"]>) {
    return this.gitdata.runAttemptId(...a);
  }
  checkRun(...a: Parameters<GitData["check"]>) {
    return this.gitdata.check(...a);
  }
  updateCheckRun(...a: Parameters<GitData["updateCheck"]>) {
    return this.gitdata.updateCheck(...a);
  }
  checkSuites(...a: Parameters<GitData["checkSuites"]>) {
    return this.gitdata.checkSuites(...a);
  }
  checkSuite(...a: Parameters<GitData["checkSuite"]>) {
    return this.gitdata.checkSuite(...a);
  }

  /** repository_dispatch: an external event that starts workflows listening for its `event_type`. */
  async repositoryDispatch(eventType: string, clientPayload: Record<string, unknown>, caller: Caller): Promise<void> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to dispatch events");
    const sha = this.getRef(this.headRef);
    if (!sha) throw new HttpError(422, "the repository is empty");
    // Suspended Actions refuse the dispatch with the reason (triggerWorkflows would swallow it).
    await this.actions.refuseIfBlocked("run");
    const m = this.meta;
    const payload = { action: eventType, branch: m.defaultBranch, client_payload: clientPayload };
    this.emit({ type: "repository_dispatch", action: eventType, repoId: m.repoId, owner: m.owner, repo: m.name, payload: JSON.parse(JSON.stringify(payload)), actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf }, at: now() });
    await triggerWorkflows(this, { name: "repository_dispatch", action: eventType, ref: this.headRef, sha, payload, title: eventType }, caller);
  }

  // ---------------------------------------------------------------- RPC passthroughs: GitHub imports and milestones (repo/imports.ts)

  private importsCache?: RepoImports;
  private get importsModule(): RepoImports {
    return (this.importsCache ??= new RepoImports(this.sql));
  }

  /** The import that currently holds this repository, or null. Other writes are refused meanwhile (loadRepo, gitReceivePack). */
  importLockHolder(): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'import_lock'").toArray()[0]?.value ?? null;
  }

  /**
   * Claim the repository for an import. Refuses if another import holds it, or if the repo
   * already holds any ref, issue, comment, milestone, protection or release this import did not write
   * (so a retry never adopts content people added in the meantime — H2).
   */
  importBegin(importId: string): void {
    const holder = this.importLockHolder();
    if (holder && holder !== importId) throw new HttpError(409, "another import is in progress for this repository");
    // A ref not written by this import, or any foreign row, means the repo was adopted since.
    for (const r of this.refs()) {
      if (r.name.startsWith("refs/diffinery-import/")) continue;
      if (this.importsModule.importRefOid(r.name, importId) === null) {
        if (holder !== importId) throw new HttpError(409, "repository already holds content not written by this import; start a new import");
      }
    }
    if (this.importsModule.hasForeignContent(importId)) throw new HttpError(409, "repository already holds content not written by this import; start a new import");
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('import_lock', ?)", importId);
  }

  /** Release the import lock (on finalize, fail or cancel). */
  importEnd(importId: string): void {
    if (this.importLockHolder() === importId) this.sql.exec("DELETE FROM meta WHERE key = 'import_lock'");
  }

  importProtection(pattern: string, rules: ProtectionRules | null, importId: string) {
    // What agents may do is a person's decision here, never something an import brings in.
    if (rules) {
      const { allowAgentAutoMerge: _a, agentAutoMergeWithoutApproval: _w, autoMergeAgents: _g, autoMergeMethod: _gm, agentsMayPush: _p, agentsMayMerge: _m, ...rest } = rules;
      rules = rest;
    }
    if (rules?.mergeQueue) rules = { ...rules, mergeQueue: normalizeMergeQueue(rules.mergeQueue) };
    if (rules?.requiredCheckSources) rules = { ...rules, requiredCheckSources: normalizeCheckSources(rules.requiredCheckSources) };
    if (rules) this.importsModule.protection(pattern, JSON.stringify(rules), importId);
  }
  importLabels(...a: Parameters<RepoImports["labels"]>) {
    return this.importsModule.labels(...a);
  }
  importMilestones(...a: Parameters<RepoImports["milestones"]>) {
    return this.importsModule.milestones(...a);
  }
  importIssues(...a: Parameters<RepoImports["issues"]>) {
    return this.importsModule.issues(...a);
  }
  importComments(...a: Parameters<RepoImports["comments"]>) {
    return this.importsModule.comments(...a);
  }
  importReviews(...a: Parameters<RepoImports["reviews"]>) {
    return this.importsModule.reviews(...a);
  }
  importSetMergedBy(...a: Parameters<RepoImports["setMergedBy"]>) {
    return this.importsModule.setMergedBy(...a);
  }
  importPullNumbers(...a: Parameters<RepoImports["pullNumbers"]>) {
    return this.importsModule.pullNumbers(...a);
  }
  importCounts() {
    return this.importsModule.counts();
  }
  importFindings() {
    return this.importsModule.findings();
  }
  /**
   * Point `refs/pull/N/head` at each imported pull request's head commit (the server owns
   * refs/pull/*; the agent pushed the commits to refs/diffinery-import/pull/N). Heads whose
   * commits never arrived (e.g. deleted forks) are reported, not fatal.
   */
  importPullRefs(importId?: string): { created: number; missing: number[] } {
    const missing: number[] = [];
    let created = 0;
    for (const p of this.importsModule.pullHeads()) {
      const ref = `refs/pull/${p.number}/head`;
      if (!/^[0-9a-f]{40}$/.test(p.headSha) || !this.store.has(p.headSha)) {
        missing.push(p.number);
        continue;
      }
      const current = this.getRef(ref);
      // Record provenance so a retry does not mistake refs/pull/*/head for content people adopted.
      if (importId) this.importsModule.recordImportRef(ref, p.headSha, importId);
      if (current === p.headSha) continue;
      if (this.casRef(ref, current, p.headSha)) created++;
    }
    return { created, missing };
  }
  /** Remove the import's own refs once refs/pull/N/head keep the pull request commits reachable. */
  importDropTempRefs(importId?: string): number {
    const refs = this.refs(IMPORT_REF_PREFIX);
    for (const r of refs) this.casRef(r.name, r.oid, null);
    if (importId) this.importsModule.dropImportRefs(importId);
    return refs.length;
  }
  setOrgVariables(...a: Parameters<RepoImports["setOrgVariables"]>) {
    return this.importsModule.setOrgVariables(...a);
  }
  issueMilestoneOf(number: number) {
    return this.importsModule.milestoneOf(number);
  }
  /** Check names that workflow jobs on the default branch report, keyed by job name (GitHub names checks by job). */
  async importCheckNames(): Promise<Record<string, string[]>> {
    const sha = await this.resolve("HEAD");
    const out: Record<string, string[]> = {};
    if (!sha) return out;
    for (const w of await this.actions.loadWorkflows(sha)) {
      if (!w.workflow) continue;
      const wf = w.workflow.name ?? w.path.split("/").pop()!;
      for (const [key, job] of Object.entries(w.workflow.jobs)) {
        const name = (job as { name?: unknown }).name;
        for (const n of new Set([key, typeof name === "string" ? name : key])) (out[n] ??= []).push(`${wf} / ${typeof name === "string" && !name.includes("${{") ? name : key}`);
      }
    }
    return out;
  }
  milestones(...a: Parameters<RepoImports["listMilestones"]>) {
    return this.importsModule.listMilestones(...a);
  }
  milestone(...a: Parameters<RepoImports["milestone"]>) {
    return this.importsModule.milestone(...a);
  }
  saveMilestone(...a: Parameters<RepoImports["saveMilestone"]>) {
    return this.importsModule.saveMilestone(...a);
  }
  setIssueMilestone(...a: Parameters<RepoImports["setIssueMilestone"]>) {
    return this.importsModule.setIssueMilestone(...a);
  }

  // ---------------------------------------------------------------- live updates (WebSockets with hibernation)

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const topics = (new URL(request.url).searchParams.get("topics") ?? "repo").split(",").filter((t) => /^[a-z]+(:[A-Za-z0-9_-]+)?$/.test(t)).slice(0, 10);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], topics.length ? topics : ["repo"]);
    // Access is checked when a page connects; reconnecting checks it again, so someone who lost access
    // (removed, or the repository made private) stops getting updates within LIVE_REAUTH_MS.
    pair[1].serializeAttachment({ until: Date.now() + LIVE_REAUTH_MS });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Close a socket whose access check is too old; the page reconnects, and the Worker checks access again. */
  private expired(ws: WebSocket): boolean {
    const a = ws.deserializeAttachment() as { until?: number } | null;
    if (a?.until && a.until > Date.now()) return false;
    try {
      ws.close(LIVE_REAUTH_CODE, "reconnect");
    } catch {
      /* already closed */
    }
    return true;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.expired(ws)) return;
    if (message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "bye");
    } catch {
      /* already closed */
    }
  }

  broadcast(topic: string, data: unknown): void {
    const msg = JSON.stringify({ topic, data });
    for (const ws of this.ctx.getWebSockets(topic)) {
      if (this.expired(ws)) continue;
      try {
        ws.send(msg);
      } catch {
        /* client went away */
      }
    }
  }
}

export function toInfo(sha: string, c: Commit): CommitInfo {
  return { sha, tree: c.tree, parents: c.parents, author: c.author, committer: c.committer, message: c.message, signed: !!c.gpgsig };
}

export { fromUtf8 };
