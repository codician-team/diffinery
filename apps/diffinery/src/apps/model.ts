import { PERMISSION_SCOPES, type JobPermissions, type PermissionScope } from "../lib/job-permissions.js";

/**
 * What a GitHub-compatible app may ask for: repository permissions under GitHub's names, and the
 * webhook events it may subscribe to, each needing one of those permissions (as GitHub requires).
 * Installation tokens are checked per endpoint by the same table as a workflow's GITHUB_TOKEN
 * (lib/job-permissions.ts), so an app gets exactly what its permissions say there.
 *
 * Not offered: administration, secrets, variables, webhooks, members, workflows. An app can never
 * change a repository's settings or its workflow files, whatever it asks for.
 */

export type Access = "read" | "write";

export const APP_PERMISSIONS = {
  metadata: { label: "Metadata", description: "Read the repository's name, description and settings that everyone with access sees. Every app has it.", scope: null, levels: ["read"] },
  contents: { label: "Contents", description: "Code, commits, branches, tags and releases. Write pushes commits and merges pull requests.", scope: "contents", levels: ["read", "write"] },
  pull_requests: { label: "Pull requests", description: "Pull requests, reviews and their comments.", scope: "pull-requests", levels: ["read", "write"] },
  issues: { label: "Issues", description: "Issues, labels, milestones and comments.", scope: "issues", levels: ["read", "write"] },
  checks: { label: "Checks", description: "Check runs on commits. Write reports results on pull requests.", scope: "checks", levels: ["read", "write"] },
  statuses: { label: "Commit statuses", description: "Commit statuses. Write reports results on pull requests.", scope: "statuses", levels: ["read", "write"] },
  deployments: { label: "Deployments", description: "Deployments and their statuses.", scope: "deployments", levels: ["read", "write"] },
  actions: { label: "Actions", description: "Workflows, runs, jobs, logs and artifacts. Write re-runs and cancels runs.", scope: "actions", levels: ["read", "write"] },
} as const satisfies Record<string, { label: string; description: string; scope: PermissionScope | null; levels: readonly Access[] }>;

export type AppPermission = keyof typeof APP_PERMISSIONS;
export type AppPermissions = Partial<Record<AppPermission, Access>>;
export const APP_PERMISSION_NAMES = Object.keys(APP_PERMISSIONS) as AppPermission[];

/**
 * The events an app may subscribe to, and the permission each needs (any one of them, at read).
 * `installation` and `installation_repositories` always go to every app with a webhook.
 */
export const APP_EVENTS: Record<string, { label: string; needs: AppPermission[] }> = {
  push: { label: "Push", needs: ["contents"] },
  pull_request: { label: "Pull request", needs: ["pull_requests"] },
  pull_request_review: { label: "Pull request review", needs: ["pull_requests"] },
  issues: { label: "Issues", needs: ["issues"] },
  issue_comment: { label: "Issue comment", needs: ["issues", "pull_requests"] },
  release: { label: "Release", needs: ["contents"] },
  status: { label: "Status", needs: ["statuses"] },
  deployment: { label: "Deployment", needs: ["deployments"] },
  deployment_status: { label: "Deployment status", needs: ["deployments"] },
  deployment_review: { label: "Deployment review", needs: ["deployments"] },
  workflow_run: { label: "Workflow run", needs: ["actions"] },
  workflow_dispatch: { label: "Workflow dispatch", needs: ["contents"] },
  repository_dispatch: { label: "Repository dispatch", needs: ["contents"] },
};
export const APP_EVENT_NAMES = Object.keys(APP_EVENTS);
/** Sent to every app with a webhook, whatever it subscribed to. */
export const INSTALLATION_EVENTS = ["installation", "installation_repositories"] as const;

export class AppInputError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/** Permissions as sent (GitHub's names and levels); metadata is always read. Unknown names or levels are refused. */
export function parsePermissions(input: unknown): AppPermissions {
  if (input === undefined || input === null) return { metadata: "read" };
  if (typeof input !== "object" || Array.isArray(input)) throw new AppInputError("default_permissions must be an object of permission names to read or write", "default_permissions");
  const out: AppPermissions = {};
  for (const [name, level] of Object.entries(input as Record<string, unknown>)) {
    if (!Object.hasOwn(APP_PERMISSIONS, name)) throw new AppInputError(`unknown or unsupported permission '${name}'; apps can ask for: ${APP_PERMISSION_NAMES.join(", ")}`, "default_permissions");
    if (level === "none" || level === null || level === undefined) continue;
    const p = APP_PERMISSIONS[name as AppPermission];
    if (!(p.levels as readonly string[]).includes(level as string)) throw new AppInputError(`permission '${name}' must be ${p.levels.join(" or ")}`, "default_permissions");
    out[name as AppPermission] = level as Access;
  }
  out.metadata = "read";
  return out;
}

/** Events as sent; each must be one apps can subscribe to and covered by the permissions. */
export function parseEvents(input: unknown, permissions: AppPermissions): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((e) => typeof e !== "string")) throw new AppInputError("default_events must be a list of event names", "default_events");
  const events = [...new Set(input as string[])];
  for (const e of events) {
    const ev = APP_EVENTS[e];
    if (!ev) throw new AppInputError(`unknown or unsupported event '${e}'; apps can subscribe to: ${APP_EVENT_NAMES.join(", ")}`, "default_events");
    if (!eventAllowed(e, permissions)) throw new AppInputError(`event '${e}' needs the ${ev.needs.join(" or ")} permission`, "default_events");
  }
  return events.sort();
}

/** Whether permissions cover an event (installation events always). */
export function eventAllowed(event: string, permissions: AppPermissions): boolean {
  if ((INSTALLATION_EVENTS as readonly string[]).includes(event)) return true;
  const ev = APP_EVENTS[event];
  return !!ev && ev.needs.some((p) => !!permissions[p]);
}

const LEVEL: Record<Access, number> = { read: 1, write: 2 };

/**
 * The permissions an installation token asks for, which must be within the installation's. Missing
 * means all of them. GitHub's answer when one isn't granted.
 */
export function narrowPermissions(granted: AppPermissions, requested: unknown): AppPermissions {
  if (requested === undefined || requested === null) return { ...granted };
  const want = parsePermissions(requested);
  for (const [name, level] of Object.entries(want) as Array<[AppPermission, Access]>) {
    const have = granted[name];
    if (!have || LEVEL[have] < LEVEL[level]) throw new AppInputError("The permissions requested are not granted to this installation.", "permissions");
  }
  return want;
}

/**
 * What both grant: an installation keeps what its admins accepted, and an app that since asked for
 * less gets less at once (only more waits for the admins).
 */
export function intersectPermissions(a: AppPermissions, b: AppPermissions): AppPermissions {
  const out: AppPermissions = {};
  for (const [name, level] of Object.entries(a) as Array<[AppPermission, Access]>) {
    const other = b[name];
    if (other) out[name] = LEVEL[level] <= LEVEL[other] ? level : other;
  }
  out.metadata = "read";
  return out;
}

/** An app's permissions as the per-endpoint table that installation tokens are checked against. */
export function toJobPermissions(p: AppPermissions): JobPermissions {
  const out = Object.fromEntries(PERMISSION_SCOPES.map((s) => [s, "none"])) as JobPermissions;
  for (const [name, level] of Object.entries(p) as Array<[AppPermission, Access]>) {
    const scope = APP_PERMISSIONS[name]?.scope;
    if (scope) out[scope] = level;
  }
  return out;
}

/** Whether `next` asks for more than `prev` (a new permission or a higher level): installations keep `prev` until an admin accepts. */
export function widens(prev: AppPermissions, next: AppPermissions): boolean {
  return (Object.entries(next) as Array<[AppPermission, Access]>).some(([name, level]) => !prev[name] || LEVEL[prev[name]!] < LEVEL[level]);
}

/** A URL-safe slug from an app's name, as GitHub makes them: lower case, runs of other characters to one dash. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const MAX_APP_NAME = 34;
export const isValidAppName = (name: unknown): name is string => typeof name === "string" && name.trim().length > 0 && name.trim().length <= MAX_APP_NAME && slugify(name).length > 0 && !/[\u0000-\u001f<>]/.test(name);
