import type { Actor } from "@diffinery/shared";
import { HttpError } from "../lib/util.js";

export type Role = "read" | "triage" | "write" | "maintain" | "admin";
export const ROLE_LEVEL: Record<Role, number> = { read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };
export const atLeast = (role: Role | null | undefined, needed: Role): boolean => !!role && ROLE_LEVEL[role] >= ROLE_LEVEL[needed];
/** How far back a commit listing may page: one request walks at most this many commits, however deep the page asks to go. */
export const MAX_LOG_DEPTH = 10_000;

/** The authenticated caller, with their effective role on this repository. */
export interface Caller extends Actor {
  role: Role;
  /** A workflow job token's effective `permissions:` (lib/job-permissions.ts); absent for everyone else. */
  permissions?: Record<string, "none" | "read" | "write">;
  /** Set only for a running import's own push token, after the Worker verified it (see http/git.ts). */
  importId?: string;
  /** The repository owner's login when it blocked this caller (lib/moderation.ts): they read, but can't take part. */
  blockedBy?: string;
  /**
   * An agent whose own policy lets it merge (Agent setup, lib/agent-setup.ts): it may merge, or have
   * Diffinery land, a pull request a person approved, where the branch's rules alone wouldn't let it.
   */
  mayMerge?: boolean;
}

/**
 * Someone the repository's owner blocked can't open issues or pull requests, comment, review or
 * react there (lib/moderation.ts), as on GitHub.
 */
export function refuseBlocked(caller: Caller): void {
  if (caller.blockedBy) throw new HttpError(403, `you can't open issues or pull requests, comment, review or react in ${caller.blockedBy}'s repositories: ${caller.blockedBy} blocked you`);
}

export interface RepoMeta {
  repoId: string;
  ownerId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** Owner kind decides whether org secrets apply. */
  ownerKind: "user" | "org";
  /**
   * A copy of D1's repos.archived, which is the record (the Directory keeps it in sync, lib/directory.ts
   * updateRepo). Absent in objects made before it existed: RepoDO.isArchived() then reads D1 once.
   */
  archived?: boolean;
}

export interface ProtectionRules {
  requirePullRequest?: boolean;
  requiredApprovals?: number;
  dismissStaleReviews?: boolean;
  requiredChecks?: string[];
  /** Bind a required check to one reporter: check name → login, or "diffinery-actions". */
  requiredCheckSources?: Record<string, string>;
  allowForcePush?: boolean;
  allowDeletion?: boolean;
  requireLinearHistory?: boolean;
  /** When false (default), admins may bypass the rules. */
  enforceAdmins?: boolean;
  /** Agents may push directly to matching branches. Default false. */
  agentsMayPush?: boolean;
  /** Agents may merge pull requests into matching branches. Default false. */
  agentsMayMerge?: boolean;
  /**
   * Agents (and workflow tokens) may have Diffinery land a pull request here for them, through
   * auto-merge or the merge queue, once every rule is met. Needs at least one required check.
   * Only people who administer the repository change it. Default false.
   */
  allowAgentAutoMerge?: boolean;
  /**
   * With `allowAgentAutoMerge`: what Diffinery lands for an agent through auto-merge or the merge
   * queue needs no approving review from a person; green required checks are enough. A person's
   * requested changes still block it, and a change to a workflow file still needs a person to merge.
   * Only people who administer the repository change it, and every change is audited. Default false.
   */
  agentAutoMergeWithoutApproval?: boolean;
  /**
   * With `allowAgentAutoMerge`: Diffinery turns auto-merge on by itself, as the agent, for pull requests
   * these agents open into matching branches (repo/auto-merge.ts applyRule), so no one has to at merge
   * time. Everything an agent's own auto-merge needs still applies. Stored by account id; the API also
   * takes logins. Only people who administer the repository change it, and every change is audited.
   */
  autoMergeAgents?: AutoMergeAgent[];
  /** How what `autoMergeAgents` turns on merges. Default: the merge queue's method, else squash with linear history, else a merge commit. */
  autoMergeMethod?: "merge" | "squash" | "rebase";
  /** Pull requests merge through a merge queue (like GitHub's "Require merge queue"). */
  mergeQueue?: MergeQueueSettings;
}

/** An agent account whose pull requests a branch rule auto-merges. */
export type AutoMergeAgent = { id: string; login: string };

/** Branch protection as the API and the settings form send it: `autoMergeAgents` may name agents by login. */
export type ProtectionRulesInput = Omit<ProtectionRules, "autoMergeAgents"> & { autoMergeAgents?: Array<string | AutoMergeAgent> };

export interface MergeQueueSettings {
  /** How each queued pull request is merged. Default "merge". */
  method?: "merge" | "squash" | "rebase";
  /** How many queued pull requests are built and checked at once. Default 5. */
  buildConcurrency?: number;
  /** Minutes to wait for required checks on a merge group before removing it. Default 60. */
  checkTimeoutMinutes?: number;
}

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
