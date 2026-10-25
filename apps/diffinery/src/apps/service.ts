import type { Env } from "../env.js";
import { localOnly } from "../auth/dev.js";
import { decryptSecret } from "../lib/crypto.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { HttpError, newId } from "../lib/util.js";
import { deliverWebhook, type WebhookDeps } from "../lib/webhooks.js";
import { apiRoot, ghUser, isoSeconds, nodeId, numericId, userType, type Who } from "../http/gh.js";
import { APP_PERMISSION_NAMES } from "./model.js";
import { Apps, effectivePermissions, installationEvents, type App, type Installation } from "./store.js";

/**
 * What the HTTP API (http/apps.ts) and the web pages (web/apps.tsx) share about apps: who may manage
 * an app or an installation, the GitHub-shaped JSON for both, and the webhooks an app receives about
 * its installations and about the repositories they cover.
 */

/** Hook ids of apps' webhooks in deliveries and retries (lib/webhooks.ts): `app:<app id>`. */
export const APP_HOOK_PREFIX = "app:";

// ---------------------------------------------------------------- who may do what

/** The accounts a person administers: themselves and the organizations they own or administer. */
export async function adminAccounts(dir: Directory, person: Account): Promise<Account[]> {
  if (person.kind !== "user" || person.status !== "active") return [];
  const orgs = (await dir.orgsFor(person.id)).filter((o) => (o.role === "owner" || o.role === "admin") && o.status === "active");
  return [person, ...orgs];
}

/** Whether a person administers an account: it is them, or an organization they own or administer. */
export async function administers(dir: Directory, person: Account, accountId: string): Promise<boolean> {
  if (person.kind !== "user" || person.status !== "active") return false;
  if (person.id === accountId) return true;
  const role = await dir.orgRole(accountId, person.id);
  return role === "owner" || role === "admin";
}

/** The app, when the person may change it (it's theirs or their organization's), else a 404 as if it weren't there. */
export async function manageableApp(dir: Directory, env: Env, person: Account, slug: string): Promise<App> {
  const app = await new Apps(env, dir).bySlug(slug);
  if (!app || !(await administers(dir, person, app.ownerId))) throw new HttpError(404, "app not found");
  return app;
}

/** The installation, when the person administers the account it's on, else a 404. */
export async function manageableInstallation(dir: Directory, env: Env, person: Account, id: number): Promise<{ installation: Installation; app: App; account: Account }> {
  const apps = new Apps(env, dir);
  const installation = await apps.installation(id);
  if (!installation || !(await administers(dir, person, installation.accountId))) throw new HttpError(404, "installation not found");
  const [app, account] = await Promise.all([apps.byId(installation.appId), dir.account(installation.accountId)]);
  if (!app || !account) throw new HttpError(404, "installation not found");
  return { installation, app, account };
}

// ---------------------------------------------------------------- JSON, as GitHub's

const permissionsJson = (p: App["permissions"]) => Object.fromEntries(APP_PERMISSION_NAMES.filter((n) => p[n]).map((n) => [n, p[n]]));

/** GitHub's app object (GET /app, GET /apps/{slug}). */
export function appJson(base: string, app: App, owner: Who | null, extra: { installationsCount?: number } = {}) {
  return {
    id: app.id,
    slug: app.slug,
    node_id: nodeId("App", app.id),
    client_id: app.clientId,
    owner: ghUser(base, owner),
    name: app.name,
    description: app.description || null,
    external_url: app.homepageUrl,
    html_url: `${base}/apps/${app.slug}`,
    created_at: isoSeconds(app.createdAt),
    updated_at: isoSeconds(app.updatedAt),
    permissions: permissionsJson(app.permissions),
    events: app.events,
    ...(extra.installationsCount !== undefined ? { installations_count: extra.installationsCount } : {}),
  };
}

/** GitHub's installation object. */
export function installationJson(base: string, inst: Installation, app: App, account: Who, suspendedBy?: Who | null) {
  const api = apiRoot(base);
  return {
    id: inst.id,
    node_id: nodeId("Installation", inst.id),
    client_id: app.clientId,
    account: ghUser(base, account),
    repository_selection: inst.selection,
    access_tokens_url: `${api}/app/installations/${inst.id}/access_tokens`,
    repositories_url: `${api}/installation/repositories`,
    html_url: `${base}/settings/installations/${inst.id}`,
    app_id: app.id,
    app_slug: app.slug,
    target_id: numericId(account.id),
    target_type: userType(account.kind),
    permissions: permissionsJson(effectivePermissions(app, inst)),
    events: installationEvents(app, inst),
    created_at: isoSeconds(inst.createdAt),
    updated_at: isoSeconds(inst.updatedAt),
    single_file_name: null,
    has_multiple_single_files: false,
    single_file_paths: [],
    suspended_by: inst.suspendedAt ? (ghUser(base, suspendedBy ?? null) ?? null) : null,
    suspended_at: isoSeconds(inst.suspendedAt),
  };
}

/** The short repository objects of installation webhooks. */
const shortRepo = (r: Repo) => ({ id: numericId(r.id), node_id: nodeId("Repository", r.id), name: r.name, full_name: `${r.owner_login}/${r.name}`, private: r.visibility !== "public" });

/** The bot an app acts as. */
export const appBot = (app: App): Who => ({ id: `app-bot:${app.id}`, login: `${app.slug}[bot]`, kind: "system" });

// ---------------------------------------------------------------- webhooks

/** An app's webhook as deliveries need it (URL and secret), while it has an active one. */
export async function appHook(env: Env, hookId: string): Promise<{ id: string; url: string; secret: string } | null> {
  if (!hookId.startsWith(APP_HOOK_PREFIX)) return null;
  const app = await new Apps(env).byId(Number(hookId.slice(APP_HOOK_PREFIX.length)));
  if (!app?.webhookUrl || !app.webhookActive || !app.webhookSecret) return null;
  const secret = await decryptSecret(env, `app-webhook:${app.id}`, app.webhookSecret).catch(() => null);
  return secret ? { id: hookId, url: app.webhookUrl, secret } : null;
}

/**
 * Deliveries to apps' webhooks: the same signing and retries as repository webhooks. On a Worker that
 * runs on this machine only (the end-to-end tests), they may go to this machine.
 */
export const appWebhookDeps = (env: Env): WebhookDeps => ({
  ownHost: new URL(env.PUBLIC_URL).hostname,
  local: localOnly(env),
  hook: (_repoId, hookId) => appHook(env, hookId),
  record: (_repoId, hookId, status) => new Apps(env).recordDelivery(Number(hookId.slice(APP_HOOK_PREFIX.length)), status),
  requeue: async (r, delaySeconds) => {
    await env.EVENTS.send(r as never, { delaySeconds });
  },
});

async function deliver(env: Env, app: App, repoId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const hookId = `${APP_HOOK_PREFIX}${app.id}`;
  const hook = await appHook(env, hookId);
  if (!hook) return;
  await deliverWebhook(appWebhookDeps(env), { type: "webhook_retry", repoId, hookId, event, diffineryEvent: event, body: JSON.stringify(payload), delivery: newId(), attempt: 0 }, hook);
}

/**
 * A repository event (as its repository webhooks get it) to every app installed on the repository that
 * subscribed to it, with the installation it came through, as GitHub sends them.
 */
export async function deliverToApps(env: Env, repo: Pick<Repo, "id" | "owner_id">, event: string, payload: Record<string, unknown>): Promise<void> {
  const listeners = await new Apps(env).listenersFor(repo);
  const sent = await Promise.allSettled(
    listeners.filter(({ app, installation }) => installationEvents(app, installation).includes(event)).map(({ app, installation }) => deliver(env, app, repo.id, event, { ...payload, installation: { id: installation.id, node_id: nodeId("Installation", installation.id) } })),
  );
  for (const r of sent) if (r.status === "rejected") console.error("app webhook delivery failed", event, r.reason);
}

export type InstallationAction = "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";

/** The `installation` event to the app (GitHub sends it to every app with a webhook, whatever it subscribed to). */
export async function sendInstallationEvent(env: Env, base: string, o: { app: App; installation: Installation; account: Who; action: InstallationAction; sender: Who; repos?: Repo[] }): Promise<void> {
  const payload: Record<string, unknown> = {
    action: o.action,
    installation: installationJson(base, o.installation, o.app, o.account, o.action === "suspend" ? o.sender : null),
    ...(o.repos ? { repositories: o.repos.slice(0, 100).map(shortRepo) } : {}),
    requester: null,
    sender: ghUser(base, o.sender),
  };
  await deliver(env, o.app, "", "installation", payload).catch((e) => console.error("installation webhook failed", e));
}

/** The `installation_repositories` event: repositories added to or removed from an installation. */
export async function sendInstallationRepositoriesEvent(env: Env, dir: Directory, base: string, o: { app: App; installation: Installation; account: Who; sender: Who; added: string[]; removed: string[] }): Promise<void> {
  const rows = async (ids: string[]) => (await Promise.all(ids.slice(0, 100).map((id) => dir.repoById(id)))).filter((r): r is Repo => !!r);
  const [added, removed] = await Promise.all([rows(o.added), rows(o.removed)]);
  for (const [action, list] of [["added", added], ["removed", removed]] as const) {
    if (!list.length) continue;
    const payload = {
      action,
      installation: installationJson(base, o.installation, o.app, o.account),
      repository_selection: o.installation.selection,
      repositories_added: action === "added" ? list.map(shortRepo) : [],
      repositories_removed: action === "removed" ? list.map(shortRepo) : [],
      requester: null,
      sender: ghUser(base, o.sender),
    };
    await deliver(env, o.app, "", "installation_repositories", payload).catch((e) => console.error("installation_repositories webhook failed", e));
  }
}

// ---------------------------------------------------------------- installing, shared by the API and the web pages

/** What an installation change needs from the request: the Worker's bindings, the directory, and where to keep background work. */
export interface Ctx {
  env: Env;
  dir: Directory;
  base: string;
  waitUntil(p: Promise<unknown>): void;
  /** "api" or "web", for the audit log. */
  via: "api" | "web";
}

export const whoOf = (a: Pick<Account, "id" | "login" | "kind">): Who => ({ id: a.id, login: a.login, kind: a.kind });

function audit(x: Ctx, by: Who, action: string, target: string, detail?: Record<string, unknown>): void {
  x.waitUntil(x.dir.audit({ actorId: by.id, actorLogin: by.login, action, target, detail: { ...detail, via: x.via } }).catch((e) => console.error("audit failed", e)));
}

/** Install `app` on `account` (all or the given repositories), for a person who administers it. */
export async function installApp(x: Ctx, me: Account, app: App, account: Account, selection: "all" | "selected", repoIds: string[]): Promise<Installation> {
  if (!(await administers(x.dir, me, account.id))) throw new HttpError(403, `only ${account.kind === "org" ? `owners and administrators of ${account.login}` : account.login} can install apps on it`);
  const apps = new Apps(x.env, x.dir);
  const r = await apps.install(app, account, me, selection, repoIds);
  audit(x, whoOf(me), "app.installation.create", account.login, { app: app.slug, installation: r.installation.id, repository_selection: selection, repositories: repoIds.length });
  const repos = await apps.reposOf(r.installation);
  x.waitUntil(sendInstallationEvent(x.env, x.base, { app, installation: r.installation, account: whoOf(account), action: "created", sender: whoOf(me), repos }));
  return r.installation;
}

/** Change the repositories an installation covers. */
export async function changeRepositories(x: Ctx, me: Account, inst: Installation, app: App, account: Account, selection: "all" | "selected", repoIds: string[]): Promise<Installation> {
  const r = await new Apps(x.env, x.dir).setRepositories(inst, selection, repoIds);
  audit(x, whoOf(me), "app.installation.update", account.login, { app: app.slug, installation: inst.id, repository_selection: selection, added: r.added.length, removed: r.removed.length });
  if (r.added.length || r.removed.length) x.waitUntil(sendInstallationRepositoriesEvent(x.env, x.dir, x.base, { app, installation: r.installation, account: whoOf(account), sender: whoOf(me), added: r.added, removed: r.removed }));
  return r.installation;
}

/** Add or remove one repository of an installation with selected repositories. */
export async function toggleRepository(x: Ctx, me: Account, inst: Installation, app: App, account: Account, repo: Repo, add: boolean): Promise<void> {
  if (!(await new Apps(x.env, x.dir).toggleRepository(inst, repo, add))) return;
  audit(x, whoOf(me), add ? "app.installation.repository_add" : "app.installation.repository_remove", `${repo.owner_login}/${repo.name}`, { app: app.slug, installation: inst.id });
  x.waitUntil(sendInstallationRepositoriesEvent(x.env, x.dir, x.base, { app, installation: inst, account: whoOf(account), sender: whoOf(me), added: add ? [repo.id] : [], removed: add ? [] : [repo.id] }));
}

/** Uninstall, by a person who administers the account or by the app itself (`by` is then its bot). */
export async function uninstallApp(x: Ctx, by: Who, inst: Installation, app: App, account: Account | null): Promise<void> {
  await new Apps(x.env, x.dir).uninstall(inst);
  audit(x, by, "app.installation.delete", account?.login ?? inst.accountId, { app: app.slug, installation: inst.id });
  if (account) x.waitUntil(sendInstallationEvent(x.env, x.base, { app, installation: inst, account: whoOf(account), action: "deleted", sender: by }));
}

/**
 * Suspend or unsuspend, by a person who administers the account (`me`) or by the app itself (`me` null,
 * `by` its bot). An app lifts only a suspension it made itself.
 */
export async function suspendInstallation(x: Ctx, me: Account | null, by: Who, inst: Installation, app: App, account: Account | null, suspend: boolean): Promise<Installation> {
  if (!suspend && !me && inst.suspendedBy) throw new HttpError(403, "This installation was suspended by an administrator of its account; only they can unsuspend it");
  const next = await new Apps(x.env, x.dir).suspend(inst, me, suspend);
  audit(x, by, suspend ? "app.installation.suspend" : "app.installation.unsuspend", account?.login ?? inst.accountId, { app: app.slug, installation: inst.id });
  if (account && !!inst.suspendedAt !== suspend) x.waitUntil(sendInstallationEvent(x.env, x.base, { app, installation: next, account: whoOf(account), action: suspend ? "suspend" : "unsuspend", sender: by }));
  return next;
}

/** An administrator of the account accepts the permissions the app asks for now. */
export async function acceptPermissions(x: Ctx, me: Account, inst: Installation, app: App, account: Account): Promise<Installation> {
  const next = await new Apps(x.env, x.dir).acceptPermissions(inst, app);
  audit(x, whoOf(me), "app.installation.accept_permissions", account.login, { app: app.slug, installation: inst.id, permissions: app.permissions });
  x.waitUntil(sendInstallationEvent(x.env, x.base, { app, installation: next, account: whoOf(account), action: "new_permissions_accepted", sender: whoOf(me) }));
  return next;
}

/** Record a change to an app itself (create, update, keys, delete). */
export function auditApp(x: Ctx, me: Account, action: string, app: Pick<App, "slug">, detail?: Record<string, unknown>): void {
  audit(x, whoOf(me), action, app.slug, detail);
}

/** Repository names (`name` or `owner/name`) of an account, as ids; any other is refused. */
export async function repoIdsByName(dir: Directory, account: Account, names: unknown): Promise<string[]> {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw new HttpError(422, "repositories must be a list of repository names");
  if (names.length > 5000) throw new HttpError(422, "too many repositories");
  const ids: string[] = [];
  for (const raw of names as string[]) {
    const [o, n] = raw.includes("/") ? raw.split("/", 2) : [account.login, raw];
    const r = o!.toLowerCase() === account.login.toLowerCase() ? await dir.repo(account.login, n!) : null;
    if (!r || r.owner_id !== account.id) throw new HttpError(422, `${raw} isn't a repository of ${account.login}`);
    ids.push(r.id);
  }
  return [...new Set(ids)];
}
