import type { Comment, Issue } from "./collab.js";
import type { RepoMeta } from "./types.js";
import { nodeId, numericId } from "../http/gh.js";

/**
 * Webhook-style event payloads (what a job reads from GITHUB_EVENT_PATH and
 * `github.event`), shaped like GitHub's so actions and scripts that read
 * `context.payload` work unmodified: `repository`, `sender` and `organization`
 * objects with their URLs, full `pull_request` objects (with `head.repo` and
 * `base.repo`), and `issue`, `comment` and `release` objects. Triggers fill in
 * what they know; `completePayload` adds the rest when the run is created.
 */

export type PayloadSite = { publicUrl: string; meta: RepoMeta; visibility?: "public" | "private" };
type Who = { id?: string; login: string; kind?: string };

const api = (s: PayloadSite) => `${s.publicUrl}/api/v3`;

/** A user object (`sender`, `user`, `owner`). Agents and the system appear as bots. */
export function userPayload(s: PayloadSite, who: Who): Record<string, unknown> {
  const bot = who.kind === "agent" || who.kind === "system" || who.login.endsWith("[bot]");
  return {
    login: who.login,
    // Numeric like GitHub's and the REST API's (ghUser), from the account id when it's known.
    id: numericId(who.id ?? who.login),
    node_id: nodeId(bot ? "Bot" : "User", who.id ?? who.login),
    type: bot ? "Bot" : "User",
    site_admin: false,
    avatar_url: `${s.publicUrl}/${encodeURIComponent(who.login)}.png`,
    html_url: `${s.publicUrl}/${encodeURIComponent(who.login)}`,
    url: `${api(s)}/users/${encodeURIComponent(who.login)}`,
  };
}

export function organizationPayload(s: PayloadSite): Record<string, unknown> | undefined {
  const m = s.meta;
  if (m.ownerKind !== "org") return undefined;
  return { login: m.owner, id: numericId(m.ownerId), node_id: nodeId("Organization", m.ownerId), url: `${api(s)}/orgs/${m.owner}`, repos_url: `${api(s)}/orgs/${m.owner}/repos`, avatar_url: `${s.publicUrl}/${m.owner}.png`, description: null };
}

export function repositoryPayload(s: PayloadSite): Record<string, unknown> {
  const m = s.meta;
  const full = `${m.owner}/${m.name}`;
  const url = `${api(s)}/repos/${full}`;
  const html = `${s.publicUrl}/${full}`;
  const host = new URL(s.publicUrl).host;
  return {
    id: numericId(m.repoId),
    node_id: nodeId("Repository", m.repoId),
    name: m.name,
    full_name: full,
    private: s.visibility !== "public",
    visibility: s.visibility ?? "private",
    owner: { ...userPayload(s, { id: m.ownerId, login: m.owner }), type: m.ownerKind === "org" ? "Organization" : "User", name: m.owner },
    html_url: html,
    description: null,
    fork: false,
    url,
    archive_url: `${url}/{archive_format}{/ref}`,
    branches_url: `${url}/branches{/branch}`,
    commits_url: `${url}/commits{/sha}`,
    contents_url: `${url}/contents/{+path}`,
    issues_url: `${url}/issues{/number}`,
    pulls_url: `${url}/pulls{/number}`,
    labels_url: `${url}/labels{/name}`,
    releases_url: `${url}/releases{/id}`,
    statuses_url: `${url}/statuses/{sha}`,
    git_url: `git://${host}/${full}.git`,
    ssh_url: `git@${host}:${full}.git`,
    clone_url: `${html}.git`,
    svn_url: html,
    homepage: null,
    default_branch: m.defaultBranch,
    master_branch: m.defaultBranch,
    archived: false,
    disabled: false,
    is_template: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    allow_forking: false,
    topics: [],
    license: null,
  };
}

/** `issue` of the issues and issue_comment events (a pull request carries `pull_request` links, like GitHub). */
export function issuePayload(s: PayloadSite, i: Issue): Record<string, unknown> {
  const full = `${s.meta.owner}/${s.meta.name}`;
  const url = `${api(s)}/repos/${full}/issues/${i.number}`;
  return {
    id: i.number,
    node_id: `${s.meta.repoId}:${i.number}`,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    state_reason: i.stateReason,
    locked: false,
    user: userPayload(s, i.author),
    labels: i.labels.map((name) => ({ name, url: `${api(s)}/repos/${full}/labels/${encodeURIComponent(name)}` })),
    assignee: i.assignees[0] ? userPayload(s, { login: i.assignees[0] }) : null,
    assignees: i.assignees.map((login) => userPayload(s, { login })),
    comments: i.comments,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    closed_at: i.closedAt,
    author_association: "MEMBER",
    url,
    repository_url: `${api(s)}/repos/${full}`,
    comments_url: `${url}/comments`,
    html_url: `${s.publicUrl}/${full}/${i.kind === "pull" ? "pull" : "issues"}/${i.number}`,
    ...(i.kind === "pull" ? { pull_request: { url: `${api(s)}/repos/${full}/pulls/${i.number}`, html_url: `${s.publicUrl}/${full}/pull/${i.number}`, merged_at: i.pull?.mergedAt ?? null } } : {}),
  };
}

export function commentPayload(s: PayloadSite, issueNumber: number, c: Comment): Record<string, unknown> {
  const full = `${s.meta.owner}/${s.meta.name}`;
  return {
    id: c.id,
    node_id: c.id,
    body: c.body,
    user: userPayload(s, c.author),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: "MEMBER",
    url: `${api(s)}/repos/${full}/issues/comments/${c.id}`,
    html_url: `${s.publicUrl}/${full}/issues/${issueNumber}#issuecomment-${c.id}`,
    issue_url: `${api(s)}/repos/${full}/issues/${issueNumber}`,
  };
}

export type ReleaseFacts = {
  id: string | number;
  tagName: string;
  targetCommitish: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
  author: Who;
};

export function releasePayload(s: PayloadSite, r: ReleaseFacts): Record<string, unknown> {
  const full = `${s.meta.owner}/${s.meta.name}`;
  const url = `${api(s)}/repos/${full}/releases/${r.id}`;
  return {
    id: r.id,
    node_id: String(r.id),
    tag_name: r.tagName,
    target_commitish: r.targetCommitish,
    name: r.name,
    body: r.body,
    draft: r.draft,
    prerelease: r.prerelease,
    created_at: r.createdAt,
    published_at: r.publishedAt,
    author: userPayload(s, r.author),
    assets: [],
    url,
    assets_url: `${url}/assets`,
    upload_url: `${url}/assets{?name,label}`,
    html_url: `${s.publicUrl}/${full}/releases/tag/${encodeURIComponent(r.tagName)}`,
    tarball_url: `${api(s)}/repos/${full}/tarball/${encodeURIComponent(r.tagName)}`,
    zipball_url: `${api(s)}/repos/${full}/zipball/${encodeURIComponent(r.tagName)}`,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `pull_request` filled out to GitHub's shape around what the trigger set. */
function completePull(s: PayloadSite, pr: Record<string, unknown>, sender: Who): Record<string, unknown> {
  const full = `${s.meta.owner}/${s.meta.name}`;
  const n = pr.number as number;
  const url = `${api(s)}/repos/${full}/pulls/${n}`;
  const side = (v: unknown) => {
    const b = isObj(v) ? v : {};
    const ref = typeof b.ref === "string" ? b.ref : "";
    return { label: `${s.meta.owner}:${ref}`, ref, sha: b.sha ?? null, user: userPayload(s, { id: s.meta.ownerId, login: s.meta.owner }), ...b, repo: repositoryPayload(s) };
  };
  const user = isObj(pr.user) && typeof pr.user.login === "string" ? userPayload(s, { login: pr.user.login }) : userPayload(s, sender);
  return {
    id: n,
    node_id: `${s.meta.repoId}:${n}`,
    state: "open",
    locked: false,
    merged: false,
    draft: false,
    labels: [],
    assignees: [],
    requested_reviewers: [],
    author_association: "MEMBER",
    url,
    html_url: `${s.publicUrl}/${full}/pull/${n}`,
    diff_url: `${s.publicUrl}/${full}/pull/${n}.diff`,
    patch_url: `${s.publicUrl}/${full}/pull/${n}.patch`,
    issue_url: `${api(s)}/repos/${full}/issues/${n}`,
    commits_url: `${url}/commits`,
    review_comments_url: `${url}/comments`,
    comments_url: `${api(s)}/repos/${full}/issues/${n}/comments`,
    ...pr,
    user,
    head: side(pr.head),
    base: side(pr.base),
  };
}

/**
 * Adds GitHub's common fields to a trigger's payload: full `repository`,
 * `sender` and (for organisation-owned repositories) `organization`, plus a
 * complete `pull_request`. Fields the trigger set are kept.
 */
export function completePayload(s: PayloadSite, payload: Record<string, unknown>, sender: Who): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  // A trigger's own repository object (the directory's, with its real visibility) wins over the generic one.
  out.repository = { ...repositoryPayload(s), ...(isObj(payload.repository) ? payload.repository : {}) };
  const senderLogin = isObj(payload.sender) && typeof payload.sender.login === "string" ? payload.sender.login : sender.login;
  out.sender = userPayload(s, senderLogin === sender.login ? sender : { login: senderLogin });
  const org = organizationPayload(s);
  if (org) out.organization = org;
  if (isObj(payload.pull_request)) out.pull_request = completePull(s, payload.pull_request, sender);
  if (isObj(payload.pusher) && typeof payload.pusher.name === "string") out.pusher = { email: null, ...payload.pusher };
  return out;
}
