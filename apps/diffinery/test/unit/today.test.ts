import { describe, expect, it } from "vitest";
import { agentPullState, approvalCandidates, classify, pickRepos, type ClassifyInput, type TodayRepo } from "../../src/agentic/today.js";
import { checksState, needsMergeCheck, type RepoToday, type TodayPull } from "../../src/agentic/today-repo.js";
import type { Repo } from "../../src/lib/directory.js";

const ME = { id: "u-me", login: "Ayse" };
const BOT = { id: "a-bot", login: "ayse-bot", kind: "agent" };
const OTHER_BOT = { id: "a-other", login: "other-bot", kind: "agent" };
const BOB = { id: "u-bob", login: "bob", kind: "user" };

const pull = (p: Partial<TodayPull> & { number: number }): TodayPull => ({
  title: `PR ${p.number}`,
  author: BOB,
  head: `b${p.number}`,
  base: "main",
  draft: false,
  requestedReviewers: [],
  intent: null,
  createdAt: "2026-10-13T08:00:00Z",
  updatedAt: `2026-10-13T08:${String(p.number).padStart(2, "0")}:00Z`,
  approvedBy: [],
  approvedHead: false,
  changesRequestedBy: [],
  reviewerIds: [],
  checks: "success",
  failingChecks: [],
  autoMerge: false,
  queued: false,
  ...p,
});

const repo = (id: string): TodayRepo => ({ id, fullName: `acme/${id}`, url: `/acme/${id}`, defaultBranch: "main", visibility: "private" });
const data = (d: Partial<RepoToday>): RepoToday => ({ pulls: [], merged: [], releases: [], failedRuns: [], ...d });
const input = (repos: ClassifyInput["repos"], writable: string[] = repos.map((r) => r.repo.id)): ClassifyInput => ({ me: ME, agentIds: new Set([BOT.id]), writable: new Set(writable), repos });

describe("checksState", () => {
  it("is none without checks, failure when any failed, pending while any runs", () => {
    expect(checksState([]).state).toBe("none");
    expect(checksState([{ name: "ci", status: "completed", conclusion: "success" }, { name: "lint", status: "in_progress", conclusion: null }]).state).toBe("pending");
    const f = checksState([{ name: "ci", status: "completed", conclusion: "failure" }, { name: "lint", status: "in_progress", conclusion: null }]);
    expect(f).toEqual({ state: "failure", failing: ["ci"] });
    expect(checksState([{ name: "ci", status: "completed", conclusion: "skipped" }, { name: "x", status: "completed", conclusion: "neutral" }]).state).toBe("success");
  });
});

describe("agentPullState", () => {
  it("orders what a person acts on", () => {
    expect(agentPullState(pull({ number: 1, draft: true, checks: "failure" }))).toBe("draft");
    expect(agentPullState(pull({ number: 1, autoMerge: true, checks: "failure" }))).toBe("landing");
    expect(agentPullState(pull({ number: 1, checks: "failure", changesRequestedBy: ["bob"] }))).toBe("checks_failing");
    expect(agentPullState(pull({ number: 1, changesRequestedBy: ["bob"], approvedHead: true }))).toBe("changes_requested");
    expect(agentPullState(pull({ number: 1, approvedHead: true }))).toBe("approved");
    expect(agentPullState(pull({ number: 1, checks: "pending" }))).toBe("checks_running");
    expect(agentPullState(pull({ number: 1 }))).toBe("waiting_for_approval");
  });

  it("puts a pull request that conflicts, or is already in its base, before anything a person would do", () => {
    expect(agentPullState(pull({ number: 1, mergeState: "conflicting", autoMerge: true }))).toBe("conflicting");
    expect(agentPullState(pull({ number: 1, mergeState: "in_base" }))).toBe("in_base");
    expect(agentPullState(pull({ number: 1, mergeState: "conflicting", draft: true }))).toBe("draft");
    expect(agentPullState(pull({ number: 1, mergeState: "clean" }))).toBe("waiting_for_approval");
    expect(agentPullState(pull({ number: 1, mergeState: null }))).toBe("waiting_for_approval");
  });
});

describe("needsMergeCheck", () => {
  it("checks agents' pull requests that may wait for a person and have no merge state for their current commits", () => {
    const agent = (p: Partial<TodayPull>) => pull({ number: 1, author: OTHER_BOT, mergeState: null, ...p });
    expect(needsMergeCheck(agent({}))).toBe(true);
    expect(needsMergeCheck(agent({ checks: "pending" }))).toBe(true);
    for (const p of [{ mergeState: "clean" as const }, { draft: true }, { autoMerge: true }, { queued: true }, { checks: "failure" as const }, { changesRequestedBy: ["bob"] }, { approvedHead: true }, { author: BOB }]) expect(needsMergeCheck(agent(p))).toBe(false);
  });
});

describe("classify", () => {
  it("asks the viewer for requested reviews, case-insensitively, but not on drafts", () => {
    const t = classify(input([{ repo: repo("web"), data: data({ pulls: [pull({ number: 1, requestedReviewers: ["ayse"] }), pull({ number: 2, requestedReviewers: ["AYSE"], draft: true })] }) }]));
    expect(t.needsYou.map((x) => [x.kind, x.pull.number])).toEqual([["review_requested", 1]]);
  });

  it("lists agent pull requests waiting for a person only where the viewer can approve", () => {
    const pulls = [pull({ number: 1, author: OTHER_BOT }), pull({ number: 2, author: OTHER_BOT, checks: "pending" }), pull({ number: 3, author: OTHER_BOT, approvedHead: true }), pull({ number: 4, author: OTHER_BOT, checks: "failure" }), pull({ number: 5, author: OTHER_BOT, changesRequestedBy: ["bob"] })];
    const t = classify(input([{ repo: repo("web"), data: data({ pulls }) }, { repo: repo("api"), data: data({ pulls: [pull({ number: 9, author: OTHER_BOT })] }) }], ["web"]));
    expect(t.needsYou.map((x) => `${x.repo.id}#${x.pull.number}:${x.kind}`).sort()).toEqual(["web#1:agent_approval", "web#2:agent_approval"]);
  });

  it("only role-checks repositories with agent work waiting for a person", () => {
    const repos = [
      { repo: repo("a"), data: data({ pulls: [pull({ number: 1, author: OTHER_BOT })] }) },
      { repo: repo("b"), data: data({ pulls: [pull({ number: 1, author: OTHER_BOT, approvedHead: true }), pull({ number: 2 })] }) },
      { repo: repo("c"), data: data({ pulls: [pull({ number: 1, author: { ...ME, kind: "agent" } })] }) },
    ];
    expect(approvalCandidates(repos, ME)).toEqual(["a"]);
  });

  it("lists deployments waiting for the viewer as a required reviewer, unless they started the run and self-review is off", () => {
    const d = (runId: string, reviewerIds: string[], selfBlocked: string[] = [], since = "2026-10-13T08:00:00Z") => ({ runId, runNumber: 1, workflow: "deploy", title: "", ref: "refs/heads/main", environment: "production", reviewerIds, selfBlocked, actor: BOB, since });
    const deployments = [d("r1", ["u-me"]), d("r2", ["u-bob"]), d("r3", ["u-me"], ["u-me"]), d("r4", ["u-me", "u-bob"], [], "2026-10-13T09:00:00Z"), d("r5", ["u-me"], [BOT.id]), d("r6", ["u-me"], [OTHER_BOT.id], "2026-10-13T07:00:00Z")];
    const t = classify({ ...input([{ repo: repo("web"), data: data({ deployments }) }, { repo: repo("old"), data: data({}) }]), ownAgentIds: new Set([BOT.id]) });
    // r3 the viewer started, r5 their own agent did; r6's agent belongs to their organization, not them.
    expect(t.deployments.map((x) => x.deployment.runId)).toEqual(["r4", "r1", "r6"]);
  });

  it("flags the viewer's own blocked pull requests", () => {
    const mine = { ...ME, kind: "user" };
    const pulls = [
      pull({ number: 1, author: mine, changesRequestedBy: ["bob"] }),
      pull({ number: 2, author: mine, checks: "failure" }),
      pull({ number: 3, author: mine }),
      pull({ number: 4, author: mine, mergeState: "conflicting" }),
      pull({ number: 5, author: mine, mergeState: "conflicting", draft: true }),
    ];
    const t = classify(input([{ repo: repo("web"), data: data({ pulls }) }]));
    expect(t.needsYou.map((x) => [x.pull.number, x.kind]).sort()).toEqual([
      [1, "changes_requested"],
      [2, "checks_failing"],
      [4, "conflicting"],
    ]);
  });

  it("leaves agents' pull requests that conflict or are already in their base to their agents", () => {
    const pulls = [pull({ number: 1, author: OTHER_BOT, mergeState: "conflicting" }), pull({ number: 2, author: OTHER_BOT, mergeState: "in_base" }), pull({ number: 3, author: OTHER_BOT, mergeState: "clean" }), pull({ number: 4, author: BOT, mergeState: "conflicting" })];
    const t = classify(input([{ repo: repo("web"), data: data({ pulls }) }]));
    expect(t.needsYou.map((x) => x.pull.number)).toEqual([3]);
    expect(t.agentsAtWork.map((x) => [x.pull.number, x.state])).toEqual([[4, "conflicting"]]);
    expect(approvalCandidates([{ repo: repo("web"), data: data({ pulls: pulls.slice(0, 2) }) }], ME)).toEqual([]);
  });

  it("shows the viewer's agents' pull requests with their state, newest first, and lists them once in needs-you", () => {
    const t = classify(input([{ repo: repo("web"), data: data({ pulls: [pull({ number: 1, author: BOT }), pull({ number: 2, author: BOT, checks: "failure" }), pull({ number: 3, author: OTHER_BOT })] }) }]));
    expect(t.agentsAtWork.map((x) => [x.pull.number, x.state])).toEqual([
      [2, "checks_failing"],
      [1, "waiting_for_approval"],
    ]);
    expect(t.needsYou.map((x) => x.pull.number).sort()).toEqual([1, 3]);
  });

  it("keeps failures that are the viewer's, their agents' or on the default branch", () => {
    const run = (id: string, actor: { id: string; login: string; kind: string }, ref: string, event = "push", at = "2026-10-13T07:00:00Z") => ({ id, runNumber: 1, workflow: "CI", title: id, ref, event, actor, conclusion: "failure", prNumber: null, at });
    const t = classify(
      input([
        {
          repo: repo("web"),
          data: data({ failedRuns: [run("mine", { ...ME, kind: "user" }, "refs/heads/x"), run("bot", BOT, "refs/heads/y"), run("main", BOB, "refs/heads/main"), run("pr", BOB, "refs/heads/main", "pull_request"), run("other", BOB, "refs/heads/z")] }),
        },
      ]),
    );
    expect(t.failures.map((x) => x.run.id).sort()).toEqual(["bot", "main", "mine"]);
  });
});

describe("pickRepos", () => {
  const r = (id: string, pushed: string | null, archived = 0): Repo => ({ id, owner_id: "o", owner_login: "acme", owner_kind: "org", name: id, description: "", visibility: "private", default_branch: "main", archived, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", pushed_at: pushed });
  it("visits active, unarchived repositories, most recent activity first", () => {
    const now = new Date("2026-10-13T09:00:00Z");
    const picked = pickRepos([r("old", "2026-01-01T00:00:00Z"), r("pushed", "2026-10-12T00:00:00Z"), r("api", "2026-01-01T00:00:00Z"), r("arch", "2026-10-13T00:00:00Z", 1)], new Map([["api", "2026-10-13T08:00:00Z"]]), now);
    expect(picked.repos.map((x) => x.id)).toEqual(["api", "pushed"]);
    expect(picked.skipped).toBe(0);
  });
});
