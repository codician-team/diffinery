import type { AppContext } from "../auth/principal.js";
import type { Account, Repo, TokenScope } from "../lib/directory.js";
import { repoStub } from "../http/common.js";
import { atLeast, type Role } from "../repo/types.js";
import type { PackageRow } from "./store.js";

/**
 * Who may do what with a container package. Mirrors ghcr.io:
 *
 * - A package linked to a repository shares its permissions: readers pull, writers push,
 *   admins delete. The owner (the user, or the organization's owners and admins) always
 *   administers its packages. Organization members can create packages and pull the
 *   organization's unlinked packages; an unlinked package is administered by whoever created it.
 * - Packages are private unless made public.
 * - A workflow's GITHUB_TOKEN follows the job's `packages` permission. It pulls packages
 *   of its own owner, pushes to its repository's packages (creating them, linked to the
 *   repository, on first push) and deletes their versions. Packages that aren't linked to
 *   its repository are read-only to it.
 * - Personal tokens are capped by their scopes (read pulls, write pushes, admin deletes)
 *   and by their repository list.
 */
export type PackageRole = "none" | "pull" | "push" | "admin";

const RANK: Record<PackageRole, number> = { none: 0, pull: 1, push: 2, admin: 3 };
export const allows = (role: PackageRole, need: PackageRole) => RANK[role] >= RANK[need];
const max = (a: PackageRole, b: PackageRole): PackageRole => (RANK[a] >= RANK[b] ? a : b);
const min = (a: PackageRole, b: PackageRole): PackageRole => (RANK[a] <= RANK[b] ? a : b);

const fromRepoRole = (r: Role | null): PackageRole => (!r ? "none" : r === "admin" ? "admin" : atLeast(r, "write") ? "push" : "pull");
const SCOPE_CAP: Record<TokenScope, PackageRole> = { read: "pull", write: "push", admin: "admin" };

export interface PackageAccess {
  role: PackageRole;
  /** Repository a new package gets linked to when this caller creates it. */
  linkRepo: Repo | null;
  /** Who is acting, for audit and the "pushed by" column. */
  actor: { id: string; login: string } | null;
  /** Why a push or delete would be refused, for the error message. */
  hint?: string;
}

export async function packageAccess(c: AppContext, owner: Account, name: string, pkg: PackageRow | null): Promise<PackageAccess> {
  const p = c.get("principal");
  const dir = c.get("dir");

  // A suspended person's packages are hidden like their repositories (lib/moderation.ts).
  if (owner.suspended_at && !(p.type === "account" && p.account.site_admin)) return { role: "none", linkRepo: null, actor: null };

  if (p.type === "anonymous") return { role: pkg?.visibility === "public" ? "pull" : "none", linkRepo: null, actor: null };
  // Apps aren't offered the packages permission: they pull public packages, like anyone.
  if (p.type === "app" || p.type === "installation") return { role: pkg?.visibility === "public" ? "pull" : "none", linkRepo: null, actor: null, hint: "apps can't use the package registry" };

  if (p.type === "repo-token") {
    const repo = await dir.repoById(p.repoId);
    if (!repo) return { role: "none", linkRepo: null, actor: null };
    const stub = repoStub(c.env, repo.id);
    const auth = await stub.runnerAuth(p.token);
    if (!auth) return { role: "none", linkRepo: null, actor: null, hint: "the job token is no longer valid" };
    let perm: "none" | "read" | "write";
    let actor: PackageAccess["actor"];
    if (auth.kind === "job") {
      perm = await stub.packagesPermission(p.token);
      actor = { id: `job:${auth.jobId}`, login: "diffinery-actions[bot]" };
    } else {
      perm = atLeast(auth.caller.role, "write") ? "write" : "read";
      actor = { id: auth.caller.id, login: auth.caller.login };
    }
    const sameOwner = repo.owner_id === owner.id;
    let role: PackageRole = "none";
    let hint: string | undefined;
    if (pkg) {
      const linked = pkg.repo_id === repo.id;
      // A package linked to another repository follows that repository's access, which a job token
      // doesn't have: like ghcr.io, only that repository's workflows use it (unless it is public).
      if (perm !== "none" && (linked || (sameOwner && !pkg.repo_id) || pkg.visibility === "public")) role = "pull";
      if (perm === "write" && linked) role = "admin";
      else if (pkg.repo_id && !linked) hint = `${owner.login}/${pkg.name} belongs to the ${owner.login}/${pkg.repo_name ?? "?"} repository, so only its workflows can use it`;
      else if (!pkg.repo_id) hint = `${owner.login}/${pkg.name} isn't linked to a repository; link it to ${repo.owner_login}/${repo.name} in its settings so this workflow can push to it`;
    } else if (perm === "write" && sameOwner) {
      // A new name that is another repository's (diffinery.com/<owner>/<repo>[/...]) is left for that repository.
      const named = await dir.repo(owner.login, name.split("/")[0]!);
      if (named && named.id !== repo.id) hint = `${owner.login}/${name} is named after the ${owner.login}/${named.name} repository, so only its workflows can create it`;
      else role = "push";
    } else if (!sameOwner) hint = `workflows in ${repo.owner_login}/${repo.name} can only create packages under ${repo.owner_login}`;
    if (perm === "none") hint = "the workflow's GITHUB_TOKEN has no packages permission; add `permissions: packages: write`";
    else if (perm === "read" && !hint) hint = "the workflow's GITHUB_TOKEN has packages: read; add `permissions: packages: write` to push";
    return { role, linkRepo: repo, actor, hint };
  }

  const a = p.account;
  if (a.status !== "active") return { role: "none", linkRepo: null, actor: null };
  const actor = { id: a.id, login: a.login };
  const subject = a.kind === "agent" ? a.owner_id : a.id;

  // The owner administers its packages. Organization members create packages and pull the
  // organization's unlinked ones; an unlinked package is administered by whoever created it (like ghcr.io,
  // membership alone doesn't let one member push to another's package).
  let role: PackageRole = "none";
  if (a.site_admin) role = "admin";
  else if (owner.kind === "user" && subject === owner.id) role = a.kind === "agent" ? "push" : "admin";
  else if (owner.kind === "org") {
    if (a.kind === "agent" && a.owner_id === owner.id) role = "push";
    else if (subject) {
      const r = await dir.orgRole(owner.id, subject);
      if (r === "owner" || r === "admin") role = a.kind === "agent" ? "push" : "admin";
      else if (r === "member") {
        // The creator, or the member whose agent created it.
        let creator = !!pkg?.created_by && (pkg.created_by === a.id || pkg.created_by === subject);
        if (pkg?.created_by && !pkg.repo_id && !creator) creator = (await dir.account(pkg.created_by))?.owner_id === subject;
        // A package linked to a repository follows that repository's access alone (below), so
        // a member without access to a private repository can't pull its images either.
        role = !pkg ? "push" : pkg.repo_id ? "none" : creator ? (a.kind === "agent" ? "push" : "admin") : "pull";
      }
    }
  }

  let linkRepo: Repo | null = null;
  if (pkg?.repo_id) {
    const repo = await dir.repoById(pkg.repo_id);
    if (repo) role = max(role, fromRepoRole(await dir.roleFor(a, repo)));
  } else if (!pkg) {
    // diffinery.com/<owner>/<repo>[/...] is linked to that repository when the pusher can write to it,
    // and is that repository's name: someone who can't write to it can't take the name first.
    const repo = await dir.repo(owner.login, name.split("/")[0]!);
    if (repo) {
      const r = fromRepoRole(await dir.roleFor(a, repo));
      if (allows(r, "push")) {
        linkRepo = repo;
        role = max(role, r);
      } else if (!a.site_admin) {
        return { role: "none", linkRepo: null, actor, hint: `${owner.login}/${name} is named after the ${owner.login}/${repo.name} repository; only people who can write to it can create it` };
      }
    }
  }
  if (pkg?.visibility === "public") role = max(role, "pull");

  if (p.via === "token") {
    if (p.repoIds) {
      const rid = pkg ? pkg.repo_id : linkRepo?.id;
      if (!rid || !p.repoIds.includes(rid)) role = pkg?.visibility === "public" ? "pull" : "none";
    }
    const cap = p.scopes.reduce<PackageRole>((best, s) => max(best, SCOPE_CAP[s]), "none");
    role = min(role, cap);
  }
  let hint: string | undefined;
  if (p.via === "token" && !p.scopes.some((s) => s !== "read")) hint = "this token only has the read scope";
  return { role, linkRepo, actor, hint };
}
