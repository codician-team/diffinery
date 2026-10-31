import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import type { Principal } from "../../src/auth/principal.js";
import { bucketsFor, MODEL_RATE_LIMIT, modelRateLimited, overLimit, RATE_LIMITER_SHARDS, rateLimiterShard, RATE_LIMITS, RATE_PERIOD_S, type RateLimiter } from "../../src/lib/rate-limit.js";
import { RateLimiterDO } from "../../src/rate-limiter.js";

const anon: Principal = { type: "anonymous" };
const person = { type: "account", account: { id: "u1" }, via: "token", scopes: ["write"], repoIds: null } as unknown as Principal;
const job = { type: "job", repoId: "r1" } as unknown as Principal;

/** A limiter that allows `n` calls per key. */
function limiter(n: number): RateLimiter & { seen: string[] } {
  const counts = new Map<string, number>();
  const seen: string[] = [];
  return {
    seen,
    async limit({ key }) {
      seen.push(key);
      const c = (counts.get(key) ?? 0) + 1;
      counts.set(key, c);
      return { success: c <= n };
    },
  };
}

describe("rate limit buckets", () => {
  it("counts sign-in attempts per IP address, and other anonymous requests separately", () => {
    expect(bucketsFor("POST", "/auth/passkey/login/options", anon, "203.0.113.9")).toEqual([["RL_AUTH", "ip:203.0.113.9"]]);
    expect(bucketsFor("POST", "/invite/abc/email", anon, "203.0.113.9")).toEqual([["RL_AUTH", "ip:203.0.113.9"]]);
    expect(bucketsFor("POST", "/signup", anon, "203.0.113.9")).toEqual([["RL_AUTH", "ip:203.0.113.9"]]);
    expect(bucketsFor("POST", "/signup/verify", anon, "203.0.113.9")).toEqual([["RL_AUTH", "ip:203.0.113.9"]]);
    // Security reports, signed in or not, count per IP address like sign-up.
    expect(bucketsFor("POST", "/security/report", anon, "203.0.113.9")).toEqual([["RL_AUTH", "ip:203.0.113.9"]]);
    for (const path of ["/early-access", "/early-access/confirm", "/early-access/remove", "/early-access/remove/confirm"]) expect(bucketsFor("POST", path, anon, "203.0.113.9"), path).toEqual([["RL_AUTH", "ip:203.0.113.9"]]);
    expect(bucketsFor("GET", "/early-access", anon, "203.0.113.9")).toEqual([["RL_ANON", "ip:203.0.113.9"]]);
    expect(bucketsFor("POST", "/security/report", person, "203.0.113.9")).toEqual([["RL_AUTH", "ip:203.0.113.9"]]);
    expect(bucketsFor("GET", "/security/report", anon, "203.0.113.9")).toEqual([["RL_ANON", "ip:203.0.113.9"]]);
    expect(bucketsFor("GET", "/signup", anon, "203.0.113.9")).toEqual([["RL_ANON", "ip:203.0.113.9"]]);
    expect(bucketsFor("GET", "/login", anon, "203.0.113.9")).toEqual([["RL_ANON", "ip:203.0.113.9"]]);
    expect(bucketsFor("GET", "/api/v3/repos/acme/app", anon, "203.0.113.9")).toEqual([["RL_ANON", "ip:203.0.113.9"]]);
    expect(bucketsFor("GET", "/acme/app.git/info/refs", anon, "198.51.100.1")).toEqual([["RL_ANON", "ip:198.51.100.1"]]);
  });

  it("counts a signed-in account's requests, and its new issues, comments and repositories again", () => {
    expect(bucketsFor("GET", "/api/v3/user/repos", person, "x")).toEqual([["RL_ACCOUNT", "acct:u1"]]);
    for (const [m, path] of [
      ["POST", "/api/v3/user/repos"],
      ["POST", "/api/v3/orgs/acme/repos"],
      ["POST", "/api/v3/user/orgs"],
      ["POST", "/api/v3/repos/acme/app/issues"],
      ["POST", "/api/v3/repos/acme/app/issues/3/comments"],
      ["POST", "/api/v3/repos/acme/app/pulls/4/reviews"],
      ["POST", "/api/v3/repos/acme/app/pulls/4/comments/9/replies"],
      ["POST", "/api/v3/repos/acme/app/commits/abc123/comments"],
      ["POST", "/new"],
      ["POST", "/acme/app/issues"],
      ["POST", "/acme/app/issues/3/comment"],
      ["POST", "/acme/app/pull/4/review"],
      ["POST", "/api/v3/diffinery/reports"],
      ["POST", "/-/report"],
    ]) expect(bucketsFor(m!, path!, person, "x"), path).toEqual([["RL_ACCOUNT", "acct:u1"], ["RL_CREATE", "acct:u1"]]);
    expect(bucketsFor("PATCH", "/api/v3/repos/acme/app/issues/3", person, "x")).toEqual([["RL_ACCOUNT", "acct:u1"]]);
  });

  it("leaves runners, the Actions runtime, health checks and avatars alone", () => {
    for (const path of ["/healthz", "/api/avatars/u1", "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact", "/_runtime/x", "/runner/jobs/claim", "/-/model/anthropic/v1/messages"]) expect(bucketsFor("POST", path, anon, "x"), path).toEqual([]);
    expect(bucketsFor("GET", "/api/v3/repos/acme/app", job, "x")).toEqual([]);
  });
});

describe("rate limit checks", () => {
  it("refuses once a bucket is used up, per key", async () => {
    const rl = limiter(2);
    const env = { RL_ANON: rl } as unknown as Env;
    const a = bucketsFor("GET", "/", anon, "203.0.113.9");
    expect(await overLimit(env, a)).toBeNull();
    expect(await overLimit(env, a)).toBeNull();
    expect(await overLimit(env, a)).toBe("RL_ANON");
    expect(await overLimit(env, bucketsFor("GET", "/", anon, "203.0.113.10"))).toBeNull();
  });

  it("names the create bucket when an account's general budget still has room", async () => {
    const env = { RL_ACCOUNT: limiter(100), RL_CREATE: limiter(1) } as unknown as Env;
    const b = bucketsFor("POST", "/api/v3/repos/acme/app/issues", person, "x");
    expect(await overLimit(env, b)).toBeNull();
    expect(await overLimit(env, b)).toBe("RL_CREATE");
  });

  it("lets requests through when no limiter is configured or the limiter fails", async () => {
    expect(await overLimit({} as Env, [["RL_ANON", "ip:x"]])).toBeNull();
    const broken = { RL_ANON: { limit: async () => Promise.reject(new Error("down")) } } as unknown as Env;
    expect(await overLimit(broken, [["RL_ANON", "ip:x"]])).toBeNull();
  });

  it("matches the limits configured for production", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    for (const [name, limit] of Object.entries(RATE_LIMITS)) {
      const line = text.split("\n").find((l) => l.includes(`"name": "${name}"`)) ?? "";
      const m = /"limit": (\d+), "period": (\d+)/.exec(line);
      expect(m, name).not.toBeNull();
      expect([Number(m![1]), Number(m![2])], name).toEqual([limit, RATE_PERIOD_S]);
    }
  });
});

describe("rate limits in the Worker", () => {
  // Importing the whole Worker takes a few seconds when the suite runs in parallel.
  it("answers 429 with retry-after once an anonymous address is over its limit", { timeout: 30_000 }, async () => {
    const { app } = await import("../../src/app.js");
    const env = { DB: {}, PUBLIC_URL: "https://d.example", RL_ANON: limiter(1) } as unknown as Env;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const get = () => app.request("/healthz-not-exempt", { headers: { "cf-connecting-ip": "203.0.113.9" } }, env, ctx);
    expect((await get()).status).toBe(404);
    const r = await get();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(r.headers.get("strict-transport-security")).toBeTruthy();
    expect(((await r.json()) as { message: string }).message).toMatch(/at most 300 a minute/);
  });
});

describe("model requests per paying person (phase 5a)", () => {
  it("counts per person, and lets requests through without a binding or when it fails", async () => {
    const rl = limiter(2);
    const env = { RL_MODEL: rl } as unknown as Env;
    expect(await modelRateLimited(env, "p1")).toBe(false);
    expect(await modelRateLimited(env, "p1")).toBe(false);
    expect(await modelRateLimited(env, "p1")).toBe(true);
    expect(await modelRateLimited(env, "p2")).toBe(false);
    expect(rl.seen).toEqual(["model:p1", "model:p1", "model:p1", "model:p2"]);
    expect(await modelRateLimited({} as Env, "p1")).toBe(false);
    const broken = { RL_MODEL: { limit: async () => { throw new Error("down"); } } } as unknown as Env;
    expect(await modelRateLimited(broken, "p1")).toBe(false);
  });

  it("matches wrangler.jsonc, and the model proxy is not in the per-account buckets", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const line = text.split("\n").find((l) => l.includes('"name": "RL_MODEL"')) ?? "";
    expect(/"limit": (\d+), "period": (\d+)/.exec(line)?.slice(1).map(Number)).toEqual([MODEL_RATE_LIMIT, RATE_PERIOD_S]);
    expect(bucketsFor("POST", "/-/model/anthropic/v1/messages", person, "203.0.113.9")).toEqual([]);
  });
});

/** A RATE_LIMITER namespace of real RateLimiterDO objects, recording which object each call reached. */
function limiterObjects(fail = false) {
  const objects = new Map<string, RateLimiterDO>();
  const calls: string[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      hit: async (key: string, limits: Array<[string, number]>) => {
        calls.push(name);
        if (fail) throw new Error("object unreachable");
        if (!objects.has(name)) objects.set(name, new RateLimiterDO({} as DurableObjectState, {} as Env));
        return objects.get(name)!.hit(key, limits);
      },
    }),
  };
  return { ns, calls };
}

describe("the Durable Object fallback (RATE_LIMITS=durable)", () => {
  afterEach(() => vi.useRealTimers());

  it("counts buckets without a binding at the production limits, one object call per request", async () => {
    const { ns, calls } = limiterObjects();
    const env = { RATE_LIMITS: "durable", RATE_LIMITER: ns } as unknown as Env;
    const sign = bucketsFor("POST", "/signup", anon, "203.0.113.9");
    for (let i = 0; i < RATE_LIMITS.RL_AUTH; i++) expect(await overLimit(env, sign)).toBeNull();
    expect(await overLimit(env, sign)).toBe("RL_AUTH");
    expect(await overLimit(env, bucketsFor("POST", "/signup", anon, "203.0.113.10"))).toBeNull();
    // An account's request and its new content share a key: one call counts both buckets.
    calls.length = 0;
    const create = bucketsFor("POST", "/api/v3/repos/acme/app/issues", person, "x");
    for (let i = 0; i < RATE_LIMITS.RL_CREATE; i++) expect(await overLimit(env, create)).toBeNull();
    expect(await overLimit(env, create)).toBe("RL_CREATE");
    expect(calls).toHaveLength(RATE_LIMITS.RL_CREATE + 1);
    expect(new Set(calls)).toEqual(new Set([rateLimiterShard("acct:u1")]));
  });

  it("starts a new count every window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12, 0, 0));
    const { ns } = limiterObjects();
    const env = { RATE_LIMITS: "durable", RATE_LIMITER: ns } as unknown as Env;
    const b = bucketsFor("POST", "/signup", anon, "203.0.113.9");
    for (let i = 0; i < RATE_LIMITS.RL_AUTH; i++) await overLimit(env, b);
    expect(await overLimit(env, b)).toBe("RL_AUTH");
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12, 0, RATE_PERIOD_S - 1));
    expect(await overLimit(env, b)).toBe("RL_AUTH");
    vi.setSystemTime(Date.UTC(2026, 9, 30, 12, 0, RATE_PERIOD_S));
    expect(await overLimit(env, b)).toBeNull();
  });

  it("limits model requests per paying person", async () => {
    const { ns } = limiterObjects();
    const env = { RATE_LIMITS: "durable", RATE_LIMITER: ns } as unknown as Env;
    for (let i = 0; i < MODEL_RATE_LIMIT; i++) expect(await modelRateLimited(env, "p1")).toBe(false);
    expect(await modelRateLimited(env, "p1")).toBe(true);
    expect(await modelRateLimited(env, "p2")).toBe(false);
  });

  it("uses a binding where there is one, and is off unless RATE_LIMITS is durable", async () => {
    const { ns, calls } = limiterObjects();
    const bound = { RATE_LIMITS: "durable", RATE_LIMITER: ns, RL_ANON: limiter(1) } as unknown as Env;
    expect(await overLimit(bound, [["RL_ANON", "ip:x"]])).toBeNull();
    expect(await overLimit(bound, [["RL_ANON", "ip:x"]])).toBe("RL_ANON");
    expect(await modelRateLimited({ RATE_LIMITER: ns } as unknown as Env, "p1")).toBe(false);
    expect(await overLimit({ RATE_LIMITER: ns } as unknown as Env, [["RL_AUTH", "ip:x"]])).toBeNull();
    expect(calls).toEqual([]);
  });

  it("lets requests through when the object fails", async () => {
    const { ns, calls } = limiterObjects(true);
    const env = { RATE_LIMITS: "durable", RATE_LIMITER: ns } as unknown as Env;
    expect(await overLimit(env, [["RL_AUTH", "ip:x"]])).toBeNull();
    expect(await modelRateLimited(env, "p1")).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("spreads keys over a fixed set of objects", () => {
    const shards = new Set(Array.from({ length: 2000 }, (_, i) => rateLimiterShard(`ip:198.51.${i >> 8}.${i & 255}`)));
    expect(shards.size).toBe(RATE_LIMITER_SHARDS);
    expect(rateLimiterShard("acct:u1")).toBe(rateLimiterShard("acct:u1"));
  });

  it("is bound in wrangler.jsonc, for production and local development", () => {
    const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(text.match(/\{ "name": "RATE_LIMITER", "class_name": "RateLimiterDO" \}/g)).toHaveLength(2);
    expect(text).toMatch(/"new_sqlite_classes": \["RateLimiterDO"\]/);
  });
});
