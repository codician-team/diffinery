import { describe, expect, it } from "vitest";
import { jobOrder, parseWorkflow, type Workflow } from "@diffinery/workflow-yaml";
import { ReusableError, expandReusable, parseCallRef, type Loader } from "../../src/repo/reusable.js";

const wf = (yaml: string, path = ".github/workflows/x.yml"): Workflow => {
  const { workflow, errors } = parseWorkflow(yaml, path);
  if (!workflow) throw new Error(errors.map((e) => e.message).join("; "));
  return workflow;
};

const LIB = wf(`on:
  workflow_call:
    inputs:
      who: { type: string }
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: echo a }]
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo b }]
`);

const files: Record<string, Workflow> = { "./.github/workflows/lib.yml": LIB };
const load: Loader = async (uses, from) => {
  const w = files[uses];
  if (!w) throw new Error(`${uses} not found`);
  return { workflow: w, source: from };
};
const root = { repoId: null, sha: "abc" };

describe("expandReusable", () => {
  it("flattens a call into prefixed jobs and orders around it", async () => {
    const main = wf(`on: push
jobs:
  first:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  call:
    needs: first
    uses: ./.github/workflows/lib.yml
    with: { who: me }
  last:
    needs: call
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`);
    const exp = await expandReusable(main, root, load);
    expect(Object.keys(exp.workflow.jobs)).toEqual(["first", "call/a", "call/b", "last"]);
    expect(exp.workflow.jobs["call/a"]!.needs).toEqual(["first"]);
    expect(exp.workflow.jobs["call/b"]!.needs).toEqual(["call/a"]);
    expect(exp.workflow.jobs["last"]!.needs.sort()).toEqual(["call/a", "call/b"]);
    expect(exp.needs.get("last")).toEqual(["call"]);
    expect(exp.parentOf.get("call/b")).toBe("call");
    expect(jobOrder(exp.workflow).order).toEqual([["first"], ["call/a"], ["call/b"], ["last"]]);
  });

  it("nests calls and stops at four levels", async () => {
    const level = (n: number) => wf(`on: workflow_call
jobs:
  j:
    uses: ./.github/workflows/l${n + 1}.yml
`);
    for (let i = 1; i <= 5; i++) files[`./.github/workflows/l${i}.yml`] = level(i);
    const main = wf(`on: push
jobs:
  top:
    uses: ./.github/workflows/l1.yml
`);
    await expect(expandReusable(main, root, load)).rejects.toThrow(ReusableError);
    files["./.github/workflows/l3.yml"] = LIB;
    const exp = await expandReusable(main, root, load);
    expect(Object.keys(exp.workflow.jobs)).toEqual(["top/j/j/a", "top/j/j/b"]);
  });

  it("rejects unknown inputs and workflows without workflow_call", async () => {
    files["./.github/workflows/plain.yml"] = wf(`on: push
jobs:
  x:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`);
    const bad = (uses: string, w = "") => wf(`on: push
jobs:
  c:
    uses: ${uses}
${w}`);
    await expect(expandReusable(bad("./.github/workflows/plain.yml"), root, load)).rejects.toThrow(/not a reusable workflow/);
    await expect(expandReusable(bad("./.github/workflows/lib.yml", "    with: { nope: 1 }\n"), root, load)).rejects.toThrow(/no input named 'nope'/);
    await expect(expandReusable(bad("./.github/workflows/missing.yml"), root, load)).rejects.toThrow(/not found/);
  });
});

describe("parseCallRef", () => {
  it("parses local and remote references", () => {
    expect(parseCallRef("./.github/workflows/a.yml")).toEqual({ kind: "local", path: ".github/workflows/a.yml" });
    expect(parseCallRef("octo/tools/.github/workflows/b.yaml@v1")).toEqual({ kind: "remote", owner: "octo", repo: "tools", path: ".github/workflows/b.yaml", ref: "v1" });
    expect(() => parseCallRef("octo/tools/.github/workflows/b.yaml")).toThrow();
    expect(parseCallRef("./.diffinery/workflows/c.yml")).toEqual({ kind: "local", path: ".diffinery/workflows/c.yml" });
    // A called workflow outside the workflow directories would dodge the guards on workflow changes.
    expect(() => parseCallRef("./ci/build.yml")).toThrow(/workflows/);
    expect(() => parseCallRef("./.github/workflows/../../ci/build.yml")).toThrow(/workflows/);
    expect(() => parseCallRef("octo/tools/ci/build.yml@main")).toThrow(/workflows/);
    expect(() => parseCallRef("octo/tools/.github/workflows/../ci/build.yml@main")).toThrow(/workflows/);
    expect(parseCallRef("octo/tools/.diffinery/workflows/d.yml@main")).toEqual({ kind: "remote", owner: "octo", repo: "tools", path: ".diffinery/workflows/d.yml", ref: "main" });
  });
});
