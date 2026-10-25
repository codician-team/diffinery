import { inRange, matchesText, type IssueQuery } from "../lib/search-query.js";
import type { RepoDO } from "./RepoDO.js";

type Row = {
  number: number;
  kind: string;
  title: string;
  body: string;
  state: string;
  author_login: string;
  assignees: string;
  labels: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  locked: number;
  head_ref: string | null;
  base_ref: string | null;
  draft: number | null;
  merged: number | null;
  comments: number;
};

/** Rows scanned per repository, and comment bodies read for `in:comments`. */
const MAX_ROWS = 5000;
const MAX_COMMENT_ROWS = 2000;

/** One hit: the issue number and the value it sorts by. The Worker merges hits across repositories. */
export type SearchHit = { number: number; key: string | number };

/**
 * Issue and pull request search within one repository. Returns only numbers
 * and sort keys (at most `limit`); the Worker merges the hits of every
 * repository the caller can read and then loads just the page it returns.
 */
export function searchIssues(repo: RepoDO, q: IssueQuery, limit: number): { hits: SearchHit[]; total: number } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.kind) {
    where.push("i.kind = ?");
    args.push(q.kind);
  }
  if (q.state) {
    where.push("i.state = ?");
    args.push(q.state);
  }
  if (q.merged !== undefined) where.push(q.merged ? "p.merged = 1" : "coalesce(p.merged, 0) = 0");
  if (q.draft !== undefined) where.push(q.draft ? "p.draft = 1" : "coalesce(p.draft, 0) = 0");
  if (q.locked !== undefined) where.push(q.locked ? "i.locked = 1" : "i.locked = 0");
  // Author search distinguishes imported GitHub users from Diffinery accounts: "author:github:alice"
  // matches the mannequin, a plain "author:alice" matches only the real Diffinery account.
  if (q.author) {
    if (q.author.startsWith("github:")) {
      where.push("i.author_kind = 'github' AND i.author_login = ? COLLATE NOCASE");
      args.push(q.author.slice(7));
    } else {
      where.push("i.author_login = ? COLLATE NOCASE AND i.author_kind != 'github'");
      args.push(q.author);
    }
  }
  if (q.notAuthor) {
    if (q.notAuthor.startsWith("github:")) {
      where.push("NOT (i.author_kind = 'github' AND i.author_login = ? COLLATE NOCASE)");
      args.push(q.notAuthor.slice(7));
    } else {
      where.push("NOT (i.author_login = ? COLLATE NOCASE AND i.author_kind != 'github')");
      args.push(q.notAuthor);
    }
  }
  if (q.head) {
    where.push("p.head_ref = ?");
    args.push(q.head);
  }
  if (q.base) {
    where.push("p.base_ref = ?");
    args.push(q.base);
  }
  for (const l of q.labels) {
    where.push("EXISTS (SELECT 1 FROM json_each(i.labels) WHERE lower(value) = lower(?))");
    args.push(l);
  }
  for (const l of q.notLabels) {
    where.push("NOT EXISTS (SELECT 1 FROM json_each(i.labels) WHERE lower(value) = lower(?))");
    args.push(l);
  }
  if (q.noLabel) where.push("i.labels = '[]'");
  if (q.noAssignee) where.push("i.assignees = '[]'");
  if (q.assignee) {
    where.push("EXISTS (SELECT 1 FROM json_each(i.assignees) WHERE lower(value) = lower(?))");
    args.push(q.assignee);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = repo.sql
    .exec<Row>(
      `SELECT i.*, p.head_ref, p.base_ref, p.draft, p.merged, (SELECT count(*) FROM comments c WHERE c.number = i.number AND c.review_id IS NULL) AS comments
       FROM issues i LEFT JOIN pulls p ON p.number = i.number ${w} ORDER BY i.number DESC LIMIT ?`,
      ...args,
      MAX_ROWS,
    )
    .toArray();
  const fields = q.in.length ? q.in : ["title", "body"];
  // in:comments reads a bounded number of the newest comment bodies, once, instead of a query per issue.
  const commentText = new Map<number, string[]>();
  if (fields.includes("comments") && q.text.length) {
    for (const c of repo.sql.exec<{ number: number; body: string }>("SELECT number, body FROM comments ORDER BY rowid DESC LIMIT ?", MAX_COMMENT_ROWS).toArray()) {
      const list = commentText.get(c.number) ?? [];
      list.push(c.body);
      commentText.set(c.number, list);
    }
  }
  const matched = rows.filter((r) => {
    if (!inRange(r.created_at, q.created) || !inRange(r.updated_at, q.updated) || !inRange(r.closed_at, q.closed)) return false;
    if (!q.text.length) return true;
    const hay: string[] = [];
    if (fields.includes("title")) hay.push(r.title);
    if (fields.includes("body")) hay.push(r.body);
    if (fields.includes("comments")) hay.push(...(commentText.get(r.number) ?? []));
    return matchesText(q.text, hay);
  });
  const sort = q.sort ?? { field: "created", dir: "desc" };
  const key = (r: Row) => (sort.field === "comments" ? r.comments : sort.field === "updated" ? r.updated_at : r.created_at);
  matched.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = x < y ? -1 : x > y ? 1 : b.number - a.number;
    return sort.dir === "asc" ? c : -c;
  });
  return { hits: matched.slice(0, Math.max(0, Math.min(limit, 1000))).map((r) => ({ number: r.number, key: key(r) })), total: matched.length };
}
