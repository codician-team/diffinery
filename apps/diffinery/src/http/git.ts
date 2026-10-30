import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppVars } from "../auth/principal.js";
import { HttpError } from "../lib/util.js";
import { BodyTooLarge, putStream, type BlobBucket } from "../lib/blob-store.js";
import { pushBodyKey, type SpilledBody } from "../lib/storage-keys.js";
import { importPushAllowed } from "../imports/service.js";
import { loadRepo, repoStub } from "./common.js";
import type { Caller } from "../repo/types.js";
import { resetByDeploy, UPLOAD_PACK_PATH } from "../git/protocol.js";

/**
 * Git smart HTTP (protocol v2 for fetch/clone, v0 for push) and the Git LFS
 * batch API, at https://diffinery.com/<owner>/<repo>.git
 *
 * A transferred or renamed repository is served under its old name too (`follow`),
 * as GitHub does, and a push there says where it moved. A redirect would not do:
 * git follows one only on info/refs (never on its POSTs), and then rebuilds its
 * credentials from the new URL, which drops a token embedded in the remote URL.
 */
export const git = new Hono<{ Bindings: Env; Variables: AppVars }>();

const noCache = { "cache-control": "no-cache, max-age=0, must-revalidate", pragma: "no-cache" };

git.get("/:owner/:repo/info/refs", async (c) => {
  const service = c.req.query("service");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") throw new HttpError(403, "dumb HTTP protocol is not supported; update git");
  // Git only offers credentials after a 401, so an anonymous push must be asked for them (as GitHub does), even to a public repository.
  if (service === "git-receive-pack" && c.get("principal").type === "anonymous") throw new HttpError(401, "authentication required");
  const { stub, repo } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), service === "git-receive-pack" ? "write" : "read", { follow: true });
  if (service === "git-receive-pack" && repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  if (service === "git-upload-pack" && !/version=2/.test(c.req.header("git-protocol") ?? "")) {
    throw new HttpError(400, "Diffinery requires Git protocol v2 (git 2.26 or newer, or run: git config --global protocol.version 2)");
  }
  const body = await stub.gitInfoRefs(service);
  return new Response(body, { headers: { "content-type": `application/x-${service}-advertisement`, ...noCache } });
});

git.post("/:owner/:repo/git-upload-pack", async (c) => {
  const { stub } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "read", { readOnlyPost: true, follow: true });
  const body = await readBody(c.req.raw, MAX_UPLOAD_PACK_REQUEST, "fetch request exceeds 16 MB");
  // Through RepoDO.fetch rather than RPC, so the pack streams on celld too.
  const out = await stub.fetch(`https://repo${UPLOAD_PACK_PATH}`, { method: "POST", body });
  return new Response(out.body, { headers: { "content-type": "application/x-git-upload-pack-result", ...noCache } });
});

git.post("/:owner/:repo/git-receive-pack", async (c) => {
  // During someone else's import the repository refuses the push itself, with a message the client prints.
  const { stub, caller, repo, moved } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "write", { follow: true, whileImporting: true });
  // A GitHub import's own token, while that import is running and filling this repository, may push in import mode.
  const p = c.get("principal");
  if (p.type === "account" && p.importId && p.tokenId && (await importPushAllowed(c.env, p.importId, repo.id, p.tokenId))) caller.importId = p.importId;
  const { body, release } = await readPushBody(c.env, repo.id, c.req.raw);
  const out = await receiveWithRetry(c.env, repo.id, stub, body, caller, moved).finally(release);
  c.executionCtx.waitUntil(c.get("dir").touchPushed(repo.id));
  return new Response(out, { headers: { "content-type": "application/x-git-receive-pack-result", ...noCache } });
});

/**
 * A deploy resets every Durable Object, and one doing a push then fails it mid-way: git doesn't
 * retry a push, so it would print a 500. The push is handed over once more (to the new code; a
 * large one is still staged in R2: only this function deletes it, once the push is done either way).
 * Nothing is lost or moved twice: objects are stored by their ids, and refs move only at the end,
 * each by compare-and-swap; one the cut-off attempt already moved to the pushed commit is reported
 * as updated.
 */
export async function receiveWithRetry(env: Env, repoId: string, stub: ReturnType<typeof repoStub>, body: Uint8Array | SpilledBody, caller: Caller, moved: boolean): Promise<Uint8Array> {
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await stub.gitReceivePack(body, caller, { moved, retry: attempt > 1 });
      } catch (e) {
        if (attempt >= PUSH_TRIES || !(resetByDeploy(e) || resetForMemory(e))) throw e;
        // A stub that saw its object reset is broken; a new one reaches the new code.
        stub = repoStub(env, repoId);
      }
    }
  } finally {
    if (!(body instanceof Uint8Array)) await env.BUCKET.delete(body.spilled).catch(() => {});
  }
}

const PUSH_TRIES = 2;

/**
 * The repository's object was reset for going past its memory. Pushes to one repository take turns
 * for memory (RepoDO.gitReceivePack), so a push cut off this way was most likely caught up in another
 * request's reset, not the cause: like a deploy's reset, it is handed over once more, which moves the
 * refs the cut-off attempt didn't and sends the push events it may not have sent.
 */
export const resetForMemory = (e: unknown) => e instanceof Error && /exceeded its memory limit and was reset/i.test(e.message);

export { resetByDeploy };

/** A fetch's wants and haves; git's own negotiation stays far below this. */
const MAX_UPLOAD_PACK_REQUEST = 16 * 1024 * 1024;
/** The repository refuses pushes over 100 MB with a clear message; this stops anything far beyond. */
const MAX_RECEIVE_PACK_REQUEST = 101 * 1024 * 1024;

/**
 * The request body, gunzipped when the client compressed it. Reading stops at `max` bytes
 * (after decompression), so neither a huge body nor a gzip bomb is ever held in memory.
 */
async function readBody(req: Request, max: number, tooLarge: string): Promise<Uint8Array> {
  let stream = req.body;
  if (!stream) return new Uint8Array(0);
  if (req.headers.get("content-encoding") === "gzip") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, tooLarge);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.length;
  }
  return out;
}

/** Pushes up to this size are handed to the repository in memory; larger ones go through R2. */
const IN_MEMORY_PUSH = 16 * 1024 * 1024;
/**
 * Push bodies one Worker isolate holds in memory at once, across its requests (it has 128 MB, and a
 * body is held twice while it is joined): past this, a push goes through R2 even under IN_MEMORY_PUSH.
 */
const ISOLATE_PUSH_BYTES = 32 * 1024 * 1024;
let bufferedPushBytes = 0;

/**
 * A push's body. A large one is staged in R2 as it arrives (a Worker and a Durable Object each
 * have 128 MB of memory, and holding a 70 MB push twice, then copying it to the repository, does
 * not fit); the repository reads it from there once and deletes it.
 */
async function readPushBody(env: Env, repoId: string, req: Request): Promise<{ body: Uint8Array | SpilledBody; release: () => void }> {
  let counted = 0;
  const release = () => {
    bufferedPushBytes -= counted;
    counted = 0;
  };
  try {
    return { body: await readPushBodyCounted(env, repoId, req, (n) => ((counted += n), (bufferedPushBytes += n))), release };
  } catch (e) {
    release();
    throw e;
  }
}

/** readPushBody's body; `count` is told of every byte held in memory (ISOLATE_PUSH_BYTES). */
async function readPushBodyCounted(env: Env, repoId: string, req: Request, count: (bytes: number) => void): Promise<Uint8Array | SpilledBody> {
  const tooLarge = "push exceeds 100 MB; split it into smaller pushes";
  let stream = req.body;
  if (!stream) return new Uint8Array(0);
  if (req.headers.get("content-encoding") === "gzip") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    count(value.length);
    if (total > IN_MEMORY_PUSH || bufferedPushBytes > ISOLATE_PUSH_BYTES) {
      // Too big to pass along in memory (or this isolate holds enough already): what came so far, then the rest, goes to R2.
      count(-total);
      const key = pushBodyKey(repoId);
      const rest = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const ch of chunks.splice(0)) controller.enqueue(ch);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: () => reader.cancel(),
      });
      try {
        const size = await putStream(env.BUCKET as unknown as BlobBucket, key, rest, MAX_RECEIVE_PACK_REQUEST);
        return { spilled: key, size };
      } catch (e) {
        await env.BUCKET.delete(key).catch(() => {});
        if (e instanceof BodyTooLarge) throw new HttpError(413, tooLarge);
        throw e;
      }
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.length;
  }
  return out;
}

// ---------------------------------------------------------------- Git LFS

const lfsKey = (repoId: string, oid: string) => `repos/${repoId}/lfs/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
const LFS_TYPE = "application/vnd.git-lfs+json";

git.post("/:owner/:repo/info/lfs/objects/batch", async (c) => {
  const req = (await c.req.json()) as { operation: "upload" | "download"; objects: Array<{ oid: string; size: number }> };
  const { repo, stub } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), req.operation === "upload" ? "write" : "read", { readOnlyPost: req.operation !== "upload", follow: true });
  const base = `${c.env.PUBLIC_URL}/${c.req.param("owner")}/${c.req.param("repo")}/info/lfs/objects`;
  const auth = c.req.header("authorization");
  const objects = [];
  const uploads: Array<{ oid: string; size: number }> = [];
  for (const o of req.objects.slice(0, 1000)) {
    if (!/^[0-9a-f]{64}$/.test(o.oid)) {
      objects.push({ oid: o.oid, size: o.size, error: { code: 422, message: "invalid oid" } });
      continue;
    }
    const head = await c.env.BUCKET.head(lfsKey(repo.id, o.oid));
    if (req.operation === "download") {
      if (!head) objects.push({ oid: o.oid, size: o.size, error: { code: 404, message: "object not found" } });
      else objects.push({ oid: o.oid, size: head.size, authenticated: true, actions: { download: { href: `${base}/${o.oid}`, header: auth ? { Authorization: auth } : {}, expires_in: 3600 } } });
    } else if (head) objects.push({ oid: o.oid, size: o.size, authenticated: true });
    else uploads.push(o);
  }
  // Past the owner's storage quota (lib/quotas.ts) no new object is taken: each gets the reason instead.
  const full = uploads.length ? await stub.storageRefusal(uploads.reduce((n, o) => n + (Number(o.size) || 0), 0)) : null;
  for (const o of uploads) objects.push(full ? { oid: o.oid, size: o.size, error: { code: 507, message: full } } : { oid: o.oid, size: o.size, authenticated: true, actions: { upload: { href: `${base}/${o.oid}`, header: auth ? { Authorization: auth } : {}, expires_in: 3600 } } });
  return c.body(JSON.stringify({ transfer: "basic", objects, hash_algo: "sha256" }), 200, { "content-type": LFS_TYPE });
});

git.get("/:owner/:repo/info/lfs/objects/:oid", async (c) => {
  const { repo } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "read", { follow: true });
  const obj = await c.env.BUCKET.get(lfsKey(repo.id, c.req.param("oid")));
  if (!obj) throw new HttpError(404, "object not found");
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "content-length": String(obj.size) } });
});

git.put("/:owner/:repo/info/lfs/objects/:oid", async (c) => {
  const { repo, stub } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "write", { follow: true });
  const oid = c.req.param("oid");
  if (!/^[0-9a-f]{64}$/.test(oid)) throw new HttpError(422, "invalid oid");
  const length = Number(c.req.header("content-length"));
  const full = await stub.storageRefusal(Number.isFinite(length) ? length : 0);
  if (full) throw new HttpError(507, full);
  // Verify the content hash while storing: R2 checks the SHA-256 we pass.
  const body = await c.req.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (digest !== oid) throw new HttpError(422, "content does not match oid");
  await c.env.BUCKET.put(lfsKey(repo.id, oid), body);
  await stub.recordLfs(oid, body.byteLength);
  return c.body(null, 200);
});
