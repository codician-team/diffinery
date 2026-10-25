/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { AppContext } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import { allows, packageAccess, type PackageRole } from "../registry/access.js";
import { RegistryStore, type ManifestRow, type PackageRow } from "../registry/store.js";
import { ICONS } from "./assets.js";
import { KSelect } from "./kumo.js";
import { OrgHeader } from "./account.js";
import { csrfToken } from "./csrf.js";
import { Avatar, CopyButton, Form, Time, act, fmtBytes, post, principalAccount, prm, render, repoUrl, type WebApp } from "./ui.js";

/**
 * Container packages in the web UI: an owner's packages, one package with its tags and
 * versions (and settings for admins), and the packages linked to a repository.
 */

const host = (c: AppContext) => new URL(c.env.PUBLIC_URL).host;
const imageRef = (c: AppContext, p: Pick<PackageRow, "owner_login" | "name">) => `${host(c)}/${p.owner_login.toLowerCase()}/${p.name}`;
const pkgUrl = (p: Pick<PackageRow, "owner_login" | "name">) => `/${p.owner_login}/-/packages/container/${p.name}`;

async function ownerOf(c: AppContext): Promise<Account> {
  const owner = await c.get("dir").accountByLogin(prm(c, "owner"));
  if (!owner || owner.kind === "agent") throw new HttpError(404, "not found");
  return owner;
}

/** An organization's packages pages keep its header and tab bar, with Packages selected. */
async function orgShell(c: AppContext, org: Account) {
  const me = principalAccount(c);
  const role = me ? await c.get("dir").orgRole(org.id, me.kind === "agent" ? (me.owner_id ?? me.id) : me.id) : null;
  return <OrgHeader org={org} role={role} isOwner={!!me?.site_admin || role === "owner"} tab="packages" />;
}

async function visible(c: AppContext, owner: Account, rows: PackageRow[]): Promise<PackageRow[]> {
  const out: PackageRow[] = [];
  for (const p of rows) if (allows((await packageAccess(c, owner, p.name, p)).role, "pull")) out.push(p);
  return out;
}

async function loadPackage(c: AppContext, owner: Account, name: string, need: PackageRole = "pull") {
  const store = new RegistryStore(c.env);
  const pkg = await store.package(owner.id, name.toLowerCase());
  if (!pkg) throw new HttpError(404, "package not found");
  const access = await packageAccess(c, owner, pkg.name, pkg);
  if (!allows(access.role, "pull")) throw new HttpError(c.get("principal").type === "anonymous" ? 401 : 404, "package not found");
  if (!allows(access.role, need)) throw new HttpError(403, "package admins only");
  return { store, pkg, access };
}

const VisIcon = ({ v }: { v: string }) => <span class="st faint">{raw(v === "public" ? ICONS.globe : ICONS.lock)}</span>;

const PackageList = ({ c, rows, showRepo, empty }: { c: AppContext; rows: Array<PackageRow & { version_count?: number; tag_count?: number }>; showRepo: boolean; empty: Child }) =>
  rows.length ? (
    <ul class="list">
      {rows.map((p) => (
        <li>
          <span class="st faint">{raw(ICONS.package)}</span>
          <div class="grow">
            <a href={pkgUrl(p)}>
              <b>
                {p.owner_login}/{p.name}
              </b>
            </a>{" "}
            <span class="badge">{p.visibility}</span>
            {p.description ? <div class="muted small">{p.description}</div> : null}
            <div class="muted small mono">{imageRef(c, p)}</div>
          </div>
          {showRepo && p.repo_name ? (
            <a class="small muted" href={`/${p.owner_login}/${p.repo_name}`}>
              {raw(ICONS.repo)} {p.repo_name}
            </a>
          ) : null}
          <span class="muted small">
            {p.tag_count ?? 0} tag{p.tag_count === 1 ? "" : "s"} · updated <Time at={p.updated_at} />
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <div class="empty">{empty}</div>
  );

const Usage = ({ c, image, tag }: { c: AppContext; image: string; tag: string }) => {
  const login = `docker login ${host(c)} -u <username> -p <token>`;
  const pull = `docker pull ${image}:${tag}`;
  const workflow = `- name: Sign in to the Diffinery registry
  run: echo "\${{ secrets.GITHUB_TOKEN }}" | docker login ${host(c)} -u "\${{ github.actor }}" --password-stdin
- run: |
    docker build -t ${image}:\${{ github.sha }} .
    docker push ${image}:\${{ github.sha }}`;
  return (
    <div class="box">
      <div class="head">
        <h3>Use this image</h3>
      </div>
      <div class="body">
        <p class="muted small m0">Sign in with any username and a token from Settings → Access tokens as the password (the read scope pulls, write pushes).</p>
        <div class="row mt">
          <pre class="cmd one grow m0 mono">{login}</pre>
        </div>
        <div class="row mt">
          <pre class="cmd one grow m0 mono">{pull}</pre>
          <CopyButton text={pull} size="base" />
        </div>
        <p class="muted small mt">
          In a workflow, the job's <code>GITHUB_TOKEN</code> signs in. It can push to packages of its own repository (with <code>permissions: packages: write</code> when the workflow sets permissions) and pull its owner's packages.
        </p>
        <pre class="cmd m0 mono small">{workflow}</pre>
      </div>
    </div>
  );
};

const platformsOf = (v: ManifestRow) => (v.platforms ? (JSON.parse(v.platforms) as Array<{ platform: string | null }>).map((x) => x.platform).filter((x): x is string => !!x && x !== "unknown/unknown") : []);

export function registerPackages(web: WebApp): void {
  web.get("/:owner/-/packages", async (c) => {
    const owner = await ownerOf(c);
    const rows = await visible(c, owner, (await new RegistryStore(c.env).packages({ ownerIds: [owner.id], limit: 1000 })).filter((p) => p.owner_id === owner.id));
    return render(
      c,
      { title: `${owner.login} packages` },
      <>
        {owner.kind === "org" ? (
          <>
            {await orgShell(c, owner)}
            <p class="muted small">
              Container images at <span class="mono">{host(c)}/{owner.login.toLowerCase()}/…</span>
            </p>
          </>
        ) : (
          <div class="row mb" style="gap:12px">
            <Avatar login={owner.login} size="lg" version={owner.avatar_version} />
            <div>
              <h1 class="m0">
                <a href={`/${owner.login}`}>{owner.login}</a> <span class="faint">/</span> Packages
              </h1>
              <div class="muted small">
                Container images at <span class="mono">{host(c)}/{owner.login.toLowerCase()}/…</span>
              </div>
            </div>
          </div>
        )}
        <div class="box">
          <PackageList
            c={c}
            rows={rows}
            showRepo
            empty={
              <>
                No packages yet. Push one with <code class="mono">docker push {host(c)}/{owner.login.toLowerCase()}/IMAGE:TAG</code>.
              </>
            }
          />
        </div>
      </>,
    );
  });

  web.get("/:owner/-/packages/container/:name{.+}", async (c) => {
    const owner = await ownerOf(c);
    const { store, pkg, access } = await loadPackage(c, owner, prm(c, "name"));
    const versions = await store.versions(pkg.id);
    const tagged = versions.flatMap((v) => v.tags.map((t) => ({ tag: t, v })));
    const isAdmin = allows(access.role, "admin");
    const image = imageRef(c, pkg);
    const t = csrfToken(c);
    const me = principalAccount(c);
    const repos = isAdmin && me ? await c.get("dir").reposVisibleTo(me, owner.id) : [];
    const latest = tagged.find((x) => x.tag === "latest")?.tag ?? tagged[0]?.tag ?? "latest";
    return render(
      c,
      { title: `${owner.login}/${pkg.name}`, description: pkg.description ?? `Container image ${image}` },
      <>
        {owner.kind === "org" ? await orgShell(c, owner) : null}
        <div class="mb">
          <h1 class="m0">
            <VisIcon v={pkg.visibility} />
            <a href={`/${owner.login}/-/packages`}>{owner.login}</a> <span class="faint">/</span> <strong>{pkg.name}</strong> <span class="badge">{pkg.visibility}</span>
          </h1>
          {pkg.description ? <p class="muted m0">{pkg.description}</p> : null}
          <p class="muted small">
            {pkg.repo_name ? (
              <>
                Linked to{" "}
                <a href={`/${owner.login}/${pkg.repo_name}`}>
                  {owner.login}/{pkg.repo_name}
                </a>
                , which sets who can pull and push.{" "}
              </>
            ) : (
              <>Not linked to a repository. </>
            )}
            Created <Time at={pkg.created_at} />, updated <Time at={pkg.updated_at} />.
          </p>
        </div>
        <Usage c={c} image={image} tag={latest} />
        <div class="box">
          <div class="head">
            <h3>
              {raw(ICONS.tag)} Versions <span class="muted small">({versions.length})</span>
            </h3>
          </div>
          {versions.length ? (
            <table class="tbl">
              <thead>
                <tr>
                  <th>Tags</th>
                  <th>Digest</th>
                  <th>Platforms</th>
                  <th>Size</th>
                  <th>Pushed</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr>
                    <td>{v.tags.length ? v.tags.map((x) => <span class="badge green">{x}</span>) : <span class="muted small">untagged</span>}</td>
                    <td class="mono small">
                      <span title={v.digest}>{v.digest.slice(0, 19)}</span> <CopyButton text={`${image}@${v.digest}`} label="Copy" />
                    </td>
                    <td class="small">{platformsOf(v).join(", ") || "—"}</td>
                    <td class="small">{fmtBytes(v.total_size)}</td>
                    <td class="small">
                      <Time at={v.created_at} />
                      {v.pushed_by ? <span class="muted"> by {v.pushed_by}</span> : null}
                    </td>
                    {isAdmin ? (
                      <td class="right">
                        <Form action={`/${owner.login}/-/packages/-/delete-version`} t={t} class="inline" confirm={`Delete ${v.tags.length ? v.tags.join(", ") : v.digest.slice(0, 19)}? Anything pulling it by tag or digest will stop working.`}>
                          <input type="hidden" name="name" value={pkg.name} />
                          <input type="hidden" name="digest" value={v.digest} />
                          <button class="btn sm danger">Delete</button>
                        </Form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="empty">No versions yet.</div>
          )}
        </div>
        {isAdmin ? (
          <>
            <Form action={`/${owner.login}/-/packages/-/update`} t={t} class="box">
              <div class="head">
                <h3>{raw(ICONS.gear)} Settings</h3>
              </div>
              <div class="body">
                <input type="hidden" name="name" value={pkg.name} />
                <div class="field" style="max-width:360px">
                  <label>Visibility</label>
                  <KSelect
                    name="visibility"
                    block
                    label="Visibility"
                    value={pkg.visibility}
                    options={[
                      { value: "private", label: "Private: people with access to the linked repository or the owner" },
                      { value: "public", label: "Public: anyone, without signing in" },
                    ]}
                  />
                </div>
                <div class="field" style="max-width:360px">
                  <label>Linked repository</label>
                  <KSelect name="repository" block label="Linked repository" value={pkg.repo_name ?? ""} options={[{ value: "", label: "None" }, ...repos.map((r) => ({ value: r.name, label: `${r.owner_login}/${r.name}` }))]} />
                  <div class="hint">The package shares the repository's permissions: readers pull, writers and its workflows push, admins manage.</div>
                </div>
                <button class="btn primary">Save</button>
              </div>
            </Form>
            <Form action={`/${owner.login}/-/packages/-/delete`} t={t} class="box" confirm={`Delete ${owner.login}/${pkg.name} and all of its versions?`} match={pkg.name}>
              <div class="head">
                <h3>Delete this package</h3>
              </div>
              <div class="body row">
                <input type="hidden" name="name" value={pkg.name} />
                <p class="muted small grow m0">Removes every tag and version. Type the package name to confirm.</p>
                <button class="btn danger">Delete package</button>
              </div>
            </Form>
          </>
        ) : null}
      </>,
    );
  });

  post(web, "/:owner/-/packages/-/update", async (c, f) => {
    const owner = await ownerOf(c);
    const name = f.s("name");
    return act(
      c,
      pkgUrl({ owner_login: owner.login, name }),
      async () => {
        const { store, pkg, access } = await loadPackage(c, owner, name, "admin");
        const visibility = (["private", "public"] as const).find((v) => v === f.s("visibility"));
        const repoName = f.s("repository").trim();
        const repoId = repoName ? (await loadRepo(c, owner.login, repoName, "admin", { whileArchived: true })).repo.id : null;
        await store.updatePackage(pkg.id, { visibility, repoId });
        await c.get("dir").audit({ actorId: access.actor?.id, actorLogin: access.actor?.login, action: "package.update", target: `${owner.login}/${pkg.name}`, detail: { visibility, repository: repoName || null } });
      },
      "Package settings saved.",
    );
  });

  post(web, "/:owner/-/packages/-/delete-version", async (c, f) => {
    const owner = await ownerOf(c);
    const name = f.s("name");
    return act(
      c,
      pkgUrl({ owner_login: owner.login, name }),
      async () => {
        const { store, pkg, access } = await loadPackage(c, owner, name, "admin");
        const digest = f.s("digest");
        if (!(await store.deleteManifest(pkg.id, digest))) throw new HttpError(404, "version not found");
        await c.get("dir").audit({ actorId: access.actor?.id, actorLogin: access.actor?.login, action: "package.delete_version", target: `${owner.login}/${pkg.name}@${digest}` });
      },
      "Version deleted.",
    );
  });

  post(web, "/:owner/-/packages/-/delete", async (c, f) => {
    const owner = await ownerOf(c);
    const name = f.s("name");
    return act(
      c,
      pkgUrl({ owner_login: owner.login, name }),
      async () => {
        const { store, pkg, access } = await loadPackage(c, owner, name, "admin");
        await store.deletePackage(pkg.id);
        await c.get("dir").audit({ actorId: access.actor?.id, actorLogin: access.actor?.login, action: "package.delete", target: `${owner.login}/${pkg.name}` });
        return `/${owner.login}/-/packages`;
      },
      "Package deleted.",
    );
  });

  web.get("/:owner/:repo/packages", async (c) => {
    const { repo, caller } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const rows = await new RegistryStore(c.env).packages({ repoId: repo.id });
    const image = `${host(c)}/${repo.owner_login.toLowerCase()}/${repo.name.toLowerCase()}`;
    return render(
      c,
      { title: `Packages · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "packages" } },
      <>
        <div class="box">
          <div class="head">
            <h3>{raw(ICONS.package)} Packages</h3>
          </div>
          <PackageList
            c={c}
            rows={rows}
            showRepo={false}
            empty={
              <>
                No packages yet. Images pushed as <code class="mono">{image}</code> (or <code class="mono">{image}/…</code>), or by this repository's workflows, show up here.
              </>
            }
          />
        </div>
        <Usage c={c} image={image} tag="latest" />
        <p class="muted small">
          <a href={`${repoUrl(repo)}`}>Back to the code</a> · <a href={`/${repo.owner_login}/-/packages`}>All of {repo.owner_login}'s packages</a>
        </p>
      </>,
    );
  });
}
