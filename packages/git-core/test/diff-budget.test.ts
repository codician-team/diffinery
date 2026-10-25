import { structuredPatch } from "diff";
import { describe, expect, it } from "vitest";
import { DiffBudget, MAX_EDIT_LENGTH, MemoryStore, fileDiff, mergeText, utf8 } from "../src/index.js";

// Two files with no line in common: Myers' worst case, quadratic in their length.
const unrelated = (n: number) => [Array.from({ length: n }, (_, i) => `old ${i}\n`).join(""), Array.from({ length: n }, (_, i) => `new ${i}\n`).join("")];

async function diffOf(a: string, b: string, budget?: DiffBudget) {
  const store = new MemoryStore();
  const oldOid = await store.write("blob", utf8(a));
  const newOid = await store.write("blob", utf8(b));
  return fileDiff(store, { path: "f.txt", status: "modified", oldOid, newOid }, 3, budget);
}

describe("diffs are bounded", () => {
  it("a file rewritten from scratch is diffed in one pass, as one replaced block", async () => {
    // 2 x 40k lines (about 0.8 MB): unbounded, this takes minutes.
    const [a, b] = unrelated(40_000);
    const t = Date.now();
    const d = await diffOf(`same 1\nsame 2\n${a}same 3\n`, `same 1\nsame 2\n${b}same 3\n`);
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(d.truncated).toBeUndefined();
    expect([d.additions, d.deletions]).toEqual([40_000, 40_000]);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0]!;
    expect([h.oldStart, h.oldLines, h.newStart, h.newLines]).toEqual([1, 40_003, 1, 40_003]);
    expect(h.lines.slice(0, 3)).toEqual([" same 1", " same 2", "-old 0"]);
    expect(h.lines.at(-1)).toBe(" same 3");
  });

  it("the cheap diff matches Myers' line counts and marks a missing final newline", async () => {
    const d = await diffOf("x\n", "y", new DiffBudget(undefined, 0));
    expect(d.hunks).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y", "\\ No newline at end of file"] }]);
    const added = await diffOf("", "a\nb\n", new DiffBudget(undefined, 0));
    expect(added.hunks).toEqual(structuredPatch("f", "f", "", "a\nb\n", "", "", { context: 3 }).hunks.map(({ oldStart, oldLines, newStart, newLines, lines }) => ({ oldStart, oldLines, newStart, newLines, lines })));
  });

  it("small changes still get Myers' minimal diff", async () => {
    const base = Array.from({ length: 200 }, (_, i) => `line ${i}\n`);
    const changed = [...base];
    changed[10] = "changed 10\n";
    changed[150] = "changed 150\n";
    const d = await diffOf(base.join(""), changed.join(""));
    expect([d.additions, d.deletions, d.hunks.length]).toEqual([2, 2, 2]);
  });

  it("one request shares a budget: after it is spent, files are still listed but not diffed", async () => {
    const budget = new DiffBudget(100, MAX_EDIT_LENGTH ** 2);
    const first = await diffOf("a\n".repeat(20), "b\n".repeat(20), budget);
    expect(first.truncated).toBeUndefined();
    expect(budget.bytes).toBe(20);
    const second = await diffOf("c\n".repeat(20), "d\n".repeat(20), budget);
    expect(second.truncated).toBe(true);
  });

  it("a three-way merge too large to compute is a conflict, quickly", () => {
    const [a, b] = unrelated(30_000);
    const t = Date.now();
    expect(mergeText(`top\n${a}`, `top\n${b}`, `changed\n${a}`)).toBeNull();
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(mergeText("1\n2\n3\n", "1\nx\n3\n", "1\n2\n3\n4\n")).toBe("1\nx\n3\n4\n");
  });
});
