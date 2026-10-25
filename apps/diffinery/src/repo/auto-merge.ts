import type { Actor } from "@diffinery/shared";
import type { Env } from "../env.js";
import { agentMayMerge } from "../lib/agent-setup.js";
import { Directory } from "../lib/directory.js";
import { HttpError, now } from "../lib/util.js";
import type { RepoDO } from "./RepoDO.js";
import { isAppCaller, isJobCaller } from "./token-policy.js";
import { Apps } from "../apps/store.js";
import { ROLE_LEVEL, atLeast, type Caller, type ProtectionRules, type Role } from "./types.js";

/**
 * Auto-merge, like GitHub's: Diffinery merges a pull request by itself as soon as every
 * rule of its base branch is met (required checks green on the head, approvals from people,
 * linear history and an up-to-date branch where required). Into a branch that merges
 * through a merge queue it adds the pull request to the queue instead.
 *
 * It is also how agents land changes on protected branches without a bypass: they never
 * merge there themselves, but a person who administers the repository can let them have
 * Diffinery do it (`allowAgentAutoMerge`), on a branch whose required checks gate it. With
 * `autoMergeAgents` on the rule too, Diffinery turns it on by itself for those agents' pull
 * requests (applyRule), so no agent or person has to at merge time.
 *
 * People and agents can also have it turned on for every pull request they open (accounts.auto_merge,
 * applyOwn): it is their own click, automated, with nothing it wouldn't need anyway, and only into a
 * branch with a required check, so it always waits for CI.
 */

export type MergeMethod = "merge" | "squash" | "rebase";

/** Stored on the pull request (pulls.auto_merge) while auto-merge is on. */
export type AutoMergeState = {
  method: MergeMethod;
  commitTitle: string | null;
  commitMessage: string | null;
  enabledBy: Actor;
  enabledAt: string;
  /** The role (and a workflow token's permissions) it was enabled with: the merge never acts with more. */
  role: Role;
  permissions?: Caller["permissions"];
  /** Delete the head branch once it lands, as a manual merge's `delete_branch` does (collab.ts completeMerge says which branches). */
  deleteBranch?: boolean;
  /** The branch rule pattern whose `autoMergeAgents` turned it on, for the agent in `enabledBy`. */
  byRule?: string;
  /** Turned on when `enabledBy` opened the pull request (or marked it ready), because their own setting says so (applyOwn). */
  byDefault?: boolean;
};

/** What the API and the web show: who turned it on, and how it will merge. */
export type AutoMergeInfo = Pick<AutoMergeState, "method" | "commitTitle" | "commitMessage" | "enabledBy" | "enabledAt" | "byRule" | "byDefault"> & { deleteBranch: boolean };

/**
 * An account's own auto-merge setting (accounts.auto_merge): turn auto-merge on for the pull requests it
 * opens, with this merge method ("default": as the base branch merges). Null when it's off.
 */
export type AutoMergeDefault = MergeMethod | "default";

export function parseAutoMergeDefault(v: unknown): AutoMergeDefault | null {
  return v === "default" || v === "merge" || v === "squash" || v === "rebase" ? v : null;
}

export type AutoMergeResult = { state: "enabled" | "queued" | "merged"; autoMerge: AutoMergeInfo | null; mergeCommit?: string | null };

/** Why auto-merge turns itself off in an archived repository, which is read-only for everyone. */
export const ARCHIVED_REASON = "the repository is archived";

/** Comments about auto-merge the server wrote on its own (it was turned off because ...). */
export const AUTO_MERGE_BOT: Caller = { id: "system:auto-merge", login: "diffinery-auto-merge[bot]", kind: "system", role: "admin" };

const METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

/** A person: not an agent, not a workflow's GITHUB_TOKEN, not the system. */
export const isPerson = (c: Pick<Caller, "id" | "kind">): boolean => c.kind === "user" && !isJobCaller(c);

/**
 * Whether `caller` may have Diffinery land a pull request into `base` without a person merging
 * it: by auto-merge, or through the merge queue. Null when it may, else why not.
 *
 * - People may (branch protection still decides when the merge happens).
 * - Agents and workflow tokens may on a branch that is neither the default branch nor protected.
 * - An agent may where `agentsMayMerge` already lets it merge by itself.
 * - Otherwise only where a person turned on `allowAgentAutoMerge`, and the branch has at least
 *   one required check, so CI gates what lands. Workflow tokens are held to the same rule even
 *   when the run's code didn't come from an agent.
 */
export function automaticLandingRefusal(caller: Pick<Caller, "id" | "kind" | "mayMerge">, rules: ProtectionRules | null, isDefault: boolean, base: string): { status: 403 | 422; message: string } | null {
  if (isPerson(caller)) return null;
  if (!rules && !isDefault) return null;
  if (caller.kind === "agent" && rules?.agentsMayMerge) return null;
  if (mergesByAgentPermission(caller, rules, isDefault, true)) return null;
  const who = isJobCaller(caller) ? "workflow tokens" : isAppCaller(caller) ? "apps" : "agents";
  if (!rules?.allowAgentAutoMerge) {
    return { status: 403, message: `${who} may not have pull requests merged into ${base} automatically unless its branch protection allows it (allowAgentAutoMerge, set by a repository admin); a person must merge` };
  }
  if (!rules.requiredChecks?.length) {
    return { status: 422, message: `${base} has no required status checks: allowAgentAutoMerge needs at least one, so that CI gates what ${who} land` };
  }
  return null;
}

/**
 * Whether an agent merges into a branch, by hand or through auto-merge and the merge queue, on its own
 * policy's permission (`mayMerge`, from Agent setup: lib/agent-setup.ts) rather than a rule of the
 * branch. The rules of the branch still all apply, and on top of them a person must have approved the
 * pull request's latest commit, and a change to a workflow file needs a person to merge it.
 * Never a workflow token's, whatever kind it carries.
 */
export function mergesByAgentPermission(caller: Pick<Caller, "id" | "kind" | "mayMerge">, rules: ProtectionRules | null, isDefault: boolean, automatic: boolean): boolean {
  if (caller.kind !== "agent" || isJobCaller(caller) || !caller.mayMerge) return false;
  // Where agents merge anyway: a branch that is neither protected nor the default one, or one whose rules let them.
  if (!rules && !isDefault) return false;
  if (rules?.agentsMayMerge) return false;
  if (automatic && rules?.allowAgentAutoMerge && rules.requiredChecks?.length) return false;
  return true;
}

/** Whether an automatic landing by `caller` relies on `allowAgentAutoMerge` (rather than being a person's, or allowed anyway). */
export function landsByAgentRule(caller: Pick<Caller, "id" | "kind">, rules: ProtectionRules | null, isDefault: boolean): boolean {
  return !isPerson(caller) && (!!rules || isDefault) && !(caller.kind === "agent" && rules?.agentsMayMerge);
}

const minRole = (a: Role, b: Role): Role => (ROLE_LEVEL[a] <= ROLE_LEVEL[b] ? a : b);

type Filter = { number?: number; sha?: string; base?: string };

export class AutoMerge {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private repo: RepoDO,
    private env: Env,
  ) {}

  private get sql() {
    return this.repo.sql;
  }

  state(number: number): AutoMergeState | null {
    const r = this.sql.exec<{ auto_merge: string | null }>("SELECT auto_merge FROM pulls WHERE number = ?", number).toArray()[0];
    return r?.auto_merge ? (JSON.parse(r.auto_merge) as AutoMergeState) : null;
  }

  static info(s: AutoMergeState | null): AutoMergeInfo | null {
    return s
      ? { method: s.method, commitTitle: s.commitTitle, commitMessage: s.commitMessage, enabledBy: s.enabledBy, enabledAt: s.enabledAt, deleteBranch: !!s.deleteBranch, ...(s.byRule ? { byRule: s.byRule } : {}), ...(s.byDefault ? { byDefault: true } : {}) }
      : null;
  }

  /**
   * Turn auto-merge on (or change how it merges), then merge or enqueue right away if the pull request is ready.
   * `opts.rule`: the server turns it on for `caller`, the pull request's agent, because that branch rule names it
   * (applyRule); it is then recorded as the server's doing. `opts.byDefault`: `caller` opened the pull request and
   * their own setting turns auto-merge on (applyOwn). `opts.background`: look at the pull request after returning,
   * so opening one doesn't wait for a merge check.
   */
  async enable(
    number: number,
    input: { method?: string; commitTitle?: string | null; commitMessage?: string | null; deleteBranch?: boolean; expectedHeadSha?: string },
    caller: Caller,
    opts: { rule?: string; byDefault?: boolean; background?: boolean } = {},
  ): Promise<AutoMergeResult> {
    const { issue } = this.repo.collab.get(number);
    const pull = issue.pull;
    if (!pull) throw new HttpError(404, "not a pull request");
    if (await this.repo.isArchived()) throw new HttpError(403, "repository is archived (read-only)");
    if (pull.merged) throw new HttpError(422, "pull request is already merged");
    if (issue.state !== "open") throw new HttpError(422, "pull request is closed");
    if (pull.draft) throw new HttpError(422, "pull request is a draft; mark it ready for review first");
    if (!atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to enable auto-merge");
    const rules = this.repo.protectionFor(pull.base);
    const refusal = automaticLandingRefusal(caller, rules, pull.base === this.repo.meta.defaultBranch, pull.base);
    if (refusal) throw new HttpError(refusal.status, refusal.message);
    if (landsByAgentRule(caller, rules, pull.base === this.repo.meta.defaultBranch)) {
      const path = await this.repo.collab.changedWorkflow(number);
      if (path) throw new HttpError(422, `the pull request changes workflow file \`${path}\`; CI can't gate a change to itself, so a person must merge it`);
    }
    if (input.method !== undefined && !METHODS.includes(input.method as MergeMethod)) throw new HttpError(422, "merge_method must be merge, squash or rebase");
    const method = (input.method as MergeMethod | undefined) ?? rules?.mergeQueue?.method ?? (rules?.requireLinearHistory ? "squash" : "merge");
    if (method === "merge" && rules?.requireLinearHistory) throw new HttpError(422, `${pull.base} requires linear history; use squash or rebase`);
    if (this.repo.queue.isQueued(number)) throw new HttpError(422, "pull request is already in the merge queue");
    if (input.expectedHeadSha && input.expectedHeadSha !== pull.headSha) throw new HttpError(409, "head branch was modified; review and try again");
    const state: AutoMergeState = {
      method,
      commitTitle: typeof input.commitTitle === "string" && input.commitTitle ? input.commitTitle : null,
      commitMessage: typeof input.commitMessage === "string" && input.commitMessage ? input.commitMessage : null,
      enabledBy: { id: caller.id, login: caller.login, kind: caller.kind, ...(caller.onBehalfOf ? { onBehalfOf: caller.onBehalfOf } : {}) },
      enabledAt: now(),
      role: caller.role,
      ...(caller.permissions ? { permissions: caller.permissions } : {}),
      ...(input.deleteBranch === true ? { deleteBranch: true } : {}),
      ...(opts.rule ? { byRule: opts.rule } : {}),
      ...(opts.byDefault ? { byDefault: true } : {}),
    };
    // Turned on by a branch rule: the server did it (for the agent it merges as), and the record says so.
    const by = opts.rule ? AUTO_MERGE_BOT : caller;
    this.sql.exec("UPDATE pulls SET auto_merge = ? WHERE number = ?", JSON.stringify(state), number);
    this.repo.social.record(number, "auto_merge_enabled", by, { merge_method: method, ...(opts.rule ? { rule: opts.rule, agent: caller.login } : {}), ...(opts.byDefault ? { by_default: true } : {}) });
    this.event(number, "auto_merge_enabled", by);
    this.audit("pull_request.auto_merge_enabled", by, number, {
      base: pull.base,
      method,
      viaAgentRule: landsByAgentRule(caller, rules, pull.base === this.repo.meta.defaultBranch),
      ...(opts.rule ? { byRule: opts.rule, agent: caller.login } : {}),
      ...(opts.byDefault ? { byDefault: true } : {}),
    });
    this.repo.broadcast(`pr:${number}`, { action: "auto_merge" });
    if (opts.background) {
      this.repo.background(this.process({ number }));
      return { state: "enabled", autoMerge: AutoMerge.info(state) };
    }
    await this.process({ number });
    return this.result(number);
  }

  /**
   * A branch rule's `autoMergeAgents`: when one of those agents opens a pull request into a matching branch, marks
   * it ready, or pushes to it, Diffinery turns auto-merge on by itself, as that agent. It then lands exactly as the
   * agent's own auto-merge would: `allowAgentAutoMerge` and a required check, the agent's write access at merge
   * time, approvals unless the rule waives them, no requested changes, and a person for a workflow change.
   * Never again on a pull request where anyone turned auto-merge off, or the server did. `announce`: when it
   * can't turn on, say why in a comment (once, when the pull request is opened or marked ready).
   */
  async applyRule(number: number, announce: boolean, opts: { background?: boolean } = {}): Promise<void> {
    const r = this.sql
      .exec<{ author_id: string; author_kind: string; state: string; draft: number; merged: number; auto_merge: string | null; base_ref: string }>(
        "SELECT i.author_id, i.author_kind, i.state, p.draft, p.merged, p.auto_merge, p.base_ref FROM issues i JOIN pulls p ON p.number = i.number WHERE i.number = ?",
        number,
      )
      .toArray()[0];
    if (!r || r.state !== "open" || r.merged || r.draft || r.auto_merge || r.author_kind !== "agent") return;
    const rule = this.repo.protectionRuleFor(r.base_ref);
    if (!rule?.rules.allowAgentAutoMerge || !rule.rules.autoMergeAgents?.some((a) => a.id === r.author_id)) return;
    if (this.repo.queue.isQueued(number)) return;
    if (this.sql.exec("SELECT 1 FROM issue_events WHERE number = ? AND event = 'auto_merge_disabled' LIMIT 1", number).toArray().length) return;
    const caller = await this.accountCaller(r.author_id, "admin");
    if (!caller || caller.kind !== "agent") return;
    try {
      await this.enable(number, { method: rule.rules.autoMergeMethod }, caller, { rule: rule.pattern, background: opts.background });
    } catch (e) {
      if (!announce) return;
      const why = e instanceof HttpError ? e.detail : "it could not be turned on";
      try {
        this.repo.collab.addComment(number, `Auto-merge didn't turn on by itself (branch rule \`${rule.pattern}\` auto-merges ${caller.login}'s pull requests): ${why}. A person can merge it.`, AUTO_MERGE_BOT);
      } catch (err) {
        console.warn("auto-merge rule comment failed", err);
      }
    }
  }

  /**
   * A pull request was just opened by `opener`. `choice` is what they asked for when opening it (the API's
   * `auto_merge`): false keeps auto-merge off, true turns it on even if their setting doesn't. Otherwise a
   * branch rule naming its agent (applyRule), then the opener's own setting (applyOwn), may turn it on.
   * Returns why it stayed off when they asked for it, else null.
   */
  async opened(number: number, opener: Caller, choice?: boolean): Promise<string | null> {
    if (choice === false) return null;
    await this.applyRule(number, true, { background: true });
    if (this.state(number)) return null;
    return this.applyOwn(number, opener, { requested: choice === true, announce: true });
  }

  /**
   * The setting "turn on auto-merge for my pull requests" (accounts.auto_merge), for a person or an agent: when
   * `actor` opens a pull request, or marks their draft ready, Diffinery turns auto-merge on for them, as them. It
   * is their own click automated: it lands only as their own auto-merge would (required checks, approvals, the
   * agent rules, a person for an agent's workflow change), and only into a branch with at least one required
   * check, so it always waits for CI. Never on a pull request someone else opened, or where auto-merge was turned
   * off before. `requested`: they asked for it on this pull request, whatever their setting. Returns why it
   * stayed off, or null when it turned on or had nothing to do.
   */
  async applyOwn(number: number, actor: Caller, opts: { requested?: boolean; announce?: boolean } = {}): Promise<string | null> {
    const r = this.sql
      .exec<{ author_id: string; state: string; draft: number; merged: number; auto_merge: string | null; base_ref: string }>(
        "SELECT i.author_id, i.state, p.draft, p.merged, p.auto_merge, p.base_ref FROM issues i JOIN pulls p ON p.number = i.number WHERE i.number = ?",
        number,
      )
      .toArray()[0];
    if (!r || r.state !== "open" || r.merged || r.auto_merge || r.author_id !== actor.id) return null;
    if (r.draft) return opts.requested ? "the pull request is a draft; auto-merge can turn on once it is marked ready" : null;
    if (this.repo.queue.isQueued(number)) return null;
    if (this.sql.exec("SELECT 1 FROM issue_events WHERE number = ? AND event = 'auto_merge_disabled' LIMIT 1", number).toArray().length) return null;
    const setting = isJobCaller(actor) ? null : parseAutoMergeDefault((await new Directory(this.env).account(actor.id))?.auto_merge);
    if (!setting && !opts.requested) return null;
    const rules = this.repo.protectionFor(r.base_ref);
    // Without a required check nothing waits for CI, and auto-merge would merge at once: that isn't "on green".
    if (!rules?.requiredChecks?.length) return `${r.base_ref} has no required status checks, so auto-merge would not wait for CI; set up merge on green in the repository's settings`;
    const method = setting && setting !== "default" && !(setting === "merge" && rules.requireLinearHistory) ? setting : undefined;
    try {
      await this.enable(number, { method }, actor, { byDefault: true, background: true });
      return null;
    } catch (e) {
      const why = e instanceof HttpError ? e.detail : "it could not be turned on";
      // An agent hears why in a comment, once; a person sees the pull request's merge box.
      if (opts.announce && actor.kind === "agent" && !opts.requested) {
        try {
          this.repo.collab.addComment(number, `Auto-merge didn't turn on by itself (${actor.login} turns on auto-merge for its pull requests): ${why}. A person can merge it.`, AUTO_MERGE_BOT);
        } catch (err) {
          console.warn("auto-merge default comment failed", err);
        }
      }
      return why;
    }
  }

  private result(number: number): AutoMergeResult {
    const p = this.sql.exec<{ merged: number; merge_commit: string | null }>("SELECT merged, merge_commit FROM pulls WHERE number = ?", number).one();
    if (p.merged) return { state: "merged", autoMerge: null, mergeCommit: p.merge_commit };
    if (this.repo.queue.isQueued(number)) return { state: "queued", autoMerge: null };
    return { state: "enabled", autoMerge: AutoMerge.info(this.state(number)) };
  }

  /** Turn auto-merge off at someone's request: who turned it on, or anyone with write access. */
  disable(number: number, caller: Caller): void {
    const s = this.state(number);
    if (!s) return;
    if (s.enabledBy.id !== caller.id && !atLeast(caller.role, "write")) throw new HttpError(403, "write access is required to disable auto-merge");
    this.cancel(number, caller, null);
  }

  /** A push to the head branch by anyone but who turned auto-merge on cancels it, as on GitHub. */
  headPushed(number: number, pusher: Caller): void {
    const s = this.state(number);
    if (s && s.enabledBy.id !== pusher.id) this.cancel(number, pusher, `${pusher.login} pushed new commits to the branch`);
  }

  /** The pull request closed or merged: auto-merge is over, nothing to announce. */
  clear(number: number): void {
    this.sql.exec("UPDATE pulls SET auto_merge = NULL WHERE number = ? AND auto_merge IS NOT NULL", number);
  }

  /** Turn auto-merge off; with a reason, the server did (it is said in a comment). */
  cancel(number: number, by: Caller, reason: string | null): void {
    const s = this.state(number);
    if (!s) return;
    this.clear(number);
    this.repo.social.record(number, "auto_merge_disabled", by, reason ? { reason } : {});
    this.event(number, "auto_merge_disabled", by);
    this.audit("pull_request.auto_merge_disabled", by, number, { enabledBy: s.enabledBy.login, ...(reason ? { reason } : {}) });
    if (reason) {
      try {
        this.repo.collab.addComment(number, `Auto-merge was turned off: ${reason}.`, AUTO_MERGE_BOT);
      } catch (e) {
        console.warn("auto-merge comment failed", e);
      }
    }
    this.repo.broadcast(`pr:${number}`, { action: "auto_merge" });
  }

  /** The repository was archived: nothing lands by itself any more, so every waiting auto-merge is turned off, saying why. */
  repositoryArchived(): Promise<void> {
    return this.exclusive(async () => {
      for (const n of this.pending({})) this.cancel(n, AUTO_MERGE_BOT, ARCHIVED_REASON);
    });
  }

  /** Re-evaluate in the background: after checks complete, reviews, protection changes and pushes. */
  schedule(filter: Filter = {}): void {
    if (!this.pending(filter).length) return;
    this.repo.background(this.process(filter));
  }

  private pending(filter: Filter): number[] {
    const where = ["p.auto_merge IS NOT NULL", "i.state = 'open'"];
    const args: unknown[] = [];
    if (filter.number !== undefined) {
      where.push("p.number = ?");
      args.push(filter.number);
    }
    if (filter.sha !== undefined) {
      where.push("p.head_sha = ?");
      args.push(filter.sha);
    }
    if (filter.base !== undefined) {
      where.push("p.base_ref = ?");
      args.push(filter.base);
    }
    return this.sql
      .exec<{ number: number }>(`SELECT p.number FROM pulls p JOIN issues i ON i.number = p.number WHERE ${where.join(" AND ")} ORDER BY p.number`, ...args)
      .toArray()
      .map((r) => r.number);
  }

  process(filter: Filter = {}): Promise<void> {
    return this.exclusive(async () => {
      for (const n of this.pending(filter)) {
        try {
          await this.step(n);
        } catch (e) {
          console.error(`auto-merge of #${n} failed`, e);
        }
      }
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Merge (or enqueue) one pull request if it is ready now; otherwise leave auto-merge on, or turn it off when it can never go through. */
  private async step(number: number): Promise<void> {
    const s = this.state(number);
    if (!s) return;
    const { issue } = this.repo.collab.get(number);
    const pull = issue.pull!;
    if (pull.merged || issue.state !== "open") return this.clear(number);
    if (this.repo.queue.isQueued(number)) return this.clear(number);
    // An archived repository is read-only: a check that finishes after the archive must not land anything.
    if (await this.repo.isArchived()) return this.cancel(number, AUTO_MERGE_BOT, ARCHIVED_REASON);
    const caller = await this.callerOf(s);
    if (!caller || !atLeast(caller.role, "write")) return this.cancel(number, AUTO_MERGE_BOT, `${s.enabledBy.login} no longer has write access`);
    // The rules may have changed since it was turned on: an agent's auto-merge needs them to still allow it.
    const rules = this.repo.protectionFor(pull.base);
    const refusal = automaticLandingRefusal(caller, rules, pull.base === this.repo.meta.defaultBranch, pull.base);
    if (refusal) return this.cancel(number, AUTO_MERGE_BOT, refusal.message);
    if (s.method === "merge" && rules?.requireLinearHistory) return this.cancel(number, AUTO_MERGE_BOT, `${pull.base} requires linear history, and auto-merge was set to create a merge commit`);
    const m = await this.repo.collab.mergeability(number, caller, { automatic: true });
    if (!m.mergeable) return;
    if (rules?.mergeQueue) {
      let r: Awaited<ReturnType<RepoDO["queue"]["enqueue"]>>;
      try {
        r = await this.repo.queue.enqueue(number, { method: s.method, deleteBranch: !!s.deleteBranch }, caller);
      } catch (e) {
        // Like a refused merge: the queue said no, so auto-merge is off and the comment says why.
        if (e instanceof HttpError && e.status === 409) return;
        return this.cancel(number, AUTO_MERGE_BOT, e instanceof HttpError ? e.detail : "the pull request could not be added to the merge queue");
      }
      this.clear(number);
      this.audit("pull_request.auto_merge_enqueued", caller, number, { base: pull.base, state: r.state });
      return;
    }
    try {
      const r = await this.repo.collab.merge(number, { method: s.method, title: s.commitTitle ?? undefined, message: s.commitMessage ?? undefined, expectedHeadSha: pull.headSha, deleteBranch: !!s.deleteBranch }, caller, { automatic: true });
      this.audit("pull_request.auto_merged", caller, number, { base: pull.base, method: r.method, sha: r.sha });
    } catch (e) {
      // The head or base moved under us: the next event looks again. Anything else won't fix itself.
      if (e instanceof HttpError && e.status === 409) return;
      this.cancel(number, AUTO_MERGE_BOT, e instanceof HttpError ? e.detail : "the merge failed");
    }
  }

  /**
   * Who merges: the one who turned auto-merge on, with their access as it is now (never more than
   * when they turned it on). A workflow token's job has ended by then, so it keeps what it had.
   */
  private async callerOf(s: AutoMergeState): Promise<Caller | null> {
    const by = s.enabledBy;
    if (isJobCaller(by)) return { ...by, role: s.role, permissions: s.permissions };
    if (isAppCaller(by)) return this.appCaller(by, s);
    return this.accountCaller(by.id, s.role);
  }

  /** An app's bot, while its installation is still active and still covers this repository. */
  private async appCaller(by: Actor, s: AutoMergeState): Promise<Caller | null> {
    const apps = new Apps(this.env);
    const inst = await apps.installation(Number(by.id.slice("app:".length)));
    if (!inst || inst.suspendedAt) return null;
    const [app, account] = await Promise.all([apps.byId(inst.appId), new Directory(this.env).account(inst.accountId)]);
    if (!app || account?.status !== "active" || account.suspended_at) return null;
    const m = this.repo.meta;
    if (!(await apps.covers(inst, { id: m.repoId, owner_id: m.ownerId }))) return null;
    return { ...by, role: s.role, permissions: s.permissions };
  }

  /** An account as a caller in this repository, with its access as it is now, never above `cap`. */
  private async accountCaller(id: string, cap: Role): Promise<Caller | null> {
    const dir = new Directory(this.env);
    const [account, repo] = await Promise.all([dir.account(id), dir.repoById(this.repo.meta.repoId)]);
    if (!account || !repo) return null;
    const role = await dir.roleFor(account, repo);
    if (!role) return null;
    const kind = account.kind === "agent" ? "agent" : "user";
    const onBehalfOf = kind === "agent" && account.owner_id ? (await dir.account(account.owner_id))?.login : undefined;
    return { id: account.id, login: account.login, kind, ...(onBehalfOf ? { onBehalfOf } : {}), role: minRole(role, cap), ...(agentMayMerge(account) ? { mayMerge: true } : {}) };
  }

  private event(number: number, action: "auto_merge_enabled" | "auto_merge_disabled", by: Caller): void {
    const p = this.sql.exec<{ head_ref: string; head_sha: string; base_ref: string }>("SELECT head_ref, head_sha, base_ref FROM pulls WHERE number = ?", number).toArray()[0];
    if (!p) return;
    const m = this.repo.meta;
    this.repo.emit({ type: "pull_request", action, repoId: m.repoId, owner: m.owner, repo: m.name, number, headRef: p.head_ref, headSha: p.head_sha, baseRef: p.base_ref, actor: { id: by.id, login: by.login, kind: by.kind, onBehalfOf: by.onBehalfOf }, at: now() });
  }

  private audit(action: string, by: Caller, number: number, detail: Record<string, string | number | boolean | null>): void {
    const m = this.repo.meta;
    this.repo.emit({ type: "audit", action, actor: { id: by.id, login: by.login, kind: by.kind, onBehalfOf: by.onBehalfOf }, target: `${m.owner}/${m.name}#${number}`, detail, at: now() });
  }
}
