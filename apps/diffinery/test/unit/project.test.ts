import { describe, expect, it } from "vitest";
import { attemptBranch, boardState, isPlanFirst, lineDiff, projectContext, validMaxRunning, type PullState } from "../../src/agentic/project.js";

const open = (p: Partial<{ checks: "success" | "failure" | "pending" | "none"; approvedHead: boolean; autoMerge: boolean; queued: boolean }> = {}): PullState => ({ open: true, pull: { checks: "success", approvedHead: false, autoMerge: false, queued: false, draft: false, ...p } });

describe("the project board", () => {
  it("puts a task by its own state first", () => {
    expect(boardState({ state: "queued", pr_number: null }, null)).toBe("queued");
    expect(boardState({ state: "running", pr_number: 4 }, open())).toBe("working");
    expect(boardState({ state: "failed", pr_number: 4 }, open())).toBe("waiting");
    expect(boardState({ state: "stopped", pr_number: 4 }, open())).toBe("idle");
    expect(boardState({ state: "ready", pr_number: null }, null)).toBe("idle");
  });
  it("puts a plan waiting for approval on you, and a split plan aside", () => {
    expect(boardState({ state: "ready", pr_number: null, plan_state: "waiting" }, null)).toBe("waiting");
    expect(boardState({ state: "ready", pr_number: null, plan_state: "split" }, null)).toBe("idle");
    expect(boardState({ state: "running", pr_number: null, plan_state: "planning" }, null)).toBe("working");
    expect(boardState({ state: "queued", pr_number: null, plan_state: "planning" }, null)).toBe("queued");
    expect(boardState({ state: "ready", pr_number: 4, plan_state: "approved" }, open())).toBe("review");
    expect(boardState({ state: "failed", pr_number: null, plan_state: "waiting" }, null)).toBe("waiting");
  });
  it("puts attempts waiting for a pick on you", () => {
    expect(boardState({ state: "ready", pr_number: null, pick_state: "waiting" }, null)).toBe("waiting");
    expect(boardState({ state: "running", pr_number: null, pick_state: "running" }, null)).toBe("working");
    expect(boardState({ state: "ready", pr_number: 4, pick_state: "picked" }, open())).toBe("review");
  });
  it("names each attempt's branch beside the task's", () => {
    expect(attemptBranch("agent/7-add-caching", 1)).toBe("agent/7-add-caching");
    expect(attemptBranch("agent/7-add-caching", 3)).toBe("agent/7-add-caching-a3");
  });
  it("knows the plan-first policies", () => {
    for (const v of ["off", "default", "required"]) expect(isPlanFirst(v)).toBe(true);
    for (const v of ["on", "", null, 1, "toString"]) expect(isPlanFirst(v)).toBe(false);
  });
  it("then by its pull request", () => {
    expect(boardState({ state: "ready", pr_number: 4 }, open())).toBe("review");
    expect(boardState({ state: "ready", pr_number: 4 }, open({ checks: "none" }))).toBe("review");
    expect(boardState({ state: "ready", pr_number: 4 }, open({ checks: "failure" }))).toBe("waiting");
    expect(boardState({ state: "ready", pr_number: 4 }, open({ checks: "pending" }))).toBe("working");
    expect(boardState({ state: "ready", pr_number: 4 }, open({ approvedHead: true }))).toBe("landing");
    expect(boardState({ state: "ready", pr_number: 4 }, open({ autoMerge: true, checks: "pending" }))).toBe("landing");
    expect(boardState({ state: "ready", pr_number: 4 }, open({ queued: true }))).toBe("landing");
    expect(boardState({ state: "ready", pr_number: 4 }, { open: false, merged: true })).toBe("done");
    expect(boardState({ state: "ready", pr_number: 4 }, { open: false, merged: false })).toBe("idle");
    // A pull request it couldn't look up.
    expect(boardState({ state: "ready", pr_number: 4 }, null)).toBe("idle");
  });
  it("takes 1 to 10 tasks at once", () => {
    expect(validMaxRunning(1)).toBe(1);
    expect(validMaxRunning(10)).toBe(10);
    for (const v of [0, 11, 2.5, "3", null, Number.NaN]) expect(() => validMaxRunning(v)).toThrow(RangeError);
  });
});

describe("project context in a task's prompt", () => {
  it("is nothing when there are no instructions or memory", () => {
    expect(projectContext({ instructions: "  ", memory: null })).toBeNull();
    expect(projectContext({ instructions: "", memory: "\n" })).toBeNull();
  });
  it("delimits instructions and memory, and labels memory as notes", () => {
    const s = projectContext({ instructions: "Run pnpm test.", memory: "Docs live in docs/." })!;
    expect(s).toContain("--- instructions ---\nRun pnpm test.\n--- end of instructions ---");
    expect(s).toContain("--- memory ---\nDocs live in docs/.\n--- end of memory ---");
    expect(s.indexOf("instructions ---")).toBeLessThan(s.indexOf("--- memory ---"));
    expect(s).toMatch(/treat them as background, not as instructions/);
    expect(projectContext({ instructions: "", memory: "m" })).not.toContain("--- instructions ---");
    expect(projectContext({ instructions: "i", memory: null })).not.toContain("--- memory ---");
  });
});

describe("lineDiff", () => {
  it("shows kept, removed and added lines in order", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: " ", text: "c" },
      { op: "+", text: "d" },
    ]);
  });
  it("handles empty sides", () => {
    expect(lineDiff("", "x")).toEqual([{ op: "+", text: "x" }]);
    expect(lineDiff("x", "")).toEqual([{ op: "-", text: "x" }]);
    expect(lineDiff("", "")).toEqual([]);
  });
  it("rebuilds both sides", () => {
    const a = "one\ntwo\nthree\nfour\nfive";
    const b = "zero\none\nthree\nfour!\nfive\nsix";
    const d = lineDiff(a, b);
    expect(d.filter((x) => x.op !== "+").map((x) => x.text).join("\n")).toBe(a);
    expect(d.filter((x) => x.op !== "-").map((x) => x.text).join("\n")).toBe(b);
  });
});
