import { Hono } from "hono";
import type { Env } from "../env.js";
import { callerFor, requireAccount, requireRecentSignIn, requireScope, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account, Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { Apps, effectivePermissions, pendingPermissions, type App, type AppInput, type Installation } from "../apps/store.js";
import { acceptPermissions, adminAccounts, administers, appBot, appJson, auditApp, changeRepositories, installApp, installationJson, manageableApp, manageableInstallation, repoIdsByName, suspendInstallation, toggleRepository, uninstallApp, whoOf, type Ctx } from "../apps/service.js";
import { APP_PERMISSION_NAMES } from "../apps/model.js";
import { baseOf, ghRepo, isoSeconds, numericId, pageOf, setLinks } from "./gh.js";

/**
 * GitHub-compatible apps over REST (apps/): what an app does with its JWT (/app, its installations,
 * installation tokens), what an installation token reads about itself (/installation/repositories),
 * what people see (/apps/{slug}, /user/installations), and Diffinery's own endpoints for registering
 * apps and installing them (/diffinery/apps, /diffinery/installations).
 *
 * Registering an app, adding a key, installing it or giving it more repositories or permissions needs
 * a person signed in with a passkey in a browser: no token, agent or app can grant an app access.
 */
export const appsApi = new Hono<{ Bindings: Env; Variables: AppVars }>();

const base = (c: AppContext) => baseOf(c);
const apps = (c: AppContext) => new Apps(c.env, c.get("dir"));

async function body<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/** A JSON body that may be left out (Octokit sends none for an empty request). */
async function optionalBody<T extends object>(c: AppContext): Promise<Partial<T>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Problems parsing JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Problems parsing JSON");
  return v as Partial<T>;
}

function idParam(c: AppContext, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, "Not Found");
  return n;
}

/** The app whose JWT signed the request. */
function requireApp(c: AppContext): App {
  const p = c.get("principal");
  if (p.type === "app") return p.app;
  throw new HttpError(401, "A JSON web token could not be decoded: this endpoint needs the app's JWT, signed with its private key");
}

/** A person (not an agent, token or app) in a browser signed in with a passkey; `next` is where to come back to after signing in again. */
export function requirePerson(c: AppContext, what: string, o: { recent?: string } = {}): Account {
  const p = c.get("principal");
  if (p.type === "account" && (p.via === "session" || p.via === "dev")) {
    if (o.recent) requireRecentSignIn(c, o.recent);
    const a = requireAccount(c);
    if (a.kind !== "user") throw new HttpError(403, `only people can ${what}`);
    return a;
  }
  if (p.type === "anonymous") throw new HttpError(401, "sign in required");
  throw new HttpError(403, `to ${what}, sign in with your passkey in a browser: ${c.env.PUBLIC_URL}/settings/apps. No token, agent or app can give an app access`);
}

/** The installation of the app signing the request, or GitHub's 404. */
async function ownInstallation(c: AppContext, app: App): Promise<Installation> {
  const inst = await apps(c).installation(idParam(c, "id"));
  if (!inst || inst.appId !== app.id) throw new HttpError(404, "Not Found");
  return inst;
}

async function installationOut(c: AppContext, inst: Installation, app: App, account?: Account | null) {
  const dir = c.get("dir");
  const [acct, by] = await Promise.all([account ?? dir.account(inst.accountId), inst.suspendedBy ? dir.account(inst.suspendedBy) : null]);
  if (!acct) throw new HttpError(404, "Not Found");
  return installationJson(base(c), inst, app, whoOf(acct), by ? whoOf(by) : null);
}

const ctx = (c: AppContext): Ctx => ({ env: c.env, dir: c.get("dir"), base: base(c), waitUntil: (p) => c.executionCtx.waitUntil(p), via: "api" });

/** Settings only an app's managers see, beside GitHub's app object. */
async function appDetail(c: AppContext, app: App) {
  const owner = await c.get("dir").account(app.ownerId);
  return {
    ...appJson(base(c), app, owner ? whoOf(owner) : null, { installationsCount: (await apps(c).installationsOf(app.id)).length }),
    public: app.public,
    setup_url: app.setupUrl,
    callback_urls: app.callbackUrls,
    hook_attributes: { url: app.webhookUrl, active: app.webhookActive },
    last_delivery: app.lastDelivery ? { at: isoSeconds(app.lastDelivery.at), status: app.lastDelivery.status } : null,
  };
}

// ---------------------------------------------------------------- the app, with its JWT

appsApi.get("/app", async (c) => {
  const app = requireApp(c);
  const owner = await c.get("dir").account(app.ownerId);
  return c.json(appJson(base(c), app, owner ? whoOf(owner) : null, { installationsCount: (await apps(c).installationsOf(app.id)).length }));
});

appsApi.get("/app/installations", async (c) => {
  const app = requireApp(c);
  let list = await apps(c).installationsOf(app.id);
  const since = c.req.query("since");
  if (since) list = list.filter((i) => i.updatedAt >= since);
  const p = pageOf(c);
  setLinks(c, p, list.length);
  return c.json(await Promise.all(list.slice(p.offset, p.offset + p.perPage).map((i) => installationOut(c, i, app))));
});

appsApi.get("/app/installations/:id", async (c) => {
  const app = requireApp(c);
  return c.json(await installationOut(c, await ownInstallation(c, app), app));
});

// The app uninstalls itself.
appsApi.delete("/app/installations/:id", async (c) => {
  const app = requireApp(c);
  const inst = await ownInstallation(c, app);
  await uninstallApp(ctx(c), appBot(app), inst, app, await c.get("dir").account(inst.accountId));
  return c.body(null, 204);
});

appsApi.post("/app/installations/:id/access_tokens", async (c) => {
  const app = requireApp(c);
  const inst = await ownInstallation(c, app);
  const account = await c.get("dir").account(inst.accountId);
  if (!account || account.status !== "active" || account.suspended_at) throw new HttpError(403, "This installation's account is not active");
  const b = await optionalBody<{ repositories: unknown; repository_ids: unknown; permissions: unknown }>(c);
  const t = await apps(c).mintToken(app, inst, { repositories: b.repositories, repositoryIds: b.repository_ids, permissions: b.permissions }, numericId);
  return c.json(
    {
      token: t.token,
      expires_at: isoSeconds(t.expiresAt),
      permissions: Object.fromEntries(APP_PERMISSION_NAMES.filter((n) => t.permissions[n]).map((n) => [n, t.permissions[n]])),
      repository_selection: t.repos ? "selected" : inst.selection,
      ...(t.repos ? { repositories: t.repos.map((r) => ghRepo(base(c), r)) } : {}),
    },
    201,
  );
});

for (const method of ["put", "delete"] as const) {
  appsApi[method]("/app/installations/:id/suspended", async (c) => {
    const app = requireApp(c);
    const inst = await ownInstallation(c, app);
    await suspendInstallation(ctx(c), null, appBot(app), inst, app, await c.get("dir").account(inst.accountId), method === "put");
    return c.body(null, 204);
  });
}

/** The app's installation on an account, for its JWT (GitHub's 404 when there's none). */
async function installationOn(c: AppContext, account: Account | null) {
  const app = requireApp(c);
  if (!account || account.kind === "agent") throw new HttpError(404, "Not Found");
  const inst = await apps(c).installationFor(app.id, account.id);
  if (!inst) throw new HttpError(404, "Not Found");
  return c.json(await installationOut(c, inst, app, account));
}

appsApi.get("/repos/:owner/:repo/installation", async (c) => {
  const app = requireApp(c);
  const repo = await c.get("dir").repo(c.req.param("owner"), c.req.param("repo"));
  const inst = repo ? await apps(c).installationFor(app.id, repo.owner_id) : null;
  if (!repo || !inst || !(await apps(c).covers(inst, repo))) throw new HttpError(404, "Not Found");
  return c.json(await installationOut(c, inst, app));
});
appsApi.get("/orgs/:org/installation", async (c) => {
  const a = await c.get("dir").accountByLogin(c.req.param("org"));
  return installationOn(c, a?.kind === "org" ? a : null);
});
appsApi.get("/users/:username/installation", async (c) => installationOn(c, await c.get("dir").accountByLogin(c.req.param("username"))));

// ---------------------------------------------------------------- an installation token about itself

appsApi.get("/installation/repositories", async (c) => {
  const p = c.get("principal");
  if (p.type !== "installation") throw new HttpError(403, "This endpoint needs an installation access token");
  const all = await apps(c).reposOf(p.auth.installation);
  const only = p.auth.repoIds;
  const list = only ? all.filter((r) => only.includes(r.id)) : all;
  const pg = pageOf(c);
  setLinks(c, pg, list.length);
  return c.json({ total_count: list.length, repository_selection: only ? "selected" : p.auth.installation.selection, repositories: list.slice(pg.offset, pg.offset + pg.perPage).map((r) => ghRepo(base(c), r)) });
});

appsApi.delete("/installation/token", async (c) => {
  const p = c.get("principal");
  if (p.type !== "installation") throw new HttpError(403, "This endpoint needs an installation access token");
  await apps(c).revokeToken(p.auth.tokenHash);
  return c.body(null, 204);
});

// ---------------------------------------------------------------- what people see

appsApi.get("/apps/:slug", async (c) => {
  const app = await apps(c).bySlug(c.req.param("slug"));
  const p = c.get("principal");
  const self = (p.type === "app" && p.app.id === app?.id) || (p.type === "installation" && p.auth.app.id === app?.id);
  const manager = p.type === "account" && app ? await administers(c.get("dir"), p.account, app.ownerId) : false;
  if (!app || !(app.public || self || manager)) throw new HttpError(404, "Not Found");
  const owner = await c.get("dir").account(app.ownerId);
  return c.json(appJson(base(c), app, owner ? whoOf(owner) : null));
});

/** Installations on the accounts a person administers (themselves and their organizations). */
async function installationsFor(c: AppContext, person: Account) {
  const accounts = await adminAccounts(c.get("dir"), person);
  return apps(c).installationsOn(accounts.map((a) => a.id));
}

appsApi.get("/user/installations", async (c) => {
  const me = requireAccount(c);
  const list = await installationsFor(c, me);
  const p = pageOf(c);
  setLinks(c, p, list.length);
  return c.json({ total_count: list.length, installations: await Promise.all(list.slice(p.offset, p.offset + p.perPage).map(({ installation, app }) => installationOut(c, installation, app))) });
});

appsApi.get("/user/installations/:id/repositories", async (c) => {
  const me = requireAccount(c);
  const { installation } = await manageableInstallation(c.get("dir"), c.env, me, idParam(c, "id"));
  const all = await apps(c).reposOf(installation);
  const visible: Repo[] = [];
  for (const r of all) if (await callerFor(c, r)) visible.push(r);
  const p = pageOf(c);
  setLinks(c, p, visible.length);
  return c.json({ total_count: visible.length, repository_selection: installation.selection, repositories: visible.slice(p.offset, p.offset + p.perPage).map((r) => ghRepo(base(c), r)) });
});

for (const method of ["put", "delete"] as const) {
  appsApi[method]("/user/installations/:id/repositories/:repoId", async (c) => {
    const add = method === "put";
    const me = requirePerson(c, add ? "give an app access to a repository" : "remove a repository from an app");
    const { installation, app, account } = await manageableInstallation(c.get("dir"), c.env, me, idParam(c, "id"));
    const want = Number(c.req.param("repoId"));
    const repo = (await apps(c).reposOf({ ...installation, selection: "all" })).find((r) => numericId(r.id) === want);
    if (!repo) throw new HttpError(404, "Not Found");
    await toggleRepository(ctx(c), me, installation, app, account, repo, add);
    return c.body(null, 204);
  });
}

// ---------------------------------------------------------------- Diffinery: registering apps

type AppBody = AppInput & { owner?: unknown };

appsApi.get("/diffinery/apps", async (c) => {
  requireScope(c, "read");
  const me = requireAccount(c);
  const owned = await apps(c).ownedBy((await adminAccounts(c.get("dir"), me)).map((a) => a.id));
  return c.json(await Promise.all(owned.map((a) => appDetail(c, a))));
});

appsApi.post("/diffinery/apps", async (c) => {
  const me = requirePerson(c, "register an app", { recent: "/settings/apps/new" });
  const b = await body<AppBody>(c);
  const dir = c.get("dir");
  const owner = b.owner === undefined || b.owner === null || b.owner === me.login ? me : await dir.accountByLogin(String(b.owner));
  if (!owner || !(await administers(dir, me, owner.id))) throw new HttpError(422, "owner must be you or an organization you own or administer");
  const r = await apps(c).create(owner, me, b);
  auditApp(ctx(c), me, "app.create", r.app, { owner: owner.login });
  // GitHub's answer to the app manifest flow: the app, its private key and its webhook secret.
  return c.json({ ...(await appDetail(c, r.app)), pem: r.privateKeyPem, webhook_secret: r.webhookSecret }, 201);
});

appsApi.get("/diffinery/apps/:slug", async (c) => {
  requireScope(c, "read");
  const me = requireAccount(c);
  return c.json(await appDetail(c, await manageableApp(c.get("dir"), c.env, me, c.req.param("slug"))));
});

appsApi.patch("/diffinery/apps/:slug", async (c) => {
  const me = requirePerson(c, "change an app");
  const app = await manageableApp(c.get("dir"), c.env, me, c.req.param("slug"));
  const b = await body<AppBody>(c);
  const next = (await apps(c).update(app, b)) as App & { madeWebhookSecret?: string };
  auditApp(ctx(c), me, "app.update", app, { fields: Object.keys(b).filter((k) => k !== "webhook_secret") });
  return c.json({ ...(await appDetail(c, next)), ...(next.madeWebhookSecret ? { webhook_secret: next.madeWebhookSecret } : {}) });
});

appsApi.delete("/diffinery/apps/:slug", async (c) => {
  const me = requirePerson(c, "delete an app", { recent: "/settings/apps" });
  const app = await manageableApp(c.get("dir"), c.env, me, c.req.param("slug"));
  await apps(c).delete(app);
  auditApp(ctx(c), me, "app.delete", app);
  return c.body(null, 204);
});

appsApi.get("/diffinery/apps/:slug/keys", async (c) => {
  requireScope(c, "read");
  const me = requireAccount(c);
  const app = await manageableApp(c.get("dir"), c.env, me, c.req.param("slug"));
  return c.json((await apps(c).keys(app.id)).map((k) => ({ id: k.id, fingerprint: k.fingerprint, created_at: isoSeconds(k.createdAt), last_used_at: isoSeconds(k.lastUsedAt) })));
});

appsApi.post("/diffinery/apps/:slug/keys", async (c) => {
  const me = requirePerson(c, "add a key to an app", { recent: `/settings/apps/${c.req.param("slug")}` });
  const app = await manageableApp(c.get("dir"), c.env, me, c.req.param("slug"));
  const b = await optionalBody<{ public_key: unknown }>(c);
  const k = await apps(c).addKey(app, me, b.public_key);
  auditApp(ctx(c), me, "app.key.create", app, { fingerprint: k.fingerprint });
  return c.json({ id: k.id, fingerprint: k.fingerprint, ...(k.privateKeyPem ? { pem: k.privateKeyPem } : {}) }, 201);
});

appsApi.delete("/diffinery/apps/:slug/keys/:keyId", async (c) => {
  const me = requirePerson(c, "delete an app's key");
  const app = await manageableApp(c.get("dir"), c.env, me, c.req.param("slug"));
  const keys = await apps(c).keys(app.id);
  const key = keys.find((k) => k.id === c.req.param("keyId"));
  if (!key) throw new HttpError(404, "key not found");
  if (keys.length === 1) throw new HttpError(422, "an app needs at least one key: add another before deleting this one");
  await apps(c).deleteKey(app, key.id);
  auditApp(ctx(c), me, "app.key.delete", app, { fingerprint: key.fingerprint });
  return c.body(null, 204);
});

// ---------------------------------------------------------------- Diffinery: installing apps

appsApi.post("/diffinery/apps/:slug/installations", async (c) => {
  const me = requirePerson(c, "install an app");
  const dir = c.get("dir");
  const app = await apps(c).bySlug(c.req.param("slug"));
  if (!app || !(app.public || (await administers(dir, me, app.ownerId)))) throw new HttpError(404, "app not found");
  const b = await optionalBody<{ account: unknown; repository_selection: unknown; repositories: unknown }>(c);
  const account = b.account === undefined || b.account === null || b.account === me.login ? me : await dir.accountByLogin(String(b.account));
  if (!account || !(await administers(dir, me, account.id))) throw new HttpError(422, "account must be you or an organization you own or administer");
  const selection = b.repository_selection === "selected" ? "selected" : b.repository_selection === "all" || b.repository_selection === undefined ? "all" : null;
  if (!selection) throw new HttpError(422, "repository_selection must be all or selected");
  const ids = selection === "selected" ? await repoIdsByName(dir, account, b.repositories) : [];
  const installation = await installApp(ctx(c), me, app, account, selection, ids);
  return c.json(await installationOut(c, installation, app, account), 201);
});

appsApi.get("/diffinery/installations/:id", async (c) => {
  requireScope(c, "read");
  const me = requireAccount(c);
  const { installation, app, account } = await manageableInstallation(c.get("dir"), c.env, me, idParam(c, "id"));
  return c.json({ ...(await installationOut(c, installation, app, account)), pending_permissions: pendingPermissions(app, installation), effective_permissions: effectivePermissions(app, installation), repositories: installation.selection === "selected" ? (await apps(c).reposOf(installation)).map((r) => `${r.owner_login}/${r.name}`) : null });
});

appsApi.patch("/diffinery/installations/:id", async (c) => {
  const me = requirePerson(c, "change which repositories an app can use");
  const { installation, app, account } = await manageableInstallation(c.get("dir"), c.env, me, idParam(c, "id"));
  const b = await body<{ repository_selection?: unknown; repositories?: unknown }>(c);
  const selection = b.repository_selection === undefined ? installation.selection : b.repository_selection;
  if (selection !== "all" && selection !== "selected") throw new HttpError(422, "repository_selection must be all or selected");
  const ids = selection === "selected" ? await repoIdsByName(c.get("dir"), account, b.repositories) : [];
  return c.json(await installationOut(c, await changeRepositories(ctx(c), me, installation, app, account, selection, ids), app, account));
});

appsApi.delete("/diffinery/installations/:id", async (c) => {
  const me = requirePerson(c, "uninstall an app");
  const { installation, app, account } = await manageableInstallation(c.get("dir"), c.env, me, idParam(c, "id"));
  await uninstallApp(ctx(c), whoOf(me), installation, app, account);
  return c.body(null, 204);
});

for (const method of ["put", "delete"] as const) {
  appsApi[method]("/diffinery/installations/:id/suspended", async (c) => {
    const suspend = method === "put";
    const me = requirePerson(c, suspend ? "suspend an app" : "unsuspend an app");
    const { installation, app, account } = await manageableInstallation(c.get("dir"), c.env, me, idParam(c, "id"));
    await suspendInstallation(ctx(c), me, whoOf(me), installation, app, account, suspend);
    return c.body(null, 204);
  });
}

appsApi.post("/diffinery/installations/:id/accept_permissions", async (c) => {
  const me = requirePerson(c, "accept an app's new permissions");
  const { installation, app, account } = await manageableInstallation(c.get("dir"), c.env, me, idParam(c, "id"));
  return c.json(await installationOut(c, await acceptPermissions(ctx(c), me, installation, app, account), app, account));
});
