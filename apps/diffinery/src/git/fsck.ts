import { fromUtf8, toHex } from "@diffinery/git-core";
import { isDotGitName } from "../lib/tree-names.js";

/**
 * Git's fsck for pushed objects, as GitHub runs it (`receive.fsckObjects`): trees a git
 * client would refuse to check out, or that would write outside the work tree, and
 * `.gitmodules` files that make a client run an option as a command (CVE-2018-17456)
 * or clone a submodule outside `.git/modules` (CVE-2018-11235).
 */

export interface PushedObject {
  oid: string;
  type: string;
  content: Uint8Array;
}

// Characters HFS+ ignores when comparing names, as in tree-names.ts.
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** `.gitmodules` as Windows (8.3 short name, trailing dots and spaces) and macOS read it. */
export function isDotGitmodulesName(name: string): boolean {
  const n = name.replace(HFS_IGNORABLE, "").toLowerCase().replace(/[. ]+$/, "");
  return n === ".gitmodules" || n === "gitmod~1";
}

/** Why a submodule's name, path or URL in `.gitmodules` is unsafe, or null. */
export function unsafeGitmodules(text: string): string | null {
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[\s*submodule\s+"((?:[^"\\]|\\.)*)"\s*\]/i.exec(line);
    if (head) {
      section = head[1]!.replace(/\\(.)/g, "$1");
      if (section.split(/[/\\]/).includes("..")) return `submodule name '${section}' can't contain '..'`;
      continue;
    }
    if (line.startsWith("[")) {
      section = null;
      continue;
    }
    if (section === null) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.replace(/^"(.*)"$/, "$1").trim();
    if ((key === "url" || key === "path") && value.startsWith("-")) return `submodule '${section}' has a ${key} that starts with '-'`;
  }
  return null;
}

/** Why the pushed objects can't be accepted, or null when they pass. */
export function fsckObjects(objects: PushedObject[]): string | null {
  const gitmodules = new Set<string>();
  for (const o of objects) {
    const why = o.type === "tree" ? fsckTree(o.oid, o.content, gitmodules) : fsckSize(o.oid, o.type, o.content.length);
    if (why) return why;
  }
  if (gitmodules.size) {
    for (const o of objects) {
      if (o.type !== "blob" || !gitmodules.has(o.oid)) continue;
      const why = fsckGitmodules(o.oid, o.content);
      if (why) return why;
    }
  }
  return null;
}

/**
 * The largest tree a push may hold. Checking one keeps every name in it, at several times its
 * size; real trees are rarely more than a few MB (100,000 files in one directory is about 4 MB).
 */
export const MAX_TREE_BYTES = 8 * 1024 * 1024;

/**
 * The largest commit or tag a push may hold. After a push, its commits are read and decoded whole
 * (workflow triggers, webhooks, the pull request page), at about three times their size; a real
 * commit message or tag is a few KB.
 */
export const MAX_COMMIT_BYTES = 4 * 1024 * 1024;

/** Why a pushed commit or tag is too large to accept, or null (any other type passes). */
export function fsckSize(oid: string, type: string, size: number): string | null {
  if ((type === "commit" || type === "tag") && size > MAX_COMMIT_BYTES) return `${type} ${oid}: larger than ${MAX_COMMIT_BYTES / (1024 * 1024)} MiB`;
  return null;
}

/** Why one pushed tree can't be accepted, or null. The blobs it names `.gitmodules` go into `gitmodules`, for `fsckGitmodules`. */
export function fsckTree(oid: string, content: Uint8Array, gitmodules: Set<string>): string | null {
  if (content.length > MAX_TREE_BYTES) return `tree ${oid}: larger than ${MAX_TREE_BYTES / (1024 * 1024)} MiB`;
  // Read in place: only the names are kept, not an object for each entry.
  const seen = new Set<string>();
  for (let i = 0; i < content.length; ) {
    const sp = content.indexOf(0x20, i);
    const nul = sp < 0 ? -1 : content.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > content.length) return `tree ${oid}: malformed tree`;
    const name = fromUtf8(content.subarray(sp + 1, nul));
    const i0 = i;
    const at = nul + 1;
    i = nul + 21;
    const why =
      !name ? "empty name"
      : name === "." || name === ".." ? `'${name}' is not a valid name`
      : name.includes("/") ? `'${name}' contains '/'`
      : isDotGitName(name) ? `'${name}' is reserved ('.git')`
      : seen.has(name) ? `duplicate entry '${name}'`
      : null;
    if (why) return `tree ${oid}: ${why}`;
    seen.add(name);
    if (isDotGitmodulesName(name)) {
      if (fromUtf8(content.subarray(i0, sp)) === "120000") return `tree ${oid}: '.gitmodules' is a symbolic link`;
      gitmodules.add(toHex(content.subarray(at, at + 20)));
    }
  }
  return null;
}

/** Why a pushed blob that a tree names `.gitmodules` can't be accepted, or null. */
export function fsckGitmodules(oid: string, content: Uint8Array): string | null {
  const why = unsafeGitmodules(fromUtf8(content));
  return why ? `.gitmodules ${oid}: ${why}` : null;
}
