import type { Env } from "../env.js";
import type { RepoMeta, Role } from "../repo/types.js";
import { ROLE_LEVEL } from "../repo/types.js";
import { HttpError, RESERVED_LOGINS, isValidLogin, isValidName, newId, now, randomAlnum, randomToken, sha256 } from "./util.js";
import { mailForAudit, tokenCreated } from "../mail/notify.js";
import { enqueueMail } from "../mail/send.js";
import { archivePrefix, deletePrefixes } from "./storage-keys.js";
import { inviteProof } from "../auth/invite-proof.js";
import { checkRepositoryQuota } from "./quotas.js";
import { blockSubjects, isBlocked } from "./moderation.js";
import { agentRepoId } from "./agent-setup.js";

export interface Account {
  id: string;
  login: string;
  kind: "user" | "org" | "agent";
  name: string | null;
  email: string | null;
  status: "active" | "pending" | "disabled";
  site_admin: number;
  owner_id: string | null;
  agent_policy: string | null;
  /** Profile picture version (R2 avatars/<id>/<version>/<size>.webp), null for initials. */
  avatar_version: number | null;
  /** "light", "dark" or null (follow the system). */
  appearance: string | null;
  /** Turn on auto-merge for the pull requests it opens: a merge method or "default"; null (or absent before migration 0041) when off. */
  auto_merge?: string | null;
  /** Organizations: the role every member gets on its repositories ("none", "read", "write" or "admin"). */
  base_role: string | null;
  /** Set while a site administrator suspends the person (lib/moderation.ts); status is then `disabled`. */
  suspended_at?: string | null;
  suspended_by?: string | null;
  suspended_reason?: string | null;
  created_at: string;
  /** When the account was deleted (accounts/lifecycle.ts); the row stays under a placeholder login. */
  deleted_at?: string | null;
}

export interface Repo {
  id: string;
  owner_id: string;
  owner_login: string;
  owner_kind: "user" | "org" | "agent";
  name: string;
  description: string;
  visibility: "private" | "public";
  default_branch: string;
  archived: number;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  /** JSON array of topic names (GitHub's repository topics). */
  topics?: string;
  /** Project website (GitHub's `homepage`). */
  homepage?: string;
  /** Set while the owner is suspended (lib/moderation.ts): the repository is hidden from everyone but site administrators. */
  owner_suspended_at?: string | null;
}

export type TokenScope = "read" | "write" | "admin";

export type BaseRole = "none" | "read" | "write" | "admin";
export const BASE_ROLES: readonly BaseRole[] = ["none", "read", "write", "admin"];

/** An organization's base permission; unset means read, the default for new organizations. */
export function baseRole(org: Pick<Account, "base_role">): BaseRole {
  return BASE_ROLES.find((r) => r === org.base_role) ?? "read";
}

/** Repositories are public or private; GitHub's "internal" is refused like any other value. */
export function repoVisibility(v: unknown): Repo["visibility"] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "public" || v === "private") return v;
  throw new HttpError(422, "visibility must be public or private", { errors: [{ resource: "Repository", code: "invalid", field: "visibility" }] });
}

/** Data access for the global directory in D1. */
/** Invitations one person (not a site admin) may send in 24 hours. */
export const MAX_INVITES_PER_DAY = 50;

/** What adding someone did: added them at once, invited them by username, or sent an invitation link to an email address. */
export type AddResult = { added: Account } | { invitedUser: Account; id: string; renewed: boolean } | { invited: { email: string; url: string } };

/** A person's own pending invitations (binds: now, account id, account email). */
const MINE = "i.accepted_at IS NULL AND i.expires_at > ? AND (i.org_id IS NOT NULL OR i.repo_id IS NOT NULL) AND (i.account_id = ? OR (i.account_id IS NULL AND i.email = ?))";

/** One account's grants on one repository, as Directory.grantsFor reads them. */
export type RepoGrants = { repoId: string; accountId: string; access: Role | null; memberRole: string | null; baseRole: string | null };

export class Directory {
  constructor(private env: Env) {}

  private get db() {
    return this.env.DB;
  }

  // ---------------------------------------------------------------- accounts

  async account(id: string): Promise<Account | null> {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
  }

  async accountByLogin(login: string): Promise<Account | null> {
    return this.db.prepare("SELECT * FROM accounts WHERE login = ?").bind(login).first<Account>();
  }

  async accountByEmail(email: string): Promise<Account | null> {
    return this.db.prepare("SELECT * FROM accounts WHERE email = ? AND kind = 'user'").bind(email).first<Account>();
  }

  /**
   * Only a verified email address makes a bootstrap administrator. Logins on the list are
   * ignored: whoever creates an account picks its login, so a login proves nothing.
   */
  private isBootstrapAdmin(email: string): boolean {
    const list = (this.env.BOOTSTRAP_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return list.includes(email.toLowerCase());
  }

  private async uniqueLogin(base: string): Promise<string> {
    let candidate = base.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "user";
    for (let i = 0; i < 50; i++) {
      const tryLogin = i === 0 ? candidate : `${candidate}-${i + 1}`;
      if (!RESERVED_LOGINS.has(tryLogin.toLowerCase()) && !(await this.loginTaken(tryLogin))) return tryLogin;
    }
    candidate = `${candidate}-${randomToken(3)}`;
    return candidate;
  }

  /**
   * When a deleted account's username becomes free again (accounts/lifecycle.ts LOGIN_COOLDOWN_DAYS), or null
   * when it isn't cooling down.
   */
  async loginCooldown(login: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT available_at FROM released_logins WHERE login = ? AND available_at > ?").bind(login, now()).first<{ available_at: string }>();
    return r?.available_at ?? null;
  }

  /**
   * Whether old URLs at this login still lead somewhere else: a renamed account's profile, or
   * repositories and images that moved away with a transfer, a rename or before their organization
   * was deleted. Whoever took the login would take over those redirects and could serve their own
   * code at the old clone URLs, so it stays retired. `forAccountId` may take back its own old login.
   */
  async loginRetired(login: string, forAccountId = ""): Promise<boolean> {
    const r = await this.db
      .prepare(
        `SELECT 1 FROM login_redirects WHERE login = ?1 AND account_id != ?2
         UNION ALL SELECT 1 FROM repo_redirects r JOIN repos p ON p.id = r.repo_id WHERE r.owner_login = ?1 AND p.owner_id != ?2
         UNION ALL SELECT 1 FROM package_redirects r JOIN packages p ON p.id = r.package_id WHERE r.owner_login = ?1 AND p.owner_id != ?2
         LIMIT 1`,
      )
      .bind(login, forAccountId)
      .first();
    return !!r;
  }

  /** Whether an account has this login, a deleted account had it too recently for anyone to take it, or old URLs at it lead elsewhere. */
  async loginTaken(login: string): Promise<boolean> {
    return !!(await this.accountByLogin(login)) || !!(await this.loginCooldown(login)) || (await this.loginRetired(login));
  }

  /** Refuse a login that a deleted account gave up less than 90 days ago, or whose old URLs lead to another account's work. */
  private async checkCooldown(login: string, what = "This username", forAccountId = ""): Promise<void> {
    const until = await this.loginCooldown(login);
    if (until) throw new HttpError(422, `${what} belonged to an account that was deleted recently; it can be used again from ${until.slice(0, 10)}`);
    if (await this.loginRetired(login, forAccountId)) throw new HttpError(422, `${what} is retired: links to it still lead to repositories or a profile that moved elsewhere`);
  }

  /**
   * Find or create the user behind a verified email (Access recovery, invite links, open sign-up,
   * dev sign-in). A new account waits for an invite unless it has one, is a bootstrap
   * administrator or `hints.active` says so (open sign-up).
   */
  async userForEmail(email: string, hints: { name?: string; login?: string; id?: string; active?: boolean } = {}): Promise<Account> {
    const existing = await this.accountByEmail(email);
    if (existing) {
      if (existing.status === "pending" && this.isBootstrapAdmin(email)) {
        await this.db.prepare("UPDATE accounts SET status = 'active', site_admin = 1 WHERE id = ?").bind(existing.id).run();
        await this.audit({ actorId: existing.id, actorLogin: existing.login, action: "site_admin.grant", target: existing.login, detail: { via: "bootstrap" } });
        return { ...existing, status: "active", site_admin: 1 };
      }
      return existing;
    }
    const admin = this.isBootstrapAdmin(email);
    const login = await this.uniqueLogin(hints.login ?? email.split("@")[0]!);
    const id = hints.id ?? newId();
    const hasInvite = await this.db.prepare("SELECT 1 FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > ?").bind(email, now()).first();
    await this.db
      .prepare("INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES (?, ?, 'user', ?, ?, ?, ?, ?)")
      .bind(id, login, hints.name ?? null, email, admin || hasInvite || hints.active ? "active" : "pending", admin ? 1 : 0, now())
      .run();
    if (admin) await this.audit({ actorId: id, actorLogin: login, action: "site_admin.grant", target: login, detail: { via: "bootstrap" } });
    if (hasInvite) await this.acceptInvitesForEmail(id, email);
    return (await this.account(id))!;
  }

  /** Rename an account and change its display name (and an organization's base permission) in one write, after checking every field. */
  async updateAccount(id: string, patch: { login?: string; name?: unknown; baseRole?: unknown }): Promise<void> {
    if (patch.name !== undefined && patch.name !== null && typeof patch.name !== "string") throw new HttpError(422, "name must be a string", { errors: [{ resource: "Account", code: "invalid", field: "name" }] });
    if (patch.baseRole !== undefined && !BASE_ROLES.includes(patch.baseRole as BaseRole)) throw new HttpError(422, "base permission must be none, read, write or admin", { errors: [{ resource: "Organization", code: "invalid", field: "default_repository_permission" }] });
    if (patch.login && !isValidLogin(patch.login)) throw new HttpError(422, "invalid or reserved login");
    if (patch.login) {
      const clash = await this.accountByLogin(patch.login);
      if (clash && clash.id !== id) throw new HttpError(422, "login already taken");
      await this.checkCooldown(patch.login, "This name", id);
    }
    // A blank display name clears it, so pages fall back to the login.
    const name = patch.name === undefined ? undefined : (patch.name as string | null)?.trim() || null;
    const before = patch.login ? await this.account(id) : null;
    await this.db
      .prepare("UPDATE accounts SET login = COALESCE(?, login), name = CASE WHEN ? THEN ? ELSE name END, base_role = CASE WHEN kind = 'org' THEN COALESCE(?, base_role) ELSE base_role END WHERE id = ?")
      .bind(patch.login ?? null, name === undefined ? 0 : 1, name ?? null, (patch.baseRole as string | undefined) ?? null, id)
      .run();
    if (patch.login && before && before.login.toLowerCase() !== patch.login.toLowerCase()) {
      // The old login keeps leading here (repository URLs, the profile) until another account takes it.
      await this.db.batch([
        this.db.prepare("DELETE FROM login_redirects WHERE login = ?").bind(patch.login),
        this.db.prepare("INSERT OR REPLACE INTO login_redirects (login, account_id, created_at) VALUES (?, ?, ?)").bind(before.login, id, now()),
      ]);
    }
    if (patch.login) {
      // Repos keep their ids; their Durable Objects cache the owner login, so refresh them.
      const repos = await this.db.prepare("SELECT id FROM repos WHERE owner_id = ?").bind(id).all<{ id: string }>();
      for (const r of repos.results) {
        await this.env.REPO.get(this.env.REPO.idFromName(r.id)).updateMeta({ owner: patch.login });
        await this.forgetArchives(r.id);
      }
    }
  }

  async setAppearance(id: string, appearance: "light" | "dark" | null): Promise<void> {
    await this.db.prepare("UPDATE accounts SET appearance = ? WHERE id = ?").bind(appearance, id).run();
  }

  /** The account's own auto-merge setting (repo/auto-merge.ts applyOwn): a merge method, "default", or null for off. People and agents only. */
  async setAutoMerge(id: string, value: "default" | "merge" | "squash" | "rebase" | null): Promise<void> {
    await this.db.prepare("UPDATE accounts SET auto_merge = ? WHERE id = ? AND kind IN ('user', 'agent')").bind(value, id).run();
  }

  /** Point an account at a new profile picture version (null: back to initials). */
  async setAvatarVersion(id: string, version: number | null): Promise<void> {
    await this.db.prepare("UPDATE accounts SET avatar_version = ? WHERE id = ?").bind(version, id).run();
  }

  async createOrg(login: string, name: string, creator: Account): Promise<Account> {
    if (!isValidLogin(login)) throw new HttpError(422, "invalid or reserved organization name");
    if (await this.accountByLogin(login)) throw new HttpError(422, "name already taken");
    await this.checkCooldown(login, "This name");
    const id = newId();
    const t = now();
    await this.db.batch([
      this.db.prepare("INSERT INTO accounts (id, login, kind, name, status, base_role, created_at) VALUES (?, ?, 'org', ?, 'active', 'read', ?)").bind(id, login, name || login, t),
      this.db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, creator.id, t),
    ]);
    return (await this.account(id))!;
  }

  /**
   * Delete an organization. Refused while it still owns repositories (transfer or delete them first),
   * container images or an import in progress. Its agents are disabled (their tokens revoked), its
   * members, pending invitations, secrets and variables, model keys and agent policy removed, and its login freed. The account row
   * stays, disabled under a placeholder login, because the audit log, import history and its agents
   * still refer to it. Repositories transferred out of it keep redirecting from their old URLs.
   */
  async deleteOrg(org: Account): Promise<void> {
    if (org.kind !== "org") throw new HttpError(404, "not an organization");
    const count = async (q: string) => (await this.db.prepare(q).bind(org.id).first<{ n: number }>())?.n ?? 0;
    const repos = await count("SELECT count(*) AS n FROM repos WHERE owner_id = ?");
    if (repos) throw new HttpError(422, `${org.login} still owns ${repos} ${repos === 1 ? "repository" : "repositories"}; transfer or delete ${repos === 1 ? "it" : "them"} before deleting the organization`);
    const images = await count("SELECT count(*) AS n FROM packages WHERE owner_id = ?");
    if (images) throw new HttpError(422, `${org.login} still owns ${images} container ${images === 1 ? "image" : "images"}; delete ${images === 1 ? "it" : "them"} before deleting the organization`);
    const imports = await count("SELECT count(*) AS n FROM imports WHERE target_owner_id = ? AND status IN ('draft', 'queued', 'running')");
    if (imports) throw new HttpError(422, `an import into ${org.login} is still in progress; wait for it to finish or cancel it first`);
    // Other accounts may have installed its apps (apps/): deleting them is a decision of its own.
    const apps = await count("SELECT count(*) AS n FROM apps WHERE owner_id = ?");
    if (apps) throw new HttpError(422, `${org.login} still owns ${apps} ${apps === 1 ? "app" : "apps"}; delete ${apps === 1 ? "it" : "them"} under Settings → Apps before deleting the organization`);
    const agents = await this.db.prepare("SELECT id FROM accounts WHERE kind = 'agent' AND owner_id = ? AND status != 'disabled'").bind(org.id).all<{ id: string }>();
    for (const a of agents.results) await this.setStatus(a.id, "disabled");
    await this.db.batch([
      this.db.prepare("DELETE FROM org_members WHERE org_id = ?").bind(org.id),
      this.db.prepare("DELETE FROM invites WHERE org_id = ? AND accepted_at IS NULL").bind(org.id),
      this.db.prepare("DELETE FROM org_secrets WHERE org_id = ?").bind(org.id),
      this.db.prepare("DELETE FROM org_secret_repos WHERE org_id = ?").bind(org.id),
      this.db.prepare("DELETE FROM org_variables WHERE org_id = ?").bind(org.id),
      // Phase 5b: its model keys, agent policy, allowance counts and the usage its keys paid for.
      this.db.prepare("DELETE FROM model_keys WHERE account_id = ?").bind(org.id),
      this.db.prepare("DELETE FROM org_agent_policies WHERE org_id = ?").bind(org.id),
      this.db.prepare("DELETE FROM org_key_spend WHERE org_id = ?").bind(org.id),
      this.db.prepare("DELETE FROM agent_usage WHERE key_owner = ?").bind(org.id),
      this.db.prepare("DELETE FROM login_redirects WHERE account_id = ?").bind(org.id),
      // Apps installed on it lose their access (apps/store.ts).
      this.db.prepare("DELETE FROM app_installation_tokens WHERE installation_id IN (SELECT id FROM app_installations WHERE account_id = ?)").bind(org.id),
      this.db.prepare("DELETE FROM app_installation_repos WHERE installation_id IN (SELECT id FROM app_installations WHERE account_id = ?)").bind(org.id),
      this.db.prepare("DELETE FROM app_installations WHERE account_id = ?").bind(org.id),
      this.db.prepare("UPDATE accounts SET login = ?, status = 'disabled' WHERE id = ?").bind(`deleted-${org.id}`, org.id),
    ]);
  }

  /** Whether an account sees an organization's settings such as its base permission: members, the
   * organization's own agents, agents of members, and site admins. */
  async inOrg(orgId: string, account: Account): Promise<boolean> {
    if (account.site_admin) return true;
    if (account.kind === "agent") return account.owner_id === orgId || (!!account.owner_id && !!(await this.orgRole(orgId, account.owner_id)));
    return !!(await this.orgRole(orgId, account.id));
  }

  async orgRole(orgId: string, userId: string): Promise<"owner" | "admin" | "member" | null> {
    const r = await this.db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, userId).first<{ role: "owner" | "admin" | "member" }>();
    return r?.role ?? null;
  }

  async orgsFor(userId: string): Promise<Array<Account & { role: string }>> {
    const r = await this.db.prepare("SELECT a.*, m.role FROM org_members m JOIN accounts a ON a.id = m.org_id WHERE m.user_id = ? ORDER BY a.login").bind(userId).all<Account & { role: string }>();
    return r.results;
  }

  async orgMembers(orgId: string): Promise<Array<Account & { role: string }>> {
    const r = await this.db.prepare("SELECT a.*, m.role FROM org_members m JOIN accounts a ON a.id = m.user_id WHERE m.org_id = ? ORDER BY a.login").bind(orgId).all<Account & { role: string }>();
    return r.results;
  }

  async setOrgMember(orgId: string, userId: string, role: "owner" | "admin" | "member" | null, by?: Account): Promise<void> {
    const previous = await this.orgRole(orgId, userId);
    await this.writeOrgMember(orgId, userId, role);
    if (previous !== role) {
      const org = await this.account(orgId);
      if (!org) return;
      await enqueueMail(this.env, [{ kind: "org_membership", data: { org: org.login, role, previous, by: by && by.id !== userId ? by.login : undefined }, to: { accountId: userId }, reason: "account", at: now() }]);
      // A heads-up on Diffinery too when someone else adds you.
      if (role && !previous && by && by.id !== userId) await this.notify([userId], { kind: "org_membership", title: `${by.login} added you to ${org.login} as ${role === "admin" ? "an admin" : `a${role === "owner" ? "n" : ""} ${role}`}`, url: `/${org.login}` });
    }
  }

  /**
   * Add someone to an organization by username or email, like GitHub's "Add people". Either way they
   * get an invitation and join when they accept it: a username's invitation waits in their
   * Settings → Invitations (with an email and a notification), an email address's invitation is a
   * link that also creates the account if there is none. Only an admin adding themselves joins at once.
   */
  async addOrgPerson(org: Account, by: Account, who: string, role: "owner" | "admin" | "member"): Promise<AddResult> {
    const q = who.trim().replace(/^@/, "");
    if (!q) throw new HttpError(422, "enter a username or an email address");
    const email = q.includes("@");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) throw new HttpError(422, "enter a valid email address");
    // An email address always gets an invitation, even when it belongs to an account: adding the
    // account directly would tell the admin its username, and the person hasn't agreed to join.
    if (email) {
      const inv = await this.createInvite(by, { email: q, orgId: org.id, role });
      return { invited: { email: q, url: inv.url } };
    }
    const user = await this.accountByLogin(q);
    if (user) {
      if (user.kind !== "user") throw new HttpError(422, `${user.login} is not a person; agents belong to an organization through Settings → Agents`);
      if (user.status === "disabled") throw new HttpError(422, `${user.login}'s account is disabled`);
      if (await this.orgRole(org.id, user.id)) throw new HttpError(422, `${user.login} is already a member of ${org.login}`);
      await this.refuseBlocked(org, user, by);
      if (user.id === by.id) {
        await this.setOrgMember(org.id, user.id, role, by);
        return { added: user };
      }
      return { invitedUser: user, ...(await this.inviteAccount(by, user, { orgId: org.id, role })) };
    }
    throw new HttpError(404, `no one has the username ${q}; to invite someone new, enter their email address`);
  }

  /** Add a collaborator by username (a person or an agent; see grantRepoAccess), or invite an email address. */
  async addRepoPerson(repo: Repo, by: Account, who: string, role: Role): Promise<AddResult> {
    const q = who.trim().replace(/^@/, "");
    if (!q) throw new HttpError(422, "enter a username or an email address");
    const email = q.includes("@");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) throw new HttpError(422, "enter a valid email address");
    // As for organizations, an email address always gets an invitation.
    if (email) {
      const inv = await this.createInvite(by, { email: q, repoId: repo.id, role });
      return { invited: { email: q, url: inv.url } };
    }
    const account = await this.accountByLogin(q);
    if (account) return this.grantRepoAccess(repo, by, account, role);
    throw new HttpError(404, `no one has the username ${q}; to invite someone new, enter their email address`);
  }

  /**
   * Give an account a role on a repository, as GitHub does: agents, people who already have a direct
   * grant (a role change), members of the organization that owns the repository and the admin
   * themselves get it at once; anyone else gets an invitation and has access only once they accept it.
   */
  async grantRepoAccess(repo: Repo, by: Account, account: Account, role: Role): Promise<{ added: Account } | { invitedUser: Account; id: string; renewed: boolean }> {
    if (account.kind === "org") throw new HttpError(422, `${account.login} is an organization; add its people instead`);
    if (account.status === "disabled") throw new HttpError(422, `${account.login}'s account is disabled`);
    await this.refuseBlocked({ id: repo.owner_id, login: repo.owner_login }, account, by);
    const direct =
      account.kind === "agent" ||
      account.id === by.id ||
      !!(await this.db.prepare("SELECT 1 FROM repo_access WHERE repo_id = ? AND account_id = ?").bind(repo.id, account.id).first()) ||
      (repo.owner_kind === "org" && !!(await this.orgRole(repo.owner_id, account.id)));
    if (!direct) return { invitedUser: account, ...(await this.inviteAccount(by, account, { repoId: repo.id, role })) };
    await this.setCollaborator(repo.id, account.id, role);
    if (account.id !== by.id) await this.notify([account.id], { repoId: repo.id, kind: "repo_access", title: `${by.login} gave you ${role} access to ${repo.owner_login}/${repo.name}`, url: `/${repo.owner_login}/${repo.name}` });
    return { added: account };
  }

  /** Revoke a pending invitation to an organization, a repository, or (neither) the site. False if there was none. */
  async revokeInvite(id: string, scope: { orgId?: string; repoId?: string }): Promise<boolean> {
    const r = await this.db
      .prepare("DELETE FROM invites WHERE id = ? AND accepted_at IS NULL AND org_id IS ? AND repo_id IS ?")
      .bind(id, scope.orgId ?? null, scope.repoId ?? null)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /**
   * Blocks keep people apart, as on GitHub: an owner (a person or an organization) can't invite or add
   * someone it blocked, and nobody can invite or add a person who blocked them.
   */
  private async refuseBlocked(owner: Pick<Account, "id" | "login">, user: Account, by: Account): Promise<void> {
    // An agent is blocked along with its owner.
    if (await isBlocked(this.env, owner.id, blockSubjects(user))) throw new HttpError(422, `${owner.login} blocked ${user.kind === "agent" ? `${user.login}'s owner` : user.login}; unblock them first`);
    if (await isBlocked(this.env, user.id, blockSubjects(by))) throw new HttpError(422, `you can't invite ${user.login}`);
  }

  private async writeOrgMember(orgId: string, userId: string, role: "owner" | "admin" | "member" | null): Promise<void> {
    // Removing or demoting the last owner would leave nobody able to manage the organization.
    if (role !== "owner" && (await this.orgRole(orgId, userId)) === "owner") {
      const owners = await this.db.prepare("SELECT count(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner' AND user_id != ?").bind(orgId, userId).first<{ n: number }>();
      if (!owners?.n) throw new HttpError(422, "an organization needs at least one owner; make someone else an owner first");
    }
    if (role === null) {
      // Their grants on the organization's repositories (including the admin grant for repositories they
      // created) go too, for them and their agents. Roles are computed per request, so tokens lose access at once.
      await this.db.batch([
        this.db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").bind(orgId, userId),
        this.db
          .prepare("DELETE FROM repo_access WHERE repo_id IN (SELECT id FROM repos WHERE owner_id = ?) AND account_id IN (SELECT ? UNION SELECT id FROM accounts WHERE kind = 'agent' AND owner_id = ?)")
          .bind(orgId, userId, userId),
      ]);
      return;
    }
    await this.db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role").bind(orgId, userId, role, now()).run();
  }

  async users(): Promise<Account[]> {
    return (await this.db.prepare("SELECT * FROM accounts WHERE kind = 'user' AND deleted_at IS NULL ORDER BY login").all<Account>()).results;
  }

  async setStatus(id: string, status: Account["status"]): Promise<void> {
    const before = await this.account(id);
    // Any status but disabled also lifts a suspension (lib/moderation.ts).
    await this.db.prepare(`UPDATE accounts SET status = ?${status === "disabled" ? "" : ", suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL"} WHERE id = ?`).bind(status, id).run();
    if (status === "disabled") await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").bind(now(), id).run();
    // A disabled account's browser sessions end too.
    if (status === "disabled") await this.db.prepare("DELETE FROM sessions WHERE account_id = ?").bind(id).run();
    // People hear when they are disabled or enabled again (not when an invite activates them).
    if (before?.kind === "user" && before.status !== status && (status === "disabled" || before.status === "disabled")) {
      await enqueueMail(this.env, [{ kind: "account_status", data: { status: status === "disabled" ? "disabled" : "active" }, to: { accountId: id }, reason: "account", at: now() }]);
    }
  }

  // ---------------------------------------------------------------- agents

  async createAgent(owner: Account, input: { login: string; name?: string; orgId?: string; policy?: Record<string, unknown> }): Promise<Account> {
    if (!isValidLogin(input.login)) throw new HttpError(422, "invalid or reserved agent name");
    const login = input.login.endsWith("[bot]") ? input.login : `${input.login}`;
    if (await this.accountByLogin(login)) throw new HttpError(422, "name already taken");
    await this.checkCooldown(login, "This name");
    const id = newId();
    const ownerId = input.orgId ?? owner.id;
    if (input.orgId) {
      const role = await this.orgRole(input.orgId, owner.id);
      if (role !== "owner" && role !== "admin") throw new HttpError(403, "only organization admins can create organization agents");
    }
    const policy = { maxRole: "write", canMergeProtected: false, budgetUsdMonthly: null, ...input.policy };
    await this.db
      .prepare("INSERT INTO accounts (id, login, kind, name, status, owner_id, agent_policy, created_at) VALUES (?, ?, 'agent', ?, 'active', ?, ?, ?)")
      .bind(id, login, input.name?.trim() || login, ownerId, JSON.stringify(policy), now())
      .run();
    return (await this.account(id))!;
  }

  async agentsOwnedBy(ownerIds: string[]): Promise<Account[]> {
    if (!ownerIds.length) return [];
    const q = `SELECT * FROM accounts WHERE kind = 'agent' AND owner_id IN (${ownerIds.map(() => "?").join(",")}) ORDER BY login`;
    return (await this.db.prepare(q).bind(...ownerIds).all<Account>()).results;
  }

  // ---------------------------------------------------------------- tokens

  /** `importId`: a GitHub import's short-lived push token (see imports/service.ts). `client`: "cli" for a CLI sign-in's token (auth/cli-login.ts), "oauth" for a connected app's (auth/oauth.ts, with `oauthGrantId`). */
  async createToken(
    account: Account,
    input: { name: string; scopes?: TokenScope[]; repoIds?: string[] | null; expiresInDays?: number; expiresInSeconds?: number; importId?: string; client?: "cli" | "oauth"; oauthGrantId?: string; notify?: boolean },
  ): Promise<{ token: string; id: string; expiresAt: string }> {
    const days = Math.min(Math.max(input.expiresInDays ?? 90, 1), 366);
    // Letters and digits only after the prefix: the GitHub CLI masks a token after its last `_`
    // (`gh auth status`), so an underscore in the random part would show the rest of it.
    const token = `dfy_${randomAlnum(40)}`;
    const id = newId();
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ? Math.min(input.expiresInSeconds, days * 86400) * 1000 : days * 86400_000)).toISOString();
    await this.db
      .prepare("INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, repo_ids, expires_at, created_at, import_id, client, oauth_grant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, account.id, input.name || "token", await sha256(token), token.slice(0, 10), JSON.stringify(input.scopes?.length ? input.scopes : ["write"]), input.repoIds ? JSON.stringify(input.repoIds) : null, expiresAt, now(), input.importId ?? null, input.client ?? null, input.oauthGrantId ?? null)
      .run();
    // An import's own push token is server-managed and short-lived: no "new token" email. A connected
    // app's tokens (auth/oauth.ts) email once, when the app is connected, not on every refresh.
    if (!input.importId && input.notify !== false) await tokenCreated(this.env, this, account, { name: input.name || "token", scopes: input.scopes?.length ? input.scopes : ["write"] }).catch((e) => console.error("token email failed", e));
    return { token, id, expiresAt };
  }

  async tokens(accountId: string): Promise<Array<{ id: string; name: string; prefix: string; scopes: string[]; repoIds: string[] | null; expiresAt: string; lastUsedAt: string | null; createdAt: string; client: string | null }>> {
    // Import push tokens (import_id set) are server-managed and hidden from the personal token list, and
    // connected apps' tokens are listed by connection (Settings → Access tokens → Connected apps).
    const r = await this.db.prepare("SELECT * FROM tokens WHERE account_id = ? AND revoked_at IS NULL AND import_id IS NULL AND oauth_grant_id IS NULL ORDER BY created_at DESC").bind(accountId).all<Record<string, string | null>>();
    return r.results.map((t) => ({ id: t.id!, name: t.name!, prefix: t.prefix!, scopes: JSON.parse(t.scopes!), repoIds: t.repo_ids ? JSON.parse(t.repo_ids) : null, expiresAt: t.expires_at!, lastUsedAt: t.last_used_at ?? null, createdAt: t.created_at!, client: t.client ?? null }));
  }

  async revokeToken(accountId: string, id: string): Promise<void> {
    await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND account_id = ?").bind(now(), id, accountId).run();
  }

  async verifyToken(token: string): Promise<{ id: string; account: Account; owner: Account | null; scopes: TokenScope[]; repoIds: string[] | null; importId: string | null } | null> {
    const hash = await sha256(token);
    // The token, its account and that account's owner (for an agent) in one round trip: every API, git and MCP call waits for this.
    const [row, account, tokenOwner] = await Promise.all([
      this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").bind(hash).first<Record<string, string | null>>(),
      this.db.prepare("SELECT * FROM accounts WHERE id = (SELECT account_id FROM tokens WHERE token_hash = ?)").bind(hash).first<Account>(),
      this.db.prepare("SELECT * FROM accounts WHERE id = (SELECT a.owner_id FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE t.token_hash = ?)").bind(hash).first<Account>(),
    ]);
    if (!row || row.revoked_at || row.expires_at! < now()) return null;
    if (!account || account.id !== row.account_id || account.status !== "active") return null;
    // An agent's tokens stop working while its owner is suspended (lib/moderation.ts), disabled or otherwise not active.
    let owner: Account | null = null;
    if (account.kind === "agent" && account.owner_id) {
      owner = tokenOwner?.id === account.owner_id ? tokenOwner : await this.account(account.owner_id);
      if (!owner || owner.suspended_at || owner.status !== "active") return null;
      // A connected app acting as an organization's agent (auth/oauth.ts) stops the moment the person who
      // approved it is no longer an owner or admin of that organization, not only at its next refresh.
      if (row.oauth_grant_id && owner.kind === "org") {
        const g = await this.db.prepare("SELECT person_id FROM oauth_grants WHERE id = ?").bind(row.oauth_grant_id).first<{ person_id: string }>();
        const role = g ? await this.orgRole(owner.id, g.person_id) : null;
        if (role !== "owner" && role !== "admin") return null;
      }
    }
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 3600_000) {
      await this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").bind(now(), row.id!).run();
    }
    return { id: row.id!, account, owner, scopes: JSON.parse(row.scopes!), repoIds: row.repo_ids ? JSON.parse(row.repo_ids) : null, importId: row.import_id ?? null };
  }

  /** Revoke a token by id whoever owns it (server-managed tokens such as an import's push token). */
  async revokeTokenById(id: string): Promise<void> {
    await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), id).run();
  }

  /** Revoke every live token an import ever minted (not only the current one), so a stale token can never push. */
  async revokeTokensByImport(importId: string): Promise<void> {
    await this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE import_id = ? AND revoked_at IS NULL").bind(now(), importId).run();
  }

  // ---------------------------------------------------------------- invites

  /** The role is one an organization invitation can have and the inviter may give, and (for a new invitation) the inviter is under the daily limit. */
  private async checkInvite(inviter: Account, input: { orgId?: string; repoId?: string; role: string }, isNew = true): Promise<void> {
    if (input.orgId) {
      if (input.role !== "member" && input.role !== "admin" && input.role !== "owner") throw new HttpError(422, "role must be member, admin or owner");
      if (input.role === "owner" && !inviter.site_admin && (await this.orgRole(input.orgId, inviter.id)) !== "owner") throw new HttpError(403, "only owners can invite owners");
    }
    if (input.repoId && !Object.hasOwn(ROLE_LEVEL, input.role)) throw new HttpError(422, "permission must be read, triage, write, maintain or admin");
    // Invitations are email to any address: a daily limit per inviter keeps an account from being used to spam.
    if (isNew && !inviter.site_admin) {
      const sent = (await this.db.prepare("SELECT count(*) AS n FROM invites WHERE invited_by = ? AND created_at > ?").bind(inviter.id, new Date(Date.now() - 86400_000).toISOString()).first<{ n: number }>())?.n ?? 0;
      if (sent >= MAX_INVITES_PER_DAY) throw new HttpError(429, `you can send at most ${MAX_INVITES_PER_DAY} invitations in 24 hours; try again later`);
    }
  }

  async createInvite(inviter: Account, input: { email: string; orgId?: string; repoId?: string; role: string }): Promise<{ id: string; url: string; token: string }> {
    await this.checkInvite(inviter, input);
    // One open invitation per address and organization or repository. The email column is NOCASE,
    // so Bob@x.com and bob@x.com count as the same person.
    const pending = await this.db
      .prepare("SELECT 1 FROM invites WHERE email = ? AND account_id IS NULL AND org_id IS ? AND repo_id IS ? AND accepted_at IS NULL AND expires_at > ?")
      .bind(input.email, input.orgId ?? null, input.repoId ?? null, now())
      .first();
    if (pending) throw new HttpError(422, `${input.email} already has a pending invitation; revoke it first to send a new one`);
    // An address that already belongs to a member still gets an invitation (accepting it changes
    // nothing): refusing would tell the inviter whose address it is.
    const existing = await this.accountByEmail(input.email);
    const token = randomToken(24);
    const id = newId();
    await this.db
      .prepare("INSERT INTO invites (id, org_id, repo_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.orgId ?? null, input.repoId ?? null, input.email, input.role, await sha256(token), inviter.id, now(), new Date(Date.now() + 14 * 86400_000).toISOString())
      .run();
    // If the person already exists, activate them now so the invite also works from the dashboard.
    if (existing?.status === "pending") await this.setStatus(existing.id, "active");
    const url = `${this.env.PUBLIC_URL}/invite/${token}`;
    await this.mailInvite({ id, email: input.email, org_id: input.orgId ?? null, repo_id: input.repoId ?? null, role: input.role, invited_by: inviter.id, expires_at: new Date(Date.now() + 14 * 86400_000).toISOString() }, token);
    return { id, url, token };
  }

  /**
   * Invite an existing person by username to an organization or a repository. They join when they
   * accept it in Settings → Invitations or through the API; the email and notification only point
   * there, so the invitation carries no link that works for anyone else. Inviting someone who already
   * has a pending invitation changes its role instead of sending another.
   */
  async inviteAccount(inviter: Account, user: Account, input: { orgId?: string; repoId?: string; role: string }): Promise<{ id: string; renewed: boolean }> {
    const pending = await this.db
      .prepare("SELECT id FROM invites WHERE account_id = ? AND org_id IS ? AND repo_id IS ? AND accepted_at IS NULL AND expires_at > ?")
      .bind(user.id, input.orgId ?? null, input.repoId ?? null, now())
      .first<{ id: string }>();
    if (pending) {
      await this.checkInvite(inviter, input, false);
      await this.db.prepare("UPDATE invites SET role = ? WHERE id = ?").bind(input.role, pending.id).run();
      return { id: pending.id, renewed: true };
    }
    await this.checkInvite(inviter, input);
    const id = newId();
    const expiresAt = new Date(Date.now() + 14 * 86400_000).toISOString();
    // The token column is required and unique; nobody is given this one; the invitation is accepted by id.
    await this.db
      .prepare("INSERT INTO invites (id, org_id, repo_id, email, account_id, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.orgId ?? null, input.repoId ?? null, user.email ?? null, user.id, input.role, await sha256(randomToken(24)), inviter.id, now(), expiresAt)
      .run();
    const org = input.orgId ? await this.account(input.orgId) : null;
    const repo = input.repoId ? await this.repoById(input.repoId) : null;
    const where = org ? org.login : repo ? `${repo.owner_login}/${repo.name}` : "Diffinery";
    await this.notify([user.id], { repoId: input.repoId, kind: "invitation", title: `${inviter.login} invited you to ${where} as ${input.role}`, url: "/settings/invitations" });
    await enqueueMail(this.env, [
      {
        kind: "invite",
        data: { inviter: inviter.login, url: `${this.env.PUBLIC_URL}/settings/invitations`, org: org?.login, repo: repo ? `${repo.owner_login}/${repo.name}` : undefined, role: input.role, expiresAt, existing: true },
        to: { accountId: user.id },
        reason: "invitation",
        at: now(),
      },
    ]);
    return { id, renewed: false };
  }

  /**
   * Email an invitation to its address. Only this emailed link carries the proof that lets
   * someone create an account for the address (auth/invite-proof.ts); the plain link shown to
   * the inviter leads to a page that sends this email.
   */
  async mailInvite(inv: { id: string; email: string; org_id: string | null; repo_id: string | null; role: string; invited_by: string | null; expires_at: string }, token: string): Promise<void> {
    const proof = await inviteProof(this.env, await sha256(token));
    // The proof rides in the fragment, which browsers never send to the server, so request logs never hold
    // it; the invite page posts it (web/auth.tsx). Links sent before this carried it as ?proof=, still accepted.
    const url = `${this.env.PUBLIC_URL}/invite/${token}#proof=${proof}`;
    const inviter = inv.invited_by ? await this.account(inv.invited_by) : null;
    const org = inv.org_id ? await this.account(inv.org_id) : null;
    const repo = inv.repo_id ? await this.repoById(inv.repo_id) : null;
    const existing = await this.accountByEmail(inv.email);
    await enqueueMail(this.env, [
      {
        kind: "invite",
        data: { inviter: inviter?.login ?? "diffinery", url, org: org?.login, repo: repo ? `${repo.owner_login}/${repo.name}` : undefined, role: inv.role, expiresAt: inv.expires_at },
        to: existing ? { accountId: existing.id } : { email: inv.email },
        reason: "invitation",
        at: now(),
      },
    ]);
  }

  /** Invitations sent from an organization, a repository or the site. One sent to a username shows the username, never the person's email address. */
  async invites(filter: { orgId?: string; repoId?: string; site?: boolean; pending?: boolean }): Promise<Array<{ id: string; email: string | null; login: string | null; role: string; createdAt: string; expiresAt: string; acceptedAt: string | null; invitedBy: string | null }>> {
    const r = await this.db
      .prepare(
        `SELECT i.*, a.login AS inviter, u.login AS invitee FROM invites i LEFT JOIN accounts a ON a.id = i.invited_by LEFT JOIN accounts u ON u.id = i.account_id WHERE (? IS NULL OR i.org_id = ?) AND (? IS NULL OR i.repo_id = ?)${filter.site ? " AND i.org_id IS NULL AND i.repo_id IS NULL" : ""}${filter.pending ? " AND i.accepted_at IS NULL AND i.expires_at > ?" : ""} ORDER BY i.created_at DESC LIMIT 200`,
      )
      .bind(filter.orgId ?? null, filter.orgId ?? null, filter.repoId ?? null, filter.repoId ?? null, ...(filter.pending ? [now()] : []))
      .all<Record<string, string | null>>();
    return r.results.map((i) => ({ id: i.id!, email: i.account_id ? null : i.email!, login: i.account_id ? i.invitee ?? null : null, role: i.role!, createdAt: i.created_at!, expiresAt: i.expires_at!, acceptedAt: i.accepted_at ?? null, invitedBy: i.inviter ?? null }));
  }

  /**
   * Pending invitations to an organization or a repository for this person: those sent to their
   * username, and those sent to their email address.
   */
  async invitesFor(user: Account): Promise<Array<{ id: string; orgId: string | null; repoId: string | null; org: string | null; repo: string | null; role: string; invitedBy: string | null; createdAt: string; expiresAt: string }>> {
    const r = await this.db
      .prepare(
        `SELECT i.*, a.login AS inviter, o.login AS org_login, ro.login || '/' || r.name AS repo_full FROM invites i
         LEFT JOIN accounts a ON a.id = i.invited_by LEFT JOIN accounts o ON o.id = i.org_id LEFT JOIN repos r ON r.id = i.repo_id LEFT JOIN accounts ro ON ro.id = r.owner_id
         WHERE ${MINE} ORDER BY i.created_at DESC LIMIT 100`,
      )
      .bind(now(), user.id, user.email ?? null)
      .all<Record<string, string | null>>();
    return r.results.map((i) => ({ id: i.id!, orgId: i.org_id ?? null, repoId: i.repo_id ?? null, org: i.org_login ?? null, repo: i.repo_full ?? null, role: i.role!, invitedBy: i.inviter ?? null, createdAt: i.created_at!, expiresAt: i.expires_at! }));
  }

  /** Accept or decline one of this person's pending invitations (see invitesFor). */
  async answerInvite(id: string, user: Account, accept: boolean): Promise<{ orgId: string | null; repoId: string | null }> {
    const inv = await this.db.prepare(`SELECT i.* FROM invites i WHERE ${MINE} AND i.id = ?`).bind(now(), user.id, user.email ?? null, id).first<Record<string, string | null>>();
    if (!inv) throw new HttpError(404, "no pending invitation with this id");
    if (accept) await this.applyInvite(inv, user);
    else await this.db.prepare("DELETE FROM invites WHERE id = ? AND accepted_at IS NULL").bind(id).run();
    return { orgId: inv.org_id ?? null, repoId: inv.repo_id ?? null };
  }

  async acceptInvite(token: string, user: Account): Promise<{ orgId: string | null; repoId: string | null }> {
    const inv = await this.db.prepare("SELECT * FROM invites WHERE token_hash = ?").bind(await sha256(token)).first<Record<string, string | null>>();
    if (!inv || inv.accepted_at || inv.expires_at! < now()) throw new HttpError(404, "this invite is invalid or has expired");
    if (inv.account_id) {
      if (inv.account_id !== user.id) throw new HttpError(403, "this invitation is for someone else");
    } else if (inv.email && inv.email.toLowerCase() !== (user.email ?? "").toLowerCase()) throw new HttpError(403, `this invite was sent to ${inv.email}; sign in with that address`);
    await this.applyInvite(inv, user);
    return { orgId: inv.org_id ?? null, repoId: inv.repo_id ?? null };
  }

  private async acceptInvitesForEmail(userId: string, email: string): Promise<void> {
    const user = (await this.account(userId))!;
    const r = await this.db.prepare("SELECT * FROM invites WHERE email = ? AND account_id IS NULL AND accepted_at IS NULL AND expires_at > ?").bind(email, now()).all<Record<string, string | null>>();
    for (const inv of r.results) await this.applyInvite(inv, user);
  }

  private async applyInvite(inv: Record<string, string | null>, user: Account): Promise<void> {
    const stmts = [this.db.prepare("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?").bind(now(), user.id, inv.id!), this.db.prepare("UPDATE accounts SET status = 'active' WHERE id = ? AND status = 'pending'").bind(user.id)];
    if (inv.org_id) stmts.push(this.db.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, user_id) DO NOTHING").bind(inv.org_id, user.id, inv.role === "admin" || inv.role === "owner" ? inv.role : "member", now()));
    if (inv.repo_id) stmts.push(this.db.prepare("INSERT OR REPLACE INTO repo_access (repo_id, account_id, role) VALUES (?, ?, ?)").bind(inv.repo_id, user.id, inv.role));
    await this.db.batch(stmts);
    const org = inv.org_id ? await this.account(inv.org_id) : null;
    const repo = inv.repo_id ? await this.repoById(inv.repo_id) : null;
    if (inv.invited_by && inv.invited_by !== user.id) {
      await enqueueMail(this.env, [
        { kind: "invite_accepted", data: { login: user.login, email: inv.account_id ? "" : (user.email ?? inv.email ?? ""), org: org?.login, repo: repo ? `${repo.owner_login}/${repo.name}` : undefined }, to: { accountId: inv.invited_by }, reason: "account", at: now() },
      ]);
    }
  }

  /** Record a pending account's request. Administrators hear about it once a day at most, however often it is sent. */
  async requestAccess(accountId: string, note: string): Promise<void> {
    const before = await this.db.prepare("SELECT created_at FROM access_requests WHERE account_id = ?").bind(accountId).first<{ created_at: string }>();
    await this.db.prepare("INSERT OR REPLACE INTO access_requests (account_id, note, created_at) VALUES (?, ?, ?)").bind(accountId, note.slice(0, 500), now()).run();
    if (before && Date.parse(before.created_at) > Date.now() - 86_400_000) return;
    const who = await this.account(accountId);
    const admins = await this.db.prepare("SELECT id FROM accounts WHERE kind = 'user' AND site_admin = 1 AND status = 'active' LIMIT 20").all<{ id: string }>();
    if (who) await enqueueMail(this.env, admins.results.map((a) => ({ kind: "access_request" as const, data: { email: who.email ?? "", login: who.login, note: note.slice(0, 500) }, to: { accountId: a.id }, reason: "admin" as const, at: now() })));
  }

  async accessRequests(): Promise<Array<{ account: Account; note: string; createdAt: string }>> {
    const r = await this.db.prepare("SELECT a.*, r.note AS req_note, r.created_at AS req_at FROM access_requests r JOIN accounts a ON a.id = r.account_id WHERE a.status = 'pending' ORDER BY r.created_at").all<Account & { req_note: string; req_at: string }>();
    return r.results.map((x) => ({ account: x, note: x.req_note, createdAt: x.req_at }));
  }

  // ---------------------------------------------------------------- repositories

  async repo(owner: string, name: string): Promise<Repo | null> {
    return this.db
      .prepare("SELECT r.*, a.login AS owner_login, a.kind AS owner_kind, a.suspended_at AS owner_suspended_at FROM repos r JOIN accounts a ON a.id = r.owner_id WHERE a.login = ? AND r.name = ?")
      .bind(owner, name.replace(/\.git$/, ""))
      .first<Repo>();
  }

  async repoById(id: string): Promise<Repo | null> {
    return this.db.prepare("SELECT r.*, a.login AS owner_login, a.kind AS owner_kind, a.suspended_at AS owner_suspended_at FROM repos r JOIN accounts a ON a.id = r.owner_id WHERE r.id = ?").bind(id).first<Repo>();
  }

  /**
   * Repositories an account works with, most recently pushed first (at most 500): its own, its
   * organizations' (as its role there allows) and those shared with it, like GitHub's /user/repos.
   * With `ownerId`, that owner's repositories the account can see, public ones included. Without it,
   * other people's public repositories aren't listed: there may be any number of them (see
   * publicRepos), and listing them pushed the account's own out of the 500.
   */
  async reposVisibleTo(account: Account, ownerId?: string): Promise<Repo[]> {
    if (account.status !== "active") return [];
    if (account.kind === "agent") {
      const owner = account.owner_id ? await this.account(account.owner_id) : null;
      if (!owner || owner.status !== "active") return [];
    }
    const params: unknown[] = [];
    let q = "SELECT r.*, a.login AS owner_login, a.kind AS owner_kind, a.suspended_at AS owner_suspended_at FROM repos r JOIN accounts a ON a.id = r.owner_id";
    const subjectId = account.kind === "agent" ? account.owner_id! : account.id;
    if (ownerId) {
      q += " WHERE r.owner_id = ?";
      params.push(ownerId);
      if (!account.site_admin) {
        q += ` AND (r.visibility = 'public' OR r.owner_id = ? OR r.owner_id IN (SELECT m.org_id FROM org_members m JOIN accounts o ON o.id = m.org_id WHERE m.user_id = ? AND (m.role != 'member' OR COALESCE(o.base_role, 'read') != 'none')) OR r.id IN (SELECT repo_id FROM repo_access WHERE account_id IN (?, ?)))`;
        params.push(subjectId, subjectId, account.id, subjectId);
      }
    } else {
      // Each part is an indexed lookup (repos by owner, org_members by user, repo_access by account).
      q += ` WHERE r.id IN (SELECT id FROM repos WHERE owner_id = ?
        UNION SELECT o.id FROM org_members m JOIN accounts oa ON oa.id = m.org_id JOIN repos o ON o.owner_id = m.org_id WHERE m.user_id = ? AND (m.role != 'member' OR COALESCE(oa.base_role, 'read') != 'none' OR o.visibility = 'public')
        UNION SELECT repo_id FROM repo_access WHERE account_id IN (?, ?))`;
      params.push(subjectId, subjectId, account.id, subjectId);
    }
    // A suspended person's repositories are hidden from everyone but site administrators.
    if (!account.site_admin) q += " AND a.suspended_at IS NULL";
    q += " ORDER BY COALESCE(r.pushed_at, r.updated_at) DESC LIMIT 500";
    return (await this.db.prepare(q).bind(...params).all<Repo>()).results;
  }

  /**
   * Public repositories, most recently pushed first (for the sitemap and search). `filter.words` keeps
   * those whose owner/name, description or topics contain every word; `filter.owners` those of these
   * owners (logins).
   */
  async publicRepos(limit: number, filter: { words?: string[]; owners?: string[] } = {}): Promise<Repo[]> {
    let q = "SELECT r.*, a.login AS owner_login, a.kind AS owner_kind, a.suspended_at AS owner_suspended_at FROM repos r JOIN accounts a ON a.id = r.owner_id WHERE r.visibility = 'public' AND a.suspended_at IS NULL";
    const params: unknown[] = [];
    const owners = (filter.owners ?? []).slice(0, 20);
    if (owners.length) {
      q += ` AND a.login IN (${owners.map(() => "?").join(", ")})`;
      params.push(...owners);
    }
    for (const w of (filter.words ?? []).slice(0, 10)) {
      q += " AND (a.login || '/' || r.name || ' ' || COALESCE(r.description, '') || ' ' || r.topics) LIKE ? ESCAPE '\\'";
      params.push(`%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    }
    q += " ORDER BY COALESCE(r.pushed_at, r.updated_at) DESC LIMIT ?";
    params.push(limit);
    return (await this.db.prepare(q).bind(...params).all<Repo>()).results;
  }

  /** `o.authorized`: the caller already checked that `creator` may create repositories for `owner` (GitHub imports). */
  async createRepo(owner: Account, creator: Account, input: { name: string; description?: string; visibility?: string; defaultBranch?: string }, o: { authorized?: boolean } = {}): Promise<Repo> {
    if (!isValidName(input.name)) throw new HttpError(422, "invalid repository name: use letters, numbers, '.', '-' and '_'");
    // Like GitHub, a member who creates an organization repository administers it, whatever the base permission.
    let creatorGrant: string | null = null;
    if (o.authorized) {
      // checked by the caller
    } else if (owner.kind === "org") {
      const subject = creator.kind === "agent" ? creator.owner_id! : creator.id;
      const role = await this.orgRole(owner.id, subject);
      if (!role && !creator.site_admin) throw new HttpError(403, "you are not a member of this organization");
      if (role === "member") creatorGrant = subject;
    } else if (owner.id !== creator.id && !creator.site_admin) throw new HttpError(403, "you can only create repositories for yourself or your organizations");
    if (await this.repo(owner.login, input.name)) throw new HttpError(422, "a repository with this name already exists");
    await checkRepositoryQuota(this.env, owner.id, owner.login);
    const id = newId();
    const t = now();
    const branch = input.defaultBranch || "main";
    await this.db.batch([
      this.db
        .prepare("INSERT INTO repos (id, owner_id, name, description, visibility, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, owner.id, input.name, input.description ?? "", repoVisibility(input.visibility) ?? "private", branch, t, t),
      ...(creatorGrant ? [this.db.prepare("INSERT INTO repo_access (repo_id, account_id, role) VALUES (?, ?, 'admin')").bind(id, creatorGrant)] : []),
      // A new repository at a moved one's old name takes it over for good, as on GitHub.
      ...this.claimName(owner.login, input.name),
    ]);
    const meta: RepoMeta = { repoId: id, ownerId: owner.id, owner: owner.login, name: input.name, defaultBranch: branch, ownerKind: owner.kind === "org" ? "org" : "user", archived: false };
    const stub = this.env.REPO.get(this.env.REPO.idFromName(id));
    await stub.init(meta);
    if (owner.kind === "org") {
      const vars = await this.orgVariables(owner.id);
      if (vars.length) await stub.setOrgVariables(Object.fromEntries(vars.map((v) => [v.name, v.value])));
    }
    return (await this.repoById(id))!;
  }

  async updateRepo(repo: Repo, patch: { name?: string; description?: string; visibility?: string; defaultBranch?: string; archived?: boolean; homepage?: string; topics?: string[] }): Promise<Repo> {
    if (patch.name && !isValidName(patch.name)) throw new HttpError(422, "invalid repository name");
    const renamed = !!patch.name && patch.name !== repo.name;
    if (renamed && patch.name!.toLowerCase() !== repo.name.toLowerCase() && (await this.repo(repo.owner_login, patch.name!))) {
      throw new HttpError(422, "a repository with this name already exists", { errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
    }
    await this.db.batch([
      this.db
        .prepare("UPDATE repos SET name = COALESCE(?, name), description = COALESCE(?, description), visibility = COALESCE(?, visibility), default_branch = COALESCE(?, default_branch), archived = COALESCE(?, archived), updated_at = ? WHERE id = ?")
        .bind(patch.name ?? null, patch.description ?? null, repoVisibility(patch.visibility) ?? null, patch.defaultBranch ?? null, patch.archived === undefined ? null : patch.archived ? 1 : 0, now(), repo.id),
      // A rename leaves a redirect from the old name, like a transfer.
      ...(renamed ? [this.leaveRedirect(repo), ...this.claimName(repo.owner_login, patch.name!)] : []),
    ]);
    if (patch.homepage !== undefined || patch.topics !== undefined) {
      await this.db
        .prepare("UPDATE repos SET homepage = COALESCE(?, homepage), topics = COALESCE(?, topics) WHERE id = ?")
        .bind(patch.homepage ?? null, patch.topics ? JSON.stringify(patch.topics.slice(0, 20)) : null, repo.id)
        .run();
    }
    if (patch.name || patch.defaultBranch) await this.env.REPO.get(this.env.REPO.idFromName(repo.id)).updateMeta({ name: patch.name ?? repo.name, defaultBranch: patch.defaultBranch ?? repo.default_branch });
    // The repository's object lands pull requests by itself (auto-merge, the merge queue): it must know, and stop.
    if (patch.archived !== undefined) await this.env.REPO.get(this.env.REPO.idFromName(repo.id)).setArchived(patch.archived);
    if (renamed) await this.forgetArchives(repo.id);
    return (await this.repoById(repo.id))!;
  }

  async deleteRepo(repo: Repo): Promise<void> {
    await this.db.batch(this.repoRowDeletes({ repoId: repo.id }));
    // Wipes the Durable Object's storage, then the repository's R2 objects.
    await this.env.REPO.get(this.env.REPO.idFromName(repo.id)).destroy();
  }

  /**
   * The directory's part of deleting one repository, or every repository an account owns (account deletion,
   * which then runs each Durable Object's `destroy()` in the background).
   */
  repoRowDeletes(which: { repoId: string } | { ownerId: string }): D1PreparedStatement[] {
    const [ids, key] = "repoId" in which ? ["?", which.repoId] : ["SELECT id FROM repos WHERE owner_id = ?", which.ownerId];
    return [
      this.db.prepare(`DELETE FROM repo_access WHERE repo_id IN (${ids})`).bind(key),
      // Agent setup's agents (lib/agent-setup.ts) could only ever reach this repository: they stop for good.
      this.db.prepare(`UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL AND account_id IN (SELECT agent_id FROM agent_setups WHERE repo_id IN (${ids}))`).bind(now(), key),
      this.db.prepare(`UPDATE accounts SET status = 'disabled' WHERE id IN (SELECT agent_id FROM agent_setups WHERE repo_id IN (${ids}))`).bind(key),
      this.db.prepare(`DELETE FROM agent_setups WHERE repo_id IN (${ids})`).bind(key),
      this.db.prepare(`DELETE FROM agent_setup_checks WHERE repo_id IN (${ids})`).bind(key),
      // Invitations reference the repository without ON DELETE CASCADE, so they'd block the delete.
      this.db.prepare(`DELETE FROM invites WHERE repo_id IN (${ids})`).bind(key),
      this.db.prepare(`DELETE FROM schedules WHERE repo_id IN (${ids})`).bind(key),
      // A deleted repository's old names stop redirecting.
      this.db.prepare(`DELETE FROM repo_redirects WHERE repo_id IN (${ids})`).bind(key),
      // Apps installed with this repository selected (apps/store.ts) no longer list it.
      this.db.prepare(`DELETE FROM app_installation_repos WHERE repo_id IN (${ids})`).bind(key),
      this.db.prepare(`DELETE FROM repos WHERE ${"repoId" in which ? "id" : "owner_id"} = ?`).bind(key),
    ];
  }

  /**
   * Move a repository to another owner, like GitHub's transfer, optionally renaming it. The repository
   * keeps its id, so its Durable Object (git data, issues, pull requests, runs, secrets, variables,
   * environments, webhooks, deploy keys, caches) and its R2 objects stay where they are; its packages
   * move with it, and the old owner/name redirects to the new one. The caller has checked that `by`
   * administers the repository; this checks the rest: only people transfer, a personal repository only
   * by its owner, and only to `by`'s own account or an organization `by` owns or administers.
   */
  async transferRepo(repo: Repo, by: Account, target: Account, newName?: string): Promise<Repo> {
    if (by.kind !== "user" || by.status !== "active") throw new HttpError(403, "only people can transfer repositories");
    if (repo.owner_kind !== "org" && repo.owner_id !== by.id && !by.site_admin) throw new HttpError(403, "only the owner can transfer a personal repository");
    if (target.kind === "agent" || target.status !== "active") throw new HttpError(422, "repositories can only be transferred to a person or an organization", { errors: [{ resource: "Repository", code: "invalid", field: "new_owner" }] });
    const targetRole = target.kind === "org" ? await this.orgRole(target.id, by.id) : null;
    if (target.kind === "user" ? target.id !== by.id : targetRole !== "owner" && targetRole !== "admin") {
      throw new HttpError(403, "you can transfer repositories only to your own account or to an organization you own or administer");
    }
    if (target.id === repo.owner_id) throw new HttpError(422, `${repo.owner_login}/${repo.name} already belongs to ${target.login}`, { errors: [{ resource: "Repository", code: "invalid", field: "new_owner" }] });
    const name = newName?.trim() || repo.name;
    if (!isValidName(name)) throw new HttpError(422, "invalid repository name: use letters, numbers, '.', '-' and '_'", { errors: [{ resource: "Repository", code: "invalid", field: "new_name" }] });
    if (await this.repo(target.login, name)) throw new HttpError(422, `${target.login} already has a repository named ${name}`, { errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
    await checkRepositoryQuota(this.env, target.id, target.login);
    // Packages linked to the repository move with it; an image of the same name under the target would collide.
    const clash = await this.db
      .prepare("SELECT p.name FROM packages p WHERE p.owner_id = ? AND p.name IN (SELECT name FROM packages WHERE repo_id = ?) LIMIT 1")
      .bind(target.id, repo.id)
      .first<{ name: string }>();
    if (clash) throw new HttpError(422, `${target.login} already has a container image named ${clash.name}; this repository's image of that name would replace it`);
    // An import filling the repository works by its owner and name; let it finish first.
    const stub = this.env.REPO.get(this.env.REPO.idFromName(repo.id));
    if (await stub.importLockHolder()) throw new HttpError(423, "repository is locked by an import in progress; transfer it once the import finishes");
    const t = now();
    await this.db.batch([
      this.db.prepare("UPDATE repos SET owner_id = ?, name = ?, updated_at = ? WHERE id = ?").bind(target.id, name, t, repo.id),
      this.leaveRedirect(repo),
      ...this.claimName(target.login, name),
      this.db.prepare("INSERT OR REPLACE INTO package_redirects (owner_login, name, package_id, created_at) SELECT ?, name, id, ? FROM packages WHERE repo_id = ?").bind(repo.owner_login, t, repo.id),
      this.db.prepare("DELETE FROM package_redirects WHERE owner_login = ? AND name IN (SELECT name FROM packages WHERE repo_id = ?)").bind(target.login, repo.id),
      this.db.prepare("UPDATE packages SET owner_id = ?, updated_at = ? WHERE repo_id = ?").bind(target.id, t, repo.id),
      // Apps installed on the old owner with this repository selected lose it (apps/store.ts).
      this.db.prepare("DELETE FROM app_installation_repos WHERE repo_id = ?").bind(repo.id),
      // Direct collaborators stay, and a new personal owner needs no grant of its own. Grants that came
      // with the old organization go, as when someone leaves it: its members' (including the admin grant
      // of whoever created the repository), their agents' and the organization's own agents'.
      this.db.prepare("DELETE FROM repo_access WHERE repo_id = ? AND account_id = ?").bind(repo.id, target.id),
      ...(repo.owner_kind === "org"
        ? [
            this.db
              .prepare("DELETE FROM repo_access WHERE repo_id = ? AND account_id IN (SELECT user_id FROM org_members WHERE org_id = ? UNION SELECT id FROM accounts WHERE kind = 'agent' AND (owner_id = ? OR owner_id IN (SELECT user_id FROM org_members WHERE org_id = ?)))")
              .bind(repo.id, repo.owner_id, repo.owner_id, repo.owner_id),
          ]
        : []),
    ]);
    // The Durable Object keeps its id; refresh what it knows about its owner, and swap in the new owner's organization variables.
    await stub.updateMeta({ owner: target.login, ownerId: target.id, ownerKind: target.kind === "org" ? "org" : "user", name });
    const vars = target.kind === "org" ? await this.orgVariables(target.id) : [];
    await stub.setOrgVariables(Object.fromEntries(vars.map((v) => [v.name, v.value])));
    await this.forgetArchives(repo.id);
    return (await this.repoById(repo.id))!;
  }

  /** Cached zipballs and tarballs are named after the owner and repository; drop them when either changes (they are rebuilt on the next download). */
  private async forgetArchives(repoId: string): Promise<void> {
    await deletePrefixes(this.env.BUCKET, [archivePrefix(repoId)]).catch((e) => console.error("could not drop cached archives", repoId, e));
  }

  // ---------------------------------------------------------------- redirects (transfers and renames)

  /** Remember a repository's current owner/name before it moves, so the old URLs lead to it. */
  private leaveRedirect(repo: Repo): D1PreparedStatement {
    return this.db.prepare("INSERT OR REPLACE INTO repo_redirects (owner_login, name, repo_id, created_at) VALUES (?, ?, ?, ?)").bind(repo.owner_login, repo.name, repo.id, now());
  }

  /**
   * A repository now lives at owner/name: an older redirect from there stops applying, and so do
   * redirects of images named after it (<owner>/<name> and <owner>/<name>/...), which its own
   * workflows push to.
   */
  private claimName(ownerLogin: string, name: string): D1PreparedStatement[] {
    return [
      this.db.prepare("DELETE FROM repo_redirects WHERE owner_login = ? AND name = ?").bind(ownerLogin, name),
      this.db.prepare("DELETE FROM package_redirects WHERE owner_login = ? AND (name = ? OR substr(name, 1, length(?) + 1) = lower(?) || '/')").bind(ownerLogin, name.toLowerCase(), name, name),
    ];
  }

  /**
   * Where an owner/name that holds no repository now leads: a transferred or renamed repository, or one
   * under a renamed owner. Callers must apply the same visibility check as for a direct load, so a
   * redirect never shows that a private repository exists.
   */
  async movedRepo(owner: string, name: string): Promise<Repo | null> {
    const bare = name.replace(/\.git$/, "");
    const direct = await this.db.prepare("SELECT repo_id FROM repo_redirects WHERE owner_login = ? AND name = ?").bind(owner, bare).first<{ repo_id: string }>();
    if (direct) return this.repoById(direct.repo_id);
    const account = await this.renamedAccount(owner);
    if (!account) return null;
    const moved = await this.repo(account.login, bare);
    if (moved) return moved;
    const again = await this.db.prepare("SELECT repo_id FROM repo_redirects WHERE owner_login = ? AND name = ?").bind(account.login, bare).first<{ repo_id: string }>();
    return again ? this.repoById(again.repo_id) : null;
  }

  /** The account that used to have this login, while no account has it now. */
  async renamedAccount(login: string): Promise<Account | null> {
    if (await this.accountByLogin(login)) return null;
    return this.db.prepare("SELECT a.* FROM login_redirects l JOIN accounts a ON a.id = l.account_id WHERE l.login = ? AND a.status = 'active'").bind(login).first<Account>();
  }

  async setTopics(repoId: string, topics: string[]): Promise<void> {
    await this.db.prepare("UPDATE repos SET topics = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(topics), now(), repoId).run();
  }

  // ---------------------------------------------------------------- organization variables

  async orgVariables(orgId: string): Promise<Array<{ name: string; value: string; updated_at: string }>> {
    return (await this.db.prepare("SELECT name, value, updated_at FROM org_variables WHERE org_id = ? ORDER BY name").bind(orgId).all<{ name: string; value: string; updated_at: string }>()).results;
  }

  /** Set (or, with null, delete) organization variables, then copy the set into each of the organization's repositories. */
  async setOrgVariables(orgId: string, changes: Record<string, string | null>): Promise<void> {
    const stmts = Object.entries(changes).map(([name, value]) =>
      value === null
        ? this.db.prepare("DELETE FROM org_variables WHERE org_id = ? AND name = ?").bind(orgId, name.toUpperCase())
        : this.db.prepare("INSERT OR REPLACE INTO org_variables (org_id, name, value, updated_at) VALUES (?, ?, ?, ?)").bind(orgId, name.toUpperCase(), value, now()),
    );
    if (stmts.length) await this.db.batch(stmts);
    await this.syncOrgVariables(orgId);
  }

  /**
   * Add organization variables only where none exists (ON CONFLICT DO NOTHING), used by imports so
   * an import never overwrites a value an org admin already set. Returns which names were added and
   * which were skipped because a variable of that name already existed.
   */
  async addOrgVariablesIfAbsent(orgId: string, vars: Record<string, string>): Promise<{ added: string[]; skipped: string[] }> {
    const before = new Set((await this.orgVariables(orgId)).map((v) => v.name));
    const added: string[] = [];
    const skipped: string[] = [];
    const stmts: D1PreparedStatement[] = [];
    for (const [rawName, value] of Object.entries(vars)) {
      const name = rawName.toUpperCase();
      if (before.has(name)) {
        skipped.push(name);
        continue;
      }
      added.push(name);
      stmts.push(this.db.prepare("INSERT INTO org_variables (org_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, name) DO NOTHING").bind(orgId, name, value, now()));
    }
    if (stmts.length) {
      await this.db.batch(stmts);
      await this.syncOrgVariables(orgId);
    }
    return { added, skipped };
  }

  /**
   * Copy the organization's current variable set into each of its repositories' Durable Objects.
   * Every repository is tried even when one fails, and failures get a second try. Any still failing
   * make this throw, so the caller can repeat the (idempotent) change: the variables themselves are
   * already saved, and each copy is the whole set, so a later sync brings a stale repository current.
   */
  private async syncOrgVariables(orgId: string): Promise<void> {
    const vars = Object.fromEntries((await this.orgVariables(orgId)).map((v) => [v.name, v.value]));
    let ids = (await this.db.prepare("SELECT id FROM repos WHERE owner_id = ?").bind(orgId).all<{ id: string }>()).results.map((r) => r.id);
    for (let attempt = 0; attempt < 2 && ids.length; attempt++) {
      const results = await Promise.allSettled(ids.map((id) => this.env.REPO.get(this.env.REPO.idFromName(id)).setOrgVariables(vars)));
      ids = ids.filter((_, i) => results[i]!.status === "rejected");
    }
    if (ids.length) throw new HttpError(503, `the variables were saved, but ${ids.length} ${ids.length === 1 ? "repository wasn't" : "repositories weren't"} updated; repeat the request to finish`);
  }

  /** The highest role an agent may ever hold (its policy's maxRole, default write). */
  agentMaxRole(account: Account): Role {
    const policy = account.agent_policy ? (JSON.parse(account.agent_policy) as { maxRole?: Role }) : {};
    return policy.maxRole ?? "write";
  }

  async touchPushed(repoId: string): Promise<void> {
    await this.db.prepare("UPDATE repos SET pushed_at = ?, updated_at = ? WHERE id = ?").bind(now(), now(), repoId).run();
  }

  async collaborators(repoId: string): Promise<Array<{ account: Account; role: Role }>> {
    const r = await this.db.prepare("SELECT a.*, x.role AS access_role FROM repo_access x JOIN accounts a ON a.id = x.account_id WHERE x.repo_id = ? ORDER BY a.login").bind(repoId).all<Account & { access_role: Role }>();
    return r.results.map((x) => ({ account: x, role: x.access_role }));
  }

  async setCollaborator(repoId: string, accountId: string, role: Role | null): Promise<void> {
    const previous = (await this.db.prepare("SELECT role FROM repo_access WHERE repo_id = ? AND account_id = ?").bind(repoId, accountId).first<{ role: Role }>())?.role ?? null;
    if (role) await this.db.prepare("INSERT OR REPLACE INTO repo_access (repo_id, account_id, role) VALUES (?, ?, ?)").bind(repoId, accountId, role).run();
    else await this.db.prepare("DELETE FROM repo_access WHERE repo_id = ? AND account_id = ?").bind(repoId, accountId).run();
    const repo = previous !== role ? await this.repoById(repoId) : null;
    if (repo) await enqueueMail(this.env, [{ kind: "repo_access", data: { repo: `${repo.owner_login}/${repo.name}`, role, previous }, to: { accountId }, reason: "account", at: now() }]);
  }

  /** Accounts by id, in chunks that stay under D1's 100 bound parameters (missing ids are left out). */
  async accountsByIds(ids: string[]): Promise<Account[]> {
    const out: Account[] = [];
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 90) {
      const part = unique.slice(i, i + 90);
      out.push(...(await this.db.prepare(`SELECT * FROM accounts WHERE id IN (${part.map(() => "?").join(", ")})`).bind(...part).all<Account>()).results);
    }
    return out;
  }

  /** Accounts by login, case-insensitively (unknown logins are left out). */
  async accountsByLogins(logins: string[]): Promise<Account[]> {
    const out: Account[] = [];
    const unique = [...new Set(logins.map((l) => l.toLowerCase()))];
    for (let i = 0; i < unique.length; i += 90) {
      const part = unique.slice(i, i + 90);
      out.push(...(await this.db.prepare(`SELECT * FROM accounts WHERE login IN (${part.map(() => "?").join(", ")})`).bind(...part).all<Account>()).results);
    }
    return out;
  }

  /**
   * The ids of `accounts` that can read `repo` (roleFor isn't null), with a few queries for all of
   * them rather than two each: a notification about a busy thread checks up to 200 people.
   */
  async readersOf(repo: Repo, accounts: Account[]): Promise<Set<string>> {
    const out = new Set<string>();
    const users: Account[] = [];
    for (const a of accounts) {
      if (a.status !== "active") continue;
      if (a.kind === "agent") {
        if (await this.roleFor(a, repo)) out.add(a.id);
      } else if (a.kind === "user") users.push(a);
    }
    for (const a of users) if (a.site_admin || repo.visibility !== "private" || repo.owner_id === a.id) out.add(a.id);
    const rest = users.filter((a) => !out.has(a.id));
    for (let i = 0; i < rest.length; i += 90) {
      const ids = rest.slice(i, i + 90).map((a) => a.id);
      const marks = ids.map(() => "?").join(", ");
      const shared = await this.db.prepare(`SELECT account_id AS id FROM repo_access WHERE repo_id = ? AND account_id IN (${marks})`).bind(repo.id, ...ids).all<{ id: string }>();
      for (const r of shared.results) out.add(r.id);
      if (repo.owner_kind === "org") {
        const members = await this.db
          .prepare(`SELECT m.user_id AS id, m.role, o.base_role FROM org_members m JOIN accounts o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id IN (${marks})`)
          .bind(repo.owner_id, ...ids)
          .all<{ id: string; role: string; base_role: string | null }>();
        for (const m of members.results) if (m.role === "owner" || m.role === "admin" || (m.role === "member" && baseRole(m) !== "none")) out.add(m.id);
      }
    }
    return out;
  }

  /** Effective role of an account on a repository (null = no access). */
  /**
   * The grants that decide `accountId`'s role in the repository `owner/name` (its own access, and its membership of
   * the owning organization), read by name so a request can read them at the same time as the repository itself.
   * Empty when there is no such repository. roleFor takes them in place of reading them again.
   */
  async grantsFor(owner: string, name: string, accountId: string): Promise<RepoGrants[]> {
    const r = await this.db
      .prepare(
        "SELECT r.id AS repo_id, ? AS account_id, ra.role AS access, m.role AS member_role, o.base_role FROM repos r JOIN accounts o ON o.id = r.owner_id LEFT JOIN repo_access ra ON ra.repo_id = r.id AND ra.account_id = ? LEFT JOIN org_members m ON m.org_id = r.owner_id AND m.user_id = ? WHERE o.login = ? AND r.name = ?",
      )
      .bind(accountId, accountId, accountId, owner, name.replace(/\.git$/, ""))
      .all<{ repo_id: string; account_id: string; access: Role | null; member_role: string | null; base_role: string | null }>();
    return r.results.map((g) => ({ repoId: g.repo_id, accountId: g.account_id, access: g.access, memberRole: g.member_role, baseRole: g.base_role }));
  }

  /** `account`'s own access to `repo` and its membership of the owning organization: from `grants` when they cover them, else read. */
  private async grantsOf(account: Account, repo: Repo, grants: RepoGrants[]): Promise<{ explicit: { role: Role } | null; m: { role: string; base_role: string | null } | null }> {
    const g = grants.find((x) => x.repoId === repo.id && x.accountId === account.id);
    if (g) return { explicit: g.access ? { role: g.access } : null, m: repo.owner_kind === "org" && g.memberRole ? { role: g.memberRole, base_role: g.baseRole } : null };
    const [m, explicit] = await Promise.all([
      repo.owner_kind === "org"
        ? this.db
            .prepare("SELECT m.role, o.base_role FROM org_members m JOIN accounts o ON o.id = m.org_id WHERE m.org_id = ? AND m.user_id = ?")
            .bind(repo.owner_id, account.id)
            .first<{ role: string; base_role: string | null }>()
        : null,
      this.db.prepare("SELECT role FROM repo_access WHERE repo_id = ? AND account_id = ?").bind(repo.id, account.id).first<{ role: Role }>(),
    ]);
    return { explicit, m };
  }

  /**
   * `knownOwner`: an agent's owner as the caller already read it this request (auth/principal.ts), else it is read here.
   * `grants`: grantsFor's answers for this repository, read alongside it; any not covered are read here.
   */
  async roleFor(account: Account, repo: Repo, knownOwner?: Account | null, grants: RepoGrants[] = []): Promise<Role | null> {
    if (account.status !== "active") return null;
    if (account.kind === "agent") {
      if (!account.owner_id) return null;
      // An agent from Agent setup reaches its one repository and nothing else, whatever token it uses.
      const only = agentRepoId(account);
      if (only !== null && only !== repo.id) return null;
      // The owner, the owner's role and the agent's own grant, each read once and side by side.
      const ownerOf = knownOwner?.id === account.owner_id ? Promise.resolve(knownOwner) : this.account(account.owner_id);
      const [owner, ownerRole, explicit] = await Promise.all([
        ownerOf,
        ownerOf.then((o) => (!o || o.status !== "active" ? null : o.kind === "org" ? (repo.owner_id === o.id ? ("admin" as const) : null) : this.roleFor(o, repo, undefined, grants))),
        this.grantsOf(account, repo, grants).then((g) => g.explicit),
      ]);
      if (!owner || owner.status !== "active") return null;
      if (!ownerRole) return null;
      const policy = account.agent_policy ? (JSON.parse(account.agent_policy) as { maxRole?: Role }) : {};
      // A grant on the repository can lower an agent's role, never lift it past the maximum its owner set:
      // any of the repository's admins can grant, and only the owner decides how far the agent goes.
      const max = policy.maxRole && Object.hasOwn(ROLE_LEVEL, policy.maxRole) ? policy.maxRole : null;
      const granted = explicit?.role ?? max ?? "write";
      const cap: Role = max && ROLE_LEVEL[granted] > ROLE_LEVEL[max] ? max : granted;
      return ROLE_LEVEL[ownerRole] < ROLE_LEVEL[cap] ? ownerRole : cap;
    }
    if (account.site_admin) return "admin";
    let best: Role | null = null;
    const bump = (r: Role | null) => {
      if (r && (!best || ROLE_LEVEL[r] > ROLE_LEVEL[best])) best = r;
    };
    if (repo.owner_id === account.id) bump("admin");
    const { m, explicit } = await this.grantsOf(account, repo, grants);
    if (repo.owner_kind === "org") {
      // Owners and admins administer every repository; members get the organization's base permission.
      if (m?.role === "owner" || m?.role === "admin") bump("admin");
      else if (m?.role === "member") {
        const base = baseRole(m);
        if (base !== "none") bump(base);
      }
    }
    bump(explicit?.role ?? null);
    if (repo.visibility !== "private") bump("read");
    return best;
  }

  // ---------------------------------------------------------------- notifications and audit

  async notify(accountIds: string[], n: { repoId?: string; kind: string; title: string; url: string }): Promise<void> {
    const unique = [...new Set(accountIds)];
    if (!unique.length) return;
    await this.db.batch(unique.map((id) => this.db.prepare("INSERT INTO notifications (id, account_id, repo_id, kind, title, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(newId(), id, n.repoId ?? null, n.kind, n.title, n.url, now())));
  }

  async notifications(accountId: string, unreadOnly = false): Promise<Array<{ id: string; kind: string; title: string; url: string; createdAt: string; readAt: string | null }>> {
    const r = await this.db.prepare(`SELECT * FROM notifications WHERE account_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 100`).bind(accountId).all<Record<string, string | null>>();
    return r.results.map((n) => ({ id: n.id!, kind: n.kind!, title: n.title!, url: n.url!, createdAt: n.created_at!, readAt: n.read_at ?? null }));
  }

  async markRead(accountId: string, id?: string): Promise<void> {
    await this.db.prepare(`UPDATE notifications SET read_at = ? WHERE account_id = ? ${id ? "AND id = ?" : ""} AND read_at IS NULL`).bind(...(id ? [now(), accountId, id] : [now(), accountId])).run();
  }

  async audit(entry: { actorId?: string; actorLogin?: string; onBehalfOf?: string; action: string; target?: string; detail?: unknown; at?: string }): Promise<void> {
    await this.db
      .prepare("INSERT INTO audit_log (id, at, actor_id, actor_login, on_behalf_of, action, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(), entry.at ?? now(), entry.actorId ?? null, entry.actorLogin ?? null, entry.onBehalfOf ?? null, entry.action, entry.target ?? null, entry.detail ? JSON.stringify(entry.detail) : null)
      .run();
    // Security emails (sign-ins, passkeys, tokens, push protection…) hang off the audit log.
    await mailForAudit(this.env, this, entry).catch((e) => console.error("security email failed", entry.action, e));
  }

  async auditLog(limit = 200): Promise<Array<Record<string, string | null>>> {
    return (await this.db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?").bind(limit).all<Record<string, string | null>>()).results;
  }
}

/** How long audit log entries are kept (docs/security/audit-log.md, and the privacy policy). */
export const AUDIT_RETENTION_DAYS = 730;

/** Delete audit log entries older than AUDIT_RETENTION_DAYS, a bounded batch at a time; returns how many went. */
export async function pruneAuditLog(db: D1Database, at = new Date(), batch = 5000): Promise<number> {
  const before = new Date(at.getTime() - AUDIT_RETENTION_DAYS * 86400_000).toISOString();
  const r = await db.prepare("DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? LIMIT ?)").bind(before, batch).run();
  return r.meta.changes ?? 0;
}
