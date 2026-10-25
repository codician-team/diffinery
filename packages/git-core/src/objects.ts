import { concat, fromHex, fromUtf8, toHex, utf8 } from "./bytes.js";
import { Sha1, sha1Hex } from "./sha1.js";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

export const ZERO_OID = "0000000000000000000000000000000000000000";
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GitObject {
  type: ObjectType;
  content: Uint8Array;
}

export function objectHeader(type: ObjectType, size: number): Uint8Array {
  return utf8(`${type} ${size}\0`);
}

/**
 * Content larger than this is hashed in pieces after its header, never copied: slower than
 * WebCrypto, which only hashes one whole buffer, but an object never needs twice its size to hash.
 */
export const HASH_COPY_MAX = 1024 * 1024;

export async function hashObject(type: ObjectType, content: Uint8Array): Promise<string> {
  const header = objectHeader(type, content.length);
  if (content.length > HASH_COPY_MAX) return toHex(new Sha1().update(header).update(content).digest());
  return sha1Hex(concat([header, content]));
}

export const isOid = (s: string): boolean => /^[0-9a-f]{40}$/.test(s);

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "40000" | "160000"
  name: string;
  oid: string;
}

export const isTreeMode = (mode: string): boolean => mode === "40000" || mode === "040000";

export function parseTree(content: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < content.length) {
    const sp = content.indexOf(0x20, i);
    const nul = content.indexOf(0x00, sp);
    if (sp < 0 || nul < 0) throw new Error("malformed tree");
    const mode = fromUtf8(content.subarray(i, sp));
    const name = fromUtf8(content.subarray(sp + 1, nul));
    const oid = toHex(content.subarray(nul + 1, nul + 21));
    entries.push({ mode: mode === "040000" ? "40000" : mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git sorts tree entries as if directory names had a trailing slash. */
function treeSortKey(e: TreeEntry): string {
  return isTreeMode(e.mode) ? `${e.name}/` : e.name;
}

export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = utf8(treeSortKey(a));
  const kb = utf8(treeSortKey(b));
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
  return ka.length - kb.length;
}

export function serializeTree(entries: readonly TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort(compareTreeEntries);
  return concat(sorted.flatMap((e) => [utf8(`${e.mode} ${e.name}\0`), fromHex(e.oid)]));
}

// ---------------------------------------------------------------- commits & tags

export interface Signature {
  name: string;
  email: string;
  /** Seconds since epoch. */
  timestamp: number;
  /** e.g. "+0200" */
  timezone: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
  gpgsig?: string;
  /** Extra headers we preserve but don't interpret. */
  extraHeaders?: [string, string][];
}

export interface Tag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger?: Signature;
  message: string;
}

export function parseSignature(s: string): Signature {
  const m = /^(.*) <(.*)> (-?\d+) ([+-]\d{4})$/.exec(s);
  if (!m) return { name: s, email: "", timestamp: 0, timezone: "+0000" };
  return { name: m[1]!, email: m[2]!, timestamp: Number(m[3]), timezone: m[4]! };
}

export function formatSignature(s: Signature): string {
  return `${s.name} <${s.email}> ${s.timestamp} ${s.timezone}`;
}

function parseHeaders(text: string): { headers: [string, string][]; message: string } {
  const headers: [string, string][] = [];
  const end = text.indexOf("\n\n");
  const head = end >= 0 ? text.slice(0, end) : text;
  const message = end >= 0 ? text.slice(end + 2) : "";
  for (const line of head.split("\n")) {
    if (line.startsWith(" ") && headers.length) {
      const last = headers[headers.length - 1]!;
      last[1] += `\n${line.slice(1)}`;
    } else {
      const sp = line.indexOf(" ");
      headers.push([line.slice(0, sp), line.slice(sp + 1)]);
    }
  }
  return { headers, message };
}

export function parseCommit(content: Uint8Array): Commit {
  const { headers, message } = parseHeaders(fromUtf8(content));
  const c: Commit = { tree: "", parents: [], author: parseSignature(""), committer: parseSignature(""), message };
  for (const [k, v] of headers) {
    if (k === "tree") c.tree = v;
    else if (k === "parent") c.parents.push(v);
    else if (k === "author") c.author = parseSignature(v);
    else if (k === "committer") c.committer = parseSignature(v);
    else if (k === "gpgsig") c.gpgsig = v;
    else (c.extraHeaders ??= []).push([k, v]);
  }
  return c;
}

export function serializeCommit(c: Commit): Uint8Array {
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${formatSignature(c.author)}`, `committer ${formatSignature(c.committer)}`];
  for (const [k, v] of c.extraHeaders ?? []) lines.push(`${k} ${v.replace(/\n/g, "\n ")}`);
  if (c.gpgsig) lines.push(`gpgsig ${c.gpgsig.replace(/\n/g, "\n ")}`);
  return utf8(`${lines.join("\n")}\n\n${c.message}`);
}

export function parseTag(content: Uint8Array): Tag {
  const { headers, message } = parseHeaders(fromUtf8(content));
  const t: Tag = { object: "", type: "commit", tag: "", message };
  for (const [k, v] of headers) {
    if (k === "object") t.object = v;
    else if (k === "type") t.type = v as ObjectType;
    else if (k === "tag") t.tag = v;
    else if (k === "tagger") t.tagger = parseSignature(v);
  }
  return t;
}

export function serializeTag(t: Tag): Uint8Array {
  const lines = [`object ${t.object}`, `type ${t.type}`, `tag ${t.tag}`];
  if (t.tagger) lines.push(`tagger ${formatSignature(t.tagger)}`);
  return utf8(`${lines.join("\n")}\n\n${t.message}`);
}
