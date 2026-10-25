/**
 * Tree entry names the server refuses to write (and leaves out of archives):
 * empty names, `.` and `..`, names with `/`, `\` or NUL, and anything a
 * checkout on Windows or macOS would treat as `.git` (`.GIT`, `.git.`,
 * `.git ` , `git~1`, `.g‌it`). Git's own fsck rejects the same names.
 */

// Characters HFS+ ignores when comparing names (zero-width joiners, direction marks, BOM).
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

export function isDotGitName(name: string): boolean {
  const n = name.replace(HFS_IGNORABLE, "").toLowerCase().replace(/[. ]+$/, "");
  return n === ".git" || n === "git~1";
}

/** Why a single tree entry name is unsafe, or null when it is fine. */
export function unsafeTreeName(name: string): string | null {
  if (!name) return "empty name";
  if (name === "." || name === "..") return `'${name}' is not a valid name`;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return "names can't contain '/', '\\' or NUL";
  if (isDotGitName(name)) return "'.git' is reserved";
  if (name.length > 255) return "name is too long";
  return null;
}

/** Why a slash-separated path is unsafe to write, or null. */
export function unsafeTreePath(path: string): string | null {
  if (path.includes("\\") || path.includes("\0")) return "paths can't contain '\\' or NUL";
  const parts = path.split("/").filter((p) => p !== "");
  if (!parts.length) return "empty path";
  if (path.length > 4096) return "path is too long";
  for (const p of parts) {
    const why = unsafeTreeName(p);
    if (why) return why;
  }
  return null;
}
