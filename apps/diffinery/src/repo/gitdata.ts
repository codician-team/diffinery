import { ACTIONS_APP } from "./required.js";
import {
  CODE_TYPES,
  EMPTY_TREE_OID,
  hashObject,
  isAncestor,
  isOid,
  isTreeMode,
  mergeBase,
  mergeTrees,
  parseTag,
  readCommit,
  readTree,
  resolvePath,
  serializeCommit,
  serializeTag,
  serializeTree,
  type ObjectType,
  type Signature,
  type TreeEntry,
  utf8,
} from "@diffinery/git-core";
import type { Env } from "../env.js";
import { numericId, uuidNumber, uuidPattern } from "../http/gh.js";
import { scanForSecrets, type SecretHit } from "../git/secret-scan.js";
import { ZipWriter, tarEnd, tarEntry, tarStart, zip, type ArchiveEntry } from "../lib/archive.js";
import { R2Sink } from "../lib/r2-sink.js";
import { unsafeTreeName, unsafeTreePath } from "../lib/tree-names.js";
import { HttpError, noreplyEmail, now } from "../lib/util.js";
import { archiveKey } from "../lib/storage-keys.js";
import type { Check } from "./collab.js";
import { toInfo, type CommitInfo, type RepoDO } from "./RepoDO.js";
import { atLeast, type Caller } from "./types.js";

export type SigInput = { name?: string; email?: string; date?: string };
export type TreeInput = { path?: string; mode?: string; type?: string; sha?: string | null; content?: string };
export type GitTreeEntry = { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; size?: number };

const MODES = new Set(["100644", "100755", "040000", "160000", "120000"]);
/** Uncompressed file content an archive may hold; bigger repositories should be cloned. */
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
/** Tree entries a walk may visit (repeated subtrees count every time), against tree bombs. */
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_DEPTH = 128;
/** Archive builds per repository per hour (cached archives don't count). */
const ARCHIVE_BUILDS_PER_HOUR = 20;

/** Language by file extension, for GET /languages (programming and markup languages, like linguist). */
const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", swift: "Swift", m: "Objective-C",
  c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++", cs: "C#", fs: "F#", php: "PHP", pl: "Perl", lua: "Lua", r: "R",
  dart: "Dart", ex: "Elixir", exs: "Elixir", erl: "Erlang", hs: "Haskell", clj: "Clojure", elm: "Elm", ml: "OCaml", zig: "Zig", nim: "Nim",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", sql: "PLpgSQL", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "Sass",
  less: "Less", vue: "Vue", svelte: "Svelte", astro: "Astro", tf: "HCL", hcl: "HCL", nix: "Nix", sol: "Solidity", vb: "Visual Basic .NET",
  groovy: "Groovy", jl: "Julia", cr: "Crystal", v: "V", d: "D", asm: "Assembly", s: "Assembly", mk: "Makefile", cmake: "CMake", proto: "Protocol Buffer",
};
const LANGUAGE_FILES: Record<string, string> = { Dockerfile: "Dockerfile", Makefile: "Makefile", "CMakeLists.txt": "CMake", Rakefile: "Ruby", Gemfile: "Ruby" };
const VENDORED = /(^|\/)(node_modules|vendor|third_party|dist|build|\.yarn)\//;

function parseSig(input: SigInput | undefined, fallback: Signature, field: string): Signature {
  if (!input) return fallback;
  if (!input.name || !input.email) throw new HttpError(422, `${field} needs a name and an email`, { errors: [{ resource: "Commit", code: "missing_field", field }] });
  let timestamp = fallback.timestamp;
  let timezone = "+0000";
  if (input.date) {
    const t = Date.parse(input.date);
    if (Number.isNaN(t)) throw new HttpError(422, `${field}.date must be an ISO 8601 date`);
    timestamp = Math.floor(t / 1000);
    const m = /([+-])(\d{2}):?(\d{2})$/.exec(input.date);
    if (m) timezone = `${m[1]}${m[2]}${m[3]}`;
  }
  return { name: input.name.replace(/[<>\n]/g, ""), email: input.email.replace(/[<>\n]/g, ""), timestamp, timezone };
}

const sixDigit = (mode: string) => mode.padStart(6, "0");
const entryType = (mode: string): GitTreeEntry["type"] => (isTreeMode(mode) ? "tree" : mode === "160000" ? "commit" : "blob");

/**
 * Git data API (blobs, trees, commits, annotated tags), contents writes with
 * optimistic concurrency, the merges API, archives, languages and a few
 * Actions and checks extras that need direct access to the repository.
 */
export class GitData {
  constructor(
    private repo: RepoDO,
    private env: Env,
  ) {}

  private get sql() {
    return this.repo.sql;
  }

  private get store() {
    return this.repo.store;
  }

  private requireWrite(caller: Caller): void {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required");
  }

  private signature(caller: Caller): Signature {
    return { name: caller.login, email: noreplyEmail(this.env.PUBLIC_URL, caller.login), timestamp: Math.floor(Date.now() / 1000), timezone: "+0000" };
  }

  private agentHeaders(caller: Caller): [string, string][] {
    return caller.kind === "agent" ? [["diffinery-agent", `${caller.login}${caller.onBehalfOf ? ` on-behalf-of ${caller.onBehalfOf}` : ""}`]] : [];
  }

  /** Same push protection as git pushes: blobs with credentials are refused. */
  private scan(oid: string, content: Uint8Array, caller: Caller): void {
    const marked: SecretHit[] = [];
    const hits = scanForSecrets([{ oid, content }], marked);
    const m = this.repo.meta;
    if (marked.length) this.repo.emit({ type: "audit", action: "api.secret_marked", actor: caller, target: `${m.owner}/${m.name}`, detail: { kinds: marked.map((h) => h.kind), blob: oid }, at: now() });
    if (hits.length) {
      this.repo.emit({ type: "audit", action: "api.blocked_secret", actor: caller, target: `${m.owner}/${m.name}`, detail: { kinds: hits.map((h) => h.kind), blob: oid }, at: now() });
      throw new HttpError(422, `push protection: possible secret detected (${hits.map((h) => h.kind).join(", ")})`);
    }
  }

  objectType(oid: string): ObjectType | null {
    const row = this.sql.exec<{ type: number }>("SELECT type FROM objects WHERE oid = ?", oid).toArray()[0];
    return row ? (CODE_TYPES[row.type] ?? null) : null;
  }

  /** Refs under a prefix with the type of the object each points at. */
  refsWithTypes(prefix: string): Array<{ ref: string; sha: string; type: ObjectType | "commit" }> {
    return this.repo.refs(prefix).map((r) => ({ ref: r.name, sha: r.oid, type: this.objectType(r.oid) ?? "commit" }));
  }

  // ---------------------------------------------------------------- blobs

  async createBlob(content: Uint8Array, caller: Caller, quotaChecked = false): Promise<{ sha: string; size: number }> {
    this.requireWrite(caller);
    if (!quotaChecked) await this.repo.checkStorage(content.length);
    const oid = await hashObject("blob", content);
    this.scan(oid, content, caller);
    await this.store.writeKnown(oid, "blob", content);
    return { sha: oid, size: content.length };
  }

  async getBlob(sha: string): Promise<{ sha: string; size: number; content: Uint8Array }> {
    if (!isOid(sha)) throw new HttpError(404, "blob not found");
    const o = await this.store.read(sha);
    if (!o || o.type !== "blob") throw new HttpError(404, "blob not found");
    return { sha, size: o.content.length, content: o.content };
  }

  // ---------------------------------------------------------------- trees

  async createTree(baseTree: string | undefined, entries: TreeInput[], caller: Caller): Promise<string> {
    this.requireWrite(caller);
    if (!Array.isArray(entries)) throw new HttpError(422, "tree must be an array", { errors: [{ resource: "Tree", code: "invalid", field: "tree" }] });
    const adding = entries.reduce((n, e) => n + (e?.content === undefined ? 0 : String(e.content).length), 0);
    if (adding) await this.repo.checkStorage(adding);
    if (baseTree && this.objectType(baseTree) !== "tree") throw new HttpError(422, "base_tree is not a valid tree oid", { errors: [{ resource: "Tree", code: "invalid", field: "base_tree" }] });
    type Node = { entries: Map<string, TreeEntry>; children: Map<string, Node> };
    const load = async (oid: string | null): Promise<Node> => ({ entries: new Map(oid ? (await readTree(this.store, oid)).map((e) => [e.name, e]) : []), children: new Map() });
    const root = await load(baseTree ?? null);
    const dirFor = async (parts: string[]): Promise<Node> => {
      let node = root;
      for (const part of parts) {
        let child = node.children.get(part);
        if (!child) {
          const existing = node.entries.get(part);
          child = await load(existing && isTreeMode(existing.mode) ? existing.oid : null);
          node.children.set(part, child);
        }
        node = child;
      }
      return node;
    };
    for (const e of entries) {
      const parts = String(e.path ?? "").split("/").filter(Boolean);
      const name = parts.pop();
      const why = unsafeTreePath(String(e.path ?? ""));
      if (!name || why) throw new HttpError(422, `invalid tree path ${JSON.stringify(String(e.path ?? ""))}: ${why ?? "empty path"}`, { errors: [{ resource: "Tree", code: "invalid", field: "path" }] });
      const mode = String(e.mode ?? "100644");
      if (!MODES.has(mode)) throw new HttpError(422, `invalid mode ${mode}`, { errors: [{ resource: "Tree", code: "invalid", field: "mode" }] });
      const dir = await dirFor(parts);
      if (e.sha === null && e.content === undefined) {
        dir.entries.delete(name);
        dir.children.delete(name);
        continue;
      }
      let oid: string;
      if (e.content !== undefined) {
        if (mode === "040000" || mode === "160000") throw new HttpError(422, "content can only be used with blob modes");
        oid = (await this.createBlob(new TextEncoder().encode(String(e.content)), caller, true)).sha;
      } else {
        oid = String(e.sha ?? "");
        if (!isOid(oid)) throw new HttpError(422, `invalid sha for ${e.path}`, { errors: [{ resource: "Tree", code: "invalid", field: "sha" }] });
        const want = mode === "040000" ? "tree" : mode === "160000" ? null : "blob";
        if (want && this.objectType(oid) !== want) throw new HttpError(422, `${oid} is not a ${want}`, { errors: [{ resource: "Tree", code: "invalid", field: "sha" }] });
      }
      dir.children.delete(name);
      dir.entries.set(name, { mode: mode === "040000" ? "40000" : mode, name, oid });
    }
    const finish = async (node: Node): Promise<string | null> => {
      for (const [name, child] of node.children) {
        const oid = await finish(child);
        if (oid) node.entries.set(name, { mode: "40000", name, oid });
        else node.entries.delete(name);
      }
      if (node.entries.size === 0) return null;
      return this.store.write("tree", serializeTree([...node.entries.values()]));
    };
    return (await finish(root)) ?? (await this.store.write("tree", new Uint8Array(0)));
  }

  /** A tree by tree SHA, commit SHA or ref; `recursive` lists every entry (truncated after 100k). */
  async getTree(rev: string, recursive: boolean): Promise<{ sha: string; tree: GitTreeEntry[]; truncated: boolean }> {
    let sha = isOid(rev) && this.objectType(rev) === "tree" ? rev : null;
    if (!sha) {
      const commit = await this.repo.resolve(rev);
      if (!commit) throw new HttpError(404, "tree not found");
      sha = (await readCommit(this.store, commit)).tree;
    }
    const out: GitTreeEntry[] = [];
    let truncated = false;
    const sizes = (oids: string[]) => {
      const m = new Map<string, number>();
      for (let i = 0; i < oids.length; i += 100) {
        const chunk = oids.slice(i, i + 100);
        for (const r of this.sql.exec<{ oid: string; size: number }>(`SELECT oid, size FROM objects WHERE oid IN (${chunk.map(() => "?").join(",")})`, ...chunk).toArray()) m.set(r.oid, r.size);
      }
      return m;
    };
    const walk = async (oid: string, prefix: string) => {
      const entries = await readTree(this.store, oid);
      const size = sizes(entries.filter((e) => !isTreeMode(e.mode) && e.mode !== "160000").map((e) => e.oid));
      for (const e of entries) {
        if (out.length >= 100_000) {
          truncated = true;
          return;
        }
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        const type = entryType(e.mode);
        out.push({ path, mode: sixDigit(e.mode), type, sha: e.oid, ...(type === "blob" ? { size: size.get(e.oid) ?? 0 } : {}) });
        if (recursive && type === "tree") await walk(e.oid, path);
      }
    };
    if (sha !== EMPTY_TREE_OID || this.store.has(sha)) await walk(sha, "");
    return { sha, tree: out, truncated };
  }

  // ---------------------------------------------------------------- commits and tags

  async createCommit(input: { message?: string; tree?: string; parents?: string[]; author?: SigInput; committer?: SigInput; signature?: string }, caller: Caller): Promise<CommitInfo> {
    this.requireWrite(caller);
    if (typeof input.message !== "string") throw new HttpError(422, "message is required", { errors: [{ resource: "Commit", code: "missing_field", field: "message" }] });
    if (!input.tree || this.objectType(input.tree) !== "tree") throw new HttpError(422, "tree is not a valid tree oid", { errors: [{ resource: "Commit", code: "invalid", field: "tree" }] });
    const parents = input.parents ?? [];
    if (!Array.isArray(parents)) throw new HttpError(422, "parents must be an array");
    for (const p of parents) if (!isOid(String(p)) || this.objectType(String(p)) !== "commit") throw new HttpError(422, `parent ${p} is not a valid commit`, { errors: [{ resource: "Commit", code: "invalid", field: "parents" }] });
    this.scan("(commit message)", utf8(input.message), caller);
    const me = this.signature(caller);
    const author = parseSig(input.author, me, "author");
    const committer = parseSig(input.committer, input.author ? author : me, "committer");
    const sha = await this.store.write(
      "commit",
      serializeCommit({ tree: input.tree, parents: parents.map(String), author, committer, message: input.message, extraHeaders: this.agentHeaders(caller), gpgsig: input.signature || undefined }),
    );
    return this.repo.commitInfo(sha);
  }

  async gitCommit(sha: string): Promise<CommitInfo> {
    if (!isOid(sha) || this.objectType(sha) !== "commit") throw new HttpError(404, "commit not found");
    return toInfo(sha, await readCommit(this.store, sha));
  }

  async createTag(input: { tag?: string; message?: string; object?: string; type?: string; tagger?: SigInput }, caller: Caller) {
    this.requireWrite(caller);
    const tag = String(input.tag ?? "").trim();
    if (!tag || /[\s~^:?*[\\]|\.\.|^\.|\/$|\.lock$/.test(tag)) throw new HttpError(422, "invalid tag name", { errors: [{ resource: "Tag", code: "invalid", field: "tag" }] });
    const object = String(input.object ?? "");
    const actual = isOid(object) ? this.objectType(object) : null;
    if (!actual) throw new HttpError(422, "object does not exist", { errors: [{ resource: "Tag", code: "invalid", field: "object" }] });
    const type = (input.type ?? actual) as ObjectType;
    if (type !== actual) throw new HttpError(422, `object is a ${actual}, not a ${type}`, { errors: [{ resource: "Tag", code: "invalid", field: "type" }] });
    const tagger = parseSig(input.tagger, this.signature(caller), "tagger");
    const message = String(input.message ?? "");
    this.scan("(tag message)", utf8(message), caller);
    const sha = await this.store.write("tag", serializeTag({ object, type, tag, tagger, message: message.endsWith("\n") || !message ? message : `${message}\n` }));
    return this.getTag(sha);
  }

  async getTag(sha: string) {
    if (!isOid(sha) || this.objectType(sha) !== "tag") throw new HttpError(404, "tag not found");
    const o = await this.store.read(sha);
    const t = parseTag(o!.content);
    return { sha, tag: t.tag, message: t.message, tagger: t.tagger ?? null, object: { sha: t.object, type: t.type } };
  }

  // ---------------------------------------------------------------- contents

  /** Create or update one file; `sha` must name the file's current blob when it exists (GitHub's rule). */
  async putContents(
    input: { path: string; content: Uint8Array; message: string; branch?: string; sha?: string; author?: { name: string; email: string }; committer?: { name: string; email: string } },
    caller: Caller,
  ): Promise<{ created: boolean; commit: CommitInfo; blob: { sha: string; size: number } }> {
    this.requireWrite(caller);
    if (!input.message) throw new HttpError(422, "message is required", { errors: [{ resource: "Commit", code: "missing_field", field: "message" }] });
    const branch = input.branch || this.repo.meta.defaultBranch;
    const head = this.repo.getRef(`refs/heads/${branch}`);
    const existing = head ? await resolvePath(this.store, (await readCommit(this.store, head)).tree, input.path) : null;
    if (existing && isTreeMode(existing.mode)) throw new HttpError(422, `${input.path} is a directory`);
    if (existing && !input.sha) throw new HttpError(422, "Invalid request.\n\n\"sha\" wasn't supplied.", { errors: [{ resource: "Contents", code: "missing_field", field: "sha" }] });
    if (existing && input.sha !== existing.oid) throw new HttpError(409, `${input.path} does not match ${input.sha}`);
    if (!existing && input.sha) throw new HttpError(409, `${input.path} does not exist at ${branch}`);
    const oid = await hashObject("blob", input.content);
    const res = await this.repo.commitFiles({ branch, message: input.message, changes: [{ path: input.path, content: input.content }], expectedHeadSha: head ?? undefined, author: input.author, committer: input.committer }, caller);
    return { created: !existing, commit: await this.repo.commitInfo(res.sha), blob: { sha: oid, size: input.content.length } };
  }

  async deleteContents(input: { path: string; message: string; branch?: string; sha?: string; author?: { name: string; email: string }; committer?: { name: string; email: string } }, caller: Caller): Promise<CommitInfo> {
    this.requireWrite(caller);
    if (!input.message) throw new HttpError(422, "message is required");
    const branch = input.branch || this.repo.meta.defaultBranch;
    const head = this.repo.getRef(`refs/heads/${branch}`);
    if (!head) throw new HttpError(404, `branch ${branch} not found`);
    const existing = await resolvePath(this.store, (await readCommit(this.store, head)).tree, input.path);
    if (!existing || isTreeMode(existing.mode)) throw new HttpError(404, "file not found");
    if (!input.sha) throw new HttpError(422, "Invalid request.\n\n\"sha\" wasn't supplied.", { errors: [{ resource: "Contents", code: "missing_field", field: "sha" }] });
    if (input.sha !== existing.oid) throw new HttpError(409, `${input.path} does not match ${input.sha}`);
    const res = await this.repo.commitFiles({ branch, message: input.message, changes: [{ path: input.path, delete: true }], expectedHeadSha: head, author: input.author, committer: input.committer }, caller);
    return this.repo.commitInfo(res.sha);
  }

  /** The README in a directory (GET /readme). */
  async readme(rev: string, dir = ""): Promise<{ path: string; sha: string; size: number; content: Uint8Array; commit: string } | null> {
    const t = await this.repo.tree(rev, dir);
    if (!t) return null;
    const candidates = t.items.filter((i) => i.type === "blob" && /^readme(\.[A-Za-z0-9]+)?$/i.test(i.name));
    const pick = candidates.find((i) => /\.(md|markdown)$/i.test(i.name)) ?? candidates[0];
    if (!pick) return null;
    const b = await this.repo.blob(t.sha, pick.path);
    return b ? { path: pick.path, sha: b.oid, size: b.size, content: b.content, commit: b.sha } : null;
  }

  // ---------------------------------------------------------------- merges API

  /** Merge `head` into the `base` branch. Returns null when there is nothing to merge. */
  async merge(input: { base?: string; head?: string; commit_message?: string }, caller: Caller): Promise<CommitInfo | null> {
    this.requireWrite(caller);
    const base = String(input.base ?? "");
    const ref = `refs/heads/${base}`;
    const baseSha = this.repo.getRef(ref);
    if (!baseSha) throw new HttpError(404, "Base does not exist");
    const headSha = await this.repo.resolve(String(input.head ?? ""));
    if (!headSha) throw new HttpError(404, "Head does not exist");
    if (await isAncestor(this.store, headSha, baseSha)) return null;
    const mb = await mergeBase(this.store, baseSha, headSha);
    const [bt, ht, mt] = await Promise.all([readCommit(this.store, baseSha), readCommit(this.store, headSha), mb ? readCommit(this.store, mb) : null]);
    const merged = await mergeTrees(this.store, mt?.tree ?? null, bt.tree, ht.tree);
    if (merged.conflicts.length || !merged.tree) throw new HttpError(409, "Merge conflict");
    const sig = this.signature(caller);
    const message = input.commit_message || `Merge ${input.head} into ${base}`;
    const sha = await this.store.write("commit", serializeCommit({ tree: merged.tree, parents: [baseSha, headSha], author: sig, committer: sig, message: message.endsWith("\n") ? message : `${message}\n`, extraHeaders: this.agentHeaders(caller) }));
    const check = await this.repo.checkRefUpdate(ref, baseSha, sha, caller);
    if (!check.ok) throw new HttpError(403, check.reason ?? "rejected");
    if (!this.repo.casRef(ref, baseSha, sha)) throw new HttpError(409, "base branch moved; try again");
    await this.repo.afterRefUpdate(ref, baseSha, sha, caller);
    return this.repo.commitInfo(sha);
  }

  // ---------------------------------------------------------------- languages and archives

  /** Bytes per language at the default branch, cached per commit. */
  async languages(): Promise<Record<string, number>> {
    const sha = await this.repo.resolve("HEAD");
    if (!sha) return {};
    const cached = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'languages'").toArray()[0];
    if (cached) {
      const c = JSON.parse(cached.value) as { sha: string; data: Record<string, number> };
      if (c.sha === sha) return c.data;
    }
    const out: Record<string, number> = {};
    try {
      await this.walkTree((await readCommit(this.store, sha)).tree, "", (e, path) => {
        if (isTreeMode(e.mode)) return !VENDORED.test(`${path}/`);
        if (e.mode === "160000" || e.mode === "120000" || VENDORED.test(path)) return false;
        const lang = LANGUAGE_FILES[e.name] ?? LANGUAGES[e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : ""];
        if (!lang) return false;
        const size = this.sql.exec<{ size: number }>("SELECT size FROM objects WHERE oid = ?", e.oid).toArray()[0]?.size ?? 0;
        out[lang] = (out[lang] ?? 0) + size;
        return false;
      });
    } catch (e) {
      // A huge (or hostile) tree: report what was counted before the budget ran out.
      if (!(e instanceof HttpError && e.status === 413)) throw e;
    }
    const sorted = Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('languages', ?)", JSON.stringify({ sha, data: sorted }));
    return sorted;
  }

  archiveKey(sha: string, format: "zip" | "tar.gz"): string {
    // Outside repos/: a cache the lifecycle rules may expire (lib/storage-keys.ts).
    return archiveKey(this.repo.meta.repoId, sha, format);
  }

  /**
   * Visit every entry under a tree, depth first. `visit` returns whether to
   * descend into a subtree. Every entry visited counts against one budget
   * (a subtree reused a thousand times costs a thousand times), so a small
   * tree of shared subtrees can't make a walk explode.
   */
  private async walkTree(tree: string, prefix: string, visit: (e: TreeEntry, path: string) => boolean | Promise<boolean>, budget = { left: MAX_TREE_ENTRIES }, depth = 0): Promise<void> {
    if (depth > MAX_TREE_DEPTH) throw new HttpError(413, "the tree is nested too deeply");
    for (const e of await readTree(this.store, tree)) {
      if (--budget.left < 0) throw new HttpError(413, `the tree has more than ${MAX_TREE_ENTRIES.toLocaleString("en-US")} entries; clone it with git instead`);
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if ((await visit(e, path)) && isTreeMode(e.mode)) await this.walkTree(e.oid, path, visit, budget, depth + 1);
    }
  }

  /** Allow at most ARCHIVE_BUILDS_PER_HOUR fresh archive builds per repository. */
  private countArchiveBuild(): void {
    const hourAgo = Date.now() - 3600_000;
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'archive_builds'").toArray()[0];
    const recent = (row ? (JSON.parse(row.value) as number[]) : []).filter((t) => t > hourAgo);
    if (recent.length >= ARCHIVE_BUILDS_PER_HOUR) throw new HttpError(429, "too many archives were built for this repository in the last hour; try again later or clone it with git");
    recent.push(Date.now());
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('archive_builds', ?)", JSON.stringify(recent));
  }

  /**
   * Build a source archive of a commit into R2 (top directory `<owner>-<repo>-<sha7>/`,
   * like GitHub). Entries stream through the compressor into R2, so memory stays
   * around one file plus one upload part. Archives are a cache: R2 may evict them
   * and they are rebuilt on the next download.
   */
  async buildArchive(sha: string, format: "zip" | "tar.gz"): Promise<{ key: string; size: number }> {
    const commit = await readCommit(this.store, sha);
    this.countArchiveBuild();
    const m = this.repo.meta;
    const prefix = `${m.owner}-${m.name}-${sha.slice(0, 7)}`;
    const mtime = commit.committer.timestamp;
    const key = this.archiveKey(sha, format);
    const sink = new R2Sink(this.env.BUCKET, key, format === "zip" ? "application/zip" : "application/gzip", MAX_ARCHIVE_BYTES + 16 * 1024 * 1024, "repository is too large for an on-the-fly archive; clone it with git instead");
    let total = 0;
    // Each entry, in tree order; unsafe names (and anything under them) are left out.
    const entries = async (emit: (e: ArchiveEntry) => Promise<void>) => {
      await emit({ path: `${prefix}/`, dir: true });
      await this.walkTree(commit.tree, prefix, async (e, path) => {
        if (unsafeTreeName(e.name)) return false;
        if (isTreeMode(e.mode)) {
          await emit({ path: `${path}/`, dir: true });
          return true;
        }
        if (e.mode === "160000") {
          await emit({ path: `${path}/`, dir: true });
          return false;
        }
        const o = await this.store.read(e.oid);
        if (!o) return false;
        total += o.content.length;
        if (total > MAX_ARCHIVE_BYTES) throw new HttpError(413, "repository is too large for an on-the-fly archive; clone it with git instead");
        await emit({ path, mode: e.mode, content: o.content });
        return false;
      });
    };
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    try {
      if (format === "zip") {
        const zw = new ZipWriter(mtime);
        await entries(async (e) => {
          let parts: Uint8Array[];
          try {
            parts = await zw.entry(e);
          } catch (err) {
            if (err instanceof RangeError) throw new HttpError(413, "this repository has too many files for a zip archive (more than 65,535); download the .tar.gz archive or clone it with git");
            throw err;
          }
          for (const part of parts) await sink.write(part);
        });
        for (const part of zw.end(sha)) await sink.write(part);
      } else {
        const gz = new CompressionStream("gzip");
        const w = gz.writable.getWriter();
        writer = w;
        const reader = gz.readable.getReader();
        const pump = (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            await sink.write(value);
          }
        })();
        // If R2 or the size limit stops the pump, fail the writes instead of waiting on backpressure.
        const stopped = pump.catch(async (err) => {
          await w.abort(err).catch(() => undefined);
          throw err;
        });
        const put = async (parts: Uint8Array[]) => {
          for (const part of parts) if (part.length) await w.write(part);
        };
        await put(tarStart(mtime, sha));
        await entries((e) => put(tarEntry(e, mtime)));
        await put([tarEnd()]);
        await w.close();
        await stopped;
      }
      return { key, size: await sink.close() };
    } catch (e) {
      await writer?.abort(e).catch(() => undefined);
      await sink.abort();
      throw e;
    }
  }

  // ---------------------------------------------------------------- Actions extras

  /**
   * A run's logs as a zip (GET /actions/runs/:id/logs), laid out like GitHub's: one text file per
   * job, and a folder per job with a file per step (`build/1_Run tests.txt`), which `gh run view
   * --log` shows each step's lines from.
   */
  async runLogsZip(runId: string): Promise<Uint8Array> {
    const run = this.repo.actions.getRun(runId);
    const entries: ArchiveEntry[] = [];
    const text = (lines: Array<{ t: string; text: string }>) => new TextEncoder().encode(lines.map((l) => `${l.t} ${l.text}`).join("\n") + (lines.length ? "\n" : ""));
    let total = 0;
    for (const [i, j] of run.jobs.entries()) {
      const { lines } = await this.repo.actions.logs(j.id);
      const all = text(lines);
      total += all.length * 2;
      if (total > 24 * 1024 * 1024) break;
      entries.push({ path: `${i + 1}_${j.name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 100)}.txt`, mode: "100644", content: all });
      // gh finds a step's file by the job's name without "/" and ":", cut to 90 characters.
      const dir = j.name.replace(/[\\/:*?"<>|]+/g, "").slice(0, 90);
      for (const s of j.steps) {
        const mine = lines.filter((l) => l.step === s.index);
        entries.push({ path: `${dir}/${s.index + 1}_${s.name.replace(/[\\/:*?"<>|]+/g, "").slice(0, 100)}.txt`, mode: "100644", content: text(mine) });
      }
    }
    return zip(entries, Math.floor(Date.parse(run.updatedAt) / 1000) || Math.floor(Date.now() / 1000));
  }

  /** The run id of attempt `n` of a run (re-runs are stored as new runs with the same number). */
  runAttemptId(runId: string, attempt: number): string {
    const r = this.repo.actions.getRun(runId);
    const row = this.sql.exec<{ id: string }>("SELECT id FROM runs WHERE workflow_path = ? AND run_number = ? AND attempt = ? ORDER BY created_at DESC LIMIT 1", r.workflowPath, r.number, attempt).toArray()[0];
    if (!row) throw new HttpError(404, "run attempt not found");
    return row.id;
  }

  // ---------------------------------------------------------------- check runs and suites

  /**
   * A check run by GitHub's numeric id, Diffinery's own, or the Actions job that reports it: a job's
   * `check_run_url`, or its REST id (http/gh.ts uuidNumber), which `gh run view` asks for annotations by.
   */
  check(raw: string): Check {
    const job = uuidPattern(raw);
    if (job) raw = this.sql.exec<{ id: string }>("SELECT id FROM jobs WHERE id GLOB ? ORDER BY rowid DESC LIMIT 1", job).toArray()[0]?.id ?? raw;
    const row = /^\d{1,15}$/.test(raw)
      ? this.sql.exec<{ sha: string; id: string }>("SELECT sha, id FROM checks WHERE seq = ?", Number(raw)).toArray()[0]
      : (this.sql.exec<{ sha: string; id: string }>("SELECT sha, id FROM checks WHERE id = ?", raw).toArray()[0] ??
        this.sql.exec<{ sha: string; id: string }>("SELECT sha, id FROM checks WHERE job_id = ? ORDER BY seq DESC LIMIT 1", raw).toArray()[0]);
    const c = row ? this.repo.collab.checks(row.sha).find((x) => x.id === row.id) : undefined;
    if (!c) throw new HttpError(404, "check run not found");
    return c;
  }

  /** PATCH /check-runs/:id: status, conclusion, output (annotations accumulate, like GitHub). */
  updateCheck(
    id: string,
    input: {
      name?: string;
      details_url?: string;
      external_id?: string;
      status?: string;
      conclusion?: string;
      started_at?: string;
      completed_at?: string;
      output?: { title?: string; summary?: string; text?: string; annotations?: unknown[] };
    },
    caller: Caller,
  ): Check {
    this.requireWrite(caller);
    const c = this.check(id);
    if (c.app === ACTIONS_APP) throw new HttpError(403, "check runs from Diffinery Actions can't be changed over the API");
    const own = c.creatorId ? c.creatorId === caller.id : c.app.toLowerCase() === caller.login.toLowerCase();
    if (!own) throw new HttpError(403, "only the app that created a check run can update it");
    if (input.status && !["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(input.status)) throw new HttpError(422, "invalid status", { errors: [{ resource: "CheckRun", code: "invalid", field: "status" }] });
    const conclusions = ["action_required", "cancelled", "failure", "neutral", "success", "skipped", "stale", "timed_out"];
    if (input.conclusion && !conclusions.includes(input.conclusion)) throw new HttpError(422, "invalid conclusion", { errors: [{ resource: "CheckRun", code: "invalid", field: "conclusion" }] });
    if (input.details_url && !/^https?:\/\//i.test(input.details_url)) throw new HttpError(422, "details_url must be an http(s) URL");
    const status = input.conclusion ? "completed" : (input.status ?? c.status);
    if (status === "completed" && !(input.conclusion ?? c.conclusion)) throw new HttpError(422, "conclusion is required when status is completed", { errors: [{ resource: "CheckRun", code: "missing_field", field: "conclusion" }] });
    const output = { ...(c.output ?? {}) } as Record<string, unknown>;
    if (input.output) {
      for (const k of ["title", "summary", "text"] as const) if (input.output[k] !== undefined) output[k] = String(input.output[k]).slice(0, 65535);
      if (Array.isArray(input.output.annotations)) {
        const all = [...((output.annotations as unknown[]) ?? []), ...input.output.annotations.slice(0, 50)];
        output.annotations = all.slice(0, 1000);
      }
    }
    if (input.external_id !== undefined) output.external_id = String(input.external_id);
    const t = now();
    this.sql.exec(
      "UPDATE checks SET name = ?, status = ?, conclusion = ?, details_url = ?, output = ?, started_at = ?, completed_at = ? WHERE id = ?",
      input.name ?? c.name,
      status,
      status === "completed" ? (input.conclusion ?? c.conclusion) : null,
      input.details_url ?? c.detailsUrl,
      JSON.stringify(output),
      input.started_at ?? c.startedAt ?? (status !== "queued" ? t : null),
      status === "completed" ? (input.completed_at ?? c.completedAt ?? t) : null,
      c.id,
    );
    for (const p of this.sql.exec<{ number: number }>("SELECT number FROM pulls WHERE head_sha = ?", c.sha).toArray()) this.repo.broadcast(`pr:${p.number}`, { action: "checks" });
    if (status === "completed") this.repo.collab.checkCompleted(c.sha);
    return this.check(c.id);
  }

  /**
   * Check suites, synthesised: one per workflow run, or per app for external check runs. `number` is
   * the REST API's id: the run's (http/gh.ts uuidNumber), or a hash of the app suite's id.
   */
  checkSuites(sha: string): Array<{ id: string; number: number; app: string; headSha: string; status: string; conclusion: string | null; runs: Check[] }> {
    const groups = new Map<string, Check[]>();
    for (const c of this.repo.collab.checks(sha)) {
      const id = c.runId ?? `app-${c.app}-${sha}`;
      groups.set(id, [...(groups.get(id) ?? []), c]);
    }
    return [...groups].map(([id, runs]) => {
      const done = runs.every((r) => r.status === "completed");
      const failed = runs.some((r) => ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""));
      return { id, number: suiteNumber(id), app: runs[0]!.app, headSha: sha, status: done ? "completed" : runs.some((r) => r.status === "in_progress") ? "in_progress" : "queued", conclusion: done ? (failed ? "failure" : "success") : null, runs };
    });
  }

  /** A check suite by its id or its REST API number (`number` in checkSuites). */
  checkSuite(id: string): ReturnType<GitData["checkSuites"]>[number] {
    if (/^\d{1,16}$/.test(id)) {
      const run = uuidPattern(id);
      const n = Number(id);
      id =
        (run && this.sql.exec<{ id: string }>("SELECT id FROM runs WHERE id GLOB ? ORDER BY created_at DESC LIMIT 1", run).toArray()[0]?.id) ||
        // App suites have no table to look their number up in; external check runs are few.
        this.sql
          .exec<{ app: string; sha: string }>("SELECT DISTINCT app, sha FROM checks WHERE run_id IS NULL")
          .toArray()
          .map((r) => `app-${r.app}-${r.sha}`)
          .find((k) => suiteNumber(k) === n) ||
        id;
    }
    const row = id.startsWith("app-")
      ? this.sql.exec<{ sha: string }>("SELECT sha FROM checks WHERE ? = 'app-' || app || '-' || sha LIMIT 1", id).toArray()[0]
      : this.sql.exec<{ sha: string }>("SELECT sha FROM checks WHERE run_id = ? LIMIT 1", id).toArray()[0];
    const suite = row ? this.checkSuites(row.sha).find((s) => s.id === id) : undefined;
    if (!suite) throw new HttpError(404, "check suite not found");
    return suite;
  }
}

/** A check suite's REST API id: its workflow run's, or a hash of an app suite's `app-<app>-<sha>`. */
function suiteNumber(id: string): number {
  return id.startsWith("app-") ? numericId(id) : uuidNumber(id);
}
