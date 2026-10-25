import { HttpError, now } from "../lib/util.js";
import type { Check } from "./collab.js";
import type { RepoDO } from "./RepoDO.js";
import { atLeast, type Caller } from "./types.js";

export type StatusState = "error" | "failure" | "pending" | "success";
const STATES = new Set<StatusState>(["error", "failure", "pending", "success"]);

type StatusRow = {
  id: number;
  sha: string;
  state: StatusState;
  context: string;
  description: string | null;
  target_url: string | null;
  creator_id: string;
  creator_login: string;
  creator_kind: string;
  created_at: string;
  updated_at: string;
};

export type CommitStatus = {
  id: number;
  sha: string;
  state: StatusState;
  context: string;
  description: string | null;
  targetUrl: string | null;
  creator: { id: string; login: string; kind: string };
  createdAt: string;
  updatedAt: string;
};

const toStatus = (r: StatusRow): CommitStatus => ({
  id: r.id,
  sha: r.sha,
  state: r.state,
  context: r.context,
  description: r.description,
  targetUrl: r.target_url,
  creator: { id: r.creator_id, login: r.creator_login, kind: r.creator_kind },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Combined state as GitHub computes it: any failure or error fails, any pending (or none) is pending. */
export function combineStates(states: StatusState[]): StatusState | "pending" {
  if (states.some((s) => s === "error" || s === "failure")) return "failure";
  if (!states.length || states.some((s) => s === "pending")) return "pending";
  return "success";
}

/**
 * Commit statuses (the older, simpler API next to check runs). External CI and
 * bots post them; they show with the checks on pull requests and commits, and
 * branch protection's required checks match a status `context` too.
 */
export class Statuses {
  constructor(private repo: RepoDO) {}

  private get sql() {
    return this.repo.sql;
  }

  async create(rev: string, input: { state?: string; target_url?: string | null; description?: string | null; context?: string }, caller: Caller): Promise<CommitStatus> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to create commit statuses");
    const sha = await this.repo.resolve(rev);
    if (!sha) throw new HttpError(422, `no commit found for SHA: ${rev}`, { errors: [{ resource: "Status", code: "invalid", field: "sha" }] });
    const state = input.state as StatusState;
    if (!STATES.has(state)) throw new HttpError(422, "state must be one of error, failure, pending, success", { errors: [{ resource: "Status", code: "invalid", field: "state" }] });
    const target = input.target_url || null;
    if (target && !/^https?:\/\//i.test(target)) throw new HttpError(422, "target_url must be an http(s) URL", { errors: [{ resource: "Status", code: "invalid", field: "target_url" }] });
    const context = (input.context || "default").slice(0, 255);
    if (this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM statuses WHERE sha = ? AND context = ?", sha, context).one().n >= 1000) {
      throw new HttpError(422, "this SHA and context has reached the maximum number of statuses");
    }
    const t = now();
    this.sql.exec(
      "INSERT INTO statuses (sha, state, context, description, target_url, creator_id, creator_login, creator_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      sha,
      state,
      context,
      input.description ? input.description.slice(0, 1024) : null,
      target,
      caller.id,
      caller.login,
      caller.kind,
      t,
      t,
    );
    const status = toStatus(this.sql.exec<StatusRow>("SELECT * FROM statuses WHERE id = last_insert_rowid()").one());
    const m = this.repo.meta;
    this.repo.emit({
      type: "status",
      repoId: m.repoId,
      owner: m.owner,
      repo: m.name,
      payload: { id: status.id, sha, name: `${m.owner}/${m.name}`, state, context, description: status.description, target_url: target, commit: { sha }, created_at: t, updated_at: t },
      actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf },
      at: t,
    });
    for (const p of this.sql.exec<{ number: number }>("SELECT number FROM pulls WHERE head_sha = ?", sha).toArray()) this.repo.broadcast(`pr:${p.number}`, { action: "checks" });
    if (state !== "pending") this.repo.collab.checkCompleted(sha);
    return status;
  }

  /** Every status for a commit, newest first. */
  list(sha: string): CommitStatus[] {
    return this.sql.exec<StatusRow>("SELECT * FROM statuses WHERE sha = ? ORDER BY id DESC", sha).toArray().map(toStatus);
  }

  /** The latest status per context. */
  latest(sha: string): CommitStatus[] {
    return this.sql
      .exec<StatusRow>("SELECT s.* FROM statuses s WHERE s.sha = ? AND s.id = (SELECT max(id) FROM statuses x WHERE x.sha = s.sha AND x.context = s.context) ORDER BY s.context", sha)
      .toArray()
      .map(toStatus);
  }

  combined(sha: string): { state: string; statuses: CommitStatus[] } {
    const statuses = this.latest(sha);
    return { state: combineStates(statuses.map((s) => s.state)), statuses };
  }

  /** Latest statuses shaped like check runs, for the UI and merge requirements. */
  asChecks(sha: string): Check[] {
    // Newest per context *and creator*: one reporter's later status can't overwrite another's for required checks.
    const rows = this.sql
      .exec<StatusRow>("SELECT s.* FROM statuses s WHERE s.sha = ? AND s.id = (SELECT max(id) FROM statuses x WHERE x.sha = s.sha AND x.context = s.context AND x.creator_id = s.creator_id) ORDER BY s.context, s.id", sha)
      .toArray()
      .map(toStatus);
    return rows.map((s) => ({
      id: `status-${s.id}`,
      sha,
      name: s.context,
      status: s.state === "pending" ? "in_progress" : "completed",
      conclusion: s.state === "pending" ? null : s.state === "error" ? "failure" : s.state,
      runId: null,
      jobId: null,
      detailsUrl: s.targetUrl,
      output: s.description ? { title: s.description } : null,
      app: "status",
      startedAt: s.createdAt,
      completedAt: s.state === "pending" ? null : s.updatedAt,
      creatorId: s.creator.id,
      creatorLogin: s.creator.login,
      creatorKind: s.creator.kind,
    }));
  }
}
