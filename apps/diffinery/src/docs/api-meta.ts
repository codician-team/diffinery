/**
 * Hand-written notes for the generated REST API reference (/docs/api and
 * /docs/api/openapi.json). The list of endpoints itself comes from the live
 * router, so an endpoint can't be missing from the docs: one without an entry
 * here still appears, with a summary derived from its method and path. A unit
 * test fails when an entry here no longer matches a route.
 *
 * Keys are "METHOD /path" with OpenAPI-style {params}, relative to /api/v3.
 */

/** Who may call an endpoint: a repository role, or an account-level requirement. */
export type Access = "public" | "account" | "read" | "triage" | "write" | "maintain" | "admin" | "org-admin" | "org-owner" | "site-admin";

/** [type, description, required?] */
export type Field = [string, string, boolean?];

export interface OpDoc {
  summary: string;
  description?: string;
  access?: Access;
  query?: Record<string, Field>;
  body?: Record<string, Field>;
  /** Success status, when it isn't 200. */
  status?: number;
}

export type Scope = "read" | "write" | "admin";

/**
 * Endpoints whose token requirement differs from the default (GET needs a
 * read token, anything else a write token). These are account-level changes,
 * so a token limited to repositories is refused too, except where noted.
 */
export const ACCOUNT_SCOPES: Record<string, { scope: Scope; anyToken?: boolean; sessionOnly?: boolean }> = {
  "POST /user/orgs": { scope: "admin" },
  "PATCH /orgs/{org}": { scope: "admin" },
  "POST /orgs/{org}/invitations": { scope: "admin" },
  "POST /invitations": { scope: "admin" },
  "DELETE /orgs/{org}": { scope: "admin" },
  "POST /repos/{owner}/{repo}/transfer": { scope: "admin" },
  "GET /orgs/{org}/invitations": { scope: "read" },
  "GET /user/repository_invitations": { scope: "read" },
  "PATCH /user/repository_invitations/{id}": { scope: "write" },
  "DELETE /user/repository_invitations/{id}": { scope: "write" },
  "GET /user/memberships/orgs": { scope: "read" },
  "GET /user/memberships/orgs/{org}": { scope: "read" },
  "PATCH /user/memberships/orgs/{org}": { scope: "write" },
  "GET /user/usage": { scope: "read", anyToken: true },
  "GET /orgs/{org}/usage": { scope: "read", anyToken: true },
  "GET /admin/accounts/{login}/quotas": { scope: "read", anyToken: true },
  "PATCH /admin/accounts/{login}/quotas": { scope: "admin" },
  "GET /admin/repos/{owner}/{repo}/actions-suspension": { scope: "read" },
  "PUT /admin/repos/{owner}/{repo}/actions-suspension": { scope: "admin" },
  "DELETE /admin/repos/{owner}/{repo}/actions-suspension": { scope: "admin" },
  "GET /admin/accounts/{login}/actions-suspension": { scope: "read" },
  "PUT /admin/accounts/{login}/actions-suspension": { scope: "admin" },
  "DELETE /admin/accounts/{login}/actions-suspension": { scope: "admin" },
  "GET /admin/hosted-compute-pause": { scope: "read" },
  "PUT /admin/hosted-compute-pause": { scope: "admin" },
  "DELETE /admin/hosted-compute-pause": { scope: "admin" },
  "DELETE /orgs/{org}/invitations/{id}": { scope: "admin" },
  "GET /invitations": { scope: "read" },
  "DELETE /invitations/{id}": { scope: "admin" },
  "POST /user/repos": { scope: "write" },
  "POST /orgs/{org}/repos": { scope: "write" },
  "GET /orgs/{org}/actions/secrets": { scope: "admin" },
  "PUT /orgs/{org}/actions/secrets/{name}": { scope: "admin" },
  "DELETE /orgs/{org}/actions/secrets/{name}": { scope: "admin" },
  "GET /orgs/{org}/actions/secrets/{name}": { scope: "admin" },
  "GET /orgs/{org}/actions/secrets/{name}/repositories": { scope: "admin" },
  "PUT /orgs/{org}/actions/secrets/{name}/repositories": { scope: "admin" },
  "PUT /orgs/{org}/actions/secrets/{name}/repositories/{repoId}": { scope: "admin" },
  "DELETE /orgs/{org}/actions/secrets/{name}/repositories/{repoId}": { scope: "admin" },
  "POST /diffinery/tokens": { scope: "admin", sessionOnly: true },
  "DELETE /diffinery/tokens/{id}": { scope: "admin" },
  "POST /diffinery/agents": { scope: "admin", sessionOnly: true },
  "PUT /diffinery/model-keys/{provider}": { scope: "admin", sessionOnly: true },
  "DELETE /diffinery/model-keys/{provider}": { scope: "admin", sessionOnly: true },
  "GET /diffinery/model-keys": { scope: "read", anyToken: true },
  "GET /diffinery/model-usage": { scope: "read", anyToken: true },
  "GET /orgs/{org}/diffinery/agent-policy": { scope: "read" },
  "PUT /orgs/{org}/diffinery/agent-policy": { scope: "admin", sessionOnly: true },
  "GET /orgs/{org}/diffinery/model-keys": { scope: "read" },
  "PUT /orgs/{org}/diffinery/model-keys/{provider}": { scope: "admin", sessionOnly: true },
  "DELETE /orgs/{org}/diffinery/model-keys/{provider}": { scope: "admin", sessionOnly: true },
  "GET /orgs/{org}/diffinery/model-usage": { scope: "read" },
  "GET /diffinery/tasks": { scope: "read", anyToken: true },
  "POST /repos/{owner}/{repo}/diffinery/tasks": { scope: "write", sessionOnly: true },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/messages": { scope: "write", sessionOnly: true },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/retry": { scope: "write", sessionOnly: true },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/plan/approve": { scope: "write", sessionOnly: true },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/attempts/{attempt}/pick": { scope: "write", sessionOnly: true },
  "PATCH /repos/{owner}/{repo}/diffinery/tasks/{number}": { scope: "write", sessionOnly: true },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/plan/split": { scope: "write", sessionOnly: true },
  "POST /repos/{owner}/{repo}/diffinery/project/posts": { scope: "write", sessionOnly: true },
  "PUT /repos/{owner}/{repo}/diffinery/project/memory": { scope: "write", sessionOnly: true },
  "PUT /repos/{owner}/{repo}/diffinery/project/settings": { scope: "write", sessionOnly: true },
  "PUT /repos/{owner}/{repo}/diffinery/project/coordinator": { scope: "write", sessionOnly: true },
  "DELETE /repos/{owner}/{repo}/diffinery/project/coordinator": { scope: "write", sessionOnly: true },
  "POST /repos/{owner}/{repo}/diffinery/project/posts/{n}/handle": { scope: "write", sessionOnly: true },
  "PUT /repos/{owner}/{repo}/diffinery/agent-review": { scope: "admin", sessionOnly: true },
  "POST /diffinery/agents/{login}/tokens": { scope: "admin", sessionOnly: true },
  "DELETE /diffinery/agents/{login}": { scope: "admin" },
  "GET /diffinery/auto-merge": { scope: "read" },
  "PUT /diffinery/auto-merge": { scope: "write" },
  "PUT /diffinery/agents/{login}/auto-merge": { scope: "write" },
  "PUT /notifications": { scope: "write" },
  "PUT /diffinery/notification-settings": { scope: "write" },
  "POST /diffinery/emails/test": { scope: "write" },
  "POST /diffinery/emails/digest": { scope: "write" },
  "POST /diffinery/admin/emails/samples": { scope: "admin" },
  "POST /diffinery/email/verification": { scope: "write" },
  "GET /diffinery/admin/email/suppressions": { scope: "read" },
  "PUT /diffinery/admin/email/suppressions/{email}": { scope: "admin" },
  "DELETE /diffinery/admin/email/suppressions/{email}": { scope: "admin" },
  "GET /diffinery/admin/security-reports": { scope: "read" },
  "GET /diffinery/admin/security-reports/{id}": { scope: "read" },
  "PATCH /diffinery/admin/security-reports/{id}": { scope: "admin" },
  "GET /diffinery/admin/early-access": { scope: "read" },
  "GET /diffinery/admin/early-access/{id}": { scope: "read" },
  "POST /diffinery/admin/early-access/{id}/invite": { scope: "admin" },
  "PATCH /diffinery/admin/early-access/{id}": { scope: "admin" },
  "DELETE /diffinery/admin/early-access/{id}": { scope: "admin" },
  "GET /diffinery/admin/status/incidents": { scope: "read" },
  "POST /diffinery/admin/status/incidents": { scope: "admin" },
  "POST /diffinery/admin/status/incidents/{id}/updates": { scope: "admin" },
  "PUT /user/avatar": { scope: "write" },
  "DELETE /user/avatar": { scope: "write" },
  "PUT /orgs/{org}/avatar": { scope: "write" },
  "DELETE /orgs/{org}/avatar": { scope: "write" },
  "POST /orgs/{org}/actions/variables": { scope: "admin" },
  "PATCH /orgs/{org}/actions/variables/{name}": { scope: "admin" },
  "DELETE /orgs/{org}/actions/variables/{name}": { scope: "admin" },
  "POST /diffinery/imports/{id}/cancel": { scope: "write" },
  "POST /diffinery/imports/{id}/retry": { scope: "write" },
  "POST /diffinery/imports/{id}/selection": { scope: "write" },
  "POST /diffinery/user/linked-accounts/github/challenge": { scope: "admin" },
  "POST /diffinery/user/linked-accounts/github": { scope: "admin" },
  "DELETE /diffinery/user/linked-accounts/{id}": { scope: "admin" },
  "DELETE /diffinery/admin/linked-accounts/{id}": { scope: "admin" },
  "GET /user/blocks": { scope: "read" },
  "GET /user/blocks/{username}": { scope: "read" },
  "PUT /user/blocks/{username}": { scope: "write" },
  "DELETE /user/blocks/{username}": { scope: "write" },
  "GET /orgs/{org}/blocks": { scope: "read" },
  "GET /orgs/{org}/blocks/{username}": { scope: "read" },
  "PUT /orgs/{org}/blocks/{username}": { scope: "admin" },
  "DELETE /orgs/{org}/blocks/{username}": { scope: "admin" },
  "POST /diffinery/reports": { scope: "write" },
  "GET /admin/reports": { scope: "read" },
  "GET /admin/reports/{id}": { scope: "read" },
  "PATCH /admin/reports/{id}": { scope: "admin" },
  "PUT /users/{username}/suspended": { scope: "admin" },
  "DELETE /users/{username}/suspended": { scope: "admin" },
};

const page: Record<string, Field> = {
  per_page: ["integer", "Results per page (default 30, at most 100)."],
  page: ["integer", "Page number, starting at 1."],
};

export const API_DOCS: Record<string, OpDoc> = {
  // ------------------------------------------------------------ meta, users and organizations
  "GET /": { summary: "API root", description: "Names the API and links to these docs and the MCP endpoint.", access: "public" },
  "GET /meta": { summary: "Instance metadata", description: "Whether this instance issues OIDC tokens to workflows, and the runner image its last deploy set (`runner_image`; each job reports the image it ran on as `runner.image`), and whether it tells search engines about changed public pages through IndexNow (`indexnow`: `enabled`, `key_location` and the time, URL count, IndexNow status and `endpoint` of the `last_submission`; see [Site administration](/docs/admin/site-administration#search-engines)).", access: "public" },
  "GET /rate_limit": {
    summary: "Get rate limit status",
    description: "For GitHub clients that check their budget before calling. It always reports a full, constant budget (15000 core requests an hour). Diffinery's real limits are per minute (2,000 requests per account, 60 new repositories, issues, pull requests, comments and the like, 300 requests per IP address without signing in) and answer 429 with `retry-after: 60`; see /docs/reference/rest-api#rate-limits.",
    access: "public",
  },
  "GET /user": { summary: "Get the authenticated account", description: "Returns your account, including `email` and `site_admin`. Agents get their own account (type `Bot`).", access: "account" },
  "PUT /user/avatar": {
    summary: "Set your profile picture",
    description:
      "Diffinery only. The raw request body is the image (JPEG, PNG or WebP, at most 5 MB), not JSON. Returns the new `avatar_url`. A token needs `write` or `admin` scope and must not be limited to repositories. Audited.",
    access: "account",
  },
  "DELETE /user/avatar": { summary: "Remove your profile picture", description: "Diffinery only. Goes back to generated initials and returns the `avatar_url`. Same token rules as setting one. Audited.", access: "account" },
  "GET /users/{login}": { summary: "Get an account", description: "A user, organization or agent by login. A suspended person is `404` except to site administrators, who also see `suspended_at` and `suspension_reason`.", access: "account" },
  "GET /user/usage": {
    summary: "Get your quotas and usage",
    description: "Hosted minutes used this month, hosted jobs running, sandboxes open, repositories owned and bytes stored, each with its `limit` (`-1` is unlimited), and `exempt` for accounts run by a site administrator. An agent gets its owner's. See [Limits](/docs/reference/limits#account-quotas).",
    access: "account",
  },
  "GET /orgs/{org}/usage": { summary: "Get an organization's quotas and usage", description: "The same as `GET /user/usage`, for the organization's owners and admins.", access: "org-admin" },
  "GET /admin/accounts/{login}/quotas": { summary: "Get an account's quotas and usage", description: "Site administrators only.", access: "site-admin" },
  "PATCH /admin/accounts/{login}/quotas": {
    summary: "Change an account's quotas",
    description: "Site administrators only. Send only the quotas to change: a whole number, `-1` for unlimited, or `null` for the default. Audited as `account.quotas.set`.",
    access: "site-admin",
    body: {
      hosted_minutes: ["integer", "Hosted minutes per calendar month (UTC)."],
      hosted_jobs: ["integer", "Hosted Actions jobs running at once."],
      sandboxes: ["integer", "Agent sandboxes open at once."],
      repositories: ["integer", "Repositories the account owns."],
      storage_bytes: ["integer", "Bytes stored: git objects, Git LFS objects, release assets and packages, not Actions artifacts or caches."],
    },
  },
  "GET /admin/repos/{owner}/{repo}/actions-suspension": {
    summary: "Get a repository's Actions suspension",
    description: "Site administrators only. `suspended`, `reason`, `suspended_by`, `suspended_at`, and `owner_suspended` when its owner's Actions are suspended.",
    access: "site-admin",
  },
  "PUT /admin/repos/{owner}/{repo}/actions-suspension": {
    summary: "Suspend Actions for a repository",
    description: "Site administrators only. No runs start, queued jobs fail and no sandboxes open; what runs now stops (`stopped`). Audited as `actions.suspend`.",
    access: "site-admin",
    body: { reason: ["string", "Why (up to 500 characters). Shown to the people affected and kept in the audit log.", true] },
  },
  "DELETE /admin/repos/{owner}/{repo}/actions-suspension": { summary: "Lift a repository's Actions suspension", description: "Site administrators only. New work can start again; nothing restarts. Audited as `actions.unsuspend`.", access: "site-admin" },
  "GET /admin/accounts/{login}/actions-suspension": { summary: "Get an account's Actions suspension", description: "Site administrators only. `suspended`, `reason`, `suspended_by` and `suspended_at`.", access: "site-admin" },
  "PUT /admin/accounts/{login}/actions-suspension": {
    summary: "Suspend Actions for an account",
    description: "Site administrators only. As for a repository, for every repository the person or organization owns; their running runs and sandboxes stop now. Audited as `actions.suspend`.",
    access: "site-admin",
    body: { reason: ["string", "Why (up to 500 characters). Shown to the people affected and kept in the audit log.", true] },
  },
  "DELETE /admin/accounts/{login}/actions-suspension": { summary: "Lift an account's Actions suspension", description: "Site administrators only. New work can start again; nothing restarts. Audited as `actions.unsuspend`.", access: "site-admin" },
  "GET /admin/hosted-compute-pause": { summary: "Get the hosted compute pause", description: "Site administrators only. `paused`, `reason`, `paused_by` and `paused_at`.", access: "site-admin" },
  "PUT /admin/hosted-compute-pause": {
    summary: "Pause hosted compute",
    description: "Site administrators only. Hosted jobs fail without starting and sandboxes are refused everywhere; running ones stop now. Self-hosted runners still work. Audited as `compute.pause`.",
    access: "site-admin",
    body: { reason: ["string", "Why (up to 500 characters). Shown to the people affected and kept in the audit log.", true] },
  },
  "DELETE /admin/hosted-compute-pause": { summary: "Resume hosted compute", description: "Site administrators only. New hosted jobs and sandboxes can start again; nothing restarts. Audited as `compute.unpause`.", access: "site-admin" },
  "GET /user/orgs": { summary: "List your organizations", description: "Each organization carries your `role` in it (member, admin or owner).", access: "account" },
  "GET /user/repository_invitations": { summary: "List your repository invitations", description: "Pending invitations to repositories, sent to your username or your email address.", access: "account" },
  "PATCH /user/repository_invitations/{id}": { summary: "Accept a repository invitation", description: "You get the role it offers. Audited as `invite.accept`.", access: "account", status: 204 },
  "DELETE /user/repository_invitations/{id}": { summary: "Decline a repository invitation", description: "The invitation is deleted; nobody is told. Audited as `invite.decline`.", access: "account", status: 204 },
  "GET /user/memberships/orgs": { summary: "List your organization memberships", description: "Active memberships and pending invitations, each with `state` (`active` or `pending`), `role` (GitHub's `admin` or `member`) and `diffinery_role` (`owner`, `admin` or `member`).", access: "account", query: { state: ["string", "`active` or `pending`."] } },
  "GET /user/memberships/orgs/{org}": { summary: "Get your organization membership", description: "404 when you are neither a member nor invited.", access: "account" },
  "PATCH /user/memberships/orgs/{org}": { summary: "Accept an organization invitation", description: "Send `{\"state\": \"active\"}` to join with the role the invitation offers. Audited as `invite.accept`.", access: "account", body: { state: ["string", "`active`.", true] } },
  "POST /user/orgs": {
    summary: "Create an organization",
    access: "account",
    status: 201,
    body: { login: ["string", "Organization login (letters, digits, `-` and `_`; no dots).", true], name: ["string", "Display name (default: the login)."] },
  },
  "GET /orgs/{org}": {
    summary: "Get an organization",
    description: "GitHub's organization object. Members, the organization's agents, agents of members, and site admins also get `default_repository_permission`, the organization's base permission (`none`, `read`, `write` or `admin`).",
    access: "account",
  },
  "PATCH /orgs/{org}": {
    summary: "Update an organization",
    description:
      "Organization owners (and site admins) only; admins and members get 403. Returns the updated organization. Every field is checked before anything is saved, so a bad value (422) changes nothing. Changing the base permission applies to every member right away; owners and admins always keep admin. Audited.",
    access: "org-owner",
    body: {
      default_repository_permission: ["string", "Base permission every member gets on the organization's repositories: `none`, `read` (the default for new organizations), `write` or `admin`."],
      name: ["string", "Display name. An empty value clears it, and pages show the login instead."],
    },
  },
  "GET /orgs/{org}/members": { summary: "List organization members", description: "Members only (or site admins). Each entry carries the member's `role`.", access: "account" },
  "POST /orgs/{org}/invitations": {
    summary: "Invite someone to an organization",
    description: "Emails an invite link. The response holds the link too, so you can share it yourself. Refused with 422 when the address already has a pending invitation to the organization (letter case doesn't matter) or belongs to a member. You can send at most 50 invitations in 24 hours (site admins aren't limited); more answer 429 `you can send at most 50 invitations in 24 hours; try again later`.",
    access: "org-admin",
    status: 201,
    body: { email: ["string", "Email address to invite.", true], role: ["string", "`member` (default), `admin` or `owner`."] },
  },
  "GET /orgs/{org}/invitations": { summary: "List an organization's pending invitations", description: "Owners and admins (or site admins). Each has an `id` to revoke it with.", access: "org-admin" },
  "DELETE /orgs/{org}": {
    summary: "Delete an organization",
    description:
      "Owners only (or site admins). Refused with 422 while the organization still owns repositories (transfer or delete them first), container images, or an import in progress. Its members, pending invitations, secrets and variables are removed, its agents disabled and their tokens revoked, and its login freed. Repositories transferred out of it keep redirecting from their old URLs. Audited. From a browser session whose sign-in is more than 2 hours old: 403 `Confirm it's you: sign in with your passkey again to do this.` with a `confirm` URL (see /docs/security/overview#confirming-its-you).",
    access: "org-admin",
    status: 202,
  },
  "DELETE /orgs/{org}/invitations/{id}": {
    summary: "Revoke an organization invitation",
    description: "The link stops working and the address can be invited again. 404 when no pending invitation has this id. Audited.",
    access: "org-admin",
    status: 204,
  },
  "PUT /orgs/{org}/avatar": {
    summary: "Set an organization's picture",
    description:
      "Diffinery only. Organization owners (and site admins) only. The raw request body is the image (JPEG, PNG or WebP, at most 5 MB), not JSON. Returns the new `avatar_url`. A token needs `write` or `admin` scope and must not be limited to repositories. Audited.",
    access: "org-owner",
  },
  "DELETE /orgs/{org}/avatar": { summary: "Remove an organization's picture", description: "Diffinery only. Organization owners (and site admins) only. Goes back to generated initials and returns the `avatar_url`. Audited.", access: "org-owner" },
  "POST /invitations": {
    summary: "Invite someone to this instance",
    description: "A site-wide invite with no organization. Site admins only.",
    access: "site-admin",
    status: 201,
    body: { email: ["string", "Email address to invite.", true] },
  },
  "GET /invitations": { summary: "List pending invitations to this instance", description: "Site-wide invites only, not those to an organization or repository. Site admins only.", access: "site-admin" },
  "DELETE /invitations/{id}": { summary: "Revoke an invitation to this instance", description: "Site admins only. 404 when no pending site-wide invitation has this id. Audited.", access: "site-admin", status: 204 },

  // ------------------------------------------------------------ moderation (lib/moderation.ts)
  "GET /user/blocks": { summary: "List the people you blocked", description: "People only. See [Blocking and reporting](/docs/accounts/blocking-and-reporting).", access: "account" },
  "GET /user/blocks/{username}": { summary: "Check whether you blocked a person", description: "`204` if you did, `404` if not.", access: "account", status: 204 },
  "PUT /user/blocks/{username}": {
    summary: "Block a person",
    description: "In your repositories they (and their agents) can't open issues or pull requests, comment, review or react; they stop being a collaborator, pending invitations between you are cancelled and you get no notifications from them. Audited as `user.block`.",
    access: "account",
    status: 204,
  },
  "DELETE /user/blocks/{username}": { summary: "Unblock a person", description: "Audited as `user.unblock`.", access: "account", status: 204 },
  "GET /orgs/{org}/blocks": { summary: "List the people an organization blocked", description: "Organization owners and site administrators.", access: "org-owner" },
  "GET /orgs/{org}/blocks/{username}": { summary: "Check whether an organization blocked a person", description: "`204` if it did, `404` if not.", access: "org-owner", status: 204 },
  "PUT /orgs/{org}/blocks/{username}": { summary: "Block a person from an organization", description: "As blocking for yourself, for every repository the organization owns. Members can't be blocked. Audited as `org.block`.", access: "org-owner", status: 204 },
  "DELETE /orgs/{org}/blocks/{username}": { summary: "Unblock a person from an organization", description: "Audited as `org.unblock`.", access: "org-owner", status: 204 },
  "POST /diffinery/reports": {
    summary: "Report content to the site administrators",
    description: "Diffinery only. People only, at most 20 a day and one open report per thing. Returns the report (`id`, `kind`, `target`, `html_url`, `reason`, `body`, `state`, `created_at`). Audited as `report.create`.",
    access: "account",
    status: 201,
    body: {
      kind: ["string", "`user`, `repository`, `issue`, `pull_request` or `comment`.", true],
      login: ["string", "The person, for `user`."],
      repository: ["string", "`owner/name`, for everything but `user`."],
      number: ["integer", "The issue or pull request, for `issue` and `pull_request`."],
      comment_id: ["string", "The comment, for `comment`."],
      reason: ["string", "`spam`, `harassment`, `hate`, `violence`, `sexual`, `malware`, `impersonation` or `other`.", true],
      body: ["string", "A note for the administrators (up to 2,000 characters; required for `other`)."],
    },
  },
  "GET /admin/reports": {
    summary: "List reports",
    description: "Site administrators only. Newest first, with the reporter, the account reported, the excerpt kept when it was reported and the resolution. The total is in `x-total-count`.",
    access: "site-admin",
    query: { state: ["string", "`open` (default), `resolved` or `all`."], ...page },
  },
  "GET /admin/reports/{id}": { summary: "Get a report", description: "Site administrators only.", access: "site-admin" },
  "PATCH /admin/reports/{id}": {
    summary: "Resolve or reopen a report",
    description: "Site administrators only. Audited as `report.resolve` or `report.reopen`.",
    access: "site-admin",
    body: { state: ["string", "`resolved` or `open`.", true], resolution: ["string", "What you did, for `resolved` (up to 2,000 characters)."] },
  },
  "PUT /users/{username}/suspended": {
    summary: "Suspend a person",
    description: "Site administrators only (GitHub Enterprise's endpoint). Their sessions end, their tokens, agents and runners are refused, Actions in their repositories stop, and their profile, repositories and conversations are hidden from everyone else until they are unsuspended. Audited as `user.suspend`.",
    access: "site-admin",
    status: 204,
    body: { reason: ["string", "Why (up to 500 characters). Emailed to them and kept in the audit log.", true] },
  },
  "DELETE /users/{username}/suspended": { summary: "Unsuspend a person", description: "Site administrators only. Everything comes back, tokens included. Audited as `user.unsuspend`.", access: "site-admin", status: 204 },
  "PUT /repos/{owner}/{repo}/diffinery/comments/{id}/minimized": {
    summary: "Hide (minimize) a comment",
    description: "Diffinery only (GitHub's GraphQL `minimizeComment`). Write access, people only. The comment is shown collapsed with its reason. Audited as `comment.minimize`.",
    access: "write",
    body: { reason: ["string", "`spam`, `abuse`, `off_topic`, `outdated`, `duplicate` or `resolved` (or GitHub's `classifier`, such as `OFF_TOPIC`).", true] },
  },
  "DELETE /repos/{owner}/{repo}/diffinery/comments/{id}/minimized": { summary: "Show a hidden comment again", description: "Diffinery only. Write access, people only. Audited as `comment.unminimize`.", access: "write" },

  // ------------------------------------------------------------ search
  "GET /search/issues": {
    summary: "Search issues and pull requests",
    description:
      "Searches the repositories you can read (only public ones without a token), at most 50 per query; `incomplete_results` is true when more were left out. Qualifiers: `repo:`, `user:`, `org:`, `owner:`, `is:`, `type:`, `state:`, `draft:`, `label:`, `no:`, `author:`, `assignee:`, `head:`, `base:`, `in:`, `created:`, `updated:`, `closed:` and `sort:`; others are searched as text. Only the first 1000 results are available, and every `score` is 1.",
    access: "public",
    query: {
      q: ["string", "Search query, at most 256 characters.", true],
      sort: ["string", "`created` (default), `updated` or `comments`."],
      order: ["string", "`desc` (default) or `asc`."],
      ...page,
    },
  },
  "GET /search/repositories": {
    summary: "Search repositories",
    description:
      "Matches names, descriptions and topics of the repositories you can see (only public ones without a token). Qualifiers: `user:`, `org:`, `owner:`, `repo:`, `topic:`, `is:public`, `is:private`, `archived:` and `in:name,description,topics`. `fork:`, `language:`, `stars:`, `forks:`, `size:`, `pushed:` and `created:` are accepted but don't filter anything. Every `score` is 1.",
    access: "public",
    query: {
      q: ["string", "Search query, at most 256 characters.", true],
      sort: ["string", "`updated` sorts by last push; anything else keeps the default order."],
      order: ["string", "With `sort=updated`: `desc` (default) or `asc`."],
      ...page,
    },
  },

  // ------------------------------------------------------------ repositories
  "GET /user/repos": { summary: "List repositories you can access", description: "A token limited to repositories lists only those repositories.", access: "account" },
  "POST /user/repos": {
    summary: "Create a repository for yourself",
    description: "An agent's repositories belong to its owner.",
    access: "account",
    status: 201,
    body: {
      name: ["string", "Repository name.", true],
      description: ["string", "Short description."],
      visibility: ["string", "`private` (default) or `public`."],
      default_branch: ["string", "Default branch name (default `main`)."],
    },
  },
  "GET /users/{login}/repos": { summary: "List an account's repositories", description: "Only the ones you can see. A token limited to repositories lists only those repositories.", access: "account" },
  "GET /orgs/{org}/repos": { summary: "List an organization's repositories", description: "Only the ones you can see. A token limited to repositories lists only those repositories.", access: "account" },
  "POST /orgs/{org}/repos": {
    summary: "Create an organization repository",
    access: "account",
    status: 201,
    body: {
      name: ["string", "Repository name.", true],
      description: ["string", "Short description."],
      visibility: ["string", "`private` (default) or `public`."],
      default_branch: ["string", "Default branch name (default `main`)."],
    },
  },
  "GET /repos/{owner}/{repo}": { summary: "Get a repository", description: "Includes your role (`permissions.role`) and repository statistics.", access: "read" },
  "PATCH /repos/{owner}/{repo}": {
    summary: "Update a repository",
    access: "admin",
    description: "Works on an archived repository too, so an admin can unarchive it with `archived: false`. Audited as `repo.update`, `repo.archive` or `repo.unarchive`. A new `name` renames the repository: its old name keeps redirecting (see the transfer endpoint), until a repository is created there again. 422 when the owner already has a repository with that name.",
    body: {
      name: ["string", "New name."],
      description: ["string", "New description."],
      visibility: ["string", "`private` or `public`."],
      default_branch: ["string", "New default branch (must exist)."],
      archived: ["boolean", "Archive (read-only) or unarchive."],
    },
  },
  "POST /repos/{owner}/{repo}/diffinery/purge-unreachable": {
    summary: "Purge unreachable objects",
    description: "Permanently deletes every commit, tree and file that no branch, tag, pull request, merge queue entry or unfinished workflow run reaches, and empties the archive cache, so a secret force-pushed away can't be fetched by its SHA. Returns `{ objects, bytes }`. People only, not agents. Repositories of up to 300,000 objects (422 otherwise). From a browser session whose sign-in is more than 2 hours old: 403 `Confirm it's you: sign in with your passkey again to do this.` with a `confirm` URL. Audited as `repo.purge_unreachable`. See /docs/security/push-protection#removing-a-secret-that-was-pushed.",
    access: "admin",
  },
  "DELETE /repos/{owner}/{repo}": { summary: "Delete a repository", description: "People only; agents can't delete repositories. Works on an archived repository too. Audited. From a browser session whose sign-in is more than 2 hours old: 403 `Confirm it's you: sign in with your passkey again to do this.` with a `confirm` URL (see /docs/security/overview#confirming-its-you).", access: "admin", status: 204 },
  "POST /repos/{owner}/{repo}/transfer": {
    summary: "Transfer a repository",
    description:
      "Moves the repository to `new_owner`: the caller's own account, or an organization where the caller is an owner or admin. Needs admin access to the repository (a personal repository: its owner) and a token with the admin scope; agents, job tokens (`GITHUB_TOKEN`) and sandbox tokens are refused. 422 when the new owner already has a repository (or a container image of a moved image's name) with that name. Git data, issues, pull requests, Actions runs, secrets, variables, environments, webhooks and caches move with it, and so do container images linked to it. Direct collaborators keep their access; grants that came from the old organization (its members, their agents, its agents) are dropped, and the new owner's organization secrets and variables apply. The old owner/name keeps working for anyone who can read the repository, as on GitHub: API calls get a 301 (reads) or 307 (anything else) to the new URL, web pages a 301, Git (with a `This repository moved` notice on push) and MCP are served under the old name, and image names resolve to the moved images. Creating a repository at the old name ends the redirect. Admins of both owners get an email. Audited as `repo.transfer`. Returns the repository. From a browser session whose sign-in is more than 2 hours old: 403 `Confirm it's you: sign in with your passkey again to do this.` with a `confirm` URL (see /docs/security/overview#confirming-its-you).",
    access: "admin",
    status: 202,
    body: { new_owner: ["string", "Login of the user or organization to transfer to.", true], new_name: ["string", "A new name for the repository (default: keep its name)."] },
  },
  "GET /repos/{owner}/{repo}/collaborators": { summary: "List collaborators", description: "Each entry carries `role_name`.", access: "read" },
  "PUT /repos/{owner}/{repo}/collaborators/{login}": {
    summary: "Invite a collaborator, or change one's role",
    description:
      "As on GitHub, a person without access gets an invitation and has access once they accept it: the answer is `201` with the invitation (`id`, `repository`, `invitee`, `inviter`, `permissions`, `expires_at`), audited as `repo.invite`; asking again while it's pending changes its role. Agents, existing collaborators, members of the owning organization and yourself get the role at once: `204`, audited as `repo.collaborator.set`.",
    access: "admin",
    status: 201,
    body: { permission: ["string", "`read`, `triage`, `write` (default), `maintain` or `admin`; GitHub's `pull` and `push` work too."] },
  },
  "DELETE /repos/{owner}/{repo}/collaborators/{login}": { summary: "Remove a collaborator", description: "Audited as `repo.collaborator.remove`.", access: "admin", status: 204 },
  "GET /repos/{owner}/{repo}/invitations": { summary: "List pending repository invitations", description: "Invitations sent by email to people without an account. Each has an `id` to revoke it with.", access: "admin" },
  "DELETE /repos/{owner}/{repo}/invitations/{id}": {
    summary: "Revoke a repository invitation",
    description: "The link stops working and the address can be invited again. 404 when no pending invitation to this repository has this id. Audited.",
    access: "admin",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/assignees": { summary: "List assignable people", description: "Collaborators with triage access or more, plus the owner when the owner is a user.", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/assignees/{login}": {
    summary: "Check if someone can be assigned",
    description: "204 when `login` is the repository's owner or a collaborator with triage access or more, 404 otherwise.",
    access: "read",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/languages": {
    summary: "List languages",
    description: "Bytes of code per language on the default branch, largest first. Languages come from file extensions and a few well-known file names; vendored directories like `node_modules` and `vendor` are skipped.",
    access: "read",
  },
  "GET /repos/{owner}/{repo}/topics": { summary: "Get topics", description: "Returns `{ names }`.", access: "read" },
  "PUT /repos/{owner}/{repo}/topics": {
    summary: "Replace topics",
    description: "Names are lower-cased and deduplicated. Each starts with a letter or digit and has at most 50 letters, digits and dashes; at most 20 topics. Audited.",
    access: "admin",
    body: { names: ["string[]", "Every topic the repository should have (`[]` clears them).", true] },
  },
  "POST /repos/{owner}/{repo}/dispatches": {
    summary: "Trigger a repository_dispatch event",
    description: "Starts workflows on the default branch that run `on: repository_dispatch` with this type, and sends the `repository_dispatch` webhook. Fails with 422 on an empty repository, and with 429 when the repository already has 500 unfinished workflow runs.",
    access: "write",
    status: 204,
    body: {
      event_type: ["string", "Event type, at most 100 characters.", true],
      client_payload: ["object", "Data for workflows as `github.event.client_payload`: at most 10 top-level keys and 64 KB."],
    },
  },

  // ------------------------------------------------------------ branches, tags, refs and commits
  "GET /repos/{owner}/{repo}/branches": { summary: "List branches", description: "Each branch says whether it is `protected` and the `default`.", access: "read" },
  "GET /repos/{owner}/{repo}/branches/{branch}": { summary: "Get a branch", access: "read" },
  "GET /repos/{owner}/{repo}/tags": { summary: "List tags", access: "read" },
  "POST /repos/{owner}/{repo}/merges": {
    summary: "Merge a branch",
    description:
      "Merges `head` into the `base` branch with a merge commit. Returns 201 with the commit, 204 when `base` already contains `head`, 409 on a conflict and 404 when either doesn't exist. Branch protection and agent rules apply as they do to a push.",
    access: "write",
    status: 201,
    body: {
      base: ["string", "Branch to merge into.", true],
      head: ["string", "Branch, tag or commit to merge.", true],
      commit_message: ["string", "Commit message (default: `Merge {head} into {base}`)."],
    },
  },
  "GET /repos/{owner}/{repo}/git/refs/{path}": { summary: "List references", description: "Every ref under `refs/{path}`, for example `heads` or `tags/v1`.", access: "read" },
  "POST /repos/{owner}/{repo}/git/refs": {
    summary: "Create a reference",
    description: "Branch protection and agent rules apply as they do to a push.",
    access: "write",
    status: 201,
    body: { ref: ["string", "Full ref name, like `refs/heads/feature`.", true], sha: ["string", "Commit to point at.", true] },
  },
  "PATCH /repos/{owner}/{repo}/git/refs/{path}": {
    summary: "Update a reference",
    access: "write",
    body: { sha: ["string", "New target commit.", true], force: ["boolean", "Allow a non-fast-forward update."] },
  },
  "DELETE /repos/{owner}/{repo}/git/refs/{path}": { summary: "Delete a reference", access: "write", status: 204 },
  "GET /repos/{owner}/{repo}/commits": {
    summary: "List commits",
    access: "read",
    query: { sha: ["string", "Branch, tag or commit to start from (default: the default branch)."], path: ["string", "Only commits that touch this path."], ...page },
  },
  "GET /repos/{owner}/{repo}/commits/{ref}": { summary: "Get a commit", description: "The commit with its diff.", access: "read" },
  "GET /repos/{owner}/{repo}/commits/{sha}/pulls": {
    summary: "List pull requests for a commit",
    description: "Pull requests whose head or merge commit is this commit, plus open pull requests (the 50 newest) that contain it. 422 when the commit doesn't exist.",
    access: "read",
    query: { ...page },
  },
  "GET /repos/{owner}/{repo}/compare/{spec}": { summary: "Compare two refs", description: "`spec` is `base...head`.", access: "read" },
  "GET /repos/{owner}/{repo}/raw/{ref}/{path}": { summary: "Download a raw file", description: "The file's bytes, served as text or `application/octet-stream`.", access: "read" },

  // ------------------------------------------------------------ contents
  "GET /repos/{owner}/{repo}/contents": { summary: "List the root directory", access: "read", query: { ref: ["string", "Branch, tag or commit (default: the default branch)."] } },
  "GET /repos/{owner}/{repo}/contents/{path}": {
    summary: "Get a file or directory",
    description: "A directory returns an array of entries; a file returns its content base64-encoded.",
    access: "read",
    query: { ref: ["string", "Branch, tag or commit (default: the default branch)."] },
  },
  "PUT /repos/{owner}/{repo}/contents/{path}": {
    summary: "Create or update a file",
    description: "Commits one file.",
    access: "write",
    status: 201,
    body: { message: ["string", "Commit message.", true], content: ["string", "New content, base64-encoded.", true], branch: ["string", "Branch to commit to (default: the default branch)."] },
  },
  "DELETE /repos/{owner}/{repo}/contents/{path}": {
    summary: "Delete a file",
    access: "write",
    body: { message: ["string", "Commit message.", true], branch: ["string", "Branch to commit to (default: the default branch)."] },
  },
  "POST /repos/{owner}/{repo}/diffinery/commits": {
    summary: "Commit several files at once",
    description:
      "Diffinery only. Writes and deletes any number of files in one commit, without a git client. Pass `expected_head_sha` to fail instead of racing another writer. Push protection scans the new content as it does for `git push`: content that looks like a credential is refused with 422 and audited as `api.blocked_secret`. A repository admin who is a person can commit it anyway with an `allow_secrets` reason, audited as `api.secret_bypassed` and emailed to the repository's admins.",
    access: "write",
    status: 201,
    body: {
      branch: ["string", "Branch to commit to.", true],
      message: ["string", "Commit message.", true],
      files: ["array", "Changes: `{ path, content, encoding: \"utf-8\" | \"base64\", mode: \"100644\" | \"100755\" }` or `{ path, delete: true }`.", true],
      base: ["string", "Create `branch` from this ref when it doesn't exist."],
      expected_head_sha: ["string", "Fail with 409 if the branch has moved."],
      allow_secrets: ["string", "Why a detected secret may be committed anyway (repository admins who are people; at most 200 characters are kept)."],
    },
  },
  "GET /repos/{owner}/{repo}/readme": {
    summary: "Get the README",
    description: "The README in the root directory, base64-encoded like a file from the contents API. A Markdown README wins when there are several. Send `Accept: application/vnd.github.raw` for the raw bytes.",
    access: "read",
    query: { ref: ["string", "Branch, tag or commit (default: the default branch)."] },
  },
  "GET /repos/{owner}/{repo}/readme/{dir}": {
    summary: "Get a directory's README",
    description: "Like the root README, for the directory `dir`.",
    access: "read",
    query: { ref: ["string", "Branch, tag or commit (default: the default branch)."] },
  },
  ...archiveDocs("tarball", "a tarball", "`.tar.gz`"),
  ...archiveDocs("zipball", "a zip archive", "`.zip` (at most 65535 files)"),

  // ------------------------------------------------------------ releases
  "GET /repos/{owner}/{repo}/releases": { summary: "List releases", description: "Newest first. Drafts are included only for people with write access.", access: "read", query: { ...page } },
  "POST /repos/{owner}/{repo}/releases": {
    summary: "Create a release",
    description:
      "A published release (not a draft) creates its tag at `target_commitish` when the tag doesn't exist, sends `release` webhooks and starts `on: release` workflows; a draft only sends the `created` webhook. 422 when the tag already has a published release. Upload assets to the release's `upload_url`. `discussion_category_name` is ignored. See [Releases](/docs/collaboration/releases).",
    access: "write",
    status: 201,
    body: {
      tag_name: ["string", "Tag to release.", true],
      target_commitish: ["string", "Branch, tag or commit for a new tag (default: the default branch)."],
      name: ["string", "Release title."],
      body: ["string", "Markdown notes, at most 125000 characters."],
      draft: ["boolean", "Save as a draft."],
      prerelease: ["boolean", "Mark as a prerelease."],
      make_latest: ["string", "`true` (default), `false`, or `legacy` (the newest by date)."],
      generate_release_notes: ["boolean", "Append generated notes to `body`."],
    },
  },
  "GET /repos/{owner}/{repo}/releases/{id}": { summary: "Get a release", description: "Drafts are 404 for people without write access.", access: "read" },
  "PATCH /repos/{owner}/{repo}/releases/{id}": {
    summary: "Update a release",
    description: "Send only what changes. Setting `draft` to false publishes the release (creating its tag if needed); setting it back to true unpublishes it. Sends `release` webhooks.",
    access: "write",
    body: {
      tag_name: ["string", "New tag."],
      target_commitish: ["string", "Branch, tag or commit for a new tag."],
      name: ["string", "Release title."],
      body: ["string", "Markdown notes, at most 125000 characters."],
      draft: ["boolean", "Draft or published."],
      prerelease: ["boolean", "Mark as a prerelease."],
      make_latest: ["string", "`true`, `false` or `legacy`."],
    },
  },
  "DELETE /repos/{owner}/{repo}/releases/{id}": { summary: "Delete a release", description: "Deletes its assets too; the tag stays. Sends the `release` webhook.", access: "write", status: 204 },
  "GET /repos/{owner}/{repo}/releases/{id}/assets": { summary: "List release assets", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/releases/assets/{id}": {
    summary: "Get a release asset",
    description: "The asset's metadata, or the file itself with `Accept: application/octet-stream`.",
    access: "read",
  },
  "PATCH /repos/{owner}/{repo}/releases/assets/{id}": {
    summary: "Update a release asset",
    description: "`state` is accepted and ignored.",
    access: "write",
    body: { name: ["string", "New file name (unique within the release)."], label: ["string", "Display label."] },
  },
  "DELETE /repos/{owner}/{repo}/releases/assets/{id}": { summary: "Delete a release asset", access: "write", status: 204 },
  "POST /repos/{owner}/{repo}/releases/generate-notes": {
    summary: "Generate release notes",
    description: "Builds notes from the pull requests merged since the previous release, with categories from `.github/release.yml` (or `.yaml`). Nothing is saved; returns `{ name, body }`.",
    access: "write",
    body: {
      tag_name: ["string", "Tag for the release.", true],
      target_commitish: ["string", "Used when the tag doesn't exist yet (default: the default branch)."],
      previous_tag_name: ["string", "Start from this tag (default: the newest earlier published release)."],
      configuration_file_path: ["string", "Config file to use instead of `.github/release.yml`."],
    },
  },
  "GET /repos/{owner}/{repo}/releases/latest": {
    summary: "Get the latest release",
    description: "The release marked latest, or else the newest published release that isn't a prerelease. 404 when there is none.",
    access: "read",
  },
  "GET /repos/{owner}/{repo}/releases/tags/{tag}": { summary: "Get a release by tag", description: "Published releases only; drafts aren't found by tag.", access: "read" },
  ...reactionDocs("/repos/{owner}/{repo}/releases/{id}", "a release", "Drafts are hidden from people without write access, and so are their reactions."),

  // ------------------------------------------------------------ git database
  "POST /repos/{owner}/{repo}/git/blobs": {
    summary: "Create a blob",
    description: "Push protection applies: content that looks like a credential is refused with 422. Returns `{ url, sha }`.",
    access: "write",
    status: 201,
    body: { content: ["string", "The blob's content.", true], encoding: ["string", "`utf-8` (default) or `base64`."] },
  },
  "GET /repos/{owner}/{repo}/git/blobs/{sha}": { summary: "Get a blob", description: "Content is base64-encoded; send `Accept: application/vnd.github.raw` for the raw bytes.", access: "read" },
  "POST /repos/{owner}/{repo}/git/trees": {
    summary: "Create a tree",
    description:
      "Applies the entries on top of `base_tree`. An entry with `content` creates a blob (push protection applies); one with `sha: null` deletes the path. `type` is ignored: the mode decides. At most 10000 entries per request.",
    access: "write",
    status: 201,
    body: {
      tree: ["array", "Entries: `{ path, mode, sha }` or `{ path, mode, content }`. `mode` is `100644` (default), `100755`, `040000`, `160000` or `120000`.", true],
      base_tree: ["string", "Tree to start from (default: an empty tree)."],
    },
  },
  "GET /repos/{owner}/{repo}/git/trees/{sha}": {
    summary: "Get a tree",
    description: "`sha` may be a tree, a commit or a ref. `truncated` is true when a recursive listing stopped at 100000 entries.",
    access: "read",
    query: { recursive: ["string", "Any value but `0` or `false` lists every entry below, not just the top level."] },
  },
  "POST /repos/{owner}/{repo}/git/commits": {
    summary: "Create a Git commit",
    description: "Writes a commit object; no branch moves until you update a reference. `author` and `committer` default to you. Commits made by agents carry a `diffinery-agent` header.",
    access: "write",
    status: 201,
    body: {
      message: ["string", "Commit message.", true],
      tree: ["string", "SHA of the commit's tree.", true],
      parents: ["string[]", "Parent commit SHAs (none for a root commit)."],
      author: ["object", "`{ name, email, date }`."],
      committer: ["object", "`{ name, email, date }` (default: the author)."],
      signature: ["string", "Signature to store in the commit as given."],
    },
  },
  "GET /repos/{owner}/{repo}/git/commits/{sha}": { summary: "Get a Git commit", access: "read" },
  "POST /repos/{owner}/{repo}/git/tags": {
    summary: "Create a tag object",
    description: "Writes an annotated tag object only; create its `refs/tags/...` reference with `POST /repos/{owner}/{repo}/git/refs` to publish it.",
    access: "write",
    status: 201,
    body: {
      tag: ["string", "Tag name.", true],
      object: ["string", "SHA of the object to tag.", true],
      message: ["string", "Tag message."],
      type: ["string", "`commit`, `tree`, `blob` or `tag`; must match the object (default: its type)."],
      tagger: ["object", "`{ name, email, date }` (default: you)."],
    },
  },
  "GET /repos/{owner}/{repo}/git/tags/{sha}": { summary: "Get a tag object", description: "`verification.verified` is always false.", access: "read" },
  "GET /repos/{owner}/{repo}/git/ref/{ref}": {
    summary: "Get a reference",
    description: "`ref` is the name after `refs/`, like `heads/main` or `tags/v1.0`, and must match exactly.",
    access: "read",
  },
  "GET /repos/{owner}/{repo}/git/matching-refs/{ref}": {
    summary: "List matching references",
    description: "Refs whose names start with `refs/{ref}`, like `heads/feature` or `tags/v1.`. Pull request refs appear only when `ref` starts with `pull/`.",
    access: "read",
    query: { per_page: ["integer", "Results per page (default 100, at most 100)."], page: page.page! },
  },
  "GET /repos/{owner}/{repo}/git/refs": {
    summary: "List all references",
    description: "Every branch, tag and other ref, without pull request refs.",
    access: "read",
    query: { per_page: ["integer", "Results per page (default 100, at most 100)."], page: page.page! },
  },

  // ------------------------------------------------------------ branch protection
  "GET /repos/{owner}/{repo}/branches/{branch}/protection": { summary: "Get a protection rule", description: "`branch` is the rule's pattern.", access: "admin" },
  "PUT /repos/{owner}/{repo}/branches/{branch}/protection": {
    summary: "Create or replace a protection rule",
    description:
      "`branch` is a branch name or pattern. People only: agents and workflow tokens can't change protection. `allowAgentAutoMerge` (boolean) lets agents land pull requests through auto-merge or the merge queue; turning it on or off is audited as `repo.protection.agent_auto_merge`. `agentAutoMergeWithoutApproval` (boolean, needs `allowAgentAutoMerge`) lets those landings go through on green required checks without a person's approval, audited as `repo.protection.agent_approval_waiver`. `autoMergeAgents` (agent logins, needs `allowAgentAutoMerge`) has Diffinery turn auto-merge on by itself, as the agent, for pull requests those agents open, mark ready or push to, with `autoMergeMethod` (`merge`, `squash` or `rebase`) for how they merge; the answer stores them as `{ id, login }`, and changes are audited as `repo.protection.agent_auto_merge_rule`. See the branch protection guide for every field.",
    access: "admin",
  },
  "DELETE /repos/{owner}/{repo}/branches/{branch}/protection": { summary: "Delete a protection rule", description: "Audited as `repo.protection.delete`.", access: "admin", status: 204 },

  // ------------------------------------------------------------ issues
  "GET /repos/{owner}/{repo}/issues": {
    summary: "List issues and pull requests",
    description: "As on GitHub, this list includes pull requests. The total is in the `X-Total-Count` header.",
    access: "read",
    query: { state: ["string", "`open` (default), `closed` or `all`."], labels: ["string", "Only items with this label."], creator: ["string", "Only items opened by this login."], milestone: ["string", "A milestone number, `none` (no milestone) or `*` (any milestone)."], q: ["string", "Text search in titles."], ...page },
  },
  "POST /repos/{owner}/{repo}/issues": {
    summary: "Create an issue",
    description: "Needs a signed-in caller, also on a public repository. As on GitHub, `labels` and `assignees` from a caller without triage access are dropped without an error.",
    access: "read",
    status: 201,
    body: { title: ["string", "Title.", true], body: ["string", "Markdown body."], labels: ["string[]", "Label names."], assignees: ["string[]", "Logins."] },
  },
  "GET /repos/{owner}/{repo}/issues/{number}": { summary: "Get an issue", access: "read" },
  "PATCH /repos/{owner}/{repo}/issues/{number}": {
    summary: "Update an issue",
    description: "The author can edit their own issue or pull request. As on GitHub, `labels`, `assignees` and `milestone` from a caller without triage access are dropped without an error.",
    access: "read",
    body: {
      title: ["string", "New title."],
      body: ["string", "New body."],
      state: ["string", "`open` or `closed`."],
      state_reason: ["string", "Why it was closed, like `completed` or `not_planned`."],
      labels: ["string[]", "Replace the labels."],
      assignees: ["string[]", "Replace the assignees."],
      milestone: ["integer", "Milestone number, or `null` to remove the milestone. Ignored without triage access. Checked before anything is saved: 422 when it isn't a whole number or `null`, or when no milestone has that number."],
    },
  },
  "GET /repos/{owner}/{repo}/milestones": {
    summary: "List milestones",
    description: "Every milestone in the state you ask for (no paging), ordered by due date (milestones without one last), then by number. The `id` is the milestone number. Milestones come from GitHub imports or are created with the endpoint below; the web UI sets an issue's milestone but doesn't create milestones.",
    access: "read",
    query: { state: ["string", "`open` (default), `closed` or `all`. Anything else is 422."] },
  },
  "GET /repos/{owner}/{repo}/milestones/{number}": { summary: "Get a milestone", description: "`number` is the milestone number. 404 `milestone not found`.", access: "read" },
  "POST /repos/{owner}/{repo}/milestones": {
    summary: "Create a milestone",
    description: "New milestones are open unless `state` is `closed`. There is no endpoint to delete a milestone.",
    access: "triage",
    status: 201,
    body: {
      title: ["string", "1 to 255 characters.", true],
      description: ["string", "At most 65,536 characters."],
      state: ["string", "`open` (default) or `closed`."],
      due_on: ["string", "ISO 8601 timestamp, or `null`."],
    },
  },
  "PATCH /repos/{owner}/{repo}/milestones/{number}": {
    summary: "Update a milestone",
    description: "Send only the fields you change. Closing records `closed_at`; reopening clears it.",
    access: "triage",
    body: {
      title: ["string", "1 to 255 characters."],
      description: ["string", "At most 65,536 characters."],
      state: ["string", "`open` or `closed`."],
      due_on: ["string", "ISO 8601 timestamp, or `null` to clear it."],
    },
  },
  "GET /repos/{owner}/{repo}/issues/{number}/comments": {
    summary: "List comments",
    description: "Conversation comments on an issue or pull request (not review comments).",
    access: "read",
    query: { since: ["string", "Only comments updated at or after this ISO timestamp."], ...page },
  },
  "POST /repos/{owner}/{repo}/issues/{number}/comments": { summary: "Add a comment", access: "read", status: 201, body: { body: ["string", "Markdown body.", true] } },
  "GET /repos/{owner}/{repo}/issues/comments": {
    summary: "List comments in a repository",
    description: "Conversation comments on every issue and pull request.",
    access: "read",
    query: {
      since: ["string", "Only comments updated at or after this ISO timestamp."],
      sort: ["string", "`created` (default) or `updated`."],
      direction: ["string", "`asc` (default) or `desc`."],
      ...page,
    },
  },
  "GET /repos/{owner}/{repo}/issues/comments/{id}": { summary: "Get a comment", description: "`id` is the numeric id or Diffinery's own.", access: "read" },
  "PATCH /repos/{owner}/{repo}/issues/comments/{id}": { summary: "Edit a comment", access: "read", body: { body: ["string", "New Markdown body.", true] } },
  "DELETE /repos/{owner}/{repo}/issues/comments/{id}": { summary: "Delete a comment", description: "Your own comments, or anyone's with maintain access.", access: "read", status: 204 },
  ...reactionDocs("/repos/{owner}/{repo}/issues/{number}", "an issue", "Works for pull requests too."),
  ...reactionDocs("/repos/{owner}/{repo}/issues/comments/{id}", "a comment"),
  "POST /repos/{owner}/{repo}/issues/{number}/assignees": {
    summary: "Add assignees",
    description: "Adds to the current assignees, at most 10 in all. Logins aren't checked against who can be assigned. Returns the issue.",
    access: "triage",
    status: 201,
    body: { assignees: ["string[]", "Logins to add."] },
  },
  "DELETE /repos/{owner}/{repo}/issues/{number}/assignees": { summary: "Remove assignees", description: "Returns the issue.", access: "triage", body: { assignees: ["string[]", "Logins to remove."] } },
  "PUT /repos/{owner}/{repo}/issues/{number}/lock": {
    summary: "Lock a conversation",
    description: "While locked, only people with triage access can comment, review or react.",
    access: "triage",
    status: 204,
    body: { lock_reason: ["string", "`off-topic`, `too heated`, `resolved` or `spam`."] },
  },
  "DELETE /repos/{owner}/{repo}/issues/{number}/lock": { summary: "Unlock a conversation", access: "triage", status: 204 },
  "GET /repos/{owner}/{repo}/issues/{number}/events": { summary: "List an issue's events", description: "Labels, assignments, state changes, locks, review requests and the like, oldest first.", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/issues/{number}/timeline": {
    summary: "List an issue's timeline",
    description: "Events, comments (`commented`) and reviews (`reviewed`) together, oldest first.",
    access: "read",
    query: { ...page },
  },
  "GET /repos/{owner}/{repo}/issues/events": { summary: "List events in a repository", description: "Events on every issue and pull request, newest first, each with its `issue`.", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/issues/events/{id}": { summary: "Get an event", access: "read" },
  "GET /repos/{owner}/{repo}/labels": { summary: "List labels", access: "read" },
  "POST /repos/{owner}/{repo}/labels": {
    summary: "Create a label",
    description: "422 when a label with that name exists; change one with `PATCH /repos/{owner}/{repo}/labels/{name}`.",
    access: "triage",
    status: 201,
    body: { name: ["string", "Label name, at most 100 characters.", true], color: ["string", "6-digit hex color, with or without `#` (default `ededed`)."], description: ["string", "Description."] },
  },
  "GET /repos/{owner}/{repo}/labels/{name}": { summary: "Get a label", access: "read" },
  "PATCH /repos/{owner}/{repo}/labels/{name}": {
    summary: "Update a label",
    description: "Renaming it renames it on every issue too.",
    access: "triage",
    body: { new_name: ["string", "New name."], color: ["string", "6-digit hex color, with or without `#`."], description: ["string", "Description."] },
  },
  "DELETE /repos/{owner}/{repo}/labels/{name}": { summary: "Delete a label", description: "Also removes it from every issue.", access: "triage", status: 204 },
  "GET /repos/{owner}/{repo}/issues/{number}/labels": { summary: "List an issue's labels", access: "read", query: { ...page } },
  "POST /repos/{owner}/{repo}/issues/{number}/labels": {
    summary: "Add labels to an issue",
    description: "Labels that don't exist yet are created. At most 100 per issue. Returns the issue's labels.",
    access: "triage",
    body: { labels: ["string[]", "Label names (`{ name }` objects, or a bare array as the body, work too).", true] },
  },
  "PUT /repos/{owner}/{repo}/issues/{number}/labels": {
    summary: "Replace an issue's labels",
    description: "Labels that don't exist yet are created; `[]` removes them all. Returns the issue's labels.",
    access: "triage",
    body: { labels: ["string[]", "Label names (`{ name }` objects, or a bare array as the body, work too).", true] },
  },
  "DELETE /repos/{owner}/{repo}/issues/{number}/labels": { summary: "Remove all labels from an issue", access: "triage", status: 204 },
  "DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}": {
    summary: "Remove a label from an issue",
    description: "Returns the labels left. 404 when the issue doesn't have it.",
    access: "triage",
  },

  // ------------------------------------------------------------ pull requests
  "GET /repos/{owner}/{repo}/pulls": {
    summary: "List pull requests",
    description: "The total is in the `X-Total-Count` header.",
    access: "read",
    query: { state: ["string", "`open` (default), `closed` or `all`."], labels: ["string", "Only pull requests with this label."], creator: ["string", "Only pull requests opened by this login."], q: ["string", "Text search in titles."], ...page },
  },
  "POST /repos/{owner}/{repo}/pulls": {
    summary: "Open a pull request",
    description: "A workflow's `GITHUB_TOKEN` can open one only when the repository allows workflows to create pull requests (`can_approve_pull_request_reviews`, see `PUT /repos/{owner}/{repo}/actions/permissions/workflow`); otherwise 403.",
    access: "write",
    status: 201,
    body: {
      title: ["string", "Title.", true],
      head: ["string", "Branch with the changes (`owner:branch` also works).", true],
      base: ["string", "Branch to merge into (default: the default branch)."],
      body: ["string", "Markdown description."],
      intent: ["string", "Diffinery: what the change is meant to do, shown to reviewers."],
      draft: ["boolean", "Open as a draft."],
      reviewers: ["string[]", "Logins to request reviews from."],
      auto_merge: ["boolean", "Diffinery: `true` turns on auto-merge as it opens, `false` keeps it off where your setting would turn it on. When asked for and it stayed off (for example, the base branch has no required checks), the answer's `auto_merge_skipped` says why. See /docs/collaboration/merge-on-green."],
    },
  },
  "GET /repos/{owner}/{repo}/pulls/{number}": {
    summary: "Get a pull request",
    description: "Includes `mergeable`, `mergeable_state`, `merge_blockers` (why it can't merge yet), `approvals`, `required_approvals` and `checks`.",
    access: "read",
  },
  "PATCH /repos/{owner}/{repo}/pulls/{number}": {
    summary: "Update a pull request",
    description:
      "The author, or anyone with triage access. `base` isn't supported and is ignored. A merged pull request can't be reopened. A title or body change sends a `pull_request` `edited` event. `draft` is a Diffinery extension (GitHub only offers it through GraphQL): the author or anyone with write access can set it on an open pull request. It records a `ready_for_review` or `convert_to_draft` timeline event and sends the `pull_request` webhook with the action `ready_for_review` or `converted_to_draft`.",
    access: "read",
    body: {
      title: ["string", "New title."],
      body: ["string", "New description."],
      state: ["string", "`open` or `closed`."],
      draft: ["boolean", "`false` marks it ready for review; `true` converts it back to a draft."],
    },
  },
  "PUT /repos/{owner}/{repo}/pulls/{number}/update-branch": {
    summary: "Update a pull request's branch",
    description:
      "Merges the base branch into the head branch right away, then answers 202 as GitHub does. 422 when the base has no new commits, on a conflict, or when `expected_head_sha` doesn't match. Branch protection and agent rules apply to the head branch.",
    access: "write",
    status: 202,
    body: { expected_head_sha: ["string", "Fail unless the head branch is at this commit."] },
  },
  "GET /repos/{owner}/{repo}/pulls/{number}/files": { summary: "List changed files", description: "Each file with its status, additions, deletions and patch.", access: "read" },
  "GET /repos/{owner}/{repo}/pulls/{number}/commits": { summary: "List a pull request's commits", access: "read" },
  "GET /repos/{owner}/{repo}/pulls/{number}/merge": { summary: "Check mergeability", description: "Whether the pull request can merge now, and if not, the blockers.", access: "read" },
  "PUT /repos/{owner}/{repo}/pulls/{number}/merge": {
    summary: "Merge a pull request",
    description:
      "Fails with 405 and the blockers when protection rules aren't met, and with 405 when a merge commit is asked for on a branch that requires linear history (without `merge_method`, such a branch squashes). A branch that requires a merge queue answers 405 too: add the pull request to the queue instead. A repository admin (a person, not an agent or a workflow) can bypass, when the rule doesn't include administrators, there are no conflicts and the pull request isn't a draft. Each flag covers only what it names: `bypass_rules: true` skips unmet rules and linear history, and `bypass_merge_queue: true` skips only the queue. A bypass that skipped an unmet rule, linear history or the queue is audited as `pull_request.merge_bypassed`. Agents can't merge into the default branch or a protected branch themselves (unless the rule sets `agentsMayMerge`); where it sets `allowAgentAutoMerge` they turn on auto-merge (`PUT .../auto-merge`) instead.",
    access: "write",
    body: {
      merge_method: ["string", "`merge`, `squash` or `rebase`."],
      commit_title: ["string", "Title of the merge or squash commit."],
      commit_message: ["string", "Body of the merge or squash commit."],
      sha: ["string", "Fail if the head has moved from this commit."],
      delete_branch: ["boolean", "Delete the head branch after merging."],
      bypass_merge_queue: ["boolean", "Merge directly even when a queue is required (admins). Doesn't skip unmet rules; send `bypass_rules` too for that."],
      bypass_rules: ["boolean", "Merge even though protection rules (including linear history) aren't met (admins). Without it, an admin's merge is blocked like anyone else's."],
    },
  },
  "GET /repos/{owner}/{repo}/merge-queue/{branch}": { summary: "Get a branch's merge queue", description: "Diffinery only (GitHub exposes this through GraphQL). Settings and every entry with its merge group and checks.", access: "read" },
  "PUT /repos/{owner}/{repo}/pulls/{number}/merge-queue": {
    summary: "Add a pull request to the merge queue",
    description: "Diffinery only. Returns 201 with the entry when queued.",
    access: "write",
    status: 201,
    body: { merge_method: ["string", "`merge`, `squash` or `rebase` (default: the queue's method)."], delete_branch: ["boolean", "Delete the head branch once merged."] },
  },
  "DELETE /repos/{owner}/{repo}/pulls/{number}/merge-queue": { summary: "Remove a pull request from the merge queue", access: "write", status: 204 },
  "PUT /repos/{owner}/{repo}/pulls/{number}/auto-merge": {
    summary: "Enable auto-merge",
    description:
      "Diffinery's REST form of GitHub's `enablePullRequestAutoMerge`. Diffinery merges the pull request by itself as soon as every rule of its base branch is met (required checks on the head, approvals from people, linear history), as the caller, never bypassing anything; into a branch with a merge queue it adds it to the queue instead. Returns `{ state, auto_merge, merge_commit_sha }`: `state` is `enabled` (waiting), `queued` or `merged` (it was ready). The pull request's `auto_merge` shows it until then. A push to the head branch by anyone else, or converting the pull request to a draft, turns it off. 422 for a draft, a closed or merged pull request, or one already in the merge queue. Agents and workflow tokens may use it on the default branch or a protected one only when its rule sets `allowAgentAutoMerge` (else 403) and has at least one required check (else 422); a workflow token needs `contents: write`. Audited as `pull_request.auto_merge_enabled`, and the merge as `pull_request.auto_merged`.",
    access: "write",
    body: {
      merge_method: ["string", "`merge`, `squash` or `rebase` (default: the queue's method, `squash` where linear history is required, else `merge`)."],
      commit_title: ["string", "Title of the merge or squash commit."],
      commit_message: ["string", "Body of the merge or squash commit."],
      delete_branch: ["boolean", "Delete the head branch once auto-merge lands the pull request, directly or through the queue (never the default branch or a protected one). 422 `delete_branch must be a boolean` otherwise."],
      sha: ["string", "Turn auto-merge on only if the head is still this commit (409 if it moved)."],
    },
  },
  "DELETE /repos/{owner}/{repo}/pulls/{number}/auto-merge": {
    summary: "Disable auto-merge",
    description: "GitHub's `disablePullRequestAutoMerge`. Anyone with write access may turn it off, whoever turned it on; a workflow token needs `contents: write`. 204 even when it was off, which records nothing. Otherwise it records an `auto_merge_disabled` event, sends a `pull_request` webhook with that action, and is audited as `pull_request.auto_merge_disabled`.",
    access: "write",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/pulls/{number}/reviews": { summary: "List reviews", access: "read" },
  "POST /repos/{owner}/{repo}/pulls/{number}/reviews": {
    summary: "Submit a review",
    description:
      "Only people's approvals count toward required approvals: agents' and workflows' don't. A workflow's `GITHUB_TOKEN` can approve or request changes only when the repository allows it (`can_approve_pull_request_reviews`); otherwise 403.",
    access: "read",
    status: 201,
    body: {
      event: ["string", "`APPROVE`, `REQUEST_CHANGES` or `COMMENT` (default)."],
      body: ["string", "Review summary."],
      comments: ["array", "Line comments: `{ path, line, side: \"LEFT\" | \"RIGHT\", body }`."],
    },
  },
  "GET /repos/{owner}/{repo}/pulls/{number}/reviews/{id}": { summary: "Get a review", description: "`id` is the numeric id or Diffinery's own.", access: "read" },
  "PUT /repos/{owner}/{repo}/pulls/{number}/reviews/{id}/dismissals": {
    summary: "Dismiss a review",
    description: "Only approvals and change requests can be dismissed. Needs maintain access; agents and the pull request's author can't dismiss. `event` is ignored. Returns the review.",
    access: "maintain",
    body: { message: ["string", "Why the review is dismissed.", true] },
  },
  "GET /repos/{owner}/{repo}/pulls/{number}/comments": { summary: "List review comments", description: "Line comments from reviews.", access: "read", query: { ...page } },
  "POST /repos/{owner}/{repo}/pulls/{number}/comments": {
    summary: "Create a review comment",
    description:
      "Adds one line comment as its own `COMMENTED` review, on the current head; `commit_id` is ignored and `position` is read as a line number, not a diff position. Multi-line comments aren't supported. With `in_reply_to`, replies to that comment instead. 422 on a closed pull request.",
    access: "read",
    status: 201,
    body: {
      body: ["string", "Markdown body.", true],
      path: ["string", "File path (required unless replying)."],
      line: ["integer", "Line number (required unless replying)."],
      side: ["string", "`RIGHT` (default) or `LEFT`."],
      position: ["integer", "Used as `line` when `line` is missing."],
      commit_id: ["string", "Accepted and ignored."],
      in_reply_to: ["integer", "Review comment id to reply to; its path and line are used."],
    },
  },
  "POST /repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies": {
    summary: "Reply to a review comment",
    description: "Adds a reply on the same line, as its own `COMMENTED` review.",
    access: "read",
    status: 201,
    body: { body: ["string", "Markdown body.", true] },
  },
  "GET /repos/{owner}/{repo}/pulls/comments": {
    summary: "List review comments in a repository",
    access: "read",
    query: {
      since: ["string", "Only comments updated at or after this ISO timestamp."],
      sort: ["string", "`created` (default) or `updated`."],
      direction: ["string", "`asc` (default) or `desc`."],
      ...page,
    },
  },
  "GET /repos/{owner}/{repo}/pulls/comments/{id}": { summary: "Get a review comment", access: "read" },
  "PATCH /repos/{owner}/{repo}/pulls/comments/{id}": {
    summary: "Edit a review comment",
    description: "Your own comments, or anyone's with maintain access.",
    access: "read",
    body: { body: ["string", "New Markdown body.", true] },
  },
  "DELETE /repos/{owner}/{repo}/pulls/comments/{id}": { summary: "Delete a review comment", description: "Your own comments, or anyone's with maintain access.", access: "read", status: 204 },
  ...reactionDocs("/repos/{owner}/{repo}/pulls/comments/{id}", "a review comment"),
  "GET /repos/{owner}/{repo}/pulls/{number}/requested_reviewers": { summary: "List requested reviewers", description: "Returns `{ users, teams }`; `teams` is always empty.", access: "read" },
  "POST /repos/{owner}/{repo}/pulls/{number}/requested_reviewers": {
    summary: "Request reviewers",
    description: "The author, or anyone with triage access. Team reviewers aren't supported: a non-empty `team_reviewers` fails with 422. Sends the `pull_request` webhook (`review_requested`). Returns the pull request.",
    access: "read",
    status: 201,
    body: { reviewers: ["string[]", "Logins."], team_reviewers: ["string[]", "Must be empty or absent."] },
  },
  "DELETE /repos/{owner}/{repo}/pulls/{number}/requested_reviewers": {
    summary: "Remove requested reviewers",
    description: "The author, or anyone with triage access. Teams aren't supported. Returns the pull request.",
    access: "read",
    body: { reviewers: ["string[]", "Logins to remove."] },
  },

  // ------------------------------------------------------------ commit statuses
  "POST /repos/{owner}/{repo}/statuses/{sha}": {
    summary: "Create a commit status",
    description:
      "`sha` may also be a branch or tag. Statuses show with the checks, and a required check in branch protection can name a `context`; one account's status never replaces another's for that. At most 1000 statuses per commit and context. Sends the `status` webhook. See [Checks and statuses](/docs/collaboration/checks-and-statuses).",
    access: "write",
    status: 201,
    body: {
      state: ["string", "`error`, `failure`, `pending` or `success`.", true],
      target_url: ["string", "http(s) link to details."],
      description: ["string", "Short description (cut at 1024 characters)."],
      context: ["string", "Label that tells statuses apart (default `default`)."],
    },
  },
  "GET /repos/{owner}/{repo}/commits/{ref}/statuses": { summary: "List commit statuses", description: "Every status for the commit, newest first, including older ones for the same context.", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/statuses/{ref}": { summary: "List commit statuses for a ref", description: "Same as `GET /repos/{owner}/{repo}/commits/{ref}/statuses`.", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/commits/{ref}/status": {
    summary: "Get the combined status",
    description: "The latest status per context and an overall `state`: `failure` if any is `error` or `failure`, `pending` if any is pending or there are none, else `success`. Check runs aren't included.",
    access: "read",
    query: { per_page: ["integer", "Statuses per page (default 100, at most 100)."], page: page.page! },
  },

  // ------------------------------------------------------------ checks
  "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": { summary: "List check runs for a commit", access: "read" },
  "GET /repos/{owner}/{repo}/check-runs/{id}": { summary: "Get a check run", description: "`id` is the numeric id, Diffinery's own, or the id of the Actions job that reports it (a job's `check_run_url` points here).", access: "read" },
  "PATCH /repos/{owner}/{repo}/check-runs/{id}": {
    summary: "Update a check run",
    description:
      "Only the account that created the check run can update it, and runs from Diffinery Actions can't be changed. A `conclusion` completes the run. Annotations add to the existing ones (50 per request, 1000 in all).",
    access: "write",
    body: {
      name: ["string", "New name."],
      status: ["string", "`queued`, `in_progress`, `completed`, `waiting`, `requested` or `pending`."],
      conclusion: ["string", "`action_required`, `cancelled`, `failure`, `neutral`, `success`, `skipped`, `stale` or `timed_out`."],
      details_url: ["string", "http(s) link to more detail."],
      external_id: ["string", "Your own reference for the run."],
      started_at: ["string", "ISO timestamp."],
      completed_at: ["string", "ISO timestamp."],
      output: ["object", "`{ title, summary, text, annotations }`."],
    },
  },
  "GET /repos/{owner}/{repo}/check-runs/{id}/annotations": { summary: "List check run annotations", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/commits/{ref}/check-suites": {
    summary: "List check suites for a commit",
    description: "Diffinery derives check suites from check runs: one per workflow run, and one per app (id `app-{app}-{sha}`) for external check runs. `head_branch` is always null and `pull_requests` empty.",
    access: "read",
    query: { ...page },
  },
  "GET /repos/{owner}/{repo}/check-suites/{id}": { summary: "Get a check suite", description: "`id` is a workflow run id or `app-{app}-{sha}`.", access: "read" },
  "GET /repos/{owner}/{repo}/check-suites/{id}/check-runs": { summary: "List a check suite's check runs", access: "read", query: { ...page } },
  "POST /repos/{owner}/{repo}/check-runs": {
    summary: "Create or update a check run",
    description: "For external CI and integrations. A check with the same name on the same commit is updated. Required checks in branch protection can name it.",
    access: "write",
    status: 201,
    body: {
      name: ["string", "Check name.", true],
      head_sha: ["string", "Commit the check is for.", true],
      status: ["string", "`queued` (default), `in_progress` or `completed`."],
      conclusion: ["string", "With `completed`: `success`, `failure`, `neutral`, `cancelled`, `skipped` or `timed_out`."],
      details_url: ["string", "Link to more detail."],
      output: ["object", "`{ title, summary }`."],
    },
  },

  // ------------------------------------------------------------ deployments
  "GET /repos/{owner}/{repo}/deployments": {
    summary: "List deployments",
    description: "Newest first. Each filter matches exactly.",
    access: "read",
    query: {
      sha: ["string", "Full commit SHA."],
      ref: ["string", "Ref, as given when the deployment was created."],
      task: ["string", "Task name."],
      environment: ["string", "Environment name."],
      ...page,
    },
  },
  "POST /repos/{owner}/{repo}/deployments": {
    summary: "Create a deployment",
    description:
      "Unless `required_contexts` is `[]`, every check and status on the commit (or each context you name) must have passed, else 409; checks and statuses reported by agents don't count toward the default set. Creates the environment if needed and sends the `deployment` webhook. Environment names are case-insensitive: an existing environment keeps its spelling, and any spelling of `production` is a production environment. `auto_merge` is ignored. See [Environments](/docs/actions/environments).",
    access: "write",
    status: 201,
    body: {
      ref: ["string", "Branch, tag or commit to deploy.", true],
      task: ["string", "Task name (default `deploy`)."],
      payload: ["object", "Extra data for the deployer (a string is kept as is)."],
      environment: ["string", "Environment name (default `production`)."],
      description: ["string", "Short description."],
      transient_environment: ["boolean", "Transient deployments aren't made inactive by later successful ones."],
      production_environment: ["boolean", "Default: true when the environment is `production`."],
      required_contexts: ["string[]", "Contexts that must have passed; `[]` skips the check."],
    },
  },
  "GET /repos/{owner}/{repo}/deployments/{id}": { summary: "Get a deployment", access: "read" },
  "DELETE /repos/{owner}/{repo}/deployments/{id}": {
    summary: "Delete a deployment",
    description: "Refused with 422 while its latest status is `success`, unless it is the only deployment in its environment. Deletes its statuses too.",
    access: "write",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/deployments/{id}/statuses": { summary: "List deployment statuses", description: "Newest first.", access: "read", query: { ...page } },
  "POST /repos/{owner}/{repo}/deployments/{id}/statuses": {
    summary: "Create a deployment status",
    description:
      "A `success` status marks older successful deployments to the same environment inactive (except transient and production ones) unless `auto_inactive` is false. A different `environment` moves the deployment there. Sends the `deployment_status` webhook.",
    access: "write",
    status: 201,
    body: {
      state: ["string", "`error`, `failure`, `inactive`, `in_progress`, `queued`, `pending` or `success`.", true],
      log_url: ["string", "http(s) link to the deployment's output."],
      target_url: ["string", "Older name for `log_url`, used when `log_url` is missing."],
      environment_url: ["string", "http(s) link to the deployed environment."],
      description: ["string", "Short description (cut at 140 characters)."],
      environment: ["string", "Move the deployment to this environment."],
      auto_inactive: ["boolean", "`false` keeps older deployments active (default `true`)."],
    },
  },
  "GET /repos/{owner}/{repo}/deployments/{id}/statuses/{status}": { summary: "Get a deployment status", access: "read" },

  // ------------------------------------------------------------ environments
  "GET /repos/{owner}/{repo}/environments": { summary: "List environments", access: "read", query: { ...page } },
  "GET /repos/{owner}/{repo}/environments/{env}": { summary: "Get an environment", access: "read" },
  "PUT /repos/{owner}/{repo}/environments/{env}": {
    summary: "Create or update an environment",
    description:
      "People only; agents can't change environments. Required reviewers and a wait timer hold a job that names the environment before anything starts, until a reviewer approves and the timer has passed. Fields left out keep their values. Audited. See [Required reviewers and wait timers](/docs/actions/environments#required-reviewers-and-wait-timers).",
    access: "admin",
    body: {
      deployment_branch_policy: ["object", "`{ protected_branches, custom_branch_policies }` with exactly one true, or `null` to allow every ref."],
      wait_timer: ["integer", "Minutes a job waits before it deploys, 0 to 43200."],
      reviewers: ["array", "Up to 6 people with access, as `{type: \"User\", id}` (the numeric id the API shows) or `{type: \"User\", login}`. Never agents; Diffinery has no teams. `[]` or `null` removes them."],
      prevent_self_review: ["boolean", "Whoever started a run (or an earlier attempt, or owns the agent that did) can't approve it."],
    },
  },
  "DELETE /repos/{owner}/{repo}/environments/{env}": { summary: "Delete an environment", description: "Deletes its secrets and variables too. People only. Audited.", access: "admin", status: 204 },
  "GET /repos/{owner}/{repo}/environments/{env}/deployment-branch-policies": {
    summary: "List deployment branch policies",
    description: "The branch and tag patterns of an environment with `custom_branch_policies`.",
    access: "read",
    query: { ...page },
  },
  "POST /repos/{owner}/{repo}/environments/{env}/deployment-branch-policies": {
    summary: "Create a deployment branch policy",
    description: "The environment must have `custom_branch_policies`. Tag patterns never match tags last pushed by an agent. People only. Audited.",
    access: "admin",
    body: { name: ["string", "Branch or tag name pattern, like `release/*`.", true], type: ["string", "`branch` (default) or `tag`."] },
  },
  "DELETE /repos/{owner}/{repo}/environments/{env}/deployment-branch-policies/{id}": {
    summary: "Delete a deployment branch policy",
    description: "People only. Audited.",
    access: "admin",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/environments/{env}/secrets": {
    summary: "List environment secrets",
    description: "Names and dates only; values are never returned.",
    access: "admin",
    query: { ...page },
  },
  "GET /repos/{owner}/{repo}/environments/{env}/secrets/{name}": { summary: "Get an environment secret", description: "Name and dates only.", access: "admin" },
  "PUT /repos/{owner}/{repo}/environments/{env}/secrets/{name}": {
    summary: "Set an environment secret",
    description:
      "People only. Names are upper-cased, and `GITHUB_` names are refused. The value is encrypted at rest; GitHub's sealed-box `encrypted_value` isn't supported. The first secret on an environment without a branch policy limits it to protected branches. Returns 201 for a new secret and 204 for a replaced one. Audited.",
    access: "admin",
    status: 201,
    body: { value: ["string", "Secret value.", true] },
  },
  "DELETE /repos/{owner}/{repo}/environments/{env}/secrets/{name}": { summary: "Delete an environment secret", description: "People only. Audited.", access: "admin", status: 204 },
  "GET /repos/{owner}/{repo}/environments/{env}/variables": {
    summary: "List environment variables",
    access: "write",
    query: { per_page: ["integer", "Results per page (default 10, at most 100)."], page: page.page! },
  },
  "GET /repos/{owner}/{repo}/environments/{env}/variables/{name}": { summary: "Get an environment variable", access: "write" },
  "POST /repos/{owner}/{repo}/environments/{env}/variables": {
    summary: "Create an environment variable",
    description: "409 when it exists. Names are upper-cased, and `GITHUB_` names are refused. People only. Audited as `environment.variable.set`.",
    access: "admin",
    status: 201,
    body: { name: ["string", "Variable name.", true], value: ["string", "Variable value.", true] },
  },
  "PATCH /repos/{owner}/{repo}/environments/{env}/variables/{name}": {
    summary: "Update an environment variable",
    description: "People only. Renaming onto a name that exists fails with 409. Audited as `environment.variable.set`.",
    access: "admin",
    status: 204,
    body: { name: ["string", "New name (renames the variable)."], value: ["string", "New value."] },
  },
  "DELETE /repos/{owner}/{repo}/environments/{env}/variables/{name}": { summary: "Delete an environment variable", description: "People only. Audited as `environment.variable.delete`.", access: "admin", status: 204 },

  // ------------------------------------------------------------ actions
  "GET /repos/{owner}/{repo}/actions/workflows": { summary: "List workflows", description: "Each workflow file with its triggers, and parse errors for invalid ones (`state: invalid`).", access: "read" },
  "GET /repos/{owner}/{repo}/actions/workflows/{workflow}": {
    summary: "Get a workflow",
    description: "`workflow` is the file path or file name; the response's `id` is the path. `created_at` and `updated_at` are the time of the request, not of the file.",
    access: "read",
  },
  "GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs": {
    summary: "List a workflow's runs",
    description: "No `Link` header; page with `total_count`.",
    access: "read",
    query: {
      branch: ["string", "Head branch."],
      status: ["string", "Run status or conclusion."],
      event: ["string", "Triggering event."],
      head_sha: ["string", "Head commit."],
      ...page,
    },
  },
  "POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches": {
    summary: "Run a workflow (workflow_dispatch)",
    description: "`workflow` is the file path or name, URL-encoded, like `.github%2Fworkflows%2Fdeploy.yml` or `deploy.yml`. Returns the new run's id. Fails with 429 when the repository already has 500 unfinished workflow runs.",
    access: "write",
    status: 201,
    body: { ref: ["string", "Branch or tag to run on.", true], inputs: ["object", "Values for `on.workflow_dispatch.inputs`."] },
  },
  "POST /repos/{owner}/{repo}/actions/runners/registration-token": {
    summary: "Create a runner registration token",
    description: "As on GitHub: a `drg_` token that registers any number of self-hosted runners with this repository for an hour. Returns `{ token, expires_at }`. People only: agents, job tokens and sandbox tokens get 403 `only repository admins can add self-hosted runners`. Audited as `runner.registration_token`. See /docs/actions/runners#manage-runners.",
    access: "admin",
    status: 201,
  },
  "POST /repos/{owner}/{repo}/actions/runners/register": {
    summary: "Register a self-hosted runner",
    description: "Trades a registration token for the runner's own `drn_` token, shown once, which can claim this repository's jobs and nothing else. No `Authorization` header: the registration token is the credential. A wrong or expired token, or a repository that doesn't exist, gets 401 `invalid or expired registration token`. At most 100 runners per repository and 20 labels per runner (429 past the runner limit). Returns `{ id, name, labels, ephemeral, token }`. Audited as `runner.register`, with the admin who created the registration token as the actor.",
    access: "public",
    status: 201,
    body: {
      registration_token: ["string", "A `drg_` token from `POST .../actions/runners/registration-token`.", true],
      name: ["string", "Runner name (default `runner`)."],
      labels: ["string[]", "Labels the runner offers, matched against `runs-on`."],
      ephemeral: ["boolean", "`true` for a single job: the runner's token stops working once it takes a job, and the runner is removed when the job finishes."],
    },
  },
  "GET /repos/{owner}/{repo}/actions/runners": {
    summary: "List self-hosted runners",
    description: "GitHub's shape: `{ total_count, runners }`, each with `id`, `name`, `os`, `status` (`online` when it polled in the last 90 seconds, otherwise `offline`), `busy`, `ephemeral` and `labels`.",
    access: "admin",
  },
  "DELETE /repos/{owner}/{repo}/actions/runners/{id}": {
    summary: "Remove a self-hosted runner",
    description: "Its runner token stops working at once. A job it is running carries on with its own job token. Audited as `runner.remove`.",
    access: "admin",
    status: 204,
  },
  "POST /repos/{owner}/{repo}/actions/runners/claim": {
    summary: "Claim a job for a self-hosted runner",
    description: "Used by `diffinery runner`. Send the runner's `drn_` token and an empty body: the runner offers the name and labels it registered with. Only registered runners claim: a personal token, even a repository admin's, gets 403 `personal tokens can't claim jobs; register this runner: ...`. Returns 204 when no queued job matches the labels, otherwise the job with a fresh job token. See /docs/actions/runners.",
    access: "admin",
  },
  "GET /repos/{owner}/{repo}/actions/runs": {
    summary: "List workflow runs",
    access: "read",
    query: {
      workflow: ["string", "Workflow file path."],
      branch: ["string", "Head branch."],
      status: ["string", "Run status or conclusion."],
      event: ["string", "Triggering event."],
      head_sha: ["string", "Head commit."],
      per_page: ["integer", "Results per page (default 25, at most 100)."],
      page: ["integer", "Page number, starting at 1."],
    },
  },
  "GET /repos/{owner}/{repo}/actions/runs/{id}": {
    summary: "Get a workflow run",
    description: "The run with its jobs. `id` is the run's id, or its number (`github.run_id` in workflows), which picks the latest attempt.",
    access: "read",
  },
  "GET /repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}": {
    summary: "Get a run attempt",
    description: "Re-runs are stored as separate runs with the same run number; this returns attempt `attempt` of the run's number.",
    access: "read",
  },
  "GET /repos/{owner}/{repo}/actions/runs/{id}/logs": {
    summary: "Download a run's logs",
    description: "A zip with one text file per job. Jobs past 24 MB of logs in total are left out.",
    access: "read",
  },
  "DELETE /repos/{owner}/{repo}/actions/runs/{id}/logs": {
    summary: "Delete a run's logs",
    description: "Deletes every job's log and step summary for good; the run, its jobs, checks and artifacts stay. Only for a finished run (409 otherwise). An agent can delete only the logs of runs that didn't run on the default branch or a protected branch, and a workflow's `GITHUB_TOKEN` can't delete logs (403). Audited as `repo.actions.logs.delete`.",
    access: "write",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/actions/runs/{id}/jobs": { summary: "List a run's jobs", description: "Each job as `GET .../actions/jobs/{id}` returns it, with `runner`, `placementTries` and `restarts`.", access: "read" },
  "GET /repos/{owner}/{repo}/actions/runs/{id}/pending_deployments": {
    summary: "List the environments a run waits on",
    description: "Environments whose required reviewers or wait timer hold the run's jobs, with `current_user_can_approve` for the caller. See [Required reviewers and wait timers](/docs/actions/environments#required-reviewers-and-wait-timers).",
    access: "read",
  },
  "POST /repos/{owner}/{repo}/actions/runs/{id}/pending_deployments": {
    summary: "Approve or reject a run's pending deployments",
    description:
      "Only a listed reviewer, signed in or with a `write` token: never an agent, a workflow's token or a sandbox token (403). With `prevent_self_review`, not whoever started the run (403). One decision per environment and run counts; 422 when nothing waits. Approved jobs start once their wait timer has passed; rejected ones fail. Returns the deployments of the jobs that were waiting. Audited as `deployment.approve` or `deployment.reject`.",
    access: "read",
    body: {
      environment_ids: ["array", "Ids of the environments to decide.", true],
      state: ["string", "`approved` or `rejected`.", true],
      comment: ["string", "Shown with the decision and in the audit log."],
    },
  },
  "GET /repos/{owner}/{repo}/actions/runs/{id}/approvals": { summary: "List a run's deployment reviews", description: "Each reviewer's decision, with the environment and comment.", access: "read" },
  "POST /repos/{owner}/{repo}/actions/runs/{id}/cancel": { summary: "Cancel a run", access: "write", status: 202 },
  "POST /repos/{owner}/{repo}/actions/runs/{id}/rerun": {
    summary: "Re-run a workflow run",
    description: "Starts a new attempt that runs every job again. Answers `{ run_id }`, the new attempt's id. A workflow's `GITHUB_TOKEN` can't re-run workflows (403).",
    access: "write",
    status: 201,
    body: { enable_debug_logging: ["boolean", "Accepted and ignored."] },
  },
  "POST /repos/{owner}/{repo}/actions/runs/{id}/rerun-failed-jobs": {
    summary: "Re-run a run's failed jobs",
    description:
      "Starts a new attempt that runs the jobs and matrix legs that failed, were cancelled or timed out, and every job that depends on them. The others are kept from the earlier attempt as they were, with their logs and artifacts. Answers `{ run_id }`, the new attempt's id. 409 `this run has no failed jobs to re-run`, or when the run hasn't finished. A workflow's `GITHUB_TOKEN` can't re-run workflows (403).",
    access: "write",
    status: 201,
    body: { enable_debug_logging: ["boolean", "Accepted and ignored."] },
  },
  "GET /repos/{owner}/{repo}/actions/jobs/{id}": { summary: "Get a job", description: "The job with its steps. GitHub's job fields, plus Diffinery's own: `runner` (the hosted container's `image`, `location` and `instance`; `null` on a self-hosted runner) and `placementTries` (how many times a hosted job went back in line before a runner took it: no free container, or a runner on a replaced image) and `restarts` (how many times it started over because the platform replaced its runner before its steps ran). See /docs/actions/runners.", access: "read" },
  "POST /repos/{owner}/{repo}/actions/jobs/{id}/rerun": {
    summary: "Re-run a job",
    description:
      "Starts a new attempt of the job's run that runs this job (this matrix leg) and every job that depends on it; the other jobs are kept from the earlier attempt as they were. Answers `{ run_id }`, the new attempt's id. 409 when the run hasn't finished. A workflow's `GITHUB_TOKEN` can't re-run workflows (403).",
    access: "write",
    status: 201,
    body: { enable_debug_logging: ["boolean", "Accepted and ignored."] },
  },
  "GET /repos/{owner}/{repo}/actions/jobs/{id}/logs": {
    summary: "Get a job's logs",
    description: "Plain text, one timestamped line each, or JSON with `format=json`.",
    access: "read",
    query: { format: ["string", "`json` for an array of `{ t, text }` lines."], after: ["integer", "Only lines after this sequence number (for following a live log)."] },
  },
  "GET /repos/{owner}/{repo}/actions/runs/{runId}/artifacts": {
    summary: "List a run's artifacts",
    description:
      "Newest first, in the same shape as `GET /repos/{owner}/{repo}/actions/artifacts`. `runId` is the run's id, or its number (`github.run_id` in workflows), which covers every attempt of the run. Expired artifacts are listed with `expired: true`; their content is gone.",
    access: "read",
    query: { name: ["string", "Only artifacts with exactly this name."], ...page },
  },
  "GET /repos/{owner}/{repo}/actions/artifacts": {
    summary: "List artifacts",
    description:
      "Every artifact in the repository, newest first. Each has a numeric `id`, `name`, `size_in_bytes`, `digest` (`sha256:...` when the uploader sent one), `created_at`, `expires_at`, `expired`, an `archive_download_url`, and `workflow_run` (its `id` is the run number). An artifact past its retention stays listed with `expired: true` for 90 more days; its content is already deleted. Returns `{ total_count, artifacts }`.",
    access: "read",
    query: { name: ["string", "Only artifacts with exactly this name."], ...page },
  },
  "GET /repos/{owner}/{repo}/actions/artifacts/{id}": { summary: "Get an artifact", description: "`id` is the artifact's numeric id. Expired artifacts are returned too, with `expired: true`.", access: "read" },
  "GET /repos/{owner}/{repo}/actions/artifacts/{id}/{format}": {
    summary: "Download an artifact",
    description:
      "`format` must be `zip` (anything else is 404). Redirects with 302 to a signed URL that works for 10 minutes and needs no token; follow redirects (`curl -L`). The content is a zip, or the file itself for an artifact uploaded as a single unzipped file. 410 `Artifact has expired` once the artifact has expired.",
    access: "read",
    status: 302,
  },
  "DELETE /repos/{owner}/{repo}/actions/artifacts/{id}": {
    summary: "Delete an artifact",
    description: "Deletes the artifact and its content, expired or not; it no longer counts toward the repository's artifact quota. 404 when there is no artifact with that id. Audited as `actions.artifact.delete`.",
    access: "write",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/actions/caches": {
    summary: "List caches",
    description:
      "Saved cache entries; uploads in progress aren't listed. Each has a numeric `id`, `key`, `version`, `ref` (the ref it was saved for, like `refs/heads/main`), `size_in_bytes`, `created_at` and `last_accessed_at`. Returns `{ total_count, actions_caches }`.",
    access: "read",
    query: {
      key: ["string", "Only entries whose key starts with this."],
      ref: ["string", "Only entries saved for this full ref, like `refs/heads/main`."],
      sort: ["string", "`last_accessed_at` (default), `created_at` or `size_in_bytes`."],
      direction: ["string", "`desc` (default) or `asc`."],
      ...page,
    },
  },
  "DELETE /repos/{owner}/{repo}/actions/caches": {
    summary: "Delete caches by key",
    description:
      "Deletes every entry whose key is exactly `key` (all versions), or only those saved for `ref`. Returns the deleted entries as `{ total_count, actions_caches }`. 422 `key is required` without `key`, 404 when nothing matched. Audited as `actions.cache.delete`.",
    access: "write",
    query: { key: ["string", "The exact cache key.", true], ref: ["string", "Only entries saved for this full ref, like `refs/heads/main`."] },
  },
  "DELETE /repos/{owner}/{repo}/actions/caches/{id}": {
    summary: "Delete a cache",
    description: "By the entry's numeric id. 404 when there is none. Audited as `actions.cache.delete`.",
    access: "write",
    status: 204,
  },
  "GET /repos/{owner}/{repo}/actions/cache/usage": {
    summary: "Get cache usage",
    description: "`full_name`, `active_caches_size_in_bytes` and `active_caches_count` of the saved entries. A repository keeps up to 10 GB of caches; see [Limits](/docs/reference/limits#caches-and-artifacts).",
    access: "read",
  },
  "GET /repos/{owner}/{repo}/actions/permissions/workflow": {
    summary: "Get workflow token permissions",
    description:
      "The defaults for the `GITHUB_TOKEN` of the repository's workflows (GitHub's \"Workflow permissions\" setting). `default_workflow_permissions` is what a job without `permissions:` gets: `read` (contents and packages read, nothing else) or `write` (read and write on every scope except `id-token`). `can_approve_pull_request_reviews` says whether job tokens may open pull requests and approve or request changes. `agent_runs_use_secrets` (a Diffinery addition, `false` by default) says whether runs of code an agent wrote get the repository's and organization's secrets. New repositories start with `read` and `false`; repositories created before the setting existed have `write` and `false`. See [Workflow permissions](/docs/actions/workflow-permissions).",
    access: "admin",
  },
  "PUT /repos/{owner}/{repo}/actions/permissions/workflow": {
    summary: "Set workflow token permissions",
    description:
      "Send only what changes. People only: agents get 403 `only people can change what workflows are allowed to do`. Applies to jobs that start afterwards. Each change is audited as `repo.actions_workflow_settings`. Even when allowed, a workflow's approval never counts toward required approvals.",
    access: "admin",
    status: 204,
    body: {
      default_workflow_permissions: ["string", "`read` or `write`."],
      can_approve_pull_request_reviews: ["boolean", "Allow workflows' `GITHUB_TOKEN` to open pull requests and to approve or request changes."],
      agent_runs_use_secrets: ["boolean", "Give runs of code an agent wrote (an agent triggered the run, pushed its branch last, or opened or pushed to its pull request) the repository's and organization's secrets. Default `false`."],
    },
  },
  "GET /repos/{owner}/{repo}/actions/secrets": { summary: "List repository secrets", description: "Names and update times only; values are never returned.", access: "admin" },
  "PUT /repos/{owner}/{repo}/actions/secrets/{name}": {
    summary: "Set a repository secret",
    description: "People only. The value is encrypted at rest. GitHub's sealed-box `encrypted_value` isn't supported; send `value` over HTTPS. Audited as `repo.secret.set`.",
    access: "admin",
    status: 204,
    body: { value: ["string", "Secret value.", true] },
  },
  "DELETE /repos/{owner}/{repo}/actions/secrets/{name}": { summary: "Delete a repository secret", description: "People only. Audited as `repo.secret.delete`.", access: "admin", status: 204 },
  "GET /repos/{owner}/{repo}/actions/variables": {
    summary: "List repository variables",
    description: "The repository's own variables. Workflows in an organization's repositories also see the organization's variables (`GET /orgs/{org}/actions/variables`), and a repository variable with the same name wins.",
    access: "write",
    query: { ...page },
  },
  "POST /repos/{owner}/{repo}/actions/variables": {
    summary: "Create a repository variable",
    description: "409 when the repository already has a variable with this name. An organization variable of the same name doesn't count, and the repository's wins in workflows. Names are stored upper-cased. People only. Audited as `repo.variable.set`.",
    access: "admin",
    status: 201,
    body: { name: ["string", "Variable name.", true], value: ["string", "Variable value.", true] },
  },
  "GET /repos/{owner}/{repo}/actions/variables/{name}": { summary: "Get a repository variable", description: "404 for a name only the organization has. `created_at` and `updated_at` are always null.", access: "write" },
  "PATCH /repos/{owner}/{repo}/actions/variables/{name}": {
    summary: "Update a repository variable",
    description: "404 when the repository has no variable with this name; organization variables aren't changed here. People only. Renaming onto a name that exists fails with 409. Audited as `repo.variable.set`.",
    access: "admin",
    status: 204,
    body: { name: ["string", "New name (renames the variable)."], value: ["string", "New value."] },
  },
  "PUT /repos/{owner}/{repo}/actions/variables/{name}": {
    summary: "Set a repository variable",
    description: "Diffinery's form: creates the variable or replaces its value. GitHub clients use `POST` and `PATCH`. Names are stored upper-cased. People only. Audited as `repo.variable.set`.",
    access: "admin",
    status: 204,
    body: { value: ["string", "Variable value.", true] },
  },
  "DELETE /repos/{owner}/{repo}/actions/variables/{name}": {
    summary: "Delete a repository variable",
    description: "People only. Names are matched without regard to letter case. Audited as `repo.variable.delete`.",
    access: "admin",
    status: 204,
  },
  "GET /orgs/{org}/actions/secrets": { summary: "List organization secrets", description: "Names, update times and `visibility` (`all`, `private` or `selected`), never values.", access: "org-admin" },
  "GET /orgs/{org}/actions/secrets/{name}": { summary: "Get an organization secret", description: "Its name, update time and `visibility`, never the value. 404 when there is no such secret.", access: "org-admin" },
  "PUT /orgs/{org}/actions/secrets/{name}": {
    summary: "Set an organization secret",
    description: "Creates or updates the secret. `visibility` says which of the organization's repositories get it: `all` (the default for a new secret), `private` (private and internal ones) or `selected` (those in `selected_repository_ids`). An update without them keeps the secret's visibility and selection. Names are upper-cased and must match `[A-Z_][A-Z0-9_]*`. People only. Audited as `org.secret.set`. See /docs/actions/secrets-and-variables#organization-secrets.",
    access: "org-admin",
    status: 204,
    body: {
      value: ["string", "Secret value.", true],
      visibility: ["string", "`all`, `private` or `selected` (422 otherwise)."],
      selected_repository_ids: ["integer[]", "With `selected`: the repositories' numeric ids. An id that isn't one of the organization's repositories gets 422."],
    },
  },
  "GET /orgs/{org}/actions/secrets/{name}/repositories": { summary: "List a secret's selected repositories", description: "`{ total_count, repositories }` for a secret with `visibility: selected`; 409 `the secret's visibility isn't selected` otherwise.", access: "org-admin" },
  "PUT /orgs/{org}/actions/secrets/{name}/repositories": {
    summary: "Replace a secret's selected repositories",
    description: "Only for a secret with `visibility: selected` (409 otherwise). A repository that leaves the selection stops getting the secret from its next job. Audited as `org.secret.repositories`.",
    access: "org-admin",
    status: 204,
    body: { selected_repository_ids: ["integer[]", "Every repository that should get the secret.", true] },
  },
  "PUT /orgs/{org}/actions/secrets/{name}/repositories/{repoId}": { summary: "Add a repository to a secret's selection", description: "Only for a secret with `visibility: selected` (409 otherwise). `repoId` is the repository's numeric id. Audited as `org.secret.repository.add`.", access: "org-admin", status: 204 },
  "DELETE /orgs/{org}/actions/secrets/{name}/repositories/{repoId}": { summary: "Remove a repository from a secret's selection", description: "Only for a secret with `visibility: selected` (409 otherwise). The repository stops getting the secret from its next job. Audited as `org.secret.repository.remove`.", access: "org-admin", status: 204 },
  "DELETE /orgs/{org}/actions/secrets/{name}": { summary: "Delete an organization secret", description: "People only. 404 when the organization has no secret with this name. Audited as `org.secret.delete`.", access: "org-admin", status: 204 },
  "GET /orgs/{org}/actions/variables": {
    summary: "List organization variables",
    description:
      "Actions variables shared by every repository of the organization: workflows read them as `vars.NAME`, and a repository variable with the same name wins. Returns `total_count` and every variable (no paging) with `name`, `value`, `visibility` (always `all`), `created_at` and `updated_at`. Organization owners and admins who are people (agents get 403 `organization admins only`); anyone outside the organization gets 404.",
    access: "org-admin",
  },
  "POST /orgs/{org}/actions/variables": {
    summary: "Create an organization variable",
    description:
      "Creates the variable, or replaces the value of one with that name (GitHub answers 409 instead). Names are stored upper-cased; they must start with a letter or `_`, contain only letters, digits and `_`, and not start with `GITHUB_` (422 `invalid variable name`). Values are strings of at most 49,152 characters (422 `value must be a string of at most 48 KB`). GitHub's `visibility` and `selected_repository_ids` are ignored: every repository of the organization gets the variable. People only. Audited as `org.variable_set`.",
    access: "org-admin",
    status: 201,
    body: { name: ["string", "Variable name.", true], value: ["string", "Variable value, at most 49,152 characters.", true] },
  },
  "GET /orgs/{org}/actions/variables/{name}": { summary: "Get an organization variable", description: "`name` is matched in upper case. 404 `variable not found`. Organization owners and admins who are people.", access: "org-admin" },
  "PATCH /orgs/{org}/actions/variables/{name}": {
    summary: "Update an organization variable",
    description: "Sets the value, creating the variable if it doesn't exist. Renaming isn't supported: a `name` in the body is ignored. Same name and value rules as creating. People only. Audited as `org.variable_set`.",
    access: "org-admin",
    status: 204,
    body: { value: ["string", "New value, at most 49,152 characters.", true] },
  },
  "DELETE /orgs/{org}/actions/variables/{name}": { summary: "Delete an organization variable", description: "404 when the organization has no variable with this name, and nothing is audited. People only. Audited as `org.variable_delete`.", access: "org-admin", status: 204 },

  // ------------------------------------------------------------ webhooks
  "GET /repos/{owner}/{repo}/hooks": { summary: "List webhooks", description: "Secrets are never returned.", access: "admin" },
  "POST /repos/{owner}/{repo}/hooks": {
    summary: "Create a webhook",
    description: "`config.url` must be `https://` to a public host: `localhost`, single-label, `.local` and `.internal` names, private, loopback and link-local addresses get 422 `webhook URL must be a public host`, and Diffinery's own host 422 `webhook URL can't point at Diffinery itself`. At most 20 webhooks per repository (422). Audited as `repo.webhook.create`.",
    access: "admin",
    status: 201,
    body: { config: ["object", "`{ url, secret }`. The secret signs each delivery (`X-Hub-Signature-256`).", true], events: ["string[]", "Event names, or `[\"*\"]` (default) for all."] },
  },
  "DELETE /repos/{owner}/{repo}/hooks/{id}": { summary: "Delete a webhook", description: "Audited as `repo.webhook.delete`.", access: "admin", status: 204 },

  // ------------------------------------------------------------ notifications and email
  "GET /notifications": { summary: "List notifications", description: "A token limited to repositories answers 403 `this token is limited to repositories and can't read notifications`, since notifications cover every repository.", access: "account", query: { all: ["boolean", "`true` to include read ones."] } },
  "PUT /notifications": { summary: "Mark all notifications as read", access: "account", status: 205 },
  "GET /repos/{owner}/{repo}/subscription": { summary: "Get your watch setting", description: "404 when you only get participating notifications (the default), as on GitHub.", access: "read" },
  "PUT /repos/{owner}/{repo}/subscription": {
    summary: "Watch or ignore a repository",
    access: "read",
    body: { subscribed: ["boolean", "`true` for all activity, `false` for participating only."], ignored: ["boolean", "`true` to ignore the repository."] },
  },
  "DELETE /repos/{owner}/{repo}/subscription": { summary: "Stop watching a repository", description: "Back to participating notifications.", access: "read", status: 204 },
  "GET /diffinery/notification-settings": { summary: "Get your notification settings", access: "account" },
  "PUT /diffinery/notification-settings": { summary: "Update your notification settings", description: "Send only the groups you want to change. The morning digest is `digest`: `email` (on or off), `hour` (0 to 23), `timeZone` (an IANA time zone such as `Europe/Istanbul` or `UTC`) and `weekends`; 422 for an hour or time zone it can't use. See /docs/agents/today#the-morning-digest.", access: "account" },
  "GET /diffinery/emails": {
    summary: "List emails sent to you",
    access: "account",
    query: { kind: ["string", "Only this kind of email."], since: ["string", "ISO timestamp."], per_page: ["integer", "At most this many (default 50)."], all: ["string", "`1` for everyone's (site admins)."] },
  },
  "POST /diffinery/emails/test": { summary: "Send yourself a test email", description: "At most 5 an hour; more answer 429 `you can send at most 5 test emails an hour; try again later`.", access: "account" },
  "POST /diffinery/emails/digest": { summary: "Send yourself the morning digest now", description: "Your Today digest, sent now even when the digest is off or has nothing in it, covering what happened since the last one. At most 3 an hour; more answer 429. See /docs/agents/today#the-morning-digest.", access: "account" },
  "GET /diffinery/email": {
    summary: "Your email address and whether it is suppressed",
    description: "`suppressed` is null, or why Diffinery sends nothing to your address: `reason` (`hard-bounce`, `complaint` or `manual`), `detail`, `source`, `created_at` and `owner_can_lift`.",
    access: "account",
  },
  "POST /diffinery/email/verification": {
    summary: "Ask for the email that turns email back on",
    description: "When your address is suppressed by a bounce or complaint, sends one email to it, past the suppression list; following its link while signed in lifts the suppression. 409 when it isn't suppressed, 403 for a suppression a site administrator added, at most 3 an hour.",
    access: "account",
  },
  "GET /diffinery/admin/email": { summary: "Email delivery status", description: "Whether sending is configured, whether the signed bounce and complaint endpoint is on (`event_intake`), and counts for the last 24 hours.", access: "site-admin" },
  "GET /diffinery/admin/email/suppressions": { summary: "List suppressed email addresses", description: "Newest first: `email`, `reason` (`hard-bounce`, `complaint` or `manual`), `detail`, `source` (`cloudflare`, `webhook`, `send` or `admin`), `created_by` and `created_at`.", access: "site-admin" },
  "PUT /diffinery/admin/email/suppressions/{email}": { summary: "Suppress an email address", description: "Diffinery sends nothing to it until it is removed. Recorded in the audit log.", access: "site-admin", body: { note: ["string", "Why, kept with the entry."] } },
  "DELETE /diffinery/admin/email/suppressions/{email}": { summary: "Remove an address from the suppression list", description: "Whatever put it there. 404 when it isn't suppressed. Recorded in the audit log.", access: "site-admin", status: 204 },
  "GET /diffinery/admin/security-reports": {
    summary: "List security reports",
    description: "Private vulnerability reports sent through `/security/report`, newest first: `id`, `state` (`new`, `triaged` or `resolved`), `summary`, `details`, `area`, `reply_to`, `reporter` (a login, or null when not signed in), `note`, `updated_by`, `updated_at`, `created_at` and `html_url`. 404 for anyone but a site administrator.",
    access: "site-admin",
    query: { state: ["string", "Only reports in this state: `new`, `triaged` or `resolved`."], per_page: ["integer", "At most this many (default 100, up to 500)."] },
  },
  "GET /diffinery/admin/security-reports/{id}": { summary: "Get a security report", description: "One report, as in the list. 404 when there is none, or for anyone but a site administrator.", access: "site-admin" },
  "PATCH /diffinery/admin/security-reports/{id}": {
    summary: "Triage or resolve a security report",
    description: "Sets the report's state and note (a missing or empty note clears it). Recorded in the audit log as `security_report.triage`, `security_report.resolve` or `security_report.reopen`. 404 for anyone but a site administrator.",
    access: "site-admin",
    body: { state: ["string", "`triaged`, `resolved`, or `new` to reopen it.", true], note: ["string", "For the other site administrators, up to 2,000 characters."] },
  },
  "GET /diffinery/admin/early-access": {
    summary: "List early access requests",
    description:
      "Requests sent through `/early-access`, newest first: `id`, `state` (`unconfirmed` until the address follows the emailed link, then `confirmed`, `invited` or `declined`), `email`, `name`, `company`, `use_case`, `hosting` (`github`, `gitlab`, `bitbucket`, `azure`, `self-hosted`, `other`, `none` or null), `confirmed_at`, `invite_id`, `decided_by`, `decided_at`, `created_at`, `updated_at` and `html_url`. 404 for anyone but a site administrator. See [Early access](/docs/accounts/early-access).",
    access: "site-admin",
    query: { state: ["string", "Only requests in this state: `confirmed`, `unconfirmed`, `invited` or `declined`."], q: ["string", "Only requests whose address, name, company or use contains this text."], per_page: ["integer", "At most this many (default 100, up to 500)."], page: ["integer", "Page number, from 1."] },
  },
  "GET /diffinery/admin/early-access/{id}": { summary: "Get an early access request", description: "One request, as in the list. 404 when there is none, or for anyone but a site administrator.", access: "site-admin" },
  "POST /diffinery/admin/early-access/{id}/invite": {
    summary: "Invite an early access request",
    description:
      "Sends the request's address the instance's usual invitation email (it works once for 14 days) and marks the request `invited`. An address that already has a pending instance invitation keeps it; one that already belongs to an active account is refused (422). Recorded in the audit log as `early_access.invite`, and `invite.create` when a new invitation is sent. 404 for anyone but a site administrator.",
    access: "site-admin",
  },
  "PATCH /diffinery/admin/early-access/{id}": {
    summary: "Decline an early access request, or put it back",
    description: "`declined` declines it; `confirmed` puts a declined request back (as `unconfirmed` if its address never confirmed). Nobody is emailed. Recorded in the audit log as `early_access.decline` or `early_access.restore`. 404 for anyone but a site administrator.",
    access: "site-admin",
    body: { state: ["string", "`declined`, or `confirmed` to put a declined request back.", true] },
  },
  "DELETE /diffinery/admin/early-access/{id}": {
    summary: "Delete an early access request",
    description: "Removes the request, for someone who asks for their data to be removed. An invitation already sent from it stays; revoke it separately. Recorded in the audit log as `early_access.delete`, without the request's content or address. 404 for anyone but a site administrator.",
    access: "site-admin",
    status: 204,
  },
  "GET /diffinery/status": {
    summary: "Get the instance's status",
    description:
      "The status page as JSON, shaped like Statuspage's summary: `status` (`indicator`: `none`, `minor`, `major`, `critical` or `maintenance`, and a `description`), `components` (`id`, `name`, `status`: `operational`, `under_maintenance`, `degraded_performance`, `partial_outage` or `major_outage`, and a `note` when a kill switch or a database failure set it), `incidents` (the unresolved ones, newest first, each with its `updates`, newest first) and `updated_at`. Cached for 30 seconds. See [Status page](/docs/self-hosting/status-page).",
    access: "public",
  },
  "GET /diffinery/admin/status/incidents": {
    summary: "List status incidents",
    description: "Incidents on the status page, newest first, resolved or not: `id`, `title`, `impact`, `state`, `components`, `created_by`, `created_at`, `updated_at`, `resolved_at`, `updates` (each with `id`, `state`, `body`, `author` and `created_at`, newest first) and `html_url`. 404 for anyone but a site administrator.",
    access: "site-admin",
    query: { per_page: ["integer", "At most this many (default 50, up to 200)."] },
  },
  "POST /diffinery/admin/status/incidents": {
    summary: "Open a status incident",
    description: "Opens an incident with its first update and answers with it. While it isn't resolved, its impact sets the status of each component it names: `critical` is a major outage, `major` a partial outage, `minor` degraded performance and `maintenance` under maintenance. Recorded in the audit log as `status_incident.create`. 404 for anyone but a site administrator.",
    access: "site-admin",
    status: 201,
    body: {
      title: ["string", "One line, up to 200 characters.", true],
      impact: ["string", "`minor`, `major`, `critical` or `maintenance`.", true],
      components: ["array", "At least one of `web`, `git`, `actions`, `agents`, `packages` and `email`.", true],
      state: ["string", "`investigating`, `identified`, `monitoring` or `resolved`.", true],
      body: ["string", "The first update, plain text up to 5,000 characters. It is public.", true],
    },
  },
  "POST /diffinery/admin/status/incidents/{id}/updates": {
    summary: "Post an update to a status incident",
    description: "Adds an update and moves the incident to its state; `resolved` resolves it, and any other state reopens a resolved incident. Answers with the incident. Recorded in the audit log as `status_incident.resolve` when it resolves the incident and `status_incident.update` otherwise. 404 when there is no such incident, or for anyone but a site administrator.",
    access: "site-admin",
    status: 201,
    body: { state: ["string", "`investigating`, `identified`, `monitoring` or `resolved`.", true], body: ["string", "Plain text up to 5,000 characters. It is public.", true] },
  },
  "GET /diffinery/admin/scheduler": {
    summary: "Workflow scheduler state",
    description: "`tick_minutes`, `last_tick_at` (when the last check finished), `covered_until` (the last minute whose schedules were started) and `next_tick_at` (null when the timer isn't set). Tells a scheduler that stopped ticking from a run that failed to start.",
    access: "site-admin",
  },
  "GET /diffinery/admin/indexnow": {
    summary: "IndexNow submissions",
    description: "What this instance has told search engines through IndexNow: `enabled` (and `off_reason` when it isn't), `key_location`, how many `site_pages` and public `repositories` it tracks, how many are `queued`, `retry_at` (set after IndexNow refused or couldn't be reached), `repositories_checked_at`, and the newest `submissions` (`at`, `urls`, `status` from IndexNow or null when unreachable, `endpoint` (the host that answered), `ms`, `error`, and the first 50 `paths`). See [Search engines](/docs/admin/site-administration#search-engines).",
    access: "site-admin",
    query: { per_page: ["integer", "Submissions to return (default 50, up to 200)."] },
  },
  "GET /diffinery/admin/errors": {
    summary: "List unexpected server errors",
    description: "The newest answers with a 5xx status, newest first: `id` (the `request_id` the answer carried, also in its `x-request-id` header), `at`, `method`, `route`, `path`, `status`, `message` and `stack`. The newest 500 are kept. No request bodies, query strings or headers are kept, and tokens in a message are masked.",
    access: "site-admin",
    query: { per_page: ["integer", "At most this many (default 100, up to 500)."] },
  },
  "GET /diffinery/admin/errors/{id}": { summary: "Get a server error by its request ID", description: "The error a 5xx answer with this `request_id` recorded; 404 once it is no longer among the newest 500.", access: "site-admin" },
  "POST /diffinery/admin/emails/samples": { summary: "Send yourself every email template", access: "site-admin", body: { only: ["string[]", "Only these sample ids."] } },

  // ------------------------------------------------------------ tokens, agents and sandboxes
  "GET /diffinery/tokens": { summary: "List your tokens", access: "account" },
  "POST /diffinery/tokens": {
    summary: "Create a token",
    description: "From a browser session only: no token can create a token. The token value is returned once. Unknown scopes or an empty list fail with 422, and so does a repository you can't see (`unknown repository owner/name`). From a browser session whose sign-in is more than 2 hours old: 403 `Confirm it's you: sign in with your passkey again to do this.` with a `confirm` URL (see /docs/security/overview#confirming-its-you).",
    access: "account",
    status: 201,
    body: {
      name: ["string", "A name to recognise it by.", true],
      scopes: ["string[]", "`read`, `write` (default) and/or `admin`."],
      repositories: ["string[]", "Restrict to these `owner/name` repositories (only ones you can see)."],
      expires_in_days: ["integer", "Lifetime in days."],
    },
  },
  "DELETE /diffinery/tokens/{id}": { summary: "Revoke a token", access: "account", status: 204 },
  "GET /diffinery/today": {
    summary: "Your morning view",
    description: "Pull requests that need you, your agents' open pull requests with their state, and what merged, was released or failed in the last 24 hours, across the repositories you can see that were active in the last 30 days (at most 100). A token limited to repositories sees only those. See /docs/agents/today.",
    access: "account",
  },
  "GET /diffinery/agents": { summary: "List your agents", description: "Agents you own, and agents of organizations you administer.", access: "account" },
  "POST /diffinery/agents": {
    summary: "Create an agent",
    description: "People, from a browser session only (no token can create a token). Returns the agent and its first token (write scope, 90 days, unless you say otherwise). Unknown scopes or an empty list fail with 422. From a browser session whose sign-in is more than 2 hours old: 403 `Confirm it's you: sign in with your passkey again to do this.` with a `confirm` URL (see /docs/security/overview#confirming-its-you).",
    access: "account",
    status: 201,
    body: {
      login: ["string", "Agent login.", true],
      name: ["string", "Display name."],
      org: ["string", "Organization that owns the agent (default: you)."],
      policy: ["object", "Agent policy."],
      token: ["object", "`{ scopes, expires_in_days }` for the first token."],
      auto_merge: ["boolean", "Turn on auto-merge for the pull requests it opens (see `PUT /diffinery/agents/{login}/auto-merge`)."],
    },
  },
  "POST /diffinery/agents/{login}/tokens": {
    summary: "Create a token for an agent",
    description: "From a browser session only (no token can create a token): the agent's owner, or an owner or admin of the organization that owns it. Default scope `write`; unknown scopes or an empty list fail with 422. Audited as `agent.token.create`. From a browser session whose sign-in is more than 2 hours old: 403 `Confirm it's you: sign in with your passkey again to do this.` with a `confirm` URL (see /docs/security/overview#confirming-its-you).",
    access: "account",
    status: 201,
    body: { name: ["string", "Token name."], scopes: ["string[]", "`read`, `write` (default) and/or `admin`."], expires_in_days: ["integer", "Lifetime in days."] },
  },
  "DELETE /diffinery/agents/{login}": { summary: "Disable an agent", description: "Its tokens stop working.", access: "account", status: 204 },
  "GET /diffinery/auto-merge": {
    summary: "Your auto-merge setting",
    description: "Whether Diffinery turns on auto-merge for the pull requests you open: `{ enabled, merge_method }`, where `merge_method` is `default` (as the branch merges), `merge`, `squash`, `rebase`, or null when off. An agent's token reads the agent's own. See /docs/collaboration/merge-on-green.",
    access: "account",
  },
  "PUT /diffinery/auto-merge": {
    summary: "Turn auto-merge on or off for pull requests you open",
    description:
      "People only. When on, Diffinery turns on auto-merge for you as you open a pull request (or mark your draft ready), wherever its base branch has at least one required check; it merges once every rule of the branch is met, approvals included. The body may also be just `true` or `false`. Returns the setting. Audited as `account.auto_merge`. See /docs/collaboration/merge-on-green.",
    access: "account",
    body: { enabled: ["boolean", "On or off.", true], merge_method: ["string", "`default` (as the branch merges, the default), `merge`, `squash` or `rebase`."] },
  },
  "PUT /diffinery/agents/{login}/auto-merge": {
    summary: "Turn auto-merge on or off for an agent's pull requests",
    description:
      "The agent's owner, or an owner or admin of the organization that owns it. Diffinery then turns on auto-merge, as the agent, for each pull request it opens; it lands only as the agent's own auto-merge would (the repository must allow agents' auto-merge, or the agent may merge what a person approved), and a workflow change still needs a person. Same body as `PUT /diffinery/auto-merge`. Audited as `agent.auto_merge`.",
    access: "account",
    body: { enabled: ["boolean", "On or off.", true], merge_method: ["string", "`default`, `merge`, `squash` or `rebase`."] },
  },
  "POST /repos/{owner}/{repo}/diffinery/agent-setup/checks": {
    summary: "Report an agent setup check",
    description: "What the hosted setup script (`/{owner}/{repo}/agent-setup.sh`, run by `diffinery setup --repo`) sends after its self-test: the Check on Settings → Agent setup. Tokens only, with write access to the repository; browser sessions and workflow tokens get 403. The report is green only when every line passed. Returns `ok` and the page's `html_url`. See [Cloud agent environments](/docs/connect/cloud-agents).",
    access: "write",
    status: 201,
    body: {
      checks: ["object[]", "1 to 30 lines of `{ name, ok, message }`: what was checked, whether it passed, and what to change when it didn't.", true],
      cli_version: ["string", "The CLI's version."],
    },
  },
  "GET /repos/{owner}/{repo}/diffinery/agent-setup": {
    summary: "Get the agent setup check",
    description: "The latest Check on Settings → Agent setup, or `check: null` before any: `ok`, `checked_at`, `first_ok_at` (when a check first passed), the `account` and `token` (`name`, `prefix`) that reported it, `cli_version` and the `checks` lines. See [Cloud agent environments](/docs/connect/cloud-agents).",
    access: "write",
  },
  "POST /repos/{owner}/{repo}/diffinery/sandboxes": {
    summary: "Start a sandbox",
    description: "A container with the repository checked out, for agents to build and test in.",
    access: "write",
    status: 201,
    body: { ref: ["string", "Branch, tag or commit to check out (default: the default branch)."] },
  },
  // ------------------------------------------------------------ model access and agent tasks (agentic/)
  "GET /diffinery/model-keys": {
    summary: "List your model keys",
    description: "Your saved model API keys for agent tasks: `provider` (`anthropic`, `openai` or `openrouter`), `hint` (the key's last four characters), `opted_in_at`, `created_at` and `updated_at`. The keys themselves are never returned. See /docs/agents/tasks#model-access.",
    access: "account",
  },
  "GET /diffinery/model-usage": {
    summary: "Get your model usage",
    description: "The model usage you paid for over the last `days`, as on Settings → Model access: `days`, `since`, and `repositories`, one line per repository (named as it was when its runs ended) and `kind` (`task`, `review` or `coordinator`) with `runs`, `reported_by_cli_runs`, `requests`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` and `cost_usd` (`null` when no run reported a cost). A token limited to some repositories sees only their lines. See /docs/agents/tasks#usage-and-cost.",
    access: "account",
    query: { days: ["integer", "1 to 90 (default 30)."] },
  },
  "GET /orgs/{org}/diffinery/agent-policy": {
    summary: "Get an organization's agent policy",
    description: "Owners only (and site administrators); a token limited to repositories gets 403. `keys` (`personal`, `either` or `organization`: whose key pays), `runtimes` (`claude-code`, `codex`, `custom`), `providers` (`anthropic`, `openai`, `openrouter`), `max_running` (tasks at once per repository, 1 to 10), `terminals`, `terminal_tasks`, `review`, `member_monthly_tokens` (`null` for no allowance), `updated_by` and `updated_at`. See /docs/agents/organizations.",
    access: "org-owner",
  },
  "PUT /orgs/{org}/diffinery/agent-policy": {
    summary: "Change an organization's agent policy",
    description: "From a browser session only, by an owner. Fields left out stay as they are; answers with the whole policy. 422 when a value is out of range, or no runtime or provider is left allowed. Each repository's tasks at once are held to `max_running` right away. Audited as `org.agent_policy.update`, with the new values.",
    access: "org-owner",
    body: {
      keys: ["string", "`personal` (each person's own keys), `either` (the organization's keys when it has them) or `organization` (only the organization's keys)."],
      runtimes: ["array", "Allowed runtimes: `claude-code`, `codex`, `custom`. At least one."],
      providers: ["array", "Allowed providers: `anthropic`, `openai`, `openrouter`. At least one."],
      max_running: ["integer", "Most tasks at once per repository, 1 to 10."],
      terminals: ["boolean", "Allow web terminals."],
      terminal_tasks: ["boolean", "Let terminals run agent tasks."],
      review: ["boolean", "Allow agent review."],
      member_monthly_tokens: ["integer", "Tokens one person may spend of the organization's keys in a calendar month (UTC), 10,000 to 10,000,000,000, or `null` for no allowance."],
    },
  },
  "GET /orgs/{org}/diffinery/model-keys": {
    summary: "List an organization's model keys",
    description: "Owners only; a token limited to repositories gets 403. Each key as `GET /diffinery/model-keys` shows a personal one: `provider`, `hint` (last four characters), `opted_in_at`, `created_at` and `updated_at`. The keys themselves are never returned. See /docs/agents/organizations.",
    access: "org-owner",
  },
  "PUT /orgs/{org}/diffinery/model-keys/{provider}": {
    summary: "Save an organization's model key",
    description: "From a browser session with a sign-in from the last 2 hours, by an owner. `provider` is `anthropic`, `openai` or `openrouter`; `accept_terms: true` is required. The key is encrypted, never shown again and never sent to a sandbox. Every owner gets a security email. Audited as `org.model_key.set`.",
    access: "org-owner",
    body: { key: ["string", "The API key (`sk-ant-...`, `sk-...` or `sk-or-...`)."], accept_terms: ["boolean", "Must be `true`."] },
  },
  "DELETE /orgs/{org}/diffinery/model-keys/{provider}": {
    summary: "Delete an organization's model key",
    description: "From a browser session with a sign-in from the last 2 hours, by an owner. 404 when the organization has no key for that provider. Audited as `org.model_key.delete`.",
    access: "org-owner",
    status: 204,
  },
  "GET /orgs/{org}/diffinery/model-usage": {
    summary: "Get an organization's model usage",
    description: "Owners only; a token limited to repositories gets 403. The runs the organization's keys paid for over the last `days`, shaped like `GET /diffinery/model-usage` with a `person` on each line, and `month`: `month`, `member_monthly_tokens` and `people` (each `person` and their `tokens` on the organization's keys this month). See /docs/agents/organizations#usage.",
    access: "org-owner",
    query: { days: ["integer", "1 to 90 (default 30)."] },
  },
  "PUT /diffinery/model-keys/{provider}": {
    summary: "Save a model key",
    description: "From a browser session only: no token, agent, job or sandbox can set a model key. `provider` is `anthropic`, `openai` or `openrouter`. `accept_terms: true` records that you use that provider through Diffinery under your own account and its terms (422 without it). The key is encrypted, never shown again and never sent to a sandbox. Sends you a security email. Audited as `model_key.set`.",
    access: "account",
    body: { key: ["string", "The API key (`sk-ant-...`, `sk-...` or `sk-or-...`)."], accept_terms: ["boolean", "Must be `true`."] },
  },
  "DELETE /diffinery/model-keys/{provider}": { summary: "Delete a model key", description: "From a browser session only. Running tasks that use it lose model access. Audited as `model_key.delete`.", access: "account", status: 204 },
  "GET /diffinery/tasks": {
    summary: "List your agent tasks",
    description: "Agent tasks you started across repositories where you still have write access, most recently changed first (for an agent's token: the tasks it runs). A token limited to repositories sees only those.",
    access: "account",
  },
  "GET /repos/{owner}/{repo}/diffinery/tasks": {
    summary: "List agent tasks",
    description: "The repository's agent tasks, newest first. Needs write access: transcripts show an agent's reasoning and command output. `state` filters: `queued`, `running`, `ready`, `failed` or `stopped`, or `active` for running and queued together.",
    access: "write",
    query: { state: ["string", "`queued`, `running`, `ready`, `failed`, `stopped` or `active` (running or queued)."], per_page: ["integer", "At most 100 (default 50)."] },
  },
  "POST /repos/{owner}/{repo}/diffinery/tasks": {
    summary: "Start an agent task",
    description: "From a browser session only, by a person with write access, as one of their agents (they own it, or administer the organization that owns it) that has write access here: each run spends the person's own model key, so no token can start one. The agent works in a sandbox, then Diffinery pushes `agent/<number>-<slug>` and opens a pull request as the agent. 422 when the runtime needs a model key you haven't saved. Audited as `task.start`. See /docs/agents/tasks.",
    access: "write",
    status: 201,
    body: {
      goal: ["string", "What to do (required, at most 20,000 characters)."],
      runtime: ["string", "`claude-code` (default), `codex` or `custom`."],
      provider: ["string", "Where the runtime's model calls go: its own provider (`anthropic` for Claude Code, `openai` for Codex; the default) or `openrouter`."],
      model: ["string", "With `provider: openrouter`: the OpenRouter model id (default `~anthropic/claude-sonnet-latest` for Claude Code, `~openai/gpt-sol-latest` for Codex)."],
      agent: ["string", "The agent's login (required)."],
      base: ["string", "Branch to start from (default: the default branch)."],
      plan_first: ["boolean", "`true` to plan in a read-only sandbox before building, `false` to build at once. Left out, the project's default; a project that requires plans ignores `false`. See /docs/agents/tasks#plan-first."],
      attempts: ["integer", "1 (default) to 4: run the first build as that many attempts side by side, then pick one (422 above 1 for a task on a pull request's branch). See /docs/agents/tasks#best-of-n."],
      fix_checks: ["boolean", "Start a fix run when the pull request's checks fail (default `true`, `false` for a task on a pull request's branch). See /docs/agents/tasks#verify-and-land."],
      land: ["boolean", "Turn on auto-merge for its pull request as the task's agent, so it merges once approved and checks pass (default `false`)."],
      command: ["string", "For `custom`: the shell command to run."],
    },
  },
  "GET /repos/{owner}/{repo}/diffinery/project": {
    summary: "Get the project",
    description: "The repository's project: `settings` (`max_running`, `instructions`, `plan_first`), `memory` (`body`, `version`, `updated_by`, `updated_at`) and `board`, the agent tasks by column (`waiting`, `working`, `queued`, `review`, `landing`, `done`, `idle`). Agent reviews aren't on the board. Needs write access. See /docs/agents/projects.",
    access: "write",
  },
  "GET /repos/{owner}/{repo}/diffinery/project/posts": {
    summary: "List the project conversation",
    description: "Posts and task events, oldest first: those after `after`, or the latest 100. Needs write access.",
    access: "write",
    query: { after: ["integer", "Return posts after this id (default 0)."], per_page: ["integer", "At most 100 (default 100)."] },
  },
  "POST /repos/{owner}/{repo}/diffinery/project/posts": {
    summary: "Post to the project conversation",
    description: "Markdown, at most 20,000 characters (422 otherwise). If you have a coordinator in this project, it handles the post unless you send `coordinator: false`; the response's `coordinator` says whether it did. A person in a browser session only. 403 on an archived repository.",
    access: "write",
    status: 201,
    body: { body: ["string", "The post.", true], coordinator: ["boolean", "`false` to post without handing it to your coordinator."] },
  },
  "POST /repos/{owner}/{repo}/diffinery/project/posts/{n}/handle": {
    summary: "Hand a post to your coordinator",
    description: "Your coordinator handles post `n`, anyone's, on your model key. Each post is handled once. A person in a browser session only. Audited as `project.coordinate`. See /docs/agents/projects#coordinator.",
    access: "write",
  },
  "GET /repos/{owner}/{repo}/diffinery/project/coordinator": {
    summary: "Get your coordinator",
    description: "Your coordinator's settings in this project: `enabled`, `agent`, `runtime`, `command`, `provider`, `model`, `tokens_per_run`, `tokens_per_task`, `opted_in_at`, `updated_at`. Needs write access.",
    access: "write",
  },
  "GET /repos/{owner}/{repo}/diffinery/project/coordinators": {
    summary: "List the coordinators in a project",
    description: "Every person's coordinator in this project, oldest first: `person`, `agent`, `runtime`, `provider`, `model`, `opted_in_at`. Never their token budgets or custom command. Needs write access. See /docs/agents/projects#coordinator.",
    access: "write",
  },
  "PUT /repos/{owner}/{repo}/diffinery/project/coordinator": {
    summary: "Turn on or change your coordinator",
    description: "Your agent then reads your posts and turns them into tasks, on your model key. Each coordinator starts at most 5 tasks per post and 20 per 24 hours in the project. A person in a browser session only. Audited as `project.coordinator`. See /docs/agents/projects#coordinator.",
    access: "write",
    body: {
      agent: ["string", "The login of an agent you manage with write access to the repository.", true],
      runtime: ["string", "`claude-code` (default), `codex` or `custom`."],
      command: ["string", "For `custom`: the shell command."],
      provider: ["string", "`openrouter` to run Claude Code or Codex via OpenRouter."],
      model: ["string", "With `provider: openrouter`: the OpenRouter model id."],
      tokens_per_run: ["integer", "Token budget of each coordinator run, 100,000 to 50,000,000 (default 1,000,000)."],
      tokens_per_task: ["integer", "Token budget of each run of a task it starts, 100,000 to 50,000,000 (default 2,000,000)."],
      accept: ["boolean", "Must be `true`: confirms your coordinator and its tasks use your model key.", true],
    },
  },
  "DELETE /repos/{owner}/{repo}/diffinery/project/coordinator": { summary: "Turn off your coordinator", description: "A person in a browser session only. Audited as `project.coordinator`.", access: "write" },
  "GET /repos/{owner}/{repo}/diffinery/project/memory": {
    summary: "Get the project memory",
    description: "The current memory and its last 50 `versions` (`version`, `updated_by`, `updated_at`, `length`). Every agent task reads it as background notes; agent reviews don't. Needs write access.",
    access: "write",
  },
  "PUT /repos/{owner}/{repo}/diffinery/project/memory": {
    summary: "Save or restore the project memory",
    description: "Saves `body` (at most 40,000 characters) as a new version, or restores an earlier version as a new one with `restore` (404 `no such memory version`). A person in a browser session only. Audited as `project.memory`.",
    access: "write",
    body: { body: ["string", "The new memory (Markdown)."], restore: ["integer", "A version number to restore instead."] },
  },
  "PUT /repos/{owner}/{repo}/diffinery/project/settings": {
    summary: "Change the project settings",
    description: "Project instructions every agent task and agent review gets, how many tasks run at once, and whether tasks plan first. Tasks beyond `max_running` queue and start oldest first. A person in a browser session only. Audited as `project.settings`.",
    access: "admin",
    body: {
      max_running: ["integer", "1 to 10 (default 3)."],
      instructions: ["string", "At most 10,000 characters."],
      plan_first: ["string", "`off` (default: tasks build at once unless started with `plan_first: true`), `default` (tasks plan first unless started with `plan_first: false`) or `required` (every task plans first, including ones coordinators start)."],
    },
  },
  "GET /repos/{owner}/{repo}/diffinery/tasks/{number}": {
    summary: "Get an agent task",
    description: "The task, its runs and its pull request. Needs write access. A plan-first task also has `plan_state` (`planning`, `waiting`, `approved` or `split`) and `plan`; a task split from a plan has `parent_task`. A task with more than one attempt has `pick_state` (`running`, `waiting` or `picked`) and `picked_attempt`, and each run its `attempt`. Every task has `fix_checks`, `check_fixes` (fix runs started so far) and `land`, `paid_by` (`person`, or `organization` when an organization's key pays), and `usage` (the model usage of all its runs; each run has its own `usage`, with `source`: `proxy`, or `runtime` for a run in a terminal). See /docs/agents/tasks#usage-and-cost.",
    access: "write",
  },
  "PATCH /repos/{owner}/{repo}/diffinery/tasks/{number}": {
    summary: "Change a task's options",
    description: "From a browser session only, by the person who started the task. `fix_checks` starts a fix run when its pull request's checks fail (one per commit, at most 3 per task); turning `land` on turns on auto-merge for an open pull request as the task's agent, under the usual rules for agents. 422 when a value isn't `true` or `false`; 409 `only agent tasks have these options` for an agent review. Audited as `task.options`. See /docs/agents/tasks#verify-and-land.",
    access: "write",
    body: { fix_checks: ["boolean", "Fix failing checks."], land: ["boolean", "Land when approved."] },
  },
  "GET /repos/{owner}/{repo}/diffinery/tasks/{number}/attempts": {
    summary: "Compare a task's attempts",
    description: "Needs write access. One entry per attempt of a best-of-N task: `attempt`, `run`, `state`, `error`, `branch`, `head_sha`, `changes` (`files`, `additions`, `deletions`), `checks` and `failing_checks` on its branch, `model_requests`, `tokens`, `summary` (its last message) and `compare_url`. See /docs/agents/tasks#best-of-n.",
    access: "write",
  },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/attempts/{attempt}/pick": {
    summary: "Pick a task's attempt",
    description: "From a browser session only, by the person who started the task. The attempt's branch becomes the task's branch, with a pull request; the other attempts' branches are deleted. 409 `the attempts are still running`, `attempt <n> is already picked` or `this task has no attempts to pick from`; 404 `no such attempt`; 422 `attempt <n> has no work to pick: ...` when it changed nothing or didn't finish. Audited as `task.pick`.",
    access: "write",
    status: 202,
  },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/plan/approve": {
    summary: "Approve a task's plan",
    description: "From a browser session only, by the person who started the task. The build run starts with the goal and the plan, and every later run gets the plan as the approved one. 409 `the plan isn't ready yet` while it plans, `this task has no plan waiting for approval`, or `the task is running`. Audited as `task.plan_approve`. See /docs/agents/tasks#plan-first.",
    access: "write",
    status: 202,
  },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/plan/split": {
    summary: "Split a task's plan into tasks",
    description: "From a browser session only, by the person who started the task. Your coordinator gets the goal and the plan as a post of yours and starts tasks for its parts, each with `parent_task`; this task is then done with. Returns `post`, `task` (the coordinator's run) and `status` (`started` or `queued`). 422 `set up your coordinator for this project first` without a coordinator; the same 409s as approving. Audited as `task.plan_split`.",
    access: "write",
    status: 202,
  },
  "GET /repos/{owner}/{repo}/diffinery/tasks/{number}/transcript": {
    summary: "Read a task's transcript",
    description: "Lines after `after` (a line number), oldest first: `stream` is `out` and `err` (the runtime's output, Claude Code's `stream-json` or Codex's `--json` lines), `setup` (installing and pushing) or `note` (Diffinery's own). Model keys and git credentials are masked.",
    access: "write",
    query: { after: ["integer", "Return lines after this one."], per_page: ["integer", "At most 5000 (default 2000)."] },
  },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/messages": {
    summary: "Send a task a follow-up",
    description: "From a browser session only, by the person who started the task. Starts a new run on the task's branch with the message (while a run is active, it waits and starts when that run ends). Audited as `task.message`.",
    access: "write",
    status: 201,
    body: { body: ["string", "The message."] },
  },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/retry": { summary: "Retry a task", description: "From a browser session only, by the person who started the task, when no run is active (409 otherwise). Audited as `task.retry`.", access: "write", status: 201 },
  "POST /repos/{owner}/{repo}/diffinery/tasks/{number}/stop": {
    summary: "Stop a task",
    description: "The person who started it, its agent, or a repository admin. Stops the agent, closes the sandbox (its git credential stops working) and ends the run's model access. Work already pushed stays. Audited as `task.stop`.",
    access: "write",
  },
  "GET /repos/{owner}/{repo}/diffinery/agent-review": {
    summary: "Get agent review settings",
    description: "Whether agent review is on, which agent reviews with which runtime, whose model key every review uses (`uses_key_of`), when it reviews (`trigger`: `push`, `open` or `request`), which pull requests (`authors`: `all`, `people` or `agents`), `drafts`, `autofix`, `daily_limit` and `tokens_per_review`. `{\"enabled\": false}` when it was never turned on. Needs write access. See /docs/agents/review.",
    access: "write",
  },
  "PUT /repos/{owner}/{repo}/diffinery/agent-review": {
    summary: "Turn agent review on, change or off",
    description: "From a browser session only, by a repository admin who can run tasks as the agent and has the runtime's model key: every review on the repository, including ones other people ask for, spends that admin's key, so `accept_terms` must be true. `{\"enabled\": false}` turns it off. Audited as `review.settings`.",
    access: "admin",
    body: {
      agent: ["string", "The reviewing agent's login (required)."],
      runtime: ["string", "`claude-code` (default), `codex` or `custom`."],
      provider: ["string", "Where the runtime's model calls go: its own provider (`anthropic` for Claude Code, `openai` for Codex; the default) or `openrouter`."],
      model: ["string", "With `provider: openrouter`: the OpenRouter model id (default `~anthropic/claude-sonnet-latest` for Claude Code, `~openai/gpt-sol-latest` for Codex)."],
      command: ["string", "For `custom`: the shell command; it must end its output with the findings block the prompt describes."],
      trigger: ["string", "`push` (default: on open and every push), `open` (once per pull request) or `request` (only when asked)."],
      authors: ["string", "`all` (default), `people` or `agents`."],
      drafts: ["boolean", "Review drafts too (default false)."],
      autofix: ["boolean", "Start a fix task on the pull request's branch for blocking findings (default false; at most 3 times per pull request)."],
      daily_limit: ["integer", "Most reviews and autofix runs the repository starts in 24 hours, 1 to 1000 (default 50). Past it, pull requests get an action-required check, autofix waits, and you get an email."],
      tokens_per_review: ["integer", "Most tokens one review may use, counted from the provider's responses (cache reads count as a tenth), 100000 to 50000000 (default 2000000)."],
      accept_terms: ["boolean", "Must be true: reviews use your model key."],
      enabled: ["boolean", "`false` turns agent review off."],
    },
  },
  "GET /repos/{owner}/{repo}/pulls/{number}/diffinery/agent-review": {
    summary: "Get a pull request's agent review",
    description: "The pull request's review task (each review is a run of it), the last reviewed head (`reviewed_sha`) and every finding: `id`, `path`, `line`, `side`, `severity` (`blocking` or `not_blocking`), `title`, `body`, `suggestion`, `state` (`open`, `fixed` or `dismissed`), `fixed_in` and the review `comment_id`. Needs write access.",
    access: "write",
  },
  "POST /repos/{owner}/{repo}/pulls/{number}/diffinery/agent-review": {
    summary: "Ask for an agent review",
    description: "Reviews the pull request now, or once its current review ends, whatever the trigger setting. People with write access only (any of their tokens); agents can't ask. 422 when agent review is off; 429 past a daily limit (the repository's, or 20 reviews of one pull request in 24 hours). Audited as `review.request`.",
    access: "write",
    status: 202,
  },
  "POST /repos/{owner}/{repo}/diffinery/sandboxes/{id}/{action}": {
    summary: "Use a sandbox",
    description: "`action` is `exec` (run a command), `read` or `write` (files), or `close`.",
    access: "write",
  },

  // ------------------------------------------------------------ GitHub imports and linked accounts
  "POST /diffinery/imports": {
    summary: "Start a GitHub import",
    description:
      "Imports one GitHub repository (`source`), or many repositories of a GitHub organization or user (`source_owner`), on the server, and returns the import (`status: queued`). Git history with LFS objects is copied in a container; issues and pull requests (with their numbers), comments, reviews, labels, milestones, branch protection, Actions variables, deployment environments and releases come through GitHub's REST API. Secret values are never read: only secret names are listed in `summary`, for a person to set by hand. People can import into their own account or an organization they own or administer (site administrators: any user or organization). An agent can import only where its owner may (the owner's own account or an organization the owner owns or administers; an organization's agent, only into that organization), and only when its policy allows `write`; its imports always use `secrets: stop` and skip Actions variables and environments. Needs a `write` or `admin` token (403 `starting an import needs a token with write or admin scope`), or a browser session. At most one organization import and three repository imports run at a time per account and per target (429), and a `source` repository larger than `IMPORT_MAX_REPO_KB` (default 10 GB, by GitHub's reported size) is refused with 422. Other errors: 422 `<owner>/<name> already exists; choose another name`, 422 `GitHub repository <source> was not found or the token cannot read it`, 422 `GitHub rejected the token (expired or revoked?)`, 429 when GitHub's rate limit is reached, 502 `could not reach GitHub: ...`. Audited as `import.create`. See [Migrate from GitHub](/docs/migrate-from-github).",
    access: "account",
    status: 201,
    body: {
      source: ["string", "One repository: `owner/name`, a github.com or GitHub Enterprise URL, or an SSH remote such as `git@github.com:owner/name.git`. Send either `source` or `source_owner`."],
      source_owner: ["string", "A GitHub organization or user: imports its repositories (private ones too when the token can see them)."],
      owner: ["string", "The Diffinery user or organization that will own the new repositories.", true],
      name: ["string", "`source` only: the new repository's name. Default: the GitHub name. It must not exist yet."],
      visibility: ["string", "`keep` (default: public stays public, private and internal become private), `private` or `public`. `internal` is accepted and means `private`."],
      github_token: ["string", "A GitHub token that can read the source, at most 400 characters. Needed for private repositories; Actions variables, secret names and branch protection need a token with admin access to the source. Encrypted at rest, used only by this import, deleted when it ends, never returned."],
      github_api_url: ["string", "GitHub Enterprise Server: the REST API base, such as `https://ghe.example.com/api/v3` (default `https://api.github.com`). Must be HTTPS on a public host. Required, on the same host as `source`, when `source` names an Enterprise host and you send `github_token`."],
      options: ["object", "What to copy; each is `true` by default: `issues` (issues and pull requests with comments and reviews), `labels` (labels and milestones), `branch_protection`, `variables` (Actions variables, secret names and deployment environments), `releases`, `lfs`. Plus `secrets`: `bypass` (default: credentials found in old history are imported with an audited push protection bypass, which needs a person with admin on the target and an `admin` token or browser session) or `stop` (the import fails). Unknown keys are refused with 422."],
      repositories: ["string[]", "`source_owner` only: the repository names to import, at most 1,000. Default: every repository (up to 1,000)."],
      exclude_forks: ["boolean", "`source_owner` only: skip forks (default `false`)."],
      exclude_archived: ["boolean", "`source_owner` only: skip archived repositories (default `false`)."],
      concurrency: ["integer", "`source_owner` only: repositories imported at the same time, 1 to 8 (default 3)."],
    },
  },
  "GET /diffinery/imports": {
    summary: "List your imports",
    description: "The imports you started, newest first, at most 100. Repository imports that belong to an organization import aren't listed separately; read them through the organization import's `children`.",
    access: "account",
  },
  "GET /diffinery/imports/{id}": {
    summary: "Get an import",
    description:
      "Readable by the person or agent who started it, by people who could start an import into the same target (the account itself, or the organization's owners and admins), and by site administrators; others get 404 `import not found`. Fields: `kind` (`repository` or `organization`), `status` (`draft`, `queued`, `running`, `succeeded`, `failed` or `cancelled`), `attempt`, `source`, `target`, `visibility`, `options`, `steps` (each with `name`, `title`, `status`, `message`, `count` and times), `git` (the transfer's `phase`, `message`, `chunks`, `bytes` and `tries`), `summary` (counts, secret names, variables, environments, releases, push protection `findings`, linked and imported people), `warnings`, `error` and timestamps. An organization import adds `children` (each repository import's `id`, `source`, `target`, `status`, current `step` and `error`), and a draft adds `candidates`. Credentials are never included. Poll until `status` is `succeeded`, `failed` or `cancelled`.",
    access: "account",
  },
  "POST /diffinery/imports/{id}/cancel": {
    summary: "Cancel an import",
    description:
      "Stops a `draft`, `queued` or `running` import (409 `the import already <status>` otherwise): ends its workflow and container and revokes its push tokens. Cancelling an organization import cancels its unfinished repository imports. A repository the import already created is kept with what was copied so far, and is unlocked. Anyone who can read the import can cancel it. Audited as `import.cancel`.",
    access: "account",
  },
  "POST /diffinery/imports/{id}/retry": {
    summary: "Retry an import",
    description:
      "Runs a `failed` or `cancelled` import again as a new `attempt` (409 `only failed or cancelled imports can be retried` otherwise), with the same options. Only whoever started it can retry it (404 for anyone else), except that a person who may import into the target can also retry an import an agent started. A repository import inside an organization import can't be retried on its own (422 `retry the organization import this repository belongs to`); retrying the organization import re-runs its failed and cancelled repositories, except those that failed because the target name was taken. The GitHub token was deleted when the import ended, so send `github_token` again for a private source. The retry resumes into the repository the import created, and fails if someone else has written to it since (`repository already holds content not written by this import; start a new import`). An agent can't retry once the repository exists (403 `an agent cannot retry an import after the repository was created; a person who administers <owner> must retry it`). Audited as `import.retry`.",
    access: "account",
    status: 202,
    body: { github_token: ["string", "A GitHub token for this attempt (optional; at most 400 characters)."] },
  },
  "POST /diffinery/imports/{id}/selection": {
    summary: "Choose repositories for a draft import",
    description:
      "An organization import started from the web form waits as a `draft` with its `candidates` until its repositories are chosen; this starts it. Names are matched to the candidates ignoring case, and names that aren't candidates are dropped. 422 `choose at least one repository`, 409 `this import has already started`. Only whoever started it (404 for anyone else). Imports started through this API or MCP never wait as drafts. Unstarted drafts are cancelled after 7 days. Audited as `import.create`.",
    access: "account",
    status: 202,
    body: { repositories: ["string[]", "Names of the repositories to import, at most 1,000.", true] },
  },
  "POST /diffinery/imports/{id}/claim": {
    summary: "Claim an import's Git transfer (local development)",
    description:
      "Only when the Worker runs with `IMPORT_GIT_AGENT=external` (the `dev` environment, where containers don't run); 404 otherwise. Whoever started the import gets `{ token }`, a push token for the transfer, and runs the runner image's import mode by hand with `DIFFINERY_API_URL`, `DIFFINERY_IMPORT_ID` and `DIFFINERY_IMPORT_TOKEN`. 409 `this import is not waiting for an agent`.",
    access: "account",
  },
  "GET /diffinery/imports/{id}/agent/spec": {
    summary: "Get a Git transfer spec (import agent)",
    description:
      "Internal: called by the import container with the import's own push token, which works only on Git, Git LFS and these agent endpoints. Says what to clone and where to push, and includes the GitHub token, so no other credential is accepted (403 `this token does not belong to this import`, or 403 `this push token is no longer current for the import` for a token from an earlier try; 409 `this import is not running`).",
    access: "account",
  },
  "POST /diffinery/imports/{id}/agent/progress": {
    summary: "Report Git transfer progress (import agent)",
    description: "Internal: the import agent reports its phase, a message, and the chunks and bytes pushed so far. Same credential rules as the spec. 204.",
    access: "account",
    status: 204,
  },
  "POST /diffinery/imports/{id}/agent/complete": {
    summary: "Report a Git transfer's result (import agent)",
    description: "Internal: the import agent reports the result (branches, tags, pull request heads, LFS objects, push protection findings, warnings). Revokes the push token and wakes the import's workflow. Same credential rules as the spec. 204.",
    access: "account",
    status: 204,
  },
  "GET /diffinery/user/linked-accounts": {
    summary: "List your linked GitHub accounts",
    description:
      "Each link has `id`, `host` (`github.com` or the Enterprise host), `apiBase`, `login`, `externalId` (GitHub's numeric user id) and `createdAt`. Imports attribute a GitHub user's issues, pull requests, comments, reviews and releases to the Diffinery account linked to that user id on the same API base. Everyone else is imported as a mannequin: login `github:<login>`, `type: \"Mannequin\"`, linking to the GitHub profile.",
    access: "account",
  },
  "POST /diffinery/user/linked-accounts/github/challenge": {
    summary: "Get a GitHub link code",
    description:
      "Step 1 of linking a GitHub account without a token: returns `nonce` (`diffinery-link-` and 32 hex characters, the same each time for your account and host), `apiBase`, `host` and `gistsUrl`. Put the nonce in the description or a file of a public gist of the GitHub account, then call `POST /diffinery/user/linked-accounts/github`. People only (403 `only people can link GitHub accounts`).",
    access: "account",
    body: { api_url: ["string", "GitHub Enterprise REST API base, such as `https://ghe.example.com/api/v3`. Default: github.com."] },
  },
  "POST /diffinery/user/linked-accounts/github": {
    summary: "Link a GitHub account",
    description:
      "Step 2: reads the GitHub user's public profile and public gists without a token on the same API base, and links the account when one of the first 100 public gists GitHub lists for the user has your nonce in its description or in a file (file contents are read for at most 20 gists). Returns `{ id, host, login }`. 422 `create a PUBLIC gist whose description or a file contains <nonce>, then try again`, 422 `GitHub user <login> was not found`, 409 `GitHub user <login> is linked to another Diffinery account`, 429 when GitHub's rate limit is reached. People only. Audited as `account.link_github`.",
    access: "account",
    status: 201,
    body: { login: ["string", "Your GitHub username.", true], api_url: ["string", "The same API base you used for the challenge. Default: github.com."] },
  },
  "DELETE /diffinery/user/linked-accounts/{id}": {
    summary: "Unlink a GitHub account",
    description: "Removes one of your own links (an id that isn't yours changes nothing). Imports that already ran keep their attribution. Audited as `account.unlink_github`.",
    access: "account",
    status: 204,
  },
  "DELETE /diffinery/admin/linked-accounts/{id}": {
    summary: "Clear anyone's GitHub link",
    description: "For example after an account changes hands. `id` is the link id from `GET /diffinery/user/linked-accounts` of the account that owns it; there is no endpoint that lists other people's links. 404 `link not found`, 403 `site admin only`. Audited as `account.link_cleared`.",
    access: "site-admin",
    status: 204,
  },

  // ------------------------------------------------------------ packages
  "GET /repos/{owner}/{repo}/packages": { summary: "List a repository's packages", description: "Container images linked to the repository.", access: "read" },
  ...packageDocs("/user/packages", "your"),
  ...packageDocs("/users/{owner}/packages", "a user's"),
  ...packageDocs("/orgs/{owner}/packages", "an organization's"),
};

function packageDocs(prefix: string, whose: string): Record<string, OpDoc> {
  return {
    [`GET ${prefix}`]: { summary: `List ${whose} packages`, description: "Only packages you can pull.", access: "account" },
    [`GET ${prefix}/{type}/{name}`]: { summary: `Get one of ${whose} packages`, description: "`type` is `container`.", access: "read" },
    [`PATCH ${prefix}/{type}/{name}`]: {
      summary: `Update one of ${whose} packages`,
      description: "Change its visibility or the repository it is linked to.",
      access: "admin",
      body: { visibility: ["string", "`private` or `public`."], repository: ["string", "Repository name to link, or `null` to unlink."] },
    },
    [`DELETE ${prefix}/{type}/{name}`]: { summary: `Delete one of ${whose} packages`, access: "admin", status: 204 },
    [`GET ${prefix}/{type}/{name}/versions`]: { summary: "List package versions", access: "read", query: { state: ["string", "`tagged` for tagged versions only."], ...page } },
    [`GET ${prefix}/{type}/{name}/versions/{id}`]: { summary: "Get a package version", access: "read" },
    [`DELETE ${prefix}/{type}/{name}/versions/{id}`]: { summary: "Delete a package version", access: "admin", status: 204 },
  };
}

/** GitHub's tarball and zipball endpoints, with and without a ref. */
function archiveDocs(kind: "tarball" | "zipball", what: string, format: string): Record<string, OpDoc> {
  const description = `A ${format} of the repository's files, served directly (GitHub redirects to a download host instead). Built once per commit, at most 20 new builds per repository per hour (429 after that); repositories with more than 24 MB of files can't be archived (413).`;
  return {
    [`GET /repos/{owner}/{repo}/${kind}`]: { summary: `Download ${what}`, description: `${description} Uses the default branch.`, access: "read" },
    [`GET /repos/{owner}/{repo}/${kind}/{ref}`]: { summary: `Download ${what} of a ref`, description, access: "read" },
  };
}

/** Reactions on one kind of subject. `note` adds a sentence to the list endpoint. */
function reactionDocs(prefix: string, what: string, note?: string): Record<string, OpDoc> {
  return {
    [`GET ${prefix}/reactions`]: {
      summary: `List reactions to ${what}`,
      ...(note ? { description: note } : {}),
      access: "read",
      query: { content: ["string", "Only reactions with this content."], ...page },
    },
    [`POST ${prefix}/reactions`]: {
      summary: `Add a reaction to ${what}`,
      description: `Needs a signed-in account${what === "a release" ? "" : ", and triage access when the conversation is locked"}. Returns 201 for a new reaction, or 200 with the existing one when you had already reacted with that content.`,
      access: "read",
      status: 201,
      body: { content: ["string", "`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket` or `eyes`.", true] },
    },
    [`DELETE ${prefix}/reactions/{reaction}`]: { summary: `Delete a reaction from ${what}`, description: "Your own reactions, or anyone's with admin access.", access: "read", status: 204 },
  };
}
