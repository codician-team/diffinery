/**
 * Pure planning helpers for the import mode (see importer.ts): how to cut a
 * repository's history into pushes that each stay under a size budget, and how
 * to read what the server said about a push.
 */

/**
 * Binary search for the furthest point of a first-parent chain whose push stays
 * within `budget`. `sizeAt(i)` is the size of everything reachable from the i-th
 * commit that the server does not have yet, so it grows with `i`. Returns null
 * when even the first commit is over budget.
 */
export async function furthestWithin(n: number, sizeAt: (i: number) => Promise<number>, budget: number): Promise<{ index: number; size: number } | null> {
  if (n <= 0) return null;
  const last = await sizeAt(n - 1);
  if (last <= budget) return { index: n - 1, size: last };
  let lo = 0;
  let hi = n - 2;
  let best: { index: number; size: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const size = await sizeAt(mid);
    if (size <= budget) {
      best = { index: mid, size };
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Greedy batches of at most `budget` bytes, keeping order; an item larger than the budget gets a batch of its own. */
export function batchBySize<T extends { size: number }>(items: T[], budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const it of items) {
    if (cur.length && used + it.size > budget) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(it);
    used += it.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Push protection findings from `remote:` lines, e.g. "remote:   AWS access key in blob 0123456789". */
export function parseSecretFindings(output: string): Array<{ kind: string; blob: string }> {
  const out: Array<{ kind: string; blob: string }> = [];
  const seen = new Set<string>();
  for (const m of output.matchAll(/^remote:\s+(.+?) in blob ([0-9a-f]{7,40})\s*$/gm)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m[1]!.trim(), blob: m[2]! });
  }
  return out;
}

/** The push was refused or cut off because the request was too big. */
export function isSizeRejection(output: string): boolean {
  return /exceeds \d+ ?MB|split it into smaller pushes|HTTP 413|Request Entity Too Large|RPC failed|remote end hung up|HTTP 50[023]|unexpected disconnect|pack exceeds/i.test(output);
}

/** The server's reason when the push was refused because the owner reached its storage limit, or null. */
export function storageRejection(output: string): string | null {
  return /^remote: Push refused: (.* has reached its storage limit .*?)\s*$/m.exec(output)?.[1] ?? null;
}

/** The push was refused by push protection. */
export function isSecretRejection(output: string): boolean {
  return /secret detected|Push blocked: possible secrets/i.test(output);
}

export type RefKind = "branch" | "tag" | "pull";

/** Which refs an import copies: branches, tags and pull request heads (not `refs/pull/N/merge`, merge queue branches, notes or others). */
export function importRefKind(ref: string): RefKind | null {
  if (ref.startsWith("refs/heads/gh-readonly-queue/")) return null;
  if (ref.startsWith("refs/heads/")) return "branch";
  if (ref.startsWith("refs/tags/")) return "tag";
  if (/^refs\/pull\/\d+\/head$/.test(ref)) return "pull";
  return null;
}

/** Push order: the default branch first, then other branches, tags and pull request heads (by number). */
export function sortRefsForImport(refs: string[], defaultBranch: string): string[] {
  const rank = (r: string) => (r === `refs/heads/${defaultBranch}` ? 0 : r.startsWith("refs/heads/") ? 1 : r.startsWith("refs/tags/") ? 2 : 3);
  const pr = (r: string) => Number(/^refs\/pull\/(\d+)\//.exec(r)?.[1] ?? 0);
  return [...refs].sort((a, b) => rank(a) - rank(b) || pr(a) - pr(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Import-only namespace on the Diffinery side. The server owns `refs/pull/*`, so
 * pull request heads land under `pull/N` here and the server creates
 * `refs/pull/N/head` from the imported pull request; chunks use `tmp/`.
 */
export const IMPORT_REF_PREFIX = "refs/diffinery-import/";

/** Where a source ref is pushed: branches and tags as they are, `refs/pull/N/head` to `refs/diffinery-import/pull/N`. */
export function importDestination(ref: string): string {
  const m = /^refs\/pull\/(\d+)\/head$/.exec(ref);
  return m ? `${IMPORT_REF_PREFIX}pull/${m[1]}` : ref;
}

/** `git push --porcelain` result lines: "<flag>\t<src>:<dst>\t<summary>". */
export function parsePorcelain(output: string): Array<{ ref: string; ok: boolean; reason: string }> {
  const out: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const line of output.split("\n")) {
    const m = /^([ +\-*=!])\t([^\t]*):([^\t]+)\t(.*)$/.exec(line);
    if (!m) continue;
    out.push({ ref: m[3]!, ok: m[1] !== "!", reason: m[4]!.replace(/^\[[^\]]*\]\s*/, "").replace(/^\((.*)\)$/, "$1") || m[4]! });
  }
  return out;
}
