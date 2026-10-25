import type { Env } from "../env.js";
import { newId, now } from "../lib/util.js";

/** A container image name below an owner: diffinery.com/<owner_login>/<name>. */
export interface PackageRow {
  id: string;
  owner_id: string;
  owner_login: string;
  owner_kind: "user" | "org" | "agent";
  name: string;
  repo_id: string | null;
  repo_name: string | null;
  visibility: "private" | "public";
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManifestRow {
  /** rowid, used as the numeric version id in the REST API. */
  id?: number;
  package_id: string;
  digest: string;
  media_type: string;
  artifact_type: string | null;
  subject: string | null;
  annotations: string | null;
  size: number;
  total_size: number;
  platforms: string | null;
  pushed_by: string | null;
  created_at: string;
}

export interface UploadRow {
  id: string;
  package_id: string;
  r2_key: string;
  multipart_id: string | null;
  parts: string;
  size: number;
  tail: number;
  digest: string | null;
  /** SHA-256 progress over the bytes so far (lib/sha256.ts), null once finished or for older uploads. */
  hash_state: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlobRow {
  digest: string;
  size: number;
  r2_key: string;
  created_at: string;
}

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** OCI repository path components below the owner, lowercase only. */
export const NAME_RE = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

export const manifestKey = (digest: string) => `registry/manifests/${digest.replace(":", "/")}`;
export const blobKey = (uploadId: string) => `registry/blobs/${uploadId}`;
export const tailKey = (uploadId: string) => `registry/uploads/${uploadId}/tail`;

const PKG_SELECT = "SELECT p.*, a.login AS owner_login, a.kind AS owner_kind, r.name AS repo_name FROM packages p JOIN accounts a ON a.id = p.owner_id LEFT JOIN repos r ON r.id = p.repo_id";

/** The registry's index in D1. Bytes live in R2 under registry/. */
export class RegistryStore {
  constructor(private env: Env) {}

  private get db() {
    return this.env.DB;
  }

  // ---------------------------------------------------------------- packages

  async package(ownerId: string, name: string): Promise<PackageRow | null> {
    return this.db.prepare(`${PKG_SELECT} WHERE p.owner_id = ? AND p.name = ?`).bind(ownerId, name).first<PackageRow>();
  }

  async packageById(id: string): Promise<PackageRow | null> {
    return this.db.prepare(`${PKG_SELECT} WHERE p.id = ?`).bind(id).first<PackageRow>();
  }

  /** A package that moved to another owner with its repository, by its old <owner>/<name> (see migrations/0011_redirects.sql). */
  async movedPackage(ownerLogin: string, name: string): Promise<PackageRow | null> {
    const r = await this.db.prepare("SELECT package_id FROM package_redirects WHERE owner_login = ? AND name = ?").bind(ownerLogin, name).first<{ package_id: string }>();
    return r ? this.packageById(r.package_id) : null;
  }

  /** Creates the package unless a concurrent push just did; returns it either way. */
  async createPackage(ownerId: string, name: string, repoId: string | null, createdBy: string): Promise<PackageRow> {
    const t = now();
    await this.db
      .prepare("INSERT INTO packages (id, owner_id, name, repo_id, visibility, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'private', ?, ?, ?) ON CONFLICT(owner_id, name) DO NOTHING")
      .bind(newId(), ownerId, name, repoId, createdBy, t, t)
      .run();
    return (await this.package(ownerId, name))!;
  }

  async packages(filter: { ownerIds?: string[]; repoIds?: string[]; repoId?: string; all?: boolean; limit?: number }): Promise<Array<PackageRow & { tag_count: number; version_count: number }>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.repoId) {
      where.push("p.repo_id = ?");
      params.push(filter.repoId);
    } else if (!filter.all) {
      const ors: string[] = [];
      if (filter.ownerIds?.length) {
        ors.push(`p.owner_id IN (${filter.ownerIds.map(() => "?").join(",")})`);
        params.push(...filter.ownerIds);
      }
      if (filter.repoIds?.length) {
        ors.push(`p.repo_id IN (${filter.repoIds.map(() => "?").join(",")})`);
        params.push(...filter.repoIds);
      }
      ors.push("p.visibility = 'public'");
      where.push(`(${ors.join(" OR ")})`);
    }
    const q = `SELECT p.*, a.login AS owner_login, a.kind AS owner_kind, r.name AS repo_name,
        (SELECT count(*) FROM package_tags t WHERE t.package_id = p.id) AS tag_count,
        (SELECT count(*) FROM package_manifests m WHERE m.package_id = p.id) AS version_count
      FROM packages p JOIN accounts a ON a.id = p.owner_id LEFT JOIN repos r ON r.id = p.repo_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.updated_at DESC LIMIT ?`;
    params.push(filter.limit ?? 500);
    return (await this.db.prepare(q).bind(...params).all<PackageRow & { tag_count: number; version_count: number }>()).results;
  }

  async updatePackage(id: string, patch: { visibility?: PackageRow["visibility"]; repoId?: string | null; description?: string | null }): Promise<void> {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now()];
    if (patch.visibility) {
      sets.push("visibility = ?");
      params.push(patch.visibility);
    }
    if (patch.repoId !== undefined) {
      sets.push("repo_id = ?");
      params.push(patch.repoId);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    await this.db.prepare(`UPDATE packages SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id).run();
  }

  async touchPackage(id: string): Promise<void> {
    await this.db.prepare("UPDATE packages SET updated_at = ? WHERE id = ?").bind(now(), id).run();
  }

  /** Deletes a package and everything it indexes; unreferenced bytes go at the next cleanup. */
  async deletePackage(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM package_tags WHERE package_id = ?").bind(id),
      this.db.prepare("DELETE FROM package_manifests WHERE package_id = ?").bind(id),
      this.db.prepare("DELETE FROM package_manifest_blobs WHERE package_id = ?").bind(id),
      this.db.prepare("DELETE FROM package_blobs WHERE package_id = ?").bind(id),
      this.db.prepare("DELETE FROM registry_uploads WHERE package_id = ?").bind(id),
      this.db.prepare("DELETE FROM packages WHERE id = ?").bind(id),
    ]);
  }

  // ---------------------------------------------------------------- blobs

  async blob(digest: string): Promise<BlobRow | null> {
    return this.db.prepare("SELECT * FROM registry_blobs WHERE digest = ?").bind(digest).first<BlobRow>();
  }

  /** The blob, if this package holds it. */
  async packageBlob(packageId: string, digest: string): Promise<BlobRow | null> {
    return this.db.prepare("SELECT b.* FROM package_blobs pb JOIN registry_blobs b ON b.digest = pb.digest WHERE pb.package_id = ? AND pb.digest = ?").bind(packageId, digest).first<BlobRow>();
  }

  async packageBlobs(packageId: string, digests: string[]): Promise<Set<string>> {
    if (!digests.length) return new Set();
    const found = new Set<string>();
    for (let i = 0; i < digests.length; i += 90) {
      const chunk = digests.slice(i, i + 90);
      const r = await this.db.prepare(`SELECT digest FROM package_blobs WHERE package_id = ? AND digest IN (${chunk.map(() => "?").join(",")})`).bind(packageId, ...chunk).all<{ digest: string }>();
      for (const x of r.results) found.add(x.digest);
    }
    return found;
  }

  /** Records a verified blob (keeping an existing copy if there is one) and returns the stored row. */
  async addBlob(digest: string, size: number, r2Key: string): Promise<BlobRow> {
    await this.db.prepare("INSERT INTO registry_blobs (digest, size, r2_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING").bind(digest, size, r2Key, now()).run();
    return (await this.blob(digest))!;
  }

  async linkBlob(packageId: string, digest: string): Promise<void> {
    await this.db.prepare("INSERT INTO package_blobs (package_id, digest, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(packageId, digest, now()).run();
  }

  async unlinkBlob(packageId: string, digest: string): Promise<void> {
    await this.db.prepare("DELETE FROM package_blobs WHERE package_id = ? AND digest = ?").bind(packageId, digest).run();
  }

  // ---------------------------------------------------------------- uploads

  async createUpload(packageId: string): Promise<UploadRow> {
    const id = newId();
    const t = now();
    const row: UploadRow = { id, package_id: packageId, r2_key: blobKey(id), multipart_id: null, parts: "[]", size: 0, tail: 0, digest: null, hash_state: null, created_at: t, updated_at: t };
    await this.db.prepare("INSERT INTO registry_uploads (id, package_id, r2_key, parts, size, tail, created_at, updated_at) VALUES (?, ?, ?, '[]', 0, 0, ?, ?)").bind(id, packageId, row.r2_key, t, t).run();
    return row;
  }

  async upload(id: string): Promise<UploadRow | null> {
    return this.db.prepare("SELECT * FROM registry_uploads WHERE id = ?").bind(id).first<UploadRow>();
  }

  async saveUpload(u: UploadRow): Promise<void> {
    await this.db
      .prepare("UPDATE registry_uploads SET multipart_id = ?, parts = ?, size = ?, tail = ?, digest = ?, hash_state = ?, updated_at = ? WHERE id = ?")
      .bind(u.multipart_id, u.parts, u.size, u.tail, u.digest, u.hash_state, now(), u.id)
      .run();
  }

  async deleteUpload(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM registry_uploads WHERE id = ?").bind(id).run();
  }

  // ---------------------------------------------------------------- manifests and tags

  async manifest(packageId: string, digest: string): Promise<ManifestRow | null> {
    return this.db.prepare("SELECT * FROM package_manifests WHERE package_id = ? AND digest = ?").bind(packageId, digest).first<ManifestRow>();
  }

  async tagDigest(packageId: string, tag: string): Promise<string | null> {
    return (await this.db.prepare("SELECT digest FROM package_tags WHERE package_id = ? AND tag = ?").bind(packageId, tag).first<{ digest: string }>())?.digest ?? null;
  }

  /** Which of these manifests the package holds, with the size of each one's content. */
  async manifestSizes(packageId: string, digests: string[]): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    for (let i = 0; i < digests.length; i += 90) {
      const chunk = digests.slice(i, i + 90);
      const r = await this.db.prepare(`SELECT digest, total_size FROM package_manifests WHERE package_id = ? AND digest IN (${chunk.map(() => "?").join(",")})`).bind(packageId, ...chunk).all<{ digest: string; total_size: number }>();
      for (const x of r.results) found.set(x.digest, x.total_size);
    }
    return found;
  }

  async putManifest(m: ManifestRow, tag: string | null, blobs: string[]): Promise<void> {
    const t = now();
    const stmts = [
      ...blobs.map((d) => this.db.prepare("INSERT INTO package_manifest_blobs (package_id, manifest, digest) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(m.package_id, m.digest, d)),
      this.db
        .prepare("INSERT INTO package_manifests (package_id, digest, media_type, artifact_type, subject, annotations, size, total_size, platforms, pushed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(package_id, digest) DO NOTHING")
        .bind(m.package_id, m.digest, m.media_type, m.artifact_type, m.subject, m.annotations, m.size, m.total_size, m.platforms, m.pushed_by, m.created_at),
      this.db.prepare("UPDATE packages SET updated_at = ? WHERE id = ?").bind(t, m.package_id),
    ];
    if (tag) stmts.push(this.db.prepare("INSERT INTO package_tags (package_id, tag, digest, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(package_id, tag) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at").bind(m.package_id, tag, m.digest, t));
    await this.db.batch(stmts);
  }

  async tags(packageId: string, opts: { n?: number; last?: string } = {}): Promise<string[]> {
    const r = await this.db
      .prepare("SELECT tag FROM package_tags WHERE package_id = ? AND tag > ? ORDER BY tag LIMIT ?")
      .bind(packageId, opts.last ?? "", Math.min(Math.max(opts.n ?? 10000, 0), 10000))
      .all<{ tag: string }>();
    return r.results.map((x) => x.tag);
  }

  async deleteTag(packageId: string, tag: string): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM package_tags WHERE package_id = ? AND tag = ?").bind(packageId, tag).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Deletes a manifest and the tags pointing at it. */
  async deleteManifest(packageId: string, digest: string): Promise<boolean> {
    const [, r] = await this.db.batch([
      this.db.prepare("DELETE FROM package_tags WHERE package_id = ? AND digest = ?").bind(packageId, digest),
      this.db.prepare("DELETE FROM package_manifests WHERE package_id = ? AND digest = ?").bind(packageId, digest),
      this.db.prepare("DELETE FROM package_manifest_blobs WHERE package_id = ? AND manifest = ?").bind(packageId, digest),
    ]);
    return (r!.meta.changes ?? 0) > 0;
  }

  async versionById(packageId: string, id: number): Promise<(ManifestRow & { tags: string[] }) | null> {
    const m = await this.db.prepare("SELECT rowid AS id, * FROM package_manifests WHERE package_id = ? AND rowid = ?").bind(packageId, id).first<ManifestRow>();
    if (!m) return null;
    const tags = (await this.db.prepare("SELECT tag FROM package_tags WHERE package_id = ? AND digest = ? ORDER BY tag").bind(packageId, m.digest).all<{ tag: string }>()).results.map((t) => t.tag);
    return { ...m, tags };
  }

  async referrers(packageId: string, subject: string): Promise<ManifestRow[]> {
    return (await this.db.prepare("SELECT * FROM package_manifests WHERE package_id = ? AND subject = ? ORDER BY created_at").bind(packageId, subject).all<ManifestRow>()).results;
  }

  /** Versions (manifests) with their tags, newest first. Children of multi-platform images are left out. */
  async versions(packageId: string, opts: { limit?: number; all?: boolean } = {}): Promise<Array<ManifestRow & { tags: string[] }>> {
    const manifests = (await this.db.prepare("SELECT rowid AS id, * FROM package_manifests WHERE package_id = ? ORDER BY created_at DESC LIMIT ?").bind(packageId, opts.limit ?? 1000).all<ManifestRow>()).results;
    const tags = (await this.db.prepare("SELECT tag, digest FROM package_tags WHERE package_id = ? ORDER BY updated_at DESC").bind(packageId).all<{ tag: string; digest: string }>()).results;
    const byDigest = new Map<string, string[]>();
    for (const t of tags) byDigest.set(t.digest, [...(byDigest.get(t.digest) ?? []), t.tag]);
    const children = new Set<string>();
    if (!opts.all) {
      for (const m of manifests) {
        for (const d of (m.platforms ? (JSON.parse(m.platforms) as Array<{ digest?: string }>) : []).map((p) => p.digest)) if (d) children.add(d);
        if (m.subject) children.add(m.digest);
      }
    }
    return manifests.filter((m) => byDigest.has(m.digest) || !children.has(m.digest)).map((m) => ({ ...m, tags: byDigest.get(m.digest) ?? [] }));
  }

  // ---------------------------------------------------------------- cleanup

  /**
   * Removes abandoned uploads and bytes nothing references any more. Runs from the
   * cron trigger; a grace period keeps blobs that a push in progress is about to use.
   */
  async cleanup(limit = 200): Promise<{ uploads: number; blobs: number; manifests: number }> {
    const day = new Date(Date.now() - 86400_000).toISOString();
    const stale = (await this.db.prepare("SELECT * FROM registry_uploads WHERE updated_at < ? LIMIT ?").bind(day, limit).all<UploadRow>()).results;
    for (const u of stale) {
      if (u.multipart_id) await this.env.BUCKET.resumeMultipartUpload(u.r2_key, u.multipart_id).abort().catch(() => {});
      await this.env.BUCKET.delete([u.r2_key, tailKey(u.id)]);
      await this.deleteUpload(u.id);
    }
    // Blobs a package holds that none of its manifests use any more (deleted versions, abandoned pushes).
    await this.db
      .prepare("DELETE FROM package_blobs WHERE rowid IN (SELECT pb.rowid FROM package_blobs pb WHERE pb.created_at < ? AND NOT EXISTS (SELECT 1 FROM package_manifest_blobs mb WHERE mb.package_id = pb.package_id AND mb.digest = pb.digest) LIMIT ?)")
      .bind(day, limit * 5)
      .run();
    // Blobs no package holds, past the grace period.
    const blobs = (await this.db.prepare("SELECT b.* FROM registry_blobs b WHERE b.created_at < ? AND NOT EXISTS (SELECT 1 FROM package_blobs pb WHERE pb.digest = b.digest) LIMIT ?").bind(day, limit).all<BlobRow>()).results;
    for (const b of blobs) {
      await this.db.prepare("DELETE FROM registry_blobs WHERE digest = ? AND NOT EXISTS (SELECT 1 FROM package_blobs pb WHERE pb.digest = ?)").bind(b.digest, b.digest).run();
      if (!(await this.blob(b.digest))) await this.env.BUCKET.delete(b.r2_key);
    }
    // Manifest bytes no package lists. They are tiny, so only the R2 listing costs anything; do a page per run.
    let manifests = 0;
    // A random shard each run, so every manifest gets looked at over time.
    const shard = [...crypto.getRandomValues(new Uint8Array(1))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const listed = await this.env.BUCKET.list({ prefix: `registry/manifests/sha256/${shard}`, limit: 500 });
    const old = listed.objects.filter((o) => o.uploaded.toISOString() < day);
    if (old.length) {
      const digests = old.map((o) => o.key.slice("registry/manifests/".length).replace("/", ":"));
      const inUse = new Set<string>();
      for (let i = 0; i < digests.length; i += 90) {
        const chunk = digests.slice(i, i + 90);
        const r = await this.db.prepare(`SELECT DISTINCT digest FROM package_manifests WHERE digest IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ digest: string }>();
        for (const x of r.results) inUse.add(x.digest);
      }
      const unused = old.filter((_, i) => !inUse.has(digests[i]!)).map((o) => o.key);
      if (unused.length) await this.env.BUCKET.delete(unused);
      manifests = unused.length;
    }
    return { uploads: stale.length, blobs: blobs.length, manifests };
  }
}
