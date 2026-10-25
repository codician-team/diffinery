import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { requireAccount } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { loadRepo } from "../http/common.js";
import { allows, packageAccess, type PackageRole } from "./access.js";
import { RegistryStore, type ManifestRow, type PackageRow } from "./store.js";

/**
 * Packages REST API, shaped like GitHub's (/user/packages, /orgs/{org}/packages,
 * versions and deletes), so scripts and actions such as
 * actions/delete-package-versions work. Only the container package type exists.
 */
export const packagesApi = new Hono<{ Bindings: Env; Variables: AppVars }>().basePath("/api/v3");

const host = (c: AppContext) => new URL(c.env.PUBLIC_URL).host;

export function packageJson(c: AppContext, p: PackageRow & { version_count?: number; tag_count?: number }) {
  const base = `${c.env.PUBLIC_URL}/${p.owner_login}/-/packages/container/${encodeURIComponent(p.name)}`;
  return {
    id: p.id,
    name: p.name,
    package_type: "container",
    owner: { login: p.owner_login, type: p.owner_kind === "org" ? "Organization" : "User" },
    version_count: p.version_count,
    visibility: p.visibility,
    description: p.description,
    image: `${host(c)}/${p.owner_login.toLowerCase()}/${p.name}`,
    url: `${c.env.PUBLIC_URL}/api/v3/${p.owner_kind === "org" ? "orgs" : "users"}/${p.owner_login}/packages/container/${encodeURIComponent(p.name)}`,
    html_url: base,
    repository: p.repo_id ? { id: p.repo_id, name: p.repo_name, full_name: `${p.owner_login}/${p.repo_name}`, html_url: `${c.env.PUBLIC_URL}/${p.owner_login}/${p.repo_name}` } : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export function versionJson(c: AppContext, p: PackageRow, v: ManifestRow & { tags: string[] }) {
  return {
    id: v.id,
    name: v.digest,
    url: `${packageJson(c, p).url}/versions/${v.id}`,
    package_html_url: packageJson(c, p).html_url,
    html_url: `${packageJson(c, p).html_url}/${v.digest}`,
    created_at: v.created_at,
    updated_at: v.created_at,
    media_type: v.media_type,
    size: v.total_size,
    platforms: v.platforms ? (JSON.parse(v.platforms) as Array<{ platform: string | null }>).map((x) => x.platform).filter(Boolean) : [],
    pushed_by: v.pushed_by,
    metadata: { package_type: "container", container: { tags: v.tags } },
  };
}

function checkType(c: AppContext): void {
  const t = c.req.param("type");
  if (t && t !== "container" && t !== "docker") throw new HttpError(404, `Diffinery hosts container packages only (got ${t})`);
  const q = c.req.query("package_type");
  if (q && q !== "container" && q !== "docker") throw new HttpError(422, "package_type must be container");
}

async function ownerAccount(c: AppContext, login: string, kind?: "org" | "user"): Promise<Account> {
  const a = await c.get("dir").accountByLogin(login);
  if (!a || a.kind === "agent" || (kind && a.kind !== kind)) throw new HttpError(404, "not found");
  return a;
}

/** Packages under an owner that the caller can pull. */
async function listFor(c: AppContext, owner: Account) {
  checkType(c);
  const store = new RegistryStore(c.env);
  const rows = await store.packages({ ownerIds: [owner.id], all: false, limit: 1000 });
  const out = [];
  for (const p of rows.filter((r) => r.owner_id === owner.id)) {
    if (allows((await packageAccess(c, owner, p.name, p)).role, "pull")) out.push(packageJson(c, p));
  }
  const vis = c.req.query("visibility");
  return vis ? out.filter((p) => p.visibility === vis) : out;
}

async function loadPackage(c: AppContext, owner: Account, need: PackageRole) {
  checkType(c);
  const name = decodeURIComponent(c.req.param("name")!).toLowerCase();
  const store = new RegistryStore(c.env);
  const pkg = await store.package(owner.id, name);
  if (!pkg) throw new HttpError(c.get("principal").type === "anonymous" ? 401 : 404, "package not found");
  const access = await packageAccess(c, owner, name, pkg);
  if (!allows(access.role, "pull")) throw new HttpError(c.get("principal").type === "anonymous" ? 401 : 404, "package not found");
  if (!allows(access.role, need)) throw new HttpError(403, `${need} access to this package is required${access.hint ? `: ${access.hint}` : ""}`);
  return { store, pkg, access };
}

type OwnerOf = (c: AppContext) => Promise<Account>;
const owners: Array<[string, OwnerOf]> = [
  ["/user/packages", async (c) => requireAccount(c)],
  ["/users/:owner/packages", (c) => ownerAccount(c, c.req.param("owner")!, "user")],
  ["/orgs/:owner/packages", (c) => ownerAccount(c, c.req.param("owner")!, "org")],
];

/**
 * A workflow's or sandbox's token pushes to its repository's packages and deletes their versions, as on GitHub,
 * but never makes one public or deletes it outright: that takes a person (or agent) with admin access.
 */
function workflowTokensMayNot(c: AppContext, what: string): void {
  if (c.get("principal").type === "repo-token") throw new HttpError(403, `a workflow's token can't ${what}; someone with admin access to the package can`);
}

for (const [prefix, ownerOf] of owners) {
  packagesApi.get(prefix, async (c) => c.json(await listFor(c, await ownerOf(c))));

  packagesApi.get(`${prefix}/:type/:name`, async (c) => {
    const owner = await ownerOf(c);
    const { store, pkg } = await loadPackage(c, owner, "pull");
    const versions = await store.versions(pkg.id);
    return c.json({ ...packageJson(c, pkg), version_count: versions.length });
  });

  // Diffinery: change visibility or the linked repository ({"repository": "name"} or null).
  packagesApi.patch(`${prefix}/:type/:name`, async (c) => {
    const owner = await ownerOf(c);
    workflowTokensMayNot(c, "change a package's visibility or repository");
    const { store, pkg, access } = await loadPackage(c, owner, "admin");
    const b = (await c.req.json().catch(() => ({}))) as { visibility?: string; repository?: string | null };
    const patch: Parameters<RegistryStore["updatePackage"]>[1] = {};
    if (b.visibility !== undefined) {
      if (!["private", "public"].includes(b.visibility)) throw new HttpError(422, "visibility must be private or public");
      patch.visibility = b.visibility as PackageRow["visibility"];
    }
    if (b.repository !== undefined) {
      if (b.repository === null || b.repository === "") patch.repoId = null;
      else {
        const name = b.repository.includes("/") ? b.repository.split("/").pop()! : b.repository;
        const { repo } = await loadRepo(c, owner.login, name, "admin", { whileArchived: true });
        patch.repoId = repo.id;
      }
    }
    await store.updatePackage(pkg.id, patch);
    await c.get("dir").audit({ actorId: access.actor?.id, actorLogin: access.actor?.login, action: "package.update", target: `${owner.login}/${pkg.name}`, detail: b });
    return c.json(packageJson(c, (await store.packageById(pkg.id))!));
  });

  packagesApi.delete(`${prefix}/:type/:name`, async (c) => {
    const owner = await ownerOf(c);
    workflowTokensMayNot(c, "delete a whole package");
    const { store, pkg, access } = await loadPackage(c, owner, "admin");
    await store.deletePackage(pkg.id);
    await c.get("dir").audit({ actorId: access.actor?.id, actorLogin: access.actor?.login, action: "package.delete", target: `${owner.login}/${pkg.name}` });
    return c.body(null, 204);
  });

  packagesApi.get(`${prefix}/:type/:name/versions`, async (c) => {
    const owner = await ownerOf(c);
    const { store, pkg } = await loadPackage(c, owner, "pull");
    const perPage = Math.min(Math.max(Number(c.req.query("per_page") ?? 30) || 30, 1), 100);
    const page = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const tagged = c.req.query("state") === "tagged";
    let versions = await store.versions(pkg.id);
    if (tagged) versions = versions.filter((v) => v.tags.length);
    return c.json(versions.slice((page - 1) * perPage, page * perPage).map((v) => versionJson(c, pkg, v)));
  });

  packagesApi.get(`${prefix}/:type/:name/versions/:id`, async (c) => {
    const owner = await ownerOf(c);
    const { store, pkg } = await loadPackage(c, owner, "pull");
    const v = await store.versionById(pkg.id, Number(c.req.param("id")));
    if (!v) throw new HttpError(404, "version not found");
    return c.json(versionJson(c, pkg, v));
  });

  packagesApi.delete(`${prefix}/:type/:name/versions/:id`, async (c) => {
    const owner = await ownerOf(c);
    const { store, pkg, access } = await loadPackage(c, owner, "admin");
    const v = await store.versionById(pkg.id, Number(c.req.param("id")));
    if (!v) throw new HttpError(404, "version not found");
    await store.deleteManifest(pkg.id, v.digest);
    await c.get("dir").audit({ actorId: access.actor?.id, actorLogin: access.actor?.login, action: "package.delete_version", target: `${owner.login}/${pkg.name}@${v.digest}` });
    return c.body(null, 204);
  });
}

// Diffinery: the packages linked to a repository.
packagesApi.get("/repos/:owner/:repo/packages", async (c) => {
  const { repo } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "read");
  const rows = await new RegistryStore(c.env).packages({ repoId: repo.id });
  return c.json(rows.map((p) => packageJson(c, p)));
});
