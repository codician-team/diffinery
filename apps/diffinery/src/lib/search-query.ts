/**
 * GitHub search query syntax (`repo:o/r is:pr is:open label:bug fix crash`),
 * parsed into filters for issue and repository search. Pure, so it is unit
 * tested on its own.
 */

export type Range = { gt?: string; gte?: string; lt?: string; lte?: string };

export type IssueQuery = {
  repos: string[];
  owners: string[];
  kind?: "issue" | "pull";
  state?: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  locked?: boolean;
  labels: string[];
  notLabels: string[];
  noLabel?: boolean;
  author?: string;
  notAuthor?: string;
  assignee?: string;
  noAssignee?: boolean;
  head?: string;
  base?: string;
  in: Array<"title" | "body" | "comments">;
  text: string[];
  created?: Range;
  updated?: Range;
  closed?: Range;
  sort?: { field: "created" | "updated" | "comments"; dir: "asc" | "desc" };
};

export type RepoQuery = {
  owners: string[];
  repos: string[];
  topics: string[];
  visibility?: "public" | "private";
  archived?: boolean;
  in: Array<"name" | "description" | "topics">;
  text: string[];
};

export type Token = { key: string | null; value: string; negated: boolean };

/** Split a query into qualifiers and words, honouring double quotes and a leading `-`. */
export function tokenize(q: string): Token[] {
  const out: Token[] = [];
  const re = /(-?)(?:([A-Za-z_-]+):)?(?:"([^"]*)"?|(\S+))/g;
  for (const m of q.matchAll(re)) {
    const key = m[2] ? m[2].toLowerCase() : null;
    const value = m[3] ?? m[4] ?? "";
    if (key && value === "" && m[3] === undefined) out.push({ key: null, value: `${m[2]}:`, negated: false });
    else if (key || value) out.push({ key, value, negated: m[1] === "-" });
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;

/** `>2024-01-01`, `>=…`, `<…`, `<=…`, `a..b`, `a..*`, `*..b` or an exact day. */
export function parseRange(v: string): Range | null {
  const m = /^(>=|<=|>|<)(.+)$/.exec(v);
  if (m) {
    const d = m[2]!;
    if (!DATE.test(d)) return null;
    const endOfDay = d.length === 10 ? `${d}T23:59:59.999Z` : d;
    if (m[1] === ">") return { gt: endOfDay };
    if (m[1] === ">=") return { gte: d };
    if (m[1] === "<") return { lt: d };
    return { lte: endOfDay };
  }
  const r = /^(.+)\.\.(.+)$/.exec(v);
  if (r) {
    const out: Range = {};
    if (r[1] !== "*") {
      if (!DATE.test(r[1]!)) return null;
      out.gte = r[1];
    }
    if (r[2] !== "*") {
      if (!DATE.test(r[2]!)) return null;
      out.lte = r[2]!.length === 10 ? `${r[2]}T23:59:59.999Z` : r[2];
    }
    return out;
  }
  if (!DATE.test(v)) return null;
  return v.length === 10 ? { gte: v, lte: `${v}T23:59:59.999Z` } : { gte: v, lte: v };
}

export function inRange(value: string | null | undefined, r: Range | undefined): boolean {
  if (!r) return true;
  if (!value) return false;
  if (r.gt && !(value > r.gt)) return false;
  if (r.gte && !(value >= r.gte)) return false;
  if (r.lt && !(value < r.lt)) return false;
  if (r.lte && !(value <= r.lte)) return false;
  return true;
}

/** Parse an issue/pull request search; `sort`/`order` query params override a `sort:` qualifier. */
export function parseIssueQuery(q: string, params: { sort?: string; order?: string } = {}): IssueQuery {
  const s: IssueQuery = { repos: [], owners: [], labels: [], notLabels: [], in: [], text: [] };
  for (const t of tokenize(q)) {
    const v = t.value;
    const lv = v.toLowerCase();
    switch (t.key) {
      case null:
        if (v) s.text.push(t.negated ? `-${v}` : v);
        break;
      case "repo":
        if (/^[^/\s]+\/[^/\s]+$/.test(v)) s.repos.push(v);
        break;
      case "user":
      case "org":
      case "owner":
        s.owners.push(v);
        break;
      case "is":
      case "type":
      case "state":
        if (lv === "issue") s.kind = "issue";
        else if (lv === "pr" || lv === "pull-request" || lv === "pull_request") s.kind = "pull";
        else if (lv === "open" || lv === "closed") s.state = t.negated ? (lv === "open" ? "closed" : "open") : lv;
        else if (lv === "merged" || lv === "unmerged") {
          s.kind = "pull";
          s.merged = (lv === "merged") !== t.negated;
        } else if (lv === "draft") s.draft = !t.negated;
        else if (lv === "locked" || lv === "unlocked") s.locked = (lv === "locked") !== t.negated;
        break;
      case "draft":
        s.draft = lv === "true";
        break;
      case "label":
        for (const l of v.split(",").filter(Boolean)) (t.negated ? s.notLabels : s.labels).push(l);
        break;
      case "no":
        if (lv === "label") s.noLabel = true;
        else if (lv === "assignee") s.noAssignee = true;
        break;
      case "author":
        if (t.negated) s.notAuthor = v;
        else s.author = v;
        break;
      case "assignee":
        s.assignee = v;
        break;
      case "head":
        s.head = v;
        break;
      case "base":
        s.base = v;
        break;
      case "in":
        for (const f of lv.split(",")) if ((f === "title" || f === "body" || f === "comments") && !s.in.includes(f)) s.in.push(f);
        break;
      case "created":
      case "updated":
      case "closed": {
        const r = parseRange(v);
        if (r) s[t.key] = r;
        break;
      }
      case "sort": {
        const [field, dir] = lv.split("-");
        if (field === "created" || field === "updated" || field === "comments") s.sort = { field, dir: dir === "asc" ? "asc" : "desc" };
        break;
      }
      default:
        // Unknown qualifiers are searched as text, like GitHub does with words it doesn't recognise.
        s.text.push(`${t.key}:${v}`);
    }
  }
  const sort = params.sort?.toLowerCase();
  if (sort === "created" || sort === "updated" || sort === "comments") s.sort = { field: sort, dir: params.order?.toLowerCase() === "asc" ? "asc" : "desc" };
  return s;
}

export function parseRepoQuery(q: string): RepoQuery {
  const s: RepoQuery = { owners: [], repos: [], topics: [], in: [], text: [] };
  for (const t of tokenize(q)) {
    const lv = t.value.toLowerCase();
    switch (t.key) {
      case null:
        if (t.value) s.text.push(t.negated ? `-${t.value}` : t.value);
        break;
      case "user":
      case "org":
      case "owner":
        s.owners.push(t.value);
        break;
      case "repo":
        if (/^[^/\s]+\/[^/\s]+$/.test(t.value)) s.repos.push(t.value);
        break;
      case "topic":
        s.topics.push(lv);
        break;
      case "is":
        if (lv === "public" || lv === "private") s.visibility = lv;
        break;
      case "archived":
        s.archived = lv === "true";
        break;
      case "in":
        for (const f of lv.split(",")) if ((f === "name" || f === "description" || f === "topics") && !s.in.includes(f)) s.in.push(f);
        break;
      case "fork":
      case "language":
      case "stars":
      case "forks":
      case "size":
      case "pushed":
      case "created":
        // Accepted but not filtered on: Diffinery has no forks, stars or language index.
        break;
      default:
        s.text.push(`${t.key}:${t.value}`);
    }
  }
  return s;
}

/** Case-insensitive text match: every word appears, and no `-word` does. */
export function matchesText(words: string[], haystacks: string[]): boolean {
  if (!words.length) return true;
  const hay = haystacks.join("\n").toLowerCase();
  return words.every((w) => (w.length > 1 && w.startsWith("-") ? !hay.includes(w.slice(1).toLowerCase()) : hay.includes(w.toLowerCase())));
}
