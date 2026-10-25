import { Apps } from "../apps/store.js";
import type { Env } from "../env.js";
import type { Account, Directory } from "../lib/directory.js";
import { deletePrefixes } from "../lib/storage-keys.js";
import { HttpError, now } from "../lib/util.js";
import { enqueueMail } from "../mail/send.js";
import { RegistryStore } from "../registry/store.js";

/**
 * The end of an account's life, and who runs the instance.
 *
 * Deleting an account (Settings → Account, or a site administrator in Site administration) removes, at once,
 * the person's repositories (their rows; each repository's Durable Object and R2 objects go in the background
 * through the same `destroy()` as deleting one repository), container images, access tokens, browser
 * sessions, passkeys, agents (and their tokens), organization memberships, collaborator grants, invitations,
 * notifications and settings, linked accounts, model keys, quota rows, the email log and any exports. What
 * the person wrote in other people's repositories stays, attributed to the `ghost` user as on GitHub
 * (RepoDO.forgetAccounts, also in the background, which also removes self-hosted runners they registered).
 * The account row stays, disabled under the placeholder login `deleted-<id>`, because the audit log and import
 * history refer to it; its username can be taken again after {@link LOGIN_COOLDOWN_DAYS} days.
 *
 * Deleting is refused while the person is the only owner of an organization, the only site administrator, or
 * has an import into their account in progress.
 */

/** Days before a deleted account's username can be used again (GitHub uses 90 too). */
export const LOGIN_COOLDOWN_DAYS = 90;

/** What the background part of deleting an account works on (AccountWorkflow). */
export interface DeletionCleanup {
  kind: "delete";
  accountId: string;
  /** The person and their agents: whose work becomes the ghost's. */
  ids: string[];
  /** Their logins before the deletion (runners and merges are recorded by login). */
  logins: string[];
  repoIds: string[];
}

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Why `account` can't be deleted now, as sentences addressed to `self` (the person) or to an administrator. Empty when it can. */
export async function deletionBlockers(env: Env, account: Account, self: boolean): Promise<string[]> {
  const who = self ? "You are" : `${account.login} is`;
  const out: string[] = [];
  const orgs = await env.DB.prepare(
    `SELECT o.login FROM org_members m JOIN accounts o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.role = 'owner'
        AND NOT EXISTS (SELECT 1 FROM org_members x WHERE x.org_id = m.org_id AND x.role = 'owner' AND x.user_id != m.user_id)
      ORDER BY o.login`,
  )
    .bind(account.id)
    .all<{ login: string }>();
  const logins = orgs.results.map((o) => o.login);
  if (logins.length) {
    const one = logins.length === 1;
    out.push(`${who} the only owner of ${one ? "the organization" : "the organizations"} ${list(logins)}: make someone else an owner of ${one ? "it" : "each"}, or delete ${one ? "it" : "them"}, first.`);
  }
  if (account.site_admin) {
    const others = await env.DB.prepare("SELECT count(*) AS n FROM accounts WHERE kind = 'user' AND site_admin = 1 AND status = 'active' AND deleted_at IS NULL AND id != ?").bind(account.id).first<{ n: number }>();
    if (!others?.n) out.push(`${who} the only site administrator: make someone else a site administrator first.`);
  }
  const imports = await env.DB.prepare("SELECT count(*) AS n FROM imports WHERE (target_owner_id = ? OR created_by = ?) AND status IN ('queued', 'running')").bind(account.id, account.id).first<{ n: number }>();
  if (imports?.n) out.push(`An import ${self ? "you started, or into your account," : `by or into ${account.login}`} is still in progress: wait for it to finish or cancel it first.`);
  return out;
}

/**
 * Delete a person's account (see the top of this file). `by` is the person themselves or a site administrator;
 * the caller has checked who may and asked them to sign in again. Returns how much went.
 */
export async function deleteAccount(env: Env, dir: Directory, account: Account, by: Account, via: "settings" | "admin"): Promise<{ repositories: number; packages: number; agents: number }> {
  if (account.kind !== "user" || account.deleted_at) throw new HttpError(404, "no such person");
  const blockers = await deletionBlockers(env, account, by.id === account.id);
  if (blockers.length) throw new HttpError(422, blockers.join(" "));
  const db = env.DB;
  const repos = (await db.prepare("SELECT id FROM repos WHERE owner_id = ?").bind(account.id).all<{ id: string }>()).results.map((r) => r.id);
  const agents = (await db.prepare("SELECT id, login FROM accounts WHERE kind = 'agent' AND owner_id = ? AND deleted_at IS NULL").bind(account.id).all<{ id: string; login: string }>()).results;
  const ids = [account.id, ...agents.map((a) => a.id)];
  const logins = [account.login, ...agents.map((a) => a.login)];
  const inIds = ids.map(() => "?").join(", ");
  const packages = (await db.prepare(`SELECT id FROM packages WHERE owner_id IN (${inIds})`).bind(...ids).all<{ id: string }>()).results.map((p) => p.id);

  // Container images first: their tags and manifests go now, unused bytes at the registry's next cleanup.
  const registry = new RegistryStore(env);
  for (const id of packages) await registry.deletePackage(id);

  const t = now();
  const until = new Date(Date.now() + LOGIN_COOLDOWN_DAYS * 86400_000).toISOString();
  const forIds = (q: string) => db.prepare(q.replace("(?)", `(${inIds})`)).bind(...ids);
  const forMe = (q: string) => db.prepare(q).bind(account.id);
  await db.batch([
    ...dir.repoRowDeletes({ ownerId: account.id }),
    // The apps the person registered, with their keys and installations, and apps installed on their account (apps/store.ts).
    ...new Apps(env, dir).accountDeletes([account.id]),
    forIds("DELETE FROM tokens WHERE account_id IN (?)"),
    forMe("DELETE FROM sessions WHERE account_id = ?"),
    forMe("DELETE FROM passkeys WHERE account_id = ?"),
    forMe("DELETE FROM signin_links WHERE account_id = ? AND used_at IS NULL"),
    forMe("DELETE FROM org_members WHERE user_id = ?"),
    forIds("DELETE FROM repo_access WHERE account_id IN (?)"),
    db.prepare("DELETE FROM invites WHERE accepted_at IS NULL AND (account_id = ? OR invited_by = ?)").bind(account.id, account.id),
    forIds("DELETE FROM notifications WHERE account_id IN (?)"),
    forMe("DELETE FROM notification_prefs WHERE account_id = ?"),
    forMe("DELETE FROM mail_digests WHERE account_id = ?"),
    forMe("DELETE FROM repo_watches WHERE account_id = ?"),
    forMe("DELETE FROM thread_subscriptions WHERE account_id = ?"),
    forMe("DELETE FROM known_devices WHERE account_id = ?"),
    forMe("DELETE FROM access_requests WHERE account_id = ?"),
    forMe("DELETE FROM account_links WHERE account_id = ?"),
    forIds("DELETE FROM model_keys WHERE account_id IN (?)"),
    forMe("DELETE FROM terminal_terms WHERE account_id = ?"),
    // Runs an organization's key paid for stay in its owners' report, as a deleted account.
    db.prepare("DELETE FROM agent_usage WHERE person_id = ? AND (key_owner IS NULL OR key_owner = ?)").bind(account.id, account.id),
    forMe("DELETE FROM org_key_spend WHERE person_id = ?"),
    forIds("DELETE FROM account_quotas WHERE account_id IN (?)"),
    forIds("DELETE FROM compute_usage WHERE account_id IN (?)"),
    forIds("DELETE FROM login_redirects WHERE account_id IN (?)"),
    forMe("DELETE FROM email_log WHERE account_id = ?"),
    forMe("DELETE FROM account_exports WHERE account_id = ?"),
    // A GitHub token kept for a draft import goes with the draft.
    forMe("UPDATE imports SET token_ciphertext = NULL, status = CASE WHEN status = 'draft' THEN 'cancelled' ELSE status END WHERE created_by = ?"),
    // The usernames wait before anyone can take them, so old links and mentions don't lead to someone else.
    ...logins.map((login, i) => db.prepare("INSERT OR REPLACE INTO released_logins (login, account_id, released_at, available_at) VALUES (?, ?, ?, ?)").bind(login, ids[i]!, t, until)),
    db
      .prepare(
        `UPDATE accounts SET login = 'deleted-' || id, name = NULL, email = NULL, status = 'disabled', site_admin = 0, avatar_version = NULL, appearance = NULL,
           actions_suspended_at = NULL, actions_suspended_by = NULL, actions_suspended_reason = NULL, deleted_at = ? WHERE id IN (${inIds})`,
      )
      .bind(t, ...ids),
  ]);

  await dir.audit({ actorId: by.id, actorLogin: by.login, action: "account.delete", target: account.login, detail: { via, repositories: repos.length, packages: packages.length, agents: agents.map((a) => a.login) } });
  if (account.email) await enqueueMail(env, [{ kind: "account_deleted", data: { login: account.login, by: by.id === account.id ? undefined : by.login, cooldownDays: LOGIN_COOLDOWN_DAYS }, to: { email: account.email, name: account.name ?? undefined }, reason: "account", at: t }]);
  await startCleanup(env, { kind: "delete", accountId: account.id, ids, logins, repoIds: repos });
  return { repositories: repos.length, packages: packages.length, agents: agents.length };
}

/** Hand the slow part of a deletion to the background (AccountWorkflow); without the binding (unit tests) it runs now. */
async function startCleanup(env: Env, job: DeletionCleanup): Promise<void> {
  if (env.ACCOUNT_WORKFLOW) {
    await env.ACCOUNT_WORKFLOW.create({ id: `delete-${job.accountId}`, params: job });
    return;
  }
  for (const id of job.repoIds) await destroyRepository(env, id);
  await deleteAccountObjects(env, job.accountId);
  for (let after: string | null = ""; after !== null; ) after = await ghostPage(env, job, after);
}

/** Wipe one of a deleted account's repositories: its Durable Object and R2 objects, as deleting a repository does. */
export async function destroyRepository(env: Env, repoId: string): Promise<void> {
  await env.REPO.get(env.REPO.idFromName(repoId)).destroy();
}

/** A deleted account's own R2 objects: profile pictures and exports. True once they are all gone. */
export async function deleteAccountObjects(env: Env, accountId: string): Promise<boolean> {
  return deletePrefixes(env.BUCKET, [`avatars/${accountId}/`, `exports/${accountId}/`]);
}

/** How many repositories one background step visits. */
export const GHOST_PAGE = 25;

/**
 * Attribute a deleted account's work to the ghost in the next page of repositories (by id, after `after`).
 * Every repository is visited: someone can comment on any public repository, and keeps what they wrote in
 * repositories they lost access to. Returns where the next page starts, or null when done.
 */
export async function ghostPage(env: Env, job: DeletionCleanup, after: string): Promise<string | null> {
  const page = await env.DB.prepare("SELECT id FROM repos WHERE id > ? ORDER BY id LIMIT ?").bind(after, GHOST_PAGE).all<{ id: string }>();
  await Promise.all(page.results.map((r) => env.REPO.get(env.REPO.idFromName(r.id)).forgetAccounts(job.ids, job.logins)));
  return page.results.length < GHOST_PAGE ? null : page.results.at(-1)!.id;
}

// ---------------------------------------------------------------- site administrators

/**
 * Make a person a site administrator, or stop them being one. Only an active person can be made one, and the
 * last active site administrator can't be removed (the check and the change are one statement, so two
 * administrators removing each other can't both succeed). Audited as `site_admin.grant` or `site_admin.revoke`,
 * and the person gets an email. False when nothing changed.
 */
export async function setSiteAdmin(env: Env, dir: Directory, target: Account, grant: boolean, by: Account): Promise<boolean> {
  if (target.kind !== "user" || target.deleted_at) throw new HttpError(404, "no such person");
  let changed: number;
  if (grant) {
    if (target.status !== "active") throw new HttpError(422, `${target.login}'s account is ${target.status}: enable it before making them a site administrator`);
    changed = (await env.DB.prepare("UPDATE accounts SET site_admin = 1 WHERE id = ? AND site_admin = 0 AND status = 'active'").bind(target.id).run()).meta.changes ?? 0;
  } else {
    changed =
      (
        await env.DB.prepare(
          "UPDATE accounts SET site_admin = 0 WHERE id = ? AND site_admin = 1 AND EXISTS (SELECT 1 FROM accounts WHERE kind = 'user' AND site_admin = 1 AND status = 'active' AND deleted_at IS NULL AND id != ?)",
        )
          .bind(target.id, target.id)
          .run()
      ).meta.changes ?? 0;
    if (!changed && target.site_admin) throw new HttpError(422, "Diffinery needs at least one site administrator: make someone else a site administrator first");
  }
  if (!changed) return false;
  await dir.audit({ actorId: by.id, actorLogin: by.login, action: grant ? "site_admin.grant" : "site_admin.revoke", target: target.login });
  await enqueueMail(env, [{ kind: "site_admin", data: { granted: grant, by: by.login }, to: { accountId: target.id }, reason: "security_alert", at: now() }]);
  return true;
}
