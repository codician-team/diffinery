import { Hono } from "hono";
import { Apps } from "../apps/store.js";
import type { Env } from "../env.js";
import { callerFor, type AppContext, type AppVars, type Principal } from "../auth/principal.js";
import type { Repo } from "../lib/directory.js";
import { matchesText, parseIssueQuery, parseRepoQuery } from "../lib/search-query.js";
import { HttpError } from "../lib/util.js";
import type { Issue } from "../repo/collab.js";
import { hiddenAuthors, repoStub } from "./common.js";
import { baseOf, ghIssue, ghRepo, pageOf, setLinks, topicsOf } from "./gh.js";
import { issueCtx } from "./ghctx.js";

/** GET /search/issues and /search/repositories over the repositories the caller can read. */
export const search = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** Searches fan out to at most this many repositories; more sets `incomplete_results`. */
const MAX_REPOS = 50;
/** Anonymous searches fan out to fewer: each repository searched is a Durable Object request, and anyone can send them. */
const MAX_ANONYMOUS_REPOS = 10;

/** How many repositories one issue search may fan out to for this caller. */
export const searchFanOut = (p: Principal): number => (p.type === "anonymous" ? MAX_ANONYMOUS_REPOS : MAX_REPOS);
const MAX_RESULTS = 1000;
/** GitHub's limit on the length of a search query. */
const MAX_QUERY = 256;
/** Repository search checks access on at most this many candidates. */
const MAX_REPO_CANDIDATES = 300;

/**
 * Repositories the caller might read: only active accounts (and agents whose
 * owner is active) get anything beyond public repositories, and every
 * candidate is checked again with callerFor, which applies roles, token
 * scopes and repository restrictions.
 */
async function candidates(c: AppContext, q?: { text: string[]; owners: string[] }): Promise<Repo[]> {
  const p = c.get("principal");
  const dir = c.get("dir");
  // Public repositories are looked up by the query's words and owners in D1, not taken from a fixed
  // number of the most recent ones, so any of them can be found however many there are.
  const publicOnes = () => dir.publicRepos(500, { words: q?.text.filter((w) => !w.startsWith("-")), owners: q?.owners });
  if (p.type === "account") {
    if (p.account.status !== "active") return [];
    const [mine, open] = await Promise.all([dir.reposVisibleTo(p.account), publicOnes()]);
    const seen = new Set(mine.map((r) => r.id));
    return [...mine, ...open.filter((r) => !seen.has(r.id))];
  }
  if (p.type === "repo-token") {
    const r = await dir.repoById(p.repoId);
    return r ? [r] : [];
  }
  if (p.type === "installation") {
    const only = p.auth.repoIds;
    const [mine, open] = await Promise.all([new Apps(c.env, dir).reposOf(p.auth.installation), publicOnes()]);
    const own = only ? mine.filter((r) => only.includes(r.id)) : mine;
    const seen = new Set(own.map((r) => r.id));
    return [...own, ...open.filter((r) => !seen.has(r.id))];
  }
  return publicOnes();
}

/** The first `limit` repositories (in order) the caller can actually read, and whether more were left unchecked. */
async function authorized(c: AppContext, repos: Repo[], limit: number): Promise<{ repos: Repo[]; incomplete: boolean }> {
  const out: Repo[] = [];
  for (let i = 0; i < repos.length; i++) {
    if (out.length >= limit) return { repos: out, incomplete: true };
    if (await callerFor(c, repos[i]!)) out.push(repos[i]!);
  }
  return { repos: out, incomplete: false };
}

const fullName = (r: Repo) => `${r.owner_login}/${r.name}`.toLowerCase();

function queryOf(c: AppContext): string {
  const raw = c.req.query("q") ?? "";
  if (!raw.trim()) throw new HttpError(422, "Validation Failed", { errors: [{ resource: "Search", field: "q", code: "missing" }] });
  if (raw.length > MAX_QUERY) throw new HttpError(422, `The search is longer than ${MAX_QUERY} characters.`, { errors: [{ resource: "Search", field: "q", code: "invalid" }] });
  return raw;
}

search.get("/search/issues", async (c) => {
  const q = parseIssueQuery(queryOf(c), { sort: c.req.query("sort"), order: c.req.query("order") });
  const p = pageOf(c);
  if (p.offset >= MAX_RESULTS) throw new HttpError(422, "Only the first 1000 search results are available");
  const owners = [...q.owners, ...q.repos.map((r) => r.split("/")[0]!)];
  let repos = await candidates(c, { text: [], owners });
  if (q.repos.length) {
    const want = new Set(q.repos.map((r) => r.toLowerCase()));
    repos = repos.filter((r) => want.has(fullName(r)));
  }
  if (q.owners.length) {
    const owners = new Set(q.owners.map((o) => o.toLowerCase()));
    repos = repos.filter((r) => owners.has(r.owner_login.toLowerCase()));
  }
  const allowed = await authorized(c, repos, searchFanOut(c.get("principal")));
  // Each repository returns at most `want` hits as (number, sort key); only the page is loaded afterwards.
  const want = Math.min(p.offset + p.perPage, MAX_RESULTS);
  const results = await Promise.all(allowed.repos.map(async (r) => ({ repo: r, ...(await repoStub(c.env, r.id).searchIssues(q, want)) })));
  const total = results.reduce((n, r) => n + r.total, 0);
  const sort = q.sort ?? { field: "created", dir: "desc" };
  const page = results
    .flatMap((r) => r.hits.map((h) => ({ repo: r.repo, number: h.number, key: h.key })))
    .sort((a, b) => {
      const d = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      return (sort.dir === "asc" ? d : -d) || (a.repo.id < b.repo.id ? -1 : a.repo.id > b.repo.id ? 1 : b.number - a.number);
    })
    .slice(p.offset, p.offset + p.perPage);
  const byRepo = new Map<string, { repo: Repo; numbers: number[] }>();
  for (const h of page) {
    const entry = byRepo.get(h.repo.id) ?? { repo: h.repo, numbers: [] };
    entry.numbers.push(h.number);
    byRepo.set(h.repo.id, entry);
  }
  const shaped = new Map<string, ReturnType<typeof ghIssue>>();
  for (const { repo, numbers } of byRepo.values()) {
    const stub = repoStub(c.env, repo.id);
    const issues = (await stub.issuesByNumber(numbers, await hiddenAuthors(c))) as unknown as Issue[];
    const x = await issueCtx(c, repo, stub, issues);
    for (const i of issues) shaped.set(`${repo.id}#${i.number}`, ghIssue(x, i));
  }
  setLinks(c, p, Math.min(total, MAX_RESULTS));
  const items = page.flatMap((h) => {
    const item = shaped.get(`${h.repo.id}#${h.number}`);
    return item ? [{ ...item, score: 1 }] : [];
  });
  return c.json({ total_count: total, incomplete_results: allowed.incomplete, items });
});

search.get("/search/repositories", async (c) => {
  const q = parseRepoQuery(queryOf(c));
  const p = pageOf(c);
  const fields = q.in.length ? q.in : ["name", "description", "topics"];
  const owners = new Set(q.owners.map((o) => o.toLowerCase()));
  const names = new Set(q.repos.map((r) => r.toLowerCase()));
  const filtered = (await candidates(c, q)).filter((r) => {
    if (owners.size && !owners.has(r.owner_login.toLowerCase())) return false;
    if (names.size && !names.has(fullName(r))) return false;
    if (q.visibility && (q.visibility === "public") !== (r.visibility === "public")) return false;
    if (q.archived !== undefined && !!r.archived !== q.archived) return false;
    const topics = topicsOf(r);
    if (q.topics.some((t) => !topics.includes(t))) return false;
    const hay: string[] = [];
    if (fields.includes("name")) hay.push(r.name, fullName(r));
    if (fields.includes("description")) hay.push(r.description ?? "");
    if (fields.includes("topics")) hay.push(topics.join(" "));
    return matchesText(q.text, hay);
  });
  const allowed = await authorized(c, filtered, MAX_REPO_CANDIDATES);
  const hits = allowed.repos;
  const order = c.req.query("order") === "asc" ? 1 : -1;
  if (c.req.query("sort") === "updated") hits.sort((a, b) => ((a.pushed_at ?? a.updated_at) < (b.pushed_at ?? b.updated_at) ? -order : order));
  setLinks(c, p, hits.length);
  return c.json({ total_count: hits.length, incomplete_results: allowed.incomplete, items: hits.slice(p.offset, p.offset + p.perPage).map((r) => ({ ...ghRepo(baseOf(c), r), score: 1 })) });
});
