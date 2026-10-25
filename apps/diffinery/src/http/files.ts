import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { HttpError } from "../lib/util.js";
import type { Caller } from "../repo/types.js";
import { R2Sink } from "../lib/r2-sink.js";
import { baseOf, ghAsset } from "./gh.js";
import { decodePath, intParam, loadTarget, repoParams, type Stub } from "./ghctx.js";

/**
 * Byte routes outside /api/v3, at the paths GitHub clients expect:
 * release asset uploads (`upload_url`), browser downloads of release assets
 * and source archives.
 */
export const files = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** Workers accept request bodies up to 100 MB, so that is the real limit for an asset. */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const TOO_LARGE = "release assets are limited to 100 MB";

/** Store an asset's bytes in R2 and record it. Streams either way; without a length, bytes are counted and the upload stops at the limit. */
export async function storeAsset(
  env: Env,
  stub: Stub,
  releaseId: number,
  meta: { name: string; label?: string; contentType?: string },
  data: { stream: ReadableStream<Uint8Array>; length: number | null },
  caller: Caller,
) {
  if (data.length !== null && data.length > MAX_ASSET_BYTES) throw new HttpError(413, TOO_LARGE);
  const { id, r2Key } = await stub.startReleaseAsset(releaseId, { ...meta, size: data.length ?? undefined }, caller);
  try {
    let size: number;
    if (data.length !== null) {
      const fixed = new FixedLengthStream(data.length);
      await Promise.all([data.stream.pipeTo(fixed.writable), env.BUCKET.put(r2Key, fixed.readable, { httpMetadata: { contentType: meta.contentType } })]);
      size = data.length;
    } else {
      const sink = new R2Sink(env.BUCKET, r2Key, meta.contentType ?? "application/octet-stream", MAX_ASSET_BYTES, TOO_LARGE);
      const reader = data.stream.getReader();
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
    return await stub.finishReleaseAsset(id, size);
  } catch (e) {
    await stub.abortReleaseAsset(id);
    await env.BUCKET.delete(r2Key).catch(() => undefined);
    throw e;
  }
}

/** Serve stored bytes as a download that browsers never render inline. */
export async function serveDownload(c: AppContext, key: string, name: string, contentType: string): Promise<Response> {
  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw new HttpError(404, "Not Found");
  return new Response(obj.body, {
    headers: {
      "content-type": contentType || "application/octet-stream",
      "content-length": String(obj.size),
      "content-disposition": `attachment; filename="${name.replace(/[^\w.+@~-]+/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      etag: obj.httpEtag,
    },
  });
}

// POST {upload_url}?name=...&label=...: the raw request body is the file (Octokit's uploadReleaseAsset, `gh release upload`).
files.post("/api/uploads/repos/:owner/:repo/releases/:id/assets", async (c) => {
  const { stub, caller, repo } = await loadTarget(c, "write");
  const name = c.req.query("name");
  if (!name) throw new HttpError(422, "the name query parameter is required", { errors: [{ resource: "ReleaseAsset", code: "missing_field", field: "name" }] });
  const body = c.req.raw.body;
  if (!body) throw new HttpError(422, "the request body is the asset's content");
  const len = c.req.header("content-length");
  const length = len !== undefined && /^\d+$/.test(len) ? Number(len) : null;
  const asset = await storeAsset(c.env, stub, intParam(c, "id"), { name, label: c.req.query("label") ?? undefined, contentType: c.req.header("content-type") }, { stream: body, length }, caller);
  const release = await stub.getRelease(intParam(c, "id"), caller);
  return c.json(ghAsset(baseOf(c), repo.owner_login, repo.name, release.tagName, asset), 201);
});

// Browser download of a release asset: /<owner>/<repo>/releases/download/<tag>/<name> (tags may contain slashes).
files.get("/:owner/:repo/releases/download/*", async (c) => {
  const { stub, caller } = await loadTarget(c);
  const rest = c.req.path.split("/releases/download/")[1] ?? "";
  const cut = rest.lastIndexOf("/");
  if (cut <= 0) throw new HttpError(404, "Not Found");
  const tag = decodePath(rest.slice(0, cut));
  const name = decodePath(rest.slice(cut + 1));
  const d = await stub.releaseDownload({ tag, name }, caller);
  return serveDownload(c, d.r2Key, d.name, d.contentType);
});

/** A source archive of `ref` (built once per commit and kept in R2). */
export async function archiveResponse(c: AppContext, stub: Stub, owner: string, repo: string, ref: string, format: "zip" | "tar.gz"): Promise<Response> {
  const sha = await stub.resolve(ref || "HEAD");
  if (!sha) throw new HttpError(404, "Not Found");
  let key = await stub.archiveKey(sha, format);
  if (!(await c.env.BUCKET.head(key))) key = (await stub.buildArchive(sha, format)).key;
  return serveDownload(c, key, `${owner}-${repo}-${sha.slice(0, 7)}.${format}`, format === "zip" ? "application/zip" : "application/gzip");
}

// /<owner>/<repo>/archive/<ref>.zip and .tar.gz (also refs/heads/<branch>.zip, like GitHub's archive links).
files.get("/:owner/:repo/archive/*", async (c) => {
  const { stub, repo } = await loadTarget(c);
  const spec = decodePath(c.req.path.split("/archive/")[1] ?? "");
  const m = /^(.+)\.(zip|tar\.gz)$/.exec(spec);
  if (!m) throw new HttpError(404, "Not Found");
  return archiveResponse(c, stub, repo.owner_login, repo.name, m[1]!, m[2] as "zip" | "tar.gz");
});

