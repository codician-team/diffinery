/**
 * IndexNow (web/indexnow.ts): the key file, which pages are covered, and the cron that submits only
 * what changed, never a private repository, and never throws.
 * Needs src/docs/content.generated.ts (`pnpm build` or `pnpm build:docs`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { web } from "../../src/web/routes.js";
import type { Env } from "../../src/env.js";
import type { Repo } from "../../src/lib/directory.js";
import { docsSitemapEntries } from "../../src/docs/web.js";
import { siteSitemapEntries } from "../../src/web/site.js";
import { INDEXNOW_ENDPOINTS, indexNowCron, indexNowKey, indexNowOff, indexNowStatus, MAX_URLS, RETRY_MS, sitePageContents } from "../../src/web/indexnow.js";
import { testD1 } from "./stubs/d1.js";

app.route("/", web);

const ORIGIN = "https://diffinery.example";
const MASTER_KEY = btoa("k".repeat(32));
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

type Sent = { host: string; key: string; keyLocation: string; urlList: string[] };

function setup(o: { status?: number | ((url: string) => number); version?: string } = {}) {
  const db = testD1();
  const env = { PUBLIC_URL: ORIGIN, MASTER_KEY, DB: db, CF_VERSION_METADATA: o.version ? { id: "v", tag: "", timestamp: o.version } : undefined } as unknown as Env;
  const sent: Sent[] = [];
  const urls: string[] = [];
  let status = o.status ?? 200;
  const fetcher = (async (url: string, init: RequestInit) => {
    expect(INDEXNOW_ENDPOINTS).toContain(url);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json; charset=utf-8");
    urls.push(url);
    sent.push(JSON.parse(init.body as string) as Sent);
    const s = typeof status === "function" ? status(url) : status;
    return new Response(s === 200 ? "" : "nope", { status: s });
  }) as unknown as typeof fetch;
  let repos: Array<Partial<Repo>> = [];
  const dir = { publicRepos: async () => repos as Repo[] };
  return {
    env,
    db,
    sent,
    urls,
    run: () => indexNowCron(env as never, dir, fetcher),
    setRepos: (r: Array<Partial<Repo>>) => (repos = r),
    /** A new version, as a deploy makes (its content is the same build, so tests change what was last submitted instead). */
    deploy: (timestamp: string) => ((env as { CF_VERSION_METADATA?: WorkerVersionMetadata }).CF_VERSION_METADATA = { id: `v-${timestamp}`, tag: "", timestamp }),
    setStatus: (s: number | ((url: string) => number)) => (status = s),
    state: (k: string) => db.sqlite.prepare("SELECT v FROM indexnow_state WHERE k = ?").get(k) as { v: string } | undefined,
    /** Moves time forward for the cron: every stored time goes back by `ms`. */
    age: (ms: number) => {
      for (const k of ["retry_at", "repos_checked_at"]) {
        const r = db.sqlite.prepare("SELECT v FROM indexnow_state WHERE k = ?").get(k) as { v: string } | undefined;
        if (r) db.sqlite.prepare("UPDATE indexnow_state SET v = ? WHERE k = ?").run(new Date(Date.parse(r.v) - ms).toISOString(), k);
      }
    },
  };
}

const paths = (s: Sent) => s.urlList.map((u) => u.slice(ORIGIN.length));

describe("IndexNow", () => {
  it("is on only for a public https origin with a master key, unless INDEXNOW=off", () => {
    expect(indexNowOff({ PUBLIC_URL: ORIGIN, MASTER_KEY })).toBeNull();
    expect(indexNowOff({ PUBLIC_URL: ORIGIN, MASTER_KEY, INDEXNOW: "off" })).toMatch(/off/);
    expect(indexNowOff({ PUBLIC_URL: "http://localhost:8787", MASTER_KEY })).toMatch(/public/);
    expect(indexNowOff({ PUBLIC_URL: "https://localhost", MASTER_KEY })).toMatch(/public/);
    expect(indexNowOff({ PUBLIC_URL: "https://10.0.0.1", MASTER_KEY })).toMatch(/public/);
    expect(indexNowOff({ PUBLIC_URL: ORIGIN })).toMatch(/MASTER_KEY/);
    expect(indexNowKey({ PUBLIC_URL: "http://localhost:8787", MASTER_KEY })).toBeNull();
  });

  it("serves the key file at the site root, and nothing at other names", async () => {
    const env = { PUBLIC_URL: ORIGIN, MASTER_KEY, DB: testD1() } as unknown as Env;
    const key = await indexNowKey(env)!;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    // Stable for the instance, different for another origin or master key.
    expect(await indexNowKey(env)!).toBe(key);
    expect(await indexNowKey({ PUBLIC_URL: "https://other.example", MASTER_KEY })!).not.toBe(key);
    expect(await indexNowKey({ PUBLIC_URL: ORIGIN, MASTER_KEY: btoa("j".repeat(32)) })!).not.toBe(key);
    const res = await app.fetch(new Request(`${ORIGIN}/${key}.txt`), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(key);
    expect((await app.fetch(new Request(`${ORIGIN}/${"0".repeat(32)}.txt`), env, ctx)).status).toBe(404);
    const off = { ...env, INDEXNOW: "off" } as Env;
    expect((await app.fetch(new Request(`${ORIGIN}/${key}.txt`), off, ctx)).status).toBe(404);
  });

  it("covers every page in the sitemap and each one's Markdown version, and nothing behind sign-in", async () => {
    const pages = await sitePageContents({ PUBLIC_URL: ORIGIN });
    const want = [...siteSitemapEntries().map((e) => e.path), ...docsSitemapEntries().map((e) => e.path)];
    for (const p of want) expect(pages.has(p), p).toBe(true);
    for (const p of siteSitemapEntries().map((e) => e.path)) expect(pages.has(p === "/" ? "/index.md" : `${p}.md`), `${p}.md`).toBe(true);
    for (const p of docsSitemapEntries().map((e) => e.path)) expect(pages.has(p === "/docs" ? "/docs/index.md" : `${p}.md`), `${p}.md`).toBe(true);
    for (const p of ["/llms.txt", "/llms-full.txt", "/llms-small.txt", "/docs/actions/llms-full.txt", "/compare/github", "/docs/quickstart", "/docs/quickstart.md"]) expect(pages.has(p), p).toBe(true);
    for (const p of pages.keys()) expect(p).not.toMatch(/^\/(settings|login|signin|auth|admin|new|notifications|invite|api|-)(\/|$)/);
    // Every page answers 200 to a visitor.
    const env = { PUBLIC_URL: ORIGIN, DB: testD1() } as unknown as Env;
    for (const p of ["/", "/index.md", "/compare/github.md", "/docs/quickstart.md", "/llms.txt"]) expect((await app.fetch(new Request(`${ORIGIN}${p}`), env, ctx)).status, p).toBe(200);
    // The early access form is for an instance's own visitors, not for search engines.
    expect(pages.has("/early-access")).toBe(false);
  });

  describe("cron", () => {
    let t: ReturnType<typeof setup>;
    beforeEach(() => {
      t = setup({ version: "2026-10-22T10:00:00.000Z" });
    });

    it("submits every page once, then only what a deploy changed or removed", async () => {
      const all = await sitePageContents({ PUBLIC_URL: ORIGIN });
      const s = await t.run();
      expect(s).toMatchObject({ status: 200, error: null, urls: all.size });
      expect(t.sent).toHaveLength(1);
      const key = await indexNowKey(t.env)!;
      expect(t.sent[0]).toMatchObject({ host: "diffinery.example", key, keyLocation: `${ORIGIN}/${key}.txt` });
      expect(new Set(paths(t.sent[0]!))).toEqual(new Set(all.keys()));
      expect(t.sent[0]!.urlList.every((u) => u.startsWith(`${ORIGIN}/`))).toBe(true);

      // Nothing changed: nothing sent.
      expect(await t.run()).toBeNull();
      expect(t.sent).toHaveLength(1);

      // A deploy that changed one page and removed another (as if they had held other content before).
      t.db.sqlite.prepare("UPDATE indexnow_urls SET hash = 'old', sent_hash = 'old' WHERE path = '/docs/quickstart'").run();
      t.db.sqlite.prepare("INSERT INTO indexnow_urls (path, kind, hash, sent_hash) VALUES ('/docs/removed', 'site', 'x', 'x'), ('/docs/never-sent', 'site', 'y', NULL)").run();
      t.db.sqlite.prepare("UPDATE indexnow_state SET v = 'older' WHERE k = 'site_fingerprint'").run();
      // The same version doesn't look again.
      expect(await t.run()).toBeNull();
      t.deploy("2026-10-22T11:00:00.000Z");
      expect(await t.run()).toMatchObject({ status: 200, urls: 2 });
      expect(paths(t.sent[1]!).sort()).toEqual(["/docs/quickstart", "/docs/removed"]);
      // A page gone and submitted is forgotten; one never submitted was forgotten without a submission.
      expect(t.db.sqlite.prepare("SELECT path FROM indexnow_urls WHERE path IN ('/docs/removed', '/docs/never-sent')").all()).toEqual([]);
      expect(await t.run()).toBeNull();
      expect(t.sent).toHaveLength(2);
    });

    it("ignores an older version that runs during a rollout", async () => {
      await t.run();
      t.db.sqlite.prepare("UPDATE indexnow_urls SET hash = 'old', sent_hash = 'old' WHERE path = '/features'").run();
      t.db.sqlite.prepare("UPDATE indexnow_state SET v = 'other' WHERE k = 'site_fingerprint'").run();
      const old = setup({ version: "2026-10-22T09:00:00.000Z" });
      (old.env as { DB: D1Database }).DB = t.env.DB;
      const fetcher = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
      expect(await indexNowCron(old.env as never, { publicRepos: async () => [] }, fetcher)).toBeNull();
      expect(t.state("site_fingerprint")?.v).toBe("other");
      // A newer version does check.
      t.deploy("2026-10-22T11:00:00.000Z");
      expect(await t.run()).toMatchObject({ urls: 1 });
      expect(paths(t.sent[1]!)).toEqual(["/features"]);
    });

    it("submits public repositories when pushed, hourly, and never a private one", async () => {
      t.setRepos([
        { owner_login: "acme", name: "app", pushed_at: "2026-10-22T09:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
        { owner_login: "acme", name: "lib", pushed_at: null, updated_at: "2026-10-02T00:00:00Z" },
      ]);
      await t.run();
      expect(paths(t.sent[0]!)).toEqual(expect.arrayContaining(["/acme/app", "/acme/lib"]));
      // Pushed again within the hour: waits for the hourly check.
      t.setRepos([
        { owner_login: "acme", name: "app", pushed_at: "2026-10-22T09:30:00Z" },
        { owner_login: "acme", name: "lib", pushed_at: null, updated_at: "2026-10-02T00:00:00Z" },
      ]);
      expect(await t.run()).toBeNull();
      t.age(3600_000);
      expect(await t.run()).toMatchObject({ urls: 1 });
      expect(paths(t.sent[1]!)).toEqual(["/acme/app"]);
      // acme/app went private (publicRepos no longer lists it) after a push: never submitted, and forgotten.
      t.db.sqlite.prepare("UPDATE indexnow_urls SET hash = 'pushed-again' WHERE path = '/acme/app'").run();
      t.setRepos([{ owner_login: "acme", name: "lib", pushed_at: null, updated_at: "2026-10-02T00:00:00Z" }]);
      t.age(3600_000);
      expect(await t.run()).toBeNull();
      expect(t.sent).toHaveLength(2);
      expect(t.db.sqlite.prepare("SELECT path FROM indexnow_urls WHERE kind = 'repo'").all()).toEqual([{ path: "/acme/lib" }]);
      // A queued repository is only submitted in a run that saw it public.
      t.db.sqlite.prepare("UPDATE indexnow_urls SET sent_hash = NULL WHERE path = '/acme/lib'").run();
      t.db.sqlite.prepare("UPDATE indexnow_urls SET sent_hash = 'old' WHERE path = '/features'").run();
      t.db.sqlite.prepare("INSERT INTO indexnow_state (k, v) VALUES ('retry_at', '2000-01-01T00:00:00Z')").run();
      expect(await t.run()).toMatchObject({ urls: 1 });
      expect(paths(t.sent[2]!)).toEqual(["/features"]);
    });

    it("keeps pages queued after a refusal and waits before trying again", async () => {
      t.setStatus(429);
      const s = await t.run();
      // Every endpoint was tried once, in order.
      expect(t.urls).toEqual(INDEXNOW_ENDPOINTS);
      expect(s).toMatchObject({ status: 429, endpoint: "yandex.com", error: "after api.indexnow.org 429 (nope); www.bing.com 429 (nope): nope" });
      const retry = Date.parse(t.state("retry_at")!.v);
      expect(retry - Date.now()).toBeGreaterThan(RETRY_MS.rateLimited - 60_000);
      // Waiting: nothing sent.
      expect(await t.run()).toBeNull();
      expect(t.sent).toHaveLength(3);
      // Once the wait is over, the same pages go again.
      t.setStatus(202);
      t.age(RETRY_MS.rateLimited);
      expect(await t.run()).toMatchObject({ status: 202, urls: s!.urls });
      expect(t.state("retry_at")).toBeUndefined();
      expect(await t.run()).toBeNull();
      const st = await indexNowStatus(t.env as never);
      expect(st).toMatchObject({ off: null, queued: 0, retryAt: null });
      expect(st.submissions.map((x) => [x.status, x.endpoint])).toEqual([
        [202, "api.indexnow.org"],
        [429, "yandex.com"],
      ]);
    });

    it("tries the next endpoint when one rate-limits or fails, but not after a refusal", async () => {
      t.setStatus((url) => (url.includes("api.indexnow.org") ? 429 : 200));
      const s = await t.run();
      expect(s).toMatchObject({ status: 200, endpoint: "www.bing.com", error: "after api.indexnow.org 429 (nope)" });
      expect(t.urls).toEqual(INDEXNOW_ENDPOINTS.slice(0, 2));
      // The pages count as submitted.
      expect(await t.run()).toBeNull();
      // A 403 (key not valid) or 422 is the same everywhere: no other endpoint is tried.
      t.db.sqlite.prepare("UPDATE indexnow_urls SET sent_hash = 'old' WHERE path = '/features'").run();
      t.db.sqlite.prepare("INSERT INTO indexnow_state (k, v) VALUES ('retry_at', '2000-01-01T00:00:00Z')").run();
      t.setStatus(403);
      expect(await t.run()).toMatchObject({ status: 403, endpoint: "api.indexnow.org", error: "nope" });
      expect(t.urls).toHaveLength(3);
      expect(Date.parse(t.state("retry_at")!.v) - Date.now()).toBeGreaterThan(RETRY_MS.refused - 60_000);
    });

    it("never throws when IndexNow can't be reached, and tries again later", async () => {
      const fetcher = (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch;
      const s = await indexNowCron(t.env as never, { publicRepos: async () => [] }, fetcher);
      expect(s).toMatchObject({ status: null, endpoint: "yandex.com" });
      expect(s!.error).toMatch(/^after api.indexnow.org unreachable \(TypeError: network down\); www.bing.com unreachable .*: TypeError: network down$/);
      expect(Date.parse(t.state("retry_at")!.v)).toBeGreaterThan(Date.now());
      // A broken database is logged, not thrown.
      const broken = { ...t.env, DB: { prepare: () => { throw new Error("D1 down"); } } };
      expect(await indexNowCron(broken as never, { publicRepos: async () => [] }, fetcher)).toBeNull();
    });

    it("sends at most MAX_URLS in one submission, and the rest in the next run", async () => {
      const many = Array.from({ length: MAX_URLS }, (_, i) => ({ owner_login: "o", name: `r${i}`, pushed_at: "2026-10-22T09:00:00Z" }));
      t.setRepos(many);
      const site = (await sitePageContents({ PUBLIC_URL: ORIGIN })).size;
      // checkRepos reads at most MAX_REPOS; the fake hands back them all, which stands in for a large queue.
      expect(await t.run()).toMatchObject({ urls: MAX_URLS });
      expect(await t.run()).toBeNull(); // repositories wait for the next hourly check
      t.age(3600_000);
      expect(await t.run()).toMatchObject({ urls: site });
      expect(await t.run()).toBeNull();
    });
  });

  it("/api/v3/meta says whether IndexNow is on and how the last submission went", async () => {
    const t = setup();
    await t.run();
    const res = await app.fetch(new Request(`${ORIGIN}/api/v3/meta`), t.env, ctx);
    const meta = (await res.json()) as { indexnow: { enabled: boolean; key_location: string; last_submission: { urls: number; status: number } } };
    expect(meta.indexnow).toMatchObject({ enabled: true, key_location: `${ORIGIN}/${await indexNowKey(t.env)!}.txt`, last_submission: { status: 200 } });
    expect(JSON.stringify(meta)).not.toContain("/docs/");
  });
});
