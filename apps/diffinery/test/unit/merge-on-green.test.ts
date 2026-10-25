import { describe, expect, it } from "vitest";
import { mergeOnGreenOn, withMergeOnGreen, withoutMergeOnGreen } from "../../src/web/merge-on-green.js";

describe("Settings → Merge on green", () => {
  it("adds the checks and agents to the rule, keeping everything else on it", () => {
    const before = { requirePullRequest: true, requiredApprovals: 1, requiredChecks: ["old", "lint"], requiredCheckSources: { old: "ci-app", lint: "diffinery-actions" }, requireLinearHistory: true, mergeQueue: { method: "squash" as const } };
    const after = withMergeOnGreen(before, { checks: ["lint", "test"], agents: ["olive-bot"], withoutApproval: true, method: "rebase" });
    expect(after).toEqual({
      requirePullRequest: true,
      requiredApprovals: 1,
      requireLinearHistory: true,
      mergeQueue: { method: "squash" },
      requiredChecks: ["lint", "test"],
      // A binding stays with a check that stays required.
      requiredCheckSources: { lint: "diffinery-actions" },
      allowAgentAutoMerge: true,
      agentAutoMergeWithoutApproval: true,
      autoMergeAgents: ["olive-bot"],
      autoMergeMethod: "rebase",
    });
    expect(mergeOnGreenOn({ allowAgentAutoMerge: true, requiredChecks: ["lint"] })).toBe(true);
  });

  it("starts a rule from nothing, and drops the waiver and agents it isn't given", () => {
    expect(withMergeOnGreen(null, { checks: ["test"], agents: [], withoutApproval: false, method: "squash" })).toEqual({ requiredChecks: ["test"], allowAgentAutoMerge: true });
    const on = { requiredChecks: ["test"], allowAgentAutoMerge: true, agentAutoMergeWithoutApproval: true, autoMergeAgents: [{ id: "a1", login: "olive-bot" }], autoMergeMethod: "squash" as const };
    expect(withMergeOnGreen(on, { checks: ["test"], agents: [], withoutApproval: false, method: null })).toEqual({ requiredChecks: ["test"], allowAgentAutoMerge: true });
  });

  it("turns off by taking away what lets agents land, keeping the required checks", () => {
    const on = { requiredChecks: ["test"], requiredApprovals: 2, allowAgentAutoMerge: true, agentAutoMergeWithoutApproval: true, autoMergeAgents: [{ id: "a1", login: "olive-bot" }], autoMergeMethod: "squash" as const };
    expect(withoutMergeOnGreen(on)).toEqual({ requiredChecks: ["test"], requiredApprovals: 2 });
    expect(mergeOnGreenOn(withoutMergeOnGreen(on))).toBe(false);
    expect(mergeOnGreenOn({ allowAgentAutoMerge: true })).toBe(false);
    expect(mergeOnGreenOn(null)).toBe(false);
  });
});
