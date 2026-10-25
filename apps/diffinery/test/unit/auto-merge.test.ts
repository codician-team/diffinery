import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { HttpError } from "../../src/lib/util.js";
import { AUTO_MERGE_BOT, AutoMerge, automaticLandingRefusal, isPerson, landsByAgentRule, mergesByAgentPermission } from "../../src/repo/auto-merge.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import type { ProtectionRules } from "../../src/repo/types.js";

const person = { id: "u1", kind: "user" as const };
const agent = { id: "a1", kind: "agent" as const };
const job = { id: "job:j1", kind: "system" as const };
const agentJob = { id: "job:j2", kind: "agent" as const };
const refuse = (c: { id: string; kind: "user" | "agent" | "system"; mayMerge?: boolean }, rules: ProtectionRules | null, isDefault = true) => automaticLandingRefusal(c, rules, isDefault, "main");

describe("who may have Diffinery land a pull request for them", () => {
  it("tells people from agents and workflow tokens", () => {
    expect(isPerson(person)).toBe(true);
    for (const c of [agent, job, agentJob]) expect(isPerson(c)).toBe(false);
    // A job token is never a person, whatever kind it carries.
    expect(isPerson({ id: "job:x", kind: "user" })).toBe(false);
  });

  it("always lets people", () => {
    expect(refuse(person, null)).toBeNull();
    expect(refuse(person, { requiredChecks: [] })).toBeNull();
  });

  it("lets agents and tokens on a branch that is neither default nor protected", () => {
    for (const c of [agent, job, agentJob]) expect(refuse(c, null, false)).toBeNull();
  });

  it("refuses agents and tokens on the default branch or a protected one without allowAgentAutoMerge", () => {
    for (const c of [agent, job, agentJob]) {
      expect(refuse(c, null)?.status).toBe(403);
      expect(refuse(c, { requiredChecks: ["ci"] }, false)?.status).toBe(403);
      expect(refuse(c, { requiredChecks: ["ci"], allowAgentAutoMerge: false })?.message).toMatch(/allowAgentAutoMerge/);
    }
  });

  it("needs at least one required check with the setting", () => {
    for (const c of [agent, job]) {
      expect(refuse(c, { allowAgentAutoMerge: true })?.status).toBe(422);
      expect(refuse(c, { allowAgentAutoMerge: true, requiredChecks: [] })?.message).toMatch(/required status checks/);
      expect(refuse(c, { allowAgentAutoMerge: true, requiredChecks: ["ci"] })).toBeNull();
    }
  });

  it("keeps agentsMayMerge for agents only: workflow tokens are never looser than agents", () => {
    expect(refuse(agent, { agentsMayMerge: true })).toBeNull();
    expect(refuse(agentJob, { agentsMayMerge: true })).toBeNull();
    expect(refuse(job, { agentsMayMerge: true })?.status).toBe(403);
    expect(landsByAgentRule(agent, { agentsMayMerge: true, allowAgentAutoMerge: true, requiredChecks: ["ci"] }, true)).toBe(false);
    expect(landsByAgentRule(agent, { allowAgentAutoMerge: true, requiredChecks: ["ci"] }, true)).toBe(true);
    expect(landsByAgentRule(person, { allowAgentAutoMerge: true, requiredChecks: ["ci"] }, true)).toBe(false);
    expect(landsByAgentRule(agent, null, false)).toBe(false);
  });
});

describe("an agent that may merge (Agent setup's Can merge pull requests)", () => {
  const setupAgent = { ...agent, mayMerge: true };
  it("lands on the default branch and protected ones: approvals and checks are left to mergeability", () => {
    expect(refuse(setupAgent, null)).toBeNull();
    expect(refuse(setupAgent, { requiredChecks: ["ci"] }, false)).toBeNull();
    expect(mergesByAgentPermission(setupAgent, null, true, false)).toBe(true);
    expect(mergesByAgentPermission(setupAgent, { requiredApprovals: 2 }, false, false)).toBe(true);
  });

  it("is never a workflow token, a person, or an agent without the permission", () => {
    for (const c of [agent, person, { ...job, mayMerge: true }, { ...agentJob, mayMerge: true }]) expect(mergesByAgentPermission(c, null, true, false)).toBe(false);
    expect(refuse({ ...agentJob, mayMerge: true }, null)?.status).toBe(403);
  });

  it("leaves the branch's own agent rules to their own path", () => {
    // agentsMayMerge keeps its approval waiver; allowAgentAutoMerge with required checks keeps landsByAgentRule.
    expect(mergesByAgentPermission(setupAgent, { agentsMayMerge: true }, true, false)).toBe(false);
    expect(mergesByAgentPermission(setupAgent, { allowAgentAutoMerge: true, requiredChecks: ["ci"] }, true, true)).toBe(false);
    expect(mergesByAgentPermission(setupAgent, { allowAgentAutoMerge: true, requiredChecks: ["ci"] }, true, false)).toBe(true);
  });

  it("has nothing to do on an unprotected branch that isn't the default", () => {
    expect(mergesByAgentPermission(setupAgent, null, false, false)).toBe(false);
  });
});

// ---------------------------------------------------------------- what auto-merge does when it tries

/** A minimal SqlStorage over node:sqlite with the repository schema. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec(REPO_SCHEMA);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...(bindings as never[]));
        return { toArray: () => rows, one: () => rows[0] } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [], one: () => undefined } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
    },
  } as unknown as SqlStorage;
  migrateRepoSchema(sql);
  return sql;
}

/**
 * Auto-merge over a fake repository: pull request #1 from `topic` into `base`, ready to merge, with
 * auto-merge turned on by a workflow token (whose access needs no directory lookup).
 */
function harness(o: { rules?: ProtectionRules | null; archived?: boolean; deleteBranch?: boolean; enqueue?: () => Promise<unknown> } = {}) {
  const sql = sqlStorage();
  const at = new Date().toISOString();
  sql.exec("INSERT INTO issues (number, kind, title, author_id, author_login, created_at, updated_at) VALUES (1, 'pull', 'T', 'u1', 'olive', ?, ?)", at, at);
  const state = { method: "squash", commitTitle: null, commitMessage: null, enabledBy: { id: "job:j1", login: "github-actions[bot]", kind: "system" }, enabledAt: at, role: "write", permissions: { contents: "write" }, ...(o.deleteBranch ? { deleteBranch: true } : {}) };
  sql.exec("INSERT INTO pulls (number, head_ref, head_sha, base_ref, auto_merge) VALUES (1, 'topic', 'h1', 'base', ?)", JSON.stringify(state));
  const comments: Array<{ body: string; by: string }> = [];
  const events: Array<{ type: string; action?: string; detail?: Record<string, unknown> }> = [];
  const merges: Array<Record<string, unknown>> = [];
  const enqueues: Array<Record<string, unknown>> = [];
  const repo = {
    sql,
    meta: { repoId: "r1", ownerId: "u1", owner: "olive", name: "n", defaultBranch: "main", ownerKind: "user", ...(o.archived !== undefined ? { archived: o.archived } : {}) },
    isArchived: async () => !!o.archived,
    protectionFor: () => o.rules ?? null,
    collab: {
      get: () => ({ issue: { number: 1, state: "open", pull: { merged: false, draft: false, base: "base", head: "topic", headSha: "h1" } } }),
      mergeability: async () => ({ mergeable: true, blockers: [] }),
      merge: async (_n: number, input: Record<string, unknown>) => {
        merges.push(input);
        sql.exec("UPDATE pulls SET merged = 1, auto_merge = NULL WHERE number = 1");
        return { merged: true, sha: "m1", method: "squash" };
      },
      addComment: (_n: number, body: string, by: { login: string }) => comments.push({ body, by: by.login }),
      changedWorkflow: async () => null,
    },
    queue: {
      isQueued: () => false,
      enqueue: async (_n: number, input: Record<string, unknown>) => {
        enqueues.push(input);
        return o.enqueue ? o.enqueue() : { state: "queued", entry: null };
      },
    },
    social: { record: () => undefined },
    emit: (e: { type: string; action?: string; detail?: Record<string, unknown> }) => events.push(e),
    broadcast: () => undefined,
    background: () => undefined,
  };
  const am = new AutoMerge(repo as unknown as RepoDO, {} as Env);
  return { am, comments, events, merges, enqueues, on: () => am.state(1) !== null };
}

const QUEUED: ProtectionRules = { requiredChecks: ["ci"], allowAgentAutoMerge: true, mergeQueue: { method: "squash" } };

describe("auto-merge at work", () => {
  it("merges a ready pull request", async () => {
    const h = harness();
    await h.am.process({ number: 1 });
    expect(h.merges).toHaveLength(1);
    expect(h.on()).toBe(false);
  });

  it("never merges, or queues, in an archived repository: it turns itself off and says why", async () => {
    for (const rules of [null, QUEUED]) {
      const h = harness({ archived: true, rules });
      await h.am.process({ number: 1 });
      expect(h.merges).toHaveLength(0);
      expect(h.enqueues).toHaveLength(0);
      expect(h.on()).toBe(false);
      expect(h.comments).toEqual([{ body: "Auto-merge was turned off: the repository is archived.", by: AUTO_MERGE_BOT.login }]);
    }
  });

  it("can't be turned on in an archived repository", async () => {
    const h = harness({ archived: true });
    h.am.clear(1);
    await expect(h.am.enable(1, {}, { id: "u1", login: "olive", kind: "user", role: "admin" })).rejects.toMatchObject({ status: 403 });
    expect(h.on()).toBe(false);
  });

  it("turns itself off, with a comment, when the merge queue refuses the pull request", async () => {
    const h = harness({ rules: QUEUED, enqueue: () => Promise.reject(new HttpError(405, "pull request cannot be added to the merge queue: required check 'ci' failed")) });
    await h.am.process({ number: 1 });
    expect(h.enqueues).toHaveLength(1);
    expect(h.on()).toBe(false);
    expect(h.comments).toEqual([{ body: "Auto-merge was turned off: pull request cannot be added to the merge queue: required check 'ci' failed.", by: AUTO_MERGE_BOT.login }]);
    expect(h.events.find((e) => e.action === "pull_request.auto_merge_disabled")?.detail?.reason).toMatch(/cannot be added to the merge queue/);
    // Anything else the queue throws turns it off too, rather than retrying on every event in silence.
    const odd = harness({ rules: QUEUED, enqueue: () => Promise.reject(new Error("boom")) });
    await odd.am.process({ number: 1 });
    expect(odd.on()).toBe(false);
    expect(odd.comments[0]?.body).toBe("Auto-merge was turned off: the pull request could not be added to the merge queue.");
  });

  it("leaves auto-merge on when the head moved under it (409): the next event looks again", async () => {
    const h = harness({ rules: QUEUED, enqueue: () => Promise.reject(new HttpError(409, "head branch was modified")) });
    await h.am.process({ number: 1 });
    expect(h.on()).toBe(true);
    expect(h.comments).toHaveLength(0);
  });

  it("deletes the head branch after it lands when asked to, directly or through the queue", async () => {
    const direct = harness({ deleteBranch: true });
    await direct.am.process({ number: 1 });
    expect(direct.merges[0]).toMatchObject({ deleteBranch: true });
    const queued = harness({ deleteBranch: true, rules: QUEUED });
    await queued.am.process({ number: 1 });
    expect(queued.enqueues[0]).toMatchObject({ deleteBranch: true });
    const kept = harness({ rules: QUEUED });
    await kept.am.process({ number: 1 });
    expect(kept.enqueues[0]).toMatchObject({ deleteBranch: false });
  });
});

// ---------------------------------------------------------------- a branch rule's autoMergeAgents

/** Pull request #1 by agent a1 into main, with auto-merge off, and a rule for main; the agent has the write role. */
function ruleHarness(o: { rules?: ProtectionRules; authorKind?: string; draft?: boolean; workflow?: string; role?: "read" | "write" } = {}) {
  const sql = sqlStorage();
  const at = new Date().toISOString();
  sql.exec("INSERT INTO issues (number, kind, title, author_id, author_login, author_kind, created_at, updated_at) VALUES (1, 'pull', 'T', 'a1', 'olive-bot', ?, ?, ?)", o.authorKind ?? "agent", at, at);
  sql.exec("INSERT INTO pulls (number, head_ref, head_sha, base_ref, draft) VALUES (1, 'topic', 'h1', 'main', ?)", o.draft ? 1 : 0);
  const rules: ProtectionRules = o.rules ?? { requiredChecks: ["ci"], allowAgentAutoMerge: true, autoMergeAgents: [{ id: "a1", login: "olive-bot" }], autoMergeMethod: "squash" };
  const comments: Array<{ body: string; by: string }> = [];
  const events: Array<{ type: string; action?: string; actor?: { login: string }; detail?: Record<string, unknown> }> = [];
  const repo = {
    sql,
    meta: { repoId: "r1", ownerId: "u1", owner: "olive", name: "n", defaultBranch: "main", ownerKind: "user", archived: false },
    isArchived: async () => false,
    protectionFor: () => rules,
    protectionRuleFor: () => ({ pattern: "main", rules }),
    collab: {
      get: () => ({ issue: { number: 1, state: "open", pull: { merged: false, draft: !!o.draft, base: "main", head: "topic", headSha: "h1" } } }),
      mergeability: async () => ({ mergeable: false, blockers: ["required check 'ci' has not run"] }),
      addComment: (_n: number, body: string, by: { login: string }) => comments.push({ body, by: by.login }),
      changedWorkflow: async () => o.workflow ?? null,
    },
    queue: { isQueued: () => false },
    social: {
      record: (n: number, event: string, actor: { id: string; login: string; kind: string }) =>
        sql.exec("INSERT INTO issue_events (number, event, actor_id, actor_login, actor_kind, detail, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?)", n, event, actor.id, actor.login, actor.kind, at),
    },
    emit: (e: (typeof events)[number]) => events.push(e),
    broadcast: () => undefined,
    background: () => undefined,
  };
  const am = new AutoMerge(repo as unknown as RepoDO, {} as Env);
  // The agent's access, as the directory would give it.
  (am as unknown as { accountCaller: (id: string) => Promise<unknown> }).accountCaller = async (id: string) => (id === "a1" ? { id: "a1", login: "olive-bot", kind: "agent", role: o.role ?? "write" } : null);
  return { am, comments, events, sql };
}

describe("a branch rule that auto-merges chosen agents' pull requests", () => {
  it("turns auto-merge on as the agent, recorded as the server's doing", async () => {
    const h = ruleHarness();
    await h.am.applyRule(1, true);
    const s = h.am.state(1);
    expect(s).toMatchObject({ method: "squash", byRule: "main", enabledBy: { id: "a1", login: "olive-bot", kind: "agent" }, role: "write" });
    const audit = h.events.find((e) => e.action === "pull_request.auto_merge_enabled");
    expect(audit?.actor?.login).toBe(AUTO_MERGE_BOT.login);
    expect(audit?.detail).toMatchObject({ byRule: "main", agent: "olive-bot", viaAgentRule: true });
    expect(AutoMerge.info(s)?.byRule).toBe("main");
  });

  it("leaves other agents, people, drafts and rules without allowAgentAutoMerge alone", async () => {
    for (const h of [
      ruleHarness({ rules: { requiredChecks: ["ci"], allowAgentAutoMerge: true, autoMergeAgents: [{ id: "a2", login: "other-bot" }] } }),
      ruleHarness({ authorKind: "user" }),
      ruleHarness({ draft: true }),
      ruleHarness({ rules: { requiredChecks: ["ci"], autoMergeAgents: [{ id: "a1", login: "olive-bot" }] } }),
      ruleHarness({ rules: { requiredChecks: ["ci"], allowAgentAutoMerge: true } }),
    ]) {
      await h.am.applyRule(1, true);
      expect(h.am.state(1)).toBeNull();
      expect(h.comments).toHaveLength(0);
    }
  });

  it("never turns it back on once it was turned off", async () => {
    const h = ruleHarness();
    await h.am.applyRule(1, false);
    h.am.disable(1, { id: "u1", login: "olive", kind: "user", role: "admin" });
    expect(h.am.state(1)).toBeNull();
    await h.am.applyRule(1, true);
    expect(h.am.state(1)).toBeNull();
  });

  it("keeps every refusal of the agent's own auto-merge, and says why when asked to", async () => {
    const wf = ruleHarness({ workflow: ".github/workflows/ci.yml" });
    await wf.am.applyRule(1, true);
    expect(wf.am.state(1)).toBeNull();
    expect(wf.comments[0]?.body).toMatch(/^Auto-merge didn't turn on by itself \(branch rule `main` auto-merges olive-bot's pull requests\): the pull request changes workflow file `\.github\/workflows\/ci\.yml`/);
    const quiet = ruleHarness({ workflow: ".github/workflows/ci.yml" });
    await quiet.am.applyRule(1, false);
    expect(quiet.comments).toHaveLength(0);
    // No required check: allowAgentAutoMerge refuses, so the rule does too.
    const unchecked = ruleHarness({ rules: { allowAgentAutoMerge: true, autoMergeAgents: [{ id: "a1", login: "olive-bot" }] } });
    await unchecked.am.applyRule(1, true);
    expect(unchecked.am.state(1)).toBeNull();
    expect(unchecked.comments[0]?.body).toMatch(/no required status checks/);
    // An agent that lost write access.
    const reader = ruleHarness({ role: "read" });
    await reader.am.applyRule(1, true);
    expect(reader.am.state(1)).toBeNull();
    expect(reader.comments[0]?.body).toMatch(/write access is required/);
  });
});

// ---------------------------------------------------------------- an account's own "auto-merge my pull requests"

/**
 * Pull request #1 into main, opened by `author` (a person, u1, by default), with auto-merge off. `settings` is
 * each account's accounts.auto_merge, as D1 would give it.
 */
function ownHarness(o: { rules?: ProtectionRules | null; author?: { id: string; login: string; kind: string }; draft?: boolean; workflow?: string; settings?: Record<string, string | null> } = {}) {
  const sql = sqlStorage();
  const at = new Date().toISOString();
  const author = o.author ?? { id: "u1", login: "olive", kind: "user" };
  sql.exec("INSERT INTO issues (number, kind, title, author_id, author_login, author_kind, created_at, updated_at) VALUES (1, 'pull', 'T', ?, ?, ?, ?, ?)", author.id, author.login, author.kind, at, at);
  sql.exec("INSERT INTO pulls (number, head_ref, head_sha, base_ref, draft) VALUES (1, 'topic', 'h1', 'main', ?)", o.draft ? 1 : 0);
  const rules = o.rules === undefined ? ({ requiredChecks: ["ci"] } as ProtectionRules) : o.rules;
  const comments: Array<{ body: string; by: string }> = [];
  const events: Array<{ type: string; action?: string; actor?: { login: string }; detail?: Record<string, unknown> }> = [];
  const lookups: string[] = [];
  const settings = o.settings ?? { u1: "default" };
  const env = {
    DB: {
      prepare: () => ({
        bind: (id: string) => ({
          first: async () => {
            lookups.push(id);
            return id in settings ? { id, auto_merge: settings[id] } : null;
          },
        }),
      }),
    },
  } as unknown as Env;
  const repo = {
    sql,
    meta: { repoId: "r1", ownerId: "u1", owner: "olive", name: "n", defaultBranch: "main", ownerKind: "user", archived: false },
    isArchived: async () => false,
    protectionFor: () => rules,
    protectionRuleFor: () => (rules ? { pattern: "main", rules } : null),
    collab: {
      get: () => ({ issue: { number: 1, state: "open", pull: { merged: false, draft: !!o.draft, base: "main", head: "topic", headSha: "h1" } } }),
      mergeability: async () => ({ mergeable: false, blockers: ["required check 'ci' has not run"] }),
      addComment: (_n: number, body: string, by: { login: string }) => comments.push({ body, by: by.login }),
      changedWorkflow: async () => o.workflow ?? null,
    },
    queue: { isQueued: () => false },
    social: {
      record: (n: number, event: string, actor: { id: string; login: string; kind: string }) =>
        sql.exec("INSERT INTO issue_events (number, event, actor_id, actor_login, actor_kind, detail, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?)", n, event, actor.id, actor.login, actor.kind, at),
    },
    emit: (e: (typeof events)[number]) => events.push(e),
    broadcast: () => undefined,
    background: () => undefined,
  };
  const am = new AutoMerge(repo as unknown as RepoDO, env);
  (am as unknown as { accountCaller: (id: string) => Promise<unknown> }).accountCaller = async (id: string) => (id === "a1" ? { id: "a1", login: "olive-bot", kind: "agent", role: "write" } : null);
  return { am, comments, events, lookups };
}

const olive = { id: "u1", login: "olive", kind: "user" as const, role: "write" as const };
const oliveBot = { id: "a1", login: "olive-bot", kind: "agent" as const, role: "write" as const };
const botAuthor = { id: "a1", login: "olive-bot", kind: "agent" };

describe("auto-merge for the pull requests an account opens (its own setting)", () => {
  it("turns on as the person who opened it, recorded as their setting, and waits for checks in the background", async () => {
    const h = ownHarness();
    expect(await h.am.opened(1, olive)).toBeNull();
    const s = h.am.state(1);
    expect(s).toMatchObject({ method: "merge", byDefault: true, enabledBy: { id: "u1", login: "olive", kind: "user" }, role: "write" });
    expect(AutoMerge.info(s)?.byDefault).toBe(true);
    const audit = h.events.find((e) => e.action === "pull_request.auto_merge_enabled");
    expect(audit?.actor?.login).toBe("olive");
    expect(audit?.detail).toMatchObject({ byDefault: true });
  });

  it("uses the setting's merge method, or the branch's where it can't", async () => {
    const squash = ownHarness({ settings: { u1: "squash" } });
    await squash.am.opened(1, olive);
    expect(squash.am.state(1)?.method).toBe("squash");
    const linear = ownHarness({ settings: { u1: "merge" }, rules: { requiredChecks: ["ci"], requireLinearHistory: true } });
    await linear.am.opened(1, olive);
    expect(linear.am.state(1)?.method).toBe("squash");
  });

  it("only waits for CI: never on a branch without a required check, saying why when asked", async () => {
    for (const rules of [null, { requiredApprovals: 1 }] as const) {
      const h = ownHarness({ rules });
      expect(await h.am.opened(1, olive)).toMatch(/main has no required status checks, so auto-merge would not wait for CI/);
      expect(h.am.state(1)).toBeNull();
    }
    const asked = ownHarness({ rules: null, settings: {} });
    expect(await asked.am.opened(1, olive, true)).toMatch(/no required status checks/);
    expect(asked.am.state(1)).toBeNull();
  });

  it("does nothing without the setting, unless it was asked for on this pull request; and false keeps it off", async () => {
    const none = ownHarness({ settings: { u1: null } });
    expect(await none.am.opened(1, olive)).toBeNull();
    expect(none.am.state(1)).toBeNull();
    const asked = ownHarness({ settings: {} });
    expect(await asked.am.opened(1, olive, true)).toBeNull();
    expect(asked.am.state(1)).toMatchObject({ byDefault: true });
    const declined = ownHarness();
    expect(await declined.am.opened(1, olive, false)).toBeNull();
    expect(declined.am.state(1)).toBeNull();
    expect(declined.lookups).toHaveLength(0);
  });

  it("never acts for someone else, on a draft, or where auto-merge was turned off before", async () => {
    const other = ownHarness({ settings: { u2: "default" } });
    await other.am.applyOwn(1, { id: "u2", login: "pat", kind: "user", role: "admin" });
    expect(other.am.state(1)).toBeNull();
    const draft = ownHarness({ draft: true });
    expect(await draft.am.applyOwn(1, olive)).toBeNull();
    expect(await draft.am.applyOwn(1, olive, { requested: true })).toMatch(/draft/);
    expect(draft.am.state(1)).toBeNull();
    const off = ownHarness();
    await off.am.applyOwn(1, olive);
    off.am.disable(1, olive);
    await off.am.applyOwn(1, olive);
    expect(off.am.state(1)).toBeNull();
  });

  it("never looks a workflow token up as an account", async () => {
    const h = ownHarness({ author: { id: "job:j1", login: "diffinery-actions[bot]", kind: "system" } });
    await h.am.applyOwn(1, { id: "job:j1", login: "diffinery-actions[bot]", kind: "system", role: "write" });
    expect(h.lookups).toHaveLength(0);
    expect(h.am.state(1)).toBeNull();
  });

  it("holds an agent to its own auto-merge's rules, and tells it why once", async () => {
    // main allows agents' auto-merge: it turns on.
    const allowed = ownHarness({ author: botAuthor, settings: { a1: "default" }, rules: { requiredChecks: ["ci"], allowAgentAutoMerge: true } });
    await allowed.am.opened(1, oliveBot);
    expect(allowed.am.state(1)).toMatchObject({ byDefault: true, enabledBy: { login: "olive-bot", kind: "agent" } });
    // It doesn't, and the agent can't merge on its own permission either: refused, with one comment.
    const refused = ownHarness({ author: botAuthor, settings: { a1: "default" } });
    expect(await refused.am.opened(1, oliveBot)).toMatch(/allowAgentAutoMerge/);
    expect(refused.am.state(1)).toBeNull();
    expect(refused.comments).toHaveLength(1);
    expect(refused.comments[0]).toMatchObject({ by: AUTO_MERGE_BOT.login });
    expect(refused.comments[0]!.body).toMatch(/^Auto-merge didn't turn on by itself \(olive-bot turns on auto-merge for its pull requests\): agents may not/);
    // An Agent setup agent that may merge: it turns on, and lands once a person approved (mergeability's business).
    const setup = ownHarness({ author: botAuthor, settings: { a1: "default" } });
    await setup.am.opened(1, { ...oliveBot, mayMerge: true });
    expect(setup.am.state(1)).not.toBeNull();
    // A change to a workflow file needs a person, whatever the settings.
    const wf = ownHarness({ author: botAuthor, settings: { a1: "default" }, workflow: ".github/workflows/ci.yml", rules: { requiredChecks: ["ci"], allowAgentAutoMerge: true, agentAutoMergeWithoutApproval: true } });
    expect(await wf.am.opened(1, oliveBot)).toMatch(/workflow file/);
    expect(wf.am.state(1)).toBeNull();
    expect(wf.comments).toHaveLength(1);
  });

  it("leaves a branch rule naming the agent first, recorded as the rule's", async () => {
    const h = ownHarness({ author: botAuthor, settings: { a1: "squash" }, rules: { requiredChecks: ["ci"], allowAgentAutoMerge: true, autoMergeAgents: [{ id: "a1", login: "olive-bot" }], autoMergeMethod: "rebase" } });
    await h.am.opened(1, oliveBot);
    expect(h.am.state(1)).toMatchObject({ byRule: "main", method: "rebase" });
    expect(h.am.state(1)?.byDefault).toBeUndefined();
  });
});
