import { ZERO_OID, mergeBase, mergeTrees, readCommit, serializeCommit } from "@diffinery/git-core";
import { squashSig } from "./collab.js";
import { ARCHIVED_REASON, automaticLandingRefusal } from "./auto-merge.js";
import { requiredCheck } from "./required.js";
import type { Actor } from "@diffinery/shared";
import { HttpError, now } from "../lib/util.js";
import type { RepoDO } from "./RepoDO.js";
import type { Caller, MergeQueueSettings } from "./types.js";

type QueueRow = {
  number: number;
  base_ref: string;
  seq: number;
  head_sha: string;
  method: "merge" | "squash" | "rebase";
  delete_branch: number;
  enqueued_by: string;
  enqueued_at: string;
  parent_sha: string | null;
  group_sha: string | null;
  group_ref: string | null;
  built_at: string | null;
};

export type QueueEntry = {
  number: number;
  title: string;
  base: string;
  position: number;
  headSha: string;
  method: QueueRow["method"];
  deleteBranch: boolean;
  enqueuedBy: Actor;
  enqueuedAt: string;
  /** queued: waiting for its merge group to be built; checking: its merge group is running checks. */
  state: "queued" | "checking";
  groupRef: string | null;
  groupSha: string | null;
  parentSha: string | null;
  builtAt: string | null;
  checks: Array<{ name: string; state: string }>;
};

export type EnqueueResult = { state: "queued" | "merged" | "removed"; entry: QueueEntry | null; mergeCommit?: string | null; reason?: string };

/** Prefix of merge group branches, the same as GitHub's so existing `branches-ignore` filters keep working. */
export const QUEUE_BRANCH_PREFIX = "gh-readonly-queue/";

export const QUEUE_BOT: Caller = { id: "system:merge-queue", login: "diffinery-merge-queue[bot]", kind: "system", role: "admin" };

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MINUTES = 60;
const OK = new Set(["success", "skipped", "neutral"]);

/** Validates merge queue settings from the API or the settings page. */
export function normalizeMergeQueue(q: MergeQueueSettings | boolean): MergeQueueSettings {
  const o: MergeQueueSettings = typeof q === "object" && q ? q : {};
  const int = (v: unknown, min: number, max: number) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : undefined);
  const out: MergeQueueSettings = { method: o.method === "squash" || o.method === "rebase" ? o.method : "merge" };
  const concurrency = int(o.buildConcurrency, 1, 20);
  const timeout = int(o.checkTimeoutMinutes, 1, 360);
  if (concurrency !== undefined) out.buildConcurrency = concurrency;
  if (timeout !== undefined) out.checkTimeoutMinutes = timeout;
  return out;
}

/**
 * A merge queue per protected base branch, like GitHub's. Each queued pull request
 * gets a merge group: a commit on `gh-readonly-queue/<base>/pr-<n>-<head>` that holds
 * the base branch, every pull request ahead of it, and its own changes. `merge_group`
 * (and `push`) workflows run on that commit; once the required checks pass and every
 * entry ahead has merged, the base branch fast-forwards to exactly the tested commit.
 * A pull request whose group fails, conflicts or times out leaves the queue, and the
 * groups behind it are rebuilt without it.
 */
export class MergeQueue {
  private lock: Promise<unknown> = Promise.resolve();
  /** Why each pull request last left a queue (kept in memory for the enqueue response). */
  private removals = new Map<number, string>();

  constructor(private repo: RepoDO) {}

  private get sql() {
    return this.repo.sql;
  }

  settings(base: string): MergeQueueSettings | null {
    return this.repo.protectionFor(base)?.mergeQueue ?? null;
  }

  private rows(base?: string): QueueRow[] {
    return base
      ? this.sql.exec<QueueRow>("SELECT * FROM merge_queue WHERE base_ref = ? ORDER BY seq", base).toArray()
      : this.sql.exec<QueueRow>("SELECT * FROM merge_queue ORDER BY base_ref, seq").toArray();
  }

  private row(number: number): QueueRow | null {
    return this.sql.exec<QueueRow>("SELECT * FROM merge_queue WHERE number = ?", number).toArray()[0] ?? null;
  }

  isQueued(number: number): boolean {
    return this.row(number) !== null;
  }

  /** The base branch whose queue holds the merge group on `sha`, if any. */
  baseForGroup(sha: string): string | null {
    return this.sql.exec<{ base_ref: string }>("SELECT base_ref FROM merge_queue WHERE group_sha = ?", sha).toArray()[0]?.base_ref ?? null;
  }

  hasEntries(base: string): boolean {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM merge_queue WHERE base_ref = ?", base).one().n > 0;
  }

  list(base?: string): QueueEntry[] {
    const out: QueueEntry[] = [];
    const position = new Map<string, number>();
    for (const r of this.rows(base)) {
      const pos = (position.get(r.base_ref) ?? 0) + 1;
      position.set(r.base_ref, pos);
      const title = this.sql.exec<{ title: string }>("SELECT title FROM issues WHERE number = ?", r.number).toArray()[0]?.title ?? "";
      const rules = this.repo.protectionFor(r.base_ref);
      const required = rules?.requiredChecks ?? [];
      const checks = r.group_sha ? this.repo.checksAndStatuses(r.group_sha) : [];
      out.push({
        number: r.number,
        title,
        base: r.base_ref,
        position: pos,
        headSha: r.head_sha,
        method: r.method,
        deleteBranch: !!r.delete_branch,
        enqueuedBy: JSON.parse(r.enqueued_by) as Actor,
        enqueuedAt: r.enqueued_at,
        state: r.group_sha ? "checking" : "queued",
        groupRef: r.group_ref,
        groupSha: r.group_sha,
        parentSha: r.parent_sha,
        builtAt: r.built_at,
        checks: (required.length ? required : [...new Set(checks.map((c) => c.name))]).map((name) => {
          const c = requiredCheck(name, checks, rules?.requiredCheckSources?.[name]);
          return { name, state: c.state === "missing" ? "expected" : c.state === "pending" ? (c.status ?? "queued") : (c.conclusion ?? "neutral") };
        }),
      });
    }
    return out;
  }

  entry(number: number): QueueEntry | null {
    const r = this.row(number);
    return r ? (this.list(r.base_ref).find((e) => e.number === number) ?? null) : null;
  }

  /** Add a pull request to its base branch's queue ("Merge when ready"). */
  async enqueue(number: number, input: { method?: QueueRow["method"]; deleteBranch?: boolean }, caller: Caller): Promise<EnqueueResult> {
    const { issue } = this.repo.collab.get(number);
    const pull = issue.pull;
    if (!pull) throw new HttpError(422, `#${number} is not a pull request`);
    if (await this.repo.isArchived()) throw new HttpError(403, "repository is archived (read-only)");
    const settings = this.settings(pull.base);
    if (!settings) throw new HttpError(422, `${pull.base} does not use a merge queue; merge the pull request directly`);
    if (this.row(number)) return this.result(number);
    // The queue lands the pull request for whoever enqueued it: agents and workflow tokens only where the branch allows it.
    const refusal = automaticLandingRefusal(caller, this.repo.protectionFor(pull.base), pull.base === this.repo.meta.defaultBranch, pull.base);
    if (refusal) throw new HttpError(refusal.status, refusal.message);
    const m = await this.repo.collab.mergeability(number, caller, { automatic: true });
    if (!m.mergeable) throw new HttpError(405, `pull request cannot be added to the merge queue: ${m.blockers.join("; ")}`, { blockers: m.blockers });
    const method = input.method ?? settings.method ?? "merge";
    if (method === "merge" && this.repo.protectionFor(pull.base)?.requireLinearHistory) throw new HttpError(422, `${pull.base} requires linear history; use squash or rebase`);
    this.sql.exec("INSERT INTO counters (name, value) VALUES ('queue', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
    const seq = this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = 'queue'").one().value;
    this.sql.exec(
      "INSERT INTO merge_queue (number, base_ref, seq, head_sha, method, delete_branch, enqueued_by, enqueued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      number,
      pull.base,
      seq,
      pull.headSha,
      method,
      input.deleteBranch ? 1 : 0,
      JSON.stringify({ id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf }),
      now(),
    );
    this.emit(number, "enqueued", caller);
    await this.process(pull.base);
    return this.result(number);
  }

  /** Where a pull request stands after a queue pass: still queued, merged, or removed (and why). */
  private result(number: number): EnqueueResult {
    const entry = this.entry(number);
    if (entry) return { state: "queued", entry };
    const merged = this.sql.exec<{ merge_commit: string | null; merged: number }>("SELECT merged, merge_commit FROM pulls WHERE number = ?", number).toArray()[0];
    if (merged?.merged) return { state: "merged", entry: null, mergeCommit: merged.merge_commit };
    return { state: "removed", entry: null, reason: this.removals.get(number) };
  }

  /** Remove a pull request from the queue at a person's request. */
  async dequeue(number: number, caller: Caller): Promise<void> {
    const r = this.row(number);
    if (!r) throw new HttpError(404, `#${number} is not in the merge queue`);
    await this.exclusive(async () => {
      const row = this.row(number);
      if (row) await this.remove(row, `${caller.login} removed it from the queue`, caller, false);
    });
    await this.process(r.base_ref);
  }

  /** The repository was archived: nothing merges any more, so every queue is emptied, saying why on each pull request. */
  repositoryArchived(): Promise<void> {
    return this.exclusive(async () => {
      for (const r of this.rows()) await this.remove(r, ARCHIVED_REASON);
      this.armAlarm();
    });
  }

  /** Re-evaluate in the background (after checks, pushes and pull request changes). */
  schedule(base?: string): void {
    this.repo.background(this.process(base));
  }

  /** Advance one queue, or every queue: merge, drop failures, rebuild and build merge groups. */
  process(base?: string): Promise<void> {
    return this.exclusive(async () => {
      const bases = base ? [base] : [...new Set(this.rows().map((r) => r.base_ref))];
      for (const b of bases) {
        try {
          await this.step(b);
        } catch (e) {
          console.error(`merge queue for ${b} failed`, e);
        }
      }
      this.armAlarm();
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async step(base: string): Promise<void> {
    const settings = this.settings(base);
    const baseRef = `refs/heads/${base}`;
    // An archived repository is read-only: a merge group's check that finishes after the archive merges nothing.
    const archived = await this.repo.isArchived();
    for (const r of this.rows(base)) {
      if (archived) await this.remove(r, ARCHIVED_REASON);
      else if (!settings) await this.remove(r, `${base} no longer uses a merge queue`);
      else if (!this.repo.getRef(baseRef)) await this.remove(r, `the base branch ${base} no longer exists`);
      else {
        const p = this.sql.exec<{ head_sha: string; merged: number; state: string }>("SELECT p.head_sha, p.merged, i.state FROM pulls p JOIN issues i ON i.number = p.number WHERE p.number = ?", r.number).toArray()[0];
        if (!p || p.merged || p.state !== "open") await this.remove(r, "the pull request was closed", undefined, false);
        else if (p.head_sha !== r.head_sha) await this.remove(r, "new commits were pushed to its branch");
      }
    }
    if (!settings || archived) return;

    // Merge from the front: the front group is built on the current base and its checks passed.
    for (;;) {
      const front = this.rows(base)[0];
      const baseSha = this.repo.getRef(baseRef);
      if (!front?.group_sha || !baseSha || front.parent_sha !== baseSha) break;
      const verdict = this.verdict(front, base, settings);
      if (verdict === "pending") break;
      if (verdict !== "pass") {
        await this.remove(front, verdict);
        continue;
      }
      if (!this.repo.casRef(baseRef, baseSha, front.group_sha)) break;
      this.sql.exec("DELETE FROM merge_queue WHERE number = ?", front.number);
      // The group's commit is now the base branch; its runs (on the deleted branch) may finish.
      await this.dropGroup(front, { cancel: false });
      const by = JSON.parse(front.enqueued_by) as Actor;
      await this.repo.collab.completeMerge(front.number, front.group_sha, baseSha, { ...by, role: "admin" }, !!front.delete_branch);
    }

    // Each group must sit on the one ahead of it (the first on the base branch). Groups whose
    // checks failed leave the queue; anything built on a group that changed is rebuilt.
    let expected = this.repo.getRef(baseRef)!;
    let built = 0;
    let blocked = false;
    const limit = Math.max(1, Math.min(20, settings.buildConcurrency ?? DEFAULT_CONCURRENCY));
    for (const r of this.rows(base)) {
      if (!blocked && r.group_sha && r.parent_sha === expected) {
        const verdict = this.verdict(r, base, settings);
        if (verdict !== "pass" && verdict !== "pending") {
          await this.remove(r, verdict);
          continue;
        }
        expected = r.group_sha;
        built++;
        continue;
      }
      if (r.group_sha) await this.dropGroup(r, { reset: true });
      if (blocked || built >= limit) {
        blocked = true;
        continue;
      }
      const group = await this.build(r, expected);
      if ("error" in group) {
        await this.remove(r, group.error);
        continue;
      }
      expected = group.sha;
      built++;
    }
  }

  /** "pass", "pending", or why the group failed. */
  private verdict(r: QueueRow, base: string, settings: MergeQueueSettings): string {
    const rules = this.repo.protectionFor(base);
    const required = rules?.requiredChecks ?? [];
    const checks = this.repo.checksAndStatuses(r.group_sha!);
    for (const name of required) {
      const c = requiredCheck(name, checks, rules?.requiredCheckSources?.[name]);
      if (c.state === "failure") {
        const what = c.conclusion === "timed_out" ? "timed out" : c.conclusion === "cancelled" ? "was cancelled" : c.conclusion === "action_required" ? "needs action" : "failed";
        return `the required check '${name}' ${what} on its merge group`;
      }
    }
    const pending = required.filter((name) => requiredCheck(name, checks, rules?.requiredCheckSources?.[name]).state !== "success");
    if (!pending.length) return "pass";
    const timeout = (settings.checkTimeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
    if (r.built_at && Date.parse(r.built_at) + timeout <= Date.now()) {
      return `required checks did not finish within ${settings.checkTimeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES} minutes (${pending.map((n) => `'${n}'`).join(", ")})`;
    }
    return "pending";
  }

  /** Build the merge group of `r` on `parent`, create its branch and start its workflows. */
  private async build(r: QueueRow, parent: string): Promise<{ sha: string } | { error: string }> {
    const store = this.repo.store;
    const { issue } = this.repo.collab.get(r.number);
    const pull = issue.pull!;
    const by = JSON.parse(r.enqueued_by) as Actor;
    const ts = Math.floor(Date.now() / 1000);
    const committer = { name: by.login, email: this.repo.noreply(by.login), timestamp: ts, timezone: "+0000" };
    let sha: string;
    if (r.method === "rebase") {
      let cur = parent;
      for (const c of await this.repo.collab.pullCommits(r.number)) {
        if (c.parents.length !== 1) return { error: "rebase merges cannot include merge commits; use a merge commit or squash" };
        const [p, mine, theirs] = await Promise.all([readCommit(store, c.parents[0]!), readCommit(store, cur), readCommit(store, c.sha)]);
        const merged = await mergeTrees(store, p.tree, mine.tree, theirs.tree);
        if (merged.conflicts.length || !merged.tree) return { error: `it conflicts with ${pull.base} and the pull requests ahead of it (${merged.conflicts.slice(0, 5).join(", ")})` };
        cur = await store.write("commit", serializeCommit({ tree: merged.tree, parents: [cur], author: theirs.author, committer, message: theirs.message, extraHeaders: theirs.extraHeaders }));
      }
      sha = cur;
    } else {
      const mb = await mergeBase(store, parent, r.head_sha);
      const [pt, ht, bt] = await Promise.all([readCommit(store, parent), readCommit(store, r.head_sha), mb ? readCommit(store, mb) : null]);
      const merged = await mergeTrees(store, bt?.tree ?? null, pt.tree, ht.tree);
      if (merged.conflicts.length || !merged.tree) return { error: `it conflicts with ${pull.base} and the pull requests ahead of it (${merged.conflicts.slice(0, 5).join(", ")})` };
      const message =
        r.method === "squash"
          ? `${issue.title} (#${r.number})\n\n${(await this.repo.collab.pullCommits(r.number)).map((c) => `* ${c.message.split("\n")[0]}`).join("\n")}\n`
          : `Merge pull request #${r.number} from ${pull.head}\n\n${issue.title}\n`;
      const author = r.method === "squash" ? squashSig(issue.author, committer, this.repo.noreply.bind(this.repo)) : committer;
      sha = await store.write("commit", serializeCommit({ tree: merged.tree, parents: r.method === "squash" ? [parent] : [parent, r.head_sha], author, committer, message }));
    }
    const ref = `refs/heads/${QUEUE_BRANCH_PREFIX}${pull.base}/pr-${r.number}-${r.head_sha}`;
    const old = this.repo.getRef(ref);
    this.repo.casRef(ref, old, sha);
    this.sql.exec("UPDATE merge_queue SET parent_sha = ?, group_sha = ?, group_ref = ?, built_at = ? WHERE number = ?", parent, sha, ref, now(), r.number);
    // GitHub runs push workflows on merge group branches too, then merge_group workflows.
    await this.repo.afterRefUpdate(ref, old ?? ZERO_OID, sha, QUEUE_BOT);
    await this.repo.actions.onMergeGroup({ number: r.number, base: pull.base, ref, sha, parent, title: issue.title, sender: by });
    this.repo.broadcast(`pr:${r.number}`, { action: "queue" });
    return { sha };
  }

  /** Delete a group's branch and (unless it merged) cancel its runs; `reset` keeps the entry queued for a rebuild. */
  private async dropGroup(r: QueueRow, o: { reset?: boolean; cancel?: boolean } = {}): Promise<void> {
    if (r.group_ref) {
      if (o.cancel !== false) await this.repo.actions.cancelRunsOnRef(r.group_ref, "Cancelled because its merge group was rebuilt or left the queue.");
      const sha = this.repo.getRef(r.group_ref);
      if (sha && this.repo.casRef(r.group_ref, sha, null)) await this.repo.afterRefUpdate(r.group_ref, sha, ZERO_OID, QUEUE_BOT);
    }
    if (o.reset) this.sql.exec("UPDATE merge_queue SET parent_sha = NULL, group_sha = NULL, group_ref = NULL, built_at = NULL WHERE number = ?", r.number);
  }

  private async remove(r: QueueRow, reason: string, by: Caller = QUEUE_BOT, comment = true): Promise<void> {
    this.sql.exec("DELETE FROM merge_queue WHERE number = ?", r.number);
    await this.dropGroup(r);
    this.removals.set(r.number, reason);
    this.emit(r.number, "dequeued", by);
    if (comment) {
      try {
        this.repo.collab.addComment(r.number, `This pull request was removed from the merge queue: ${reason}.`, QUEUE_BOT);
      } catch (e) {
        console.warn("merge queue comment failed", e);
      }
    }
    this.repo.broadcast(`pr:${r.number}`, { action: "queue" });
  }

  private emit(number: number, action: "enqueued" | "dequeued", by: Caller | Actor): void {
    const p = this.sql.exec<{ head_ref: string; head_sha: string; base_ref: string }>("SELECT head_ref, head_sha, base_ref FROM pulls WHERE number = ?", number).toArray()[0];
    if (!p) return;
    const m = this.repo.meta;
    this.repo.emit({ type: "pull_request", action, repoId: m.repoId, owner: m.owner, repo: m.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: { id: by.id, login: by.login, kind: by.kind, onBehalfOf: by.onBehalfOf }, at: now() });
  }

  /** Wake up when the earliest check timeout of a building group runs out. */
  private armAlarm(): void {
    let next = Infinity;
    for (const r of this.rows()) {
      if (!r.built_at) continue;
      const minutes = this.settings(r.base_ref)?.checkTimeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
      next = Math.min(next, Date.parse(r.built_at) + minutes * 60_000 + 1000);
    }
    this.repo.armAlarm(Number.isFinite(next) ? next : null);
  }
}
