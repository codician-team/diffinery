import { diffArrays, structuredPatch } from "diff";
import { fromUtf8 } from "./bytes.js";
import { isTreeMode, serializeTree, type TreeEntry } from "./objects.js";
import { mustRead, readTree, type ObjectReader, type ObjectStore } from "./store.js";

export type ChangeStatus = "added" | "modified" | "deleted";

export interface TreeChange {
  path: string;
  status: ChangeStatus;
  oldOid?: string;
  newOid?: string;
  oldMode?: string;
  newMode?: string;
}

/** Recursive diff between two trees (either may be null for an empty tree). */
export async function diffTrees(store: ObjectReader, oldTree: string | null, newTree: string | null, prefix = ""): Promise<TreeChange[]> {
  if (oldTree === newTree) return [];
  const a = new Map((oldTree ? await readTree(store, oldTree) : []).map((e) => [e.name, e]));
  const b = new Map((newTree ? await readTree(store, newTree) : []).map((e) => [e.name, e]));
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: TreeChange[] = [];
  for (const name of names) {
    const ea = a.get(name);
    const eb = b.get(name);
    const path = prefix ? `${prefix}/${name}` : name;
    if (ea && eb && ea.oid === eb.oid && ea.mode === eb.mode) continue;
    const aDir = ea && isTreeMode(ea.mode);
    const bDir = eb && isTreeMode(eb.mode);
    if (aDir || bDir) {
      out.push(...(await diffTrees(store, aDir ? ea!.oid : null, bDir ? eb!.oid : null, path)));
      if (ea && !aDir) out.push({ path, status: "deleted", oldOid: ea.oid, oldMode: ea.mode });
      if (eb && !bDir) out.push({ path, status: "added", newOid: eb.oid, newMode: eb.mode });
      continue;
    }
    if (!ea) out.push({ path, status: "added", newOid: eb!.oid, newMode: eb!.mode });
    else if (!eb) out.push({ path, status: "deleted", oldOid: ea.oid, oldMode: ea.mode });
    else out.push({ path, status: "modified", oldOid: ea.oid, newOid: eb.oid, oldMode: ea.mode, newMode: eb.mode });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

export function isBinary(content: Uint8Array): boolean {
  const n = Math.min(content.length, 8000);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // prefixed with ' ', '+', '-'
}

export interface FileDiff extends TreeChange {
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** Set when the diff was too large to render. */
  truncated?: boolean;
}

const MAX_DIFF_BYTES = 1024 * 1024;

/**
 * Myers' diff costs about the square of the number of changed lines, so a file pair with nothing in
 * common could hold a repository's Durable Object for minutes. Past this many changed lines the
 * change is shown as one replaced block instead, which costs one pass over the lines.
 */
export const MAX_EDIT_LENGTH = 1000;

/** Work left for one diff request (a commit, a comparison or a pull request), shared by its files. */
export class DiffBudget {
  constructor(
    /** Bytes of file content still to diff; later files are listed as too large. */
    public bytes = 16 * 1024 * 1024,
    /** Myers' work left, in squared changed lines. */
    public work = 4 * MAX_EDIT_LENGTH * MAX_EDIT_LENGTH,
  ) {}
}

export async function fileDiff(store: ObjectReader, change: TreeChange, context = 3, budget = new DiffBudget()): Promise<FileDiff> {
  const oldC = change.oldOid ? (await mustRead(store, change.oldOid)).content : new Uint8Array(0);
  const newC = change.newOid ? (await mustRead(store, change.newOid)).content : new Uint8Array(0);
  if (isBinary(oldC) || isBinary(newC)) return { ...change, binary: true, additions: 0, deletions: 0, hunks: [] };
  const size = oldC.length + newC.length;
  if (size > MAX_DIFF_BYTES || size > budget.bytes) return { ...change, binary: false, additions: 0, deletions: 0, hunks: [], truncated: true };
  budget.bytes -= size;
  const oldS = fromUtf8(oldC);
  const newS = fromUtf8(newC);
  const maxEditLength = Math.min(MAX_EDIT_LENGTH, Math.floor(Math.sqrt(Math.max(0, budget.work))));
  const patch = structuredPatch(change.path, change.path, oldS, newS, "", "", { context, maxEditLength });
  const hunks: Hunk[] = patch ? patch.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines })) : replacedBlock(oldS, newS, context);
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    }
  }
  budget.work -= patch ? (additions + deletions) ** 2 : maxEditLength ** 2;
  return { ...change, binary: false, additions, deletions, hunks };
}

/**
 * The cheap diff for a change too large for Myers: the lines the two sides share at the start and the
 * end stay as context, and everything between is removed and added as one block.
 */
function replacedBlock(oldS: string, newS: string, context: number): Hunk[] {
  const a = splitLines(oldS);
  const b = splitLines(newS);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p === a.length && p === b.length) return [];
  const from = Math.max(0, p - context);
  const after = Math.min(s, context);
  const lines: string[] = [];
  const push = (mark: string, line: string) => {
    lines.push(mark + (line.endsWith("\n") ? line.slice(0, -1) : line));
    if (!line.endsWith("\n")) lines.push("\\ No newline at end of file");
  };
  for (let i = from; i < p; i++) push(" ", a[i]!);
  for (let i = p; i < a.length - s; i++) push("-", a[i]!);
  for (let i = p; i < b.length - s; i++) push("+", b[i]!);
  for (let i = a.length - s; i < a.length - s + after; i++) push(" ", a[i]!);
  return [{ oldStart: from + 1, oldLines: a.length - s + after - from, newStart: from + 1, newLines: b.length - s + after - from, lines }];
}

export function formatUnified(d: FileDiff): string {
  const a = d.status === "added" ? "/dev/null" : `a/${d.path}`;
  const b = d.status === "deleted" ? "/dev/null" : `b/${d.path}`;
  const head = `diff --git a/${d.path} b/${d.path}\n--- ${a}\n+++ ${b}\n`;
  if (d.binary) return `${head}Binary files differ\n`;
  return head + d.hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`).join("");
}

// ---------------------------------------------------------------- three-way merge

interface Edit {
  start: number; // base line index
  end: number; // exclusive
  lines: string[];
}

function edits(base: string[], other: string[]): Edit[] | null {
  const parts = diffArrays(base, other, { maxEditLength: 2 * MAX_EDIT_LENGTH });
  if (!parts) return null;
  const out: Edit[] = [];
  let bi = 0;
  let cur: Edit | null = null;
  for (const part of parts) {
    if (part.removed) {
      cur ??= { start: bi, end: bi, lines: [] };
      cur.end += part.count ?? part.value.length;
      bi += part.count ?? part.value.length;
    } else if (part.added) {
      cur ??= { start: bi, end: bi, lines: [] };
      cur.lines.push(...part.value);
    } else {
      if (cur) out.push(cur);
      cur = null;
      bi += part.count ?? part.value.length;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const splitLines = (s: string): string[] => (s === "" ? [] : s.split(/(?<=\n)/));

/** Line-based diff3. Returns merged text, or null when the sides conflict. */
export function mergeText(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  const b = splitLines(base);
  const ea = edits(b, splitLines(ours));
  const eb = edits(b, splitLines(theirs));
  // A side too different from the base to diff cheaply is left for a person to merge.
  if (!ea || !eb) return null;
  const out: string[] = [];
  let pos = 0;
  let i = 0;
  let j = 0;
  while (i < ea.length || j < eb.length) {
    const a = ea[i];
    const c = eb[j];
    let take: Edit;
    if (a && c && a.start < c.end + (c.start === c.end ? 1 : 0) && c.start < a.end + (a.start === a.end ? 1 : 0)) {
      // Overlapping edits: fine only when identical.
      if (a.start === c.start && a.end === c.end && a.lines.join("") === c.lines.join("")) {
        take = a;
        i++;
        j++;
      } else return null;
    } else if (a && (!c || a.start < c.start || (a.start === c.start && a.end <= c.end))) {
      take = a;
      i++;
    } else {
      take = c!;
      j++;
    }
    out.push(...b.slice(pos, take.start), ...take.lines);
    pos = take.end;
  }
  out.push(...b.slice(pos));
  return out.join("");
}

export interface MergeResult {
  tree: string | null;
  conflicts: string[];
}

/** Three-way merge of trees. File-level with line-level diff3 for text files. */
export async function mergeTrees(store: ObjectStore, base: string | null, ours: string, theirs: string): Promise<MergeResult> {
  const conflicts: string[] = [];
  const mergeDir = async (b: string | null, o: string | null, t: string | null, prefix: string): Promise<string | null> => {
    if (o === t) return o;
    if (b === o) return t;
    if (b === t) return o;
    const mb = new Map((b ? await readTree(store, b) : []).map((e) => [e.name, e]));
    const mo = new Map((o ? await readTree(store, o) : []).map((e) => [e.name, e]));
    const mt = new Map((t ? await readTree(store, t) : []).map((e) => [e.name, e]));
    const result: TreeEntry[] = [];
    for (const name of new Set([...mb.keys(), ...mo.keys(), ...mt.keys()])) {
      const eb = mb.get(name);
      const eo = mo.get(name);
      const et = mt.get(name);
      const path = prefix ? `${prefix}/${name}` : name;
      const same = (x?: TreeEntry, y?: TreeEntry) => (!x && !y) || (!!x && !!y && x.oid === y.oid && x.mode === y.mode);
      if (same(eo, et)) {
        if (eo) result.push(eo);
        continue;
      }
      if (same(eb, eo)) {
        if (et) result.push(et);
        continue;
      }
      if (same(eb, et)) {
        if (eo) result.push(eo);
        continue;
      }
      const dir = (e?: TreeEntry) => (e && isTreeMode(e.mode) ? e.oid : null);
      if ((!eo || isTreeMode(eo.mode)) && (!et || isTreeMode(et.mode)) && (!eb || isTreeMode(eb.mode))) {
        const merged = await mergeDir(dir(eb), dir(eo), dir(et), path);
        if (merged) result.push({ mode: "40000", name, oid: merged });
        continue;
      }
      if (eo && et && !isTreeMode(eo.mode) && !isTreeMode(et.mode) && eo.mode === et.mode) {
        const [cb, co, ct] = await Promise.all([
          eb && !isTreeMode(eb.mode) ? mustRead(store, eb.oid) : null,
          mustRead(store, eo.oid),
          mustRead(store, et.oid),
        ]);
        if (!isBinary(co.content) && !isBinary(ct.content) && (!cb || !isBinary(cb.content))) {
          const merged = mergeText(cb ? fromUtf8(cb.content) : "", fromUtf8(co.content), fromUtf8(ct.content));
          if (merged !== null) {
            const oid = await store.write("blob", new TextEncoder().encode(merged));
            result.push({ mode: eo.mode, name, oid });
            continue;
          }
        }
      }
      conflicts.push(path);
      if (eo) result.push(eo);
    }
    if (!result.length) return null;
    return store.write("tree", serializeTree(result));
  };
  const tree = await mergeDir(base, ours, theirs, "");
  return { tree, conflicts };
}
