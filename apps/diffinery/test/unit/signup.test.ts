import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.js";
import { CODES_PER_EMAIL_PER_DAY, CODES_PER_IP_PER_DAY, MAX_CODE_ATTEMPTS, Signups, codeHash, newCode, normalEmail, signupOpen, turnstileMode, verifyTurnstile } from "../../src/auth/signup.js";

/** A minimal D1 over node:sqlite with the sign-up tables (migration 0019) and accounts. */
function d1(): { DB: D1Database; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, login TEXT, kind TEXT, email TEXT, status TEXT)");
  db.exec(readFileSync(new URL("../../migrations/0020_signup.sql", import.meta.url), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
  });
  const DB = { prepare: (sql: string) => stmt(sql), batch: async (list: Array<ReturnType<typeof stmt>>) => Promise.all(list.map((s) => s.run())) };
  return { DB: DB as unknown as D1Database, db };
}

const setup = () => {
  const { DB, db } = d1();
  const env = { DB, PUBLIC_URL: "https://diffinery.example", MASTER_KEY: "test-master-key" } as unknown as Env;
  return { env, db, signups: new Signups(env) };
};

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe("open sign-up switch", () => {
  it("is on only for SIGNUP=open", () => {
    expect(signupOpen({ SIGNUP: "open" })).toBe(true);
    for (const v of [undefined, "", "closed", "OPEN", "true", "1"]) expect(signupOpen({ SIGNUP: v }), String(v)).toBe(false);
  });

  it("stays closed when the deploy sets Turnstile keys for the security report form", () => {
    // Every deploy sets TURNSTILE_SITE_KEY and TURNSTILE_SECRET (scripts/turnstile.sh); only SIGNUP=open opens sign-up.
    const deployed = { PUBLIC_URL: "https://diffinery.example", TURNSTILE_SITE_KEY: "0x4AAAAAAAsite", TURNSTILE_SECRET: "secret" } as Env;
    expect(turnstileMode(deployed)).toBe("verify");
    expect(signupOpen(deployed)).toBe(false);
    expect(signupOpen({ ...deployed, SIGNUP: "open" })).toBe(true);
  });

  it("needs both Turnstile keys, except in local development", () => {
    expect(turnstileMode({ PUBLIC_URL: "https://diffinery.example", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret" })).toBe("verify");
    expect(turnstileMode({ PUBLIC_URL: "https://diffinery.example", TURNSTILE_SITE_KEY: "site" })).toBe("missing");
    expect(turnstileMode({ PUBLIC_URL: "https://diffinery.example", TURNSTILE_SECRET: "secret" })).toBe("missing");
    expect(turnstileMode({ PUBLIC_URL: "https://diffinery.example" })).toBe("missing");
    expect(turnstileMode({ PUBLIC_URL: "http://localhost:8787" })).toBe("skip");
    expect(turnstileMode({ PUBLIC_URL: "http://127.0.0.1:8787" })).toBe("skip");
    expect(turnstileMode({ PUBLIC_URL: "http://localhost.evil.example" })).toBe("missing");
  });
});

describe("Turnstile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks siteverify with the secret, the token and the visitor's IP, and trusts only success", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let answer: unknown = { success: true };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return Response.json(answer);
    });
    expect(await verifyTurnstile("s3cret", "tok", "203.0.113.9")).toBe(true);
    expect(calls[0]!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ secret: "s3cret", response: "tok", remoteip: "203.0.113.9" });
    answer = { success: false, "error-codes": ["invalid-input-response"] };
    expect(await verifyTurnstile("s3cret", "tok", null)).toBe(false);
    expect(await verifyTurnstile("s3cret", "", null)).toBe(false);
    expect(calls.length).toBe(2);
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await verifyTurnstile("s3cret", "tok", null)).toBe(false);
  });
});

describe("sign-up codes", () => {
  it("are six random digits, stored only as a keyed hash", async () => {
    const codes = new Set(Array.from({ length: 200 }, () => newCode()));
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(190);
    const { env, db, signups } = setup();
    const { code } = await signups.issue("new@example.com", "203.0.113.9");
    const row = db.prepare("SELECT * FROM signup_codes").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.code_hash).toBe(await codeHash(env, row.id!, code));
    expect(await codeHash({ ...env, MASTER_KEY: "another" }, row.id!, code)).not.toBe(row.code_hash);
    expect(await codeHash(env, "another-row", code)).not.toBe(row.code_hash);
  });

  it("accepts the right code once", async () => {
    const { signups } = setup();
    const { code, expiresAt } = await signups.issue("new@example.com", "203.0.113.9");
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(await signups.check("new@example.com", code)).toEqual({ ok: true });
    expect(await signups.check("new@example.com", code)).toEqual({ ok: false, left: 0 });
    // Another address's code is another address's.
    const other = await signups.issue("other@example.com", "203.0.113.9");
    expect((await signups.check("new@example.com", other.code)).ok).toBe(false);
  });

  it("dies after five wrong codes", async () => {
    const { signups } = setup();
    const { code } = await signups.issue("new@example.com", "203.0.113.9");
    for (let left = MAX_CODE_ATTEMPTS - 1; left >= 0; left--) expect(await signups.check("new@example.com", wrong(code))).toEqual({ ok: false, left });
    expect(await signups.check("new@example.com", code)).toEqual({ ok: false, left: 0 });
    await expect(signups.check("new@example.com", "12345")).rejects.toThrow(/6-digit/);
  });

  it("expires after 10 minutes, and when a new code is sent", async () => {
    const { db, signups } = setup();
    const first = await signups.issue("new@example.com", "203.0.113.9");
    const second = await signups.issue("new@example.com", "203.0.113.9");
    expect((await signups.check("new@example.com", first.code)).ok).toBe(first.code === second.code);
    db.prepare("UPDATE signup_codes SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect(await signups.check("new@example.com", second.code)).toEqual({ ok: false, left: 0 });
  });

  it("sends at most 5 a day to an address and 20 a day from an IP address", async () => {
    const { db, signups } = setup();
    for (let i = 0; i < CODES_PER_EMAIL_PER_DAY; i++) await signups.issue("busy@example.com", "198.51.100.1");
    await expect(signups.issue("busy@example.com", "198.51.100.2")).rejects.toMatchObject({ status: 429 });
    for (let i = 0; i < CODES_PER_IP_PER_DAY - CODES_PER_EMAIL_PER_DAY; i++) await signups.issue(`p${i}@example.com`, "198.51.100.1");
    await expect(signups.issue("fresh@example.com", "198.51.100.1")).rejects.toMatchObject({ status: 429 });
    await signups.issue("fresh@example.com", "198.51.100.3");
    // A day later the count starts over.
    db.prepare("UPDATE signup_codes SET created_at = ?").run(new Date(Date.now() - 86400_000 - 1000).toISOString());
    await signups.issue("busy@example.com", "198.51.100.1");
  });

  it("finds an existing account whatever the case of its address", async () => {
    const { db, signups } = setup();
    db.prepare("INSERT INTO accounts VALUES ('a1', 'pal', 'user', 'Pal@Example.com', 'active')").run();
    expect((await signups.accountFor("pal@example.com"))?.id).toBe("a1");
    expect(await signups.accountFor("nobody@example.com")).toBeNull();
  });
});

describe("sign-up tickets", () => {
  it("work once, and only for 30 minutes", async () => {
    const { db, signups } = setup();
    const token = await signups.createTicket("new@example.com");
    const t = await signups.ticket(token);
    expect(t?.email).toBe("new@example.com");
    expect(JSON.stringify(db.prepare("SELECT * FROM signup_tickets").all())).not.toContain(token);
    expect(await signups.useTicket(t!.hash)).toBe(true);
    expect(await signups.useTicket(t!.hash)).toBe(false);
    expect(await signups.ticket(token)).toBeNull();
    const late = await signups.createTicket("new@example.com");
    const row = db.prepare("SELECT expires_at FROM signup_tickets WHERE used_at IS NULL").get() as { expires_at: string };
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(29 * 60_000);
    db.prepare("UPDATE signup_tickets SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect(await signups.ticket(late)).toBeNull();
    expect(await signups.ticket("not a token")).toBeNull();
  });
});

describe("sign-up addresses", () => {
  it("lower-cases addresses and refuses what isn't one", () => {
    expect(normalEmail("  New.Person@Example.COM ")).toBe("new.person@example.com");
    for (const bad of ["", "nobody", "a@b", "a b@example.com", "<a@example.com>", `${"x".repeat(250)}@example.com`]) expect(normalEmail(bad), bad).toBeNull();
  });
});
