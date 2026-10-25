import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { Directory, type Account, type Repo } from "../../src/lib/directory.js";
import { HttpError } from "../../src/lib/util.js";
import { bookSpend, DEFAULT_POLICY, orgSpend, parsePolicy, payerFor, policyRefusal, proxyPayer, reviewRefusal, savePolicy, settleSpend, spendMonth, terminalRefusal, type AgentPolicy } from "../../src/agentic/org-policy.js";
import { MAX_OUTPUT_ESTIMATE, prepareRequest, weighted } from "../../src/agentic/usage.js";
import { testD1 } from "./stubs/d1.js";

const at = new Date().toISOString();

function world() {
  const DB = testD1();
  const env = { DB } as unknown as Env;
  const dir = new Directory(env);
  const add = (id: string, kind: string, owner: string | null = null) => DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, owner_id, created_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, id, kind, owner, at);
  const member = (org: string, user: string, role = "member") => DB.sqlite.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(org, user, role, at);
  const key = (account: string, provider: string) => DB.sqlite.prepare("INSERT INTO model_keys (account_id, provider, ciphertext, hint, opted_in_at, created_at, updated_at) VALUES (?, ?, 'x', 'abcd', ?, ?, ?)").run(account, provider, at, at, at);
  const policy = (org: string, p: Partial<AgentPolicy>) => DB.sqlite.prepare("INSERT OR REPLACE INTO org_agent_policies (org_id, json, updated_by, updated_at) VALUES (?, ?, 'owner', ?)").run(org, JSON.stringify({ ...DEFAULT_POLICY, ...p }), at);
  const repo = (owner: string, kind: "user" | "org") => ({ id: `${owner}-repo`, owner_id: owner, owner_login: owner, owner_kind: kind, name: "repo" }) as Repo;
  add("acme", "org");
  add("other-org", "org");
  add("mia", "user");
  add("otto", "user");
  add("bot", "agent", "acme");
  member("acme", "mia");
  // An agent account added to the organization never spends its key.
  member("acme", "bot");
  return { env, dir, DB, key, policy, member, repo, person: async (id: string) => (await dir.account(id)) as Account };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.detail}`;
    throw e;
  }
  return "allowed";
};

describe("organization agent policy (phase 5b)", () => {
  it("parses a policy, keeping what's left out and refusing what's out of range", () => {
    expect(parsePolicy({}, DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    const p = parsePolicy({ keys: "organization", runtimes: ["codex", "claude-code"], providers: ["openai"], max_running: "4", terminals: false, terminal_tasks: false, review: false, member_monthly_tokens: "2000000" }, DEFAULT_POLICY);
    expect(p).toEqual({ keys: "organization", runtimes: ["claude-code", "codex"], providers: ["openai"], maxRunning: 4, terminals: false, terminalTasks: false, review: false, memberMonthlyTokens: 2_000_000 });
    expect(parsePolicy({ member_monthly_tokens: null }, p).memberMonthlyTokens).toBeNull();
    for (const bad of [{ keys: "shared" }, { runtimes: [] }, { runtimes: ["vim"] }, { providers: [] }, { max_running: 11 }, { max_running: 0 }, { terminals: "yes" }, { member_monthly_tokens: 5 }, { member_monthly_tokens: 1.5e10 }]) {
      expect(() => parsePolicy(bad, DEFAULT_POLICY)).toThrow(HttpError);
    }
  });

  it("names what a policy refuses", () => {
    const p = { ...DEFAULT_POLICY, runtimes: ["claude-code" as const], providers: ["anthropic" as const] };
    expect(policyRefusal("acme", p, "codex", ["openai"])).toBe("acme's agent policy doesn't allow Codex");
    expect(policyRefusal("acme", p, "claude-code", ["openrouter"])).toBe("acme's agent policy doesn't allow OpenRouter");
    expect(policyRefusal("acme", p, "claude-code", ["anthropic"])).toBeNull();
  });

  it("refuses terminals, terminal tasks and agent review as the policy says", async () => {
    const w = world();
    const repo = w.repo("acme", "org");
    expect(await terminalRefusal(w.env, repo, { tasks: true, runtime: "codex" })).toBeNull();
    expect(await reviewRefusal(w.env, repo)).toBeNull();
    w.policy("acme", { terminalTasks: false, runtimes: ["claude-code"], review: false });
    expect(await terminalRefusal(w.env, repo, {})).toBeNull();
    expect(await terminalRefusal(w.env, repo, { tasks: true })).toBe("acme's agent policy doesn't allow agent tasks in terminals");
    expect(await reviewRefusal(w.env, repo)).toBe("acme's agent policy doesn't allow agent review");
    w.policy("acme", { runtimes: ["claude-code"] });
    expect(await terminalRefusal(w.env, repo, { tasks: true, runtime: "codex" })).toBe("acme's agent policy doesn't allow Codex");
    w.policy("acme", { terminals: false });
    expect(await terminalRefusal(w.env, repo, {})).toBe("acme's agent policy doesn't allow web terminals");
    // A person's repository has no policy.
    expect(await terminalRefusal(w.env, w.repo("mia", "user"), { tasks: true })).toBeNull();
  });

  it("holds a terminal's tasks to the allowed providers, and to members under `organization`", async () => {
    const w = world();
    const repo = w.repo("acme", "org");
    const as = async (id: string) => ({ dir: w.dir, account: await w.person(id) });
    // Claude Code in a terminal talks to Anthropic on the person's subscription, Codex to OpenAI.
    w.policy("acme", { providers: ["openai"] });
    expect(await terminalRefusal(w.env, repo, { tasks: true, runtime: "claude-code", person: await as("mia") })).toBe("acme's agent policy doesn't allow Anthropic");
    expect(await terminalRefusal(w.env, repo, { tasks: true, runtime: "codex", person: await as("mia") })).toBeNull();
    // Only members run agent tasks when the organization pays only with its own keys; a terminal without tasks stays open to all.
    w.policy("acme", { keys: "organization" });
    expect(await terminalRefusal(w.env, repo, { tasks: true, runtime: "claude-code", person: await as("otto") })).toBe("acme's agent policy lets only its members run agent tasks in its repositories");
    expect(await terminalRefusal(w.env, repo, { tasks: false, person: await as("otto") })).toBeNull();
    expect(await terminalRefusal(w.env, repo, { tasks: true, runtime: "claude-code", person: await as("mia") })).toBeNull();
    w.policy("acme", { keys: "either" });
    expect(await terminalRefusal(w.env, repo, { tasks: true, runtime: "claude-code", person: await as("otto") })).toBeNull();
  });

  it("audits a site administrator's policy change as such", async () => {
    const w = world();
    w.DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, created_at) VALUES ('root', 'root', 'user', 'active', 1, ?)").run(at);
    w.member("acme", "otto", "owner");
    const org = await w.person("acme");
    const detail = () => JSON.parse((w.DB.sqlite.prepare("SELECT detail FROM audit_log WHERE action = 'org.agent_policy.update' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }).detail);
    const pending: Array<Promise<unknown>> = [];
    const wait = (p: Promise<unknown>) => void pending.push(p.catch(() => undefined));
    await savePolicy(w.env, w.dir, org, await w.person("otto"), DEFAULT_POLICY, wait);
    await Promise.all(pending);
    expect(detail().site_admin).toBeUndefined();
    await savePolicy(w.env, w.dir, org, await w.person("root"), DEFAULT_POLICY, wait);
    await Promise.all(pending);
    expect(detail().site_admin).toBe(true);
  });

  describe("whose key pays when work starts", () => {
    let w: ReturnType<typeof world>;
    beforeEach(() => {
      w = world();
      w.key("mia", "anthropic");
      w.key("otto", "anthropic");
      w.key("acme", "anthropic");
    });

    it("is the person's own in a person's repository, and in an organization without a policy", async () => {
      const mia = await w.person("mia");
      expect(await payerFor(w.env, w.dir, w.repo("mia", "user"), mia, "claude-code", null)).toMatchObject({ keyOwner: "mia", providers: ["anthropic"], orgMaxRunning: null });
      expect(await payerFor(w.env, w.dir, w.repo("acme", "org"), mia, "claude-code", null)).toMatchObject({ keyOwner: "mia", orgMaxRunning: 10 });
      expect(await refusal(payerFor(w.env, w.dir, w.repo("acme", "org"), mia, "codex", null))).toBe("422 Codex needs your OpenAI API key: add it in Settings → Model access");
    });

    it("under `either`, is the organization's for members and the person's own for outside collaborators", async () => {
      w.policy("acme", { keys: "either", maxRunning: 2 });
      expect(await payerFor(w.env, w.dir, w.repo("acme", "org"), await w.person("mia"), "claude-code", null)).toEqual({ keyOwner: "acme", providers: ["anthropic"], orgMaxRunning: 2 });
      expect(await payerFor(w.env, w.dir, w.repo("acme", "org"), await w.person("otto"), "claude-code", null)).toMatchObject({ keyOwner: "otto" });
      // No organization key for the provider: the member's own.
      w.key("mia", "openai");
      expect(await payerFor(w.env, w.dir, w.repo("acme", "org"), await w.person("mia"), "codex", null)).toMatchObject({ keyOwner: "mia", providers: ["openai"] });
    });

    it("under `organization`, refuses outside collaborators and agent accounts, and says when the organization lacks the key", async () => {
      w.policy("acme", { keys: "organization" });
      expect(await refusal(payerFor(w.env, w.dir, w.repo("acme", "org"), await w.person("otto"), "claude-code", null))).toBe("403 acme pays for agents in its repositories with its own keys, which only its members can use");
      expect(await refusal(payerFor(w.env, w.dir, w.repo("acme", "org"), await w.person("bot"), "claude-code", null))).toMatch(/^403 /);
      w.key("mia", "openai");
      expect(await refusal(payerFor(w.env, w.dir, w.repo("acme", "org"), await w.person("mia"), "codex", null))).toBe("422 acme pays for agents with its own keys, and has no OpenAI key: an owner can add it on the organization's Settings tab");
    });

    it("refuses runtimes and providers the policy doesn't allow, and gives a custom command only allowed providers' keys", async () => {
      w.policy("acme", { keys: "either", runtimes: ["claude-code", "custom"], providers: ["anthropic"] });
      w.key("acme", "openai");
      const mia = await w.person("mia");
      expect(await refusal(payerFor(w.env, w.dir, w.repo("acme", "org"), mia, "codex", null))).toBe("403 acme's agent policy doesn't allow Codex");
      expect(await refusal(payerFor(w.env, w.dir, w.repo("acme", "org"), mia, "claude-code", "openrouter"))).toBe("403 acme's agent policy doesn't allow OpenRouter");
      expect(await payerFor(w.env, w.dir, w.repo("acme", "org"), mia, "custom", null)).toMatchObject({ keyOwner: "acme", providers: ["anthropic"] });
    });

    it("keeps a task's key owner from its start, and refuses a follow-up that may no longer pay that way", async () => {
      w.policy("acme", { keys: "either" });
      const mia = await w.person("mia");
      const repo = w.repo("acme", "org");
      expect(await payerFor(w.env, w.dir, repo, mia, "claude-code", null, "mia")).toMatchObject({ keyOwner: "mia" });
      expect(await payerFor(w.env, w.dir, repo, mia, "claude-code", null, "acme")).toMatchObject({ keyOwner: "acme" });
      // A retry by someone outside the organization of a task the organization paid for.
      expect(await refusal(payerFor(w.env, w.dir, repo, await w.person("otto"), "claude-code", null, "acme"))).toBe("403 only members of acme can run agents on its keys");
      // Transferred to another organization, or to a person.
      expect(await refusal(payerFor(w.env, w.dir, w.repo("other-org", "org"), mia, "claude-code", null, "acme"))).toMatch(/^403 this task was paid for by an organization that no longer owns/);
      expect(await refusal(payerFor(w.env, w.dir, w.repo("mia", "user"), mia, "claude-code", null, "acme"))).toMatch(/^403 this task was paid for by an organization that no longer owns/);
      w.policy("acme", { keys: "organization" });
      expect(await refusal(payerFor(w.env, w.dir, repo, mia, "claude-code", null, "mia"))).toBe("403 acme now pays for agents in its repositories only with its own keys: start a new task");
      w.policy("acme", { keys: "personal" });
      expect(await refusal(payerFor(w.env, w.dir, repo, mia, "claude-code", null, "acme"))).toBe("403 acme no longer pays for agents with its keys: start a new task with yours");
    });
  });

  describe("the model proxy's check on every request", () => {
    it("lets a member spend the organization's key, with the allowance, until something changes", async () => {
      const w = world();
      w.policy("acme", { keys: "either", memberMonthlyTokens: 50_000 });
      const repo = w.repo("acme", "org");
      const run = { repo, personId: "mia", keyOwner: "acme", provider: "anthropic" as const };
      expect(await proxyPayer(w.env, w.dir, run)).toEqual({ org: { id: "acme", login: "acme", cap: 50_000 } });
      expect(await proxyPayer(w.env, w.dir, { ...run, provider: "openai" })).toEqual({ org: { id: "acme", login: "acme", cap: 50_000 } });
      // An agent account that is "in" the organization is never a member who pays.
      expect(await proxyPayer(w.env, w.dir, { ...run, personId: "bot" })).toEqual({ refuse: "bot is no longer a member of acme, whose key this task uses" });
      // The repository moved to another organization mid-task.
      expect(await proxyPayer(w.env, w.dir, { ...run, repo: w.repo("other-org", "org") })).toEqual({ refuse: "the organization whose key this task uses no longer owns other-org/repo" });
      // The member was removed: the next request is refused, nothing cached.
      w.DB.sqlite.prepare("DELETE FROM org_members WHERE org_id = 'acme' AND user_id = 'mia'").run();
      expect(await proxyPayer(w.env, w.dir, run)).toEqual({ refuse: "mia is no longer a member of acme, whose key this task uses" });
      w.member("acme", "mia");
      w.policy("acme", { keys: "either", providers: ["openai"] });
      expect(await proxyPayer(w.env, w.dir, run)).toEqual({ refuse: "acme's agent policy doesn't allow Anthropic" });
      w.policy("acme", { keys: "personal" });
      expect(await proxyPayer(w.env, w.dir, run)).toEqual({ refuse: "acme no longer pays for agents with its keys" });
    });

    it("lets a personal key pay unless the organization now pays only with its own", async () => {
      const w = world();
      const run = { repo: w.repo("acme", "org"), personId: "mia", keyOwner: "mia", provider: "anthropic" as const };
      expect(await proxyPayer(w.env, w.dir, run)).toEqual({ org: null });
      expect(await proxyPayer(w.env, w.dir, { ...run, repo: w.repo("mia", "user") })).toEqual({ org: null });
      w.policy("acme", { keys: "organization" });
      expect(await proxyPayer(w.env, w.dir, run)).toEqual({ refuse: "acme now pays for agents in its repositories only with its own keys" });
    });
  });

  it("books each request against the monthly allowance in one step, and settles it to what was used", async () => {
    const w = world();
    expect(await bookSpend(w.env, "acme", "mia", 600, 1000)).toBe(true);
    expect(await bookSpend(w.env, "acme", "mia", 500, 1000)).toBe(false);
    await settleSpend(w.env, "acme", "mia", -100);
    expect(await bookSpend(w.env, "acme", "mia", 500, 1000)).toBe(true);
    // At the allowance, even a request with no estimate is refused.
    expect(await bookSpend(w.env, "acme", "mia", 0, 1000)).toBe(false);
    // Another person, and a first request larger than the whole allowance.
    expect(await bookSpend(w.env, "acme", "otto", 2000, 1000)).toBe(false);
    expect(await bookSpend(w.env, "acme", "otto", 10, 1000)).toBe(true);
    // Without an allowance it always books, so a limit set later counts the month so far.
    expect(await bookSpend(w.env, "other-org", "mia", 5_000_000, null)).toBe(true);
    await settleSpend(w.env, "acme", "otto", -50);
    expect((await orgSpend(w.env, "acme")).map((x) => [x.login, x.tokens])).toEqual([
      ["mia", 1000],
      ["otto", 0],
    ]);
    expect(spendMonth(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    // A request asking for absurd output books a bounded estimate, so refunding it leaves the month's count exact.
    const huge = weighted(prepareRequest("POST", "/v1/messages", '{"max_tokens":1e300,"messages":[]}', 30).estimate!);
    expect(huge).toBe(10 + MAX_OUTPUT_ESTIMATE);
    expect(await bookSpend(w.env, "other-org", "mia", huge, null)).toBe(true);
    await settleSpend(w.env, "other-org", "mia", -huge);
    expect((await orgSpend(w.env, "other-org")).map((x) => x.tokens)).toEqual([5_000_000]);
  });
});
