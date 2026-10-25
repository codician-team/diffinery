import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LogBatcher, cpuTimes, hostCpu } from "../src/api.js";
import { parseCommand, parseKeyValueFile, parsePathFile } from "../src/commands.js";
import { Masker } from "../src/mask.js";
import { parseUses, inputEnvName } from "../src/steps/actions.js";
import { resolveShell } from "../src/steps/run.js";
import { globPaths, hashFiles, maxSatisfying, satisfies, shellWords } from "../src/util.js";
import { parseYaml } from "../src/yaml.js";
import { resolveNodeVersion } from "../src/builtins/setup-node.js";
import { cloneUrlFor, basicAuthHeader } from "../src/builtins/checkout.js";
import { tmp } from "./helpers.js";
import { jobUsesDocker } from "../src/job.js";
import type { JobSpec } from "@diffinery/shared";

describe("yaml", () => {
  it("parses a typical action.yml", () => {
    const doc = parseYaml(`
# comment
name: 'My Action'
description: "Does \\"things\\""
author: someone # trailing comment
inputs:
  token:
    description: >
      The token to use
      for things.
    required: true
    default: \${{ github.token }}
  list:
    default: |
      a
      b
  empty:
outputs:
  result:
    value: \${{ steps.x.outputs.y }}
branding: { icon: 'box', color: blue }
tags: [a, "b c", 3]
runs:
  using: composite
  steps:
    - id: x
      run: |
        echo "hi: there"
        echo done
      shell: bash
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    -
      name: nested
      run: echo nested
  multi: this is
    a folded plain
`) as Record<string, any>;
    expect(doc.name).toBe("My Action");
    expect(doc.description).toBe('Does "things"');
    expect(doc.author).toBe("someone");
    expect(doc.inputs.token.description).toBe("The token to use for things.\n");
    expect(doc.inputs.token.required).toBe(true);
    expect(doc.inputs.token.default).toBe("${{ github.token }}");
    expect(doc.inputs.list.default).toBe("a\nb\n");
    expect(doc.inputs.empty).toBeNull();
    expect(doc.outputs.result.value).toBe("${{ steps.x.outputs.y }}");
    expect(doc.branding).toEqual({ icon: "box", color: "blue" });
    expect(doc.tags).toEqual(["a", "b c", 3]);
    expect(doc.runs.using).toBe("composite");
    expect(doc.runs.steps).toHaveLength(3);
    expect(doc.runs.steps[0]).toEqual({ id: "x", run: 'echo "hi: there"\necho done\n', shell: "bash" });
    expect(doc.runs.steps[1]).toEqual({ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } });
    expect(doc.runs.steps[2]).toEqual({ name: "nested", run: "echo nested" });
    expect(doc.runs.multi).toBe("this is a folded plain");
  });

  it("handles chomping, sequences at mapping indent and quotes", () => {
    const doc = parseYaml(`a: |-
  keep
  this
b: >-
  folded
  text

  para
c:
- x
- 'it''s'
- "tab\\tnl\\n"
d: "multi
  line"
`) as Record<string, any>;
    expect(doc.a).toBe("keep\nthis");
    expect(doc.b).toBe("folded text\npara");
    expect(doc.c).toEqual(["x", "it's", "tab\tnl\n"]);
    expect(doc.d).toBe("multi line");
  });
});

describe("workflow commands", () => {
  it("parses commands with properties and escapes", () => {
    expect(parseCommand("::set-output name=foo::bar")).toEqual({ command: "set-output", properties: { name: "foo" }, message: "bar" });
    expect(parseCommand("::error file=a.ts,line=3,title=Bad%3A thing::multi%0Aline%25")).toEqual({
      command: "error",
      properties: { file: "a.ts", line: "3", title: "Bad: thing" },
      message: "multi\nline%",
    });
    expect(parseCommand("::endgroup::")).toEqual({ command: "endgroup", properties: {}, message: "" });
    expect(parseCommand("not a command")).toBeNull();
    expect(parseCommand(":: nope")).toBeNull();
  });

  it("parses env files incl. heredoc syntax", () => {
    const c = "A=1\nB=x=y\nMULTI<<EOF\nl1\nl2\nEOF\nEMPTY=\nC<<ghadelimiter_123\n\nghadelimiter_123\n";
    expect(parseKeyValueFile(c)).toEqual([
      ["A", "1"],
      ["B", "x=y"],
      ["MULTI", "l1\nl2"],
      ["EMPTY", ""],
      ["C", ""],
    ]);
    expect(() => parseKeyValueFile("X<<EOF\nnever closed")).toThrow(/delimiter/);
    expect(() => parseKeyValueFile("garbage")).toThrow();
    expect(parsePathFile("/a\n\n /b \n")).toEqual(["/a", "/b"]);
  });
});

describe("masker", () => {
  it("masks values, longest first, and each line of multi-line secrets", () => {
    const m = new Masker();
    m.add("abc");
    m.add("abcdef");
    m.add("-----BEGIN KEY-----\nAAAABBBB\n-----END KEY-----");
    m.add("");
    m.add("   ");
    m.add("t"); // too short to mask
    expect(m.mask("test")).toBe("test");
    expect(m.mask("x abcdef y abc z")).toBe("x *** y *** z");
    expect(m.mask("AAAABBBB")).toBe("***");
    expect(m.mask("nothing here")).toBe("nothing here");
    expect(m.containsSecret("..abc..")).toBe(true);
  });
});

describe("versions", () => {
  it("matches common version specs", () => {
    expect(satisfies("22.11.0", "22")).toBe(true);
    expect(satisfies("22.11.0", "22.x")).toBe(true);
    expect(satisfies("22.11.0", "20")).toBe(false);
    expect(satisfies("22.11.0", ">=20")).toBe(true);
    expect(satisfies("22.11.0", ">=18 <21")).toBe(false);
    expect(satisfies("20.5.0", "18 || 20")).toBe(true);
    expect(satisfies("20.5.1", "^20.5")).toBe(true);
    expect(satisfies("20.6.0", "~20.5")).toBe(false);
    expect(satisfies("3.12.4", "3.12")).toBe(true);
    expect(satisfies("3.13.0", "3.12")).toBe(false);
    expect(satisfies("1.22.3", "1.22.3")).toBe(true);
    expect(maxSatisfying(["v20.1.0", "v22.3.0", "v22.10.1", "v23.0.0"], "22")).toBe("v22.10.1");
  });

  it("resolves node lts aliases", () => {
    const idx = [
      { version: "v23.1.0", lts: false as const, files: ["linux-x64", "linux-arm64"] },
      { version: "v22.11.0", lts: "Jod", files: ["linux-x64", "linux-arm64"] },
      { version: "v20.18.0", lts: "Iron", files: ["linux-x64", "linux-arm64"] },
    ];
    expect(resolveNodeVersion(idx, "lts/*")).toBe("22.11.0");
    expect(resolveNodeVersion(idx, "lts/iron")).toBe("20.18.0");
    expect(resolveNodeVersion(idx, "lts/-1")).toBe("20.18.0");
    expect(resolveNodeVersion(idx, "latest")).toBe("23.1.0");
    expect(resolveNodeVersion(idx, "20")).toBe("20.18.0");
  });
});

describe("glob + hashFiles", () => {
  it("expands globs with negation and hashes deterministically", () => {
    const root = tmp();
    mkdirSync(path.join(root, "a/b"), { recursive: true });
    writeFileSync(path.join(root, "a/x.txt"), "x");
    writeFileSync(path.join(root, "a/b/y.txt"), "y");
    writeFileSync(path.join(root, "a/b/z.log"), "z");
    expect(globPaths(root, ["**/*.txt"], { filesOnly: true }).map((p) => path.relative(root, p))).toEqual(["a/b/y.txt", "a/x.txt"]);
    expect(globPaths(root, ["a/**", "!a/b/z.log"], { filesOnly: true }).map((p) => path.relative(root, p))).toEqual(["a/b/y.txt", "a/x.txt"]);
    expect(globPaths(root, ["a"]).map((p) => path.relative(root, p))).toEqual(["a"]);
    const h1 = hashFiles(root, ["**/*.txt"]);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFiles(root, ["**/*.txt"])).toBe(h1);
    expect(hashFiles(root, ["**/*.nope"])).toBe("");
  });
});

describe("misc", () => {
  it("splits shell words and resolves shells", () => {
    expect(shellWords(`pwsh -command ". '/tmp/x.ps1'"`)).toEqual(["pwsh", "-command", ". '/tmp/x.ps1'"]);
    expect(resolveShell(undefined, "/t/s.sh", process.env.PATH).argv).toEqual(["bash", "--noprofile", "--norc", "-eo", "pipefail", "/t/s.sh"]);
    expect(resolveShell("sh", "/t/s.sh", process.env.PATH).argv).toEqual(["sh", "-e", "/t/s.sh"]);
    expect(resolveShell("perl {0}", "/t/s.sh", process.env.PATH).argv).toEqual(["perl", "/t/s.sh"]);
    expect(resolveShell("python", "/t/s.py", process.env.PATH).ext).toBe(".py");
    expect(() => resolveShell("zsh", "/t/s", process.env.PATH)).toThrow(/Invalid shell/);
  });

  it("parses uses references", () => {
    expect(parseUses("actions/checkout@v4")).toMatchObject({ kind: "remote", owner: "actions", repo: "checkout", subpath: "", ref: "v4", name: "actions/checkout" });
    expect(parseUses("actions/cache/restore@v4")).toMatchObject({ kind: "remote", subpath: "restore", name: "actions/cache/restore" });
    expect(parseUses("./.github/actions/x")).toEqual({ kind: "local", path: "./.github/actions/x" });
    expect(parseUses("docker://alpine:3")).toEqual({ kind: "docker", image: "alpine:3" });
    expect(() => parseUses("nope")).toThrow();
    expect(inputEnvName("my input-name")).toBe("INPUT_MY_INPUT-NAME");
  });

  it("derives clone urls and auth headers", () => {
    const spec = { repo: { owner: "acme", name: "widgets", cloneUrl: "https://diffinery.com/acme/widgets.git" } };
    expect(cloneUrlFor(spec, "acme/widgets")).toBe("https://diffinery.com/acme/widgets.git");
    expect(cloneUrlFor(spec, "other/lib")).toBe("https://diffinery.com/other/lib.git");
    expect(basicAuthHeader("tok")).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
  });

  it("log batcher retries and never drops lines", async () => {
    const received: string[] = [];
    let fails = 2;
    const b = new LogBatcher(
      async (lines) => {
        if (fails-- > 0) throw new Error("boom");
        received.push(...lines.map((l) => l.text));
      },
      { intervalMs: 20, maxBatch: 3 },
    );
    for (let i = 0; i < 10; i++) b.push({ t: "", step: 0, text: `l${i}` });
    expect(await b.close(10_000)).toBe(true);
    expect(received).toEqual(Array.from({ length: 10 }, (_, i) => `l${i}`));
  });
});

describe("host", () => {
  it("names the host's processor, and reads the vCPUs' stolen time", () => {
    const core = (n: number) => `processor\t: ${n}\nvendor_id\t: AuthenticAMD\ncpu family\t: 25\nmodel\t\t: 17\nmodel name\t: AMD EPYC\ncpu MHz\t\t: 2549.998\n\n`;
    expect(hostCpu([0, 1, 2, 3].map(core).join(""))).toBe("AMD EPYC (family 25, model 17), 4 vCPUs, 2550 MHz");
    expect(hostCpu("")).toBeUndefined();
    expect(cpuTimes("cpu  1498 0 227 267312 359 0 61 514 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\n")).toEqual({ total: 269971, steal: 514 });
    expect(cpuTimes("intr 1 2 3\n")).toBeNull();
  });
});

describe("docker head start", () => {
  const spec = (steps: Array<{ run?: string; uses?: string }>, more: Partial<JobSpec> = {}) => ({ steps, ...more }) as JobSpec;
  it("starts the daemon early only for jobs that will use Docker", () => {
    expect(jobUsesDocker(spec([{ uses: "actions/checkout@v4" }, { run: "docker build -t app ." }]))).toBe(true);
    expect(jobUsesDocker(spec([{ uses: "docker/build-push-action@v6" }]))).toBe(true);
    expect(jobUsesDocker(spec([{ uses: "docker://alpine:3.20" }]))).toBe(true);
    expect(jobUsesDocker(spec([{ run: "npm test" }], { services: { db: { image: "postgres:16" } } as JobSpec["services"] }))).toBe(true);
    expect(jobUsesDocker(spec([{ run: "npm test" }], { container: { image: "node:22" } as JobSpec["container"] }))).toBe(true);
    expect(jobUsesDocker(spec([{ uses: "actions/checkout@v4" }, { run: "pnpm install && pnpm test" }]))).toBe(false);
    expect(jobUsesDocker(spec([{ run: "echo dockerfile-lint" }]))).toBe(false);
  });
});
