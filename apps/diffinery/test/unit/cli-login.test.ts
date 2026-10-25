/**
 * Signing the CLI in through the browser (auth/cli-login.ts): the loopback flow with PKCE, the device
 * code flow, single use, expiry, denial, the recent sign-in rule, and `diffinery logout` revoking only
 * CLI tokens. Runs the real router over node:sqlite with every migration.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { web } from "../../src/web/routes.js";
import type { Env } from "../../src/env.js";
import { cleanClient, formatUserCode, normalizeUserCode, pkceChallenge } from "../../src/auth/cli-login.js";
import { placeMismatch, preselectedScope } from "../../src/web/cli-login.js";
import { bucketsFor } from "../../src/lib/rate-limit.js";
import { testD1 } from "./stubs/d1.js";

app.route("/", web);

const ORIGIN = "https://diffinery.example";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const CSRF = "csrf-token-0123456789abcdef";

function setup() {
  const DB = testD1();
  const at = new Date().toISOString();
  const old = new Date(Date.now() - 5 * 3600_000).toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  DB.sqlite.exec(`INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('u-ana', 'ana', 'user', 'Ana', 'ana@example.com', 'active', '${at}')`);
  DB.sqlite.exec(`INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash("ana-fresh-session-0000000000001")}', 'u-ana', 'passkey', '${at}', '${at}', '${later}')`);
  DB.sqlite.exec(`INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash("ana-stale-session-0000000000002")}', 'u-ana', 'passkey', '${old}', '${at}', '${later}')`);
  DB.sqlite.exec(`INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('t-ci', 'u-ana', 'ci', '${hash("dfy_ana_ci")}', 'dfy_ana_ci', '["write"]', '${later}', '${at}')`);
  const env = { PUBLIC_URL: ORIGIN, DB, BOOTSTRAP_ADMINS: "" } as unknown as Env;
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  // `cf` stands in for the edge's request.cf, which a Worker gets and a client can't set.
  const fetch = async (path: string, { cf, ...init }: RequestInit & { cf?: Record<string, string> } = {}) => {
    const req = new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init });
    if (cf) Object.defineProperty(req, "cf", { value: cf });
    const res = await app.fetch(req, env, ctx);
    await Promise.allSettled(waits);
    return res;
  };
  const browser = (session = "ana-fresh-session-0000000000001") => ({
    get: (path: string) => fetch(path, { headers: { cookie: `__Host-dfy_session=${session}; dfy_csrf=${CSRF}` } }),
    post: (path: string, form: Record<string, string>) => {
      const body = new URLSearchParams({ _csrf: CSRF, ...form }).toString();
      return fetch(path, { method: "POST", headers: { cookie: `__Host-dfy_session=${session}; dfy_csrf=${CSRF}`, "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)), origin: ORIGIN, "sec-fetch-site": "same-origin" }, body });
    },
  });
  const cli = (path: string, body: unknown, method = "POST", token?: string) => fetch(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === "DELETE" ? undefined : JSON.stringify(body) });
  const tokens = () => DB.sqlite.prepare("SELECT id, name, scopes, client, revoked_at FROM tokens WHERE account_id = 'u-ana' ORDER BY created_at").all() as Array<{ id: string; name: string; scopes: string; client: string | null; revoked_at: string | null }>;
  return { DB, fetch, browser, cli, tokens };
}

/** What the CLI does before opening the browser. */
async function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  return { verifier, state, challenge: await pkceChallenge(verifier) };
}

const authorizeUrl = (p: { state: string; challenge: string }, extra: Record<string, string> = {}) =>
  `/login/cli?${new URLSearchParams({ port: "53123", state: p.state, code_challenge: p.challenge, code_challenge_method: "S256", scope: "write", host: "ana-laptop", os: "darwin-arm64", version: "0.1.0", ...extra })}`;

describe("CLI sign-in in the browser", () => {
  it("shows who is asking, and sends the approval to the CLI's callback on 127.0.0.1 only", async () => {
    const t = setup();
    const p = await pkce();
    const page = await t.browser().get(authorizeUrl(p));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Authorize the Diffinery CLI");
    expect(html).toContain("ana-laptop");
    expect(html).toContain("darwin-arm64");
    // The page's forms may lead to the CLI's port, nowhere else.
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:53123;");
    expect(page.headers.get("x-frame-options")).toBe("DENY");

    const res = await t.browser().post("/login/cli", { port: "53123", state: p.state, code_challenge: p.challenge, host: "ana-laptop", os: "darwin-arm64", version: "0.1.0", scope: "admin", decision: "approve" });
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("http://127.0.0.1:53123");
    expect(to.pathname).toBe("/callback");
    expect(to.searchParams.get("state")).toBe(p.state);
    const code = to.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(40);
    // Nothing is minted until the CLI trades the code.
    expect(t.tokens().filter((k) => k.client === "cli")).toHaveLength(0);

    // The code alone is useless: a wrong verifier burns it.
    const wrong = await t.cli("/-/cli/token", { grant_type: "authorization_code", code, code_verifier: randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()) as unknown).toMatchObject({ error: "invalid_grant" });
    const after = await t.cli("/-/cli/token", { grant_type: "authorization_code", code, code_verifier: p.verifier });
    expect(((await after.json()) as { error: string }).error).toBe("invalid_grant");
    expect(t.tokens().filter((k) => k.client === "cli")).toHaveLength(0);
  });

  it("trades the code and verifier for a CLI token once, with the scope the person chose", async () => {
    const t = setup();
    const p = await pkce();
    const res = await t.browser().post("/login/cli", { port: "53123", state: p.state, code_challenge: p.challenge, host: "ana-laptop", os: "linux-x64", version: "0.1.0", scope: "read", decision: "approve" });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const ok = await t.cli("/-/cli/token", { grant_type: "authorization_code", code, code_verifier: p.verifier });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = (await ok.json()) as { access_token: string; scope: string; login: string; expires_at: string };
    // Letters and digits after the prefix, so `gh auth status` masks all of it.
    expect(body.access_token).toMatch(/^dfy_[A-Za-z0-9]{40}$/);
    expect(body).toMatchObject({ scope: "read", login: "ana" });
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(89 * 86400_000);
    const cli = t.tokens().find((k) => k.client === "cli")!;
    expect(cli).toMatchObject({ name: "Diffinery CLI on ana-laptop", scopes: '["read"]', revoked_at: null });
    // The token works, as the person, with its scope.
    const me = await t.fetch("/api/v3/user", { headers: { authorization: `Bearer ${body.access_token}` } });
    expect(((await me.json()) as { login: string }).login).toBe("ana");
    // Single use.
    const again = await t.cli("/-/cli/token", { grant_type: "authorization_code", code, code_verifier: p.verifier });
    expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
    // It shows up in Settings → Access tokens as a CLI sign-in.
    const list = await (await t.browser().get("/settings/tokens")).text();
    expect(list).toContain("Diffinery CLI on ana-laptop");
    expect(list).toContain("CLI sign-in");
    // The sign-in is audited.
    const audit = t.DB.sqlite.prepare("SELECT detail FROM audit_log WHERE action = 'token.create'").all() as Array<{ detail: string }>;
    expect(audit.map((a) => a.detail).join()).toContain("cli browser sign-in");
  });

  it("Cancel tells the CLI it was denied and creates nothing", async () => {
    const t = setup();
    const p = await pkce();
    const res = await t.browser().post("/login/cli", { port: "53123", state: p.state, code_challenge: p.challenge, host: "h", decision: "deny" });
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("http://127.0.0.1:53123");
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: "access_denied", state: p.state });
    expect(t.DB.sqlite.prepare("SELECT count(*) AS n FROM cli_logins").get()).toEqual({ n: 0 });
  });

  it("needs a recent passkey sign-in, and sends signed-out people to sign in first", async () => {
    const t = setup();
    const p = await pkce();
    const stale = await t.browser("ana-stale-session-0000000000002").get(authorizeUrl(p));
    expect(stale.status).toBe(303);
    const confirm = new URL(stale.headers.get("location")!, ORIGIN);
    expect(confirm.pathname).toBe("/login");
    expect(confirm.searchParams.get("confirm")).toBe("1");
    expect(confirm.searchParams.get("next")).toBe(authorizeUrl(p));
    const post = await t.browser("ana-stale-session-0000000000002").post("/login/cli", { port: "53123", state: p.state, code_challenge: p.challenge, decision: "approve" });
    expect(new URL(post.headers.get("location")!, ORIGIN).pathname).toBe("/login");
    expect(t.DB.sqlite.prepare("SELECT count(*) AS n FROM cli_logins").get()).toEqual({ n: 0 });

    const anon = await t.fetch(authorizeUrl(p));
    expect(anon.status).toBe(302);
    expect(new URL(anon.headers.get("location")!, ORIGIN).searchParams.get("next")).toBe(authorizeUrl(p));
  });

  it("refuses links that could send the code anywhere but a local port", async () => {
    const t = setup();
    const p = await pkce();
    for (const extra of [{ port: "80" }, { port: "70000" }, { port: "53123@evil.example" }, { code_challenge: "short" }, { code_challenge_method: "plain" }, { state: "" }]) {
      const res = await t.browser().get(authorizeUrl(p, extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(await res.text()).toContain("This sign-in link is incomplete");
    }
    const res = await t.browser().post("/login/cli", { port: "22", state: p.state, code_challenge: p.challenge, decision: "approve" });
    expect(res.status).toBe(400);
  });

  it("a token can't approve: the form needs a browser", async () => {
    const t = setup();
    const p = await pkce();
    const body = new URLSearchParams({ port: "53123", state: p.state, code_challenge: p.challenge, decision: "approve" }).toString();
    const res = await t.fetch("/login/cli", { method: "POST", headers: { authorization: "Bearer dfy_ana_ci", "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) }, body });
    expect(res.status).toBe(403);
  });
});

describe("CLI sign-in with a device code", () => {
  const start = async (t: ReturnType<typeof setup>, scope = "write") => {
    const r = await t.cli("/-/cli/device", { client: { host: "build-box", os: "linux-x64", version: "0.1.0" }, scope });
    expect(r.status).toBe(200);
    return (await r.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
  };
  const poll = async (t: ReturnType<typeof setup>, device_code: string) => (await t.cli("/-/cli/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code })).json() as Promise<Record<string, string>>;

  it("waits for the person, then hands the CLI its token once", async () => {
    const t = setup();
    const d = await start(t);
    expect(d.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(d.verification_uri).toBe(`${ORIGIN}/login/device`);
    expect(d).not.toHaveProperty("verification_uri_complete");
    expect(d).toMatchObject({ expires_in: 600, interval: 5 });
    expect((await poll(t, d.device_code)).error).toBe("authorization_pending");

    // Typed in any case, with or without the dash.
    const page = await t.browser().post("/login/device", { code: d.user_code.replace("-", "").toLowerCase() });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("build-box");
    expect(html).toContain(d.user_code);
    const id = /name="id" value="([^"]+)"/.exec(html)![1]!;
    const done = await t.browser().post("/login/device/decide", { id, scope: "admin", decision: "approve" });
    expect(await done.text()).toMatch(/You(&#39;|')re signed in/);

    const got = await poll(t, d.device_code);
    expect(got.access_token).toMatch(/^dfy_/);
    expect(got).toMatchObject({ scope: "admin", login: "ana" });
    expect((await poll(t, d.device_code)).error).toBe("invalid_grant");
    // Approving again changes nothing.
    expect(await (await t.browser().post("/login/device/decide", { id, decision: "approve" })).text()).toContain("already answered");
  });

  it("tells the CLI when the person cancels, and an unknown code finds nothing", async () => {
    const t = setup();
    const d = await start(t, "read");
    const html = await (await t.browser().post("/login/device", { code: d.user_code })).text();
    const id = /name="id" value="([^"]+)"/.exec(html)![1]!;
    await t.browser().post("/login/device/decide", { id, decision: "deny" });
    expect((await poll(t, d.device_code)).error).toBe("access_denied");
    expect((await poll(t, "not-a-device-code")).error).toBe("invalid_grant");
    const unknown = await t.browser().post("/login/device", { code: "BCDF-GHJK" });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toMatch(/isn(&#39;|')t valid or has expired/);
  });

  it("expires", async () => {
    const t = setup();
    const d = await start(t);
    t.DB.sqlite.exec(`UPDATE cli_logins SET expires_at = '${new Date(Date.now() - 1000).toISOString()}'`);
    expect((await poll(t, d.device_code)).error).toBe("expired_token");
    expect((await t.browser().post("/login/device", { code: d.user_code })).status).toBe(404);
  });

  it("refuses an unknown scope and counts starts against the sign-in rate limit", async () => {
    const t = setup();
    expect((await t.cli("/-/cli/device", { scope: "root" })).status).toBe(422);
    expect(bucketsFor("POST", "/-/cli/device", { type: "anonymous" }, "203.0.113.1")).toEqual([["RL_AUTH", "ip:203.0.113.1"]]);
    expect(bucketsFor("POST", "/login/device", { type: "anonymous" }, "203.0.113.1")).toEqual([["RL_AUTH", "ip:203.0.113.1"]]);
  });
});

describe("diffinery logout", () => {
  it("revokes a CLI token with itself, and leaves other tokens alone", async () => {
    const t = setup();
    const p = await pkce();
    const res = await t.browser().post("/login/cli", { port: "53123", state: p.state, code_challenge: p.challenge, host: "h", decision: "approve" });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const { access_token } = (await (await t.cli("/-/cli/token", { grant_type: "authorization_code", code, code_verifier: p.verifier })).json()) as { access_token: string };
    expect(await (await t.cli("/-/cli/token", null, "DELETE", "dfy_ana_ci")).json()).toEqual({ revoked: false });
    expect(t.tokens().find((k) => k.id === "t-ci")!.revoked_at).toBeNull();
    expect(await (await t.cli("/-/cli/token", null, "DELETE", access_token)).json()).toEqual({ revoked: true });
    expect((await t.fetch("/api/v3/user", { headers: { authorization: `Bearer ${access_token}` } })).status).toBe(401);
    expect((await t.cli("/-/cli/token", null, "DELETE")).status).toBe(401);
  });
});

describe("guards against approving someone else's sign-in", () => {
  it("never preselects admin, and says when the CLI asked for it", async () => {
    const t = setup();
    const p = await pkce();
    const html = await (await t.browser().get(authorizeUrl(p, { scope: "admin" }))).text();
    expect(html).toContain("&quot;value&quot;:&quot;write&quot;");
    expect(html).not.toContain("&quot;value&quot;:&quot;admin&quot;,&quot;items");
    expect(html).toContain("The CLI asked for Admin");
    expect(preselectedScope("admin")).toBe("write");
    expect(preselectedScope("read")).toBe("read");
    const plain = await (await t.browser().get(authorizeUrl(p))).text();
    expect(plain).not.toContain("The CLI asked for Admin");
  });

  it("warns when the device code came from another network or country", async () => {
    const t = setup();
    const r = await t.fetch("/-/cli/device", { method: "POST", cf: { city: "Lagos", country: "NG" }, headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" }, body: JSON.stringify({ client: { host: "far-away" } }) });
    const d = (await r.json()) as { user_code: string };
    const approve = (ip: string, country?: string, header?: string) =>
      t.fetch("/login/device", {
        method: "POST",
        cf: country ? { country } : undefined,
        headers: { cookie: `__Host-dfy_session=ana-fresh-session-0000000000001; dfy_csrf=${CSRF}`, "content-type": "application/x-www-form-urlencoded", "content-length": String(new URLSearchParams({ _csrf: CSRF, code: d.user_code }).toString().length), origin: ORIGIN, "cf-connecting-ip": ip, ...(header ? { "cf-ipcountry": header } : {}) },
        body: new URLSearchParams({ _csrf: CSRF, code: d.user_code }).toString(),
      });
    expect(await (await approve("198.51.100.7")).text()).toContain("from a different network (203.0.113.5)");
    expect(await (await approve("203.0.113.5")).text()).not.toContain("different network");
    // The country comes from the edge's request.cf only; a CF-IPCountry header the client sends is ignored.
    expect(await (await approve("198.51.100.7", "TR")).text()).toContain("asked for from another country</b> (Lagos, NG)");
    expect(await (await approve("198.51.100.7", "NG")).text()).not.toContain("another country");
    expect(await (await approve("198.51.100.7", undefined, "TR")).text()).not.toContain("another country");
    expect(placeMismatch({ ip: "1.1.1.1", location: "Lagos, NG" }, { ip: "2.2.2.2", country: "TR" })).toBe("country");
    expect(placeMismatch({ ip: "1.1.1.1", location: "TR" }, { ip: "2.2.2.2", country: "TR" })).toBe("network");
    expect(placeMismatch({ ip: "1.1.1.1", location: "Istanbul, TR" }, { ip: "1.1.1.1", country: "TR" })).toBeNull();
    expect(placeMismatch({ ip: null, location: null }, { ip: "1.1.1.1" })).toBeNull();
    expect(placeMismatch({ ip: "1.1.1.1", location: "Istanbul, TR" }, { ip: "2.2.2.2", country: "TR" })).toBe("network");
    expect(placeMismatch({ ip: "1.1.1.1", location: "Istanbul" }, { ip: "1.1.1.1", country: "TR" })).toBeNull();
  });
});

describe("codes and client details", () => {
  it("normalizes typed codes", () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(normalizeUserCode(" BCDF GHJK ")).toBe("BCDFGHJK");
    expect(normalizeUserCode("BCDF-GHJA")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  it("keeps what the CLI says about itself short and plain", () => {
    expect(cleanClient({ host: "<script>alert(1)</script>", os: 42, version: "0.1.0" })).toEqual({ host: "scriptalert(1)/script", os: "", version: "0.1.0" });
    expect(cleanClient({}).host).toBe("unknown host");
    expect(cleanClient({ host: "x".repeat(200) }).host).toHaveLength(64);
  });
});
