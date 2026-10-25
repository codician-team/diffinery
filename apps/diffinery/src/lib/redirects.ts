/**
 * Where an old repository URL now points, after a transfer or a rename (see migrations/0011_redirects.sql).
 * Pure functions, so the rewriting rules are unit-tested on their own.
 */

export interface RepoPath {
  owner: string;
  name: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Rewrite the first `/<owner>/<name>` pair of a path (the name may end in `.git`, which is kept) to the
 * repository's new owner and name, keeping the rest of the path. Null when the path doesn't name the
 * old repository, for callers that took the name from elsewhere (a query, a JSON body, MCP arguments).
 */
export function movedPath(path: string, from: RepoPath, to: RepoPath): string | null {
  const segs = path.split("/");
  for (let i = 1; i + 1 < segs.length; i++) {
    let owner: string;
    let name: string;
    try {
      owner = decodeURIComponent(segs[i]!);
      name = decodeURIComponent(segs[i + 1]!);
    } catch {
      return null;
    }
    const git = name.toLowerCase().endsWith(".git");
    if (!same(owner, from.owner) || !same(git ? name.slice(0, -4) : name, from.name.replace(/\.git$/i, ""))) continue;
    segs[i] = encodeURIComponent(to.owner);
    segs[i + 1] = encodeURIComponent(to.name) + (git ? name.slice(-4) : "");
    return segs.join("/");
  }
  return null;
}

/** Rewrite a path whose first segment is a renamed account's old login (its profile and repositories). */
export function movedLoginPath(path: string, from: string, to: string): string | null {
  const segs = path.split("/");
  if (segs.length < 2 || !same(segs[1]!, from)) return null;
  segs[1] = encodeURIComponent(to);
  return segs.join("/");
}

/** GitHub's answer for a moved repository: 301 for reads, 307 for anything else so the method and body are kept. */
export const movedStatus = (method: string): 301 | 307 => (method === "GET" || method === "HEAD" ? 301 : 307);
