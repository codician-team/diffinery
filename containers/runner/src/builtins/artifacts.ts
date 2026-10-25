import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { errMsg, failure, StepFailure } from "../job.js";
import { RuntimeError, type RuntimeClient } from "../runtime.js";
import { globPaths, truthyInput } from "../util.js";
import { extractZip, sha256File, writeZip } from "../zip.js";
import type { Builtin, BuiltinContext } from "./index.js";

/**
 * actions/upload-artifact and actions/download-artifact (v4 and later), on the
 * artifact service the official actions use: the same zip layout, names, ids,
 * digests and options, so artifacts move freely between built-in and real
 * actions, jobs and runs.
 */

const MIME: Record<string, string> = {
  ".txt": "text/plain", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".csv": "text/csv", ".xml": "text/xml", ".md": "text/markdown",
  ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp", ".tiff": "image/tiff", ".tif": "image/tiff",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac", ".mp4": "video/mp4", ".webm": "video/webm", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
  ".pdf": "application/pdf", ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip", ".rar": "application/vnd.rar", ".7z": "application/x-7z-compressed",
  ".wasm": "application/wasm", ".yaml": "application/x-yaml", ".yml": "application/x-yaml", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

export const mimeTypeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

const INVALID_NAME_CHARS = ['"', ":", "<", ">", "|", "*", "?", "\r", "\n", "\\", "/"];
const INVALID_PATH_CHARS = ['"', ":", "<", ">", "|", "*", "?", "\r", "\n"];

/** The action's major version (`@v4` -> 4); builtins only run for known majors. */
function major(c: BuiltinContext): number {
  return Number(/@v?(\d+)/.exec(c.uses)?.[1] ?? 99);
}

/** The run and job ids the artifact service expects, from the runtime token's `scp` claim. */
export function backendIds(token: string): { run: string; job: string } {
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { scp?: string };
  for (const scope of (payload.scp ?? "").split(" ")) {
    const parts = scope.split(":");
    if (parts[0] === "Actions.Results" && parts.length === 3) return { run: parts[1]!, job: parts[2]! };
  }
  throw new Error("the runtime token has no Actions.Results scope");
}

function runtimeFor(c: BuiltinContext): RuntimeClient {
  if (!c.job.runtime) throw failure("The artifact service is not available to this job.");
  return c.job.runtime;
}

// ---------------------------------------------------------------- search (like upload-artifact's findFilesToUpload)

const hasGlob = (s: string) => /[*?[]/.test(s);

/** @actions/glob's search path of a pattern: its longest literal directory prefix. */
function searchPathOf(abs: string): string {
  const norm = path.normalize(abs).replace(/\/+$/, "") || "/";
  if (!hasGlob(norm)) return norm;
  const parts = norm.split("/");
  const lit: string[] = [];
  for (const p of parts) {
    if (hasGlob(p)) break;
    lit.push(p);
  }
  return lit.join("/") || "/";
}

function lca(paths: string[]): string {
  let parts = paths[0]!.split("/");
  for (const p of paths.slice(1)) {
    const q = p.split("/");
    let i = 0;
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join("/") || "/";
}

export function findFilesToUpload(workspace: string, searchPath: string, includeHidden: boolean): { files: string[]; root: string } {
  const lines = searchPath
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const expand = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p);
  const negations = lines.filter((l) => l.startsWith("!")).map((l) => "!" + path.resolve(workspace, expand(l.slice(1).trim())));
  const includes = lines.filter((l) => !l.startsWith("!")).map((l) => path.resolve(workspace, expand(l)));
  // Search paths, minus those inside another one (as @actions/glob does).
  const candidates = includes.map(searchPathOf);
  const roots: string[] = [];
  for (const s of candidates) {
    if (roots.includes(s)) continue;
    if (candidates.some((o) => o !== s && (s.startsWith(o + "/") || o === "/"))) continue;
    roots.push(s);
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const inc of includes) {
    const root = searchPathOf(inc);
    for (const f of globPaths(workspace, [inc, ...negations], { filesOnly: true })) {
      if (seen.has(f)) continue;
      // Hidden: the search path's own name or anything below it starts with a dot.
      const rel = path.relative(path.dirname(root), f).split("/");
      if (!includeHidden && rel.some((s) => s.startsWith(".") && s !== ".." && s !== ".")) continue;
      seen.add(f);
      files.push(f);
    }
  }
  let root: string;
  if (roots.length > 1) root = lca(roots);
  else if (files.length === 1 && roots[0] === files[0]) root = path.dirname(files[0]!);
  else root = roots[0] ?? workspace;
  return { files, root };
}

// ---------------------------------------------------------------- upload

export const artifactUpload: Builtin = async (c) => {
  const searchPath = c.input("path");
  if (!searchPath) throw failure("Input required and not supplied: path");
  const ifNone = c.input("if-no-files-found", "warn").toLowerCase();
  if (!["warn", "error", "ignore"].includes(ifNone)) throw failure(`Unrecognized if-no-files-found input. Provided: ${ifNone}. Available options: warn,error,ignore`);
  const archive = truthyInput(c.input("archive"), true);
  const retentionRaw = c.input("retention-days");
  const retentionDays = retentionRaw ? parseInt(retentionRaw, 10) : undefined;
  if (retentionDays !== undefined && Number.isNaN(retentionDays)) throw failure("Invalid retention-days");
  const levelRaw = c.input("compression-level");
  const level = levelRaw ? parseInt(levelRaw, 10) : 6;
  if (Number.isNaN(level)) throw failure("Invalid compression-level");
  if (level < 0 || level > 9) throw failure("Invalid compression-level. Valid values are 0-9");

  const { files, root } = findFilesToUpload(c.job.workspace, searchPath, truthyInput(c.input("include-hidden-files"), false));
  if (files.length === 0) {
    const msg = `No files were found with the provided path: ${searchPath}. No artifacts will be uploaded.`;
    if (ifNone === "error") throw failure(msg);
    if (ifNone === "warn") c.warn(msg);
    else c.log(msg);
    return;
  }
  c.log(`With the provided path, there will be ${files.length} file${files.length === 1 ? "" : "s"} uploaded`);
  if (!archive && files.length > 1) throw failure(`When 'archive' is set to false, only a single file can be uploaded. Found ${files.length} files to upload.`);
  const rt = runtimeFor(c);
  const name = archive ? c.input("name", "artifact") : path.basename(files[0]!);
  const bad = INVALID_NAME_CHARS.find((ch) => name.includes(ch));
  if (!name || bad) throw failure(`The artifact name is not valid: ${name}. Contains the following character: ${JSON.stringify(bad ?? "")}`);
  const ids = backendIds(rt.token);

  if (truthyInput(c.input("overwrite"), false)) {
    try {
      await rt.twirp("ArtifactService", "DeleteArtifact", { workflow_run_backend_id: ids.run, workflow_job_run_backend_id: ids.job, name });
    } catch (e) {
      if (!(e instanceof RuntimeError && e.status === 404)) c.log(`Unable to delete artifact: ${errMsg(e)}`);
    }
  }

  const entries = files.map((f) => {
    const name = path.relative(root, f);
    const badChar = INVALID_PATH_CHARS.find((ch) => name.includes(ch));
    if (badChar) throw failure(`The path for one of the files in artifact is not valid: ${name}. Contains the following character: ${JSON.stringify(badChar)}`);
    return { source: f, name };
  });

  const req: Record<string, unknown> = {
    workflow_run_backend_id: ids.run,
    workflow_job_run_backend_id: ids.job,
    name,
    version: 7,
    mime_type: archive ? "application/zip" : mimeTypeOf(files[0]!),
  };
  if (retentionDays) {
    const max = Number(process.env.GITHUB_RETENTION_DAYS ?? c.envCtx.GITHUB_RETENTION_DAYS ?? 90) || 90;
    let days = retentionDays;
    if (days > max) {
      c.warn(`Retention days cannot be greater than the maximum allowed retention set within the repository. Using ${max} instead.`);
      days = max;
    }
    req.expires_at = new Date(Date.now() + days * 86400_000).toISOString();
  }

  const work = path.join(c.job.tempDir, `artifact-${randomUUID()}`);
  try {
    let created: { ok: boolean; signed_upload_url?: string };
    try {
      created = await rt.twirp("ArtifactService", "CreateArtifact", req);
    } catch (e) {
      if (e instanceof RuntimeError && e.status === 409) throw failure(`Failed to CreateArtifact: an artifact with the name '${name}' already exists on the workflow run. Set 'overwrite: true' to replace it.`);
      throw e;
    }
    if (!created.ok || !created.signed_upload_url) throw failure("CreateArtifact: response from backend was not ok");
    await mkdir(work, { recursive: true });
    let file: string;
    let digest: string;
    if (archive) {
      file = path.join(work, `${name}.zip`);
      digest = (await writeZip(file, entries, level)).sha256;
    } else {
      file = files[0]!;
      digest = await sha256File(file);
    }
    c.log(`Uploading artifact: ${archive ? `${name}.zip` : name}`);
    const size = await rt.upload(created.signed_upload_url, file, req.mime_type as string);
    c.log("Finalizing artifact upload");
    const done = await rt.twirp<{ ok: boolean; artifact_id?: string }>("ArtifactService", "FinalizeArtifact", {
      workflow_run_backend_id: ids.run,
      workflow_job_run_backend_id: ids.job,
      name,
      size: String(size),
      hash: `sha256:${digest}`,
    });
    if (!done.ok || !done.artifact_id) throw failure("FinalizeArtifact: response from backend was not ok");
    c.log(`Artifact ${name} has been successfully uploaded! Final size is ${size} bytes. Artifact ID is ${done.artifact_id}`);
    c.setOutput("artifact-id", done.artifact_id);
    c.setOutput("artifact-digest", digest);
    const env = c.toolEnv();
    const url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/artifacts/${done.artifact_id}`;
    c.log(`Artifact download URL: ${url}`);
    c.setOutput("artifact-url", url);
  } catch (e) {
    if (e instanceof StepFailure) throw e;
    throw failure(`Failed to upload artifact '${name}': ${errMsg(e)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------- download

interface Listed {
  id: number;
  name: string;
  size: number;
  digest?: string;
  createdAt?: string;
}

/** Keeps the newest artifact of each name (the toolkit's `latest: true`). */
function latest(list: Listed[]): Listed[] {
  const out = new Map<string, Listed>();
  for (const a of [...list].sort((x, y) => y.id - x.id)) if (!out.has(a.name)) out.set(a.name, a);
  return [...out.values()];
}

/** Minimatch-style match of an artifact name: `*`, `**`, `?`, `[...]` and `{a,b}`. */
export function nameMatches(pattern: string, name: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${pattern
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
          .join("|")})`;
        i = end;
      }
    } else re += ch.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(name);
}

interface Source {
  list(): Promise<Listed[]>;
  /** Downloads artifact `a` to `file`; returns the response's content type and file name. */
  fetch(a: Listed, file: string): Promise<{ contentType: string; fileName: string | null; url: string }>;
}

/** Artifacts of the job's own run, through the artifact service. */
function ownRun(c: BuiltinContext): Source {
  const rt = runtimeFor(c);
  const ids = backendIds(rt.token);
  const base = { workflow_run_backend_id: ids.run, workflow_job_run_backend_id: ids.job };
  return {
    async list() {
      const r = await rt.twirp<{ artifacts?: Array<{ database_id: string; name: string; size: string; created_at?: string; digest?: string }> }>("ArtifactService", "ListArtifacts", base);
      return (r.artifacts ?? []).map((a) => ({ id: Number(a.database_id), name: a.name, size: Number(a.size), createdAt: a.created_at, digest: a.digest }));
    },
    async fetch(a, file) {
      const { signed_url } = await rt.twirp<{ signed_url: string }>("ArtifactService", "GetSignedArtifactURL", { ...base, name: a.name });
      return { ...(await rt.download(signed_url, file)), url: signed_url };
    },
  };
}

/** Another run's (or repository's) artifacts, through the REST API with `github-token`. */
function otherRun(c: BuiltinContext, token: string, repository: string, runId: string): Source {
  const env = c.toolEnv();
  const api = (env.GITHUB_API_URL ?? `${c.job.spec.apiUrl.replace(/\/$/, "")}/api/v3`).replace(/\/$/, "");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw failure(`Invalid repository: '${repository}'. Must be in format owner/repo`);
  if (!/^\d+$/.test(runId)) throw failure(`Invalid run-id: '${runId}'`);
  c.job.masker.add(token);
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "diffinery-runner" };
  const base = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
  return {
    async list() {
      const out: Listed[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await fetch(`${base}/runs/${runId}/artifacts?per_page=100&page=${page}`, { headers });
        if (!res.ok) throw new Error(`Listing artifacts of run ${runId} in ${repository} failed: HTTP ${res.status}`);
        const j = (await res.json()) as { total_count: number; artifacts: Array<{ id: number; name: string; size_in_bytes: number; digest?: string | null; created_at?: string }> };
        for (const a of j.artifacts) out.push({ id: a.id, name: a.name, size: a.size_in_bytes, digest: a.digest ?? undefined, createdAt: a.created_at });
        if (out.length >= j.total_count || j.artifacts.length === 0) break;
      }
      return out;
    },
    async fetch(a, file) {
      const res = await fetch(`${base}/artifacts/${a.id}/zip`, { headers, redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status !== 302 || !location) throw new Error(`Unable to download artifact ${a.id}: HTTP ${res.status}`);
      return { ...(await runtimeFor(c).download(location, file)), url: location };
    },
  };
}

export const artifactDownload: Builtin = async (c) => {
  const v = major(c);
  const name = c.input("name");
  const pattern = c.input("pattern");
  const idsInput = c.input("artifact-ids");
  const merge = truthyInput(c.input("merge-multiple"), false);
  const skipDecompress = truthyInput(c.input("skip-decompress"), false);
  const onMismatch = (c.input("digest-mismatch") || (v >= 8 ? "error" : "warn")).toLowerCase();
  if (!["ignore", "info", "warn", "error"].includes(onMismatch)) throw failure(`Invalid value for 'digest-mismatch': '${onMismatch}'. Valid options are: ignore, info, warn, error`);
  if (name && idsInput) throw failure("Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.");
  let dest = c.input("path") || c.job.workspace;
  if (dest.startsWith("~")) dest = dest.replace("~", homedir());
  const resolved = path.resolve(c.job.workspace, dest);
  const token = c.input("github-token");
  const source = token ? otherRun(c, token, c.input("repository", `${c.job.spec.repo.owner}/${c.job.spec.repo.name}`), c.input("run-id")) : ownRun(c);

  let artifacts: Listed[];
  try {
    const all = latest(await source.list());
    if (name) {
      const a = all.find((x) => x.name === name);
      if (!a) throw failure(`Unable to download artifact(s): Artifact not found for name: ${name}
        Please ensure that your artifact is not expired and the artifact was uploaded using a compatible version of toolkit/upload-artifact.
        For more information, visit the GitHub Artifacts FAQ: https://github.com/actions/toolkit/blob/main/packages/artifact/docs/faq.md`);
      artifacts = [a];
    } else if (idsInput) {
      const wanted = idsInput.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const n = parseInt(s, 10);
        if (Number.isNaN(n)) throw failure(`Invalid artifact ID: '${s}'. Must be a number.`);
        return n;
      });
      if (!wanted.length) throw failure("No valid artifact IDs provided in 'artifact-ids' input");
      artifacts = all.filter((a) => wanted.includes(a.id));
      if (!artifacts.length) throw failure("None of the provided artifact IDs were found");
      const missing = wanted.filter((id) => !artifacts.some((a) => a.id === id));
      if (missing.length) c.warn(`Could not find the following artifact IDs: ${missing.join(", ")}`);
    } else {
      artifacts = pattern ? all.filter((a) => nameMatches(pattern, a.name)) : all;
      if (pattern) c.log(`Filtering artifacts by pattern '${pattern}'`);
      else c.log("No input name, artifact-ids or pattern filtered specified, downloading all artifacts");
    }
  } catch (e) {
    if (e instanceof StepFailure) throw e;
    throw failure(`Unable to download artifact(s): ${errMsg(e)}`);
  }
  if (artifacts.length) {
    c.log("Preparing to download the following artifacts:");
    for (const a of artifacts) c.log(`- ${a.name} (ID: ${a.id}, Size: ${a.size}, Expected Digest: ${a.digest})`);
  }

  const single = !!name || merge || (v >= 5 && artifacts.length === 1);
  const mismatches: string[] = [];
  const work = path.join(c.job.tempDir, `download-${randomUUID()}`);
  try {
    await mkdir(work, { recursive: true });
    for (const a of artifacts) {
      const into = single ? resolved : path.join(resolved, a.name);
      await mkdir(into, { recursive: true });
      const file = path.join(work, String(a.id));
      let got: { contentType: string; fileName: string | null; url: string };
      try {
        got = await source.fetch(a, file);
      } catch (e) {
        throw failure(`Unable to download artifact(s): ${errMsg(e)}`);
      }
      const digest = `sha256:${await sha256File(file)}`;
      if (a.digest && a.digest !== digest) {
        mismatches.push(a.name);
        const msg = `Artifact '${a.name}' digest validation failed. Please verify the integrity of the artifact.`;
        if (onMismatch === "warn") c.warn(msg);
        else if (onMismatch === "info") c.log(msg);
      }
      const isZip = ["application/zip", "application/x-zip-compressed", "application/zip-compressed"].includes(got.contentType) || new URL(got.url).pathname.toLowerCase().endsWith(".zip");
      if (isZip && !skipDecompress) await extractZip(file, into);
      else {
        const fileName = path.basename(got.fileName || (isZip ? `${a.name}.zip` : a.name) || "artifact");
        c.log(`Downloading raw file (non-zip) to: ${path.join(into, fileName)}`);
        await copyFile(file, path.join(into, fileName));
      }
      await rm(file, { force: true });
      c.log(`Artifact '${a.name}' downloaded to ${into}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (mismatches.length && onMismatch === "error") throw failure(`Digest validation failed for artifact(s): ${mismatches.join(", ")}. Use 'digest-mismatch: warn' to continue on mismatch.`);
  c.log(`Total of ${artifacts.length} artifact(s) downloaded`);
  c.setOutput("download-path", resolved);
  c.log("Download artifact has finished successfully");
};

