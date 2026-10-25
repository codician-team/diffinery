import { mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobCompletion, JobSpec, LogLine, StepReport, StepSpec } from "@diffinery/shared";

export interface FakeApi {
  url: string;
  token: string;
  logs: LogLine[];
  steps: Array<{ index: number; report: StepReport }>;
  completion: JobCompletion | null;
  /** Runtime token the fake results service accepts (run "1", job "job-1"). */
  runtimeToken: string;
  /** Cache entries by key (version in `cacheVersions`). */
  cache: Map<string, Buffer>;
  cacheVersions: Map<string, string>;
  /** The Range header of each blob GET ("" for none). */
  blobGets: string[];
  /** How many ranged blob GETs past the first range still answer as if the blob had changed (another ETag). */
  blobChanges: number;
  /** Finalized artifacts of the run, by name. */
  artifacts: Map<string, { id: number; body: Buffer; mimeType: string; hash?: string }>;
  requests: Array<{ method: string; path: string; auth: string | undefined; runner?: string }>;
  /** Fail the next N log POSTs with 503 (to test retries). */
  failLogs: number;
  specs: Map<string, JobSpec>;
  close(): Promise<void>;
  logText(step?: number): string;
  lastReport(index: number): StepReport | undefined;
}

export async function startFakeApi(token = "job-token-123"): Promise<FakeApi> {
  const api: FakeApi = {
    url: "",
    token,
    logs: [],
    steps: [],
    completion: null,
    runtimeToken: fakeRuntimeToken(),
    cache: new Map(),
    cacheVersions: new Map(),
    blobGets: [],
    blobChanges: 0,
    artifacts: new Map(),
    requests: [],
    failLogs: 0,
    specs: new Map(),
    close: async () => {},
    logText(step?: number) {
      return this.logs
        .filter((l) => step === undefined || l.step === step)
        .map((l) => l.text)
        .join("\n");
    },
    lastReport(index: number) {
      return [...this.steps].reverse().find((s) => s.index === index)?.report;
    },
  };
  // A minimal Actions results service: the Twirp cache/artifact services and their blob URLs.
  const pending = new Map<string, { kind: "cache" | "artifact"; name: string; version?: string; mimeType?: string; body?: Buffer }>();
  let nextId = 1;
  const runtime = (method: string, u: URL, headers: IncomingHttpHeaders, body: Buffer, res: ServerResponse, json: (s: number, v: unknown) => void) => {
    const blob = /^\/_runtime\/blob\/([^/]+)$/.exec(u.pathname);
    if (blob) {
      const id = decodeURIComponent(blob[1]!);
      if (method === "PUT") {
        const p = pending.get(id);
        if (!p || headers["x-ms-blob-type"] !== "BlockBlob") return json(400, {});
        p.body = body;
        res.writeHead(201);
        return res.end();
      }
      const art = [...api.artifacts.values()].find((a) => String(a.id) === id);
      const b = art?.body ?? api.cache.get(id);
      if (!b) return json(404, {});
      api.blobGets.push(String(headers.range ?? ""));
      // Ranged reads, like Diffinery's blob store.
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(headers.range ?? ""));
      const type = { "content-type": art?.mimeType ?? "application/octet-stream", etag: '"e1"', "accept-ranges": "bytes" };
      if (range && b.length === 0) {
        res.writeHead(416, { "content-range": "bytes */0" });
        return res.end();
      }
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), b.length - 1);
        if (start > 0 && api.blobChanges > 0) {
          api.blobChanges--;
          type.etag = '"e2"';
        }
        res.writeHead(206, { ...type, "content-range": `bytes ${start}-${end}/${b.length}` });
        return res.end(b.subarray(start, end + 1));
      }
      res.writeHead(200, type);
      return res.end(b);
    }
    if (headers.authorization !== `Bearer ${api.runtimeToken}`) return json(401, { code: "unauthenticated", msg: "bad token" });
    const req = JSON.parse(body.toString() || "{}") as Record<string, string | string[] | undefined>;
    const blobUrl = (id: string) => `${api.url}/_runtime/blob/${encodeURIComponent(id)}?sig=x`;
    switch (u.pathname.replace("/twirp/github.actions.results.api.v1.", "")) {
      case "CacheService/GetCacheEntryDownloadURL": {
        const keys = [...api.cache.keys()].filter((k) => api.cacheVersions.get(k) === req.version);
        const hit = keys.find((k) => k === req.key) ?? ((req.restore_keys ?? []) as string[]).map((p) => keys.find((k) => k.startsWith(p))).find(Boolean);
        return json(200, hit ? { ok: true, matched_key: hit, signed_download_url: blobUrl(hit) } : { ok: false });
      }
      case "CacheService/CreateCacheEntry": {
        if (api.cache.has(String(req.key))) return json(409, { code: "already_exists", msg: "cache entry already exists" });
        const id = `upload-${nextId++}`;
        pending.set(id, { kind: "cache", name: String(req.key), version: String(req.version) });
        return json(200, { ok: true, signed_upload_url: blobUrl(id) });
      }
      case "CacheService/FinalizeCacheEntryUpload": {
        const [id, p] = [...pending].find(([, p]) => p.kind === "cache" && p.name === req.key) ?? [];
        if (!id || !p?.body) return json(404, { code: "not_found", msg: "no upload" });
        pending.delete(id);
        api.cache.set(p.name, p.body);
        api.cacheVersions.set(p.name, p.version!);
        return json(200, { ok: true, entry_id: String(nextId++) });
      }
      case "ArtifactService/CreateArtifact": {
        if (api.artifacts.has(String(req.name))) return json(409, { code: "already_exists", msg: "artifact exists" });
        const id = `upload-${nextId++}`;
        pending.set(id, { kind: "artifact", name: String(req.name), mimeType: String(req.mime_type ?? "application/zip") });
        return json(200, { ok: true, signed_upload_url: blobUrl(id) });
      }
      case "ArtifactService/FinalizeArtifact": {
        const [id, p] = [...pending].find(([, p]) => p.kind === "artifact" && p.name === req.name) ?? [];
        if (!id || !p?.body) return json(404, { code: "not_found", msg: "no upload" });
        pending.delete(id);
        const artifactId = nextId++;
        api.artifacts.set(p.name, { id: artifactId, body: p.body, mimeType: p.mimeType!, hash: req.hash as string | undefined });
        return json(200, { ok: true, artifact_id: String(artifactId) });
      }
      case "ArtifactService/ListArtifacts":
        return json(200, {
          artifacts: [...api.artifacts]
            .filter(([n]) => !req.name_filter || n === req.name_filter)
            .map(([name, a]) => ({
              workflow_run_backend_id: "1",
              workflow_job_run_backend_id: "job-1",
              database_id: String(a.id),
              name,
              size: String(a.body.length),
              digest: a.hash?.replace(/^sha256:/, ""),
              created_at: new Date().toISOString(),
            })),
        });
      case "ArtifactService/GetSignedArtifactURL": {
        const a = api.artifacts.get(String(req.name));
        return a ? json(200, { signed_url: blobUrl(String(a.id)) }) : json(404, { code: "not_found", msg: "no artifact" });
      }
      case "ArtifactService/DeleteArtifact": {
        const a = api.artifacts.get(String(req.name));
        if (!a) return json(404, { code: "not_found", msg: "no artifact" });
        api.artifacts.delete(String(req.name));
        return json(200, { ok: true, artifact_id: String(a.id) });
      }
    }
    return json(404, { code: "bad_route", msg: "no such method" });
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url ?? "/", "http://x");
    api.requests.push({ method: req.method!, path: u.pathname + u.search, auth: req.headers.authorization, runner: req.headers["x-diffinery-runner"] as string | undefined });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (u.pathname.startsWith("/twirp/") || u.pathname.startsWith("/_runtime/blob/")) return runtime(req.method!, u, req.headers, body, res, json);
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
    const m = /^\/runner\/jobs\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(404, {});
    const sub = m[2] ?? "";
    if (sub === "" && req.method === "GET") {
      const s = api.specs.get(decodeURIComponent(m[1]!));
      return s ? json(200, s) : json(404, {});
    }
    if (sub === "/logs" && req.method === "POST") {
      if (api.failLogs > 0) {
        api.failLogs--;
        return json(503, { error: "try later" });
      }
      api.logs.push(...(JSON.parse(body.toString()) as { lines: LogLine[] }).lines);
      return json(200, {});
    }
    const sm = /^\/steps\/(\d+)$/.exec(sub);
    if (sm && req.method === "POST") {
      api.steps.push({ index: Number(sm[1]), report: JSON.parse(body.toString()) as StepReport });
      return json(200, {});
    }
    if (sub === "/complete" && req.method === "POST") {
      api.completion = JSON.parse(body.toString()) as JobCompletion;
      return json(200, {});
    }
    if (sub === "/oidc") return json(200, { value: `oidc-for-${u.searchParams.get("audience")}` });
    return json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise<void>((r) => server.close(() => r()));
  return api;
}

/** A runtime token shaped like the server's: its scope names run "1" and job "job-1". */
function fakeRuntimeToken(): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ scp: "Actions.GenericRead:1 Actions.Results:1:job-1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

export function tmp(prefix = "runner-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function makeSpec(api: FakeApi, steps: StepSpec[], over: Partial<JobSpec> = {}): JobSpec {
  return {
    runId: "run-1",
    jobId: "job-1",
    jobKey: "build",
    name: "build",
    repo: { owner: "acme", name: "widgets", cloneUrl: "http://invalid.test/acme/widgets.git", defaultBranch: "main" },
    sha: "0123456789abcdef0123456789abcdef01234567",
    ref: "refs/heads/main",
    workflowPath: ".github/workflows/ci.yml",
    github: { event_name: "push", actor: "octo", event: { ref: "refs/heads/main", pusher: { name: "octo" } } },
    env: {},
    matrix: {},
    strategy: { "fail-fast": true, "job-index": 0, "job-total": 1 },
    needs: {},
    inputs: {},
    vars: {},
    secrets: {},
    outputs: {},
    steps,
    timeoutMinutes: 10,
    continueOnError: false,
    idToken: false,
    apiUrl: api.url,
    token: api.token,
    runtime: { token: api.runtimeToken, resultsUrl: `${api.url}/`, cacheUrl: `${api.url}/_runtime/`, runtimeUrl: `${api.url}/_runtime/` },
    ...over,
  };
}
