import { describe, expect, it } from "vitest";
import { evaluateIf } from "@diffinery/workflow-yaml";
import { ancestors, combineResults, graphFromLevels, jobStatus, runGraph, runnerLabels } from "../../src/repo/job-graph.js";

describe("ancestors", () => {
  it("follows needs transitively, once per job", () => {
    const needs = new Map([
      ["deploy", ["test", "lint"]],
      ["test", ["build"]],
      ["lint", ["build"]],
      ["build", []],
    ]);
    expect(ancestors(needs, ["test", "lint"]).sort()).toEqual(["build", "lint", "test"]);
    expect(ancestors(needs, [])).toEqual([]);
  });
});

describe("jobStatus", () => {
  const cond = (expr: string | undefined, results: Parameters<typeof jobStatus>[0], cancelled = false) => evaluateIf(expr, {}, jobStatus(results, cancelled));

  it("skips a job whose ancestor was skipped, even when its own need succeeded", () => {
    // a (skipped) <- b (if: always(), succeeded) <- c: c is skipped on GitHub.
    expect(cond(undefined, ["skipped", "success"])).toBe(false);
    expect(cond("success()", ["skipped"])).toBe(false);
    expect(cond("failure()", ["skipped"])).toBe(false);
    expect(cond("always()", ["skipped"])).toBe(true);
    // The usual workaround runs it.
    expect(cond("!cancelled() && !failure()", ["skipped", "success"])).toBe(true);
  });

  it("runs on success, and failure() sees a failed ancestor anywhere up the chain", () => {
    expect(cond(undefined, ["success", "success"])).toBe(true);
    expect(cond(undefined, [])).toBe(true);
    expect(cond(undefined, ["failure", "success"])).toBe(false);
    expect(cond("failure()", ["failure", "success"])).toBe(true);
    expect(cond("failure()", ["cancelled"])).toBe(false);
  });

  it("knows about cancelled runs", () => {
    expect(cond(undefined, ["success"], true)).toBe(false);
    expect(cond("cancelled()", ["success"], true)).toBe(true);
    expect(cond("always()", ["cancelled"], true)).toBe(true);
  });
});

describe("combineResults", () => {
  it("is skipped for a job that never ran or whose legs were all skipped", () => {
    expect(combineResults([])).toBe("skipped");
    expect(combineResults([{ conclusion: "skipped" }, { conclusion: "skipped" }])).toBe("skipped");
  });

  it("lets failure win over cancellation, and counts a timeout as a failure", () => {
    expect(combineResults([{ conclusion: "success" }, { conclusion: "cancelled" }])).toBe("cancelled");
    expect(combineResults([{ conclusion: "cancelled" }, { conclusion: "failure" }])).toBe("failure");
    expect(combineResults([{ conclusion: "timed_out" }])).toBe("failure");
  });

  it("treats a failed leg with continue-on-error as a success", () => {
    expect(combineResults([{ conclusion: "success" }, { conclusion: "failure", continueOnError: true }])).toBe("success");
    expect(combineResults([{ conclusion: "failure", continueOnError: true }, { conclusion: "failure" }])).toBe("failure");
  });
});

describe("runnerLabels", () => {
  const ctx = { matrix: { os: "ubuntu-24.04", labels: ["self-hosted", "gpu"] }, inputs: { runner: "linux" } };

  it("evaluates matrix and other contexts per leg", () => {
    expect(runnerLabels(["${{ matrix.os }}"], ctx)).toEqual(["ubuntu-24.04"]);
    expect(runnerLabels(["self-hosted", "${{ inputs.runner }}"], ctx)).toEqual(["self-hosted", "linux"]);
  });

  it("flattens an expression that yields a list, and drops empty labels", () => {
    expect(runnerLabels(["${{ matrix.labels }}"], ctx)).toEqual(["self-hosted", "gpu"]);
    expect(runnerLabels(["${{ matrix.missing }}", "linux"], ctx)).toEqual(["linux"]);
  });
});

describe("runGraph", () => {
  /** A controllable job: resolves when the test finishes it. */
  function harness() {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const start = (key: string) =>
      new Promise<void>((resolve) => {
        started.push(key);
        finish.set(key, resolve);
      });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const finishJob = async (key: string) => {
      finish.get(key)!();
      await tick();
    };
    return { started, finish: finishJob, start, tick };
  }

  it("starts a job as soon as its own needs finish, not when its whole level does", async () => {
    const h = harness();
    // build-a and build-b have no needs; test-a only needs build-a; deploy needs both tests.
    const done = runGraph(
      [
        { key: "build-a", needs: [] },
        { key: "build-b", needs: [] },
        { key: "test-a", needs: ["build-a"] },
        { key: "test-b", needs: ["build-b"] },
        { key: "deploy", needs: ["test-a", "test-b"] },
      ],
      h.start,
    );
    await h.tick();
    expect(h.started).toEqual(["build-a", "build-b"]);
    await h.finish("build-a");
    // build-b still runs: a level-by-level scheduler would hold test-a back here.
    expect(h.started).toEqual(["build-a", "build-b", "test-a"]);
    await h.finish("test-a");
    expect(h.started).not.toContain("deploy");
    await h.finish("build-b");
    expect(h.started).toEqual(["build-a", "build-b", "test-a", "test-b"]);
    await h.finish("test-b");
    expect(h.started.at(-1)).toBe("deploy");
    await h.finish("deploy");
    await done;
    expect(h.started).toHaveLength(5);
  });

  it("ignores needs outside the graph", async () => {
    const started: string[] = [];
    await runGraph([{ key: "a", needs: ["gone"] }], async (k) => void started.push(k));
    expect(started).toEqual(["a"]);
  });

  it("turns recorded levels into a graph where each level waits for the previous one", () => {
    expect(graphFromLevels([["a", "b"], ["c"], ["d"]])).toEqual([
      { key: "a", needs: [] },
      { key: "b", needs: [] },
      { key: "c", needs: ["a", "b"] },
      { key: "d", needs: ["c"] },
    ]);
  });
});
