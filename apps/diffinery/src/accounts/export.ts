import type { Env } from "../env.js";
import type { Account } from "../lib/directory.js";
import { Directory } from "../lib/directory.js";
import { tarEnd, tarFileHeader, tarPadding } from "../lib/archive.js";
import { R2Sink } from "../lib/r2-sink.js";
import { deletePrefixes } from "../lib/storage-keys.js";
import { HttpError, newId, now } from "../lib/util.js";
import { MailStore } from "../mail/prefs.js";
import { enqueueMail } from "../mail/send.js";

/**
 * Exports of an account's data (Settings → Account → Export your data), like GitHub's account archive.
 *
 * The person asks; AccountWorkflow builds the archive in the background, one piece per step, under
 * exports/<account id>/<export id>/parts/, then puts the pieces together into one uncompressed tar archive
 * (the Git bundles inside are already compressed) and emails the person a link. They download it from
 * Settings → Account for {@link EXPORT_DAYS} days; then the cron deletes it (and an R2 age rule on exports/ is
 * the backstop). One export at a time per account.
 *
 * Inside the archive, under `diffinery-export-<login>/`:
 *
 * | Path | What |
 * |------|------|
 * | `manifest.json` | format version, account, when it was made, and every file with its size |
 * | `account.json` | profile, settings (appearance, notification settings, watched repositories), organizations, agents, access tokens and passkeys (names and dates only, never secrets), linked accounts |
 * | `repositories/<name>.json` | each repository the account owns: description, visibility, default branch, topics, clone URL |
 * | `repositories/<name>.bundle` | its branches and tags as a Git bundle: `git clone <name>.bundle` |
 * | `issues/<owner>/<repo>.json` | issues and pull requests the account opened, comments and reviews it wrote, per repository it can see |
 *
 * A repository too large to bundle ({@link MAX_BUNDLE_BYTES}) has no bundle; its JSON says so and gives the clone URL.
 */

export const EXPORT_DAYS = 7;
/** Archive format version, in manifest.json. */
export const EXPORT_FORMAT = 1;
/** Largest repository bundle in an export; tar's plain header holds sizes up to 8 GiB. */
export const MAX_BUNDLE_BYTES = 4 * 1024 ** 3;
/** Largest whole archive (R2 multipart: 10,000 parts of 8 MiB). */
const MAX_ARCHIVE_BYTES = 75 * 1024 ** 3;
/** How many repositories one step looks through for what the account wrote. */
export const AUTHORED_PAGE = 20;

export interface ExportRow {
  id: string;
  account_id: string;
  status: "queued" | "running" | "ready" | "failed";
  r2_key: string | null;
  size: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
}

export interface ExportJob {
  kind: "export";
  exportId: string;
}

const prefix = (row: Pick<ExportRow, "account_id" | "id">) => `exports/${row.account_id}/${row.id}/`;
const partsPrefix = (row: Pick<ExportRow, "account_id" | "id">) => `${prefix(row)}parts/`;
const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);

async function row(env: Env, id: string): Promise<ExportRow> {
  const r = await env.DB.prepare("SELECT * FROM account_exports WHERE id = ?").bind(id).first<ExportRow>();
  if (!r) throw new HttpError(404, "no such export");
  return r;
}

async function owner(env: Env, r: ExportRow): Promise<Account> {
  const a = await new Directory(env).account(r.account_id);
  if (!a || a.deleted_at) throw new HttpError(404, "the account was deleted");
  return a;
}

/** The account's exports, newest first (Settings → Account). Expired ones are left out. */
export async function exportsFor(env: Env, accountId: string): Promise<ExportRow[]> {
  const r = await env.DB.prepare("SELECT * FROM account_exports WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 5").bind(accountId, now()).all<ExportRow>();
  return r.results;
}

/** Ask for an export. Refused while another one is being built. Earlier archives are replaced. */
export async function requestExport(env: Env, account: Account): Promise<ExportRow> {
  const busy = await env.DB.prepare("SELECT 1 FROM account_exports WHERE account_id = ? AND status IN ('queued', 'running') AND created_at > ?").bind(account.id, new Date(Date.now() - 86400_000).toISOString()).first();
  if (busy) throw new HttpError(409, "An export is already being prepared. We'll email you when it's ready.");
  const old = await env.DB.prepare("SELECT * FROM account_exports WHERE account_id = ?").bind(account.id).all<ExportRow>();
  await deletePrefixes(env.BUCKET, old.results.map(prefix));
  const id = newId();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_exports WHERE account_id = ?").bind(account.id),
    env.DB.prepare("INSERT INTO account_exports (id, account_id, status, created_at) VALUES (?, ?, 'queued', ?)").bind(id, account.id, now()),
  ]);
  const job: ExportJob = { kind: "export", exportId: id };
  if (env.ACCOUNT_WORKFLOW) await env.ACCOUNT_WORKFLOW.create({ id: `export-${id}`, params: job });
  else await buildExport(env, id);
  return row(env, id);
}

/** The whole export in one go: what AccountWorkflow does step by step (used when there is no workflow binding). */
async function buildExport(env: Env, id: string): Promise<void> {
  try {
    const plan = await startExport(env, id);
    await exportAccount(env, id);
    for (const r of plan.owned) await exportRepository(env, id, r);
    for (let i = 0; i < plan.visible.length; i += AUTHORED_PAGE) await exportAuthored(env, id, plan.visible.slice(i, i + AUTHORED_PAGE));
    await assembleExport(env, id);
  } catch (e) {
    await failExport(env, id, e instanceof Error ? e.message : String(e));
  }
}

/** Public repositories of other people an export looks through for what the account wrote. */
const EXPORT_PUBLIC_REPOS = 1000;

/** First step: mark the export running and list the repositories it covers. */
export async function startExport(env: Env, id: string): Promise<{ owned: string[]; visible: string[] }> {
  const r = await row(env, id);
  const account = await owner(env, r);
  await env.DB.prepare("UPDATE account_exports SET status = 'running' WHERE id = ?").bind(id).run();
  const dir = new Directory(env);
  const owned = (await env.DB.prepare("SELECT id FROM repos WHERE owner_id = ? ORDER BY name").bind(account.id).all<{ id: string }>()).results.map((x) => x.id);
  // Issues and pull requests the account wrote: in the repositories it works with, and in public
  // ones (reposVisibleTo leaves those out), the most recently pushed first.
  const [visible, open] = await Promise.all([dir.reposVisibleTo(account), dir.publicRepos(EXPORT_PUBLIC_REPOS)]);
  return { owned, visible: [...new Set([...owned, ...visible.map((x) => x.id), ...open.map((x) => x.id)])] };
}

/** account.json: the profile and settings. Tokens and passkeys by name only: nothing in the archive signs anyone in. */
export async function exportAccount(env: Env, id: string): Promise<void> {
  const r = await row(env, id);
  const a = await owner(env, r);
  const db = env.DB;
  const all = async <T>(q: string) => (await db.prepare(q).bind(a.id).all<T>()).results;
  const data = {
    login: a.login,
    name: a.name,
    email: a.email,
    created_at: a.created_at,
    site_admin: !!a.site_admin,
    avatar_url: `${env.PUBLIC_URL}/api/avatars/${encodeURIComponent(a.login)}`,
    settings: {
      appearance: a.appearance ?? "auto",
      notifications: await new MailStore(db).prefs(a.id),
      watching: await all("SELECT a.login || '/' || r.name AS repository, w.level FROM repo_watches w JOIN repos r ON r.id = w.repo_id JOIN accounts a ON a.id = r.owner_id WHERE w.account_id = ? ORDER BY 1"),
    },
    organizations: await all("SELECT o.login, m.role, m.created_at AS joined_at FROM org_members m JOIN accounts o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.login"),
    agents: await all("SELECT login, name, status, created_at FROM accounts WHERE kind = 'agent' AND owner_id = ? AND deleted_at IS NULL ORDER BY login"),
    tokens: (await all<{ name: string; prefix: string; scopes: string; expires_at: string; last_used_at: string | null; created_at: string }>("SELECT name, prefix, scopes, expires_at, last_used_at, created_at FROM tokens WHERE account_id = ? AND revoked_at IS NULL AND import_id IS NULL ORDER BY created_at")).map((t) => ({ ...t, scopes: JSON.parse(t.scopes) as string[] })),
    passkeys: await all("SELECT name, created_at, last_used_at, backed_up AS synced FROM passkeys WHERE account_id = ? ORDER BY created_at"),
    linked_accounts: await all("SELECT provider, api_base, external_login AS login, created_at FROM account_links WHERE account_id = ? ORDER BY created_at"),
    model_keys: await all("SELECT provider, hint, created_at FROM model_keys WHERE account_id = ? ORDER BY provider"),
  };
  await env.BUCKET.put(`${partsPrefix(r)}account.json`, json(data));
}

/** repositories/<name>.json, and its Git bundle when the repository has commits and isn't too large. */
export async function exportRepository(env: Env, id: string, repoId: string): Promise<void> {
  const r = await row(env, id);
  const repo = await new Directory(env).repoById(repoId);
  if (!repo) return;
  const at = `${partsPrefix(r)}repositories/${repo.name}`;
  let bundle: string | null = null;
  let note: string | undefined;
  try {
    const b = await env.REPO.get(env.REPO.idFromName(repo.id)).writeBundle(`${at}.bundle`, MAX_BUNDLE_BYTES);
    if (b) bundle = `${repo.name}.bundle`;
    else note = "The repository has no branches or tags yet.";
  } catch (e) {
    if (!(e instanceof Error) || !/too large/.test(e.message)) throw e;
    note = `The repository is larger than ${MAX_BUNDLE_BYTES / 1024 ** 3} GiB, too large to bundle: clone it from clone_url.`;
  }
  const meta = {
    name: repo.name,
    full_name: `${repo.owner_login}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    default_branch: repo.default_branch,
    archived: !!repo.archived,
    topics: JSON.parse(repo.topics ?? "[]") as string[],
    homepage: repo.homepage ?? "",
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    clone_url: `${env.PUBLIC_URL}/${repo.owner_login}/${repo.name}.git`,
    bundle,
    ...(note ? { note } : {}),
  };
  await env.BUCKET.put(`${at}.json`, json(meta));
}

/** issues/<owner>/<repo>.json for each of these repositories where the account wrote something. */
export async function exportAuthored(env: Env, id: string, repoIds: string[]): Promise<void> {
  const r = await row(env, id);
  const dir = new Directory(env);
  await Promise.all(
    repoIds.map(async (repoId) => {
      const repo = await dir.repoById(repoId);
      if (!repo) return;
      const mine = await env.REPO.get(env.REPO.idFromName(repo.id)).authoredBy([r.account_id]);
      if (!mine.issues.length && !mine.comments.length && !mine.reviews.length) return;
      await env.BUCKET.put(`${partsPrefix(r)}issues/${repo.owner_login}/${repo.name}.json`, json({ repository: `${repo.owner_login}/${repo.name}`, ...mine }));
    }),
  );
}

/** Last step: the pieces become one tar archive, the pieces go, and the person hears that it's ready. */
export async function assembleExport(env: Env, id: string): Promise<void> {
  const r = await row(env, id);
  const a = await owner(env, r);
  const parts: Array<{ key: string; path: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: partsPrefix(r), cursor });
    for (const o of page.objects) parts.push({ key: o.key, path: o.key.slice(partsPrefix(r).length), size: o.size });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  parts.sort((x, y) => (x.path === "account.json" ? -1 : y.path === "account.json" ? 1 : x.path.localeCompare(y.path)));
  const day = now().slice(0, 10);
  const top = `diffinery-export-${a.login}`;
  const key = `${prefix(r)}${top}-${day}.tar`;
  const mtime = Math.floor(Date.now() / 1000);
  const manifest = json({ format: EXPORT_FORMAT, instance: env.PUBLIC_URL, account: a.login, created_at: now(), files: parts.map((p) => ({ path: p.path, size: p.size })) });
  const sink = new R2Sink(env.BUCKET, key, "application/x-tar", MAX_ARCHIVE_BYTES, "the export is too large");
  try {
    for (const b of tarFileHeader(`${top}/manifest.json`, manifest.length, mtime)) await sink.write(b);
    await sink.write(manifest);
    await sink.write(tarPadding(manifest.length));
    for (const p of parts) {
      const obj = await env.BUCKET.get(p.key);
      if (!obj) throw new Error(`a piece of the export is missing: ${p.path}`);
      for (const b of tarFileHeader(`${top}/${p.path}`, obj.size, mtime)) await sink.write(b);
      const reader = obj.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await sink.write(value);
      }
      await sink.write(tarPadding(obj.size));
    }
    await sink.write(tarEnd());
  } catch (e) {
    await sink.abort();
    throw e;
  }
  const size = await sink.close();
  await deletePrefixes(env.BUCKET, [partsPrefix(r)]);
  const expires = new Date(Date.now() + EXPORT_DAYS * 86400_000).toISOString();
  await env.DB.prepare("UPDATE account_exports SET status = 'ready', r2_key = ?, size = ?, finished_at = ?, expires_at = ? WHERE id = ?").bind(key, size, now(), expires, id).run();
  await enqueueMail(env, [{ kind: "export_ready", data: { url: `${env.PUBLIC_URL}/settings/account`, size, expiresAt: expires }, to: { accountId: a.id }, reason: "account", at: now() }]);
}

/** The export failed for good: say why on Settings → Account, and drop its pieces. */
export async function failExport(env: Env, id: string, message: string): Promise<void> {
  const r = await env.DB.prepare("SELECT * FROM account_exports WHERE id = ?").bind(id).first<ExportRow>();
  if (!r) return;
  await deletePrefixes(env.BUCKET, [prefix(r)]).catch(() => false);
  await env.DB.prepare("UPDATE account_exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").bind(message.slice(0, 500), now(), id).run();
}

/** The archive of a ready, unexpired export of this account, for downloading. */
export async function exportArchive(env: Env, accountId: string, id: string): Promise<{ body: ReadableStream; size: number; name: string }> {
  const r = await env.DB.prepare("SELECT * FROM account_exports WHERE id = ? AND account_id = ?").bind(id, accountId).first<ExportRow>();
  if (!r || r.status !== "ready" || !r.r2_key) throw new HttpError(404, "no such export");
  if (!r.expires_at || r.expires_at < now()) throw new HttpError(410, "this export has expired; ask for a new one");
  const obj = await env.BUCKET.get(r.r2_key);
  if (!obj) throw new HttpError(410, "this export has expired; ask for a new one");
  return { body: obj.body, size: obj.size, name: r.r2_key.split("/").at(-1)! };
}

/** Cron: delete exports past their 7 days, and ones stuck building for more than a day. */
export async function expireExports(env: Env): Promise<void> {
  const old = await env.DB.prepare("SELECT * FROM account_exports WHERE expires_at < ? OR (status IN ('queued', 'running', 'failed') AND created_at < ?) LIMIT 50")
    .bind(now(), new Date(Date.now() - 86400_000).toISOString())
    .all<ExportRow>();
  for (const r of old.results) {
    if (await deletePrefixes(env.BUCKET, [prefix(r)], 50)) await env.DB.prepare("DELETE FROM account_exports WHERE id = ?").bind(r.id).run();
  }
}
