import { isAncestor, mergeBase, mergeTrees, readCommit, serializeCommit } from "@diffinery/git-core";
import { HttpError, checkText, now } from "../lib/util.js";
import type { Comment, IssueRow, Review } from "./collab.js";
import type { RepoDO } from "./RepoDO.js";
import { atLeast, refuseBlocked, type Caller } from "./types.js";

export const REACTION_CONTENT = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];

export type Person = { id: string; login: string; kind: string };
export type Reaction = { id: number; content: string; user: Person; createdAt: string };
/** `detail` is JSON text: what the event is about (label, assignee, rename, lock reason, ...). */
export type IssueEvent = { id: number; number: number; event: string; actor: Person; detail: string; createdAt: string };
export type LabelRow = { id: number; name: string; color: string; description: string };
export type TimelineItem =
  | ({ kind: "event" } & IssueEvent)
  | { kind: "comment"; comment: Comment; createdAt: string }
  | { kind: "review"; review: Review; createdAt: string };

type CommentRow = {
  id: string;
  number: number;
  author_id: string;
  author_login: string;
  author_kind: string;
  body: string;
  created_at: string;
  updated_at: string;
  review_id: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  commit_id: string | null;
  in_reply_to: string | null;
  resolved: number;
  seq: number;
  review_seq: number | null;
  reply_seq: number | null;
  minimized_reason: string | null;
  minimized_by: string | null;
  minimized_at: string | null;
};

/**
 * Comment columns plus the numeric ids GitHub clients expect (row ids of the
 * comment, its review and the comment it replies to). Use with `comments c`.
 */
export const COMMENT_SELECT = "c.rowid AS seq, (SELECT r.rowid FROM reviews r WHERE r.id = c.review_id) AS review_seq, (SELECT p.rowid FROM comments p WHERE p.id = c.in_reply_to) AS reply_seq, c.*";

const toComment = (c: CommentRow): Comment => ({
  id: c.id,
  author: { id: c.author_id, login: c.author_login, kind: c.author_kind },
  body: c.body,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  reviewId: c.review_id,
  path: c.path,
  line: c.line,
  side: c.side,
  commitId: c.commit_id,
  inReplyTo: c.in_reply_to,
  resolved: !!c.resolved,
  seq: c.seq,
  reviewSeq: c.review_seq,
  inReplyToSeq: c.reply_seq,
  minimized: c.minimized_reason ? { reason: c.minimized_reason, by: c.minimized_by ?? "", at: c.minimized_at ?? "" } : null,
});

const LABEL_COLOR = /^[0-9a-fA-F]{6}$/;

/**
 * The issue and pull request sub-resources bots use: labels and assignees on
 * one issue, locking, reactions, issue events and timelines, single comments,
 * review comment replies, dismissing reviews and updating a PR branch.
 */
export class Social {
  constructor(private repo: RepoDO) {}

  private get sql() {
    return this.repo.sql;
  }

  private issueRow(number: number): IssueRow {
    const r = this.sql.exec<IssueRow>("SELECT * FROM issues WHERE number = ?", number).toArray()[0];
    if (!r) throw new HttpError(404, `#${number} not found`);
    return r;
  }

  private triage(caller: Caller): void {
    if (!atLeast(caller.role, "triage")) throw new HttpError(403, "triage access is required");
  }

  // ---------------------------------------------------------------- issue events

  record(number: number, event: string, actor: Pick<Caller, "id" | "login" | "kind">, detail: Record<string, unknown> = {}): void {
    this.sql.exec("INSERT INTO issue_events (number, event, actor_id, actor_login, actor_kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", number, event, actor.id, actor.login, actor.kind, JSON.stringify(detail), now());
  }

  /** Called by Collab.update: turn a patch into labeled/unlabeled/assigned/... events. */
  recordUpdate(before: IssueRow, patch: { title?: string; state?: string; stateReason?: string; labels?: string[]; assignees?: string[] }, caller: Pick<Caller, "id" | "login" | "kind">): void {
    if (patch.labels) {
      const old = new Set(JSON.parse(before.labels) as string[]);
      const next = new Set(patch.labels);
      const colors = new Map(this.labelRows().map((l) => [l.name, l.color]));
      for (const l of next) if (!old.has(l)) this.record(before.number, "labeled", caller, { label: { name: l, color: colors.get(l) ?? "ededed" } });
      for (const l of old) if (!next.has(l)) this.record(before.number, "unlabeled", caller, { label: { name: l, color: colors.get(l) ?? "ededed" } });
    }
    if (patch.assignees) {
      const old = new Set(JSON.parse(before.assignees) as string[]);
      const next = new Set(patch.assignees);
      for (const a of next) if (!old.has(a)) this.record(before.number, "assigned", caller, { assignee: a });
      for (const a of old) if (!next.has(a)) this.record(before.number, "unassigned", caller, { assignee: a });
    }
    if (patch.title !== undefined && patch.title !== before.title) this.record(before.number, "renamed", caller, { rename: { from: before.title, to: patch.title } });
    if (patch.state && patch.state !== before.state) this.record(before.number, patch.state === "closed" ? "closed" : "reopened", caller, patch.state === "closed" ? { state_reason: patch.stateReason ?? "completed" } : {});
  }

  events(number: number): IssueEvent[] {
    this.issueRow(number);
    return this.sql.exec<Record<string, string | number>>("SELECT * FROM issue_events WHERE number = ? ORDER BY id", number).toArray().map(toEvent);
  }

  repoEvents(limit: number, offset: number): { items: IssueEvent[]; total: number } {
    const total = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM issue_events").one().n;
    return { items: this.sql.exec<Record<string, string | number>>("SELECT * FROM issue_events ORDER BY id DESC LIMIT ? OFFSET ?", Math.min(limit, 100), offset).toArray().map(toEvent), total };
  }

  event(id: number): IssueEvent {
    const r = this.sql.exec<Record<string, string | number>>("SELECT * FROM issue_events WHERE id = ?", id).toArray()[0];
    if (!r) throw new HttpError(404, "event not found");
    return toEvent(r);
  }

  /** Comments, reviews and events of an issue in time order (GitHub's timeline, basic). */
  timeline(number: number, hide?: string[]): TimelineItem[] {
    const { comments, reviews } = this.repo.collab.get(number, hide);
    const items: TimelineItem[] = [
      ...this.events(number).map((e) => ({ kind: "event" as const, ...e })),
      ...comments.filter((c) => !c.reviewId).map((c) => ({ kind: "comment" as const, comment: c, createdAt: c.createdAt })),
      ...reviews.map((r) => ({ kind: "review" as const, review: r, createdAt: r.submittedAt })),
    ];
    return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  lockReason(number: number): string | null {
    const e = this.sql.exec<{ detail: string }>("SELECT detail FROM issue_events WHERE number = ? AND event = 'locked' ORDER BY id DESC LIMIT 1", number).toArray()[0];
    return e ? ((JSON.parse(e.detail) as { lock_reason?: string }).lock_reason ?? null) : null;
  }

  // ---------------------------------------------------------------- labels

  labelRows(): LabelRow[] {
    return this.sql.exec<LabelRow>("SELECT rowid AS id, name, color, description FROM labels ORDER BY name").toArray();
  }

  label(name: string): LabelRow {
    const l = this.sql.exec<LabelRow>("SELECT rowid AS id, name, color, description FROM labels WHERE name = ?", name).toArray()[0];
    if (!l) throw new HttpError(404, "label not found");
    return l;
  }

  createLabel(input: { name?: string; color?: string; description?: string }, caller: Caller): LabelRow {
    this.triage(caller);
    const name = (input.name ?? "").trim();
    if (!name || name.length > 100) throw new HttpError(422, "label name must be 1 to 100 characters", { errors: [{ resource: "Label", code: "invalid", field: "name" }] });
    if (this.sql.exec("SELECT 1 FROM labels WHERE name = ?", name).toArray().length) throw new HttpError(422, "a label with this name already exists", { errors: [{ resource: "Label", code: "already_exists", field: "name" }] });
    const color = (input.color ?? "ededed").replace(/^#/, "");
    if (!LABEL_COLOR.test(color)) throw new HttpError(422, "color must be a 6-digit hex code", { errors: [{ resource: "Label", code: "invalid", field: "color" }] });
    this.sql.exec("INSERT INTO labels (name, color, description) VALUES (?, ?, ?)", name, color.toLowerCase(), (input.description ?? "").slice(0, 100));
    return this.label(name);
  }

  updateLabel(name: string, input: { new_name?: string; color?: string; description?: string }, caller: Caller): LabelRow {
    this.triage(caller);
    const old = this.label(name);
    const next = input.new_name?.trim() || old.name;
    const color = (input.color ?? old.color).replace(/^#/, "");
    if (!LABEL_COLOR.test(color)) throw new HttpError(422, "color must be a 6-digit hex code", { errors: [{ resource: "Label", code: "invalid", field: "color" }] });
    if (next !== old.name && this.sql.exec("SELECT 1 FROM labels WHERE name = ?", next).toArray().length) throw new HttpError(422, "a label with this name already exists", { errors: [{ resource: "Label", code: "already_exists", field: "name" }] });
    this.sql.exec("UPDATE labels SET name = ?, color = ?, description = ? WHERE name = ?", next, color.toLowerCase(), input.description ?? old.description, old.name);
    if (next !== old.name) this.renameOnIssues(old.name, next);
    return this.label(next);
  }

  deleteLabel(name: string, caller: Caller): void {
    this.triage(caller);
    this.label(name);
    this.sql.exec("DELETE FROM labels WHERE name = ?", name);
    this.renameOnIssues(name, null);
  }

  private renameOnIssues(from: string, to: string | null): void {
    for (const r of this.sql.exec<{ number: number; labels: string }>("SELECT number, labels FROM issues WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)", from).toArray()) {
      const labels = (JSON.parse(r.labels) as string[]).flatMap((l) => (l === from ? (to ? [to] : []) : [l]));
      this.sql.exec("UPDATE issues SET labels = ? WHERE number = ?", JSON.stringify([...new Set(labels)]), r.number);
    }
  }

  /** Labels on an issue, creating any that don't exist yet (like GitHub). */
  private ensureLabels(names: string[]): string[] {
    const out: string[] = [];
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name) continue;
      if (name.length > 100) throw new HttpError(422, "label names are at most 100 characters");
      if (!this.sql.exec("SELECT 1 FROM labels WHERE name = ?", name).toArray().length) this.sql.exec("INSERT INTO labels (name, color, description) VALUES (?, 'ededed', '')", name);
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  issueLabels(number: number): LabelRow[] {
    const names = JSON.parse(this.issueRow(number).labels) as string[];
    const rows = new Map(this.labelRows().map((l) => [l.name, l]));
    return names.map((n) => rows.get(n) ?? { id: 0, name: n, color: "ededed", description: "" });
  }

  addLabels(number: number, names: string[], caller: Caller): LabelRow[] {
    this.triage(caller);
    const current = JSON.parse(this.issueRow(number).labels) as string[];
    const next = [...new Set([...current, ...this.ensureLabels(names)])];
    if (next.length > 100) throw new HttpError(422, "an issue can have at most 100 labels");
    this.repo.collab.update(number, { labels: next }, caller);
    return this.issueLabels(number);
  }

  setLabels(number: number, names: string[], caller: Caller): LabelRow[] {
    this.triage(caller);
    this.issueRow(number);
    this.repo.collab.update(number, { labels: this.ensureLabels(names) }, caller);
    return this.issueLabels(number);
  }

  removeLabel(number: number, name: string, caller: Caller): LabelRow[] {
    this.triage(caller);
    const current = JSON.parse(this.issueRow(number).labels) as string[];
    if (!current.includes(name)) throw new HttpError(404, "Label does not exist");
    this.repo.collab.update(number, { labels: current.filter((l) => l !== name) }, caller);
    return this.issueLabels(number);
  }

  // ---------------------------------------------------------------- assignees and locking

  assign(number: number, logins: string[], add: boolean, caller: Caller): void {
    this.triage(caller);
    const current = JSON.parse(this.issueRow(number).assignees) as string[];
    const set = new Set(current);
    for (const l of logins.map(String).filter(Boolean)) {
      if (add) set.add(l);
      else for (const x of [...set]) if (x.toLowerCase() === l.toLowerCase()) set.delete(x);
    }
    if (set.size > 10) throw new HttpError(422, "an issue can have at most 10 assignees");
    this.repo.collab.update(number, { assignees: [...set] }, caller);
  }

  lock(number: number, reason: string | null, caller: Caller): void {
    this.triage(caller);
    if (reason && !["off-topic", "too heated", "resolved", "spam"].includes(reason)) throw new HttpError(422, "lock_reason must be off-topic, too heated, resolved or spam");
    this.issueRow(number);
    this.sql.exec("UPDATE issues SET locked = 1, updated_at = ? WHERE number = ?", now(), number);
    this.record(number, "locked", caller, { lock_reason: reason });
  }

  unlock(number: number, caller: Caller): void {
    this.triage(caller);
    this.issueRow(number);
    this.sql.exec("UPDATE issues SET locked = 0, updated_at = ? WHERE number = ?", now(), number);
    this.record(number, "unlocked", caller);
  }

  // ---------------------------------------------------------------- comments

  /** A comment's internal id from either form clients send: GitHub's numeric id or Diffinery's own. */
  commentKey(raw: string): string {
    if (!/^\d{1,15}$/.test(raw)) return raw;
    return this.sql.exec<{ id: string }>("SELECT id FROM comments WHERE rowid = ?", Number(raw)).toArray()[0]?.id ?? raw;
  }

  /** Reaction subjects keep comments under their internal id, whichever id the client used. */
  private subjectKey(subject: string): string {
    const i = subject.indexOf(":");
    const kind = subject.slice(0, i);
    return kind === "comment" || kind === "review_comment" ? `${kind}:${this.commentKey(subject.slice(i + 1))}` : subject;
  }

  private commentRow(id: string, review: boolean): CommentRow {
    const c = this.sql.exec<CommentRow>(`SELECT ${COMMENT_SELECT} FROM comments c WHERE c.id = ? AND c.review_id IS ${review ? "NOT " : ""}NULL`, this.commentKey(id)).toArray()[0];
    if (!c) throw new HttpError(404, "comment not found");
    return c;
  }

  /** One issue comment (or, with `review`, one review comment) and the issue it belongs to. */
  comment(id: string, review = false, hide?: string[]): { number: number; isPull: boolean; comment: Comment } {
    const c = this.commentRow(id, review);
    if (hide?.includes(c.author_id)) throw new HttpError(404, "comment not found");
    return { number: c.number, isPull: this.issueRow(c.number).kind === "pull", comment: toComment(c) };
  }

  deleteComment(id: string, review: boolean, caller: Caller): void {
    const c = this.commentRow(id, review);
    if (c.author_id !== caller.id && !atLeast(caller.role, "maintain")) throw new HttpError(403, "permission denied");
    this.sql.exec("DELETE FROM comments WHERE id = ?", c.id);
    this.sql.exec("DELETE FROM reactions WHERE subject = ?", `${review ? "review_comment" : "comment"}:${c.id}`);
    this.repo.broadcast(`pr:${c.number}`, { action: "comment", id: c.id });
  }

  /** Comments across the repository (issue comments, or review comments with `review`). */
  repoComments(opts: { review: boolean; since?: string; sort?: string; direction?: string; limit: number; offset: number; hide?: string[] }): { items: Array<{ number: number; isPull: boolean; comment: Comment }>; total: number } {
    const where = [`c.review_id IS ${opts.review ? "NOT " : ""}NULL`];
    const args: unknown[] = [];
    if (opts.hide?.length) {
      where.push("c.author_id NOT IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(opts.hide));
    }
    if (opts.since) {
      where.push("c.updated_at >= ?");
      args.push(opts.since);
    }
    const col = opts.sort === "updated" ? "c.updated_at" : "c.created_at";
    const dir = opts.direction === "desc" ? "DESC" : "ASC";
    const w = `WHERE ${where.join(" AND ")}`;
    const total = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM comments c ${w}`, ...args).one().n;
    const rows = this.sql.exec<CommentRow & { kind: string }>(`SELECT ${COMMENT_SELECT}, i.kind FROM comments c JOIN issues i ON i.number = c.number ${w} ORDER BY ${col} ${dir}, c.rowid ${dir} LIMIT ? OFFSET ?`, ...args, Math.min(opts.limit, 100), opts.offset).toArray();
    return { items: rows.map((r) => ({ number: r.number, isPull: r.kind === "pull", comment: toComment(r) })), total };
  }

  /** A single review comment, or a reply to one (`in_reply_to`), as a one-comment COMMENTED review. */
  createReviewComment(number: number, input: { body?: string; commit_id?: string; path?: string; line?: number; position?: number; side?: "LEFT" | "RIGHT"; in_reply_to?: string }, caller: Caller): Comment {
    refuseBlocked(caller);
    if (!input.body?.trim()) throw new HttpError(422, "body is required", { errors: [{ resource: "PullRequestReviewComment", code: "missing_field", field: "body" }] });
    checkText("PullRequestReviewComment", input);
    let path = input.path;
    let line = input.line ?? input.position;
    let side = input.side;
    let replyTo: string | undefined;
    if (input.in_reply_to) {
      const parent = this.commentRow(String(input.in_reply_to), true);
      replyTo = parent.id;
      if (parent.number !== number) throw new HttpError(404, "comment not found");
      path = parent.path ?? undefined;
      line = parent.line ?? undefined;
      side = (parent.side as "LEFT" | "RIGHT" | null) ?? undefined;
    }
    if (!path || !line) throw new HttpError(422, "path and line are required", { errors: [{ resource: "PullRequestReviewComment", code: "missing_field", field: "line" }] });
    const review = this.repo.collab.submitReview(number, { event: "COMMENT", comments: [{ path, line: Number(line), side, body: input.body, inReplyTo: replyTo }] }, caller);
    const row = this.sql.exec<CommentRow>(`SELECT ${COMMENT_SELECT} FROM comments c WHERE c.review_id = ? ORDER BY c.rowid DESC LIMIT 1`, review.id).one();
    return toComment(row);
  }

  // ---------------------------------------------------------------- reviews and reviewers

  /** A review by GitHub's numeric id or Diffinery's own. */
  review(number: number, id: string): Review {
    const r = this.repo.collab.get(number).reviews.find((x) => x.id === id || String(x.seq) === id);
    if (!r) throw new HttpError(404, "review not found");
    return r;
  }

  /** Dismissing a review can unblock a merge, so it takes maintain access, and never the pull request's author or an agent. */
  dismissReview(number: number, id: string, message: string, caller: Caller): Review {
    if (!atLeast(caller.role, "maintain")) throw new HttpError(403, "maintain access is required to dismiss reviews");
    if (caller.kind === "agent") throw new HttpError(403, "agents can't dismiss reviews");
    if (this.issueRow(number).author_id === caller.id) throw new HttpError(403, "you can't dismiss reviews on your own pull request");
    const r = this.review(number, id);
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") throw new HttpError(422, "only approving or change-requesting reviews can be dismissed");
    this.sql.exec("UPDATE reviews SET state = 'DISMISSED' WHERE id = ?", r.id);
    this.record(number, "review_dismissed", caller, { dismissed_review: { state: r.state.toLowerCase(), review_id: r.seq ?? r.id, dismissal_message: message } });
    this.repo.broadcast(`pr:${number}`, { action: "review", state: "DISMISSED" });
    // A dismissed change request may have been the last thing holding back auto-merge.
    this.repo.autoMerge.schedule({ number });
    return this.review(number, r.id);
  }

  removeReviewers(number: number, logins: string[], caller: Caller): void {
    const r = this.issueRow(number);
    if (!atLeast(caller.role, "triage") && r.author_id !== caller.id) throw new HttpError(403, "permission denied");
    const p = this.sql.exec<{ requested_reviewers: string }>("SELECT requested_reviewers FROM pulls WHERE number = ?", number).toArray()[0];
    if (!p) throw new HttpError(404, "pull request not found");
    const drop = new Set(logins.map((l) => String(l).toLowerCase()));
    const left = (JSON.parse(p.requested_reviewers) as string[]).filter((l) => !drop.has(l.toLowerCase()));
    this.sql.exec("UPDATE pulls SET requested_reviewers = ? WHERE number = ?", JSON.stringify(left), number);
    for (const l of logins) this.record(number, "review_request_removed", caller, { requested_reviewer: l });
  }

  /** Merge the base branch into the pull request's head branch (GitHub's "Update branch"). */
  async updateBranch(number: number, expectedHeadSha: string | undefined, caller: Caller): Promise<{ sha: string }> {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to update the branch");
    const p = this.sql.exec<{ head_ref: string; head_sha: string; base_ref: string; merged: number }>("SELECT head_ref, head_sha, base_ref, merged FROM pulls WHERE number = ?", number).toArray()[0];
    if (!p) throw new HttpError(404, "pull request not found");
    if (this.issueRow(number).state !== "open") throw new HttpError(422, "pull request is closed");
    if (expectedHeadSha && expectedHeadSha !== p.head_sha) throw new HttpError(422, "expected head sha didn't match current head ref.");
    const store = this.repo.store;
    const baseSha = this.repo.getRef(`refs/heads/${p.base_ref}`);
    if (!baseSha) throw new HttpError(422, `base branch ${p.base_ref} no longer exists`);
    if (await isAncestor(store, baseSha, p.head_sha)) throw new HttpError(422, "There are no new commits on the base branch.");
    const mb = await mergeBase(store, baseSha, p.head_sha);
    const [bt, ht, mt] = await Promise.all([readCommit(store, baseSha), readCommit(store, p.head_sha), mb ? readCommit(store, mb) : null]);
    const merged = await mergeTrees(store, mt?.tree ?? null, ht.tree, bt.tree);
    if (merged.conflicts.length || !merged.tree) throw new HttpError(422, "merge conflict between base and head");
    const ts = Math.floor(Date.now() / 1000);
    const sig = { name: caller.login, email: this.repo.noreply(caller.login), timestamp: ts, timezone: "+0000" };
    const extra: [string, string][] = caller.kind === "agent" ? [["diffinery-agent", `${caller.login}${caller.onBehalfOf ? ` on-behalf-of ${caller.onBehalfOf}` : ""}`]] : [];
    const sha = await store.write("commit", serializeCommit({ tree: merged.tree, parents: [p.head_sha, baseSha], author: sig, committer: sig, message: `Merge branch '${p.base_ref}' into ${p.head_ref}\n`, extraHeaders: extra }));
    const ref = `refs/heads/${p.head_ref}`;
    const check = await this.repo.checkRefUpdate(ref, p.head_sha, sha, caller);
    if (!check.ok) throw new HttpError(403, check.reason ?? "rejected");
    if (!this.repo.casRef(ref, p.head_sha, sha)) throw new HttpError(409, "head branch moved; try again");
    await this.repo.afterRefUpdate(ref, p.head_sha, sha, caller);
    return { sha };
  }

  /** Pull requests associated with a commit: merged by it or containing it as their head (basic). */
  async pullsForCommit(sha: string): Promise<number[]> {
    const direct = this.sql.exec<{ number: number }>("SELECT number FROM pulls WHERE merge_commit = ? OR head_sha = ? ORDER BY number DESC", sha, sha).toArray().map((r) => r.number);
    const open = this.sql.exec<{ number: number; head_sha: string }>("SELECT p.number, p.head_sha FROM pulls p JOIN issues i ON i.number = p.number WHERE i.state = 'open' ORDER BY p.number DESC LIMIT 50").toArray();
    const out = new Set(direct);
    for (const p of open) if (!out.has(p.number) && this.repo.store.has(sha) && (await isAncestor(this.repo.store, sha, p.head_sha).catch(() => false))) out.add(p.number);
    return [...out];
  }

  // ---------------------------------------------------------------- reactions

  private subjectExists(subject: string): boolean {
    const [kind, id] = [subject.slice(0, subject.indexOf(":")), subject.slice(subject.indexOf(":") + 1)];
    if (kind === "issue") return this.sql.exec("SELECT 1 FROM issues WHERE number = ?", Number(id)).toArray().length > 0;
    if (kind === "comment") return this.sql.exec("SELECT 1 FROM comments WHERE id = ? AND review_id IS NULL", id).toArray().length > 0;
    if (kind === "review_comment") return this.sql.exec("SELECT 1 FROM comments WHERE id = ? AND review_id IS NOT NULL", id).toArray().length > 0;
    if (kind === "release") return this.sql.exec("SELECT 1 FROM releases WHERE id = ?", Number(id)).toArray().length > 0;
    return false;
  }

  reactions(subject: string, content?: string): Reaction[] {
    subject = this.subjectKey(subject);
    if (!this.subjectExists(subject)) throw new HttpError(404, "not found");
    const rows = this.sql
      .exec<Record<string, string | number>>(`SELECT * FROM reactions WHERE subject = ? ${content ? "AND content = ?" : ""} ORDER BY id`, ...(content ? [subject, content] : [subject]))
      .toArray();
    return rows.map((r) => ({ id: r.id as number, content: r.content as string, user: { id: r.user_id as string, login: r.user_login as string, kind: r.user_kind as string }, createdAt: r.created_at as string }));
  }

  /** The issue or pull request a reaction subject belongs to (null for releases). */
  private subjectIssue(subject: string): number | null {
    const [kind, id] = [subject.slice(0, subject.indexOf(":")), subject.slice(subject.indexOf(":") + 1)];
    if (kind === "issue") return Number(id);
    if (kind === "comment" || kind === "review_comment") return this.sql.exec<{ number: number }>("SELECT number FROM comments WHERE id = ?", id).toArray()[0]?.number ?? null;
    return null;
  }

  react(subject: string, content: string, caller: Caller): { reaction: Reaction; created: boolean } {
    subject = this.subjectKey(subject);
    if (caller.id === "anonymous") throw new HttpError(401, "sign in to react");
    refuseBlocked(caller);
    if (!REACTION_CONTENT.includes(content)) throw new HttpError(422, `content must be one of ${REACTION_CONTENT.join(", ")}`, { errors: [{ resource: "Reaction", code: "invalid", field: "content" }] });
    if (!this.subjectExists(subject)) throw new HttpError(404, "not found");
    const number = this.subjectIssue(subject);
    if (number !== null && this.issueRow(number).locked && !atLeast(caller.role, "triage")) throw new HttpError(403, "conversation is locked");
    const existing = this.sql.exec<{ id: number }>("SELECT id FROM reactions WHERE subject = ? AND content = ? AND user_id = ?", subject, content, caller.id).toArray()[0];
    if (!existing) this.sql.exec("INSERT INTO reactions (subject, content, user_id, user_login, user_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)", subject, content, caller.id, caller.login, caller.kind, now());
    const id = existing?.id ?? this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    return { reaction: this.reactions(subject).find((r) => r.id === id)!, created: !existing };
  }

  unreact(subject: string, id: number, caller: Caller): void {
    subject = this.subjectKey(subject);
    const r = this.sql.exec<{ user_id: string }>("SELECT user_id FROM reactions WHERE subject = ? AND id = ?", subject, id).toArray()[0];
    if (!r) throw new HttpError(404, "reaction not found");
    if (r.user_id !== caller.id && !atLeast(caller.role, "admin")) throw new HttpError(403, "you can only delete your own reactions");
    this.sql.exec("DELETE FROM reactions WHERE id = ?", id);
  }

  /** Reaction counts per subject, for embedding in issue, comment and release JSON. */
  reactionCounts(subjects: string[]): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (let i = 0; i < subjects.length; i += 50) {
      const chunk = subjects.slice(i, i + 50);
      const rows = this.sql.exec<{ subject: string; content: string; n: number }>(`SELECT subject, content, count(*) AS n FROM reactions WHERE subject IN (${chunk.map(() => "?").join(",")}) GROUP BY subject, content`, ...chunk).toArray();
      for (const r of rows) (out[r.subject] ??= {})[r.content] = r.n;
    }
    return out;
  }
}

function toEvent(r: Record<string, string | number>): IssueEvent {
  return { id: r.id as number, number: r.number as number, event: r.event as string, actor: { id: r.actor_id as string, login: r.actor_login as string, kind: r.actor_kind as string }, detail: r.detail as string, createdAt: r.created_at as string };
}

