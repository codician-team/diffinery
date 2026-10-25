import type { AppContext } from "../auth/principal.js";
import { HttpError, fromB64 } from "../lib/util.js";
import type { Release } from "../repo/releases.js";
import type { Role } from "../repo/types.js";
import { loadRepo } from "../http/common.js";
import { storeAsset } from "../http/files.js";
import { baseOf, repoHtml } from "../http/gh.js";
import type { Tool } from "./server.js";

/**
 * MCP tools for releases: list, read, create, edit, upload assets and draft
 * notes. They run through the same permission checks as the REST API
 * (writers create and edit; drafts stay hidden from readers).
 */

type Args = Record<string, unknown>;

const MAX_MCP_ASSET_BYTES = 25 * 1024 * 1024;

const str = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || v === "") throw new HttpError(422, `${k} is required`);
  return v;
};
const optStr = (a: Args, k: string) => (typeof a[k] === "string" && a[k] !== "" ? (a[k] as string) : undefined);
const optBool = (a: Args, k: string) => {
  if (a[k] === undefined || a[k] === null) return undefined;
  if (typeof a[k] !== "boolean") throw new HttpError(422, `${k} must be a boolean`);
  return a[k] as boolean;
};
const id = (a: Args, k: string) => {
  const n = Number(a[k]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(422, `${k} must be a positive integer`);
  return n;
};
// A transferred or renamed repository is served under its old owner/name too.
const repoOf = (c: AppContext, a: Args, min: Role = "read") => loadRepo(c, str(a, "owner"), str(a, "repo"), min, { follow: true });
const OWNER_REPO = {
  owner: { type: "string", description: "Repository owner (user or org login)" },
  repo: { type: "string", description: "Repository name" },
};

function out(c: AppContext, a: Args, r: Release) {
  const html = `${repoHtml(baseOf(c), str(a, "owner"), str(a, "repo"))}/releases/tag/${encodeURIComponent(r.tagName)}`;
  return {
    id: r.id,
    tag_name: r.tagName,
    target_commitish: r.targetCommitish,
    name: r.name,
    body: r.body,
    draft: r.draft,
    prerelease: r.prerelease,
    latest: r.latest,
    author: r.author.login,
    created_at: r.createdAt,
    published_at: r.publishedAt,
    html_url: html,
    assets: r.assets.map((x) => ({ id: x.id, name: x.name, label: x.label, content_type: x.contentType, size: x.size, download_count: x.downloadCount, download_url: `${repoHtml(baseOf(c), str(a, "owner"), str(a, "repo"))}/releases/download/${encodeURIComponent(r.tagName)}/${encodeURIComponent(x.name)}` })),
  };
}

const RELEASE_FIELDS = {
  name: { type: "string", description: "Release title" },
  body: { type: "string", description: "Release notes (Markdown)" },
  draft: { type: "boolean", description: "Keep it as a draft, visible to writers only" },
  prerelease: { type: "boolean" },
  make_latest: { type: "string", enum: ["true", "false", "legacy"], description: "Whether this becomes the latest release (default true)" },
};

const makeLatest = (a: Args) => {
  const v = optStr(a, "make_latest");
  if (v === undefined) return undefined;
  if (v !== "true" && v !== "false" && v !== "legacy") throw new HttpError(422, "make_latest must be true, false or legacy");
  return v;
};

export const RELEASE_TOOLS: Record<string, Tool> = {
  list_releases: {
    description: "List a repository's releases, newest first. Drafts are included only for writers.",
    input: { ...OWNER_REPO, limit: { type: "number", description: "At most this many (default 30, max 100)" } },
    required: ["owner", "repo"],
    readOnly: true,
    run: async (c, a) => {
      const { stub, caller } = await repoOf(c, a);
      const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 100);
      const res = await stub.listReleases({ limit, offset: 0 }, caller);
      return { total: res.total, releases: res.items.map((r) => out(c, a, r)) };
    },
  },
  get_release: {
    description: "Get a release by tag, by id, or the latest release when neither is given.",
    input: { ...OWNER_REPO, tag: { type: "string" }, id: { type: "number" } },
    required: ["owner", "repo"],
    readOnly: true,
    run: async (c, a) => {
      const { stub, caller } = await repoOf(c, a);
      const tag = optStr(a, "tag");
      const r = tag ? await stub.releaseByTag(tag, caller, true) : a.id !== undefined ? await stub.getRelease(id(a, "id"), caller) : await stub.latestRelease();
      return out(c, a, r);
    },
  },
  create_release: {
    description: "Create a release. Creates the tag at target_commitish (default branch by default) when it doesn't exist yet.",
    input: { ...OWNER_REPO, tag_name: { type: "string" }, target_commitish: { type: "string", description: "Branch or commit for a new tag" }, ...RELEASE_FIELDS, generate_release_notes: { type: "boolean", description: "Fill in notes from merged pull requests since the previous release" } },
    required: ["owner", "repo", "tag_name"],
    run: async (c, a) => {
      const { stub, caller } = await repoOf(c, a, "write");
      const r = await stub.createRelease(
        {
          tag_name: str(a, "tag_name"),
          target_commitish: optStr(a, "target_commitish"),
          name: optStr(a, "name"),
          body: optStr(a, "body"),
          draft: optBool(a, "draft"),
          prerelease: optBool(a, "prerelease"),
          make_latest: makeLatest(a),
          generate_release_notes: optBool(a, "generate_release_notes"),
        },
        caller,
      );
      return out(c, a, r);
    },
  },
  update_release: {
    description: "Edit a release: title, notes, tag, draft or prerelease state. Publishing a draft sends the release event.",
    input: { ...OWNER_REPO, id: { type: "number" }, tag_name: { type: "string" }, target_commitish: { type: "string" }, ...RELEASE_FIELDS },
    required: ["owner", "repo", "id"],
    run: async (c, a) => {
      const { stub, caller } = await repoOf(c, a, "write");
      const r = await stub.updateRelease(
        id(a, "id"),
        {
          tag_name: optStr(a, "tag_name"),
          target_commitish: optStr(a, "target_commitish"),
          name: typeof a.name === "string" ? a.name : undefined,
          body: typeof a.body === "string" ? a.body : undefined,
          draft: optBool(a, "draft"),
          prerelease: optBool(a, "prerelease"),
          make_latest: makeLatest(a),
        },
        caller,
      );
      return out(c, a, r);
    },
  },
  upload_release_asset: {
    description: "Attach a file (up to 25 MB) to a release. Pass text as content, or bytes as content_base64.",
    input: { ...OWNER_REPO, release_id: { type: "number" }, name: { type: "string", description: "File name" }, label: { type: "string" }, content_type: { type: "string" }, content: { type: "string" }, content_base64: { type: "string" } },
    required: ["owner", "repo", "release_id", "name"],
    run: async (c, a) => {
      const { stub, caller } = await repoOf(c, a, "write");
      const text = typeof a.content === "string" ? a.content : undefined;
      const b64 = optStr(a, "content_base64");
      if ((text === undefined) === (b64 === undefined)) throw new HttpError(422, "pass exactly one of content or content_base64");
      let bytes: Uint8Array;
      try {
        bytes = b64 !== undefined ? fromB64(b64) : new TextEncoder().encode(text);
      } catch {
        throw new HttpError(422, "content_base64 is not valid base64");
      }
      if (bytes.byteLength > MAX_MCP_ASSET_BYTES) throw new HttpError(413, "MCP uploads are limited to 25 MB; use the upload_url of the REST API for larger files");
      const asset = await storeAsset(c.env, stub, id(a, "release_id"), { name: str(a, "name"), label: optStr(a, "label"), contentType: optStr(a, "content_type") ?? (text !== undefined ? "text/plain" : "application/octet-stream") }, { stream: new Blob([bytes]).stream(), length: bytes.byteLength }, caller);
      return { id: asset.id, name: asset.name, size: asset.size, content_type: asset.contentType };
    },
  },
  generate_release_notes: {
    description: "Draft release notes for a tag from the pull requests merged since the previous release. Doesn't create anything.",
    input: { ...OWNER_REPO, tag_name: { type: "string" }, target_commitish: { type: "string" }, previous_tag_name: { type: "string" } },
    required: ["owner", "repo", "tag_name"],
    readOnly: true,
    run: async (c, a) => {
      const { stub } = await repoOf(c, a, "write");
      return await stub.generateReleaseNotes({ tag_name: str(a, "tag_name"), target_commitish: optStr(a, "target_commitish"), previous_tag_name: optStr(a, "previous_tag_name") });
    },
  },
};
