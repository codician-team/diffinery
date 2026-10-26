import type { ImportedComment, ImportedIssue, ImportedMilestone, ImportedReview } from "../imports/mapping.js";
import { HttpError, now } from "../lib/util.js";

/** Refs only a GitHub import writes (pull request heads and chunks in flight); see containers/runner/src/importer.ts. */
export const IMPORT_REF_PREFIX = "refs/diffinery-import/";

export type Milestone = {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  dueOn: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  creator: string | null;
  openIssues: number;
  closedIssues: number;
};

type MilestoneRow = {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  due_on: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  creator: string | null;
};

/**
 * Repository side of GitHub imports, plus milestones. Imported rows keep their
 * GitHub numbers, timestamps and people, and every write is an upsert keyed by
 * the GitHub id, so a retried import step never duplicates anything. Nothing
 * here emits events: an import fires no webhooks, workflows or notifications.
 */
export class RepoImports {
  constructor(private readonly sql: SqlStorage) {}

  // ---------------------------------------------------------------- labels and milestones

  labels(list: Array<{ name: string; color: string; description: string }>, importId: string): number {
    for (const l of list)
      this.sql.exec(
        `INSERT INTO labels (name, color, description, imported) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET color = excluded.color, description = excluded.description, imported = excluded.imported
         WHERE labels.imported = excluded.imported`,
        l.name,
        (l.color || "888888").replace(/^#/, ""),
        l.description ?? "",
        importId,
      );
    return list.length;
  }

  milestones(list: ImportedMilestone[], importId: string): number {
    for (const m of list) {
      this.sql.exec(
        `INSERT INTO milestones (number, title, description, state, due_on, created_at, updated_at, closed_at, creator, imported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET title = excluded.title, description = excluded.description, state = excluded.state,
           due_on = excluded.due_on, created_at = excluded.created_at, updated_at = excluded.updated_at, closed_at = excluded.closed_at,
           creator = excluded.creator, imported = excluded.imported
         WHERE milestones.imported = excluded.imported`,
        m.number,
        m.title,
        m.description,
        m.state,
        m.dueOn,
        m.createdAt,
        m.updatedAt,
        m.closedAt,
        m.creator,
        importId,
      );
    }
    this.raiseCounter("milestone", Math.max(0, ...list.map((m) => m.number)));
    return list.length;
  }

  // ---------------------------------------------------------------- issues and pull requests

  /** Insert issues and pull requests with their original numbers; only overwrites rows this import owns. */
  issues(list: ImportedIssue[], importId: string): number {
    for (const i of list) {
      this.sql.exec(
        `INSERT INTO issues (number, kind, title, body, state, state_reason, author_id, author_login, author_kind, assignees, labels, created_at, updated_at, closed_at, locked, imported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET kind = excluded.kind, title = excluded.title, body = excluded.body, state = excluded.state,
           state_reason = excluded.state_reason, author_id = excluded.author_id, author_login = excluded.author_login, author_kind = excluded.author_kind,
           assignees = excluded.assignees, labels = excluded.labels, created_at = excluded.created_at, updated_at = excluded.updated_at,
           closed_at = excluded.closed_at, locked = excluded.locked, imported = excluded.imported
         WHERE issues.imported = excluded.imported`,
        i.number,
        i.kind,
        i.title,
        i.body,
        i.state,
        i.stateReason,
        i.author.id,
        i.author.login,
        i.author.kind,
        JSON.stringify(i.assignees),
        JSON.stringify(i.labels),
        i.createdAt,
        i.updatedAt,
        i.closedAt,
        i.locked ? 1 : 0,
        importId,
      );
      if (i.pull) {
        const p = i.pull;
        this.sql.exec(
          `INSERT INTO pulls (number, head_ref, head_repo_id, head_sha, base_ref, draft, merged, merged_at, merged_by, merge_commit, merged_base, requested_reviewers, imported)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(number) DO UPDATE SET head_ref = excluded.head_ref, head_repo_id = excluded.head_repo_id, head_sha = excluded.head_sha, base_ref = excluded.base_ref, draft = excluded.draft,
             merged = excluded.merged, merged_at = excluded.merged_at, merged_by = COALESCE(excluded.merged_by, pulls.merged_by),
             merge_commit = excluded.merge_commit, merged_base = excluded.merged_base, requested_reviewers = excluded.requested_reviewers, imported = excluded.imported
           WHERE pulls.imported = excluded.imported`,
          i.number,
          p.headRef,
          // A fork on GitHub: marks the pull request as one whose runs get no write and no secrets.
          p.headRepo ? `github:${p.headRepo}` : null,
          p.headSha,
          p.baseRef,
          p.draft ? 1 : 0,
          p.merged ? 1 : 0,
          p.mergedAt,
          p.mergedBy,
          p.mergeCommit,
          p.baseSha ?? null,
          JSON.stringify(p.requestedReviewers),
          importId,
        );
      }
      if (i.milestone) this.sql.exec("INSERT OR REPLACE INTO issue_milestones (number, milestone) VALUES (?, ?)", i.number, i.milestone);
      else this.sql.exec("DELETE FROM issue_milestones WHERE number = ?", i.number);
    }
    this.raiseCounter("issue", Math.max(0, ...list.map((i) => i.number)));
    return list.length;
  }

  /** GitHub reports who merged a pull request only on the single pull request. */
  setMergedBy(number: number, login: string): void {
    this.sql.exec("UPDATE pulls SET merged_by = ? WHERE number = ? AND merged = 1", login, number);
  }

  /** Pull request numbers after `after`, for the reviews pass. */
  pullNumbers(after: number, limit: number): Array<{ number: number; merged: boolean }> {
    return this.sql
      .exec<{ number: number; merged: number }>("SELECT number, merged FROM pulls WHERE number > ? ORDER BY number LIMIT ?", after, limit)
      .toArray()
      .map((r) => ({ number: r.number, merged: !!r.merged }));
  }

  comments(list: ImportedComment[], importId: string): number {
    let n = 0;
    for (const c of list) {
      if (!this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM issues WHERE number = ?", c.number).one().n) continue;
      // Not INSERT OR REPLACE: that reassigns the rowid, and comment "seq" (the public id) is the rowid.
      this.sql.exec(
        `INSERT INTO comments (id, number, author_id, author_login, author_kind, body, created_at, updated_at, review_id, path, line, side, commit_id, in_reply_to, imported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET number = excluded.number, author_id = excluded.author_id, author_login = excluded.author_login,
           author_kind = excluded.author_kind, body = excluded.body, created_at = excluded.created_at, updated_at = excluded.updated_at,
           review_id = excluded.review_id, path = excluded.path, line = excluded.line, side = excluded.side, commit_id = excluded.commit_id,
           in_reply_to = excluded.in_reply_to, imported = excluded.imported
         WHERE comments.imported = excluded.imported`,
        c.id,
        c.number,
        c.author.id,
        c.author.login,
        c.author.kind,
        c.body,
        c.createdAt,
        c.updatedAt,
        c.reviewId ?? null,
        c.path ?? null,
        c.line ?? null,
        c.side ?? null,
        c.commitId ?? null,
        c.inReplyTo ?? null,
        importId,
      );
      n++;
    }
    return n;
  }

  reviews(list: ImportedReview[], importId: string): number {
    for (const r of list) {
      this.sql.exec(
        `INSERT INTO reviews (id, number, author_id, author_login, author_kind, state, body, commit_id, submitted_at, imported)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET number = excluded.number, author_id = excluded.author_id, author_login = excluded.author_login,
           author_kind = excluded.author_kind, state = excluded.state, body = excluded.body, commit_id = excluded.commit_id,
           submitted_at = excluded.submitted_at, imported = excluded.imported
         WHERE reviews.imported = excluded.imported`,
        r.id,
        r.number,
        r.author.id,
        r.author.login,
        r.author.kind,
        r.state,
        r.body,
        r.commitId,
        r.submittedAt,
        importId,
      );
    }
    return list.length;
  }

  /** New issues continue after the highest imported number. */
  private raiseCounter(name: string, value: number): void {
    if (value > 0) this.sql.exec("INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = max(value, excluded.value)", name, value);
  }

  counts(): { issues: number; pulls: number; comments: number; reviews: number; labels: number; milestones: number; maxNumber: number } {
    const q = (s: string) => this.sql.exec<{ n: number }>(s).one().n;
    return {
      issues: q("SELECT count(*) AS n FROM issues WHERE kind = 'issue'"),
      pulls: q("SELECT count(*) AS n FROM issues WHERE kind = 'pull'"),
      comments: q("SELECT count(*) AS n FROM comments"),
      reviews: q("SELECT count(*) AS n FROM reviews"),
      labels: q("SELECT count(*) AS n FROM labels"),
      milestones: q("SELECT count(*) AS n FROM milestones"),
      maxNumber: q("SELECT COALESCE(max(number), 0) AS n FROM issues"),
    };
  }

  // ---------------------------------------------------------------- push protection findings

  /** Secrets an import pushed with an admin bypass, so the summary can list what to rotate. */
  recordFindings(leaks: Array<{ oid: string; kind: string }>): void {
    for (const l of leaks.slice(0, 500)) this.sql.exec("INSERT OR IGNORE INTO import_findings (blob, kind, at) VALUES (?, ?, ?)", l.oid, l.kind, now());
  }

  findings(): Array<{ blob: string; kind: string; at: string }> {
    return this.sql.exec<{ blob: string; kind: string; at: string }>("SELECT blob, kind, at FROM import_findings ORDER BY at, blob").toArray();
  }

  /** Imported pull requests and the head commit each one pins. */
  pullHeads(): Array<{ number: number; headSha: string }> {
    return this.sql.exec<{ number: number; head_sha: string }>("SELECT number, head_sha FROM pulls ORDER BY number").toArray().map((r) => ({ number: r.number, headSha: r.head_sha }));
  }

  // ---------------------------------------------------------------- import lock and provenance (H2)

  /**
   * True when the repository already holds any issue, pull request, comment, review, label,
   * milestone, protection or release that this import did not write. A retry refuses to reuse a repo
   * that people have since adopted, so an import never clobbers real content.
   */
  hasForeignContent(importId: string): boolean {
    const tables = ["issues", "pulls", "comments", "reviews", "labels", "milestones", "protections", "releases"];
    for (const t of tables) {
      const n = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t} WHERE imported IS NULL OR imported <> ?`, importId).one().n;
      if (n > 0) return true;
    }
    // A milestone assignment or issue-milestone link is content too; covered by issues/milestones above.
    return false;
  }

  /** Record that this import set `ref` to `oid` (so a later update may move only refs it owns). */
  recordImportRef(ref: string, oid: string, importId: string): void {
    this.sql.exec("INSERT INTO import_refs (ref, oid, import_id) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET oid = excluded.oid, import_id = excluded.import_id", ref, oid, importId);
  }

  /** The oid this import last wrote to `ref`, or null if the import never wrote it. */
  importRefOid(ref: string, importId: string): string | null {
    const r = this.sql.exec<{ oid: string }>("SELECT oid FROM import_refs WHERE ref = ? AND import_id = ?", ref, importId).toArray()[0];
    return r ? r.oid : null;
  }

  dropImportRefs(importId: string): void {
    this.sql.exec("DELETE FROM import_refs WHERE import_id = ?", importId);
  }

  /** Write imported branch protection, only overwriting a rule this import owns. */
  protection(pattern: string, rules: string, importId: string): void {
    this.sql.exec(
      `INSERT INTO protections (pattern, rules, imported) VALUES (?, ?, ?)
       ON CONFLICT(pattern) DO UPDATE SET rules = excluded.rules, imported = excluded.imported
       WHERE protections.imported = excluded.imported`,
      pattern,
      rules,
      importId,
    );
  }

  // ---------------------------------------------------------------- organization variables

  /** Replace the copy of the owning organization's Actions variables. */
  setOrgVariables(vars: Record<string, string>): void {
    this.sql.exec("DELETE FROM org_variables");
    for (const [name, value] of Object.entries(vars)) this.sql.exec("INSERT INTO org_variables (name, value) VALUES (?, ?)", name, value);
  }

  // ---------------------------------------------------------------- milestones

  private milestoneRow(m: MilestoneRow): Milestone {
    const counts = this.sql
      .exec<{ state: string; n: number }>("SELECT i.state, count(*) AS n FROM issue_milestones x JOIN issues i ON i.number = x.number WHERE x.milestone = ? GROUP BY i.state", m.number)
      .toArray();
    return {
      number: m.number,
      title: m.title,
      description: m.description,
      state: m.state,
      dueOn: m.due_on,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      closedAt: m.closed_at,
      creator: m.creator,
      openIssues: counts.find((c) => c.state === "open")?.n ?? 0,
      closedIssues: counts.find((c) => c.state === "closed")?.n ?? 0,
    };
  }

  listMilestones(state: "open" | "closed" | "all" = "open"): Milestone[] {
    const rows = this.sql
      .exec<MilestoneRow>(`SELECT * FROM milestones ${state === "all" ? "" : "WHERE state = ?"} ORDER BY COALESCE(due_on, '9999'), number`, ...(state === "all" ? [] : [state]))
      .toArray();
    return rows.map((r) => this.milestoneRow(r));
  }

  milestone(number: number): Milestone {
    const r = this.sql.exec<MilestoneRow>("SELECT * FROM milestones WHERE number = ?", number).toArray()[0];
    if (!r) throw new HttpError(404, "milestone not found");
    return this.milestoneRow(r);
  }

  saveMilestone(number: number | null, input: { title?: string; description?: string; state?: "open" | "closed"; dueOn?: string | null }, creator: string): Milestone {
    const t = now();
    if (number === null) {
      if (!input.title?.trim()) throw new HttpError(422, "title is required");
      this.sql.exec("INSERT INTO counters (name, value) VALUES ('milestone', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
      const n = this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = 'milestone'").one().value;
      const state = input.state ?? "open";
      this.sql.exec(
        "INSERT INTO milestones (number, title, description, state, due_on, created_at, updated_at, creator, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        n,
        input.title.trim(),
        input.description ?? "",
        state,
        input.dueOn ?? null,
        t,
        t,
        creator,
        state === "closed" ? t : null,
      );
      return this.milestone(n);
    }
    const m = this.milestone(number);
    const state = input.state ?? m.state;
    this.sql.exec(
      "UPDATE milestones SET title = ?, description = ?, state = ?, due_on = ?, updated_at = ?, closed_at = ? WHERE number = ?",
      input.title?.trim() || m.title,
      input.description ?? m.description,
      state,
      input.dueOn === undefined ? m.dueOn : input.dueOn,
      t,
      state === "closed" ? (m.closedAt ?? t) : null,
      number,
    );
    return this.milestone(number);
  }

  setIssueMilestone(number: number, milestone: number | null): void {
    if (!this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM issues WHERE number = ?", number).one().n) throw new HttpError(404, `#${number} not found`);
    if (milestone === null) {
      this.sql.exec("DELETE FROM issue_milestones WHERE number = ?", number);
      return;
    }
    this.milestone(milestone);
    this.sql.exec("INSERT OR REPLACE INTO issue_milestones (number, milestone) VALUES (?, ?)", number, milestone);
  }

  milestoneOf(number: number): { number: number; title: string; state: "open" | "closed"; dueOn: string | null } | null {
    const r = this.sql
      .exec<{ number: number; title: string; state: "open" | "closed"; due_on: string | null }>("SELECT m.number, m.title, m.state, m.due_on FROM issue_milestones x JOIN milestones m ON m.number = x.milestone WHERE x.number = ?", number)
      .toArray()[0];
    return r ? { number: r.number, title: r.title, state: r.state, dueOn: r.due_on } : null;
  }
}
