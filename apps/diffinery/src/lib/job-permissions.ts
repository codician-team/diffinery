import type { Permissions, Workflow } from "@diffinery/workflow-yaml";
import { atLeast, type Role } from "../repo/types.js";

/**
 * GitHub's permission model for a job's GITHUB_TOKEN: the effective
 * `permissions:` of each job, and which permission each API request needs.
 * https://docs.github.com/actions/reference/workflow-syntax-for-github-actions#permissions
 */

export const PERMISSION_SCOPES = [
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];
export type Access = "none" | "read" | "write";
export type JobPermissions = Record<PermissionScope, Access>;

const LEVEL: Record<Access, number> = { none: 0, read: 1, write: 2 };
/** Scopes that only take some levels (id-token: write or none; models: read or none). */
const CEILING: Partial<Record<PermissionScope, Access>> = { models: "read" };

const all = (f: (s: PermissionScope) => Access): JobPermissions => Object.fromEntries(PERMISSION_SCOPES.map((s) => [s, f(s)])) as JobPermissions;
const clamp = (s: PermissionScope, a: Access): Access => (CEILING[s] && LEVEL[a] > LEVEL[CEILING[s]!] ? CEILING[s]! : a);

export const WRITE_ALL: JobPermissions = all((s) => clamp(s, "write"));
export const READ_ALL: JobPermissions = all((s) => (s === "id-token" ? "none" : "read"));
/** The repository default when a workflow sets no `permissions:`, set to read and write (GitHub's permissive default). */
export const PERMISSIVE_DEFAULT: JobPermissions = all((s) => (s === "id-token" ? "none" : clamp(s, "write")));
/** The repository default set to read-only (GitHub's restricted default): contents and packages, read. */
export const RESTRICTED_DEFAULT: JobPermissions = all((s) => (s === "contents" || s === "packages" ? "read" : "none"));

/** `permissions:` as written (`read-all`, `write-all`, `{}` or a mapping) to a full table; listed-out scopes get none. */
export function resolvePermissions(p: Permissions): JobPermissions {
  if (p === "write-all") return { ...WRITE_ALL };
  if (p === "read-all") return { ...READ_ALL };
  return all((s) => {
    const v = p[s];
    if (v !== "read" && v !== "write") return "none";
    // id-token has no read level; `id-token: read` grants nothing.
    if (s === "id-token" && v === "read") return "none";
    return clamp(s, v);
  });
}

/** The lower of each scope, for capping a called workflow by its caller. */
export function minPermissions(a: JobPermissions, b: JobPermissions): JobPermissions {
  return all((s) => (LEVEL[a[s]] <= LEVEL[b[s]] ? a[s] : b[s]));
}

/** The parts of an expanded run (repo/reusable.ts) the permission chain needs. */
export interface PermissionTree {
  workflow: Workflow;
  calls: Map<string, { parent: string | null; job: { permissions?: Permissions }; workflow: Workflow }>;
  parentOf: Map<string, string | null>;
}

/**
 * A job's effective token permissions. Job-level `permissions:` replace the
 * workflow's; without either, the repository default applies (read and write,
 * or read-only: the repository's Actions setting).
 * In a reusable workflow, a job without `permissions:` inherits its caller's,
 * and nothing it declares can exceed what the calling job has. Pull requests
 * from another repository (a fork) never get write.
 */
export function permissionsForJob(tree: PermissionTree, key: string, o: { untrusted?: boolean; repoDefault?: "read" | "write" } = {}): JobPermissions {
  const top = o.untrusted ? READ_ALL : WRITE_ALL;
  const base = o.untrusted ? READ_ALL : o.repoDefault === "read" ? RESTRICTED_DEFAULT : PERMISSIVE_DEFAULT;
  const wfOf = (call: string | null) => (call === null ? tree.workflow : tree.calls.get(call)!.workflow);
  // What jobs inside `call` may have at most: the calling job's permissions.
  const cap = (call: string | null): JobPermissions => (call === null ? top : callerJob(call));
  // A workflow's own level: its `permissions:`, or what it inherits.
  const level = (call: string | null): JobPermissions => {
    const declared = wfOf(call).permissions;
    if (declared !== undefined) return minPermissions(resolvePermissions(declared), cap(call));
    return call === null ? base : callerJob(call);
  };
  const callerJob = (call: string): JobPermissions => {
    const site = tree.calls.get(call)!;
    return site.job.permissions !== undefined ? minPermissions(resolvePermissions(site.job.permissions), cap(site.parent)) : level(site.parent);
  };
  const parent = tree.parentOf.get(key) ?? null;
  const declared = tree.workflow.jobs[key]?.permissions;
  return declared !== undefined ? minPermissions(resolvePermissions(declared), cap(parent)) : level(parent);
}

/**
 * The repository-level role the token gets; requests are further limited per
 * scope by {@link requestPermission}. A job token never administers or
 * maintains the repository, so branch protection always applies to it.
 */
export function roleForPermissions(p: JobPermissions): Role {
  return PERMISSION_SCOPES.some((s) => s !== "id-token" && p[s] === "write") ? "write" : "read";
}

export type Requirement = { scopes: PermissionScope[]; access: Exclude<Access, "none"> } | { metadata: true } | { forbidden: string };

const ADMIN_ONLY = new Set(["hooks", "collaborators", "keys", "invitations", "settings", "rulesets", "teams", "transfer", "autolinks", "vulnerability-alerts"]);
const BY_SEGMENT: Record<string, PermissionScope[]> = {
  issues: ["issues", "pull-requests"],
  labels: ["issues", "pull-requests"],
  milestones: ["issues", "pull-requests"],
  assignees: ["issues", "pull-requests"],
  pulls: ["pull-requests"],
  pull: ["pull-requests"],
  statuses: ["statuses"],
  "check-runs": ["checks"],
  "check-suites": ["checks"],
  deployments: ["deployments"],
  environments: ["deployments"],
  actions: ["actions"],
  pages: ["pages"],
  discussions: ["discussions"],
  "code-scanning": ["security-events"],
  "secret-scanning": ["security-events"],
  dependabot: ["security-events"],
  packages: ["packages"],
  projects: ["repository-projects"],
  attestations: ["attestations"],
};
const CONTENTS = new Set(["contents", "commits", "commit", "compare", "git", "branches", "tags", "releases", "merges", "tarball", "zipball", "readme", "dispatches", "comments", "edit", "new", "merge-upstream", "languages", "contributors", "stats", "archive", "blob", "tree", "raw", "info", "git-upload-pack", "git-receive-pack"]);

/**
 * The permission a job token needs for a request. `min` is the role the route
 * itself asks for: git fetches and LFS downloads are POSTs that only read.
 */
export function requestPermission(method: string, path: string, min: Role): Requirement {
  const readOnlyPost = /\/git-upload-pack$|\/info\/lfs\/objects\/batch$/.test(path);
  const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const access = atLeast(min, "triage") || (!safe && !readOnlyPost) ? "write" : "read";
  // uploads.github.com is served at /api/uploads (release assets).
  const api = /^\/api\/(?:v3|uploads)\/repos\/[^/]+\/[^/]+(?:\/(.*))?$/.exec(path);
  // Web and git paths are /<owner>/<repo>[.git]/...
  const web = api ? null : /^\/[^/]+\/[^/]+(?:\/(.*))?$/.exec(path);
  const rest = api ? (api[1] ?? "") : web ? (web[1] ?? "") : undefined;
  if (rest === undefined) return { forbidden: "this endpoint is not available to a workflow's GITHUB_TOKEN" };
  const segs = rest.split("/").filter(Boolean);
  const first = segs[0] ?? "";
  // The repository itself: metadata through the API; its code page on the web.
  if (!first && !api && access === "read") return { scopes: ["contents"], access };
  if (!first) return access === "read" ? { metadata: true } : { forbidden: "the repository's settings cannot be changed with a workflow's GITHUB_TOKEN" };
  const adminOnly =
    ADMIN_ONLY.has(first) ||
    (first === "actions" && /^(secrets|variables|runners|permissions|oidc)$/.test(segs[1] ?? "")) ||
    (first === "environments" && (access === "write" || /^(secrets|variables)$/.test(segs[2] ?? ""))) ||
    (first === "branches" && segs.slice(2).includes("protection"));
  if (adminOnly) return { forbidden: "this endpoint is not available to a workflow's GITHUB_TOKEN" };
  if (first === "issues" && segs.length === 1) return { scopes: ["issues"], access };
  // Merging, auto-merge (which merges later) and updating the branch write code, as on GitHub.
  if (first === "pulls" && /^(merge|update-branch|auto-merge)$/.test(segs[2] ?? "")) return { scopes: ["contents"], access };
  if (first === "commits" && /^(statuses|status)$/.test(segs[2] ?? "")) return { scopes: ["statuses"], access };
  if (first === "commits" && /^(check-runs|check-suites)$/.test(segs[2] ?? "")) return { scopes: ["checks"], access };
  if (BY_SEGMENT[first]) return { scopes: BY_SEGMENT[first]!, access };
  if (CONTENTS.has(first) || first.endsWith(".git")) return { scopes: ["contents"], access };
  return access === "read" ? { metadata: true } : { forbidden: "this endpoint is not available to a workflow's GITHUB_TOKEN" };
}

/** A request that only reads: anyone may make it on a public repository, whatever the token's permissions. */
export function readOnly(req: Requirement): boolean {
  return "metadata" in req || ("scopes" in req && req.access === "read");
}

/**
 * Throws-free check: null when allowed, else the reason for a 403. `who` is whose token it is: a
 * workflow job's, or an app's installation token (apps/), which names permissions as GitHub Apps do.
 */
export function denied(p: JobPermissions, req: Requirement, who: "job" | "app" = "job"): string | null {
  if ("metadata" in req) return null;
  if ("forbidden" in req) return who === "app" ? "Resource not accessible by integration (apps can't use this endpoint)" : req.forbidden;
  if (req.scopes.some((s) => LEVEL[p[s]] >= LEVEL[req.access])) return null;
  if (who === "app") return `Resource not accessible by integration (the app needs the ${req.scopes.map((s) => s.replace("-", "_")).join(" or ")} permission: ${req.access})`;
  return `Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: ${req.scopes.join(" or ")}: ${req.access})`;
}
