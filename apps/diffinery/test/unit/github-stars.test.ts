/**
 * The GitHub mirror's star count behind the site's "Star on GitHub" buttons (web/github-stars.ts): pages never wait
 * on GitHub, a count is shared through the colo's cache, failures keep the last count, and the numbers read like
 * GitHub's own.
 */
import { describe, expect, it } from "vitest";
import { FRESH_MS, RETRY_MS, StarCount, fetchGitHubStars, formatStars, parseBadgeCount, type Store, type Stored } from "../../src/web/github-stars.js";

function memoryStore(initial: Stored | null = null): Store & { value: Stored | null } {
  const s = {
    value: initial,
    get: async () => s.value,
    put: async (v: Stored) => void (s.value = v),
  };
  return s;
}

/** A StarCount with a hand-driven clock and GitHub, collecting its background refreshes. */
function setup(answers: Array<number | null>) {
  let now = 1_000_000;
  const asked: number[] = [];
  const count = new StarCount(
    async () => {
      asked.push(now);
      return answers.shift() ?? null;
    },
    () => now,
  );
  const pending: Promise<void>[] = [];
  const read = (store: Store) => count.read(store, (p) => pending.push(p));
  const settle = () => Promise.all(pending.splice(0));
  return { read, settle, asked, tick: (ms: number) => (now += ms), now: () => now };
}

describe("star count", () => {
  it("shows nothing until GitHub answers, without waiting for it", async () => {
    const t = setup([30]);
    const store = memoryStore();
    expect(await t.read(store)).toBeNull();
    await t.settle();
    expect(store.value).toEqual({ stars: 30, at: t.now() });
    expect(await t.read(store)).toBe(30);
    expect(t.asked).toHaveLength(1);
  });

  it("uses another isolate's count from the colo's cache, and refreshes it once it is old", async () => {
    const t = setup([31]);
    const store = memoryStore({ stars: 29, at: 1_000_000 });
    expect(await t.read(store)).toBe(29);
    await t.settle();
    expect(t.asked).toHaveLength(0);
    t.tick(FRESH_MS);
    expect(await t.read(store)).toBe(29);
    expect(await t.read(store)).toBe(29);
    await t.settle();
    expect(t.asked).toHaveLength(1);
    expect(await t.read(store)).toBe(31);
  });

  it("keeps the last count when GitHub fails, and tries again later rather than on every request", async () => {
    const t = setup([null, 40]);
    const store = memoryStore({ stars: 35, at: 1_000_000 - FRESH_MS });
    expect(await t.read(store)).toBe(35);
    await t.settle();
    expect(t.asked).toHaveLength(1);
    t.tick(RETRY_MS - 1);
    expect(await t.read(store)).toBe(35);
    await t.settle();
    expect(t.asked).toHaveLength(1);
    t.tick(1);
    await t.read(store);
    await t.settle();
    expect(t.asked).toHaveLength(2);
    expect(await t.read(store)).toBe(40);
  });

  it("doesn't retry on every request when it has never had a count", async () => {
    const t = setup([null, null]);
    const store = memoryStore();
    for (let i = 0; i < 5; i++) {
      expect(await t.read(store)).toBeNull();
      await t.settle();
    }
    expect(t.asked).toHaveLength(1);
  });
});

describe("fetching", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads stargazers_count from GitHub's REST API", async () => {
    const urls: string[] = [];
    const n = await fetchGitHubStars(async (u) => (urls.push(u), json({ stargazers_count: 29 })));
    expect(n).toBe(29);
    expect(urls).toEqual(["https://api.github.com/repos/codician-team/diffinery"]);
  });

  it("falls back to shields.io's badge when GitHub refuses, as it does when the IP address is rate limited", async () => {
    const urls: string[] = [];
    const n = await fetchGitHubStars(async (u) => (urls.push(u), u.startsWith("https://api.github.com/") ? json({ message: "API rate limit exceeded" }, 403) : json({ label: "stars", message: "1.2k" })));
    expect(n).toBe(1200);
    expect(urls[1]).toBe("https://img.shields.io/github/stars/codician-team/diffinery.json");
  });

  it("gives null when neither answers", async () => {
    expect(await fetchGitHubStars(async () => Promise.reject(new Error("offline")))).toBeNull();
    expect(await fetchGitHubStars(async (u) => (u.includes("shields") ? json({ message: "repo not found" }) : json({}, 404)))).toBeNull();
  });
});

describe("numbers", () => {
  it("parses shields.io's counts", () => {
    expect(parseBadgeCount("30")).toBe(30);
    expect(parseBadgeCount("1.2k")).toBe(1200);
    expect(parseBadgeCount("3M")).toBe(3_000_000);
    expect(parseBadgeCount("invalid")).toBeNull();
    expect(parseBadgeCount(undefined)).toBeNull();
  });

  it("formats them as GitHub's Star button does", () => {
    expect([0, 29, 999, 1000, 1049, 1234, 12_345, 123_456, 1_250_000].map(formatStars)).toEqual(["0", "29", "999", "1k", "1k", "1.2k", "12.3k", "123k", "1.2M"]);
  });
});
