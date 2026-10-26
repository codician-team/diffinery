import { Hono } from "hono";
import type { JobCompletion, LogLine, StepReport } from "@diffinery/shared";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { credentialFrom } from "../auth/principal.js";
import { signEs256 } from "../lib/jwt.js";
import { BodyTooLarge, putStream, sized, type BlobBucket } from "../lib/blob-store.js";
import { getFirst, headFirst } from "../lib/storage-keys.js";
import { HttpError } from "../lib/util.js";
import { mirrorKey, parseActionRef, refreshMirror, type MirrorBucket } from "../lib/action-mirror.js";
import { parseRunnerInfo } from "../repo/actions.js";
import { CACHE_LIMIT_BYTES } from "../repo/runtime.js";
import { repoStub } from "./common.js";

/** Endpoints the runner agent inside a job container calls. Auth: the job token. */
export const runner = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** The job token's shape only: which repository to ask. Every handler must still have the repository verify the token. */
function jobAuth(req: Request, jobId: string): { token: string; repoId: string } {
  const token = credentialFrom(req);
  if (!token?.startsWith("djt_")) throw new HttpError(401, "job token required");
  const [, repoId, tokJob] = token.split("_");
  if (!repoId || tokJob !== jobId) throw new HttpError(401, "token does not match job");
  return { token, repoId };
}

/** Stores a request body as it streams in, refusing more than `max` bytes (older runners' cache and artifact uploads). */
async function storeBody(c: AppContext, key: string, max: number): Promise<number> {
  const body = c.req.raw.body;
  if (!body) throw new HttpError(400, "empty body");
  const options = { httpMetadata: { contentType: "application/gzip" } };
  const len = c.req.header("content-length");
  if (len !== undefined && /^\d{1,15}$/.test(len)) {
    if (Number(len) > max) throw new HttpError(413, `uploads are limited to ${max} bytes`);
    return (await c.env.BUCKET.put(key, sized(body, Number(len)), options)).size;
  }
  try {
    return await putStream(c.env.BUCKET as unknown as BlobBucket, key, body, max, options);
  } catch (e) {
    if (e instanceof BodyTooLarge) throw new HttpError(413, `uploads are limited to ${max} bytes`);
    throw e;
  }
}

runner.get("/runner/jobs/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  // This Worker's runner image, not the repository object's: after a deploy the object can run the previous version for minutes.
  return c.json(await repoStub(c.env, repoId).runnerSpec(jobId, token, parseRunnerInfo(c.req.header("x-diffinery-runner")), c.env.RUNNER_IMAGE ?? null));
});

runner.post("/runner/jobs/:jobId/logs", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  const { lines } = (await c.req.json()) as { lines: LogLine[] };
  await repoStub(c.env, repoId).runnerLogs(jobId, token, lines ?? []);
  return c.json({ ok: true });
});

runner.post("/runner/jobs/:jobId/steps/:index", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  await repoStub(c.env, repoId).runnerStep(jobId, token, Number(c.req.param("index")), (await c.req.json()) as StepReport);
  return c.json({ ok: true });
});

runner.post("/runner/jobs/:jobId/complete", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  await repoStub(c.env, repoId).runnerComplete(jobId, token, (await c.req.json()) as JobCompletion, c.env.RUNNER_IMAGE ?? null);
  return c.json({ ok: true });
});

// ---- cache (actions/cache compatible semantics, backed by R2)

runner.get("/runner/jobs/:jobId/cache", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  const key = c.req.query("key") ?? "";
  const restore = (c.req.query("restore") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const hit = await repoStub(c.env, repoId).cacheLookup(jobId, token, key, restore);
  if (!hit) return c.json({ message: "cache miss" }, 404);
  return c.json({ key: hit.key, url: `${new URL(c.req.url).origin}/runner/jobs/${jobId}/cache/blob/${encodeURIComponent(hit.stored)}` });
});

runner.get("/runner/jobs/:jobId/cache/blob/:key", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  // Only entries of a scope the job may restore from (its ref, the PR base, the default branch).
  const keys = await repoStub(c.env, repoId).cacheReadKeys(jobId, token, c.req.param("key"));
  const obj = keys && (await getFirst(c.env.BUCKET, keys));
  if (!obj) throw new HttpError(404, "cache entry missing");
  return new Response(obj.body, { headers: { "content-type": "application/gzip", "content-length": String(obj.size) } });
});

runner.put("/runner/jobs/:jobId/cache/:key", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  const key = c.req.param("key");
  if (key.length > 512) throw new HttpError(422, "cache key too long");
  const stub = repoStub(c.env, repoId);
  const { r2Keys: keys } = await stub.cacheSaveKeys(jobId, token, key);
  if (await headFirst(c.env.BUCKET, keys)) return c.json({ message: "cache entry already exists" }, 409);
  const size = await storeBody(c, keys[0]!, CACHE_LIMIT_BYTES);
  const evicted = await stub.cacheSaved(jobId, token, key, size);
  if (evicted.length) await c.env.BUCKET.delete(evicted);
  return c.json({ ok: true });
});

// ---- artifacts

runner.put("/runner/jobs/:jobId/artifacts/:name", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  const stub = repoStub(c.env, repoId);
  // Authenticates the job before anything is written: jobAuth only reads the token's shape.
  // The artifact is recorded with the artifact service's (numeric ids, retention, the REST API)
  // but stored at its legacy key; `room` is what is left of the repository's artifact quota.
  const { r2Keys: keys, room } = await stub.artifactUploadKeys(jobId, token, c.req.param("name"));
  if (room === 0) throw new HttpError(413, "the repository's artifact storage quota is used up; delete artifacts or wait for them to expire");
  const size = await storeBody(c, keys[0]!, room);
  await stub.artifactSaved(jobId, token, c.req.param("name"), size);
  return c.json({ ok: true });
});

runner.get("/runner/jobs/:jobId/artifacts/:name", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  const obj = await getFirst(c.env.BUCKET, await repoStub(c.env, repoId).artifactKeysFor(jobId, token, c.req.param("name")));
  if (!obj) throw new HttpError(404, "artifact not found");
  return new Response(obj.body, { headers: { "content-type": "application/gzip" } });
});

// ---- Diffinery's copies of GitHub actions, for when GitHub is down (lib/action-mirror.ts)

/** The runner downloaded this action from GitHub: keep a recent copy of it. */
runner.post("/runner/jobs/:jobId/action-mirror", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  const action = parseActionRef((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  if (!action) throw new HttpError(422, "invalid action");
  await repoStub(c.env, repoId).requireRunningJob(jobId, token);
  const work = refreshMirror(c.env.BUCKET as unknown as MirrorBucket, action);
  // The runner doesn't wait for this: its job can end, and drop the request, before a large action is stored.
  c.executionCtx.waitUntil(work);
  return c.json({ result: await work });
});

/** GitHub failed: the stored copy of an action, and when it was fetched from GitHub. */
runner.get("/runner/jobs/:jobId/action-mirror", async (c) => {
  const jobId = c.req.param("jobId");
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  const action = parseActionRef({ owner: c.req.query("owner"), repo: c.req.query("repo"), ref: c.req.query("ref") });
  if (!action) throw new HttpError(422, "invalid action");
  await repoStub(c.env, repoId).requireRunningJob(jobId, token);
  const obj = await c.env.BUCKET.get(mirrorKey(action));
  if (!obj) throw new HttpError(404, "no copy of this action");
  return new Response(obj.body, { headers: { "content-type": "application/gzip", "content-length": String(obj.size), "x-diffinery-fetched-at": obj.uploaded.toISOString() } });
});

// ---- OIDC id tokens (actions/core getIDToken compatible: GET ?audience= → { value })

const oidc = async (c: AppContext) => {
  const jobId = c.req.param("jobId")!;
  const { token, repoId } = jobAuth(c.req.raw, jobId);
  if (!c.env.OIDC_PRIVATE_KEY) throw new HttpError(501, "OIDC is not configured on this Diffinery instance");
  const claims = await repoStub(c.env, repoId).oidcClaims(jobId, token);
  if (!claims.allowed) throw new HttpError(403, "this job lacks permissions: id-token: write");
  const g = claims.github;
  const nowS = Math.floor(Date.now() / 1000);
  const value = await signEs256(JSON.parse(c.env.OIDC_PRIVATE_KEY), {
    iss: c.env.PUBLIC_URL,
    aud: c.req.query("audience") ?? c.env.PUBLIC_URL,
    // GitHub's forms: a job in an environment, a pull request, or a branch or tag.
    sub: g.environment ? `repo:${g.repository}:environment:${g.environment}` : g.event_name === "pull_request" ? `repo:${g.repository}:pull_request` : `repo:${g.repository}:ref:${g.ref}`,
    iat: nowS,
    nbf: nowS,
    exp: nowS + 600,
    repository: g.repository,
    repository_id: g.repository_id,
    repository_owner: g.repository_owner,
    repository_owner_id: g.repository_owner_id,
    actor_id: g.actor_id,
    environment: g.environment,
    // Diffinery's own claim: whether the code that runs came from an agent.
    agent_origin: g.agent_origin === "true",
    ref_type: g.ref_type,
    head_ref: g.head_ref || undefined,
    base_ref: g.base_ref || undefined,
    run_number: g.run_number,
    run_attempt: g.run_attempt,
    ref: g.ref,
    sha: g.sha,
    workflow: g.workflow,
    event_name: g.event_name,
    run_id: g.run_id,
    actor: g.actor,
    job_workflow_ref: g.workflow_ref,
  });
  return c.json({ value });
};
runner.get("/runner/jobs/:jobId/oidc", oidc);
runner.post("/runner/jobs/:jobId/oidc", oidc);
