import { ZERO_OID, diffTrees, mergeBase, peelToCommit, readCommit, resolvePath } from "@diffinery/git-core";
import { HttpError, now } from "../lib/util.js";
import type { RepoDO } from "./RepoDO.js";
import type { Caller } from "./types.js";

/** How far back from a ref's tip to look for (or record) agents' commits. */
const AGENT_WALK = 5000;

/**
 * What a workflow's GITHUB_TOKEN is trusted with, beyond its `permissions:`
 * (lib/job-permissions.ts):
 *
 * - The repository's Actions settings, as on GitHub: the default token
 *   permissions (read-only for repositories created from now on, read and write
 *   for older ones) and whether workflows may create and approve pull requests.
 * - Whether a run's code came from an agent: the agent pushed it, opened the
 *   pull request, or pushed the branch last. Such runs act as an agent, so the
 *   agent guardrails (no pushes or merges to protected and default branches,
 *   advisory reviews) hold for code an agent wrote, whoever triggered the run.
 * - Workflow files: a job token never creates or changes them (GitHub's
 *   `workflows` permission, which GITHUB_TOKEN cannot have).
 * - Secrets in runs of agent code: none from the repository or organization
 *   unless an admin allows it (`agentRunSecrets`), since an agent with write
 *   access could otherwise push a workflow that sends them anywhere.
 */

export type WorkflowSettings = { defaultPermissions: "read" | "write"; canApprovePullRequests: boolean; agentRunSecrets: boolean };

const SETTINGS_KEY = "actions_workflow_settings";
/** Repositories that predate the setting keep GitHub's old default. */
const LEGACY: WorkflowSettings = { defaultPermissions: "write", canApprovePullRequests: false, agentRunSecrets: false };
const NEW_REPO: WorkflowSettings = { defaultPermissions: "read", canApprovePullRequests: false, agentRunSecrets: false };

export const WORKFLOW_DIRS = [".github/workflows", ".diffinery/workflows"];

export const isJobCaller = (c: { id: string }) => c.id.startsWith("job:");
/** An app's installation token (apps/, auth/principal.ts): `app:<installation id>`. */
export const isAppCaller = (c: { id: string }) => c.id.startsWith("app:");

export class TokenPolicy {
  constructor(private repo: RepoDO) {}

  private get sql() {
    return this.repo.sql;
  }

  // ---------------------------------------------------------------- settings

  /** Called when a repository is created: it starts with GitHub's current (read-only) default. */
  initNewRepo(): void {
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", SETTINGS_KEY, JSON.stringify(NEW_REPO));
  }

  settings(): WorkflowSettings {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", SETTINGS_KEY).toArray()[0];
    return row ? { ...LEGACY, ...(JSON.parse(row.value) as Partial<WorkflowSettings>) } : { ...LEGACY };
  }

  /** Changes the settings and audits the change; `via: "api"` marks one made through the REST API. */
  setSettings(patch: Partial<WorkflowSettings>, caller: Caller, o: { via?: "api" } = {}): WorkflowSettings {
    if (caller.role !== "admin") throw new HttpError(403, "admin access required");
    if (caller.kind !== "user") throw new HttpError(403, "only people can change what workflows are allowed to do");
    if (patch.defaultPermissions !== undefined && patch.defaultPermissions !== "read" && patch.defaultPermissions !== "write") throw new HttpError(422, "default_workflow_permissions must be read or write");
    if (patch.canApprovePullRequests !== undefined && typeof patch.canApprovePullRequests !== "boolean") throw new HttpError(422, "can_approve_pull_request_reviews must be a boolean");
    if (patch.agentRunSecrets !== undefined && typeof patch.agentRunSecrets !== "boolean") throw new HttpError(422, "agent_runs_use_secrets must be a boolean");
    const next = { ...this.settings(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as WorkflowSettings;
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", SETTINGS_KEY, JSON.stringify(next));
    const m = this.repo.meta;
    this.repo.emit({ type: "audit", action: "repo.actions_workflow_settings", actor: { id: caller.id, login: caller.login, kind: caller.kind, onBehalfOf: caller.onBehalfOf }, target: `${m.owner}/${m.name}`, detail: { ...next, ...(o.via ? { via: o.via } : {}) }, at: now() });
    return next;
  }

  /** Workflows creating or approving pull requests is a setting, off by default (GitHub's message). */
  assertMayCreateOrApprove(caller: Caller, what: "create" | "approve"): void {
    if (!isJobCaller(caller) || this.settings().canApprovePullRequests) return;
    throw new HttpError(403, `GitHub Actions is not permitted to ${what === "create" ? "create" : "approve"} pull requests. An admin can allow it in the repository's Actions settings ("Allow GitHub Actions to create and approve pull requests").`);
  }

  // ---------------------------------------------------------------- where code came from

  /** Records who moved `ref` (pushes, merges, API commits). */
  recordPush(ref: string, newOid: string, caller: Caller): void {
    if (newOid === ZERO_OID) this.sql.exec("DELETE FROM ref_actors WHERE ref = ?", ref);
    else this.sql.exec("INSERT OR REPLACE INTO ref_actors (ref, actor_id, actor_kind, updated_at) VALUES (?, ?, ?, ?)", ref, caller.id, caller.kind, now());
  }

  /**
   * Keeps track of commits agents pushed that aren't on the default branch yet. An agent's push
   * records the commits it brought (up to the default branch or the ref's old tip); the default
   * branch moving forward drops the ones that landed, since its runs go by who moved it.
   */
  async trackAgentCommits(ref: string, oldOid: string, newOid: string, caller: Caller): Promise<void> {
    if (newOid === ZERO_OID) return;
    const isDefault = ref === this.repo.headRef;
    if (!isDefault && caller.kind !== "agent") return;
    if (isDefault && !this.sql.exec("SELECT 1 FROM agent_commits LIMIT 1").toArray().length) return;
    const tip = await peelToCommit(this.repo.store, newOid).catch(() => null);
    if (!tip) return;
    const stop = [oldOid, isDefault ? null : await this.forkPoint(tip)].filter((o): o is string => !!o && o !== ZERO_OID);
    const fresh = await this.commitsSince(tip, stop, AGENT_WALK);
    const at = now();
    for (const oid of fresh) {
      if (isDefault) this.sql.exec("DELETE FROM agent_commits WHERE oid = ?", oid);
      else this.sql.exec("INSERT OR IGNORE INTO agent_commits (oid, pushed_at) VALUES (?, ?)", oid, at);
    }
    this.agentCodeSeen.clear();
  }

  /** Where `tip` meets the default branch: the commits past it are the ref's own. */
  private async forkPoint(tip: string): Promise<string | null> {
    const head = this.repo.getRef(this.repo.headRef);
    return head ? await mergeBase(this.repo.store, head, tip).catch(() => null) : null;
  }

  /** Commits reachable from `tip`, nearest first (by parents, not dates, which a pusher sets), short of `stop`. */
  private async commitsSince(tip: string, stop: string[], limit: number): Promise<string[]> {
    const seen = new Set(stop);
    const out: string[] = [];
    let level = [tip];
    while (level.length && out.length < limit) {
      const next: string[] = [];
      for (const oid of level) {
        if (seen.has(oid) || out.length >= limit) continue;
        seen.add(oid);
        const c = await readCommit(this.repo.store, oid).catch(() => null);
        if (!c) continue; // shallow or missing parents
        out.push(oid);
        next.push(...c.parents);
      }
      level = next;
    }
    return out;
  }

  /** Whether the code at `sha` includes a commit an agent pushed that hasn't landed on the default branch. */
  private async includesAgentCommit(sha: string): Promise<boolean> {
    if (!this.sql.exec("SELECT 1 FROM agent_commits LIMIT 1").toArray().length) return false;
    const cached = this.agentCodeSeen.get(sha);
    if (cached !== undefined) return cached;
    const tip = await peelToCommit(this.repo.store, sha).catch(() => null);
    let found = false;
    if (tip) {
      const base = await this.forkPoint(tip);
      for (const oid of await this.commitsSince(tip, base ? [base] : [], AGENT_WALK)) {
        if (this.sql.exec("SELECT 1 FROM agent_commits WHERE oid = ?", oid).toArray().length) {
          found = true;
          break;
        }
      }
    }
    if (this.agentCodeSeen.size > 200) this.agentCodeSeen.clear();
    this.agentCodeSeen.set(sha, found);
    return found;
  }

  /** includesAgentCommit's answers, per commit, until the next agent push or default branch move. */
  private agentCodeSeen = new Map<string, boolean>();

  lastPusherKind(ref: string): string | null {
    return this.sql.exec<{ actor_kind: string }>("SELECT actor_kind FROM ref_actors WHERE ref = ?", ref).toArray()[0]?.actor_kind ?? null;
  }

  /**
   * Whether a new run's code came from an agent: the trigger was an agent, the run
   * re-runs one that did (`inherited`), the branch or tag it runs was last moved by an
   * agent, for pull request events an agent opened the pull request or last pushed its
   * head branch, or, off the default branch, its code includes a commit an agent pushed
   * (so a person's push, merge, release tag or dispatch on top doesn't make it theirs).
   */
  async agentOrigin(o: { caller: { kind: string }; ref: string; sha?: string; prNumbers?: number[]; inherited?: boolean }): Promise<boolean> {
    if (o.inherited || o.caller.kind === "agent") return true;
    if ((o.ref.startsWith("refs/heads/") || o.ref.startsWith("refs/tags/")) && this.lastPusherKind(o.ref) === "agent") return true;
    for (const n of o.prNumbers ?? []) {
      const pr = this.sql.exec<{ author_kind: string; head_ref: string }>("SELECT i.author_kind, p.head_ref FROM issues i JOIN pulls p ON p.number = i.number WHERE i.number = ?", n).toArray()[0];
      if (!pr) continue;
      if (pr.author_kind === "agent" || this.lastPusherKind(`refs/heads/${pr.head_ref}`) === "agent") return true;
    }
    // The default branch's own runs go by who moved it: what a person merged there is theirs.
    if (o.sha && o.ref !== this.repo.headRef && (await this.includesAgentCommit(o.sha))) return true;
    return false;
  }

  /** A pull request whose head is in another repository (a fork), from the pull request's own row. */
  isForkPull(number: number | null): boolean {
    if (number === null) return false;
    const r = this.sql.exec<{ head_repo_id: string | null; head_ref: string }>("SELECT head_repo_id, head_ref FROM pulls WHERE number = ?", number).toArray()[0];
    if (!r) return false;
    // Imported pull requests from GitHub forks keep their head as "owner:branch", never a local branch.
    return (!!r.head_repo_id && r.head_repo_id !== this.repo.meta.repoId) || r.head_ref.includes(":");
  }

  // ---------------------------------------------------------------- workflow files

  private async workflowDir(commit: string | null, dir: string): Promise<string | null> {
    if (!commit) return null;
    const c = await readCommit(this.repo.store, await peelToCommit(this.repo.store, commit));
    const e = await resolvePath(this.repo.store, c.tree, dir);
    return e?.oid ?? null;
  }

  /**
   * The first workflow file that moving a ref from `oldOid` to `newOid` creates,
   * changes or deletes. A new ref is compared with where it branched off the
   * default branch.
   */
  async changedWorkflow(oldOid: string, newOid: string): Promise<string | null> {
    if (newOid === ZERO_OID) return null;
    let base: string | null = oldOid === ZERO_OID ? null : oldOid;
    if (!base) {
      const head = this.repo.getRef(this.repo.headRef);
      base = head ? await mergeBase(this.repo.store, head, await peelToCommit(this.repo.store, newOid)) : null;
    }
    for (const dir of WORKFLOW_DIRS) {
      const [a, b] = await Promise.all([this.workflowDir(base, dir), this.workflowDir(newOid, dir)]);
      if (a === b) continue;
      const changes = await diffTrees(this.repo.store, a, b, dir).catch(() => []);
      return changes[0]?.path ?? dir;
    }
    return null;
  }

  /**
   * GitHub's refusal for a job token, or an app's installation token, that would add or change a
   * workflow file. Apps are never offered the `workflows` permission, so they never can.
   */
  async refuseWorkflowEdit(caller: Caller, oldOid: string, newOid: string): Promise<string | null> {
    if (!isJobCaller(caller) && !isAppCaller(caller)) return null;
    const path = await this.changedWorkflow(oldOid, newOid);
    return path ? `refusing to allow a GitHub App to create or update workflow \`${path}\` without \`workflows\` permission` : null;
  }
}
