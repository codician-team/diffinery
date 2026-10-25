import { describe, expect, it } from "vitest";
import { expandMatrix, MatrixError } from "../src/index.js";

describe("expandMatrix", () => {
  it("no matrix yields one empty combination", () => {
    expect(expandMatrix(undefined)).toEqual([{}]);
    expect(expandMatrix(null)).toEqual([{}]);
  });

  it("single dimension", () => {
    expect(expandMatrix({ version: [10, 12, 14] })).toEqual([{ version: 10 }, { version: 12 }, { version: 14 }]);
  });

  it("cartesian product with first key outermost", () => {
    expect(expandMatrix({ os: ["ubuntu-latest", "windows-latest"], version: [10, 12, 14] })).toEqual([
      { os: "ubuntu-latest", version: 10 },
      { os: "ubuntu-latest", version: 12 },
      { os: "ubuntu-latest", version: 14 },
      { os: "windows-latest", version: 10 },
      { os: "windows-latest", version: 12 },
      { os: "windows-latest", version: 14 },
    ]);
  });

  it("include example from the GitHub docs", () => {
    const out = expandMatrix({
      fruit: ["apple", "pear"],
      animal: ["cat", "dog"],
      include: [
        { color: "green" },
        { color: "pink", animal: "cat" },
        { fruit: "apple", shape: "circle" },
        { fruit: "banana" },
        { fruit: "banana", animal: "cat" },
      ],
    });
    expect(out).toEqual([
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ]);
  });

  it("expanding configurations example from the docs", () => {
    const out = expandMatrix({
      os: ["windows-latest", "ubuntu-latest"],
      node: [14, 16],
      include: [{ os: "windows-latest", node: 16, npm: 6 }],
    });
    expect(out).toEqual([
      { os: "windows-latest", node: 14 },
      { os: "windows-latest", node: 16, npm: 6 },
      { os: "ubuntu-latest", node: 14 },
      { os: "ubuntu-latest", node: 16 },
    ]);
  });

  it("include-only matrix", () => {
    expect(
      expandMatrix({
        include: [
          { site: "production", datacenter: "site-a" },
          { site: "staging", datacenter: "site-b" },
        ],
      }),
    ).toEqual([
      { site: "production", datacenter: "site-a" },
      { site: "staging", datacenter: "site-b" },
    ]);
  });

  it("exclude with partial match (docs example)", () => {
    const out = expandMatrix({
      os: ["macos-latest", "windows-latest"],
      version: [12, 14, 16],
      environment: ["staging", "production"],
      exclude: [
        { os: "macos-latest", version: 12, environment: "production" },
        { os: "windows-latest", version: 16 },
      ],
    });
    expect(out).toHaveLength(12 - 1 - 2);
    expect(out).not.toContainEqual({ os: "macos-latest", version: 12, environment: "production" });
    expect(out.filter((c) => c.os === "windows-latest" && c.version === 16)).toEqual([]);
    expect(out).toContainEqual({ os: "macos-latest", version: 12, environment: "staging" });
  });

  it("exclude is applied before include, and include can re-add", () => {
    const out = expandMatrix({
      os: ["linux", "mac"],
      exclude: [{ os: "mac" }],
      include: [{ os: "mac", experimental: true }],
    });
    expect(out).toEqual([{ os: "linux" }, { os: "mac", experimental: true }]);
  });

  it("exclude everything leaves no combinations", () => {
    expect(expandMatrix({ os: ["a"], exclude: [{ os: "a" }] })).toEqual([]);
  });

  it("object-valued vectors and partial object exclude", () => {
    const out = expandMatrix({
      cfg: [
        { name: "a", flags: "-O2" },
        { name: "b", flags: "-O0" },
      ],
      arch: ["x64", "arm64"],
      exclude: [{ cfg: { name: "b" }, arch: "arm64" }],
    });
    expect(out).toEqual([
      { cfg: { name: "a", flags: "-O2" }, arch: "x64" },
      { cfg: { name: "a", flags: "-O2" }, arch: "arm64" },
      { cfg: { name: "b", flags: "-O0" }, arch: "x64" },
    ]);
  });

  it("include matching values loosely ('18' vs 18)", () => {
    expect(expandMatrix({ node: [18, 20], include: [{ node: "18", lts: true }] })).toEqual([
      { node: 18, lts: true },
      { node: 20 },
    ]);
  });

  it("evaluates a fromJSON matrix expression with ctx", () => {
    const ctx = { needs: { setup: { outputs: { matrix: '{"pkg":["a","b"],"include":[{"pkg":"a","extra":1}]}' } } } };
    expect(expandMatrix("${{ fromJSON(needs.setup.outputs.matrix) }}", ctx)).toEqual([
      { pkg: "a", extra: 1 },
      { pkg: "b" },
    ]);
  });

  it("evaluates expression vectors and include lists", () => {
    const ctx = { inputs: { versions: "[1,2]", extra: '[{"v":3}]' } };
    expect(expandMatrix({ v: "${{ fromJSON(inputs.versions) }}", include: "${{ fromJSON(inputs.extra) }}" }, ctx)).toEqual([
      { v: 1 },
      { v: 2 },
      { v: 3 },
    ]);
  });

  it("errors on invalid shapes", () => {
    expect(() => expandMatrix({ os: "ubuntu" })).toThrow(MatrixError);
    expect(() => expandMatrix({ include: ["x"] })).toThrow(/include\[0\]/);
    expect(() => expandMatrix([1, 2])).toThrow(/mapping/);
  });
});

describe("matrix size", () => {
  it("refuses a matrix with too many combinations before building any", () => {
    const m: Record<string, number[]> = {};
    for (let i = 0; i < 6; i++) m[`k${i}`] = Array.from({ length: 20 }, (_, j) => j);
    const start = Date.now();
    expect(() => expandMatrix(m)).toThrow(/64000000 combinations before exclusions; at most 4096/);
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it("still allows a large product that stays under the bound", () => {
    expect(expandMatrix({ a: Array.from({ length: 64 }, (_, i) => i), b: Array.from({ length: 64 }, (_, i) => i) })).toHaveLength(4096);
  });
  it("bounds include and exclude", () => {
    const many = Array.from({ length: 257 }, (_, i) => ({ a: i }));
    expect(() => expandMatrix({ a: [1], include: many })).toThrow(/matrix.include has 257 entries/);
    expect(() => expandMatrix({ a: [1], exclude: many })).toThrow(/matrix.exclude has 257 entries/);
  });
});
