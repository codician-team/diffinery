/**
 * IndexNow (indexnow.org): tells search engines (Bing, Yandex, Naver, Seznam, Yep and the others that
 * share submissions) which public pages were added, changed or removed, so they recrawl those instead of
 * waiting to find out. Nobody has to run anything: the Worker's five-minute cron (app.ts `scheduled`) does it.
 *
 * - Site pages (the home page, the product, comparison and company pages, the docs, each one's .md
 *   version, llms.txt, llms-full.txt, llms-small.txt and each docs section's llms files) are built into the Worker, so they only change with a deploy.
 *   The first cron run on a new version hashes each page's content, compares the hashes with the last
 *   ones submitted and queues the pages that are new, changed or gone. A deploy that changes no page
 *   submits nothing; later runs on the same version hash nothing, and a version older than the last one
 *   checked (a run on an old isolate during a rollout) is ignored.
 * - Public repositories' pages are checked hourly: a repository pushed since it was last submitted is
 *   queued. Only repositories that are public at that moment, with an owner who isn't suspended, are ever
 *   submitted (the same ones the sitemap lists), and only in the same run that saw them public: a
 *   private repository's page, or anything behind sign-in, is never sent.
 * - One POST per run, at most MAX_URLS URLs (IndexNow takes 10,000), to api.indexnow.org, or to Bing's or
 *   Yandex's own endpoint when it is rate-limited or down (INDEXNOW_ENDPOINTS). A refusal or a failure to
 *   reach IndexNow keeps the pages queued and waits before trying again; it never touches a
 *   deploy, which finished before the cron noticed it. Each submission is logged (console and
 *   indexnow_submissions, shown on Settings → Search engines).
 *
 * The key is derived from MASTER_KEY and the instance's origin, so every instance has its own without
 * configuration, and is served at /<key>.txt. INDEXNOW=off turns all of it off; so does an origin that
 * isn't public (http, localhost).
 */
import { allPages, llmsFullTxt, llmsSmallTxt, llmsTxt, markdownUrl, pageMarkdown, pageUrl, SECTIONS, sectionLlmsFullTxt, sectionLlmsFullUrl, sectionLlmsTxt, sectionLlmsUrl } from "../docs/pages.js";
import type { Env } from "../env.js";
import { hmacSha256 } from "../lib/crypto.js";
import type { Directory } from "../lib/directory.js";
import { sha256 } from "../lib/util.js";
import { homeContent, homeMarkdown, sitePageMarkdown, sitePages } from "./site.js";

/**
 * Where submissions go, in order. IndexNow engines share what each one receives, so one accepted
 * submission reaches them all. The next endpoint is tried only when one answers 429 or 5xx or can't be
 * reached: rate limits are per IP address, and a Worker's outbound addresses are shared with every
 * other Worker, so api.indexnow.org may turn it away while an engine's own endpoint takes it.
 */
export const INDEXNOW_ENDPOINTS = ["https://api.indexnow.org/indexnow", "https://www.bing.com/indexnow", "https://yandex.com/indexnow"];
/** URLs per submission: IndexNow's limit. */
export const MAX_URLS = 10_000;
/** Public repositories checked (and listed in the sitemap). */
export const MAX_REPOS = 5000;
/** How often public repositories are checked for pushes. */
export const REPO_INTERVAL_MS = 3600_000;
/** Submissions kept for Settings → Search engines. */
export const KEEP_SUBMISSIONS = 200;
/** How long to wait before trying again: after a 429, after another refusal, and when IndexNow couldn't be reached. */
export const RETRY_MS = { rateLimited: 3600_000, refused: 6 * 3600_000, unreachable: 15 * 60_000 };
const TIMEOUT_MS = 15_000;
/** Statements per D1 batch. */
const BATCH = 100;

type IndexNowEnv = Pick<Env, "DB" | "PUBLIC_URL" | "MASTER_KEY" | "INDEXNOW" | "SIGNUP" | "CF_VERSION_METADATA">;

const origin = (env: Pick<Env, "PUBLIC_URL">) => env.PUBLIC_URL.replace(/\/$/, "");

/** Why IndexNow is off on this instance, or null when it is on. */
export function indexNowOff(env: Pick<Env, "PUBLIC_URL" | "MASTER_KEY" | "INDEXNOW">): string | null {
  if ((env.INDEXNOW ?? "").toLowerCase() === "off") return "INDEXNOW is off";
  let url: URL;
  try {
    url = new URL(env.PUBLIC_URL);
  } catch {
    return "PUBLIC_URL isn't a URL";
  }
  if (url.protocol !== "https:" || url.hostname === "localhost" || !url.hostname.includes(".") || /^[\d.]+$|:/.test(url.hostname)) return "PUBLIC_URL isn't a public https origin";
  if (!env.MASTER_KEY) return "MASTER_KEY isn't set";
  return null;
}

const keys = new Map<string, Promise<string>>();
/** The instance's IndexNow key (32 hex characters), or null while IndexNow is off. */
export function indexNowKey(env: Pick<Env, "PUBLIC_URL" | "MASTER_KEY" | "INDEXNOW">): Promise<string> | null {
  if (indexNowOff(env)) return null;
  const id = `${env.MASTER_KEY} ${origin(env)}`;
  let k = keys.get(id);
  if (!k) {
    k = hmacSha256(env.MASTER_KEY!, `indexnow key for ${origin(env)}`).then((b) => [...b.slice(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join(""));
    keys.set(id, k);
  }
  return k;
}

/** Where the key file is served. */
export const keyLocation = (env: Pick<Env, "PUBLIC_URL">, key: string) => `${origin(env)}/${key}.txt`;

/**
 * Every public page built into the Worker, by path, with the content that decides whether it changed:
 * the same pages as the sitemap (less public repositories), plus each one's Markdown version and the llms files.
 */
export async function sitePageContents(env: Pick<Env, "PUBLIC_URL" | "SIGNUP">): Promise<Map<string, string>> {
  const o = origin(env);
  const pages = new Map<string, string>();
  pages.set("/", await homeContent(o));
  pages.set("/index.md", homeMarkdown(o));
  for (const p of sitePages()) {
    const md = sitePageMarkdown(p, o);
    pages.set(p.path, `${p.seoTitle ?? ""}\n${p.section}\n${md}`);
    pages.set(`${p.path}.md`, md);
  }
  for (const p of allPages(o)) {
    const md = pageMarkdown(p, o);
    pages.set(pageUrl(p.slug), `${p.section}\n${md}`);
    pages.set(markdownUrl(p.slug), md);
  }
  pages.set("/llms.txt", llmsTxt(o));
  pages.set("/llms-full.txt", llmsFullTxt(o));
  pages.set("/llms-small.txt", llmsSmallTxt(o));
  for (const sec of SECTIONS) {
    pages.set(sectionLlmsUrl(sec.slug), sectionLlmsTxt(o, sec.slug)!);
    pages.set(sectionLlmsFullUrl(sec.slug), sectionLlmsFullTxt(o, sec.slug)!);
  }
  return pages;
}

const hashCache = new Map<string, Promise<{ hashes: Map<string, string>; fingerprint: string }>>();
/** Each site page's content hash and one fingerprint of them all. The pages are part of the deploy, so an isolate computes them once. */
export function siteHashes(env: Pick<Env, "PUBLIC_URL" | "SIGNUP">): Promise<{ hashes: Map<string, string>; fingerprint: string }> {
  const id = origin(env);
  let h = hashCache.get(id);
  if (!h) {
    h = (async () => {
      const hashes = new Map<string, string>();
      for (const [path, content] of await sitePageContents(env)) hashes.set(path, (await sha256(content)).slice(0, 32));
      const fingerprint = await sha256([...hashes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, x]) => `${p} ${x}`).join("\n"));
      return { hashes, fingerprint };
    })();
    hashCache.set(id, h);
    h.catch(() => hashCache.delete(id));
  }
  return h;
}

// ---------------------------------------------------------------- state

async function getState(db: D1Database, k: string): Promise<string | null> {
  return (await db.prepare("SELECT v FROM indexnow_state WHERE k = ?").bind(k).first<{ v: string }>())?.v ?? null;
}
const setState = (db: D1Database, k: string, v: string) => db.prepare("INSERT INTO indexnow_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v);

async function runBatches(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH));
}

type Row = { path: string; kind: string; hash: string; sent_hash: string | null };

/**
 * Queues the site pages a deploy added, changed or removed. Runs only when this version's content
 * fingerprint differs from the last one checked, and never for a version older than that one's.
 * Returns how many pages it queued.
 */
export async function checkSite(env: IndexNowEnv): Promise<number> {
  const db = env.DB;
  const version = env.CF_VERSION_METADATA;
  const [lastFingerprint, lastVersionAt, lastVersionId] = await Promise.all([getState(db, "site_fingerprint"), getState(db, "site_version_at"), getState(db, "site_version_id")]);
  // This version was checked already, or a newer one was: nothing to hash.
  if (version?.id && version.id === lastVersionId) return 0;
  if (version?.timestamp && lastVersionAt && version.timestamp < lastVersionAt) return 0;
  const { hashes, fingerprint } = await siteHashes(env);
  const seen = version?.id && version.timestamp ? [setState(db, "site_version_id", version.id), setState(db, "site_version_at", version.timestamp)] : [];
  if (fingerprint === lastFingerprint) {
    if (seen.length) await db.batch(seen);
    return 0;
  }
  const rows = (await db.prepare("SELECT path, kind, hash, sent_hash FROM indexnow_urls WHERE kind = 'site'").all<Row>()).results;
  const known = new Map(rows.map((r) => [r.path, r]));
  const stmts: D1PreparedStatement[] = [];
  for (const [path, hash] of hashes) {
    if (known.get(path)?.hash === hash) continue;
    stmts.push(db.prepare("INSERT INTO indexnow_urls (path, kind, hash) VALUES (?, 'site', ?) ON CONFLICT(path) DO UPDATE SET kind = 'site', hash = excluded.hash").bind(path, hash));
  }
  for (const r of rows) {
    if (hashes.has(r.path) || r.hash === "") continue;
    // Gone: a page that was submitted is submitted once more, so search engines see it is gone; one that never was is forgotten.
    stmts.push(r.sent_hash === null ? db.prepare("DELETE FROM indexnow_urls WHERE path = ?").bind(r.path) : db.prepare("UPDATE indexnow_urls SET hash = '' WHERE path = ?").bind(r.path));
  }
  const queued = stmts.length;
  stmts.push(setState(db, "site_fingerprint", fingerprint), ...seen);
  await runBatches(db, stmts);
  return queued;
}

/**
 * Queues public repositories pushed since they were last submitted, and forgets repositories that are no
 * longer public (they are never submitted again). Returns the paths of every public repository now
 * queued: only these may be submitted in this run.
 */
export async function checkRepos(env: IndexNowEnv, dir: Pick<Directory, "publicRepos">): Promise<Set<string>> {
  const db = env.DB;
  const repos = await dir.publicRepos(MAX_REPOS);
  const current = new Map(repos.map((r) => [`/${encodeURIComponent(r.owner_login)}/${encodeURIComponent(r.name)}`, r.pushed_at ?? r.updated_at]));
  const rows = (await db.prepare("SELECT path, kind, hash, sent_hash FROM indexnow_urls WHERE kind = 'repo'").all<Row>()).results;
  const known = new Map(rows.map((r) => [r.path, r]));
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) if (!current.has(r.path)) stmts.push(db.prepare("DELETE FROM indexnow_urls WHERE path = ? AND kind = 'repo'").bind(r.path));
  const queued = new Set<string>();
  for (const [path, at] of current) {
    const row = known.get(path);
    if (row?.hash !== at) stmts.push(db.prepare("INSERT INTO indexnow_urls (path, kind, hash) VALUES (?, 'repo', ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash").bind(path, at));
    if (row?.sent_hash !== at) queued.add(path);
  }
  stmts.push(setState(db, "repos_checked_at", new Date().toISOString()));
  await runBatches(db, stmts);
  return queued;
}

// ---------------------------------------------------------------- submitting

export type Submission = { at: string; urls: number; status: number | null; ms: number; error: string | null; paths: string[]; endpoint: string | null };

/** The host of an endpoint, as logged. */
const hostOf = (url: string) => new URL(url).host;

/** POSTs `paths` to IndexNow, trying the next endpoint after a 429, a 5xx or no answer. Never throws. */
export async function submit(env: Pick<Env, "PUBLIC_URL">, key: string, paths: string[], fetcher: typeof fetch = fetch): Promise<Submission> {
  const o = origin(env);
  const at = new Date().toISOString();
  const started = Date.now();
  const body = JSON.stringify({ host: new URL(o).host, key, keyLocation: keyLocation(env, key), urlList: paths.map((p) => `${o}${p}`) });
  let status: number | null = null;
  let error: string | null = null;
  let endpoint: string | null = null;
  const passed: string[] = [];
  for (const url of INDEXNOW_ENDPOINTS) {
    if (endpoint) passed.push(`${endpoint} ${status ?? "unreachable"}${error ? ` (${error.slice(0, 120)})` : ""}`);
    endpoint = hostOf(url);
    status = null;
    error = null;
    try {
      const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = res.status;
      const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
      if (status !== 200 && status !== 202) error = text.slice(0, 500) || res.statusText || `HTTP ${status}`;
    } catch (e) {
      error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);
    }
    if (status !== null && status !== 429 && status < 500) break;
  }
  // What the endpoints passed over said, then the last one's own error.
  if (passed.length) error = [`after ${passed.join("; ")}`, error].filter(Boolean).join(": ");
  return { at, urls: paths.length, status, ms: Date.now() - started, error: error?.slice(0, 1000) ?? null, paths, endpoint };
}

const accepted = (s: Submission) => s.status === 200 || s.status === 202;

/**
 * The cron's part: queue what a deploy changed (and, hourly, what was pushed to public repositories),
 * then submit the queue. Never throws; a failure is logged and tried again later.
 */
export async function indexNowCron(env: IndexNowEnv, dir: Pick<Directory, "publicRepos">, fetcher: typeof fetch = fetch): Promise<Submission | null> {
  const key = indexNowKey(env);
  if (!key) return null;
  const db = env.DB;
  try {
    const nowMs = Date.now();
    const [retryAt, reposAt] = await Promise.all([getState(db, "retry_at"), getState(db, "repos_checked_at")]);
    const waiting = !!retryAt && Date.parse(retryAt) > nowMs;
    const siteQueued = await checkSite(env);
    if (waiting) return null;
    // Repositories once an hour, and only when IndexNow isn't asking us to wait.
    const repos = !reposAt || nowMs - Date.parse(reposAt) >= REPO_INTERVAL_MS ? await checkRepos(env, dir) : new Set<string>();
    // Pages wait in the queue only after a refusal (retry_at) or when one submission couldn't take them all.
    if (!siteQueued && !repos.size && !retryAt) return null;

    const site = (await db.prepare("SELECT path, kind, hash, sent_hash FROM indexnow_urls WHERE kind = 'site' AND (sent_hash IS NULL OR sent_hash != hash)").all<Row>()).results;
    const repoRows = repos.size ? (await db.prepare("SELECT path, kind, hash, sent_hash FROM indexnow_urls WHERE kind = 'repo' AND (sent_hash IS NULL OR sent_hash != hash)").all<Row>()).results.filter((r) => repos.has(r.path)) : [];
    const all = [...site, ...repoRows];
    if (!all.length) {
      if (retryAt) await db.prepare("DELETE FROM indexnow_state WHERE k = 'retry_at'").run();
      return null;
    }
    const batch = all.slice(0, MAX_URLS);
    const s = await submit(env, await key, batch.map((r) => r.path), fetcher);
    console.log(`indexnow: ${s.urls} URLs, ${s.endpoint} ${s.status ?? "unreachable"} in ${s.ms} ms${s.error ? `: ${s.error}` : ""}`);
    const stmts: D1PreparedStatement[] = [
      db.prepare("INSERT INTO indexnow_submissions (at, urls, status, ms, error, paths, endpoint) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(s.at, s.urls, s.status, s.ms, s.error, JSON.stringify(s.paths.slice(0, 50)), s.endpoint),
      db.prepare("DELETE FROM indexnow_submissions WHERE id <= (SELECT id FROM indexnow_submissions ORDER BY id DESC LIMIT 1 OFFSET ?)").bind(KEEP_SUBMISSIONS),
    ];
    if (accepted(s)) {
      for (const r of batch) {
        stmts.push(r.hash === "" ? db.prepare("DELETE FROM indexnow_urls WHERE path = ? AND hash = ''").bind(r.path) : db.prepare("UPDATE indexnow_urls SET sent_hash = ?, sent_at = ? WHERE path = ?").bind(r.hash, s.at, r.path));
      }
      // More than one submission holds: the rest go in the next run (site pages; repositories after the next check).
      stmts.push(all.length > batch.length ? setState(db, "retry_at", s.at) : db.prepare("DELETE FROM indexnow_state WHERE k = 'retry_at'"));
    } else {
      const wait = s.status === 429 ? RETRY_MS.rateLimited : s.status === null || s.status >= 500 ? RETRY_MS.unreachable : RETRY_MS.refused;
      stmts.push(setState(db, "retry_at", new Date(nowMs + wait).toISOString()));
    }
    await runBatches(db, stmts);
    return s;
  } catch (e) {
    console.error("indexnow failed", e);
    return null;
  }
}

// ---------------------------------------------------------------- what administrators and /meta see

export type IndexNowStatus = {
  off: string | null;
  keyLocation: string | null;
  site: number;
  repos: number;
  queued: number;
  retryAt: string | null;
  reposCheckedAt: string | null;
  submissions: Submission[];
};

export async function indexNowStatus(env: IndexNowEnv, limit = 50): Promise<IndexNowStatus> {
  const off = indexNowOff(env);
  const key = indexNowKey(env);
  const [counts, retryAt, reposCheckedAt, subs] = await Promise.all([
    env.DB.prepare("SELECT kind, COUNT(*) AS n, SUM(CASE WHEN sent_hash IS NULL OR sent_hash != hash THEN 1 ELSE 0 END) AS queued FROM indexnow_urls GROUP BY kind").all<{ kind: string; n: number; queued: number }>(),
    getState(env.DB, "retry_at"),
    getState(env.DB, "repos_checked_at"),
    lastSubmissions(env.DB, limit),
  ]);
  const by = new Map(counts.results.map((r) => [r.kind, r]));
  return {
    off,
    keyLocation: key ? keyLocation(env, await key) : null,
    site: by.get("site")?.n ?? 0,
    repos: by.get("repo")?.n ?? 0,
    queued: counts.results.reduce((n, r) => n + (r.queued ?? 0), 0),
    retryAt,
    reposCheckedAt,
    submissions: subs,
  };
}

export async function lastSubmissions(db: D1Database, limit: number): Promise<Submission[]> {
  const rows = (await db.prepare("SELECT at, urls, status, ms, error, paths, endpoint FROM indexnow_submissions ORDER BY id DESC LIMIT ?").bind(limit).all<Omit<Submission, "paths"> & { paths: string }>()).results;
  return rows.map((r) => ({ ...r, paths: JSON.parse(r.paths) as string[] }));
}

/** For GET /api/v3/meta: whether IndexNow is on, its key file, and how the last submission went (no URLs). */
export async function indexNowMeta(env: IndexNowEnv): Promise<{ enabled: boolean; key_location: string | null; last_submission: { at: string; urls: number; status: number | null; endpoint: string | null } | null }> {
  const key = indexNowKey(env);
  if (!key) return { enabled: false, key_location: null, last_submission: null };
  const last = await env.DB.prepare("SELECT at, urls, status, endpoint FROM indexnow_submissions ORDER BY id DESC LIMIT 1")
    .first<{ at: string; urls: number; status: number | null; endpoint: string | null }>()
    .catch(() => null);
  return { enabled: true, key_location: keyLocation(env, await key), last_submission: last ?? null };
}
