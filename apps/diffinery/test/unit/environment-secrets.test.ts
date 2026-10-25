import { describe, expect, it } from "vitest";
import { secretsAllowedFor, type BranchPolicy } from "../../src/repo/deployments.js";

const protectedOnly: BranchPolicy = { protected_branches: true, custom_branch_policies: false, patterns: [] };
const main = { requirePullRequest: true };
const custom: BranchPolicy = { protected_branches: false, custom_branch_policies: true, patterns: [{ id: 1, name: "release/*", type: "branch" }] };

describe("environment secrets", () => {
  it("never go to pull request refs", () => {
    for (const p of [null, protectedOnly, custom]) {
      for (const kind of ["user", "agent", "system"]) expect(secretsAllowedFor(p, "refs/pull/7/merge", kind, main)).toBe(false);
    }
  });

  it("go to runs by people on allowed refs", () => {
    expect(secretsAllowedFor(null, "refs/heads/main", "user", main)).toBe(true);
    expect(secretsAllowedFor(custom, "refs/heads/release/1", "user", null)).toBe(true);
  });

  it("go to runs by agents only when the environment is limited to protected branches", () => {
    expect(secretsAllowedFor(null, "refs/heads/main", "agent", main)).toBe(false);
    expect(secretsAllowedFor(custom, "refs/heads/release/1", "agent", null)).toBe(false);
    expect(secretsAllowedFor(protectedOnly, "refs/heads/main", "agent", main)).toBe(true);
  });

  it("don't go to runs by agents on a protected branch agents may push to themselves", () => {
    expect(secretsAllowedFor(protectedOnly, "refs/heads/agents/x", "agent", { agentsMayPush: true })).toBe(false);
    expect(secretsAllowedFor(protectedOnly, "refs/heads/agents/x", "user", { agentsMayPush: true })).toBe(true);
    expect(secretsAllowedFor(protectedOnly, "refs/heads/other", "agent", null)).toBe(false);
  });
});
