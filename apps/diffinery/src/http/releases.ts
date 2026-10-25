import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import type { Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import type { Release } from "../repo/releases.js";
import { serveDownload } from "./files.js";
import { baseOf, ghAsset, ghRelease, pageOf, paginate, setLinks } from "./gh.js";
import { intParam, jsonBody, loadTarget, repoParams, type Stub } from "./ghctx.js";

/** Releases and release assets (GitHub REST: /repos/{owner}/{repo}/releases). */
export const releases = new Hono<{ Bindings: Env; Variables: AppVars }>();

type ReleaseBody = { tag_name?: string; target_commitish?: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean; make_latest?: "true" | "false" | "legacy" | boolean; generate_release_notes?: boolean; discussion_category_name?: string };

const R = "/repos/:owner/:repo/releases";

async function out(c: AppContext, repo: Repo, stub: Stub, list: Release[]) {
  const counts = (await stub.issueExtras([], list.map((r) => `release:${r.id}`))).reactions;
  return list.map((r) => ghRelease(baseOf(c), repo.owner_login, repo.name, r, counts[`release:${r.id}`]));
}

function input(b: ReleaseBody): ReleaseBody {
  for (const k of ["tag_name", "target_commitish"] as const) if (b[k] !== undefined && typeof b[k] !== "string") throw new HttpError(422, `${k} must be a string`, { errors: [{ resource: "Release", code: "invalid", field: k }] });
  if (b.body !== undefined && b.body !== null && typeof b.body !== "string") throw new HttpError(422, "body must be a string", { errors: [{ resource: "Release", code: "invalid", field: "body" }] });
  if (typeof b.body === "string" && b.body.length > 125_000) throw new HttpError(422, "body is too long (maximum is 125000 characters)", { errors: [{ resource: "Release", code: "custom", field: "body" }] });
  return { tag_name: b.tag_name, target_commitish: b.target_commitish, name: b.name, body: b.body, draft: b.draft === undefined ? undefined : !!b.draft, prerelease: b.prerelease === undefined ? undefined : !!b.prerelease, make_latest: b.make_latest, generate_release_notes: !!b.generate_release_notes };
}

releases.get(R, async (c) => {
  const { stub, caller, repo } = await loadTarget(c);
  const p = pageOf(c);
  const res = await stub.listReleases({ limit: p.perPage, offset: p.offset }, caller);
  setLinks(c, p, res.total);
  return c.json(await out(c, repo, stub, res.items));
});

releases.post(R, async (c) => {
  const { stub, caller, repo } = await loadTarget(c, "write");
  const rel = await stub.createRelease(input(await jsonBody<ReleaseBody>(c)), caller);
  return c.json((await out(c, repo, stub, [rel]))[0], 201);
});

releases.get(`${R}/latest`, async (c) => {
  const { stub, repo } = await loadTarget(c);
  return c.json((await out(c, repo, stub, [await stub.latestRelease()]))[0]);
});

releases.get(`${R}/tags/:tag{.+}`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c);
  return c.json((await out(c, repo, stub, [await stub.releaseByTag(c.req.param("tag"), caller)]))[0]);
});

releases.post(`${R}/generate-notes`, async (c) => {
  const { stub } = await loadTarget(c, "write");
  const b = await jsonBody<{ tag_name?: string; target_commitish?: string; previous_tag_name?: string; configuration_file_path?: string }>(c);
  if (typeof b.tag_name !== "string" || !b.tag_name) throw new HttpError(422, "tag_name is required", { errors: [{ resource: "Release", code: "missing_field", field: "tag_name" }] });
  return c.json(await stub.generateReleaseNotes({ tag_name: b.tag_name, target_commitish: b.target_commitish, previous_tag_name: b.previous_tag_name, configuration_file_path: b.configuration_file_path }));
});

// One asset: JSON, or the bytes with `Accept: application/octet-stream` (Octokit, `gh release download`).
releases.get(`${R}/assets/:id`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c);
  const id = intParam(c, "id");
  if ((c.req.header("accept") ?? "").includes("application/octet-stream")) {
    const d = await stub.releaseDownload({ assetId: id }, caller);
    return serveDownload(c, d.r2Key, d.name, d.contentType);
  }
  const asset = await stub.releaseAsset(id, caller);
  const rel = await stub.getRelease(asset.releaseId, caller);
  return c.json(ghAsset(baseOf(c), repo.owner_login, repo.name, rel.tagName, asset));
});

releases.patch(`${R}/assets/:id`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c, "write");
  const b = await jsonBody<{ name?: string; label?: string; state?: string }>(c);
  const asset = await stub.updateReleaseAsset(intParam(c, "id"), { name: typeof b.name === "string" ? b.name : undefined, label: typeof b.label === "string" ? b.label : undefined }, caller);
  const rel = await stub.getRelease(asset.releaseId, caller);
  return c.json(ghAsset(baseOf(c), repo.owner_login, repo.name, rel.tagName, asset));
});

releases.delete(`${R}/assets/:id`, async (c) => {
  const { stub, caller } = await loadTarget(c, "write");
  await stub.deleteReleaseAsset(intParam(c, "id"), caller);
  return c.body(null, 204);
});

releases.get(`${R}/:id`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c);
  return c.json((await out(c, repo, stub, [await stub.getRelease(intParam(c, "id"), caller)]))[0]);
});

releases.patch(`${R}/:id`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c, "write");
  const rel = await stub.updateRelease(intParam(c, "id"), input(await jsonBody<ReleaseBody>(c)), caller);
  return c.json((await out(c, repo, stub, [rel]))[0]);
});

releases.delete(`${R}/:id`, async (c) => {
  const { stub, caller } = await loadTarget(c, "write");
  await stub.deleteRelease(intParam(c, "id"), caller);
  return c.body(null, 204);
});

releases.get(`${R}/:id/assets`, async (c) => {
  const { stub, caller, repo } = await loadTarget(c);
  const id = intParam(c, "id");
  const rel = await stub.getRelease(id, caller);
  return c.json(paginate(c, (await stub.releaseAssets(id, caller)).map((a) => ghAsset(baseOf(c), repo.owner_login, repo.name, rel.tagName, a))));
});
