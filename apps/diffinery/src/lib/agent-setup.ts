import type { Env } from "../env.js";
import type { Account, Directory, Repo } from "./directory.js";
import { HttpError, now, randomAlnum } from "./util.js";

/**
 * Agent setup (Settings → Agent setup, web/agent-setup.tsx): everything a cloud agent environment,
 * such as a Claude Code cloud environment, needs to work on one repository from its first session.
 *
 * Each person gets, per repository, an agent of their own that can only ever reach that repository:
 * its policy names it, and Directory.roleFor refuses every other repository whatever token it uses.
 * Its tokens are limited to the repository too, write at most, for 90 days. The agent never does more
 * than the person can (an agent's role is capped by its owner's), and the agent rules hold: it can't
 * push to protected or default branches, its pull requests need a person's approval, and it never
 * touches secrets or merges a change to a workflow file. Merging is on by default (`mayMerge`): the
 * agent may merge, or turn on auto-merge for, a pull request once a person approved its latest commit
 * and every rule of the branch is met (repo/collab.ts mergeability). The page turns it off.
 *
 * The hosted script (/<owner>/<repo>/agent-setup.sh) installs the CLI, wires git and gh to the token in
 * the environment and reports its self-test here, which is the page's Check.
 */

export const AGENT_SETUP_DAYS = 90;

/** What Agent setup writes in an agent's policy (accounts.agent_policy). */
export interface AgentSetupPolicy {
  maxRole: "write";
  canMergeProtected: false;
  budgetUsdMonthly: null;
  /** The one repository the agent may reach. */
  repoId: string;
  /** May merge pull requests a person approved (see above). */
  mayMerge: boolean;
}

export interface AgentSetupToken {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface SetupCheckLine {
  name: string;
  ok: boolean;
  message: string;
}

export interface SetupCheck {
  at: string;
  ok: boolean;
  firstOkAt: string | null;
  account: { id: string; login: string } | null;
  token: { id: string; name: string; prefix: string } | null;
  checks: SetupCheckLine[];
  cliVersion: string | null;
}

/** A repository-limited agent's own repository, from its policy; null for every other account. */
export function agentRepoId(account: Pick<Account, "kind" | "agent_policy">): string | null {
  if (account.kind !== "agent" || !account.agent_policy) return null;
  try {
    const p = JSON.parse(account.agent_policy) as { repoId?: unknown };
    return typeof p.repoId === "string" ? p.repoId : null;
  } catch {
    return null;
  }
}

/** Whether an agent may merge pull requests by its own policy (Agent setup's "Can merge"). */
export function agentMayMerge(account: Pick<Account, "kind" | "agent_policy">): boolean {
  if (account.kind !== "agent" || !account.agent_policy) return false;
  try {
    return (JSON.parse(account.agent_policy) as { mayMerge?: unknown }).mayMerge === true;
  } catch {
    return false;
  }
}

/** Login candidates for a person's agent on a repository: readable first, then unique. */
export function agentLogins(repo: Pick<Repo, "name">, person: Pick<Account, "login">): string[] {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const name = clean(repo.name).slice(0, 60) || "repo";
  const who = clean(person.login).slice(0, 30);
  return [`${name}-agent`, `${who}-${name}-agent`, `${who}-${name}-agent-${randomAlnum(5).toLowerCase()}`, `${name}-agent-${randomAlnum(8).toLowerCase()}`];
}

export class AgentSetup {
  constructor(
    private env: Env,
    private dir: Directory,
  ) {}

  private get db() {
    return this.env.DB;
  }

  /** `person`'s agent for `repo`, active or not. */
  async agentOf(repo: Pick<Repo, "id">, person: Pick<Account, "id">): Promise<Account | null> {
    const row = await this.db.prepare("SELECT agent_id FROM agent_setups WHERE repo_id = ? AND person_id = ?").bind(repo.id, person.id).first<{ agent_id: string }>();
    return row ? await this.dir.account(row.agent_id) : null;
  }

  /** Every person's agent for `repo` (for its administrators, who may revoke any of them). */
  async agents(repo: Pick<Repo, "id">): Promise<Array<{ agent: Account; person: Account | null; createdAt: string }>> {
    const rows = (await this.db.prepare("SELECT agent_id, person_id, created_at FROM agent_setups WHERE repo_id = ? ORDER BY created_at").bind(repo.id).all<{ agent_id: string; person_id: string; created_at: string }>()).results;
    const accounts = new Map((await this.dir.accountsByIds(rows.flatMap((r) => [r.agent_id, r.person_id]))).map((a) => [a.id, a]));
    return rows.flatMap((r) => {
      const agent = accounts.get(r.agent_id);
      return agent ? [{ agent, person: accounts.get(r.person_id) ?? null, createdAt: r.created_at }] : [];
    });
  }

  /**
   * `person`'s agent for `repo`, made on first use. A person can have one per repository; generating a
   * token again reuses it (and turns it back on if they had turned it off).
   */
  async ensureAgent(repo: Repo, person: Account): Promise<{ agent: Account; created: boolean }> {
    if (person.kind !== "user") throw new HttpError(403, "only people can set up agents");
    const existing = await this.agentOf(repo, person);
    if (existing) {
      if (existing.status !== "active") await this.dir.setStatus(existing.id, "active");
      return { agent: (await this.dir.account(existing.id))!, created: false };
    }
    const policy: AgentSetupPolicy = { maxRole: "write", canMergeProtected: false, budgetUsdMonthly: null, repoId: repo.id, mayMerge: true };
    let agent: Account | null = null;
    let last: unknown = null;
    for (const login of agentLogins(repo, person)) {
      try {
        agent = await this.dir.createAgent(person, { login, name: `Agent for ${repo.owner_login}/${repo.name}`, policy: { ...policy } });
        break;
      } catch (e) {
        // Taken, retired or in its cool-down after a deletion: try the next name.
        if (!(e instanceof HttpError) || e.status !== 422) throw e;
        last = e;
      }
    }
    if (!agent) throw last instanceof Error ? last : new HttpError(422, "couldn't name the agent");
    try {
      await this.db.prepare("INSERT INTO agent_setups (agent_id, repo_id, person_id, created_at) VALUES (?, ?, ?, ?)").bind(agent.id, repo.id, person.id, now()).run();
    } catch (e) {
      // Two tabs at once: the other one made it. This agent was never handed out, so it goes.
      await this.dir.setStatus(agent.id, "disabled");
      const other = await this.agentOf(repo, person);
      if (!other) throw e;
      return { agent: other, created: false };
    }
    return { agent, created: true };
  }

  /** A new token for the agent, limited to its repository, write at most, for 90 days. */
  async mintToken(agent: Account, repo: Repo, name: string): Promise<{ token: string; id: string; expiresAt: string }> {
    if (agentRepoId(agent) !== repo.id) throw new HttpError(403, "this agent belongs to another repository");
    return this.dir.createToken(agent, { name: name.trim().slice(0, 100) || defaultTokenName(), scopes: ["write"], repoIds: [repo.id], expiresInDays: AGENT_SETUP_DAYS });
  }

  /** The agent's live tokens, newest first. */
  async tokens(agent: Pick<Account, "id">): Promise<AgentSetupToken[]> {
    return (await this.dir.tokens(agent.id)).map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt, createdAt: t.createdAt }));
  }

  /** Another 90 days from now for a live token: the same token keeps working, so nothing needs pasting again. */
  async renew(agent: Pick<Account, "id">, tokenId: string): Promise<string> {
    const expiresAt = new Date(Date.now() + AGENT_SETUP_DAYS * 86400_000).toISOString();
    const r = await this.db
      .prepare("UPDATE tokens SET expires_at = ?, expiry_notified_at = NULL WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND expires_at > ?")
      .bind(expiresAt, tokenId, agent.id, now())
      .run();
    if (!r.meta.changes) throw new HttpError(404, "token not found, revoked or already expired: generate a new one");
    return expiresAt;
  }

  async revoke(agent: Pick<Account, "id">, tokenId: string): Promise<void> {
    await this.dir.revokeToken(agent.id, tokenId);
  }

  /** Turns the agent's merging on or off. */
  async setMayMerge(agent: Account, mayMerge: boolean): Promise<void> {
    const policy = { ...(JSON.parse(agent.agent_policy ?? "{}") as Record<string, unknown>), mayMerge };
    await this.db.prepare("UPDATE accounts SET agent_policy = ? WHERE id = ? AND kind = 'agent'").bind(JSON.stringify(policy), agent.id).run();
  }

  // ---------------------------------------------------------------- the Check

  async recordCheck(repo: Pick<Repo, "id">, by: Pick<Account, "id">, tokenId: string | null, report: { ok: boolean; checks: SetupCheckLine[]; cliVersion: string | null }): Promise<void> {
    const at = now();
    await this.db
      .prepare(
        "INSERT INTO agent_setup_checks (repo_id, at, ok, account_id, token_id, checks, cli_version, first_ok_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?3 THEN ?2 END) " +
          "ON CONFLICT (repo_id) DO UPDATE SET at = excluded.at, ok = excluded.ok, account_id = excluded.account_id, token_id = excluded.token_id, checks = excluded.checks, cli_version = excluded.cli_version, first_ok_at = COALESCE(agent_setup_checks.first_ok_at, excluded.first_ok_at)",
      )
      .bind(repo.id, at, report.ok ? 1 : 0, by.id, tokenId, JSON.stringify(report.checks), report.cliVersion)
      .run();
  }

  async check(repo: Pick<Repo, "id">): Promise<SetupCheck | null> {
    const row = await this.db.prepare("SELECT * FROM agent_setup_checks WHERE repo_id = ?").bind(repo.id).first<{ at: string; ok: number; account_id: string; token_id: string | null; checks: string; cli_version: string | null; first_ok_at: string | null }>();
    if (!row) return null;
    const [account, token] = await Promise.all([
      this.dir.account(row.account_id),
      row.token_id ? this.db.prepare("SELECT id, name, prefix FROM tokens WHERE id = ?").bind(row.token_id).first<{ id: string; name: string; prefix: string }>() : null,
    ]);
    let checks: SetupCheckLine[] = [];
    try {
      checks = JSON.parse(row.checks) as SetupCheckLine[];
    } catch {
      /* an unreadable row shows no lines */
    }
    return { at: row.at, ok: !!row.ok, firstOkAt: row.first_ok_at, account: account ? { id: account.id, login: account.login } : null, token: token ?? null, checks, cliVersion: row.cli_version };
  }
}

/** "Agent setup · Oct 22, 2026": the default label, shown in token lists and the audit log. */
export function defaultTokenName(at = new Date()): string {
  return `Agent setup · ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

/** Validates the script's report: a short list of short lines, nothing else kept. */
export function parseReport(body: unknown): { ok: boolean; checks: SetupCheckLine[]; cliVersion: string | null } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!Array.isArray(b.checks) || !b.checks.length || b.checks.length > 30) throw new HttpError(422, "checks must be a list of 1 to 30 { name, ok, message }");
  const checks = b.checks.map((c) => {
    const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    if (typeof x.name !== "string" || !x.name.trim() || typeof x.ok !== "boolean") throw new HttpError(422, "each check needs a name and ok (true or false)");
    return { name: x.name.trim().slice(0, 100), ok: x.ok, message: typeof x.message === "string" ? x.message.slice(0, 500) : "" };
  });
  const cliVersion = typeof b.cli_version === "string" ? b.cli_version.slice(0, 40) : null;
  // Green only when every line passed, whatever the script says overall.
  return { ok: checks.every((c) => c.ok), checks, cliVersion };
}
