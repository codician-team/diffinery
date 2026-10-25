import { describe, expect, it } from "vitest";
import {
  block,
  blockersOf,
  blockList,
  blockSubjects,
  cleanReport,
  cleanResolution,
  createReport,
  isBlocked,
  MAX_REPORTS_PER_DAY,
  minimizedNote,
  minimizeReason,
  openReportCount,
  reports,
  setReportState,
  suspend,
  suspendReason,
  unblock,
  unsuspend,
  visibleTo,
} from "../../src/lib/moderation.js";
import { Directory, type Account } from "../../src/lib/directory.js";
import { blockedBy, killSwitches } from "../../src/lib/killswitch.js";
import { sha256 } from "../../src/lib/util.js";
import type { Env } from "../../src/env.js";
import { testD1 } from "./stubs/d1.js";

const at = "2026-10-01T00:00:00.000Z";
const later = "2099-01-01T00:00:00.000Z";

/** A D1 with ann (site administrator), bob, cat and bob's agent bot, the organization acme (ann owns it, cat is a member), and repositories acme/app and bob/tool; REPO answers stopActions. */
function setup() {
  const DB = testD1();
  const add = (id: string, kind: string, siteAdmin = 0, owner: string | null = null) =>
    DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, owner_id, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(id, id, kind, siteAdmin, owner, at);
  add("ann", "user", 1);
  add("bob", "user");
  add("cat", "user");
  add("bot", "agent", 0, "bob");
  add("acme", "org");
  DB.sqlite.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('acme', 'ann', 'owner', ?), ('acme', 'cat', 'member', ?)").run(at, at);
  const repo = (id: string, owner: string) => DB.sqlite.prepare("INSERT INTO repos (id, owner_id, name, description, visibility, default_branch, created_at, updated_at) VALUES (?, ?, ?, '', 'public', 'main', ?, ?)").run(id, owner, id, at, at);
  repo("app", "acme");
  repo("tool", "bob");
  const stops: string[] = [];
  const REPO = { idFromName: (n: string) => n, get: (id: string) => ({ stopActions: async () => (stops.push(id), { runs: 1, jobs: 1, sandboxes: 0 }) }) };
  const audits: Array<{ action: string; target?: string; detail?: unknown }> = [];
  const audit = async (e: { action: string; target?: string; detail?: unknown }) => void audits.push(e);
  const env = { DB, REPO } as unknown as Env;
  const acct = async (id: string) => (await new Directory(env).account(id))!;
  return { env, DB, stops, audits, audit, acct };
}

const target = { kind: "issue" as const, target: "acme/app#1", url: "https://x/acme/app/issues/1", accountId: "bob", repoId: "app", excerpt: "buy now" };

describe("reports", () => {
  it("take a known reason and a bounded note, and need a note for 'something else'", () => {
    expect(cleanReport({ reason: " Spam ", body: " lots of links\r\n" })).toEqual({ reason: "spam", body: "lots of links" });
    expect(cleanReport({ reason: "harassment" })).toEqual({ reason: "harassment", body: "" });
    expect(() => cleanReport({ reason: "boring" })).toThrow(/reason must be one of/);
    expect(() => cleanReport({ reason: "other", body: "  " })).toThrow(/say what is wrong/);
    expect(() => cleanReport({ reason: "spam", body: "x".repeat(2001) })).toThrow(/at most 2000/);
    expect(() => cleanReport({ reason: "spam", body: 3 })).toThrow(/must be a string/);
    expect(() => cleanResolution(" ")).toThrow(/write what you did/);
    expect(cleanResolution(" removed it ")).toBe("removed it");
  });

  it("land in the queue once per thing, are capped per day, and are resolved and reopened", async () => {
    const { env, acct } = setup();
    const cat = await acct("cat");
    const r = await createReport(env, cat, target, { reason: "spam", body: "ads" });
    expect(r).toMatchObject({ reporter_login: "cat", account_login: "bob", kind: "issue", target: "acme/app#1", excerpt: "buy now", state: "open" });
    await expect(createReport(env, cat, target, { reason: "spam", body: "" })).rejects.toThrow(/already reported/);
    expect(await openReportCount(env)).toBe(1);
    expect((await reports(env, "open")).items.map((x) => x.id)).toEqual([r.id]);

    const done = await setReportState(env, r.id, { login: "ann" }, "resolved", "deleted the issue");
    expect(done).toMatchObject({ state: "resolved", resolved_by: "ann", resolution: "deleted the issue" });
    expect((await reports(env, "open")).total).toBe(0);
    expect((await reports(env, "resolved")).total).toBe(1);
    // Resolved, the same thing can be reported again.
    await createReport(env, cat, target, { reason: "spam", body: "" });
    expect((await setReportState(env, r.id, { login: "ann" }, "open", null))?.resolution).toBeNull();
    expect((await reports(env, "all")).total).toBe(2);
    expect(await setReportState(env, "nope", { login: "ann" }, "resolved", "x")).toBeNull();

    for (let i = 2; i < MAX_REPORTS_PER_DAY; i++) await createReport(env, cat, { ...target, target: `acme/app#${i + 10}` }, { reason: "spam", body: "" });
    await expect(createReport(env, cat, { ...target, target: "acme/app#99" }, { reason: "spam", body: "" })).rejects.toThrow(/at most 20 reports/);
  });
});

describe("blocks", () => {
  it("cover an agent through its owner", () => {
    expect(blockSubjects({ id: "bot", kind: "agent", owner_id: "bob" })).toEqual(["bot", "bob"]);
    expect(blockSubjects({ id: "bob", kind: "user", owner_id: null })).toEqual(["bob"]);
  });

  it("end the blocked person's collaboration and pending invitations, and are lifted by unblocking", async () => {
    const { env, DB, acct } = setup();
    DB.sqlite.prepare("INSERT INTO repo_access (repo_id, account_id, role) VALUES ('app', 'bob', 'write'), ('app', 'bot', 'write'), ('tool', 'cat', 'write')").run();
    const invite = (id: string, by: string, who: string | null, org: string | null, repo: string | null) =>
      DB.sqlite.prepare("INSERT INTO invites (id, org_id, repo_id, account_id, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)").run(id, org, repo, who, id, by, at, later);
    invite("i1", "ann", "bob", "acme", null);
    invite("i2", "ann", "bob", null, "app");
    invite("i3", "cat", "bob", null, null);
    const acme = await acct("acme");
    const ann = await acct("ann");
    const bob = await acct("bob");

    expect(await block(env, acme, bob, ann)).toBe(true);
    expect(await block(env, acme, bob, ann)).toBe(false);
    expect(await isBlocked(env, "acme", ["bob"])).toBe(true);
    expect(await isBlocked(env, "acme", blockSubjects(await acct("bot")))).toBe(true);
    expect(await isBlocked(env, "bob", ["acme"])).toBe(false);
    expect([...(await blockersOf(env, ["bob"]))]).toEqual(["acme"]);
    expect((await blockList(env, "acme")).map((b) => [b.account.login, b.createdBy])).toEqual([["bob", "ann"]]);
    expect(DB.sqlite.prepare("SELECT repo_id, account_id FROM repo_access ORDER BY repo_id").all()).toEqual([{ repo_id: "tool", account_id: "cat" }]);
    expect(DB.sqlite.prepare("SELECT id FROM invites").all()).toEqual([{ id: "i3" }]);

    expect(await unblock(env, "acme", "bob")).toBe(true);
    expect(await unblock(env, "acme", "bob")).toBe(false);
    expect(await isBlocked(env, "acme", ["bob"])).toBe(false);
  });

  it("can't block yourself, an organization's own member, or anything but a person", async () => {
    const { env, acct } = setup();
    const [ann, bob, cat, acme, bot] = await Promise.all(["ann", "bob", "cat", "acme", "bot"].map(acct));
    await expect(block(env, bob, bob, bob)).rejects.toThrow(/yourself/);
    await expect(block(env, acme, cat, ann)).rejects.toThrow(/member of acme/);
    await expect(block(env, bob, acme, bob)).rejects.toThrow(/only people/);
    await expect(block(env, bob, bot!, bob)).rejects.toThrow(/only people/);
    // Blocking a person stops them being added back as a collaborator or invited.
    await block(env, bob, cat, bob);
    const tool = (await new Directory(env).repo("bob", "tool"))!;
    await expect(new Directory(env).grantRepoAccess(tool, bob!, cat!, "write")).rejects.toThrow(/bob blocked cat/);
    // Nor their agents.
    await block(env, acme!, bob!, ann!);
    const app = (await new Directory(env).repo("acme", "app"))!;
    await expect(new Directory(env).grantRepoAccess(app, ann!, bot!, "write")).rejects.toThrow(/acme blocked bot's owner/);
  });
});

describe("suspension", () => {
  it("needs a reason, and hides a suspended person's content from all but site administrators", () => {
    expect(suspendReason("  spam   bot ")).toBe("spam bot");
    expect(() => suspendReason("")).toThrow(/give a reason/);
    expect(() => suspendReason("x".repeat(501))).toThrow(/at most 500/);
    expect(visibleTo({ suspended_at: null }, null)).toBe(true);
    expect(visibleTo({ suspended_at: at }, null)).toBe(false);
    expect(visibleTo({ suspended_at: at }, { site_admin: 0 } as Account)).toBe(false);
    expect(visibleTo({ suspended_at: at }, { site_admin: 1 } as Account)).toBe(true);
  });

  it("refuses tokens and sessions at once, stops Actions, and unsuspending restores the tokens", async () => {
    const { env, DB, stops, audits, audit, acct } = setup();
    const token = "dfy_test_token";
    const agentToken = "dfy_agent_token";
    for (const [id, owner, t] of [["t1", "bob", token], ["t2", "bot", agentToken]]) {
      DB.sqlite.prepare("INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES (?, ?, 'x', ?, 'dfy', '[\"repo\"]', ?, ?)").run(id!, owner!, await sha256(t!), later, at);
    }
    DB.sqlite.prepare("INSERT INTO sessions (id, account_id, method, created_at, last_seen_at, expires_at) VALUES ('s1', 'bob', 'passkey', ?, ?, ?)").run(at, at, later);
    const dir = new Directory(env);
    const ann = await acct("ann");
    expect((await dir.verifyToken(token))?.account.login).toBe("bob");

    const stopped = await suspend(env, audit, ann, await acct("bob"), "spam", "api");
    expect(stops).toEqual(["tool"]);
    expect(stopped).toMatchObject({ repositories: 1 });
    expect(await dir.verifyToken(token)).toBeNull();
    expect(await dir.verifyToken(agentToken)).toBeNull();
    expect(DB.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    const bob = await acct("bob");
    expect(bob).toMatchObject({ status: "disabled", suspended_by: "ann", suspended_reason: "spam" });
    expect(blockedBy(await killSwitches(env, "tool"), "run")).toMatch(/spam/);
    expect(audits[0]).toMatchObject({ action: "user.suspend", target: "bob", detail: { reason: "spam", via: "api" } });

    expect(await unsuspend(env, audit, ann, bob, "web")).toBe(true);
    expect(await unsuspend(env, audit, ann, await acct("bob"), "web")).toBe(false);
    expect(await acct("bob")).toMatchObject({ status: "active", suspended_at: null });
    expect((await dir.verifyToken(token))?.account.login).toBe("bob");
    expect((await dir.verifyToken(agentToken))?.account.login).toBe("bot");
    expect(blockedBy(await killSwitches(env, "tool"), "run")).toBeNull();
    expect(audits[1]).toEqual({ actorId: "ann", actorLogin: "ann", action: "user.unsuspend", target: "bob", detail: { via: "web" } });
    expect(audits).toHaveLength(2);
  });

  it("can't suspend a site administrator, yourself, or an organization", async () => {
    const { env, audit, acct } = setup();
    const [ann, bob, acme] = await Promise.all(["ann", "bob", "acme"].map(acct));
    await expect(suspend(env, audit, bob!, ann!, "x", "api")).rejects.toThrow(/site administrator/);
    await expect(suspend(env, audit, ann!, ann!, "x", "api")).rejects.toThrow(/yourself/);
    await expect(suspend(env, audit, ann!, acme!, "x", "api")).rejects.toThrow(/only people/);
  });
});

describe("hidden comments", () => {
  it("take GitHub's classifiers and say why they are hidden", () => {
    expect(minimizeReason("OFF_TOPIC")).toBe("off_topic");
    expect(minimizeReason("off-topic")).toBe("off_topic");
    expect(minimizeReason("spam")).toBe("spam");
    expect(() => minimizeReason("rude")).toThrow(/reason must be one of/);
    expect(minimizedNote("duplicate")).toBe("This comment was marked as duplicate.");
    expect(minimizedNote(null)).toBe("This comment has been minimized.");
  });
});
