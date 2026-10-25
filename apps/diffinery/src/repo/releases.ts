import { ZERO_OID, fromUtf8, isAncestor, peelToCommit, walkCommits } from "@diffinery/git-core";
import type { Env } from "../env.js";
import { ghRelease, nodeId, numericId } from "../http/gh.js";
import { importHostAllowed, withoutCredentials } from "../lib/import-hosts.js";
import { R2Sink } from "../lib/r2-sink.js";
import { HttpError, isValidRefName, now } from "../lib/util.js";
import { triggerWorkflows } from "./extra-triggers.js";
import { parseReleaseConfig, renderReleaseNotes, type NotesPull } from "./release-notes.js";
import type { RepoDO } from "./RepoDO.js";
import { atLeast, type Caller } from "./types.js";

type ReleaseRow = {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  draft: number;
  prerelease: number;
  author_id: string;
  author_login: string;
  author_kind: string;
  created_at: string;
  published_at: string | null;
  updated_at: string;
};

type AssetRow = {
  id: number;
  release_id: number;
  name: string;
  label: string;
  content_type: string;
  size: number;
  state: string;
  download_count: number;
  uploader_id: string | null;
  uploader_login: string | null;
  uploader_kind: string | null;
  r2_key: string;
  created_at: string;
  updated_at: string;
};

export type ReleaseAsset = {
  id: number;
  releaseId: number;
  name: string;
  label: string;
  contentType: string;
  size: number;
  state: string;
  downloadCount: number;
  uploader: { id: string; login: string; kind: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type Release = {
  id: number;
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  author: { id: string; login: string; kind: string };
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
  /** Whether this is the repository's latest release. */
  latest: boolean;
  assets: ReleaseAsset[];
};

export type MakeLatest = "true" | "false" | "legacy";

export type ReleaseInput = {
  tag_name?: string;
  target_commitish?: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  make_latest?: MakeLatest | boolean;
  generate_release_notes?: boolean;
};

/** What the importer knows about a release on the source forge. */
export type ImportedRelease = {
  tag_name: string;
  target_commitish?: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  created_at: string;
  published_at?: string | null;
  author: { id?: string; login: string; kind?: string };
  /** Mark as the repository's latest release (GitHub's `make_latest`). */
  latest?: boolean;
};

export type ImportedAsset = {
  name: string;
  label?: string;
  content_type?: string;
  download_count?: number;
  created_at?: string;
  updated_at?: string;
  uploader?: { id?: string; login: string; kind?: string };
};

const MAX_IMPORT_BYTES = 2 * 1024 ** 3;
/** Downloads of an imported release asset, when GitHub answers with a server error. */
const ASSET_DOWNLOAD_TRIES = 3;

/** GitHub renames asset files with unusual characters; do the same. */
export function assetName(raw: string): string {
  const name = raw
    .split(/[\\/]/)
    .pop()!
    .replace(/[^A-Za-z0-9._+@~-]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  if (!name || name.length > 255) throw new HttpError(422, "asset name must be 1 to 255 characters", { errors: [{ resource: "ReleaseAsset", code: "invalid", field: "name" }] });
  return name;
}

const toAsset = (a: AssetRow): ReleaseAsset => ({
  id: a.id,
  releaseId: a.release_id,
  name: a.name,
  label: a.label,
  contentType: a.content_type,
  size: a.size,
  state: a.state,
  downloadCount: a.download_count,
  uploader: a.uploader_id ? { id: a.uploader_id, login: a.uploader_login ?? "", kind: a.uploader_kind ?? "user" } : null,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
});

/** Blocks fetches to loopback, private and link-local hosts (the importer's asset URLs come from users). */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || (!h.includes(".") && !h.includes(":"))) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return false;
  if (h.includes(":") && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:"))) return false;
  return true;
}

/**
 * GitHub-compatible releases: rows in the repository's SQLite, asset bytes in
 * R2 under `repos/<id>/releases/`. Drafts are visible only to writers, and
 * publishing creates the tag from `target_commitish` when it doesn't exist.
 */
export class Releases {
  constructor(
    private repo: RepoDO,
    private env: Env,
  ) {}

  private get sql() {
    return this.repo.sql;
  }

  private row(id: number): ReleaseRow {
    const r = this.sql.exec<ReleaseRow>("SELECT * FROM releases WHERE id = ?", id).toArray()[0];
    if (!r) throw new HttpError(404, "release not found");
    return r;
  }

  private visibleRow(id: number, caller: Caller): ReleaseRow {
    const r = this.row(id);
    if (r.draft && !atLeast(caller.role, "write")) throw new HttpError(404, "release not found");
    return r;
  }

  private assetsOf(releaseId: number): ReleaseAsset[] {
    return this.sql.exec<AssetRow>("SELECT * FROM release_assets WHERE release_id = ? AND state = 'uploaded' ORDER BY id", releaseId).toArray().map(toAsset);
  }

  private toRelease(r: ReleaseRow, latestId = this.latestId()): Release {
    return {
      id: r.id,
      tagName: r.tag_name,
      targetCommitish: r.target_commitish,
      name: r.name,
      body: r.body,
      draft: !!r.draft,
      prerelease: !!r.prerelease,
      author: { id: r.author_id, login: r.author_login, kind: r.author_kind },
      createdAt: r.created_at,
      publishedAt: r.published_at,
      updatedAt: r.updated_at,
      latest: r.id === latestId,
      assets: this.assetsOf(r.id),
    };
  }

  // ---------------------------------------------------------------- latest

  private pinned(): number | null {
    const v = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'latest_release'").toArray()[0]?.value;
    return v ? Number(v) : null;
  }

  private pin(id: number | null): void {
    if (id === null) this.sql.exec("DELETE FROM meta WHERE key = 'latest_release'");
    else this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('latest_release', ?)", String(id));
  }

  /** The release marked latest, else the newest published full release (GitHub's rule). */
  latestId(): number | null {
    const p = this.pinned();
    if (p !== null && this.sql.exec("SELECT 1 FROM releases WHERE id = ? AND draft = 0 AND prerelease = 0", p).toArray().length) return p;
    return this.sql.exec<{ id: number }>("SELECT id FROM releases WHERE draft = 0 AND prerelease = 0 ORDER BY created_at DESC, id DESC LIMIT 1").toArray()[0]?.id ?? null;
  }

  /** Apply `make_latest` after a release was created or changed. */
  private applyLatest(r: ReleaseRow, make: MakeLatest | undefined, previousLatest: number | null): void {
    const eligible = !r.draft && !r.prerelease;
    if (make === "legacy") return this.pin(null);
    if (make === "false") {
      if (this.pinned() === r.id) this.pin(null);
      // Keep whatever was latest before, rather than letting this newer release win by date.
      else if (this.pinned() === null && previousLatest !== null && previousLatest !== r.id) this.pin(previousLatest);
      return;
    }
    if (make === "true" && eligible) this.pin(r.id);
  }

  // ---------------------------------------------------------------- reading

  list(opts: { limit: number; offset: number }, caller: Caller): { items: Release[]; total: number } {
    const drafts = atLeast(caller.role, "write") ? "" : "WHERE draft = 0";
    const total = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM releases ${drafts}`).one().n;
    const latest = this.latestId();
    const rows = this.sql.exec<ReleaseRow>(`SELECT * FROM releases ${drafts} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, Math.min(opts.limit, 100), opts.offset).toArray();
    return { items: rows.map((r) => this.toRelease(r, latest)), total };
  }

  get(id: number, caller: Caller): Release {
    return this.toRelease(this.visibleRow(id, caller));
  }

  /** A published release by tag; drafts only when `includeDrafts` and the caller can write (web UI). */
  byTag(tag: string, caller: Caller, includeDrafts = false): Release {
    const drafts = includeDrafts && atLeast(caller.role, "write");
    const r = this.sql.exec<ReleaseRow>(`SELECT * FROM releases WHERE tag_name = ? ${drafts ? "" : "AND draft = 0"} ORDER BY draft, created_at DESC LIMIT 1`, tag).toArray()[0];
    if (!r) throw new HttpError(404, "release not found");
    return this.toRelease(r);
  }

  latest(): Release {
    const id = this.latestId();
    if (id === null) throw new HttpError(404, "no published releases");
    return this.toRelease(this.row(id), id);
  }

  /** Release count and the latest release, for the repository home page. */
  summary(caller: Caller): { count: number; latest: Release | null } {
    const drafts = atLeast(caller.role, "write") ? "" : "WHERE draft = 0";
    const count = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM releases ${drafts}`).one().n;
    const id = this.latestId();
    return { count, latest: id === null ? null : this.toRelease(this.row(id), id) };
  }

  // ---------------------------------------------------------------- writing

  private requireWrite(caller: Caller): void {
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to manage releases");
  }

  /** Make sure `refs/tags/<tag>` exists, creating it at `target` (a branch, tag or SHA) like GitHub does on publish. */
  private async ensureTag(tag: string, target: string, caller: Caller): Promise<string> {
    const ref = `refs/tags/${tag}`;
    const existing = this.repo.getRef(ref);
    if (existing) return peelToCommit(this.repo.store, existing);
    if (!isValidRefName(ref)) throw new HttpError(422, `'${tag}' is not a valid tag name`, { errors: [{ resource: "Release", code: "invalid", field: "tag_name" }] });
    const sha = await this.repo.resolve(target);
    if (!sha) throw new HttpError(422, `target_commitish '${target}' does not exist`, { errors: [{ resource: "Release", code: "invalid", field: "target_commitish" }] });
    const check = await this.repo.checkRefUpdate(ref, ZERO_OID, sha, caller);
    if (!check.ok) throw new HttpError(403, check.reason ?? "tag creation rejected");
    if (!this.repo.casRef(ref, ZERO_OID, sha)) throw new HttpError(409, "tag was created concurrently; retry");
    await this.repo.afterRefUpdate(ref, ZERO_OID, sha, caller);
    return sha;
  }

  async create(input: ReleaseInput, caller: Caller): Promise<Release> {
    this.requireWrite(caller);
    const tag = (input.tag_name ?? "").trim();
    if (!tag) throw new HttpError(422, "tag_name is required", { errors: [{ resource: "Release", code: "missing_field", field: "tag_name" }] });
    const draft = !!input.draft;
    if (!draft && this.sql.exec("SELECT 1 FROM releases WHERE tag_name = ? AND draft = 0", tag).toArray().length) {
      throw new HttpError(422, "a release for this tag already exists", { errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }] });
    }
    const target = input.target_commitish?.trim() || this.repo.meta.defaultBranch;
    if (!draft) await this.ensureTag(tag, target, caller);
    else if (!this.repo.getRef(`refs/tags/${tag}`) && !(await this.repo.resolve(target))) throw new HttpError(422, `target_commitish '${target}' does not exist`);
    let body = input.body ?? "";
    let name = input.name ?? "";
    if (input.generate_release_notes) {
      const notes = await this.generateNotes({ tag_name: tag, target_commitish: target });
      body = body ? `${body}\n\n${notes.body}` : notes.body;
      name ||= notes.name;
    }
    const before = this.latestId();
    const t = now();
    this.sql.exec(
      "INSERT INTO releases (tag_name, target_commitish, name, body, draft, prerelease, author_id, author_login, author_kind, created_at, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      tag,
      target,
      name,
      body,
      draft ? 1 : 0,
      input.prerelease ? 1 : 0,
      caller.id,
      caller.login,
      caller.kind,
      t,
      draft ? null : t,
      t,
    );
    const id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    const row = this.row(id);
    this.applyLatest(row, makeLatest(input.make_latest) ?? "true", before);
    const rel = this.toRelease(row);
    await this.announce(rel, draft ? ["created"] : ["created", "published", rel.prerelease ? "prereleased" : "released"], caller);
    return this.toRelease(this.row(id));
  }

  async update(id: number, input: ReleaseInput, caller: Caller): Promise<Release> {
    this.requireWrite(caller);
    const r = this.row(id);
    const tag = input.tag_name?.trim() || r.tag_name;
    const target = input.target_commitish?.trim() || r.target_commitish;
    const draft = input.draft === undefined ? !!r.draft : !!input.draft;
    const prerelease = input.prerelease === undefined ? !!r.prerelease : !!input.prerelease;
    if (!draft && this.sql.exec("SELECT 1 FROM releases WHERE tag_name = ? AND draft = 0 AND id != ?", tag, id).toArray().length) {
      throw new HttpError(422, "a release for this tag already exists", { errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }] });
    }
    const publishing = !!r.draft && !draft;
    if (!draft) await this.ensureTag(tag, target, caller);
    const before = this.latestId();
    const t = now();
    this.sql.exec(
      "UPDATE releases SET tag_name = ?, target_commitish = ?, name = ?, body = ?, draft = ?, prerelease = ?, published_at = ?, updated_at = ? WHERE id = ?",
      tag,
      target,
      input.name ?? r.name,
      input.body ?? r.body,
      draft ? 1 : 0,
      prerelease ? 1 : 0,
      draft ? null : (r.published_at ?? t),
      t,
      id,
    );
    const row = this.row(id);
    this.applyLatest(row, makeLatest(input.make_latest) ?? (publishing ? "true" : undefined), before);
    const rel = this.toRelease(row);
    const actions: string[] = [];
    if (publishing) actions.push("published", prerelease ? "prereleased" : "released");
    else if (!r.draft && draft) actions.push("unpublished");
    else {
      actions.push("edited");
      if (!draft && !!r.prerelease !== prerelease) actions.push(prerelease ? "prereleased" : "released");
    }
    await this.announce(rel, actions, caller);
    return rel;
  }

  async remove(id: number, caller: Caller): Promise<void> {
    this.requireWrite(caller);
    const rel = this.toRelease(this.row(id));
    const keys = this.sql.exec<{ r2_key: string }>("SELECT r2_key FROM release_assets WHERE release_id = ?", id).toArray().map((a) => a.r2_key);
    this.sql.exec("DELETE FROM release_assets WHERE release_id = ?", id);
    this.sql.exec("DELETE FROM releases WHERE id = ?", id);
    this.sql.exec("DELETE FROM reactions WHERE subject = ?", `release:${id}`);
    if (this.pinned() === id) this.pin(null);
    if (keys.length) this.repo.storageChanged();
    await this.deleteObjects(keys);
    await this.announce(rel, ["deleted"], caller);
  }

  /** Webhooks for every action; workflows (`on: release`) only for published releases, like GitHub. */
  private async announce(rel: Release, actions: string[], caller: Caller): Promise<void> {
    const m = this.repo.meta;
    const base = this.env.PUBLIC_URL.replace(/\/$/, "");
    const release = ghRelease(base, m.owner, m.name, rel);
    const repository = { id: numericId(m.repoId), node_id: nodeId("Repository", m.repoId), name: m.name, full_name: `${m.owner}/${m.name}`, owner: { login: m.owner }, default_branch: m.defaultBranch, html_url: `${base}/${m.owner}/${m.name}`, clone_url: `${base}/${m.owner}/${m.name}.git` };
    const actor = { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf };
    const t = now();
    // Drafts are visible to writers only: their events go to webhooks (set up by admins), never to readers' open pages.
    const live = !rel.draft;
    for (const action of actions) this.repo.emit({ type: "release", action, repoId: m.repoId, owner: m.owner, repo: m.name, payload: { release }, actor, at: t }, { live });
    if (live) this.repo.broadcast("releases", { action: actions[0], id: rel.id });
    if (rel.draft && actions.every((a) => a !== "unpublished")) return;
    const ref = `refs/tags/${rel.tagName}`;
    const tagged = this.repo.getRef(ref);
    if (!tagged) return;
    const sha = await peelToCommit(this.repo.store, tagged).catch(() => null);
    if (!sha) return;
    for (const action of actions) {
      await triggerWorkflows(this.repo, { name: "release", action, ref, sha, payload: { action, release, repository, sender: { login: caller.login, type: caller.kind === "user" ? "User" : "Bot" } }, title: rel.name || rel.tagName }, caller);
    }
  }

  // ---------------------------------------------------------------- release notes

  async generateNotes(input: { tag_name: string; target_commitish?: string; previous_tag_name?: string; configuration_file_path?: string }): Promise<{ name: string; body: string }> {
    const tag = input.tag_name?.trim();
    if (!tag) throw new HttpError(422, "tag_name is required", { errors: [{ resource: "Release", code: "missing_field", field: "tag_name" }] });
    const tagged = this.repo.getRef(`refs/tags/${tag}`);
    const head = tagged ? await peelToCommit(this.repo.store, tagged) : await this.repo.resolve(input.target_commitish || this.repo.meta.defaultBranch);
    if (!head) throw new HttpError(422, "target_commitish does not exist", { errors: [{ resource: "Release", code: "invalid", field: "target_commitish" }] });
    let prev = input.previous_tag_name?.trim() || null;
    let prevSha: string | null = null;
    if (prev) {
      const ref = this.repo.getRef(`refs/tags/${prev}`);
      if (!ref) throw new HttpError(422, `previous tag '${prev}' does not exist`, { errors: [{ resource: "Release", code: "invalid", field: "previous_tag_name" }] });
      prevSha = await peelToCommit(this.repo.store, ref);
    } else {
      // The newest published release whose tag is behind this one.
      for (const r of this.sql.exec<{ tag_name: string }>("SELECT tag_name FROM releases WHERE draft = 0 AND tag_name != ? ORDER BY created_at DESC, id DESC LIMIT 50", tag).toArray()) {
        const ref = this.repo.getRef(`refs/tags/${r.tag_name}`);
        const sha = ref ? await peelToCommit(this.repo.store, ref).catch(() => null) : null;
        if (sha && sha !== head && (await isAncestor(this.repo.store, sha, head))) {
          prev = r.tag_name;
          prevSha = sha;
          break;
        }
      }
    }
    const stop = new Set<string>();
    if (prevSha) for (const c of await walkCommits(this.repo.store, [prevSha], { limit: 100_000 })) stop.add(c.oid);
    const range = new Set((await walkCommits(this.repo.store, [head], { stop, limit: 10_000 })).map((c) => c.oid));
    const m = this.repo.meta;
    const html = `${this.env.PUBLIC_URL.replace(/\/$/, "")}/${m.owner}/${m.name}`;
    type Merged = { number: number; merge_commit: string | null; head_sha: string; merged_at: string; title: string; author_login: string; labels: string };
    const merged = this.sql.exec<Merged>("SELECT p.number, p.merge_commit, p.head_sha, p.merged_at, i.title, i.author_login, i.labels FROM pulls p JOIN issues i ON i.number = p.number WHERE p.merged = 1 ORDER BY p.merged_at, p.number").toArray();
    const toPull = (p: Merged): NotesPull => ({ number: p.number, title: p.title, author: p.author_login, labels: JSON.parse(p.labels) as string[], url: `${html}/pull/${p.number}` });
    const inRange = merged.filter((p) => (p.merge_commit && range.has(p.merge_commit)) || range.has(p.head_sha));
    const first = new Map<string, number>();
    for (const p of merged) if (!first.has(p.author_login.toLowerCase())) first.set(p.author_login.toLowerCase(), p.number);
    const newContributors = inRange.filter((p) => first.get(p.author_login.toLowerCase()) === p.number);
    const paths = input.configuration_file_path ? [input.configuration_file_path] : [".github/release.yml", ".github/release.yaml"];
    let config;
    for (const path of paths) {
      const b = await this.repo.blob(head, path).catch(() => null);
      if (b && !b.binary) {
        config = parseReleaseConfig(fromUtf8(b.content));
        break;
      }
    }
    const changelogUrl = prev ? `${html}/compare/${encodeURIComponent(prev)}...${encodeURIComponent(tag)}` : `${html}/commits/${encodeURIComponent(tag)}`;
    return { name: tag, body: renderReleaseNotes({ pulls: inRange.map(toPull), newContributors: newContributors.map(toPull), changelogUrl, config }) };
  }

  // ---------------------------------------------------------------- assets

  assets(releaseId: number, caller: Caller): ReleaseAsset[] {
    this.visibleRow(releaseId, caller);
    return this.assetsOf(releaseId);
  }

  private assetRow(id: number, caller: Caller): AssetRow {
    const a = this.sql.exec<AssetRow>("SELECT * FROM release_assets WHERE id = ? AND state = 'uploaded'", id).toArray()[0];
    if (!a) throw new HttpError(404, "asset not found");
    this.visibleRow(a.release_id, caller);
    return a;
  }

  asset(id: number, caller: Caller): ReleaseAsset {
    return toAsset(this.assetRow(id, caller));
  }

  updateAsset(id: number, patch: { name?: string; label?: string }, caller: Caller): ReleaseAsset {
    this.requireWrite(caller);
    const a = this.assetRow(id, caller);
    const name = patch.name ? assetName(patch.name) : a.name;
    if (name !== a.name && this.sql.exec("SELECT 1 FROM release_assets WHERE release_id = ? AND name = ? AND id != ?", a.release_id, name, id).toArray().length) {
      throw new HttpError(422, `an asset named ${name} already exists`, { errors: [{ resource: "ReleaseAsset", code: "already_exists", field: "name" }] });
    }
    this.sql.exec("UPDATE release_assets SET name = ?, label = ?, updated_at = ? WHERE id = ?", name, patch.label ?? a.label, now(), id);
    return this.asset(id, caller);
  }

  async deleteAsset(id: number, caller: Caller): Promise<void> {
    this.requireWrite(caller);
    const a = this.assetRow(id, caller);
    this.sql.exec("DELETE FROM release_assets WHERE id = ?", id);
    this.repo.storageChanged();
    await this.deleteObjects([a.r2_key]);
  }

  /** Where this repository's asset bytes live; nothing outside it is ever deleted as an asset. */
  private get assetPrefix(): string {
    return `repos/${this.repo.meta.repoId}/releases/`;
  }

  /** Delete asset objects, but only keys under the asset prefix (never git objects, LFS or caches). */
  private async deleteObjects(keys: string[]): Promise<void> {
    const mine = keys.filter((k) => k.startsWith(this.assetPrefix) && !k.includes(".."));
    if (mine.length) await this.env.BUCKET.delete(mine).catch((e) => console.warn("release asset cleanup failed", e));
  }

  /**
   * Reserve an asset row; the Worker streams the bytes to the returned R2 key, then calls finishAsset.
   * `size` is the asset's, when known: past the owner's storage quota no asset is stored.
   */
  async startAsset(releaseId: number, input: { name: string; label?: string; contentType?: string; size?: number }, caller: Caller, imported?: { createdAt?: string; uploader?: { id: string; login: string; kind: string } }): Promise<{ id: number; r2Key: string }> {
    this.requireWrite(caller);
    this.row(releaseId);
    await this.repo.checkStorage(input.size ?? 0);
    const name = assetName(input.name ?? "");
    const clash = this.sql.exec<{ id: number; state: string; r2_key: string }>("SELECT id, state, r2_key FROM release_assets WHERE release_id = ? AND name = ?", releaseId, name).toArray()[0];
    if (clash?.state === "uploaded") throw new HttpError(422, `an asset named ${name} already exists`, { errors: [{ resource: "ReleaseAsset", code: "already_exists", field: "name" }] });
    if (clash) {
      // An upload that never finished: drop its row and whatever bytes it left behind.
      this.sql.exec("DELETE FROM release_assets WHERE id = ?", clash.id);
      await this.deleteObjects([clash.r2_key]);
    }
    const t = imported?.createdAt ?? now();
    const who = imported?.uploader ?? { id: caller.id, login: caller.login, kind: caller.kind };
    this.sql.exec(
      "INSERT INTO release_assets (release_id, name, label, content_type, uploader_id, uploader_login, uploader_kind, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)",
      releaseId,
      name,
      input.label ?? "",
      (input.contentType || "application/octet-stream").slice(0, 200),
      who.id,
      who.login,
      who.kind,
      t,
      t,
    );
    const id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    const r2Key = `repos/${this.repo.meta.repoId}/releases/${releaseId}/${id}`;
    this.sql.exec("UPDATE release_assets SET r2_key = ? WHERE id = ?", r2Key, id);
    return { id, r2Key };
  }

  finishAsset(id: number, size: number, extra: { downloadCount?: number; updatedAt?: string } = {}): ReleaseAsset {
    const a = this.sql.exec<AssetRow>("SELECT * FROM release_assets WHERE id = ?", id).toArray()[0];
    if (!a) throw new HttpError(404, "asset not found");
    this.sql.exec("UPDATE release_assets SET state = 'uploaded', size = ?, download_count = ?, updated_at = ? WHERE id = ?", size, extra.downloadCount ?? 0, extra.updatedAt ?? now(), id);
    this.repo.storageChanged();
    return toAsset(this.sql.exec<AssetRow>("SELECT * FROM release_assets WHERE id = ?", id).one());
  }

  abortAsset(id: number): void {
    this.sql.exec("DELETE FROM release_assets WHERE id = ? AND state != 'uploaded'", id);
  }

  /** Where to read an asset's bytes from; counts the download. */
  download(spec: { assetId: number } | { tag: string; name: string }, caller: Caller): { r2Key: string; name: string; contentType: string; size: number } {
    let a: AssetRow | undefined;
    if ("assetId" in spec) a = this.assetRow(spec.assetId, caller);
    else {
      const drafts = atLeast(caller.role, "write") ? "" : "AND r.draft = 0";
      a = this.sql
        .exec<AssetRow>(`SELECT a.* FROM release_assets a JOIN releases r ON r.id = a.release_id WHERE r.tag_name = ? AND a.name = ? AND a.state = 'uploaded' ${drafts} ORDER BY r.draft, r.id DESC LIMIT 1`, spec.tag, spec.name)
        .toArray()[0];
      if (!a) throw new HttpError(404, "asset not found");
    }
    this.sql.exec("UPDATE release_assets SET download_count = download_count + 1 WHERE id = ?", a.id);
    return { r2Key: a.r2_key, name: a.name, contentType: a.content_type, size: a.size };
  }

  // ---------------------------------------------------------------- import (used by the GitHub importer)

  /**
   * Insert a release with its original dates and author, without creating
   * tags, firing webhooks or starting workflows. Returns the release id, and
   * whether it is new: the row records the import that wrote it, and the same
   * release (tag and creation date) from the same import is updated in place, so
   * a retried step or import never duplicates it.
   */
  importRelease(input: ImportedRelease, caller: Caller): { id: number; created: boolean } {
    this.requireWrite(caller);
    const tag = input.tag_name?.trim();
    if (!tag) throw new HttpError(422, "tag_name is required");
    const created = new Date(input.created_at);
    if (Number.isNaN(created.getTime())) throw new HttpError(422, "created_at must be an ISO 8601 date");
    const draft = !!input.draft;
    const published = draft ? null : (input.published_at ?? input.created_at);
    const author = input.author ?? { login: caller.login };
    const importId = caller.importId ?? null;
    const values = [
      input.target_commitish || this.repo.meta.defaultBranch,
      input.name ?? "",
      input.body ?? "",
      draft ? 1 : 0,
      input.prerelease ? 1 : 0,
      author.id ?? `imported:${author.login}`,
      author.login,
      author.kind ?? "user",
      published,
      published ?? created.toISOString(),
    ];
    const existing = importId ? this.sql.exec<{ id: number }>("SELECT id FROM releases WHERE imported = ? AND tag_name = ? AND created_at = ?", importId, tag, created.toISOString()).toArray()[0] : undefined;
    let id: number;
    if (existing) {
      id = existing.id;
      this.sql.exec("UPDATE releases SET target_commitish = ?, name = ?, body = ?, draft = ?, prerelease = ?, author_id = ?, author_login = ?, author_kind = ?, published_at = ?, updated_at = ? WHERE id = ?", ...values, id);
    } else {
      this.sql.exec(
        "INSERT INTO releases (target_commitish, name, body, draft, prerelease, author_id, author_login, author_kind, published_at, updated_at, tag_name, created_at, imported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ...values,
        tag,
        created.toISOString(),
        importId,
      );
      id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;
    }
    if (input.latest && !draft && !input.prerelease) this.pin(id);
    return { id, created: !existing };
  }

  /**
   * Attach an asset to an imported release, from bytes staged in R2 or from a URL.
   *
   * A staged object must be under `repos/<id>/import/`. Its bytes are copied to
   * the asset's own key and the staged copy is removed, so deleting the asset
   * later can never delete anything else.
   *
   * A URL must be https on GitHub's hosts (or IMPORT_GHE_HOST). Redirects are
   * followed by hand and checked the same way; credential headers are dropped
   * as soon as a redirect leaves the original host. The body is streamed to R2
   * and counted, up to 2 GiB.
   */
  async importAsset(releaseId: number, meta: ImportedAsset, source: { r2Key: string } | { url: string; headers?: Record<string, string> }, caller: Caller): Promise<ReleaseAsset> {
    const uploader = meta.uploader ? { id: meta.uploader.id ?? `imported:${meta.uploader.login}`, login: meta.uploader.login, kind: meta.uploader.kind ?? "user" } : undefined;
    // A retried import finds the assets it already copied: keep them rather than failing on the name.
    this.requireWrite(caller);
    const done = this.sql.exec<AssetRow>("SELECT * FROM release_assets WHERE release_id = ? AND name = ? AND state = 'uploaded'", releaseId, assetName(meta.name ?? "")).toArray()[0];
    if (done) return toAsset(done);
    if ("r2Key" in source) {
      const staging = `repos/${this.repo.meta.repoId}/import/`;
      if (typeof source.r2Key !== "string" || !source.r2Key.startsWith(staging) || source.r2Key.includes("..")) throw new HttpError(422, `r2Key must be under ${staging}`);
      const obj = await this.env.BUCKET.get(source.r2Key);
      if (!obj) throw new HttpError(422, "r2Key does not exist");
      if (obj.size > MAX_IMPORT_BYTES) {
        await obj.body.cancel();
        throw new HttpError(413, "asset is too large to import");
      }
      const { id, r2Key } = await this.startAsset(releaseId, { name: meta.name, label: meta.label, contentType: meta.content_type, size: obj.size }, caller, { createdAt: meta.created_at, uploader });
      try {
        const fixed = new FixedLengthStream(obj.size);
        await Promise.all([obj.body.pipeTo(fixed.writable), this.env.BUCKET.put(r2Key, fixed.readable, { httpMetadata: obj.httpMetadata })]);
      } catch (e) {
        this.abortAsset(id);
        await this.deleteObjects([r2Key]);
        throw e;
      }
      await this.env.BUCKET.delete(source.r2Key).catch(() => undefined);
      return this.finishAsset(id, obj.size, { downloadCount: meta.download_count, updatedAt: meta.updated_at });
    }
    const allowed = (raw: string) => isPublicHttpsUrl(raw) && importHostAllowed(new URL(raw).hostname, this.env.IMPORT_GHE_HOST);
    const startHost = (() => {
      try {
        return new URL(source.url).host;
      } catch {
        return "";
      }
    })();
    let res: Response | null = null;
    // GitHub's asset host answers some downloads in a large release with a 5xx (or 429): try those again.
    for (let attempt = 0; attempt < ASSET_DOWNLOAD_TRIES; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * 3 ** (attempt - 1)));
      let url = source.url;
      let headers = { ...(source.headers ?? {}) };
      res = null;
      for (let hop = 0; hop < 5; hop++) {
        if (!allowed(url)) throw new HttpError(422, "asset URL must be an https URL on github.com, its asset hosts, or the configured GitHub Enterprise host");
        res = await fetch(url, { headers, redirect: "manual" });
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.body?.cancel();
          const next = new URL(loc, url);
          if (next.host !== startHost) headers = withoutCredentials(headers);
          url = next.toString();
          res = null;
          continue;
        }
        break;
      }
      if (!res || !(res.status >= 500 || res.status === 429) || attempt === ASSET_DOWNLOAD_TRIES - 1) break;
      await res.body?.cancel();
    }
    if (!res || !res.ok || !res.body) {
      await res?.body?.cancel();
      throw new HttpError(502, `could not download asset: HTTP ${res?.status ?? "redirect loop"}`);
    }
    const body = res.body;
    const length = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(length) && length > MAX_IMPORT_BYTES) {
      await body.cancel();
      throw new HttpError(413, "asset is too large to import");
    }
    const { id, r2Key } = await this.startAsset(releaseId, { name: meta.name, label: meta.label, contentType: meta.content_type ?? res.headers.get("content-type") ?? undefined, size: Number.isFinite(length) ? length : undefined }, caller, { createdAt: meta.created_at, uploader });
    try {
      let size: number;
      if (Number.isFinite(length) && length >= 0) {
        // FixedLengthStream fails the upload if the body is longer or shorter than announced.
        const fixed = new FixedLengthStream(length);
        await Promise.all([body.pipeTo(fixed.writable), this.env.BUCKET.put(r2Key, fixed.readable)]);
        size = length;
      } else {
        const sink = new R2Sink(this.env.BUCKET, r2Key, "application/octet-stream", MAX_IMPORT_BYTES, "asset is too large to import");
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await sink.write(value);
          }
          size = await sink.close();
        } catch (e) {
          await reader.cancel().catch(() => undefined);
          await sink.abort();
          throw e;
        }
      }
      return this.finishAsset(id, size, { downloadCount: meta.download_count, updatedAt: meta.updated_at });
    } catch (e) {
      this.abortAsset(id);
      await this.deleteObjects([r2Key]);
      throw e;
    }
  }
}

function makeLatest(v: ReleaseInput["make_latest"]): MakeLatest | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === "true") return "true";
  if (v === false || v === "false") return "false";
  if (v === "legacy") return "legacy";
  throw new HttpError(422, "make_latest must be true, false or legacy", { errors: [{ resource: "Release", code: "invalid", field: "make_latest" }] });
}
