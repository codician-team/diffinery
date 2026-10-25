import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { blockKey, chunkKey, compose, deleteKeys, finalKey, listStaged, parseBlockList, parseRange, sized, stagingPrefix, type BlobBucket, type ComposeStep } from "../lib/blob-store.js";
import { signBlobUrl, verifyBlobUrl, verifyRuntimeToken, type BlobRef, type RuntimeClaims } from "../lib/runtime-auth.js";
import { HttpError, newId } from "../lib/util.js";
import { headFirst } from "../lib/storage-keys.js";
import { MAX_UPLOAD_PART, artifactFileName, artifactObjectKeys, type ArtifactEntry, type CacheEntry } from "../repo/runtime.js";
import { auditRepo, loadRepo, repoStub } from "./common.js";
import { pageOf, paginate, setLinks } from "./gh.js";

/**
 * GitHub's Actions runtime services, so the official actions and the toolkit
 * (`@actions/cache`, `@actions/artifact`, buildkit's `type=gha` cache) work
 * against Diffinery unchanged:
 *
 * - Twirp `CacheService` (cache v2) and `ArtifactService` (artifacts v4) at
 *   `ACTIONS_RESULTS_URL`, and the legacy cache REST API at `ACTIONS_CACHE_URL`.
 *   All authenticate with the job's ACTIONS_RUNTIME_TOKEN and work only while
 *   that job runs (repo/runtime.ts decides what may be read or written).
 * - Signed blob URLs that speak the parts of Azure Blob Storage the clients use
 *   (Put Block, Put Block List, Put Blob, ranged GET), backed by R2.
 * - The REST API's artifacts and caches endpoints (`actionsRest`, under /api/v3).
 */
export const actionsRuntime = new Hono<{ Bindings: Env; Variables: AppVars }>();
export const actionsRest = new Hono<{ Bindings: Env; Variables: AppVars }>();

const READ_URL_TTL_S = 3600;
const ZIP = "application/zip";

const bucket = (env: Env) => env.BUCKET as unknown as BlobBucket;
const origin = (env: Env) => new URL(env.PUBLIC_URL).origin;
const nowS = () => Math.floor(Date.now() / 1000);

async function runtimeClaims(c: AppContext): Promise<RuntimeClaims> {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  const claims = m ? await verifyRuntimeToken(c.env, m[1]!) : null;
  if (!claims) throw new HttpError(401, "invalid or expired runtime token");
  return claims;
}

/** Status and message of an error thrown here or inside the Durable Object. */
function failure(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.detail };
  const msg = (e as Error)?.message ?? String(e);
  const m = /^(\d{3}): ([\s\S]*)$/.exec(msg);
  if (m) return { status: Number(m[1]), message: m[2]! };
  console.error(e);
  return { status: 500, message: "internal error" };
}

const readUrl = (env: Env, b: BlobRef, fileName?: string) => signBlobUrl(env, origin(env), b, "r", nowS() + READ_URL_TTL_S, fileName);

/**
 * A cache lookup whose object is really there. An entry whose object went missing
 * (or was replaced after it was committed) is dropped, and the lookup tries again.
 */
async function liveCacheHit(env: Env, claims: RuntimeClaims, keys: string[], version: string): Promise<CacheEntry | null> {
  const stub = repoStub(env, claims.repo);
  for (let i = 0; i < 5; i++) {
    const hit = await stub.rtCacheLookup(claims.job, keys, version);
    if (!hit) return null;
    const head = await env.BUCKET.head(finalKey({ repo: claims.repo, kind: "cache", id: hit.id }));
    if (head && (!hit.etag || head.etag === hit.etag)) return hit;
    await stub.rtCacheMissing(hit.id);
  }
  return null;
}

/** Composes an upload's staged pieces, each step in a Durable Object of its own (compose.ts, lib/blob-store.ts). */
function composeUpload(env: Env, b: BlobRef, segments: Array<{ key: string; size: number }>, contentType: string): Promise<number> {
  const stub = repoStub(env, b.repo);
  return compose(bucket(env), finalKey(b), segments, contentType, {
    scratch: stagingPrefix(b),
    run: (step: ComposeStep) => (env.COMPOSE ? env.COMPOSE.get(env.COMPOSE.newUniqueId()).step(b, step, contentType) : stub.rtComposeStep({ kind: b.kind, id: b.id }, step, contentType)),
  });
}

/** A request's declared length; null without Content-Length. */
function declaredLength(c: AppContext): number | null {
  const v = c.req.header("content-length");
  if (v === undefined) return null;
  if (!/^\d{1,15}$/.test(v)) throw new HttpError(400, "invalid Content-Length");
  return Number(v);
}

/** A small text body, refused past `max` bytes (with or without Content-Length). */
async function smallText(c: AppContext, max: number): Promise<string> {
  const len = declaredLength(c);
  if (len !== null && len > max) throw new HttpError(413, "the request body is too large");
  const body = c.req.raw.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "the request body is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.length;
  }
  return new TextDecoder().decode(out);
}

// ---------------------------------------------------------------- Twirp services

const TWIRP_CODES: Record<number, string> = { 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 404: "not_found", 409: "already_exists", 412: "failed_precondition", 429: "resource_exhausted" };

type TwirpRequest = Record<string, unknown>;

/** A request field by its proto name or its JSON (camelCase) name. */
function field(req: TwirpRequest, name: string): unknown {
  return req[name] ?? req[name.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())];
}

function str(req: TwirpRequest, name: string, max = 1024): string {
  const v = field(req, name) ?? "";
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${name} must be a string of at most ${max} characters`);
  return v;
}

/** int64 values arrive as strings (protobuf JSON) or numbers (Go clients). */
function int64(req: TwirpRequest, name: string): number | undefined {
  const v = field(req, name);
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`);
  return n;
}

function twirp(service: "CacheService" | "ArtifactService", method: string, fn: (c: AppContext, claims: RuntimeClaims, req: TwirpRequest) => Promise<Record<string, unknown>>) {
  actionsRuntime.post(`/twirp/github.actions.results.api.v1.${service}/${method}`, async (c) => {
    try {
      const claims = await runtimeClaims(c);
      let req: unknown;
      try {
        req = await c.req.json();
      } catch {
        throw new HttpError(400, "the request body must be JSON");
      }
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new HttpError(400, "the request body must be a JSON object");
      return c.json(await fn(c, claims, req as TwirpRequest));
    } catch (e) {
      const { status, message } = failure(e);
      return c.json({ code: TWIRP_CODES[status] ?? "internal", msg: message }, status as 400);
    }
  });
}

/** Reads name the run; the job may be the one that uploaded (download-artifact sends the artifact's ids). */
function ownRun(claims: RuntimeClaims, req: TwirpRequest): void {
  const run = field(req, "workflow_run_backend_id");
  if (run !== undefined && run !== claims.run) throw new HttpError(403, "the request names another workflow run");
}

/** Writes name the run and job; they must be the token's own. */
function ownJob(claims: RuntimeClaims, req: TwirpRequest): void {
  const run = field(req, "workflow_run_backend_id");
  const job = field(req, "workflow_job_run_backend_id");
  if ((run !== undefined && run !== claims.run) || (job !== undefined && job !== claims.job)) throw new HttpError(403, "the request names another workflow run or job");
}

twirp("CacheService", "CreateCacheEntry", async (c, claims, req) => {
  const reserved = await repoStub(c.env, claims.repo).rtCacheReserve(claims.job, str(req, "key", 512), str(req, "version", 128));
  if (!reserved) throw new HttpError(409, "a cache entry with this key and version already exists");
  const url = await signBlobUrl(c.env, origin(c.env), { repo: claims.repo, kind: "cache", id: reserved.id }, "w", claims.exp);
  return { ok: true, signed_upload_url: url };
});

twirp("CacheService", "FinalizeCacheEntryUpload", async (c, claims, req) => {
  const stub = repoStub(c.env, claims.repo);
  const entry = await stub.rtCacheReservation(claims.job, { key: str(req, "key", 512), version: str(req, "version", 128) });
  if (!entry) throw new HttpError(404, "no upload of this cache entry is in progress");
  const obj = await c.env.BUCKET.head(finalKey({ repo: claims.repo, kind: "cache", id: entry.id }));
  if (!obj) return { ok: false, entry_id: "0", message: "the cache archive was not uploaded" };
  const size = int64(req, "size_bytes");
  if (size !== undefined && size !== obj.size) return { ok: false, entry_id: "0", message: `the uploaded archive has ${obj.size} bytes, not ${size}` };
  const done = await stub.rtCacheCommit(claims.job, entry.id, obj.size, obj.etag);
  return { ok: true, entry_id: String(done.id) };
});

twirp("CacheService", "GetCacheEntryDownloadURL", async (c, claims, req) => {
  const restore = field(req, "restore_keys");
  if (restore !== undefined && (!Array.isArray(restore) || restore.length > 20 || restore.some((k) => typeof k !== "string" || k.length > 512))) throw new HttpError(400, "restore_keys must be a list of at most 20 keys");
  const keys = [...new Set([str(req, "key", 512), ...((restore as string[] | undefined) ?? [])].filter(Boolean))];
  if (!keys.length) throw new HttpError(400, "key is required");
  const hit = await liveCacheHit(c.env, claims, keys, str(req, "version", 128));
  if (!hit) return { ok: false, signed_download_url: "", matched_key: "" };
  return { ok: true, signed_download_url: await readUrl(c.env, { repo: claims.repo, kind: "cache", id: hit.id }), matched_key: hit.key };
});

const artifactName = (req: TwirpRequest) => str(req, "name", 256);

twirp("ArtifactService", "CreateArtifact", async (c, claims, req) => {
  ownJob(claims, req);
  const mime = field(req, "mime_type");
  const mimeType = typeof mime === "string" && /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(mime) ? mime : ZIP;
  const expires = field(req, "expires_at");
  const { id } = await repoStub(c.env, claims.repo).rtArtifactCreate(claims.job, artifactName(req), mimeType, typeof expires === "string" ? expires : undefined);
  const url = await signBlobUrl(c.env, origin(c.env), { repo: claims.repo, kind: "artifact", id }, "w", claims.exp);
  return { ok: true, signed_upload_url: url };
});

twirp("ArtifactService", "FinalizeArtifact", async (c, claims, req) => {
  ownJob(claims, req);
  const stub = repoStub(c.env, claims.repo);
  const name = artifactName(req);
  const upload = await stub.rtArtifactUpload(claims.job, name);
  if (!upload) throw new HttpError(404, `no upload of artifact '${name}' is in progress`);
  const obj = await c.env.BUCKET.head(finalKey({ repo: claims.repo, kind: "artifact", id: upload.id }));
  if (!obj) throw new HttpError(412, "the artifact's content was not uploaded");
  const size = int64(req, "size");
  if (size !== undefined && size !== obj.size) throw new HttpError(412, `the uploaded artifact has ${obj.size} bytes, not ${size}`);
  const hash = field(req, "hash");
  const digest = typeof hash === "string" && /^sha256:[0-9a-f]{64}$/.test(hash) ? hash : undefined;
  const done = await stub.rtArtifactFinalize(claims.job, name, obj.size, digest, obj.etag);
  return { ok: true, artifact_id: String(done.id) };
});

twirp("ArtifactService", "ListArtifacts", async (c, claims, req) => {
  ownRun(claims, req);
  const nameFilter = field(req, "name_filter");
  const list = await repoStub(c.env, claims.repo).rtJobArtifacts(claims.job, { name: typeof nameFilter === "string" ? nameFilter : undefined, id: int64(req, "id_filter") });
  return {
    artifacts: list.map((a) => ({
      workflow_run_backend_id: a.runId,
      workflow_job_run_backend_id: a.jobId,
      database_id: String(a.id),
      name: a.name,
      size: String(a.size),
      created_at: a.createdAt,
      ...(a.digest ? { digest: a.digest } : {}),
    })),
  };
});

twirp("ArtifactService", "GetSignedArtifactURL", async (c, claims, req) => {
  ownRun(claims, req);
  const name = artifactName(req);
  const a = (await repoStub(c.env, claims.repo).rtJobArtifacts(claims.job, { name }))[0];
  if (!a) throw new HttpError(404, `artifact '${name}' not found`);
  return { signed_url: await readUrl(c.env, { repo: claims.repo, kind: "artifact", id: a.id }, artifactFileName(a)) };
});

twirp("ArtifactService", "DeleteArtifact", async (c, claims, req) => {
  ownJob(claims, req);
  const name = artifactName(req);
  const deleted = await repoStub(c.env, claims.repo).rtArtifactDeleteByName(claims.job, name);
  if (!deleted) throw new HttpError(404, `artifact '${name}' not found`);
  return { ok: true, artifact_id: String(deleted.id) };
});

// ---------------------------------------------------------------- legacy cache API (ACTIONS_CACHE_URL)

const V1 = "/_runtime/_apis/artifactcache";

/** Errors in the shape the legacy API used (clients look at `typeKey` and `message`). */
function v1(fn: (c: AppContext, claims: RuntimeClaims) => Promise<Response>) {
  return async (c: AppContext) => {
    try {
      return await fn(c, await runtimeClaims(c));
    } catch (e) {
      const { status, message } = failure(e);
      const typeKey = status === 409 ? "ArtifactCacheItemAlreadyExistsException" : status === 404 ? "ArtifactCacheNotFoundException" : "ArtifactCacheException";
      return c.json({ $id: "1", innerException: null, message, typeName: `Microsoft.Azure.DevOps.ArtifactCache.WebApi.${typeKey}, Microsoft.Azure.DevOps.ArtifactCache.WebApi`, typeKey, errorCode: 0, eventId: 3000 }, status as 400);
    }
  };
}

const v1Cache = (e: CacheEntry) => ({ cacheKey: e.key, scope: e.scope, cacheVersion: e.version, creationTime: e.createdAt });

actionsRuntime.get(
  `${V1}/cache`,
  v1(async (c, claims) => {
    const keys = (c.req.query("keys") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    if (!keys.length || keys.length > 20 || keys.some((k) => k.length > 512)) throw new HttpError(400, "keys must list 1 to 20 cache keys");
    const hit = await liveCacheHit(c.env, claims, keys, (c.req.query("version") ?? "").slice(0, 128));
    if (!hit) return c.body(null, 204);
    return c.json({ ...v1Cache(hit), archiveLocation: await readUrl(c.env, { repo: claims.repo, kind: "cache", id: hit.id }) });
  }),
);

actionsRuntime.get(
  `${V1}/caches`,
  v1(async (c, claims) => {
    const stub = repoStub(c.env, claims.repo);
    const { scopes } = await stub.rtJob(claims.job);
    const key = (c.req.query("key") ?? "").slice(0, 512);
    const { caches } = await stub.rtListCaches({ key: key || undefined, perPage: 100 });
    const visible = caches.filter((e) => scopes.includes(e.scope));
    return c.json({ totalCount: visible.length, artifactCaches: visible.map(v1Cache) });
  }),
);

actionsRuntime.post(
  `${V1}/caches`,
  v1(async (c, claims) => {
    const b = (await c.req.json().catch(() => null)) as { key?: unknown; version?: unknown; cacheSize?: unknown } | null;
    if (!b || typeof b.key !== "string" || typeof b.version !== "string") throw new HttpError(400, "key and version are required");
    if (typeof b.cacheSize === "number" && b.cacheSize > 10 * 1024 ** 3) throw new HttpError(400, "the cache is larger than the 10 GB limit");
    const reserved = await repoStub(c.env, claims.repo).rtCacheReserve(claims.job, b.key, b.version);
    if (!reserved) throw new HttpError(409, `Cache already exists. Key: ${b.key}, Version: ${b.version}`);
    return c.json({ cacheId: reserved.id }, 201);
  }),
);

const cacheIdParam = (c: AppContext) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, "cache not found");
  return id;
};

actionsRuntime.patch(
  `${V1}/caches/:id`,
  v1(async (c, claims) => {
    const id = cacheIdParam(c);
    const m = /^bytes (\d{1,15})-(\d{1,15})\/(\*|\d+)$/.exec(c.req.header("content-range") ?? "");
    if (!m) throw new HttpError(400, "Content-Range must be bytes <start>-<end>/*");
    const start = Number(m[1]);
    const length = Number(m[2]) - start + 1;
    if (length < 1) throw new HttpError(400, "invalid Content-Range");
    const declared = declaredLength(c);
    if (declared !== null && declared !== length) throw new HttpError(400, `the chunk has ${declared} bytes but Content-Range says ${length}`);
    const stub = repoStub(c.env, claims.repo);
    if (!(await stub.rtCacheReservation(claims.job, { id }))) throw new HttpError(404, "no upload of this cache entry is in progress");
    // Counted against the budget before anything is stored; the body streams to R2
    // (@actions/cache sends 32 MiB chunks, four at a time, without Content-Length).
    if (!c.req.raw.body) throw new HttpError(400, "the chunk is empty");
    await stub.rtStage("cache", id, length);
    try {
      await c.env.BUCKET.put(chunkKey({ repo: claims.repo, kind: "cache", id }, start), sized(c.req.raw.body, length));
    } catch {
      await stub.rtUnstage("cache", id, length);
      throw new HttpError(400, `the chunk does not have the ${length} bytes Content-Range says`);
    }
    return c.body(null, 204);
  }),
);

actionsRuntime.post(
  `${V1}/caches/:id`,
  v1(async (c, claims) => {
    const id = cacheIdParam(c);
    const b = (await c.req.json().catch(() => null)) as { size?: unknown } | null;
    const size = b?.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "size is required");
    const stub = repoStub(c.env, claims.repo);
    if (!(await stub.rtCacheReservation(claims.job, { id }))) throw new HttpError(404, "no upload of this cache entry is in progress");
    const ref: BlobRef = { repo: claims.repo, kind: "cache", id };
    const staged = await listStaged(bucket(c.env), ref);
    // Chunks are keyed by their offset; together they must cover [0, size) exactly.
    const chunks = [...staged].flatMap(([key, n]) => {
      const off = /\/o-(\d{16})$/.exec(key);
      return off ? [{ key, size: n, offset: Number(off[1]) }] : [];
    });
    chunks.sort((x, y) => x.offset - y.offset);
    let at = 0;
    for (const ch of chunks) {
      if (ch.offset !== at) throw new HttpError(400, `the uploaded chunks do not cover byte ${at} exactly`);
      at += ch.size;
    }
    if (at !== size) throw new HttpError(400, `${at} bytes were uploaded, not ${size}`);
    await stub.rtCheckCommitSize("cache", id, size);
    await composeUpload(c.env, ref, chunks, "application/octet-stream");
    await deleteKeys(bucket(c.env), [...staged.keys()]);
    const obj = await c.env.BUCKET.head(finalKey(ref));
    if (!obj) throw new HttpError(500, "the composed cache archive is missing");
    await stub.rtCacheCommit(claims.job, id, obj.size, obj.etag);
    return c.body(null, 204);
  }),
);

// ---------------------------------------------------------------- signed blob URLs (Azure Blob subset on R2)

const BLOB_PATH = "/_runtime/blob/:repo/:kind/:id/:file?";

function blobRef(c: AppContext): BlobRef | null {
  const { repo, kind, id } = c.req.param() as { repo: string; kind: string; id: string };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(repo) || (kind !== "cache" && kind !== "artifact") || !/^\d{1,15}$/.test(id)) return null;
  return { repo, kind, id: Number(id) };
}

/** Headers every Azure Blob response carries. */
const azureHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({ "x-ms-request-id": newId(), "x-ms-version": "2025-01-05", date: new Date().toUTCString(), ...extra });

function azureError(status: number, code: string, message: string): Response {
  const xml = `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${message.replace(/[<>&]/g, "")}</Message></Error>`;
  return new Response(xml, { status, headers: azureHeaders({ "content-type": "application/xml", "x-ms-error-code": code }) });
}

const created = (etag?: string) => new Response(null, { status: 201, headers: azureHeaders({ "x-ms-request-server-encrypted": "true", ...(etag ? { etag, "last-modified": new Date().toUTCString() } : {}) }) });

/**
 * Stores a block or blob body as it streams in. Like Azure, a length is required
 * (411 without one); the bytes are counted against the repository's budget first.
 */
async function putUpload(c: AppContext, b: BlobRef, key: string, contentType?: string): Promise<{ etag: string; httpEtag: string } | Response> {
  const len = declaredLength(c);
  if (len === null) return azureError(411, "MissingContentLengthHeader", "Content-Length is required.");
  if (len > MAX_UPLOAD_PART) return azureError(413, "RequestBodyTooLarge", `A single request may carry at most ${MAX_UPLOAD_PART} bytes.`);
  const stub = repoStub(c.env, b.repo);
  await stub.rtStage(b.kind, b.id, len);
  const body = len > 0 && c.req.raw.body ? sized(c.req.raw.body, len) : new Uint8Array(0);
  try {
    const put = await c.env.BUCKET.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined);
    return { etag: put.etag, httpEtag: put.httpEtag };
  } catch (e) {
    await stub.rtUnstage(b.kind, b.id, len);
    throw e;
  }
}

const BLOCK_LIST_MAX = 8 * 1024 * 1024;

actionsRuntime.put(BLOB_PATH, async (c) => {
  const b = blobRef(c);
  if (!b) return azureError(404, "ResourceNotFound", "The specified resource does not exist.");
  const q = new URL(c.req.url).searchParams;
  if (!(await verifyBlobUrl(c.env, b, "w", q))) return azureError(403, "AuthenticationFailed", "The upload URL is invalid or has expired.");
  try {
    const comp = q.get("comp");
    if (comp === "block") {
      const blockId = q.get("blockid") ?? "";
      if (!blockId || blockId.length > 1024) return azureError(400, "InvalidQueryParameterValue", "blockid is required.");
      const put = await putUpload(c, b, blockKey(b, blockId));
      return put instanceof Response ? put : created();
    }
    if (comp !== "blocklist" && comp !== null) return azureError(400, "InvalidQueryParameterValue", `comp=${comp} is not supported.`);
    const stub = repoStub(c.env, b.repo);
    const writable = b.kind === "cache" ? await stub.rtCacheWritable(b.id) : await stub.rtArtifactWritable(b.id);
    if (!writable) return azureError(409, "BlobImmutable", "This upload is finished or its job is no longer running.");
    const contentType = c.req.header("x-ms-blob-content-type") ?? "application/octet-stream";
    if (comp === null) {
      // Put Blob: the whole content in one request.
      if ((c.req.header("x-ms-blob-type") ?? "BlockBlob") !== "BlockBlob") return azureError(400, "InvalidHeaderValue", "Only block blobs are supported.");
      const put = await putUpload(c, b, finalKey(b), contentType);
      return put instanceof Response ? put : created(put.httpEtag);
    }
    // Put Block List: concatenate the staged blocks in the order given.
    const ids = parseBlockList(await smallText(c, BLOCK_LIST_MAX));
    if (ids.length > 50_000) return azureError(400, "InvalidBlockList", "Too many blocks.");
    const staged = await listStaged(bucket(c.env), b);
    const segments: Array<{ key: string; size: number }> = [];
    for (const id of ids) {
      const key = blockKey(b, id);
      const size = staged.get(key);
      if (size === undefined) return azureError(400, "InvalidBlockList", "The specified block list is invalid.");
      segments.push({ key, size });
    }
    await stub.rtCheckCommitSize(b.kind, b.id, segments.reduce((n, s) => n + s.size, 0));
    await composeUpload(c.env, b, segments, contentType);
    await deleteKeys(bucket(c.env), [...staged.keys()]);
    const head = await c.env.BUCKET.head(finalKey(b));
    return created(head?.httpEtag ?? `"${newId()}"`);
  } catch (e) {
    const { status, message } = failure(e);
    if (status >= 500) console.error("blob upload failed", b.kind, b.id, q.get("comp") ?? "put", e);
    return azureError(status, status === 404 ? "ResourceNotFound" : status === 413 ? "RequestBodyTooLarge" : status === 409 ? "BlobImmutable" : status < 500 ? "InvalidInput" : "InternalError", message);
  }
});

const serveBlob = async (c: AppContext) => {
  const b = blobRef(c);
  if (!b) return azureError(404, "ResourceNotFound", "The specified resource does not exist.");
  if (!(await verifyBlobUrl(c.env, b, "r", new URL(c.req.url).searchParams))) return azureError(403, "AuthenticationFailed", "The download URL is invalid or has expired.");
  const stub = repoStub(c.env, b.repo);
  const headers: Record<string, string> = { "accept-ranges": "bytes", "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" };
  let etag: string | null;
  let keys = [finalKey(b)];
  if (b.kind === "cache") {
    const e = await stub.rtCacheGet(b.id);
    if (!e) return azureError(404, "BlobNotFound", "The cache entry does not exist.");
    etag = e.etag;
  } else {
    const a = await stub.rtArtifactGet(b.id);
    if (!a) return azureError(404, "BlobNotFound", "The artifact does not exist or has expired.");
    etag = a.etag;
    const name = artifactFileName(a);
    headers["content-type"] = a.mimeType;
    headers["content-disposition"] = `attachment; filename="${name.replace(/[^\w.-]+/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    if (a.digest) headers["x-ms-meta-digest"] = a.digest;
    // An older runner's tarball stays at its legacy key.
    keys = artifactObjectKeys(b.repo, a);
  }
  const head = await headFirst(c.env.BUCKET, keys);
  if (!head) return azureError(404, "BlobNotFound", "The specified blob does not exist.");
  const key = head.key;
  // Only the object that was committed: a write that landed after Finalize is not served.
  if (etag && head.etag !== etag) return azureError(409, "BlobModified", "The blob was modified after it was committed.");
  Object.assign(headers, { etag: head.httpEtag, "last-modified": head.uploaded.toUTCString() });
  const range = parseRange(c.req.header("x-ms-range") ?? c.req.header("range"), head.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: azureHeaders({ ...headers, "content-range": `bytes */${head.size}` }) });
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: azureHeaders({ ...headers, "content-length": String(head.size) }) });
  if (!range) {
    const obj = await c.env.BUCKET.get(key, { onlyIf: { etagMatches: head.etag } });
    if (!obj || !("body" in obj)) return azureError(404, "BlobNotFound", "The specified blob does not exist.");
    return new Response(obj.body, { status: 200, headers: azureHeaders({ ...headers, "content-length": String(obj.size) }) });
  }
  const obj = await c.env.BUCKET.get(key, { range: { offset: range.offset, length: range.length }, onlyIf: { etagMatches: head.etag } });
  if (!obj || !("body" in obj)) return azureError(404, "BlobNotFound", "The specified blob does not exist.");
  return new Response(obj.body, {
    status: 206,
    headers: azureHeaders({ ...headers, "content-length": String(range.length), "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}` }),
  });
};
actionsRuntime.get(BLOB_PATH, serveBlob);
actionsRuntime.on("HEAD", BLOB_PATH, serveBlob);

// ---------------------------------------------------------------- REST: artifacts and caches (/api/v3)

const P = (c: AppContext) => ({ owner: c.req.param("owner")!, repo: c.req.param("repo")! });

const idParam = (c: AppContext, name: string) => {
  const n = Number(c.req.param(name));
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "Not Found");
  return n;
};

function artifactJson(c: AppContext, repoId: string, a: ArtifactEntry) {
  const { owner, repo } = P(c);
  const url = `${c.env.PUBLIC_URL}/api/v3/repos/${owner}/${repo}/actions/artifacts/${a.id}`;
  return {
    id: a.id,
    node_id: `MDg6QXJ0aWZhY3Q${a.id}`,
    name: a.name,
    size_in_bytes: a.size,
    url,
    archive_download_url: `${url}/zip`,
    expired: a.expired,
    digest: a.digest,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    expires_at: a.expiresAt,
    workflow_run: { id: a.runNumber, repository_id: repoId, head_repository_id: repoId, head_branch: a.headBranch, head_sha: a.headSha },
  };
}

const cacheJson = (e: CacheEntry) => ({ id: e.id, ref: e.scope, key: e.key, version: e.version, last_accessed_at: e.lastUsed, created_at: e.createdAt, size_in_bytes: e.size });

actionsRest.get("/repos/:owner/:repo/actions/artifacts", async (c) => {
  const { repo, stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const p = pageOf(c);
  const res = await stub.rtRepoArtifacts({ name: c.req.query("name") || undefined, page: p.page, perPage: p.perPage });
  setLinks(c, p, res.total);
  return c.json({ total_count: res.total, artifacts: res.artifacts.map((a) => artifactJson(c, repo.id, a)) });
});

actionsRest.get("/repos/:owner/:repo/actions/runs/:runId/artifacts", async (c) => {
  const { repo, stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const runId = c.req.param("runId");
  if (!/^[A-Za-z0-9]{1,64}$/.test(runId)) throw new HttpError(404, "Not Found");
  const all = await stub.rtRunArtifacts(runId, { name: c.req.query("name") || undefined, includeExpired: true });
  return c.json({ total_count: all.length, artifacts: paginate(c, all).map((a) => artifactJson(c, repo.id, a)) });
});

actionsRest.get("/repos/:owner/:repo/actions/artifacts/:id", async (c) => {
  const { repo, stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const a = await stub.rtArtifactGet(idParam(c, "id"), { includeExpired: true });
  if (!a) throw new HttpError(404, "Not Found");
  return c.json(artifactJson(c, repo.id, a));
});

actionsRest.get("/repos/:owner/:repo/actions/artifacts/:id/:format", async (c) => {
  const { repo, stub } = await loadRepo(c, P(c).owner, P(c).repo);
  if (c.req.param("format") !== "zip") throw new HttpError(404, "Not Found");
  const a = await stub.rtArtifactGet(idParam(c, "id"), { includeExpired: true });
  if (!a) throw new HttpError(404, "Not Found");
  // As on GitHub: an expired artifact is still listed, but its content is gone.
  if (a.expired) throw new HttpError(410, "Artifact has expired");
  return c.redirect(await signBlobUrl(c.env, origin(c.env), { repo: repo.id, kind: "artifact", id: a.id }, "r", nowS() + 600, artifactFileName(a)), 302);
});

actionsRest.delete("/repos/:owner/:repo/actions/artifacts/:id", async (c) => {
  const { repo, caller, stub } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const deleted = await stub.rtArtifactDelete(idParam(c, "id"));
  if (!deleted) throw new HttpError(404, "Not Found");
  auditRepo(c, caller, repo, "actions.artifact.delete", { id: deleted.id, name: deleted.name });
  return c.body(null, 204);
});

actionsRest.get("/repos/:owner/:repo/actions/caches", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const p = pageOf(c);
  const res = await stub.rtListCaches({ key: c.req.query("key") || undefined, ref: c.req.query("ref") || undefined, sort: c.req.query("sort"), direction: c.req.query("direction"), page: p.page, perPage: p.perPage });
  setLinks(c, p, res.total);
  return c.json({ total_count: res.total, actions_caches: res.caches.map(cacheJson) });
});

actionsRest.delete("/repos/:owner/:repo/actions/caches", async (c) => {
  const { repo, caller, stub } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const key = c.req.query("key");
  if (!key) throw new HttpError(422, "key is required");
  const deleted = await stub.rtDeleteCaches({ key, ref: c.req.query("ref") || undefined });
  if (!deleted.length) throw new HttpError(404, "Not Found");
  auditRepo(c, caller, repo, "actions.cache.delete", { key, ids: deleted.map((d) => d.id) });
  return c.json({ total_count: deleted.length, actions_caches: deleted.map(cacheJson) });
});

actionsRest.delete("/repos/:owner/:repo/actions/caches/:id", async (c) => {
  const { repo, caller, stub } = await loadRepo(c, P(c).owner, P(c).repo, "write");
  const deleted = await stub.rtDeleteCaches({ id: idParam(c, "id") });
  if (!deleted.length) throw new HttpError(404, "Not Found");
  auditRepo(c, caller, repo, "actions.cache.delete", { key: deleted[0]!.key, ids: [deleted[0]!.id] });
  return c.body(null, 204);
});

// The workflow token's defaults: GitHub's "Workflow permissions" settings.
const workflowSettingsJson = (s: { defaultPermissions: "read" | "write"; canApprovePullRequests: boolean; agentRunSecrets: boolean }) => ({ default_workflow_permissions: s.defaultPermissions, can_approve_pull_request_reviews: s.canApprovePullRequests, agent_runs_use_secrets: s.agentRunSecrets });

actionsRest.get("/repos/:owner/:repo/actions/permissions/workflow", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  return c.json(workflowSettingsJson(await stub.workflowSettings()));
});

actionsRest.put("/repos/:owner/:repo/actions/permissions/workflow", async (c) => {
  const { caller, stub } = await loadRepo(c, P(c).owner, P(c).repo, "admin");
  const b = (await c.req.json().catch(() => null)) as { default_workflow_permissions?: unknown; can_approve_pull_request_reviews?: unknown; agent_runs_use_secrets?: unknown } | null;
  if (!b || typeof b !== "object") throw new HttpError(422, "a JSON body is required");
  // Audited by the repository (an audit event per change), marked as made through the API.
  await stub.setWorkflowSettings({ defaultPermissions: b.default_workflow_permissions as "read" | "write" | undefined, canApprovePullRequests: b.can_approve_pull_request_reviews as boolean | undefined, agentRunSecrets: b.agent_runs_use_secrets as boolean | undefined }, caller, { via: "api" });
  return c.body(null, 204);
});

actionsRest.get("/repos/:owner/:repo/actions/cache/usage", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const u = await stub.rtCacheUsage();
  return c.json({ full_name: `${P(c).owner}/${P(c).repo}`, active_caches_size_in_bytes: u.size, active_caches_count: u.count });
});
