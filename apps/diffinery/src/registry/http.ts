import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { checkStorageQuota, storageHeadroom } from "../lib/quotas.js";
import { allows, packageAccess, type PackageAccess, type PackageRole } from "./access.js";
import { DIGEST_RE, NAME_RE, RegistryStore, TAG_RE, manifestKey, type ManifestRow, type PackageRow, type UploadRow } from "./store.js";
import { UploadError, digestOf, discard, ingest } from "./upload.js";

/**
 * Container registry: the OCI distribution API (what `docker login/push/pull`, buildx,
 * containerd, podman, crane, oras and helm speak) at https://diffinery.com/v2/.
 *
 * Images are named diffinery.com/<owner>/<name>, like ghcr.io/<owner>/<name>. Sign in
 * with any username and a Diffinery token as the password, or a workflow's GITHUB_TOKEN.
 */
export const registry = new Hono<{ Bindings: Env; Variables: AppVars }>();

export const MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const INDEX_TYPES = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
const MAX_MANIFEST = 4 * 1024 * 1024;
const API_HEADERS = { "docker-distribution-api-version": "registry/2.0" };

export class RegistryError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function errorJson(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ errors: [{ code, message, detail: null }] }), { status, headers: { "content-type": "application/json", ...API_HEADERS, ...headers } });
}

const challenge = (c: AppContext) => ({ "www-authenticate": `Basic realm="${new URL(c.env.PUBLIC_URL).host}", charset="UTF-8"` });

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- routing

registry.all("/v2", (c) => c.redirect("/v2/", 301));

registry.all("/v2/*", async (c) => {
  try {
    const res = await route(c);
    for (const [k, v] of Object.entries(API_HEADERS)) res.headers.set(k, v);
    return res;
  } catch (e) {
    if (e instanceof RegistryError) return errorJson(e.status, e.code, e.message, e.status === 401 ? { ...challenge(c), ...e.headers } : e.headers);
    if (e instanceof UploadError) return errorJson(400, "BLOB_UPLOAD_INVALID", e.message);
    if (e instanceof HttpError) return errorJson(e.status, e.status === 401 ? "UNAUTHORIZED" : e.status === 403 ? "DENIED" : e.status === 404 ? "NAME_UNKNOWN" : "UNSUPPORTED", e.detail, e.status === 401 ? challenge(c) : {});
    console.error("registry error", c.req.method, c.req.path, e);
    return errorJson(500, "UNKNOWN", "internal error");
  }
});

async function route(c: AppContext): Promise<Response> {
  const path = c.req.path;
  const method = c.req.method;
  if (path === "/v2/") {
    if (c.get("principal").type === "anonymous") throw new RegistryError(401, "UNAUTHORIZED", "sign in with a Diffinery token: docker login " + new URL(c.env.PUBLIC_URL).host);
    return c.json({});
  }
  if (path === "/v2/_catalog") return catalog(c);
  let m: RegExpExecArray | null;
  if ((m = /^\/v2\/(.+)\/tags\/list$/.exec(path))) return tagsList(c, m[1]!);
  if ((m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(path))) {
    if (method === "GET" || method === "HEAD") return getManifest(c, m[1]!, m[2]!);
    if (method === "PUT") return putManifest(c, m[1]!, m[2]!);
    if (method === "DELETE") return deleteManifest(c, m[1]!, m[2]!);
  }
  if ((m = /^\/v2\/(.+)\/referrers\/([^/]+)$/.exec(path)) && method === "GET") return referrers(c, m[1]!, m[2]!);
  if ((m = /^\/v2\/(.+)\/blobs\/uploads\/?$/.exec(path)) && method === "POST") return startUpload(c, m[1]!);
  if ((m = /^\/v2\/(.+)\/blobs\/uploads\/([0-9a-f]{32})$/.exec(path))) {
    if (method === "GET") return uploadStatus(c, m[1]!, m[2]!);
    if (method === "PATCH") return patchUpload(c, m[1]!, m[2]!);
    if (method === "PUT") return putUpload(c, m[1]!, m[2]!);
    if (method === "DELETE") return cancelUpload(c, m[1]!, m[2]!);
  }
  if ((m = /^\/v2\/(.+)\/blobs\/([^/]+)$/.exec(path))) {
    if (method === "GET" || method === "HEAD") return getBlob(c, m[1]!, m[2]!);
    if (method === "DELETE") return deleteBlob(c, m[1]!, m[2]!);
  }
  throw new RegistryError(404, "UNSUPPORTED", `${method} ${path} is not part of the registry API`);
}

// ---------------------------------------------------------------- names and access

interface Target {
  /** The name as the client wrote it (owner/name), for Location headers. */
  full: string;
  owner: Account;
  name: string;
  pkg: PackageRow | null;
  access: PackageAccess;
  store: RegistryStore;
}

/** Splits <owner>/<name>, loads the package and checks the caller may `need` it. */
async function target(c: AppContext, full: string, need: PackageRole): Promise<Target> {
  const lower = full.toLowerCase();
  const slash = lower.indexOf("/");
  let name = slash > 0 ? lower.slice(slash + 1) : "";
  if (slash <= 0 || !NAME_RE.test(name) || lower.length > 255) {
    throw new RegistryError(400, "NAME_INVALID", `invalid image name "${full}": use ${new URL(c.env.PUBLIC_URL).host}/<owner>/<name> with lowercase letters, digits, '.', '_', '-' and '/'`);
  }
  const store = new RegistryStore(c.env);
  const dir = c.get("dir");
  const ownerLogin = lower.slice(0, slash);
  let owner = await dir.accountByLogin(ownerLogin);
  let pkg = owner && owner.kind !== "agent" ? await store.package(owner.id, name) : null;
  // An image that moved with its repository to another owner, or one under a renamed owner, answers
  // under its old name too. Access is the moved package's, so the old name never shows a private one.
  let moved = false;
  if (!pkg) {
    const found = await store.movedPackage(ownerLogin, name);
    const renamed = found ? null : await dir.renamedAccount(ownerLogin);
    const to = found ? await dir.account(found.owner_id) : renamed;
    if (to) {
      moved = true;
      owner = to;
      pkg = found ?? (await store.package(to.id, name));
    }
  }
  if (!owner || owner.kind === "agent") {
    if (c.get("principal").type === "anonymous") throw new RegistryError(401, "UNAUTHORIZED", "authentication required");
    throw new RegistryError(404, "NAME_UNKNOWN", `no user or organization named ${ownerLogin}`);
  }
  if (moved && pkg) name = pkg.name;
  const access = await packageAccess(c, owner, name, pkg);
  if (!allows(access.role, need)) {
    const anon = c.get("principal").type === "anonymous";
    if (anon) throw new RegistryError(401, "UNAUTHORIZED", "authentication required");
    if (moved && !allows(access.role, "pull")) throw new RegistryError(404, "NAME_UNKNOWN", `repository ${lower} not found`);
    if (!allows(access.role, "pull")) {
      if (need === "pull" || pkg) throw new RegistryError(404, "NAME_UNKNOWN", `repository ${owner.login}/${name} not found${access.hint ? ` (${access.hint})` : ""}`);
      throw new RegistryError(403, "DENIED", `you can't create ${owner.login}/${name}${access.hint ? `: ${access.hint}` : ""}`);
    }
    throw new RegistryError(403, "DENIED", `${need === "admin" ? "deleting from" : "pushing to"} ${owner.login}/${name} is not allowed${access.hint ? `: ${access.hint}` : ""}`);
  }
  return { full, owner, name, pkg, access, store };
}

/** The package, created on first push (linked to a repository when the access check found one). */
async function ensurePackage(c: AppContext, t: Target): Promise<PackageRow> {
  if (t.pkg) return t.pkg;
  const pkg = await t.store.createPackage(t.owner.id, t.name, t.access.linkRepo?.id ?? null, t.access.actor?.id ?? "unknown");
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: t.access.actor?.id, actorLogin: t.access.actor?.login, action: "package.create", target: `${t.owner.login}/${t.name}`, detail: { repository: t.access.linkRepo ? `${t.access.linkRepo.owner_login}/${t.access.linkRepo.name}` : null } })
      .catch((e) => console.error("audit failed", e)),
  );
  t.pkg = pkg;
  return pkg;
}

function requirePackage(t: Target): PackageRow {
  if (!t.pkg) throw new RegistryError(404, "NAME_UNKNOWN", `repository ${t.owner.login}/${t.name} not found`);
  return t.pkg;
}

// ---------------------------------------------------------------- blobs

async function getBlob(c: AppContext, full: string, digest: string): Promise<Response> {
  if (!DIGEST_RE.test(digest)) throw new RegistryError(400, "DIGEST_INVALID", "only sha256 digests are supported");
  const t = await target(c, full, "pull");
  const pkg = requirePackage(t);
  const blob = await t.store.packageBlob(pkg.id, digest);
  if (!blob) {
    // Manifests may be fetched through the blob endpoint too.
    const man = await t.store.manifest(pkg.id, digest);
    if (man) return manifestResponse(c, man, c.req.method === "HEAD");
    throw new RegistryError(404, "BLOB_UNKNOWN", `blob ${digest} not found`);
  }
  const headers: Record<string, string> = { "docker-content-digest": digest, "content-type": "application/octet-stream", etag: `"${digest}"`, "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(blob.size) } });
  const range = parseRange(c.req.header("range"), blob.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "content-range": `bytes */${blob.size}` } });
  const obj = await c.env.BUCKET.get(blob.r2_key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) throw new RegistryError(404, "BLOB_UNKNOWN", `blob ${digest} is missing from storage`);
  if (range) return new Response(obj.body, { status: 206, headers: { ...headers, "content-length": String(range.end - range.start + 1), "content-range": `bytes ${range.start}-${range.end}/${blob.size}` } });
  return new Response(obj.body, { status: 200, headers: { ...headers, "content-length": String(blob.size) } });
}

function parseRange(h: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

async function deleteBlob(c: AppContext, full: string, digest: string): Promise<Response> {
  if (!DIGEST_RE.test(digest)) throw new RegistryError(400, "DIGEST_INVALID", "only sha256 digests are supported");
  const t = await target(c, full, "admin");
  const pkg = requirePackage(t);
  if (!(await t.store.packageBlob(pkg.id, digest))) throw new RegistryError(404, "BLOB_UNKNOWN", `blob ${digest} not found`);
  await t.store.unlinkBlob(pkg.id, digest);
  return new Response(null, { status: 202 });
}

const uploadUrl = (t: Target, id: string) => `/v2/${t.full}/blobs/uploads/${id}`;

function uploadHeaders(t: Target, u: UploadRow): Record<string, string> {
  // Range can't tell an empty upload from a one-byte one, so the size is spelled out too.
  return { location: uploadUrl(t, u.id), range: `0-${Math.max(0, u.size - 1)}`, "docker-upload-uuid": u.id, "diffinery-upload-size": String(u.size), "content-length": "0" };
}

/** Refuse a blob past the owner's storage quota (lib/quotas.ts): `sofar` bytes uploaded, plus this request's. */
function checkStorage(c: AppContext, t: Target, sofar = 0): Promise<void> {
  return checkStorageQuota(c.env, t.owner.id, t.owner.login, sofar + (Number(c.req.header("content-length")) || 0));
}

/** The largest blob Diffinery stores (GitHub's container registry takes layers up to 10 GB). */
export const MAX_BLOB_BYTES = 10 * 1024 ** 3;

/** How big this upload may grow: the blob cap, and what is left of the owner's storage quota. */
async function uploadLimit(c: AppContext, t: Target): Promise<{ bytes: number; error: () => Error }> {
  const headroom = await storageHeadroom(c.env, t.owner.id);
  if (headroom < MAX_BLOB_BYTES) return { bytes: headroom, error: () => new HttpError(403, `${t.owner.login} has reached its storage limit (git objects, Git LFS objects, release assets and packages); delete some or ask a site administrator to raise it`) };
  return { bytes: MAX_BLOB_BYTES, error: () => new UploadError(`a blob may be at most ${MAX_BLOB_BYTES / 1024 ** 3} GiB`) };
}

/** Append this request's body within uploadLimit. Past it, ingest has thrown the bytes away and the upload is gone too. */
async function ingestCapped(c: AppContext, t: Target, u: UploadRow, final: boolean): Promise<UploadRow> {
  const limit = await uploadLimit(c, t);
  let over = false;
  try {
    return await ingest(c.env, u, c.req.raw.body, final, { bytes: limit.bytes, error: () => { over = true; return limit.error(); } });
  } catch (e) {
    if (over) await t.store.deleteUpload(u.id);
    throw e;
  }
}

async function startUpload(c: AppContext, full: string): Promise<Response> {
  const t = await target(c, full, "push");
  await checkStorage(c, t);
  const pkg = await ensurePackage(c, t);
  const mount = c.req.query("mount");
  const from = c.req.query("from");
  if (mount && DIGEST_RE.test(mount)) {
    // Cross-repository mount: reuse a blob the caller can already pull from another package.
    if (await t.store.packageBlob(pkg.id, mount)) return blobCreated(t, mount);
    if (from) {
      try {
        const src = await target(c, from, "pull");
        if (src.pkg && (await t.store.packageBlob(src.pkg.id, mount))) {
          await t.store.linkBlob(pkg.id, mount);
          return blobCreated(t, mount);
        }
      } catch (e) {
        if (!(e instanceof RegistryError)) throw e;
      }
    }
  }
  const u = await t.store.createUpload(pkg.id);
  const digest = c.req.query("digest");
  if (digest) {
    // Monolithic upload: the whole blob in the POST body.
    if (!DIGEST_RE.test(digest)) throw new RegistryError(400, "DIGEST_INVALID", "only sha256 digests are supported");
    return finishUpload(c, t, pkg, await ingestCapped(c, t, u, true), digest);
  }
  return new Response(null, { status: 202, headers: uploadHeaders(t, u) });
}

async function loadUpload(c: AppContext, full: string, id: string, need: PackageRole = "push"): Promise<{ t: Target; pkg: PackageRow; u: UploadRow }> {
  const t = await target(c, full, need);
  const pkg = requirePackage(t);
  const u = await t.store.upload(id);
  if (!u || u.package_id !== pkg.id) throw new RegistryError(404, "BLOB_UPLOAD_UNKNOWN", "upload not found; it may have expired");
  return { t, pkg, u };
}

async function uploadStatus(c: AppContext, full: string, id: string): Promise<Response> {
  const { t, u } = await loadUpload(c, full, id);
  return new Response(null, { status: 204, headers: uploadHeaders(t, u) });
}

function checkContentRange(c: AppContext, t: Target, u: UploadRow): void {
  const cr = c.req.header("content-range");
  if (!cr) return;
  const m = /^(?:bytes[ =])?(\d+)-(\d+)(?:\/\d+|\/\*)?$/.exec(cr.trim());
  if (!m || Number(m[1]) !== u.size) throw new RegistryError(416, "BLOB_UPLOAD_INVALID", `chunk must start at byte ${u.size}`, uploadHeaders(t, u));
}

async function patchUpload(c: AppContext, full: string, id: string): Promise<Response> {
  const { t, u } = await loadUpload(c, full, id);
  checkContentRange(c, t, u);
  await checkStorage(c, t, u.size);
  const next = await ingestCapped(c, t, u, false);
  await t.store.saveUpload(next);
  return new Response(null, { status: 202, headers: uploadHeaders(t, next) });
}

async function putUpload(c: AppContext, full: string, id: string): Promise<Response> {
  const { t, pkg, u } = await loadUpload(c, full, id);
  const digest = c.req.query("digest");
  if (!digest || !DIGEST_RE.test(digest)) throw new RegistryError(400, "DIGEST_INVALID", "the digest query parameter must be a sha256 digest");
  if (c.req.raw.body) checkContentRange(c, t, u);
  await checkStorage(c, t, u.size);
  return finishUpload(c, t, pkg, await ingestCapped(c, t, u, true), digest);
}

async function cancelUpload(c: AppContext, full: string, id: string): Promise<Response> {
  const { t, u } = await loadUpload(c, full, id);
  await discard(c.env, u);
  await t.store.deleteUpload(u.id);
  return new Response(null, { status: 204 });
}

/** Verifies a completed upload against its digest and adds it to the package. */
async function finishUpload(c: AppContext, t: Target, pkg: PackageRow, u: UploadRow, expected: string): Promise<Response> {
  let actual = u.digest;
  if (!actual) actual = (await digestOf(c.env, u.r2_key))?.digest ?? null;
  if (actual !== expected) {
    await discard(c.env, u);
    await t.store.deleteUpload(u.id);
    throw new RegistryError(400, "DIGEST_INVALID", `the uploaded content has digest ${actual ?? "unknown"}, not ${expected}`);
  }
  await t.store.addBlob(expected, u.size, u.r2_key);
  await t.store.linkBlob(pkg.id, expected);
  // Linked now, so cleanup can't drop the index row; if another upload already stored these bytes, ours go.
  const stored = await t.store.blob(expected);
  if (!stored) await t.store.addBlob(expected, u.size, u.r2_key);
  else if (stored.r2_key !== u.r2_key) await c.env.BUCKET.delete(u.r2_key);
  await t.store.deleteUpload(u.id);
  return blobCreated(t, expected);
}

function blobCreated(t: Target, digest: string): Response {
  return new Response(null, { status: 201, headers: { location: `/v2/${t.full}/blobs/${digest}`, "docker-content-digest": digest, "content-length": "0" } });
}

// ---------------------------------------------------------------- manifests

async function resolveReference(t: Target, pkg: PackageRow, reference: string): Promise<ManifestRow | null> {
  if (DIGEST_RE.test(reference)) return t.store.manifest(pkg.id, reference);
  if (!TAG_RE.test(reference)) throw new RegistryError(400, "MANIFEST_INVALID", `invalid tag "${reference}"`);
  const digest = await t.store.tagDigest(pkg.id, reference);
  return digest ? t.store.manifest(pkg.id, digest) : null;
}

async function manifestResponse(c: AppContext, m: ManifestRow, head: boolean): Promise<Response> {
  const headers: Record<string, string> = { "content-type": m.media_type, "docker-content-digest": m.digest, etag: `"${m.digest}"`, "content-length": String(m.size) };
  if (head) return new Response(null, { status: 200, headers });
  const obj = await c.env.BUCKET.get(manifestKey(m.digest));
  if (!obj) throw new RegistryError(404, "MANIFEST_UNKNOWN", `manifest ${m.digest} is missing from storage`);
  return new Response(obj.body, { status: 200, headers });
}

async function getManifest(c: AppContext, full: string, reference: string): Promise<Response> {
  const t = await target(c, full, "pull");
  const pkg = requirePackage(t);
  const m = await resolveReference(t, pkg, reference);
  if (!m) throw new RegistryError(404, "MANIFEST_UNKNOWN", `manifest ${reference} not found in ${t.owner.login}/${t.name}`);
  return manifestResponse(c, m, c.req.method === "HEAD");
}

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  urls?: string[];
  artifactType?: string;
  annotations?: Record<string, string>;
  platform?: { os?: string; architecture?: string; variant?: string };
}

interface ManifestJson {
  schemaVersion?: number;
  mediaType?: string;
  artifactType?: string;
  config?: Descriptor;
  layers?: Descriptor[];
  blobs?: Descriptor[];
  manifests?: Descriptor[];
  subject?: Descriptor;
  annotations?: Record<string, string>;
}

const platformName = (p?: Descriptor["platform"]) => (p?.os && p.architecture ? `${p.os}/${p.architecture}${p.variant ? `/${p.variant}` : ""}` : null);

async function putManifest(c: AppContext, full: string, reference: string): Promise<Response> {
  const t = await target(c, full, "push");
  const isDigest = DIGEST_RE.test(reference);
  if (!isDigest && !TAG_RE.test(reference)) throw new RegistryError(400, "MANIFEST_INVALID", `invalid tag "${reference}"`);
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_MANIFEST) throw new RegistryError(413, "MANIFEST_INVALID", "manifests are limited to 4 MiB");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MAX_MANIFEST) throw new RegistryError(413, "MANIFEST_INVALID", "manifests are limited to 4 MiB");
  const digest = `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
  if (isDigest && reference !== digest) throw new RegistryError(400, "DIGEST_INVALID", `the manifest's digest is ${digest}, not ${reference}`);
  let json: ManifestJson;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as ManifestJson;
  } catch {
    throw new RegistryError(400, "MANIFEST_INVALID", "the manifest is not valid JSON");
  }
  if (typeof json !== "object" || json === null || json.schemaVersion !== 2) throw new RegistryError(400, "MANIFEST_INVALID", "only schemaVersion 2 manifests (OCI or Docker v2) are supported");
  const header = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
  const mediaType = json.mediaType || (MANIFEST_TYPES.has(header) ? header : json.manifests ? "application/vnd.oci.image.index.v1+json" : "application/vnd.oci.image.manifest.v1+json");
  if (!MANIFEST_TYPES.has(mediaType)) throw new RegistryError(400, "MANIFEST_INVALID", `unsupported manifest media type ${mediaType}`);
  if (json.mediaType && MANIFEST_TYPES.has(header) && header !== json.mediaType) throw new RegistryError(400, "MANIFEST_INVALID", `Content-Type ${header} does not match the manifest's mediaType ${json.mediaType}`);

  const pkg = await ensurePackage(c, t);
  const isIndex = INDEX_TYPES.has(mediaType);
  let totalSize = 0;
  let platforms: Array<{ digest?: string; platform: string | null }> = [];
  const blobRefs: string[] = [];
  if (isIndex) {
    const children = (json.manifests ?? []).filter((d) => d.digest && DIGEST_RE.test(d.digest));
    if (children.length !== (json.manifests ?? []).length) throw new RegistryError(400, "MANIFEST_INVALID", "every entry in manifests needs a sha256 digest");
    const have = await t.store.manifestSizes(pkg.id, children.map((d) => d.digest!));
    const missing = children.find((d) => !have.has(d.digest!));
    if (missing) throw new RegistryError(400, "MANIFEST_BLOB_UNKNOWN", `manifest ${missing.digest} must be pushed before the index that lists it`);
    platforms = children.map((d) => ({ digest: d.digest, platform: platformName(d.platform) }));
    // What pulling every platform downloads; attestations and other artifacts don't count.
    totalSize = children.filter((d) => platformName(d.platform) !== "unknown/unknown").reduce((n, d) => n + (have.get(d.digest!) ?? 0), 0);
  } else {
    const descs = [...(json.config ? [json.config] : []), ...(json.layers ?? []), ...(json.blobs ?? [])];
    if (!json.config?.digest) throw new RegistryError(400, "MANIFEST_INVALID", "an image manifest needs a config descriptor");
    const local = descs.filter((d) => !d.urls?.length);
    for (const d of local) if (!d.digest || !DIGEST_RE.test(d.digest)) throw new RegistryError(400, "MANIFEST_INVALID", "every config and layer needs a sha256 digest");
    const digests = [...new Set(local.map((d) => d.digest!))];
    const have = await t.store.packageBlobs(pkg.id, digests);
    const missing = digests.find((d) => !have.has(d));
    if (missing) throw new RegistryError(400, "MANIFEST_BLOB_UNKNOWN", `blob ${missing} must be uploaded before the manifest that uses it`);
    blobRefs.push(...digests);
    totalSize = descs.reduce((n, d) => n + (d.size ?? 0), 0);
    const config = await readConfig(c, json.config);
    if (config) {
      platforms = [{ platform: platformName(config) }];
      await linkBySourceLabel(c, t, pkg, config.config?.Labels ?? {});
      const desc = config.config?.Labels?.["org.opencontainers.image.description"];
      if (desc && !pkg.description) await t.store.updatePackage(pkg.id, { description: desc.slice(0, 500) });
    }
  }
  const desc = json.annotations?.["org.opencontainers.image.description"];
  if (desc && !pkg.description) await t.store.updatePackage(pkg.id, { description: desc.slice(0, 500) });
  if (json.annotations?.["org.opencontainers.image.source"]) await linkBySourceLabel(c, t, pkg, json.annotations);

  const key = manifestKey(digest);
  if (!(await c.env.BUCKET.head(key))) await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mediaType } });
  const subject = json.subject?.digest && DIGEST_RE.test(json.subject.digest) ? json.subject.digest : null;
  await t.store.putManifest(
    {
      package_id: pkg.id,
      digest,
      media_type: mediaType,
      artifact_type: json.artifactType ?? (json.config?.mediaType && json.config.mediaType !== "application/vnd.oci.image.config.v1+json" && json.config.mediaType !== "application/vnd.docker.container.image.v1+json" ? json.config.mediaType : null),
      subject,
      annotations: json.annotations ? JSON.stringify(json.annotations) : null,
      size: bytes.length,
      total_size: totalSize,
      platforms: platforms.length ? JSON.stringify(platforms) : null,
      pushed_by: t.access.actor?.login ?? null,
      created_at: new Date().toISOString(),
    },
    isDigest ? null : reference,
    blobRefs,
  );
  if (!isDigest) {
    c.executionCtx.waitUntil(
      c
        .get("dir")
        .audit({ actorId: t.access.actor?.id, actorLogin: t.access.actor?.login, action: "package.push", target: `${t.owner.login}/${t.name}:${reference}`, detail: { digest } })
        .catch((e) => console.error("audit failed", e)),
    );
  }
  const headers: Record<string, string> = { location: `/v2/${t.full}/manifests/${digest}`, "docker-content-digest": digest, "content-length": "0" };
  if (subject) headers["oci-subject"] = subject;
  return new Response(null, { status: 201, headers });
}

interface ImageConfig {
  os?: string;
  architecture?: string;
  variant?: string;
  config?: { Labels?: Record<string, string> | null };
}

/** The image config (platform and labels), when it's a small JSON blob in this registry. */
async function readConfig(c: AppContext, d: Descriptor): Promise<ImageConfig | null> {
  if (d.mediaType && d.mediaType !== "application/vnd.oci.image.config.v1+json" && d.mediaType !== "application/vnd.docker.container.image.v1+json") return null;
  if (!d.digest || (d.size ?? 0) > 1024 * 1024) return null;
  const blob = await new RegistryStore(c.env).blob(d.digest);
  if (!blob) return null;
  const obj = await c.env.BUCKET.get(blob.r2_key);
  if (!obj) return null;
  try {
    const cfg = (await obj.json()) as ImageConfig;
    return { os: cfg.os, architecture: cfg.architecture, variant: cfg.variant, config: { Labels: cfg.config?.Labels ?? {} } };
  } catch {
    return null;
  }
}

/**
 * Links an unlinked package to the repository its org.opencontainers.image.source label
 * names (a Diffinery URL, or a GitHub URL of a repository moved here), when the pusher
 * can write to that repository. Like ghcr.io, the package then shares its permissions.
 */
async function linkBySourceLabel(c: AppContext, t: Target, pkg: PackageRow, labels: Record<string, string>): Promise<void> {
  if (pkg.repo_id) return;
  const src = labels["org.opencontainers.image.source"];
  if (!src) return;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return;
  }
  const ours = new URL(c.env.PUBLIC_URL).host;
  if (url.host !== ours && url.host !== "github.com") return;
  const [owner, repoName] = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (!owner || !repoName || owner.toLowerCase() !== t.owner.login.toLowerCase()) return;
  const repo = await c.get("dir").repo(t.owner.login, repoName);
  if (!repo) return;
  const p = c.get("principal");
  let canWrite = false;
  if (p.type === "repo-token") canWrite = p.repoId === repo.id && allows(t.access.role, "push");
  else if (p.type === "account") {
    const r = await c.get("dir").roleFor(p.account, repo);
    canWrite = !!r && ["write", "maintain", "admin"].includes(r);
  }
  if (!canWrite) return;
  await t.store.updatePackage(pkg.id, { repoId: repo.id });
  pkg.repo_id = repo.id;
  pkg.repo_name = repo.name;
}

async function deleteManifest(c: AppContext, full: string, reference: string): Promise<Response> {
  const t = await target(c, full, "admin");
  const pkg = requirePackage(t);
  if (DIGEST_RE.test(reference)) {
    if (!(await t.store.deleteManifest(pkg.id, reference))) throw new RegistryError(404, "MANIFEST_UNKNOWN", `manifest ${reference} not found`);
  } else {
    if (!TAG_RE.test(reference)) throw new RegistryError(400, "MANIFEST_INVALID", `invalid tag "${reference}"`);
    if (!(await t.store.deleteTag(pkg.id, reference))) throw new RegistryError(404, "MANIFEST_UNKNOWN", `tag ${reference} not found`);
  }
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: t.access.actor?.id, actorLogin: t.access.actor?.login, action: "package.delete_version", target: `${t.owner.login}/${t.name}@${reference}` })
      .catch((e) => console.error("audit failed", e)),
  );
  return new Response(null, { status: 202 });
}

async function referrers(c: AppContext, full: string, digest: string): Promise<Response> {
  if (!DIGEST_RE.test(digest)) throw new RegistryError(400, "DIGEST_INVALID", "only sha256 digests are supported");
  const t = await target(c, full, "pull");
  const pkg = requirePackage(t);
  const type = c.req.query("artifactType");
  let rows = await t.store.referrers(pkg.id, digest);
  if (type) rows = rows.filter((r) => r.artifact_type === type);
  const body = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: rows.map((r) => ({ mediaType: r.media_type, digest: r.digest, size: r.size, ...(r.artifact_type ? { artifactType: r.artifact_type } : {}), ...(r.annotations ? { annotations: JSON.parse(r.annotations) } : {}) })),
  };
  const headers: Record<string, string> = { "content-type": "application/vnd.oci.image.index.v1+json" };
  if (type) headers["oci-filters-applied"] = "artifactType";
  return new Response(JSON.stringify(body), { status: 200, headers });
}

// ---------------------------------------------------------------- listing

async function tagsList(c: AppContext, full: string): Promise<Response> {
  const t = await target(c, full, "pull");
  const pkg = requirePackage(t);
  const nq = c.req.query("n");
  const n = nq === undefined ? undefined : Math.max(0, Math.min(Number(nq) || 0, 10000));
  const last = c.req.query("last");
  const tags = await t.store.tags(pkg.id, { n: n === undefined ? undefined : n + 1, last });
  const page = n === undefined ? tags : tags.slice(0, n);
  const headers: Record<string, string> = {};
  if (n !== undefined && tags.length > n && page.length) headers.link = `</v2/${t.full}/tags/list?n=${n}&last=${encodeURIComponent(page[page.length - 1]!)}>; rel="next"`;
  return c.json({ name: `${t.owner.login}/${t.name}`, tags: page }, 200, headers);
}

async function catalog(c: AppContext): Promise<Response> {
  const p = c.get("principal");
  if (p.type === "anonymous") throw new RegistryError(401, "UNAUTHORIZED", "authentication required");
  const dir = c.get("dir");
  const store = new RegistryStore(c.env);
  let rows: PackageRow[];
  if (p.type === "account" && p.account.site_admin && !p.repoIds) rows = await store.packages({ all: true, limit: 5000 });
  else if (p.type === "account") {
    const subject = p.account.kind === "agent" ? p.account.owner_id! : p.account.id;
    const orgs = (await dir.orgsFor(subject)).map((o) => o.id);
    const repos = (await dir.reposVisibleTo(p.account)).map((r) => r.id);
    rows = await store.packages({ ownerIds: p.repoIds ? [] : [subject, ...orgs], repoIds: p.repoIds ?? repos, limit: 5000 });
    // An organization's packages linked to a repository are listed only to those who can see it.
    const seen = new Set(repos);
    rows = rows.filter((r) => r.owner_id === subject || !r.repo_id || seen.has(r.repo_id));
  } else if (p.type === "repo-token") {
    const repo = await dir.repoById(p.repoId);
    rows = repo ? await store.packages({ ownerIds: [repo.owner_id], limit: 5000 }) : [];
  } else rows = [];
  const names = rows.map((r) => `${r.owner_login.toLowerCase()}/${r.name}`).sort();
  const nq = c.req.query("n");
  const last = c.req.query("last");
  let page = last ? names.filter((x) => x > last) : names;
  const headers: Record<string, string> = {};
  if (nq !== undefined) {
    const n = Math.max(0, Number(nq) || 0);
    if (page.length > n && n > 0) headers.link = `</v2/_catalog?n=${n}&last=${encodeURIComponent(page[n - 1]!)}>; rel="next"`;
    page = page.slice(0, n);
  }
  return c.json({ repositories: page }, 200, headers);
}
