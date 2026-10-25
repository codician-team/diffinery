/**
 * Account recovery by email (/auth/access, behind Cloudflare Access) signs out every other browser of the
 * account and leaves its access tokens alone; a signed-in person confirming it's them keeps their other
 * browsers. Runs the real router over node:sqlite with every migration, and a stand-in for Access's keys.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import { web } from "../../src/web/routes.js";
import type { Env } from "../../src/env.js";
import { testD1 } from "./stubs/d1.js";

app.route("/", web);

const ORIGIN = "https://diffinery.example";
const TEAM = "team.example";
const AUD = "recovery-aud";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");

let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid?: string };

/** A Cloudflare Access assertion for `email`, signed with the stand-in key. */
async function assertion(email: string): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const body = b64url(JSON.stringify({ email, aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 300 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

function setup() {
  const DB = testD1();
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  DB.sqlite.exec(`INSERT INTO accounts (id, login, kind, name, email, status, created_at) VALUES ('u-ana', 'ana', 'user', 'Ana', 'ana@example.com', 'active', '${at}')`);
  for (const cookie of ["ana-laptop-session-000000000001", "ana-phone-session-0000000000002"]) {
    DB.sqlite.exec(`INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('${hash(cookie)}', 'u-ana', 'passkey', '${at}', '${at}', '${later}')`);
  }
  DB.sqlite.exec(`INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('t-ana', 'u-ana', 'ci', '${hash("dfy_ana")}', 'dfy_ana', '["write"]', '${later}', '${at}')`);
  const env = { PUBLIC_URL: ORIGIN, DB, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, BOOTSTRAP_ADMINS: "" } as unknown as Env;
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const get = async (path: string, headers: Record<string, string>) => {
    const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, ctx);
    await Promise.allSettled(waits);
    return res;
  };
  const sessions = () => (DB.sqlite.prepare("SELECT id FROM sessions WHERE account_id = 'u-ana'").all() as Array<{ id: string }>).map((s) => s.id);
  const audit = () => DB.sqlite.prepare("SELECT action, detail FROM audit_log ORDER BY at").all() as Array<{ action: string; detail: string | null }>;
  const tokenRevoked = () => (DB.sqlite.prepare("SELECT revoked_at FROM tokens WHERE id = 't-ana'").get() as { revoked_at: string | null }).revoked_at;
  return { get, sessions, audit, tokenRevoked };
}

describe("account recovery by email", () => {
  // Generated once: the Worker caches Access's keys by id.
  beforeAll(async () => {
    keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      return real(input, init);
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it("signs out every other browser, keeps access tokens, and says so", async () => {
    const t = setup();
    expect(t.sessions()).toHaveLength(2);
    const res = await t.get("/auth/access?next=/settings", { "cf-access-jwt-assertion": await assertion("ana@example.com") });
    expect(res.status).toBe(302);
    const cookie = /__Host-dfy_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(cookie).toBeTruthy();
    // Only the browser that just recovered the account is signed in.
    expect(t.sessions()).toEqual([hash(cookie!)]);
    expect(t.tokenRevoked()).toBeNull();
    // The notice travels in the flash cookie (encoded twice).
    expect(decodeURIComponent(decodeURIComponent(res.headers.get("set-cookie") ?? ""))).toMatch(/Every other browser signed in to your account was signed out; your access tokens keep working/);
    expect(t.audit().find((a) => a.action === "session.revoke_others")?.detail).toMatch(/"via":"access","sessions":2/);
  });

  it("keeps the other browsers when someone already signed in confirms it's them", async () => {
    const t = setup();
    const res = await t.get("/auth/access?next=/settings", { "cf-access-jwt-assertion": await assertion("ana@example.com"), cookie: "__Host-dfy_session=ana-laptop-session-000000000001" });
    expect(res.status).toBe(302);
    const cookie = /__Host-dfy_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    // The confirming browser's old session is replaced by a fresh one; the phone stays signed in.
    expect(t.sessions().sort()).toEqual([hash(cookie!), hash("ana-phone-session-0000000000002")].sort());
    expect(t.audit().some((a) => a.action === "session.revoke_others")).toBe(false);
  });
});
