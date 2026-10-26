import { ZERO_OID, isAncestor, mergeBase, mergeTrees, readCommit, serializeCommit, walkCommits } from "@diffinery/git-core";
import { checkPublicUrl } from "../imports/options.js";
import type { Env } from "../env.js";
import { encryptSecret, openSecret } from "../lib/crypto.js";
import type { QueueEntry } from "./queue.js";
import { HttpError, checkText, newId, noreplyEmail, noreplyHost, now, randomToken } from "../lib/util.js";
import type { RepoDO } from "./RepoDO.js";
import { toInfo } from "./RepoDO.js";
import { atLeast, refuseBlocked, type Caller } from "./types.js";
import { COMMENT_SELECT } from "./social.js";
import { requiredCheck } from "./required.js";
import { AutoMerge, automaticLandingRefusal, isPerson, landsByAgentRule, mergesByAgentPermission, type AutoMergeInfo } from "./auto-merge.js";

type Sig = { name: string; email: string; timestamp: number; timezone: string };

/**
 * The author signature for a squash or rebase commit. A pull request authored by a GitHub import
 * (a mannequin, author_kind "github") is attributed to the original GitHub user through GitHub's
 * own noreply domain, never a Diffinery address, so an imported author is never passed off as a
 * Diffinery account.
 */
export function squashSig(author: { login: string; kind?: string | null }, base: Sig, noreply: (login: string) => string): Sig {
  if (author.kind === "github") {
    const bare = author.login.replace(/^github:/, "");
    return { ...base, name: bare, email: `${bare}@users.noreply.github.com` };
  }
  return { ...base, name: author.login, email: noreply(author.login) };
}

export type IssueRow = {
  number: number;
  kind: "issue" | "pull";
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason: string | null;
  author_id: string;
  author_login: string;
  author_kind: string;
  assignees: string;
  labels: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  locked: number;
};

export type PullRow = {
  number: number;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  draft: number;
  merged: number;
  merged_at: string | null;
  merged_by: string | null;
  merge_commit: string | null;
  merged_base?: string | null;
  requested_reviewers: string;
  intent: string | null;
  auto_merge: string | null;
};

export type Issue = {
  number: number;
  kind: "issue" | "pull";
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  author: { id: string; login: string; kind: string };
  assignees: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
  locked: boolean;
  milestone: { number: number; title: string; state: "open" | "closed"; dueOn: string | null } | null;
  pull?: {
    head: string;
    headSha: string;
    base: string;
    draft: boolean;
    merged: boolean;
    mergedAt: string | null;
    mergedBy: string | null;
    mergeCommit: string | null;
    requestedReviewers: string[];
    intent: string | null;
    /** Set while auto-merge is on: it merges (or enqueues) by itself once every rule is met. */
    autoMerge: AutoMergeInfo | null;
  };
};

export type Comment = {
  id: string;
  author: { id: string; login: string; kind: string };
  body: string;
  createdAt: string;
  updatedAt: string;
  reviewId: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  commitId: string | null;
  inReplyTo: string | null;
  resolved: boolean;
  /** GitHub-style numeric ids: this comment's, its review's and its parent's. */
  seq?: number;
  reviewSeq?: number | null;
  inReplyToSeq?: number | null;
  /** Set while the comment is hidden (minimized) by someone with write access: why, by whom, when (lib/moderation.ts). */
  minimized?: { reason: string; by: string; at: string } | null;
};

export type Review = {
  id: string;
  author: { id: string; login: string; kind: string };
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  body: string;
  commitId: string;
  submittedAt: string;
  /** GitHub-style numeric id. */
  seq?: number;
  /** Set when the review was brought in by a GitHub import: it is shown as history, never counted as a vote. */
  imported?: boolean;
};

export type Check = {
  id: string;
  sha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  runId: string | null;
  jobId: string | null;
  detailsUrl: string | null;
  output: { title?: string; summary?: string } | null;
  app: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Who reported it over the REST API (none for Diffinery Actions). */
  creatorId?: string | null;
  creatorLogin?: string | null;
  creatorKind?: string | null;
  /** GitHub-style numeric id. */
  seq?: number | null;
};

export type Mergeability = {
  mergeable: boolean;
  state: "clean" | "blocked" | "conflicting" | "behind" | "draft" | "merged" | "closed" | "unknown";
  conflicts: string[];
  approvals: number;
  requiredApprovals: number;
  changesRequested: string[];
  checks: { name: string; state: string }[];
  blockers: string[];
  mergeBase: string | null;
  /** Set when the base branch merges through a merge queue. */
  mergeQueue: { method: "merge" | "squash" | "rebase"; entry: QueueEntry | null } | null;
  /** The base branch's rules that decide the merge form: merge commits refused, admins held to the rules. */
  linearHistory?: boolean;
  enforceAdmins?: boolean;
  /** How many required checks the base branch has: auto-merge waits for CI only where it has some. */
  requiredChecks?: number;
};

const actorOf = (c: Caller) => ({ id: c.id, login: c.login, kind: c.kind, onBehalfOf: c.onBehalfOf });

/** Webhooks one repository may have, as on GitHub. */
export const MAX_WEBHOOKS = 20;

/** A webhook as listed: everything but its signing secret. */
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  lastStatus: number | null;
  lastDeliveryAt: string | null;
}

export class Collab {
  constructor(
    private repo: RepoDO,
    private env: Env,
  ) {}

  private get sql() {
    return this.repo.sql;
  }

  private nextNumber(): number {
    this.sql.exec("INSERT INTO counters (name, value) VALUES ('issue', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
    return this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = 'issue'").one().value;
  }

  private row(number: number): IssueRow {
    const r = this.sql.exec<IssueRow>("SELECT * FROM issues WHERE number = ?", number).toArray()[0];
    if (!r) throw new HttpError(404, `#${number} not found`);
    return r;
  }

  private pullRow(number: number): PullRow {
    const r = this.sql.exec<PullRow>("SELECT * FROM pulls WHERE number = ?", number).toArray()[0];
    if (!r) throw new HttpError(404, `pull request #${number} not found`);
    return r;
  }

  private toIssue(r: IssueRow): Issue {
    const comments = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM comments WHERE number = ? AND review_id IS NULL", r.number).one().n;
    const issue: Issue = {
      number: r.number,
      kind: r.kind,
      title: r.title,
      body: r.body,
      state: r.state,
      stateReason: r.state_reason,
      author: { id: r.author_id, login: r.author_login, kind: r.author_kind },
      assignees: JSON.parse(r.assignees),
      labels: JSON.parse(r.labels),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
      comments,
      locked: !!r.locked,
      milestone: this.repo.issueMilestoneOf(r.number),
    };
    if (r.kind === "pull") {
      const p = this.pullRow(r.number);
      issue.pull = {
        head: p.head_ref,
        headSha: p.head_sha,
        base: p.base_ref,
        draft: !!p.draft,
        merged: !!p.merged,
        mergedAt: p.merged_at,
        mergedBy: p.merged_by,
        mergeCommit: p.merge_commit,
        requestedReviewers: JSON.parse(p.requested_reviewers),
        intent: p.intent,
        autoMerge: p.auto_merge ? AutoMerge.info(JSON.parse(p.auto_merge)) : null,
      };
    }
    return issue;
  }

  // ---------------------------------------------------------------- issues

  list(
    opts: {
      kind?: "issue" | "pull";
      state?: "open" | "closed" | "all";
      label?: string;
      author?: string;
      limit?: number;
      offset?: number;
      q?: string;
      // GitHub list filters (REST `issues` and `pulls` query parameters).
      labels?: string[];
      /** Any of these labels (GraphQL's `labels`); `labels` needs all of them (REST's). */
      anyLabels?: string[];
      assignee?: string;
      /** Mentioned as @login in the body or a comment (GraphQL's `filterBy.mentioned`, search's `mentions:`). */
      mentioned?: string;
      milestone?: number | "none" | "*";
      since?: string;
      head?: string;
      base?: string;
      sort?: "created" | "updated" | "comments";
      direction?: "asc" | "desc";
      /** Authors whose issues and pull requests are left out (suspended people, lib/moderation.ts). */
      hide?: string[];
    } = {},
  ): { items: Issue[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.hide?.length) {
      where.push("author_id NOT IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(opts.hide));
    }
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.state && opts.state !== "all") {
      where.push("state = ?");
      args.push(opts.state);
    }
    if (opts.author) {
      where.push("author_login = ? COLLATE NOCASE");
      args.push(opts.author);
    }
    if (opts.label) {
      where.push("EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)");
      args.push(opts.label);
    }
    if (opts.q) {
      where.push("(title LIKE ? OR body LIKE ?)");
      args.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    for (const l of opts.labels ?? []) {
      where.push("EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)");
      args.push(l);
    }
    if (opts.anyLabels?.length) {
      where.push("EXISTS (SELECT 1 FROM json_each(labels) WHERE value IN (SELECT value FROM json_each(?)))");
      args.push(JSON.stringify(opts.anyLabels));
    }
    if (opts.mentioned !== undefined) {
      // @login with no letter, digit or underscore before it and no login character after it
      // (so @ann doesn't match @anna or an email address). Logins are letters, digits and hyphens.
      if (!/^[A-Za-z0-9-]+$/.test(opts.mentioned)) where.push("0");
      else {
        const pattern = `*[^a-z0-9_]@${opts.mentioned.toLowerCase()}[^a-z0-9-]*`;
        where.push("(lower(' ' || body || ' ') GLOB ? OR EXISTS (SELECT 1 FROM comments c WHERE c.number = issues.number AND lower(' ' || c.body || ' ') GLOB ?))");
        args.push(pattern, pattern);
      }
    }
    if (opts.assignee === "none") where.push("assignees = '[]'");
    else if (opts.assignee === "*") where.push("assignees != '[]'");
    else if (opts.assignee) {
      where.push("EXISTS (SELECT 1 FROM json_each(assignees) WHERE lower(value) = lower(?))");
      args.push(opts.assignee);
    }
    if (opts.milestone === "none") where.push("number NOT IN (SELECT number FROM issue_milestones)");
    else if (opts.milestone === "*") where.push("number IN (SELECT number FROM issue_milestones)");
    else if (opts.milestone !== undefined) {
      where.push("number IN (SELECT number FROM issue_milestones WHERE milestone = ?)");
      args.push(opts.milestone);
    }
    if (opts.since) {
      where.push("updated_at >= ?");
      args.push(opts.since);
    }
    if (opts.head) {
      where.push("number IN (SELECT number FROM pulls WHERE head_ref = ?)");
      args.push(opts.head);
    }
    if (opts.base) {
      where.push("number IN (SELECT number FROM pulls WHERE base_ref = ?)");
      args.push(opts.base);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const dir = opts.direction === "asc" ? "ASC" : "DESC";
    const order =
      opts.sort === "updated"
        ? `updated_at ${dir}, number ${dir}`
        : opts.sort === "comments"
          ? `(SELECT count(*) FROM comments c WHERE c.number = issues.number AND c.review_id IS NULL) ${dir}, number ${dir}`
          : `number ${dir}`;
    const total = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM issues ${w}`, ...args).one().n;
    const rows = this.sql.exec<IssueRow>(`SELECT * FROM issues ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, Math.min(opts.limit ?? 30, 100), opts.offset ?? 0).toArray();
    return { items: rows.map((r) => this.toIssue(r)), total };
  }

  /** An issue or pull request with its comments and reviews. `hide`: authors left out (suspended people, lib/moderation.ts); their own issue is a 404. */
  get(number: number, hide?: string[]): { issue: Issue; comments: Comment[]; reviews: Review[] } {
    const issue = this.toIssue(this.row(number));
    if (hide?.includes(issue.author.id)) throw new HttpError(404, `#${number} not found`);
    const comments = this.sql
      .exec<Record<string, SqlStorageValue>>(`SELECT ${COMMENT_SELECT} FROM comments c WHERE c.number = ? ORDER BY c.created_at`, number)
      .toArray()
      .map(
        (c): Comment => ({
          id: c.id as string,
          author: { id: c.author_id as string, login: c.author_login as string, kind: c.author_kind as string },
          body: c.body as string,
          createdAt: c.created_at as string,
          updatedAt: c.updated_at as string,
          reviewId: (c.review_id as string) ?? null,
          path: (c.path as string) ?? null,
          line: (c.line as number) ?? null,
          side: (c.side as string) ?? null,
          commitId: (c.commit_id as string) ?? null,
          inReplyTo: (c.in_reply_to as string) ?? null,
          resolved: !!c.resolved,
          seq: c.seq as number,
          reviewSeq: (c.review_seq as number) ?? null,
          inReplyToSeq: (c.reply_seq as number) ?? null,
          minimized: c.minimized_reason ? { reason: c.minimized_reason as string, by: (c.minimized_by as string) ?? "", at: (c.minimized_at as string) ?? "" } : null,
        }),
      );
    const reviews = this.reviews(number);
    if (hide?.length) return { issue, comments: comments.filter((c) => !hide.includes(c.author.id)), reviews: reviews.filter((r) => !hide.includes(r.author.id)) };
    return { issue, comments, reviews };
  }

  private reviews(number: number): Review[] {
    return this.sql
      .exec<Record<string, string>>("SELECT rowid AS seq, * FROM reviews WHERE number = ? ORDER BY submitted_at", number)
      .toArray()
      .map((r) => ({
        id: r.id!,
        author: { id: r.author_id!, login: r.author_login!, kind: r.author_kind! },
        state: r.state as Review["state"],
        body: r.body!,
        commitId: r.commit_id!,
        submittedAt: r.submitted_at!,
        seq: Number(r.seq),
        imported: r.imported != null,
      }));
  }

  createIssue(input: { title: string; body?: string; labels?: string[]; assignees?: string[] }, caller: Caller): Issue {
    refuseBlocked(caller);
    if (!input.title?.trim()) throw new HttpError(422, "title is required");
    checkText("Issue", input);
    // As on GitHub, labels and assignees from someone without triage access are silently dropped.
    if (!atLeast(caller.role, "triage")) input = { ...input, labels: [], assignees: [] };
    const n = this.nextNumber();
    const t = now();
    this.sql.exec(
      "INSERT INTO issues (number, kind, title, body, author_id, author_login, author_kind, labels, assignees, created_at, updated_at) VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      n,
      input.title.trim(),
      input.body ?? "",
      caller.id,
      caller.login,
      caller.kind,
      JSON.stringify(input.labels ?? []),
      JSON.stringify(input.assignees ?? []),
      t,
      t,
    );
    const m = this.repo.meta;
    this.repo.emit({ type: "issues", action: "opened", repoId: m.repoId, owner: m.owner, repo: m.name, number: n, actor: actorOf(caller), at: t });
    this.repo.broadcast("issues", { number: n, action: "opened" });
    return this.toIssue(this.row(n));
  }

  update(number: number, patch: { title?: string; body?: string; state?: "open" | "closed"; stateReason?: string; labels?: string[]; assignees?: string[] }, caller: Caller): Issue {
    const r = this.row(number);
    checkText(r.kind === "pull" ? "PullRequest" : "Issue", patch);
    const isAuthor = r.author_id === caller.id;
    if (!isAuthor && !atLeast(caller.role, "triage")) throw new HttpError(403, "permission denied");
    if (!atLeast(caller.role, "triage")) {
      // As on GitHub, an author without triage access takes no part once they're blocked or the conversation is locked,
      // and can't reopen what someone else closed.
      refuseBlocked(caller);
      if (r.locked) throw new HttpError(403, "conversation is locked");
      if (patch.state === "open" && r.state === "closed") {
        const closer = this.sql.exec<{ actor_id: string }>("SELECT actor_id FROM issue_events WHERE number = ? AND event = 'closed' ORDER BY rowid DESC LIMIT 1", number).toArray()[0];
        if (closer && closer.actor_id !== caller.id) throw new HttpError(403, "only someone with triage access can reopen an issue someone else closed");
      }
      // As when creating: labels and assignees are silently dropped.
      patch = { ...patch, labels: undefined, assignees: undefined };
    }
    if (r.kind === "pull" && patch.state === "open" && this.pullRow(number).merged) throw new HttpError(422, "a merged pull request cannot be reopened");
    const t = now();
    const state = patch.state ?? r.state;
    this.sql.exec(
      "UPDATE issues SET title = ?, body = ?, state = ?, state_reason = ?, labels = ?, assignees = ?, updated_at = ?, closed_at = ? WHERE number = ?",
      patch.title ?? r.title,
      patch.body ?? r.body,
      state,
      patch.state === "closed" ? (patch.stateReason ?? "completed") : patch.state === "open" ? null : r.state_reason,
      JSON.stringify(patch.labels ?? JSON.parse(r.labels)),
      JSON.stringify(patch.assignees ?? JSON.parse(r.assignees)),
      t,
      state === "closed" ? (r.closed_at ?? t) : null,
      number,
    );
    this.repo.social.recordUpdate(r, patch, caller);
    const m = this.repo.meta;
    if ((patch.title !== undefined && patch.title !== r.title) || (patch.body !== undefined && patch.body !== r.body)) {
      if (r.kind === "pull") {
        const p = this.pullRow(number);
        this.repo.emit({ type: "pull_request", action: "edited", repoId: m.repoId, owner: m.owner, repo: m.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: actorOf(caller), at: t });
        this.repo.background(this.repo.actions.onPullRequest("edited", number, caller).catch((e) => console.error("pr workflow trigger", e)));
      } else this.repo.emit({ type: "issues", action: "edited", repoId: m.repoId, owner: m.owner, repo: m.name, number, actor: actorOf(caller), at: t });
    }
    if (patch.state && patch.state !== r.state) {
      const action = patch.state === "closed" ? "closed" : "reopened";
      if (r.kind === "pull") {
        const p = this.pullRow(number);
        this.repo.emit({ type: "pull_request", action, repoId: m.repoId, owner: m.owner, repo: m.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: actorOf(caller), at: t });
        if (!p.merged) this.repo.background(this.repo.actions.onPullRequest(action, number, caller).catch((e) => console.error("pr workflow trigger", e)));
        if (action === "closed" && this.repo.queue.isQueued(number)) this.repo.queue.schedule(p.base_ref);
        if (action === "closed") this.repo.autoMerge.clear(number);
      } else this.repo.emit({ type: "issues", action, repoId: m.repoId, owner: m.owner, repo: m.name, number, actor: actorOf(caller), at: t });
    }
    const before = new Set((JSON.parse(r.assignees) as string[]).map((x) => x.toLowerCase()));
    const added = (patch.assignees ?? []).filter((x) => !before.has(x.toLowerCase()));
    if (added.length) {
      if (r.kind === "pull") {
        const p = this.pullRow(number);
        this.repo.emit({ type: "pull_request", action: "assigned", repoId: m.repoId, owner: m.owner, repo: m.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: actorOf(caller), at: t, assignees: added });
      } else this.repo.emit({ type: "issues", action: "assigned", repoId: m.repoId, owner: m.owner, repo: m.name, number, actor: actorOf(caller), at: t, assignees: added });
    }
    this.repo.broadcast(`pr:${number}`, { action: "updated" });
    return this.toIssue(this.row(number));
  }

  /** Mark a pull request ready for review, or convert it back to a draft. */
  setDraft(number: number, draft: boolean, caller: Caller): Issue {
    const r = this.row(number);
    if (r.kind !== "pull") throw new HttpError(404, "not a pull request");
    if (r.author_id !== caller.id && !atLeast(caller.role, "write")) throw new HttpError(403, "only the author or someone with write access can change draft status");
    if (!atLeast(caller.role, "write")) refuseBlocked(caller);
    if (r.state !== "open") throw new HttpError(422, "the pull request is not open");
    const p = this.pullRow(number);
    if (!!p.draft === draft) return this.toIssue(r);
    const t = now();
    this.sql.exec("UPDATE pulls SET draft = ? WHERE number = ?", draft ? 1 : 0, number);
    this.sql.exec("UPDATE issues SET updated_at = ? WHERE number = ?", t, number);
    const action = draft ? "converted_to_draft" : "ready_for_review";
    // GitHub names the timeline event convert_to_draft; the webhook action is converted_to_draft.
    this.repo.social.record(number, draft ? "convert_to_draft" : "ready_for_review", caller, {});
    const m = this.repo.meta;
    this.repo.emit({ type: "pull_request", action, repoId: m.repoId, owner: m.owner, repo: m.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: actorOf(caller), at: t });
    this.repo.background(this.repo.actions.onPullRequest(action, number, caller).catch((e) => console.error("pr workflow trigger", e)));
    // As on GitHub, a draft can't auto-merge; one marked ready may now be mergeable.
    if (draft) this.repo.autoMerge.cancel(number, caller, "the pull request was converted to a draft");
    else {
      this.repo.autoMerge.schedule({ number });
      // A branch rule naming its agent, or (when they mark their own draft ready) the author's own setting.
      this.repo.background(this.repo.autoMerge.applyRule(number, true).then(() => this.repo.autoMerge.applyOwn(number, caller, { announce: true })));
    }
    this.repo.broadcast(`pr:${number}`, { action: "updated" });
    return this.toIssue(this.row(number));
  }

  addComment(number: number, body: string, caller: Caller): Comment {
    refuseBlocked(caller);
    const r = this.row(number);
    if (r.locked && !atLeast(caller.role, "triage")) throw new HttpError(403, "conversation is locked");
    if (!body?.trim()) throw new HttpError(422, "body is required");
    checkText("IssueComment", { body });
    const id = newId();
    const t = now();
    this.sql.exec("INSERT INTO comments (id, number, author_id, author_login, author_kind, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, number, caller.id, caller.login, caller.kind, body, t, t);
    this.sql.exec("UPDATE issues SET updated_at = ? WHERE number = ?", t, number);
    const m = this.repo.meta;
    this.repo.emit({ type: "issue_comment", action: "created", repoId: m.repoId, owner: m.owner, repo: m.name, number, commentId: id, actor: actorOf(caller), at: t });
    this.repo.broadcast(`pr:${number}`, { action: "comment", id });
    return this.get(number).comments.find((c) => c.id === id)!;
  }

  /**
   * Hide (minimize) a comment with one of GitHub's reasons, or (null) show it again. Needs write
   * access, as on GitHub; agents can't. Works for issue and review comments, by either id form.
   */
  minimizeComment(id: string, reason: string | null, caller: Caller): { number: number; reason: string | null } {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to hide comments");
    if (caller.kind !== "user") throw new HttpError(403, "only people can hide comments");
    id = this.repo.social.commentKey(id);
    const c = this.sql.exec<{ number: number }>("SELECT number FROM comments WHERE id = ?", id).toArray()[0];
    if (!c) throw new HttpError(404, "comment not found");
    if (reason) this.sql.exec("UPDATE comments SET minimized_reason = ?, minimized_by = ?, minimized_at = ? WHERE id = ?", reason, caller.login, now(), id);
    else this.sql.exec("UPDATE comments SET minimized_reason = NULL, minimized_by = NULL, minimized_at = NULL WHERE id = ?", id);
    this.repo.broadcast(`pr:${c.number}`, { action: "comment", id });
    return { number: c.number, reason };
  }

  editComment(id: string, body: string, caller: Caller): void {
    checkText("IssueComment", { body });
    id = this.repo.social.commentKey(id);
    const c = this.sql.exec<{ author_id: string; number: number | null }>("SELECT author_id, number FROM comments WHERE id = ?", id).toArray()[0];
    if (!c) throw new HttpError(404, "comment not found");
    if (c.author_id !== caller.id && !atLeast(caller.role, "maintain")) throw new HttpError(403, "permission denied");
    if (!atLeast(caller.role, "maintain")) {
      // Its author edits it only while they may still comment: not blocked, and the conversation not locked.
      refuseBlocked(caller);
      if (c.number != null && this.row(c.number).locked && !atLeast(caller.role, "triage")) throw new HttpError(403, "conversation is locked");
    }
    this.sql.exec("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?", body, now(), id);
  }

  labels(): Array<{ name: string; color: string; description: string }> {
    return this.sql.exec<{ name: string; color: string; description: string }>("SELECT * FROM labels ORDER BY name").toArray();
  }

  setLabel(name: string, color: string | null, description = ""): void {
    if (color === null) this.sql.exec("DELETE FROM labels WHERE name = ?", name);
    else this.sql.exec("INSERT OR REPLACE INTO labels (name, color, description) VALUES (?, ?, ?)", name, color.replace(/^#/, ""), description);
  }

  // ---------------------------------------------------------------- pull requests

  /**
   * `autoMerge`: what the opener asked for (the API's `auto_merge`): false keeps auto-merge off, true turns it on.
   * Left out, a branch rule or the opener's own setting may turn it on (auto-merge.ts opened). When they asked
   * and it stayed off, `autoMergeSkipped` says why.
   */
  async createPull(input: { title: string; body?: string; head: string; base?: string; draft?: boolean; intent?: string; reviewers?: string[]; autoMerge?: boolean }, caller: Caller): Promise<Issue & { autoMergeSkipped?: string }> {
    refuseBlocked(caller);
    this.repo.policy.assertMayCreateOrApprove(caller, "create");
    checkText("PullRequest", input);
    const base = input.base ?? this.repo.meta.defaultBranch;
    if (input.head === base) throw new HttpError(422, "head and base must be different branches");
    const headSha = this.repo.getRef(`refs/heads/${input.head}`);
    const baseSha = this.repo.getRef(`refs/heads/${base}`);
    if (!headSha) throw new HttpError(422, `head branch '${input.head}' does not exist`);
    if (!baseSha) throw new HttpError(422, `base branch '${base}' does not exist`);
    if (await isAncestor(this.repo.store, headSha, baseSha)) throw new HttpError(422, `no commits between ${base} and ${input.head}`);
    const dup = this.sql.exec<{ number: number }>("SELECT p.number FROM pulls p JOIN issues i ON i.number = p.number WHERE p.head_ref = ? AND p.base_ref = ? AND i.state = 'open'", input.head, base).toArray()[0];
    if (dup) throw new HttpError(422, `a pull request already exists for ${input.head}: #${dup.number}`, { number: dup.number });
    if (!input.title?.trim()) throw new HttpError(422, "title is required");
    const n = this.nextNumber();
    const t = now();
    this.sql.exec(
      "INSERT INTO issues (number, kind, title, body, author_id, author_login, author_kind, created_at, updated_at) VALUES (?, 'pull', ?, ?, ?, ?, ?, ?, ?)",
      n,
      input.title.trim(),
      input.body ?? "",
      caller.id,
      caller.login,
      caller.kind,
      t,
      t,
    );
    this.sql.exec(
      "INSERT INTO pulls (number, head_ref, head_sha, base_ref, draft, requested_reviewers, intent) VALUES (?, ?, ?, ?, ?, ?, ?)",
      n,
      input.head,
      headSha,
      base,
      input.draft ? 1 : 0,
      JSON.stringify(input.reviewers ?? []),
      input.intent ?? null,
    );
    const m = this.repo.meta;
    this.repo.emit({ type: "pull_request", action: "opened", repoId: m.repoId, owner: m.owner, repo: m.name, number: n, headRef: input.head, headSha, baseRef: base, actor: actorOf(caller), at: t });
    await this.repo.actions.onPullRequest("opened", n, caller).catch((e) => console.error("pr workflow trigger", e));
    // A branch rule, or the opener's own setting, may turn auto-merge on (auto-merge.ts opened). A draft waits until it's ready.
    let skipped: string | null = input.draft && input.autoMerge === true ? "the pull request is a draft; auto-merge can turn on once it is marked ready" : null;
    if (!input.draft) {
      try {
        skipped = await this.repo.autoMerge.opened(n, caller, typeof input.autoMerge === "boolean" ? input.autoMerge : undefined);
      } catch (e) {
        console.error("auto-merge on open", e);
      }
    }
    const issue = this.toIssue(this.row(n));
    return skipped && input.autoMerge === true ? { ...issue, autoMergeSkipped: skipped } : issue;
  }

  /**
   * Keep `refs/pull/<n>/head` on the pull request's head and `refs/pull/<n>/merge` on a
   * test merge commit of the head into the current base, like GitHub. The merge ref is
   * removed while the two conflict. Returns the base and merge commits.
   */
  async refreshPullRefs(number: number): Promise<{ baseSha: string | null; mergeSha: string | null }> {
    const p = this.pullRow(number);
    const headRef = `refs/pull/${number}/head`;
    const mergeRef = `refs/pull/${number}/merge`;
    if (this.repo.getRef(headRef) !== p.head_sha) this.repo.casRef(headRef, null, p.head_sha);
    const baseSha = this.repo.getRef(`refs/heads/${p.base_ref}`);
    const current = this.repo.getRef(mergeRef);
    if (!baseSha) return { baseSha: null, mergeSha: current };
    const store = this.repo.store;
    if (current) {
      const c = await readCommit(store, current).catch(() => null);
      if (c && c.parents.length === 2 && c.parents[0] === baseSha && c.parents[1] === p.head_sha) return { baseSha, mergeSha: current };
    }
    const mb = await mergeBase(store, baseSha, p.head_sha);
    const [bt, ht, mt] = await Promise.all([readCommit(store, baseSha), readCommit(store, p.head_sha), mb ? readCommit(store, mb) : null]);
    const merged = await mergeTrees(store, mt?.tree ?? null, bt.tree, ht.tree);
    if (merged.conflicts.length || !merged.tree) {
      if (current) this.repo.casRef(mergeRef, null, null);
      return { baseSha, mergeSha: null };
    }
    const sig = { name: "Diffinery", email: `noreply@${noreplyHost(this.env.PUBLIC_URL)}`, timestamp: Math.floor(Date.now() / 1000), timezone: "+0000" };
    const sha = await store.write("commit", serializeCommit({ tree: merged.tree, parents: [baseSha, p.head_sha], author: sig, committer: sig, message: `Merge ${p.head_sha} into ${baseSha}\n` }));
    this.repo.casRef(mergeRef, null, sha);
    return { baseSha, mergeSha: sha };
  }

  requestReviewers(number: number, reviewers: string[], caller: Caller): void {
    if (!atLeast(caller.role, "triage") && this.row(number).author_id !== caller.id) throw new HttpError(403, "permission denied");
    const p = this.pullRow(number);
    const set = new Set<string>([...JSON.parse(p.requested_reviewers), ...reviewers]);
    this.sql.exec("UPDATE pulls SET requested_reviewers = ? WHERE number = ?", JSON.stringify([...set]), number);
    const before = new Set((JSON.parse(p.requested_reviewers) as string[]).map((x) => x.toLowerCase()));
    const added = [...new Set(reviewers)].filter((x) => !before.has(x.toLowerCase()));
    if (added.length) {
      const m = this.repo.meta;
      this.repo.emit({ type: "pull_request", action: "review_requested", repoId: m.repoId, owner: m.owner, repo: m.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: actorOf(caller), at: now(), reviewers: added });
    }
    for (const l of added) this.repo.social.record(number, "review_requested", caller, { requested_reviewer: l });
  }

  /** Called after a branch moves: refresh open pull requests whose head is that branch. */
  async syncPullsForBranch(branch: string, sha: string, caller: Caller): Promise<number[]> {
    const rows = this.sql.exec<PullRow>("SELECT p.* FROM pulls p JOIN issues i ON i.number = p.number WHERE p.head_ref = ? AND i.state = 'open'", branch).toArray();
    const m = this.repo.meta;
    const out: number[] = [];
    for (const p of rows) {
      if (p.head_sha === sha) continue;
      this.sql.exec("UPDATE pulls SET head_sha = ? WHERE number = ?", sha, p.number);
      this.sql.exec("UPDATE issues SET updated_at = ? WHERE number = ?", now(), p.number);
      const prefs = this.repo.protectionFor(p.base_ref);
      if (prefs?.dismissStaleReviews) this.sql.exec("UPDATE reviews SET state = 'DISMISSED' WHERE number = ? AND state = 'APPROVED' AND commit_id != ?", p.number, sha);
      this.repo.autoMerge.headPushed(p.number, caller);
      this.repo.emit({ type: "pull_request", action: "synchronize", repoId: m.repoId, owner: m.owner, repo: m.name, number: p.number, headRef: branch, headSha: sha, baseRef: p.base_ref, actor: actorOf(caller), at: now() });
      await this.repo.actions.onPullRequest("synchronize", p.number, caller).catch((e) => console.error("pr workflow trigger", e));
      if (this.repo.queue.isQueued(p.number)) this.repo.queue.schedule(p.base_ref);
      this.repo.autoMerge.schedule({ number: p.number });
      // The agent that opened it pushed again: a branch rule may auto-merge its pull requests (opened before the rule, say).
      if (this.row(p.number).author_id === caller.id) this.repo.background(this.repo.autoMerge.applyRule(p.number, false));
      this.repo.broadcast(`pr:${p.number}`, { action: "synchronize", sha });
      out.push(p.number);
    }
    return out;
  }

  /**
   * The commit a pull request's commits and files are counted from: its base branch, or for a merged
   * one, where the base branch was when it merged (afterwards the base contains the head, and nothing
   * would be left). Pull requests merged before that was kept use their merge commit's first parent.
   */
  private async diffBase(p: PullRow): Promise<string | null> {
    if (p.merged) {
      const store = this.repo.store;
      if (p.merged_base && (await readCommit(store, p.merged_base).catch(() => null))) return p.merged_base;
      if (p.merge_commit && p.merge_commit !== p.head_sha) {
        const parent = (await readCommit(store, p.merge_commit).catch(() => null))?.parents[0];
        if (parent) return parent;
      }
    }
    return this.repo.getRef(`refs/heads/${p.base_ref}`);
  }

  async pullFiles(number: number) {
    const p = this.pullRow(number);
    const baseSha = (await this.diffBase(p)) ?? p.head_sha;
    const mb = await mergeBase(this.repo.store, baseSha, p.head_sha);
    return { mergeBase: mb, headSha: p.head_sha, ...(await this.repo.diff(mb, p.head_sha)) };
  }

  /**
   * Line counts for the pull request's changes (GraphQL's additions, deletions and changedFiles), kept
   * for the base and head they were counted at: clients such as Claude Code ask for them on every poll.
   */
  async pullStats(number: number): Promise<{ additions: number; deletions: number; changedFiles: number }> {
    const p = this.pullRow(number);
    const baseSha = (await this.diffBase(p)) ?? p.head_sha;
    const key = `${number}:${baseSha}:${p.head_sha}`;
    const hit = this.statsCache.get(key);
    if (hit) return hit;
    const mb = await mergeBase(this.repo.store, baseSha, p.head_sha);
    const d = await this.repo.diff(mb, p.head_sha, { patch: false });
    const stats = { additions: d.additions, deletions: d.deletions, changedFiles: d.totalFiles };
    if (this.statsCache.size >= 256) this.statsCache.delete(this.statsCache.keys().next().value!);
    this.statsCache.set(key, stats);
    return stats;
  }
  private statsCache = new Map<string, { additions: number; deletions: number; changedFiles: number }>();

  /**
   * GitHub's reviewDecision and the base branch's required checks, counted as mergeability() counts
   * approvals but without its merge: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when no
   * review is needed and nobody has reviewed.
   */
  reviewState(number: number): { decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null; requiredChecks: string[]; protection: { requiredApprovals: number; linearHistory: boolean } | null } {
    const r = this.row(number);
    const p = this.pullRow(number);
    const rules = this.repo.protectionFor(p.base_ref) ?? {};
    let required = rules.requiredApprovals ?? 0;
    if (r.author_kind === "agent" && required < 1) required = 1;
    const latest = new Map<string, Review>();
    for (const rv of this.reviews(number)) if (rv.state !== "COMMENTED" && rv.author.kind !== "github" && !rv.imported) latest.set(rv.author.id, rv);
    let approvals = 0;
    let changes = false;
    for (const rv of latest.values()) {
      if (rv.state === "APPROVED" && rv.author.kind === "user" && (!rules.dismissStaleReviews || rv.commitId === p.head_sha)) approvals++;
      if (rv.state === "CHANGES_REQUESTED") changes = true;
    }
    const decision = changes ? "CHANGES_REQUESTED" : approvals > 0 && approvals >= required ? "APPROVED" : required > 0 ? "REVIEW_REQUIRED" : null;
    const protectedBase = this.repo.protectionFor(p.base_ref) !== null;
    return { decision, requiredChecks: rules.requiredChecks ?? [], protection: protectedBase ? { requiredApprovals: rules.requiredApprovals ?? 0, linearHistory: !!rules.requireLinearHistory } : null };
  }

  /** The first workflow file the pull request adds, changes or deletes, compared with where it branched off its base. */
  async changedWorkflow(number: number): Promise<string | null> {
    const p = this.pullRow(number);
    const baseSha = this.repo.getRef(`refs/heads/${p.base_ref}`);
    const mb = baseSha ? await mergeBase(this.repo.store, baseSha, p.head_sha) : null;
    return this.repo.policy.changedWorkflow(mb ?? ZERO_OID, p.head_sha);
  }

  async pullCommits(number: number) {
    const p = this.pullRow(number);
    const baseSha = await this.diffBase(p);
    const mb = baseSha ? await mergeBase(this.repo.store, baseSha, p.head_sha) : null;
    const stop = new Set<string>();
    if (mb) for (const c of await walkCommits(this.repo.store, [mb], { limit: 100000 })) stop.add(c.oid);
    return (await walkCommits(this.repo.store, [p.head_sha], { stop, limit: 250 })).map((c) => toInfo(c.oid, c.commit)).reverse();
  }

  submitReview(
    number: number,
    input: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string; comments?: Array<{ path: string; line: number; side?: "LEFT" | "RIGHT"; body: string; inReplyTo?: string }> },
    caller: Caller,
  ): Review {
    refuseBlocked(caller);
    checkText("PullRequestReview", input);
    for (const c of input.comments ?? []) checkText("PullRequestReviewComment", c);
    const r = this.row(number);
    const p = this.pullRow(number);
    if (r.state !== "open") throw new HttpError(422, "pull request is closed");
    if (r.locked && !atLeast(caller.role, "triage")) throw new HttpError(403, "conversation is locked");
    if (input.event !== "COMMENT" && r.author_id === caller.id) throw new HttpError(422, "you cannot approve or request changes on your own pull request");
    if (input.event !== "COMMENT" && !atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to approve or request changes");
    // A workflow's GITHUB_TOKEN approves (or blocks) only where the repository allows it, as on GitHub.
    if (input.event !== "COMMENT") this.repo.policy.assertMayCreateOrApprove(caller, "approve");
    if (input.event === "COMMENT" && !input.body?.trim() && !input.comments?.length) throw new HttpError(422, "a comment review needs a body or line comments");
    const id = newId();
    const t = now();
    const state = input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
    this.sql.exec(
      "INSERT INTO reviews (id, number, author_id, author_login, author_kind, state, body, commit_id, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      number,
      caller.id,
      caller.login,
      caller.kind,
      state,
      input.body ?? "",
      p.head_sha,
      t,
    );
    for (const c of input.comments ?? []) {
      this.sql.exec(
        "INSERT INTO comments (id, number, author_id, author_login, author_kind, body, created_at, updated_at, review_id, path, line, side, commit_id, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        newId(),
        number,
        caller.id,
        caller.login,
        caller.kind,
        c.body,
        t,
        t,
        id,
        c.path,
        c.line,
        c.side ?? "RIGHT",
        p.head_sha,
        c.inReplyTo ?? null,
      );
    }
    const reviewers = (JSON.parse(p.requested_reviewers) as string[]).filter((x) => x.toLowerCase() !== caller.login.toLowerCase());
    this.sql.exec("UPDATE pulls SET requested_reviewers = ? WHERE number = ?", JSON.stringify(reviewers), number);
    this.sql.exec("UPDATE issues SET updated_at = ? WHERE number = ?", t, number);
    const m = this.repo.meta;
    this.repo.emit({ type: "pull_request_review", action: "submitted", repoId: m.repoId, owner: m.owner, repo: m.name, number, state, actor: actorOf(caller), at: t });
    this.repo.broadcast(`pr:${number}`, { action: "review", state });
    this.repo.autoMerge.schedule({ number });
    return this.reviews(number).find((x) => x.id === id)!;
  }

  resolveThread(commentId: string, resolved: boolean, caller: Caller): void {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "permission denied");
    this.sql.exec("UPDATE comments SET resolved = ? WHERE id = ? OR in_reply_to = ?", resolved ? 1 : 0, commentId, commentId);
  }

  // ---------------------------------------------------------------- checks

  checks(sha: string): Check[] {
    return this.sql
      .exec<Record<string, string | null>>("SELECT * FROM checks WHERE sha = ? ORDER BY name", sha)
      .toArray()
      .map((c) => ({
        id: c.id!,
        sha: c.sha!,
        name: c.name!,
        status: c.status as Check["status"],
        conclusion: c.conclusion ?? null,
        runId: c.run_id ?? null,
        jobId: c.job_id ?? null,
        detailsUrl: c.details_url ?? null,
        output: c.output ? JSON.parse(c.output) : null,
        app: c.app!,
        startedAt: c.started_at ?? null,
        completedAt: c.completed_at ?? null,
        creatorId: c.creator_id ?? null,
        creatorLogin: c.creator_login ?? null,
        creatorKind: c.creator_kind ?? null,
        seq: c.seq === null || c.seq === undefined ? null : Number(c.seq),
      }));
  }

  /** Create or update a check run, keyed by (sha, name, app). */
  upsertCheck(input: { sha: string; name: string; status: Check["status"]; conclusion?: string | null; runId?: string; jobId?: string; detailsUrl?: string; output?: Check["output"]; app?: string; creator?: { id: string; login: string; kind: string } }): Check {
    const app = input.app ?? "diffinery-actions";
    const existing = this.sql.exec<{ id: string; started_at: string | null; seq: number | null }>("SELECT id, started_at, seq FROM checks WHERE sha = ? AND name = ? AND app = ?", input.sha, input.name, app).toArray()[0];
    const t = now();
    const id = existing?.id ?? newId();
    const seq = existing?.seq ?? this.sql.exec<{ n: number }>("SELECT coalesce(max(seq), 0) + 1 AS n FROM checks").one().n;
    this.sql.exec(
      "INSERT OR REPLACE INTO checks (id, sha, name, status, conclusion, run_id, job_id, details_url, output, app, started_at, completed_at, creator_id, creator_login, creator_kind, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.sha,
      input.name,
      input.status,
      input.conclusion ?? null,
      input.runId ?? null,
      input.jobId ?? null,
      input.detailsUrl ?? null,
      input.output ? JSON.stringify(input.output) : null,
      app,
      existing?.started_at ?? (input.status !== "queued" ? t : null),
      input.status === "completed" ? t : null,
      input.creator?.id ?? null,
      input.creator?.login ?? null,
      input.creator?.kind ?? null,
      seq,
    );
    for (const p of this.sql.exec<{ number: number }>("SELECT number FROM pulls WHERE head_sha = ?", input.sha).toArray()) this.repo.broadcast(`pr:${p.number}`, { action: "checks" });
    if (input.status === "completed") this.checkCompleted(input.sha);
    return this.checks(input.sha).find((c) => c.id === id)!;
  }

  /** A check run or commit status finished on `sha`: a merge group may pass, a pull request may be ready to auto-merge. */
  checkCompleted(sha: string): void {
    const queueBase = this.repo.queue.baseForGroup(sha);
    if (queueBase) this.repo.queue.schedule(queueBase);
    this.repo.autoMerge.schedule({ sha });
  }

  // ---------------------------------------------------------------- merging

  /** Remember what a mergeability check found for this base and head, for Today (agentic/today-repo.ts). Never throws. */
  private recordMergeState(number: number, baseSha: string, headSha: string, state: "clean" | "conflicting" | "in_base"): void {
    try {
      this.sql.exec(
        `INSERT INTO pull_merge_state (number, base_sha, head_sha, state) VALUES (?, ?, ?, ?)
           ON CONFLICT(number) DO UPDATE SET base_sha = excluded.base_sha, head_sha = excluded.head_sha, state = excluded.state
           WHERE base_sha IS NOT excluded.base_sha OR head_sha IS NOT excluded.head_sha OR state IS NOT excluded.state`,
        number,
        baseSha,
        headSha,
        state,
      );
    } catch (e) {
      console.error("recording merge state failed", number, e);
    }
  }

  /**
   * Whether the pull request can merge now, and if not, why. `automatic`: Diffinery itself would
   * land it for `caller` (auto-merge or the merge queue), which an agent may do only where the
   * branch allows it (./auto-merge.ts); every other rule applies all the same.
   */
  async mergeability(number: number, caller?: Caller, opts: { automatic?: boolean } = {}): Promise<Mergeability> {
    const r = this.row(number);
    const p = this.pullRow(number);
    const result: Mergeability = { mergeable: false, state: "unknown", conflicts: [], approvals: 0, requiredApprovals: 0, changesRequested: [], checks: [], blockers: [], mergeBase: null, mergeQueue: null };
    if (p.merged) return { ...result, state: "merged", blockers: ["already merged"] };
    if (r.state === "closed") return { ...result, state: "closed", blockers: ["pull request is closed"] };
    const baseSha = this.repo.getRef(`refs/heads/${p.base_ref}`);
    if (!baseSha) return { ...result, blockers: [`base branch ${p.base_ref} no longer exists`] };
    const mb = await mergeBase(this.repo.store, baseSha, p.head_sha);
    result.mergeBase = mb;
    const [bt, ht, mt] = await Promise.all([readCommit(this.repo.store, baseSha), readCommit(this.repo.store, p.head_sha), mb ? readCommit(this.repo.store, mb) : null]);
    const merged = await mergeTrees(this.repo.store, mt?.tree ?? null, bt.tree, ht.tree);
    result.conflicts = merged.conflicts;
    this.recordMergeState(number, baseSha, p.head_sha, mb === p.head_sha ? "in_base" : merged.conflicts.length ? "conflicting" : "clean");
    const rules = this.repo.protectionFor(p.base_ref) ?? {};
    if (rules.mergeQueue) result.mergeQueue = { method: rules.mergeQueue.method ?? "merge", entry: this.repo.queue.entry(number) };
    result.linearHistory = !!rules.requireLinearHistory;
    result.enforceAdmins = !!rules.enforceAdmins;
    result.requiredChecks = rules.requiredChecks?.length ?? 0;
    result.requiredApprovals = rules.requiredApprovals ?? 0;
    // When Diffinery lands it for an agent (./auto-merge.ts), an approval counts only for the commit it
    // approved: nobody merges by hand to notice that the agent pushed again after a person approved.
    const isDefaultBase = p.base_ref === this.repo.meta.defaultBranch;
    const agentLanding = !!opts.automatic && !!caller && landsByAgentRule(caller, this.repo.protectionFor(p.base_ref), isDefaultBase);
    // An agent merging on its own policy's permission (Agent setup): a person approved its latest commit.
    const byPermission = !!caller && mergesByAgentPermission(caller, this.repo.protectionFor(p.base_ref), isDefaultBase, !!opts.automatic);
    const currentOnly = !!rules.dismissStaleReviews || agentLanding || byPermission;
    const latest = new Map<string, Review>();
    // Imported reviews are history, not votes, whoever authored them; and so are plain comments.
    for (const rv of this.reviews(number)) if (rv.state !== "COMMENTED" && rv.author.kind !== "github" && !rv.imported) latest.set(rv.author.id, rv);
    for (const rv of latest.values()) {
      // Only people's approvals count toward requirements: agents' reviews are advisory, and a
      // workflow's token (kind "system", or "agent" for code an agent wrote) never approves its own way in.
      if (rv.state === "APPROVED" && rv.author.kind === "user" && (!currentOnly || rv.commitId === p.head_sha)) result.approvals++;
      if (rv.state === "CHANGES_REQUESTED") result.changesRequested.push(rv.author.login);
    }
    // Commit statuses count as checks too: a required check matches a status context.
    const checks = [...this.checks(p.head_sha), ...this.repo.statuses.asChecks(p.head_sha)];
    result.checks = checks.map((c) => ({ name: c.name, state: c.status === "completed" ? (c.conclusion ?? "neutral") : c.status }));
    if (agentLanding && !byPermission && rules.agentAutoMergeWithoutApproval) {
      // An admin waived approvals for what Diffinery lands for agents here: green required checks
      // are enough (allowAgentAutoMerge always has some). Requested changes still block it below.
      result.requiredApprovals = 0;
    } else if ((r.author_kind === "agent" || byPermission) && result.requiredApprovals < 1) {
      // Agent-authored changes always need one human approval unless a rule says otherwise, and so does
      // whatever an agent merges on its own permission.
      result.requiredApprovals = 1;
    }
    if (p.draft) result.blockers.push("pull request is a draft");
    if (result.conflicts.length) result.blockers.push(`merge conflicts in ${result.conflicts.length} file(s)`);
    if (result.approvals < result.requiredApprovals) result.blockers.push(`needs ${result.requiredApprovals - result.approvals} more approving review(s)${agentLanding || byPermission ? " of its latest commit" : ""}`);
    if (result.changesRequested.length) result.blockers.push(`changes requested by ${result.changesRequested.join(", ")}`);
    for (const name of rules.requiredChecks ?? []) {
      const c = requiredCheck(name, checks, rules.requiredCheckSources?.[name]);
      if (c.state === "missing") result.blockers.push(`required check '${name}' has not run`);
      else if (c.state === "pending") result.blockers.push(`required check '${name}' is ${c.status}`);
      else if (c.state === "failure") result.blockers.push(`required check '${name}' ${c.conclusion}`);
    }
    if (rules.requireLinearHistory && mb !== baseSha) result.blockers.push("branch is behind its base; update it (linear history required)");
    if (caller) {
      if (!atLeast(caller.role, "write")) result.blockers.push("write access is required to merge");
      const workflowEdit = await this.repo.policy.refuseWorkflowEdit(caller, mb ?? ZERO_OID, p.head_sha);
      if (workflowEdit) result.blockers.push(workflowEdit);
      const isDefault = p.base_ref === this.repo.meta.defaultBranch;
      const protection = this.repo.protectionFor(p.base_ref);
      if (opts.automatic && !isPerson(caller)) {
        // Agents and workflow tokens never merge here themselves; a rule may let Diffinery land it for them.
        const refusal = automaticLandingRefusal(caller, protection, isDefault, p.base_ref);
        if (refusal) result.blockers.push(refusal.message);
        else if (landsByAgentRule(caller, protection, isDefault)) {
          // CI gates what lands, so an agent's change to the workflows that run it needs a person.
          const path = await this.repo.policy.changedWorkflow(mb ?? ZERO_OID, p.head_sha);
          if (path) result.blockers.push(`the pull request changes workflow file \`${path}\`; a person must merge it`);
        }
      } else if (byPermission) {
        const path = await this.repo.policy.changedWorkflow(mb ?? ZERO_OID, p.head_sha);
        if (path) result.blockers.push(`the pull request changes workflow file \`${path}\`; a person must merge it`);
      } else if (caller.kind === "agent" && (isDefault || Object.keys(rules).length) && !rules.agentsMayMerge) result.blockers.push("agents may not merge into this branch; a human must merge");
    }
    result.mergeable = result.blockers.length === 0;
    result.state = p.draft ? "draft" : result.conflicts.length ? "conflicting" : result.mergeable ? "clean" : "blocked";
    return result;
  }

  /** Merge now. `automatic`: auto-merge doing it for `caller` (./auto-merge.ts), which never bypasses anything. */
  async merge(
    number: number,
    input: { method?: "merge" | "squash" | "rebase"; title?: string; message?: string; expectedHeadSha?: string; deleteBranch?: boolean; bypassMergeQueue?: boolean; bypassRules?: boolean },
    caller: Caller,
    opts: { automatic?: boolean } = {},
  ) {
    const p = this.pullRow(number);
    const r = this.row(number);
    // The Worker refuses writes to an archived repository; auto-merge, which runs here by itself, is refused here.
    if (await this.repo.isArchived()) throw new HttpError(403, "repository is archived (read-only)");
    if (input.expectedHeadSha && input.expectedHeadSha !== p.head_sha) throw new HttpError(409, "head branch was modified; review and try again");
    const m = await this.mergeability(number, caller, opts);
    const rules = this.repo.protectionFor(p.base_ref) ?? {};
    // Admins (people, not agents) may bypass unmet rules, but only when they ask to, and never through auto-merge.
    const mayBypass = !opts.automatic && caller.role === "admin" && !rules.enforceAdmins && caller.kind === "user" && m.conflicts.length === 0 && !p.draft;
    // Each bypass covers only what it names: bypass_merge_queue skips the queue, bypass_rules skips unmet rules.
    const bypassQueue = mayBypass && !!input.bypassMergeQueue;
    const adminBypass = mayBypass && !!input.bypassRules;
    if (rules.mergeQueue && !bypassQueue) {
      throw new HttpError(405, `${p.base_ref} requires a merge queue: add the pull request to the queue${mayBypass ? " (or, as an admin, bypass the queue with bypass_merge_queue)" : ""}`, { blockers: [`${p.base_ref} merges through a merge queue`] });
    }
    if (!m.mergeable && !adminBypass) throw new HttpError(405, `pull request is not mergeable: ${m.blockers.join("; ")}${mayBypass ? " (as an admin you can bypass with bypass_rules)" : ""}`, { blockers: m.blockers });
    const baseRef = `refs/heads/${p.base_ref}`;
    const baseSha = this.repo.getRef(baseRef)!;
    const store = this.repo.store;
    const method = input.method ?? (rules.requireLinearHistory ? "squash" : "merge");
    if (method === "merge" && rules.requireLinearHistory && !adminBypass) throw new HttpError(405, `${p.base_ref} requires linear history; use squash or rebase`);
    const linearBypassed = method === "merge" && !!rules.requireLinearHistory;
    const queueBypassed = bypassQueue && !!rules.mergeQueue;
    if ((adminBypass && (!m.mergeable || linearBypassed)) || queueBypassed) {
      const meta = this.repo.meta;
      const blockers = [...(adminBypass ? m.blockers : []), ...(linearBypassed ? ["linear history required"] : []), ...(queueBypassed ? ["merge queue"] : [])];
      this.repo.emit({ type: "audit", action: "pull_request.merge_bypassed", actor: caller, target: `${meta.owner}/${meta.name}#${number}`, detail: { blockers, base: p.base_ref }, at: now() });
    }
    let newSha: string;
    const ts = Math.floor(Date.now() / 1000);
    const sig = { name: caller.login, email: noreplyEmail(this.env.PUBLIC_URL, caller.login), timestamp: ts, timezone: "+0000" };
    if (method === "rebase") {
      if (!(await isAncestor(store, baseSha, p.head_sha))) throw new HttpError(405, "rebase merge requires the branch to be up to date with its base (fast-forward only for now)");
      newSha = p.head_sha;
    } else {
      const [bt, ht, mt] = await Promise.all([readCommit(store, baseSha), readCommit(store, p.head_sha), m.mergeBase ? readCommit(store, m.mergeBase) : null]);
      const merged = await mergeTrees(store, mt?.tree ?? null, bt.tree, ht.tree);
      if (merged.conflicts.length || !merged.tree) throw new HttpError(405, "merge conflicts");
      const title = input.title ?? (method === "squash" ? `${r.title} (#${number})` : `Merge pull request #${number} from ${p.head_ref}`);
      const body = input.message ?? (method === "squash" ? (await this.pullCommits(number)).map((c) => `* ${c.message.split("\n")[0]}`).join("\n") : r.title);
      const author = method === "squash" ? squashSig({ login: r.author_login, kind: r.author_kind }, sig, (login) => noreplyEmail(this.env.PUBLIC_URL, login)) : sig;
      // Like every commit an agent makes, its merge commit says who it acts for.
      const extraHeaders: [string, string][] = caller.kind === "agent" ? [["diffinery-agent", `${caller.login}${caller.onBehalfOf ? ` on-behalf-of ${caller.onBehalfOf}` : ""}`]] : [];
      newSha = await store.write(
        "commit",
        serializeCommit({ tree: merged.tree, parents: method === "squash" ? [baseSha] : [baseSha, p.head_sha], author, committer: sig, message: `${title}\n\n${body}\n`, extraHeaders }),
      );
    }
    if (!this.repo.casRef(baseRef, baseSha, newSha)) throw new HttpError(409, "base branch moved during merge; try again");
    await this.completeMerge(number, newSha, baseSha, caller, !!input.deleteBranch);
    return { merged: true, sha: newSha, method };
  }

  /**
   * Whether landing the pull request may delete its head branch (a merge's `delete_branch`, also kept
   * by auto-merge and the merge queue): only a branch of this repository, never the default branch,
   * and never a protected one, whoever merges and whatever the rule's allowDeletion says.
   */
  headBranchDeletable(number: number): boolean {
    const p = this.pullRow(number);
    return !this.repo.policy.isForkPull(number) && p.head_ref !== this.repo.meta.defaultBranch && !this.repo.protectionFor(p.head_ref);
  }

  /** Record a merge whose commit is already on the base branch (directly or through the merge queue). */
  async completeMerge(number: number, newSha: string, baseSha: string, caller: Caller, deleteBranch: boolean): Promise<void> {
    const p = this.pullRow(number);
    const r = this.row(number);
    const baseRef = `refs/heads/${p.base_ref}`;
    const t = now();
    this.sql.exec("UPDATE pulls SET merged = 1, merged_at = ?, merged_by = ?, merge_commit = ?, merged_base = ?, auto_merge = NULL WHERE number = ?", t, caller.login, newSha, baseSha, number);
    if (this.repo.queue.isQueued(number)) this.repo.queue.schedule(p.base_ref);
    this.sql.exec("UPDATE issues SET state = 'closed', state_reason = 'merged', closed_at = ?, updated_at = ? WHERE number = ?", t, t, number);
    this.repo.social.record(number, "merged", caller, { commit_id: newSha });
    this.repo.social.record(number, "closed", caller, { commit_id: newSha, state_reason: "merged" });
    const meta = this.repo.meta;
    this.repo.emit({ type: "pull_request", action: "merged", repoId: meta.repoId, owner: meta.owner, repo: meta.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: actorOf(caller), at: t });
    // A merge is a push to the base branch from the server's point of view.
    const serverCaller: Caller = { ...caller, role: "admin" };
    await this.repo.afterRefUpdate(baseRef, baseSha, newSha, serverCaller);
    // Close keywords: "fixes #12", "closes #3", "resolves #7".
    for (const match of `${r.title}\n${r.body}`.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
      const n = Number(match[1]);
      try {
        const target = this.row(n);
        if (target.kind === "issue" && target.state === "open") this.update(n, { state: "closed", stateReason: "completed" }, serverCaller);
      } catch {
        /* unknown issue number */
      }
    }
    if (deleteBranch && this.headBranchDeletable(number)) {
      const headRef = `refs/heads/${p.head_ref}`;
      if (this.repo.casRef(headRef, p.head_sha, null)) await this.repo.afterRefUpdate(headRef, p.head_sha, ZERO_OID, serverCaller);
    }
    this.repo.broadcast(`pr:${number}`, { action: "merged", sha: newSha });
    // pull_request workflows with `types: [closed]` (merged ones see github.event.pull_request.merged).
    this.repo.background(this.repo.actions.onPullRequest("closed", number, caller).catch((e) => console.error("pr workflow trigger", e)));
  }

  // ---------------------------------------------------------------- webhooks

  /** The repository's webhooks, without their signing secrets. */
  webhooks(): Webhook[] {
    return this.sql
      .exec<Record<string, string | number | null>>("SELECT id, url, events, active, created_at, last_status, last_delivery_at FROM webhooks ORDER BY created_at")
      .toArray()
      .map((w) => ({
        id: w.id as string,
        url: w.url as string,
        events: JSON.parse(w.events as string),
        active: !!w.active,
        createdAt: w.created_at as string,
        lastStatus: (w.last_status as number) ?? null,
        lastDeliveryAt: (w.last_delivery_at as string) ?? null,
      }));
  }

  /**
   * The active webhooks with their signing secrets, for delivery. Secrets are stored encrypted; a hook
   * saved before that (secret_encrypted = 0) is still signed with its plaintext secret, which is
   * encrypted in place here so it doesn't stay in the clear. One sealed with MASTER_KEY_PREV, or in the
   * older v1 envelope, is sealed again with the current MASTER_KEY the same way.
   */
  async deliverableWebhooks(): Promise<Array<Webhook & { secret: string }>> {
    const rows = new Map(
      this.sql
        .exec<{ id: string; secret: string; secret_encrypted: number }>("SELECT id, secret, secret_encrypted FROM webhooks WHERE active = 1")
        .toArray()
        .map((r) => [r.id, r]),
    );
    const out: Array<Webhook & { secret: string }> = [];
    for (const h of this.webhooks()) {
      const r = rows.get(h.id);
      if (!r) continue;
      if (r.secret_encrypted) {
        // A secret that doesn't decrypt (a changed MASTER_KEY, a damaged row) leaves that one hook undelivered, not every hook.
        const opened = await openSecret(this.env, this.hookScope(h.id), r.secret).catch((e: Error) => void console.error("webhook secret unreadable", h.id, e.message));
        if (!opened) continue;
        if (!opened.current) {
          // Only if the row still holds the envelope read above; a failure here leaves it for the next delivery.
          await encryptSecret(this.env, this.hookScope(h.id), opened.plaintext)
            .then((sealed) => void this.sql.exec("UPDATE webhooks SET secret = ? WHERE id = ? AND secret_encrypted = 1 AND secret = ?", sealed, h.id, r.secret))
            .catch((e: Error) => console.error("webhook secret not sealed again", h.id, e.message));
        }
        out.push({ ...h, secret: opened.plaintext });
        continue;
      }
      const sealed = await encryptSecret(this.env, this.hookScope(h.id), r.secret);
      // Only if the row is still the plaintext read above (no concurrent re-encryption or delete).
      this.sql.exec("UPDATE webhooks SET secret = ?, secret_encrypted = 1 WHERE id = ? AND secret_encrypted = 0 AND secret = ?", sealed, h.id, r.secret);
      out.push({ ...h, secret: r.secret });
    }
    return out;
  }

  /** Each hook's secret gets its own key, so a ciphertext can't be moved to another hook or into the repository's Actions secrets. */
  private hookScope(id: string): string {
    return `repo:${this.repo.meta.repoId}:webhook:${id}`;
  }

  async createWebhook(url: string, events: string[], secret: string | undefined, ownHost: string): Promise<{ id: string; secret: string }> {
    // HTTPS to a public host other than Diffinery's own, at most 20 per repository (as on GitHub), so a
    // repository can't aim deliveries at internal addresses or multiply every event into a flood.
    checkPublicUrl(url, false, "webhook URL", ownHost);
    const count = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM webhooks").one().n;
    if (count >= MAX_WEBHOOKS) throw new HttpError(422, `a repository can have at most ${MAX_WEBHOOKS} webhooks`);
    const id = newId();
    const s = secret ?? randomToken(24);
    const sealed = await encryptSecret(this.env, this.hookScope(id), s).catch((e: Error) => {
      throw new HttpError(422, `could not store the webhook secret: ${e.message || "encryption unavailable"} (is MASTER_KEY configured?)`);
    });
    // Counted again after the await, so concurrent creates can't pass the limit together.
    if (this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM webhooks").one().n >= MAX_WEBHOOKS) throw new HttpError(422, `a repository can have at most ${MAX_WEBHOOKS} webhooks`);
    this.sql.exec("INSERT INTO webhooks (id, url, secret, secret_encrypted, events, created_at) VALUES (?, ?, ?, 1, ?, ?)", id, url, sealed, JSON.stringify(events.length ? events : ["*"]), now());
    return { id, secret: s };
  }

  deleteWebhook(id: string): void {
    this.sql.exec("DELETE FROM webhooks WHERE id = ?", id);
  }

  recordDelivery(id: string, status: number): void {
    this.sql.exec("UPDATE webhooks SET last_status = ?, last_delivery_at = ? WHERE id = ?", status, now(), id);
  }
}
