import type { Env } from "../env.js";
import { localOnly } from "../auth/dev.js";
import { checkPublicUrl } from "../imports/options.js";
import { encryptSecret } from "../lib/crypto.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { HttpError, newId, now, randomAlnum, randomToken, sha256 } from "../lib/util.js";
import { generateAppKey, parsePublicKey, readJwt, verifyAppJwt, KeyError } from "./keys.js";
import { AppInputError, eventAllowed, intersectPermissions, isValidAppName, narrowPermissions, parseEvents, parsePermissions, slugify, widens, type AppPermissions } from "./model.js";

/**
 * GitHub-compatible apps (see migrations/0042_apps.sql and the design in docs/repositories/apps.md):
 * registering an app and its keys, installing it on accounts, its JWTs and installation tokens.
 * The HTTP layer (http/apps.ts, web/apps.tsx) checks who is asking; this checks what is asked.
 */

export const INSTALLATION_TOKEN_TTL_S = 3600;
export const INSTALLATION_TOKEN_PREFIX = "dia_";
export const MAX_KEYS = 20;
export const MAX_APPS_PER_OWNER = 100;
export const MAX_CALLBACK_URLS = 10;
/** Repositories one token request may name, as on GitHub. */
export const MAX_TOKEN_REPOS = 500;
/** Repositories an installation lists or covers by name at most (all of an account's, or the selected ones). */
export const MAX_INSTALLATION_REPOS = 5000;
const MAX_TEXT = 2000;

export interface AppRow {
  id: number;
  slug: string;
  name: string;
  owner_id: string;
  description: string;
  homepage_url: string;
  setup_url: string | null;
  callback_urls: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_active: number;
  permissions: string;
  events: string;
  public: number;
  client_id: string;
  client_secret_hash: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
}

export interface App {
  id: number;
  slug: string;
  name: string;
  ownerId: string;
  description: string;
  homepageUrl: string;
  setupUrl: string | null;
  callbackUrls: string[];
  webhookUrl: string | null;
  /** The sealed secret (lib/crypto.ts, scope `app-webhook:<id>`); never shown. */
  webhookSecret: string | null;
  webhookActive: boolean;
  permissions: AppPermissions;
  events: string[];
  public: boolean;
  clientId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastDelivery: { at: string; status: number } | null;
}

export interface InstallationRow {
  id: number;
  app_id: number;
  account_id: string;
  repository_selection: "all" | "selected";
  permissions: string;
  events: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  suspended_at: string | null;
  suspended_by: string | null;
}

export interface Installation {
  id: number;
  appId: number;
  accountId: string;
  selection: "all" | "selected";
  /** What admins of the account accepted; the app may since ask for more (see `pendingPermissions`). */
  permissions: AppPermissions;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  suspendedBy: string | null;
}

/** An installation token after its checks: what it may reach and do. */
export interface InstallationAuth {
  installation: Installation;
  app: App;
  account: Account;
  /** Repositories the token is narrowed to, or null for everything the installation covers. */
  repoIds: string[] | null;
  permissions: AppPermissions;
  tokenHash: string;
}

export interface AppInput {
  name?: unknown;
  description?: unknown;
  homepage_url?: unknown;
  setup_url?: unknown;
  callback_urls?: unknown;
  webhook_url?: unknown;
  webhook_secret?: unknown;
  webhook_active?: unknown;
  default_permissions?: unknown;
  default_events?: unknown;
  public?: unknown;
}

export const appFromRow = (r: AppRow): App => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  ownerId: r.owner_id,
  description: r.description,
  homepageUrl: r.homepage_url,
  setupUrl: r.setup_url,
  callbackUrls: JSON.parse(r.callback_urls) as string[],
  webhookUrl: r.webhook_url,
  webhookSecret: r.webhook_secret,
  webhookActive: !!r.webhook_active,
  permissions: JSON.parse(r.permissions) as AppPermissions,
  events: JSON.parse(r.events) as string[],
  public: !!r.public,
  clientId: r.client_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastDelivery: r.last_delivery_at ? { at: r.last_delivery_at, status: r.last_delivery_status ?? 0 } : null,
});

export const installationFromRow = (r: InstallationRow): Installation => ({
  id: r.id,
  appId: r.app_id,
  accountId: r.account_id,
  selection: r.repository_selection,
  permissions: JSON.parse(r.permissions) as AppPermissions,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  suspendedAt: r.suspended_at,
  suspendedBy: r.suspended_by,
});

/** The events an installation receives: the app's, as far as the permissions its admins accepted cover them. */
export const installationEvents = (app: App, inst: Installation): string[] => app.events.filter((e) => eventAllowed(e, effectivePermissions(app, inst)));

/** What an installation's tokens may have: what its admins accepted, as far as the app still asks for it. */
export const effectivePermissions = (app: App, inst: Installation): AppPermissions => intersectPermissions(inst.permissions, app.permissions);

/** Permissions the app asks for that the installation hasn't accepted yet, or null. */
export function pendingPermissions(app: App, inst: Installation): AppPermissions | null {
  return widens(inst.permissions, app.permissions) ? app.permissions : null;
}

const bad = (message: string, field: string): never => {
  throw new HttpError(422, message, { errors: [{ resource: "Integration", code: "invalid", field }] });
};

/** A URL people are sent to or that receives deliveries: https, or http on a Worker that runs on this machine only. */
function checkUrl(env: Env, raw: unknown, field: string, o: { publicHost?: boolean } = {}): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_TEXT) return bad(`${field} must be a URL`, field);
  const dev = localOnly(env);
  if (o.publicHost) {
    try {
      return checkPublicUrl(raw.trim(), dev, field, dev ? undefined : new URL(env.PUBLIC_URL).hostname).toString();
    } catch (e) {
      return bad((e as Error).message.replace(/^\d{3}: /, ""), field);
    }
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return bad(`${field} is not a valid URL`, field);
  }
  if (u.username || u.password) return bad(`${field} must not contain credentials`, field);
  if (u.protocol !== "https:" && !(dev && u.protocol === "http:")) return bad(`${field} must use https`, field);
  return u.toString();
}

function wrapInput<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof AppInputError) return bad(e.message, e.field);
    throw e;
  }
}

export class Apps {
  constructor(
    private env: Env,
    private dir?: Directory,
  ) {}

  private get db() {
    return this.env.DB;
  }

  // ---------------------------------------------------------------- apps

  async byId(id: number): Promise<App | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const r = await this.db.prepare("SELECT * FROM apps WHERE id = ?").bind(id).first<AppRow>();
    return r ? appFromRow(r) : null;
  }

  async bySlug(slug: string): Promise<App | null> {
    const r = await this.db.prepare("SELECT * FROM apps WHERE slug = ?").bind(slug).first<AppRow>();
    return r ? appFromRow(r) : null;
  }

  async byClientId(clientId: string): Promise<App | null> {
    const r = await this.db.prepare("SELECT * FROM apps WHERE client_id = ?").bind(clientId).first<AppRow>();
    return r ? appFromRow(r) : null;
  }

  /** Apps owned by any of these accounts (a person and the organizations they administer), newest first. */
  async ownedBy(ownerIds: string[]): Promise<App[]> {
    if (!ownerIds.length) return [];
    const r = await this.db.prepare(`SELECT * FROM apps WHERE owner_id IN (${ownerIds.map(() => "?").join(", ")}) ORDER BY created_at DESC`).bind(...ownerIds).all<AppRow>();
    return r.results.map(appFromRow);
  }

  /** The fields of an app's settings that are set when creating it and may change later. */
  private async settings(input: AppInput, prev: App | null): Promise<Partial<AppRow>> {
    const out: Partial<AppRow> = {};
    if (input.description !== undefined) {
      if (typeof input.description !== "string" || input.description.length > MAX_TEXT) bad(`description must be text of at most ${MAX_TEXT} characters`, "description");
      out.description = (input.description as string).trim();
    }
    if (input.homepage_url !== undefined || !prev) out.homepage_url = checkUrl(this.env, input.homepage_url, "homepage_url");
    if (input.setup_url !== undefined) out.setup_url = input.setup_url === null || input.setup_url === "" ? null : checkUrl(this.env, input.setup_url, "setup_url");
    if (input.callback_urls !== undefined) {
      const list = input.callback_urls === null ? [] : input.callback_urls;
      if (!Array.isArray(list) || list.length > MAX_CALLBACK_URLS) bad(`callback_urls must be a list of at most ${MAX_CALLBACK_URLS} URLs`, "callback_urls");
      out.callback_urls = JSON.stringify((list as unknown[]).map((u) => checkUrl(this.env, u, "callback_urls")));
    }
    if (input.webhook_url !== undefined) out.webhook_url = input.webhook_url === null || input.webhook_url === "" ? null : checkUrl(this.env, input.webhook_url, "webhook_url", { publicHost: true });
    if (input.webhook_active !== undefined) {
      if (typeof input.webhook_active !== "boolean") bad("webhook_active must be true or false", "webhook_active");
      out.webhook_active = input.webhook_active ? 1 : 0;
    }
    if (input.public !== undefined) {
      if (typeof input.public !== "boolean") bad("public must be true or false", "public");
      out.public = input.public ? 1 : 0;
    }
    const permissions = input.default_permissions !== undefined ? wrapInput(() => parsePermissions(input.default_permissions)) : (prev?.permissions ?? { metadata: "read" as const });
    if (input.default_permissions !== undefined) out.permissions = JSON.stringify(permissions);
    if (input.default_events !== undefined || input.default_permissions !== undefined) {
      const events = input.default_events !== undefined ? input.default_events : (prev?.events ?? []).filter((e) => eventAllowed(e, permissions));
      out.events = JSON.stringify(wrapInput(() => parseEvents(events, permissions)));
    }
    return out;
  }

  /**
   * Register an app owned by `owner` (`by` itself, or an organization `by` owns or administers; the
   * caller checked that). Diffinery makes its first key: the private half is returned once and never
   * kept. Returns the webhook secret too when Diffinery chose it.
   */
  async create(owner: Account, by: Account, input: AppInput): Promise<{ app: App; privateKeyPem: string; webhookSecret: string | null }> {
    if (!isValidAppName(input.name)) bad("name is required: 1 to 34 characters, with at least one letter or digit", "name");
    const name = (input.name as string).trim();
    const slug = slugify(name);
    const count = await this.db.prepare("SELECT count(*) AS n FROM apps WHERE owner_id = ?").bind(owner.id).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_APPS_PER_OWNER) bad(`an account can own at most ${MAX_APPS_PER_OWNER} apps`, "name");
    if (await this.db.prepare("SELECT 1 FROM apps WHERE name = ? OR slug = ?").bind(name, slug).first()) bad(`an app named '${name}' already exists; choose another name`, "name");
    const s = await this.settings(input, null);
    let webhookSecret: string | null = null;
    let sealed: string | null = null;
    const at = now();
    const id = (await this.db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM apps").first<{ n: number }>())?.n ?? 1;
    if (s.webhook_url) {
      if (input.webhook_secret !== undefined && input.webhook_secret !== null && (typeof input.webhook_secret !== "string" || input.webhook_secret.length < 8 || input.webhook_secret.length > 256)) bad("webhook_secret must be 8 to 256 characters", "webhook_secret");
      const chosen = typeof input.webhook_secret === "string" ? input.webhook_secret : null;
      webhookSecret = chosen ? null : randomToken(24);
      sealed = await this.seal(id, chosen ?? webhookSecret!);
    }
    const key = await generateAppKey();
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO apps (id, slug, name, owner_id, description, homepage_url, setup_url, callback_urls, webhook_url, webhook_secret, webhook_active, permissions, events, public, client_id, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, slug, name, owner.id, s.description ?? "", s.homepage_url!, s.setup_url ?? null, s.callback_urls ?? "[]", s.webhook_url ?? null, sealed, s.webhook_active ?? 1, s.permissions ?? JSON.stringify({ metadata: "read" }), s.events ?? "[]", s.public ?? 0, `Iv23${randomAlnum(16)}`, by.id, at, at),
        this.db.prepare("INSERT INTO app_keys (id, app_id, public_key, fingerprint, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(), id, key.publicKey, key.fingerprint, by.id, at),
      ]);
    } catch (e) {
      // Two apps registered at once took the same id or name: the second one tries again.
      if (/UNIQUE|constraint/i.test((e as Error).message)) bad(`an app named '${name}' already exists, or another was registered at the same moment; try again`, "name");
      throw e;
    }
    return { app: (await this.byId(id))!, privateKeyPem: key.privateKeyPem, webhookSecret };
  }

  private seal(appId: number, secret: string): Promise<string> {
    return encryptSecret(this.env, `app-webhook:${appId}`, secret).catch((e: Error) => {
      throw new HttpError(422, `could not store the webhook secret: ${e.message || "encryption unavailable"} (is MASTER_KEY configured?)`);
    });
  }

  /** Change an app's settings. Its name, and so its slug and its bot's login, stay. */
  async update(app: App, input: AppInput): Promise<App> {
    if (input.name !== undefined && input.name !== app.name) bad("an app's name can't change; register a new app instead", "name");
    const s = await this.settings(input, app);
    if (input.webhook_secret !== undefined) {
      if (input.webhook_secret !== null && (typeof input.webhook_secret !== "string" || input.webhook_secret.length < 8 || input.webhook_secret.length > 256)) bad("webhook_secret must be 8 to 256 characters", "webhook_secret");
      s.webhook_secret = typeof input.webhook_secret === "string" ? await this.seal(app.id, input.webhook_secret) : null;
    }
    // A webhook URL needs a secret to sign deliveries with: one is made when there's none.
    let made: string | null = null;
    const url = s.webhook_url !== undefined ? s.webhook_url : app.webhookUrl;
    const secret = s.webhook_secret !== undefined ? s.webhook_secret : app.webhookSecret;
    if (url && !secret) {
      made = randomToken(24);
      s.webhook_secret = await this.seal(app.id, made);
    }
    const cols = Object.keys(s) as Array<keyof AppRow>;
    if (cols.length) {
      await this.db
        .prepare(`UPDATE apps SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...cols.map((k) => s[k] as string | number | null), now(), app.id)
        .run();
    }
    return { ...(await this.byId(app.id))!, ...(made ? { madeWebhookSecret: made } : {}) } as App;
  }

  /** Delete an app: its keys, every installation and their tokens go with it. */
  async delete(app: App): Promise<void> {
    const insts = `SELECT id FROM app_installations WHERE app_id = ?`;
    await this.db.batch([
      this.db.prepare(`DELETE FROM app_installation_tokens WHERE installation_id IN (${insts})`).bind(app.id),
      this.db.prepare(`DELETE FROM app_installation_repos WHERE installation_id IN (${insts})`).bind(app.id),
      this.db.prepare("DELETE FROM app_installations WHERE app_id = ?").bind(app.id),
      this.db.prepare("DELETE FROM app_keys WHERE app_id = ?").bind(app.id),
      this.db.prepare("DELETE FROM apps WHERE id = ?").bind(app.id),
    ]);
  }

  /** Statements that delete every app an account owns and every installation on it (account deletion). */
  accountDeletes(accountIds: string[]): D1PreparedStatement[] {
    const ids = accountIds.map(() => "?").join(", ");
    const apps = `SELECT id FROM apps WHERE owner_id IN (${ids})`;
    const insts = `SELECT id FROM app_installations WHERE account_id IN (${ids}) OR app_id IN (${apps})`;
    const both = [...accountIds, ...accountIds];
    return [
      this.db.prepare(`DELETE FROM app_installation_tokens WHERE installation_id IN (${insts})`).bind(...both),
      this.db.prepare(`DELETE FROM app_installation_repos WHERE installation_id IN (${insts})`).bind(...both),
      this.db.prepare(`DELETE FROM app_installations WHERE account_id IN (${ids}) OR app_id IN (${apps})`).bind(...both),
      this.db.prepare(`DELETE FROM app_keys WHERE app_id IN (${apps})`).bind(...accountIds),
      this.db.prepare(`DELETE FROM apps WHERE owner_id IN (${ids})`).bind(...accountIds),
    ];
  }

  async recordDelivery(appId: number, status: number): Promise<void> {
    await this.db.prepare("UPDATE apps SET last_delivery_at = ?, last_delivery_status = ? WHERE id = ?").bind(now(), status, appId).run();
  }

  // ---------------------------------------------------------------- keys

  async keys(appId: number): Promise<Array<{ id: string; publicKey: string; fingerprint: string; createdAt: string; lastUsedAt: string | null }>> {
    const r = await this.db.prepare("SELECT * FROM app_keys WHERE app_id = ? ORDER BY created_at").bind(appId).all<{ id: string; public_key: string; fingerprint: string; created_at: string; last_used_at: string | null }>();
    return r.results.map((k) => ({ id: k.id, publicKey: k.public_key, fingerprint: k.fingerprint, createdAt: k.created_at, lastUsedAt: k.last_used_at }));
  }

  /** Add a key: Diffinery makes one (the private half is returned once) or takes a public key in PEM. */
  async addKey(app: App, by: Account, publicKeyPem?: unknown): Promise<{ id: string; fingerprint: string; privateKeyPem: string | null }> {
    const count = await this.db.prepare("SELECT count(*) AS n FROM app_keys WHERE app_id = ?").bind(app.id).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_KEYS) bad(`an app can have at most ${MAX_KEYS} keys; delete one first`, "public_key");
    let key: { publicKey: string; fingerprint: string; privateKeyPem: string | null };
    if (publicKeyPem === undefined || publicKeyPem === null || publicKeyPem === "") key = await generateAppKey();
    else {
      try {
        key = { ...(await parsePublicKey(publicKeyPem as string)), privateKeyPem: null };
      } catch (e) {
        if (e instanceof KeyError) return bad(e.message, "public_key");
        throw e;
      }
    }
    if (await this.db.prepare("SELECT 1 FROM app_keys WHERE app_id = ? AND fingerprint = ?").bind(app.id, key.fingerprint).first()) bad("the app already has this key", "public_key");
    const id = newId();
    await this.db.prepare("INSERT INTO app_keys (id, app_id, public_key, fingerprint, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, app.id, key.publicKey, key.fingerprint, by.id, now()).run();
    return { id, fingerprint: key.fingerprint, privateKeyPem: key.privateKeyPem };
  }

  async deleteKey(app: App, keyId: string): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM app_keys WHERE app_id = ? AND id = ?").bind(app.id, keyId).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /**
   * The app a JWT signed with one of its keys stands for, or a 401 in GitHub's words. `iss` is the
   * app's id (a number, or a string of digits) or its client id.
   */
  async appForJwt(token: string): Promise<App> {
    const read = readJwt(token);
    if (!read) throw new HttpError(401, "A JSON web token could not be decoded");
    const iss = read.claims.iss;
    const app = typeof iss === "number" || (typeof iss === "string" && /^\d{1,15}$/.test(iss)) ? await this.byId(Number(iss)) : typeof iss === "string" && iss.length <= 64 ? await this.byClientId(iss) : null;
    if (!app) throw new HttpError(401, "'Issuer' claim ('iss') must be an Integer");
    const keys = await this.keys(app.id);
    const v = await verifyAppJwt(token, keys);
    if ("error" in v) throw new HttpError(401, v.error);
    const used = keys.find((k) => k.id === v.keyId);
    if (used && (!used.lastUsedAt || Date.now() - Date.parse(used.lastUsedAt) > 3600_000)) {
      await this.db.prepare("UPDATE app_keys SET last_used_at = ? WHERE id = ?").bind(now(), used.id).run().catch(() => {});
    }
    return app;
  }

  // ---------------------------------------------------------------- installations

  async installation(id: number): Promise<Installation | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const r = await this.db.prepare("SELECT * FROM app_installations WHERE id = ?").bind(id).first<InstallationRow>();
    return r ? installationFromRow(r) : null;
  }

  async installationFor(appId: number, accountId: string): Promise<Installation | null> {
    const r = await this.db.prepare("SELECT * FROM app_installations WHERE app_id = ? AND account_id = ?").bind(appId, accountId).first<InstallationRow>();
    return r ? installationFromRow(r) : null;
  }

  async installationsOf(appId: number): Promise<Installation[]> {
    const r = await this.db.prepare("SELECT * FROM app_installations WHERE app_id = ? ORDER BY id").bind(appId).all<InstallationRow>();
    return r.results.map(installationFromRow);
  }

  /** Installations on any of these accounts, with their apps (Settings → Installed apps). */
  async installationsOn(accountIds: string[]): Promise<Array<{ installation: Installation; app: App }>> {
    if (!accountIds.length) return [];
    const r = await this.db
      .prepare(`SELECT i.*, a.id AS a_id, a.slug AS a_slug FROM app_installations i JOIN apps a ON a.id = i.app_id WHERE i.account_id IN (${accountIds.map(() => "?").join(", ")}) ORDER BY i.created_at DESC`)
      .bind(...accountIds)
      .all<InstallationRow>();
    const apps = new Map<number, App>();
    for (const id of new Set(r.results.map((i) => i.app_id))) {
      const a = await this.byId(id);
      if (a) apps.set(id, a);
    }
    return r.results.filter((i) => apps.has(i.app_id)).map((i) => ({ installation: installationFromRow(i), app: apps.get(i.app_id)! }));
  }

  /** Repository ids an installation with selected repositories covers. */
  async selectedRepoIds(installationId: number): Promise<string[]> {
    const r = await this.db.prepare("SELECT repo_id FROM app_installation_repos WHERE installation_id = ?").bind(installationId).all<{ repo_id: string }>();
    return r.results.map((x) => x.repo_id);
  }

  /** The repositories an installation covers now, most recently pushed first. */
  async reposOf(inst: Installation): Promise<Repo[]> {
    const base = "SELECT r.*, a.login AS owner_login, a.kind AS owner_kind, a.suspended_at AS owner_suspended_at FROM repos r JOIN accounts a ON a.id = r.owner_id";
    const q =
      inst.selection === "all"
        ? this.db.prepare(`${base} WHERE r.owner_id = ? ORDER BY COALESCE(r.pushed_at, r.updated_at) DESC LIMIT ${MAX_INSTALLATION_REPOS}`).bind(inst.accountId)
        : this.db.prepare(`${base} WHERE r.owner_id = ? AND r.id IN (SELECT repo_id FROM app_installation_repos WHERE installation_id = ?) ORDER BY COALESCE(r.pushed_at, r.updated_at) DESC LIMIT ${MAX_INSTALLATION_REPOS}`).bind(inst.accountId, inst.id);
    return (await q.all<Repo>()).results;
  }

  /** Whether an installation covers a repository: one of its account's, and selected if it picks repositories. */
  async covers(inst: Installation, repo: Pick<Repo, "id" | "owner_id">): Promise<boolean> {
    if (repo.owner_id !== inst.accountId) return false;
    if (inst.selection === "all") return true;
    return !!(await this.db.prepare("SELECT 1 FROM app_installation_repos WHERE installation_id = ? AND repo_id = ?").bind(inst.id, repo.id).first());
  }

  /** The account's repositories with these ids; any other id is refused, so an installation never names someone else's. */
  private async ownRepos(accountId: string, repoIds: unknown): Promise<string[]> {
    if (!Array.isArray(repoIds) || repoIds.some((id) => typeof id !== "string")) bad("repositories must be a list", "repositories");
    const ids = [...new Set(repoIds as string[])];
    if (ids.length > MAX_INSTALLATION_REPOS) bad(`an installation can select at most ${MAX_INSTALLATION_REPOS} repositories`, "repositories");
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const r = await this.db.prepare(`SELECT id FROM repos WHERE owner_id = ? AND id IN (${part.map(() => "?").join(", ")})`).bind(accountId, ...part).all<{ id: string }>();
      for (const x of r.results) found.add(x.id);
    }
    if (found.size !== ids.length) bad("a selected repository doesn't belong to the account the app is installed on", "repositories");
    return ids;
  }

  /**
   * Install `app` on `account` (a person installing on their own account, or an owner or admin of an
   * organization: the caller checked). A private app installs only on its owner's account.
   */
  async install(app: App, account: Account, by: Account, selection: "all" | "selected", repoIds: string[] = []): Promise<{ installation: Installation; repoIds: string[] }> {
    if (!app.public && account.id !== app.ownerId) throw new HttpError(403, `${app.name} is private: only its owner's account can install it`);
    if (account.kind === "agent" || account.status !== "active") throw new HttpError(422, "apps can be installed on people and organizations");
    if (selection !== "all" && selection !== "selected") bad("repository_selection must be all or selected", "repository_selection");
    const ids = selection === "selected" ? await this.ownRepos(account.id, repoIds) : [];
    if (selection === "selected" && !ids.length) bad("choose at least one repository, or all of them", "repositories");
    if (await this.installationFor(app.id, account.id)) throw new HttpError(422, `${app.name} is already installed on ${account.login}; change its repositories in the installation's settings`);
    const at = now();
    try {
      await this.db
        .prepare("INSERT INTO app_installations (app_id, account_id, repository_selection, permissions, events, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(app.id, account.id, selection, JSON.stringify(app.permissions), JSON.stringify(app.events), by.id, at, at)
        .run();
    } catch (e) {
      if (/UNIQUE|constraint/i.test((e as Error).message)) throw new HttpError(422, `${app.name} is already installed on ${account.login}`);
      throw e;
    }
    const inst = (await this.installationFor(app.id, account.id))!;
    if (ids.length) await this.db.batch(ids.map((id) => this.db.prepare("INSERT OR IGNORE INTO app_installation_repos (installation_id, repo_id) VALUES (?, ?)").bind(inst.id, id)));
    return { installation: inst, repoIds: ids };
  }

  /** Change which repositories an installation covers. Returns what was added and removed (by id). */
  async setRepositories(inst: Installation, selection: "all" | "selected", repoIds: string[] = []): Promise<{ installation: Installation; added: string[]; removed: string[] }> {
    if (selection !== "all" && selection !== "selected") bad("repository_selection must be all or selected", "repository_selection");
    const ids = selection === "selected" ? await this.ownRepos(inst.accountId, repoIds) : [];
    if (selection === "selected" && !ids.length) bad("choose at least one repository, or all of them", "repositories");
    const before = inst.selection === "all" ? (await this.reposOf(inst)).map((r) => r.id) : await this.selectedRepoIds(inst.id);
    const after = selection === "all" ? (await this.reposOf({ ...inst, selection: "all" })).map((r) => r.id) : ids;
    const added = after.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !after.includes(id));
    await this.db.batch([
      this.db.prepare("DELETE FROM app_installation_repos WHERE installation_id = ?").bind(inst.id),
      ...ids.map((id) => this.db.prepare("INSERT OR IGNORE INTO app_installation_repos (installation_id, repo_id) VALUES (?, ?)").bind(inst.id, id)),
      this.db.prepare("UPDATE app_installations SET repository_selection = ?, updated_at = ? WHERE id = ?").bind(selection, now(), inst.id),
      // Tokens narrowed to a repository the installation no longer covers stop at their next check (verifyToken).
    ]);
    return { installation: (await this.installation(inst.id))!, added, removed };
  }

  /** Add or remove one repository (GitHub's PUT and DELETE /user/installations/{id}/repositories/{repo_id}). */
  async toggleRepository(inst: Installation, repo: Repo, add: boolean): Promise<boolean> {
    if (repo.owner_id !== inst.accountId) throw new HttpError(422, "that repository doesn't belong to the account the app is installed on");
    if (inst.selection === "all") throw new HttpError(422, "the installation covers all repositories: switch it to selected repositories first");
    if (add) {
      const n = await this.db.prepare("SELECT count(*) AS n FROM app_installation_repos WHERE installation_id = ?").bind(inst.id).first<{ n: number }>();
      if ((n?.n ?? 0) >= MAX_INSTALLATION_REPOS) bad(`an installation can select at most ${MAX_INSTALLATION_REPOS} repositories`, "repositories");
      const r = await this.db.prepare("INSERT OR IGNORE INTO app_installation_repos (installation_id, repo_id) VALUES (?, ?)").bind(inst.id, repo.id).run();
      return (r.meta.changes ?? 0) > 0;
    }
    const left = await this.db.prepare("SELECT count(*) AS n FROM app_installation_repos WHERE installation_id = ?").bind(inst.id).first<{ n: number }>();
    if ((left?.n ?? 0) <= 1 && (await this.covers(inst, repo))) throw new HttpError(422, "an installation needs at least one repository: uninstall the app instead");
    const r = await this.db.prepare("DELETE FROM app_installation_repos WHERE installation_id = ? AND repo_id = ?").bind(inst.id, repo.id).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async uninstall(inst: Installation): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM app_installation_tokens WHERE installation_id = ?").bind(inst.id),
      this.db.prepare("DELETE FROM app_installation_repos WHERE installation_id = ?").bind(inst.id),
      this.db.prepare("DELETE FROM app_installations WHERE id = ?").bind(inst.id),
    ]);
  }

  async suspend(inst: Installation, by: Account | null, suspended: boolean): Promise<Installation> {
    await this.db
      .prepare("UPDATE app_installations SET suspended_at = ?, suspended_by = ?, updated_at = ? WHERE id = ?")
      .bind(suspended ? now() : null, suspended ? (by?.id ?? null) : null, now(), inst.id)
      .run();
    if (suspended) await this.db.prepare("UPDATE app_installation_tokens SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL").bind(now(), inst.id).run();
    return (await this.installation(inst.id))!;
  }

  /** An admin of the account accepts the permissions the app asks for now. */
  async acceptPermissions(inst: Installation, app: App): Promise<Installation> {
    await this.db.prepare("UPDATE app_installations SET permissions = ?, events = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(app.permissions), JSON.stringify(app.events), now(), inst.id).run();
    return (await this.installation(inst.id))!;
  }

  /** Active installations of apps with a webhook that cover a repository: who hears about its events. */
  async listenersFor(repo: Pick<Repo, "id" | "owner_id">): Promise<Array<{ installation: Installation; app: App }>> {
    const r = await this.db
      .prepare(
        `SELECT i.* FROM app_installations i JOIN apps a ON a.id = i.app_id
         WHERE i.account_id = ? AND i.suspended_at IS NULL AND a.webhook_url IS NOT NULL AND a.webhook_active = 1
           AND (i.repository_selection = 'all' OR i.id IN (SELECT installation_id FROM app_installation_repos WHERE repo_id = ?))`,
      )
      .bind(repo.owner_id, repo.id)
      .all<InstallationRow>();
    const out: Array<{ installation: Installation; app: App }> = [];
    for (const row of r.results) {
      const app = await this.byId(row.app_id);
      if (app) out.push({ installation: installationFromRow(row), app });
    }
    return out;
  }

  // ---------------------------------------------------------------- installation tokens

  /**
   * An installation access token for an hour, as `POST /app/installations/{id}/access_tokens` makes:
   * for everything the installation covers, or narrowed to some repositories (by name or numeric id)
   * and permissions, never beyond the installation's.
   */
  async mintToken(
    app: App,
    inst: Installation,
    req: { repositories?: unknown; repositoryIds?: unknown; permissions?: unknown },
    numericIdOf: (repoId: string) => number,
  ): Promise<{ token: string; expiresAt: string; permissions: AppPermissions; repos: Repo[] | null }> {
    if (inst.suspendedAt) throw new HttpError(403, "This installation has been suspended");
    const permissions = wrapInput(() => narrowPermissions(effectivePermissions(app, inst), req.permissions));
    let repos: Repo[] | null = null;
    const names = req.repositories;
    const ids = req.repositoryIds;
    if (names !== undefined || ids !== undefined) {
      if (names !== undefined && (!Array.isArray(names) || names.some((n) => typeof n !== "string"))) bad("repositories must be a list of repository names", "repositories");
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((n) => typeof n !== "number"))) bad("repository_ids must be a list of repository ids", "repository_ids");
      const wantNames = new Set(((names as string[] | undefined) ?? []).map((n) => n.toLowerCase().replace(/^[^/]+\//, "")));
      const wantIds = new Set((ids as number[] | undefined) ?? []);
      if (wantNames.size + wantIds.size > MAX_TOKEN_REPOS) bad(`a token can name at most ${MAX_TOKEN_REPOS} repositories`, "repositories");
      if (wantNames.size + wantIds.size) {
        const all = await this.reposOf(inst);
        repos = all.filter((r) => wantNames.has(r.name.toLowerCase()) || wantIds.has(numericIdOf(r.id)));
        if (repos.length !== wantNames.size + wantIds.size) throw new HttpError(422, "There is at least one repository that does not exist or is not accessible to the parent installation.");
      }
    }
    const token = `${INSTALLATION_TOKEN_PREFIX}${randomAlnum(40)}`;
    const expiresAt = new Date(Date.now() + INSTALLATION_TOKEN_TTL_S * 1000).toISOString();
    await this.db
      .prepare("INSERT INTO app_installation_tokens (token_hash, installation_id, repo_ids, permissions, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256(token), inst.id, repos ? JSON.stringify(repos.map((r) => r.id)) : null, JSON.stringify(permissions), now(), expiresAt)
      .run();
    return { token, expiresAt, permissions, repos };
  }

  /**
   * What an installation token may do now, or null: unknown, expired or revoked; its installation
   * suspended or gone; its app gone; or the account it's installed on no longer active.
   */
  async verifyToken(token: string): Promise<InstallationAuth | null> {
    if (!token.startsWith(INSTALLATION_TOKEN_PREFIX) || token.length > 100) return null;
    const hash = await sha256(token);
    const row = await this.db
      .prepare(
        `SELECT t.repo_ids AS t_repo_ids, t.permissions AS t_permissions, t.expires_at AS t_expires_at, t.revoked_at AS t_revoked_at, i.*
         FROM app_installation_tokens t JOIN app_installations i ON i.id = t.installation_id WHERE t.token_hash = ?`,
      )
      .bind(hash)
      .first<InstallationRow & { t_repo_ids: string | null; t_permissions: string; t_expires_at: string; t_revoked_at: string | null }>();
    if (!row || row.t_revoked_at || row.t_expires_at < now() || row.suspended_at) return null;
    const [app, account] = await Promise.all([this.byId(row.app_id), this.dir ? this.dir.account(row.account_id) : this.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(row.account_id).first<Account>()]);
    if (!app || !account || account.status !== "active" || account.suspended_at) return null;
    const inst = installationFromRow(row);
    // Never more than the installation and the app grant now, whatever the token was made with.
    const permissions = intersectPermissions(JSON.parse(row.t_permissions) as AppPermissions, effectivePermissions(app, inst));
    return { installation: inst, app, account, repoIds: row.t_repo_ids ? (JSON.parse(row.t_repo_ids) as string[]) : null, permissions, tokenHash: hash };
  }

  async revokeToken(tokenHash: string): Promise<void> {
    await this.db.prepare("UPDATE app_installation_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now(), tokenHash).run();
  }

  /** Tokens a day past their expiry (the hourly cron). */
  async prune(): Promise<void> {
    await this.db.prepare("DELETE FROM app_installation_tokens WHERE expires_at < ?").bind(new Date(Date.now() - 86400_000).toISOString()).run();
  }
}
