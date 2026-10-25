import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { HttpError, b64, fromB64 } from "../lib/util.js";
import type { SigInput, TreeInput } from "../repo/gitdata.js";
import { loadRepo } from "./common.js";
import { archiveResponse } from "./files.js";
import { baseOf, encPath, ghCommit, ghGitCommit, ghRef, nodeId, paginate, repoApi, repoHtml, sigJson } from "./gh.js";
import { jsonBody, loadTarget, repoParams } from "./ghctx.js";

/**
 * Git data API (blobs, trees, commits, annotated tags, refs) and the
 * repository extras next to it: README, merges, languages and archives.
 */
export const gitdata = new Hono<{ Bindings: Env; Variables: AppVars }>();

const R = "/repos/:owner/:repo";
const api = (c: AppContext) => repoApi(baseOf(c), repoParams(c).owner, repoParams(c).repo);
const wantsRaw = (c: AppContext) => /application\/vnd\.github(\.v3)?\.raw/.test(c.req.header("accept") ?? "");
const base64Lines = (bytes: Uint8Array) => b64(bytes).replace(/(.{60})/g, "$1\n");

// ---------------------------------------------------------------- blobs

gitdata.post(`${R}/git/blobs`, async (c) => {
  const { stub, caller } = await loadTarget(c, "write");
  const b = await jsonBody<{ content?: string; encoding?: string }>(c);
  if (typeof b.content !== "string") throw new HttpError(422, "content is required", { errors: [{ resource: "Blob", code: "missing_field", field: "content" }] });
  const encoding = (b.encoding ?? "utf-8").toLowerCase();
  let bytes: Uint8Array;
  if (encoding === "base64") {
    try {
      bytes = fromB64(b.content.replace(/\s+/g, ""));
    } catch {
      throw new HttpError(422, "content is not valid Base64", { errors: [{ resource: "Blob", code: "invalid", field: "content" }] });
    }
  } else if (encoding === "utf-8" || encoding === "utf8") bytes = new TextEncoder().encode(b.content);
  else throw new HttpError(422, "encoding must be utf-8 or base64", { errors: [{ resource: "Blob", code: "invalid", field: "encoding" }] });
  const blob = await stub.createBlob(bytes, caller);
  return c.json({ url: `${api(c)}/git/blobs/${blob.sha}`, sha: blob.sha }, 201);
});

gitdata.get(`${R}/git/blobs/:sha`, async (c) => {
  const { stub } = await loadTarget(c);
  const blob = await stub.getBlob(c.req.param("sha"));
  if (wantsRaw(c)) return new Response(blob.content, { headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" } });
  return c.json({ sha: blob.sha, node_id: nodeId("Blob", blob.sha), size: blob.size, url: `${api(c)}/git/blobs/${blob.sha}`, content: base64Lines(blob.content), encoding: "base64" });
});

// ---------------------------------------------------------------- trees

type Tree = { sha: string; tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>; truncated: boolean };
const treeJson = (c: AppContext, t: Tree) => ({
  sha: t.sha,
  url: `${api(c)}/git/trees/${t.sha}`,
  tree: t.tree.map((e) => ({ ...e, url: `${api(c)}/git/${e.type === "tree" ? "trees" : e.type === "blob" ? "blobs" : "commits"}/${e.sha}` })),
  truncated: t.truncated,
});

gitdata.post(`${R}/git/trees`, async (c) => {
  const { stub, caller } = await loadTarget(c, "write");
  const b = await jsonBody<{ base_tree?: string; tree?: TreeInput[] }>(c);
  if (!Array.isArray(b.tree)) throw new HttpError(422, "tree is required", { errors: [{ resource: "Tree", code: "missing_field", field: "tree" }] });
  if (b.tree.length > 10_000) throw new HttpError(422, "a tree request can change at most 10000 entries");
  const sha = await stub.createTree(typeof b.base_tree === "string" ? b.base_tree : undefined, b.tree, caller);
  return c.json(treeJson(c, await stub.getTree(sha, false)), 201);
});

gitdata.get(`${R}/git/trees/:sha{.+}`, async (c) => {
  const { stub } = await loadTarget(c);
  const recursive = !!c.req.query("recursive") && c.req.query("recursive") !== "0" && c.req.query("recursive") !== "false";
  return c.json(treeJson(c, await stub.getTree(c.req.param("sha"), recursive)));
});

// ---------------------------------------------------------------- commits

gitdata.post(`${R}/git/commits`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c, "write");
  const b = await jsonBody<{ message?: string; tree?: string; parents?: string[]; author?: SigInput; committer?: SigInput; signature?: string }>(c);
  const commit = await stub.createGitCommit(b, caller);
  return c.json(ghGitCommit(baseOf(c), repo.owner_login, repo.name, commit), 201);
});

gitdata.get(`${R}/git/commits/:sha`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  return c.json(ghGitCommit(baseOf(c), repo.owner_login, repo.name, await stub.gitCommit(c.req.param("sha"))));
});

// ---------------------------------------------------------------- annotated tags

type Tag = Awaited<ReturnType<Awaited<ReturnType<typeof loadRepo>>["stub"]["gitTag"]>>;
const tagJson = (c: AppContext, t: Tag) => ({
  node_id: nodeId("Tag", t.sha),
  tag: t.tag,
  sha: t.sha,
  url: `${api(c)}/git/tags/${t.sha}`,
  message: t.message,
  tagger: t.tagger ? sigJson(t.tagger) : null,
  object: { type: t.object.type, sha: t.object.sha, url: `${api(c)}/git/${t.object.type}s/${t.object.sha}` },
  verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
});

gitdata.post(`${R}/git/tags`, async (c) => {
  const { stub, caller } = await loadTarget(c, "write");
  const b = await jsonBody<{ tag?: string; message?: string; object?: string; type?: string; tagger?: SigInput }>(c);
  return c.json(tagJson(c, await stub.createGitTag(b, caller)), 201);
});

gitdata.get(`${R}/git/tags/:sha`, async (c) => {
  const { stub } = await loadTarget(c);
  return c.json(tagJson(c, await stub.gitTag(c.req.param("sha"))));
});

// ---------------------------------------------------------------- refs (single, matching, all)

gitdata.get(`${R}/git/ref/:ref{.+}`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  const name = `refs/${c.req.param("ref")}`;
  const r = (await stub.refsWithTypes(name)).find((x) => x.ref === name);
  if (!r) throw new HttpError(404, "Not Found");
  return c.json(ghRef(baseOf(c), repo.owner_login, repo.name, r));
});

gitdata.get(`${R}/git/matching-refs/:ref{.*}`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  const prefix = `refs/${(c.req.param("ref") ?? "")}`;
  const list = (await stub.refsWithTypes(prefix)).filter((r) => !r.ref.startsWith("refs/pull/") || prefix.startsWith("refs/pull/"));
  return c.json(paginate(c, list.map((r) => ghRef(baseOf(c), repo.owner_login, repo.name, r)), 100));
});

gitdata.get(`${R}/git/refs`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  const list = (await stub.refsWithTypes("refs/")).filter((r) => !r.ref.startsWith("refs/pull/"));
  return c.json(paginate(c, list.map((r) => ghRef(baseOf(c), repo.owner_login, repo.name, r)), 100));
});

// ---------------------------------------------------------------- README

async function readme(c: AppContext) {
  const { stub, repo } = await loadTarget(c);
  const ref = c.req.query("ref") || repo.default_branch;
  const dir = (c.req.param("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const r = await stub.readme(ref, dir);
  if (!r) throw new HttpError(404, "Not Found");
  if (wantsRaw(c)) return new Response(r.content, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
  const html = repoHtml(baseOf(c), repo.owner_login, repo.name);
  const self = `${api(c)}/contents/${encPath(r.path)}?ref=${encodeURIComponent(ref)}`;
  const git = `${api(c)}/git/blobs/${r.sha}`;
  const htmlUrl = `${html}/blob/${encPath(ref)}/${encPath(r.path)}`;
  return c.json({
    type: "file",
    encoding: "base64",
    size: r.size,
    name: r.path.split("/").pop(),
    path: r.path,
    content: base64Lines(r.content),
    sha: r.sha,
    url: self,
    git_url: git,
    html_url: htmlUrl,
    download_url: `${html}/raw/${encPath(ref)}/${encPath(r.path)}`,
    _links: { self, git, html: htmlUrl },
  });
}
gitdata.get(`${R}/readme`, readme);
gitdata.get(`${R}/readme/:dir{.+}`, readme);

// ---------------------------------------------------------------- merges, languages, archives

gitdata.post(`${R}/merges`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c, "write");
  const b = await jsonBody<{ base?: string; head?: string; commit_message?: string }>(c);
  if (typeof b.base !== "string" || typeof b.head !== "string") throw new HttpError(422, "base and head are required", { errors: [{ resource: "Merge", code: "missing_field", field: typeof b.base !== "string" ? "base" : "head" }] });
  const commit = await stub.mergeBranches(b, caller);
  if (!commit) return c.body(null, 204);
  return c.json(ghCommit(baseOf(c), repo.owner_login, repo.name, commit), 201);
});

gitdata.get(`${R}/languages`, async (c) => {
  const { stub } = await loadTarget(c);
  return c.json(await stub.languages());
});

for (const [path, format] of [
  ["zipball", "zip"],
  ["tarball", "tar.gz"],
] as const) {
  const handler = async (c: AppContext) => {
    const { stub, repo } = await loadTarget(c);
    return archiveResponse(c, stub, repo.owner_login, repo.name, (c.req.param("ref") ?? "") || repo.default_branch, format);
  };
  gitdata.get(`${R}/${path}`, handler);
  gitdata.get(`${R}/${path}/:ref{.+}`, handler);
}
