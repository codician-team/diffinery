---
title: Security overview
description: Diffinery's security model: sign-in, sessions, tokens, agent guardrails, branch and push protection, secrets and key rotation, Actions, webhooks, the Markdown image proxy and auditing.
---

This page explains how Diffinery protects accounts, code and secrets, from how people sign in to how workflow secrets are encrypted and how every sensitive action is recorded. Read it to understand the model as a whole; each section links to a page with the details.

## At a glance

| Area | What Diffinery does |
|---|---|
| Sign-in | Passkeys only (WebAuthn). No passwords. |
| Browser sessions | Random session cookie, stored hashed, `HttpOnly`, `Secure`, `SameSite=Lax`, 30 days sliding |
| Cross-site requests | Double-submit CSRF token on every form, plus refusal of cross-site state-changing requests |
| Headers | HSTS, nonce-based Content Security Policy, `X-Frame-Options: DENY`, `nosniff` |
| Images in Markdown | Images from other sites are served through Diffinery's own image proxy, so those sites never see who views a page |
| Anonymous access | Read-only: anonymous callers can read public repositories but every change gets `401` |
| Machines and agents | Tokens (`dfy_...`), stored hashed, with scopes, repository restrictions and expiry; `read` tokens never write |
| Agents | Accounts owned by a person or organization, with server-enforced limits |
| Branches | Branch protection rules, enforced for git, the API, MCP and the web UI |
| Required checks | Checks reported by agents never satisfy a required check; a check can be bound to one reporter |
| Pushes and commits | Credential scanning on every push and on every commit made without Git (web editor, REST API, MCP); blocked writes leave nothing behind |
| File names | Writes through the API, MCP and the web editor refuse `.git`, `..` and other unsafe tree entry names |
| Archived repositories | Every write refused, except unarchiving, deleting, watching and linking packages |
| Actions secrets | Envelope encryption with a per-repository, per-environment or per-organization key derived from `MASTER_KEY` |
| Workflow logs | Secret values are replaced with `***` |
| Workflow credentials | A job token valid for one job, limited by the workflow's `permissions:` (read-only by default for new repositories), and short-lived OIDC id tokens |
| Webhooks | HTTPS only, signed with HMAC-SHA256, failed deliveries retried |
| Accountability | Append-only audit log and security emails |
| Isolation | One Durable Object per repository |

## Signing in with passkeys

People sign in to the web UI with a passkey: a WebAuthn credential kept by their device, password manager or security key. Diffinery has no passwords to guess, reuse or phish.

- Passkeys are bound to the site's hostname (`diffinery.com`), so a look-alike site cannot use them.
- Diffinery requires user verification (a fingerprint, face or device PIN) and discoverable credentials, and does not ask for attestation.
- Each sign-in uses a fresh challenge that expires after 5 minutes, can be used once, and is tied to the browser that requested it by a `__Host-dfy_webauthn` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`).
- New people create their first passkey from an invite link, which expires after 14 days and works once.
- If someone loses all their passkeys, a site admin can create a one-time sign-in link that lets them add a new passkey. It expires after 24 hours and works once. Its token, like an invite's email proof, travels in the URL fragment (`/signin#<token>`), which browsers never send to the server, so it stays out of request and proxy logs. An instance can also offer email recovery through Cloudflare Access at `/auth/access`; Access guards only that path.
- Agents cannot sign in to the web UI. Only people get browser sessions.

Manage your passkeys under **Settings**, **Passkeys and sessions**. Removing a passkey also signs out every other browser that signed in with it. See [Passkeys and sign-in](/docs/accounts/passkeys-and-sign-in).

## Sessions

After a passkey sign-in, Diffinery sets a session cookie:

| Property | Value |
|---|---|
| Name | `__Host-dfy_session` (the `__Host-` prefix pins it to this origin, `Path=/`, no `Domain`) |
| Flags | `HttpOnly`, `Secure`, `SameSite=Lax` |
| Lifetime | 30 days, extended by another 30 days on the first use of each day, and never more than 90 days after the sign-in |
| Storage | Only a SHA-256 hash of the session token is stored |

Signing in again replaces the browser's previous session. **Settings**, **Passkeys and sessions** lists your **Signed-in browsers**. **Sign out** next to one ends that session, and **Sign out everywhere else** ends every session except the current one. A disabled account cannot use its sessions or tokens.

### Confirming it's you

Some actions need a sign-in from the last 2 hours, much like GitHub's sudo mode:
- adding or removing a passkey;
- creating a personal access token, an agent, or an agent token;
- changing your username;
- issuing a sign-in link (site administrators);
- deleting or transferring a repository, or purging its unreachable objects;
- deleting an organization;
- exporting your account, downloading the export, or deleting your account;
- deleting someone's account, or making someone a site administrator or removing them (site administrators).

When a browser's sign-in is older than that, Diffinery asks you to **Confirm it's you** with your passkey (or by email recovery, where that is set up), then takes you back to the page. Then submit the form again. The same calls through the API with a browser session get `403 Confirm it's you: sign in with your passkey again to do this.`, with a `confirm` URL in the body. So a session left open on a shared computer, or a stolen session cookie, can't add its own passkey, mint a lasting token or delete your work. Tokens aren't affected: their scopes bound what they can do.

## Protection against cross-site requests

Browser sessions ride on cookies, so Diffinery applies two independent defenses against cross-site request forgery.

**Cross-site refusal.** Every request that changes state (any method other than `GET`, `HEAD` and `OPTIONS`) and carries no `Authorization` credential is checked first:

- If the browser sends `Sec-Fetch-Site` and its value is not `same-origin` or `none`, the request is refused.
- If there is no `Sec-Fetch-Site` header but there is an `Origin` header that differs from the site's own origin, the request is refused.

The response is `403` with `{"message": "cross-site request refused"}`. Requests authenticated with a token (git, the CLI, MCP clients, runners) are exempt because they carry no ambient credentials.

**Double-submit CSRF token.** Every page sets a random `dfy_csrf` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, 30 days), and every form carries the same value in a hidden `_csrf` field. A form submission is accepted only when:

- its `Origin`, if present, is the site's own origin (otherwise `403` with `cross-origin form submission rejected`),
- it is a form submission (`application/x-www-form-urlencoded` or `multipart/form-data`; otherwise `415` with `expected a form submission`), and
- the field matches the cookie, compared in constant time (otherwise `403` with `your session token expired or is missing; reload the page and try again`).

The passkey endpoints take JSON, which forces a CORS preflight that other sites cannot pass.

## Security headers and content security policy

Every response carries:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` (unless a response sets its own) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

Web pages also get `Cache-Control: private, no-store` and a Content Security Policy with a new random nonce for each response:

```text
default-src 'self'; script-src 'nonce-...'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self' wss://diffinery.com ws://diffinery.com;
font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

Only scripts that carry the page's nonce run, so injected markup cannot execute scripts. Raw file views and downloadable logs are served with `Content-Security-Policy: sandbox`, so a file that contains HTML cannot run scripts in Diffinery's origin.

Pages load images only from Diffinery itself. Images from other sites in Markdown come through Diffinery's image proxy (see [Images from other sites](#images-from-other-sites)).

## Images from other sites

An image in Markdown (an issue, pull request, comment, review, README, Markdown file, release notes, job summary or agent task) that points at another site would tell that site the IP address, browser and time of everyone who views the page, even in a private repository. So Diffinery fetches those images itself and serves them from its own address, as GitHub does:

- The page shows the image from `/-/camo/<signature>/<encoded URL>`. Only URLs Diffinery signed while rendering are fetched, so the proxy can't be used to fetch anything else.
- Diffinery fetches the image over HTTPS without your cookies, IP address or browser details. An `http://` image is fetched over `https://`, as browsers already do on an HTTPS page.
- Only public hosts are fetched: never Diffinery itself, `localhost` or private, link-local or internal addresses, also after a redirect (at most 4 are followed).
- The answer must be a PNG, JPEG, GIF, WebP, AVIF or SVG image of at most 10 MB, within 10 seconds. SVG images are served with a sandboxing Content Security Policy, so scripts in them can't run.
- Images are cached for as long as the other site allows (between 5 minutes and 7 days; a day if it doesn't say), so the other site sees only an occasional request from Diffinery. An image that can't be fetched shows as broken.

Links in Markdown still go to their original addresses, and images from the repository itself (relative paths) or from Diffinery load directly.

## Tokens and scopes

Everything that is not a browser (git, the [CLI](/docs/reference/cli), scripts, MCP clients, agents) authenticates with a token in the `Authorization` header (`Bearer`, `token` or HTTP Basic with the token as the password).

| Property | Detail |
|---|---|
| Format | `dfy_` followed by 40 random characters |
| Storage | Only a SHA-256 hash is stored; the token is shown once, at creation |
| Expiry | 1 to 366 days; 90 by default (30 for agent tokens created in the web UI) |
| Scope | `read`, `write` or `admin` |
| Repositories | Optionally restricted to a list of repositories |
| Revocation | Immediate; disabling an account revokes all of its tokens |

A token never grants more than its account has. The scope caps the account's role on each repository:

| Scope | Highest role it allows |
|---|---|
| `read` | read: clone and view |
| `write` | maintain: push, issues, pull requests, runs, and moving tags |
| `admin` | admin: everything the account can do, including settings |

A `read` token can't change anything: every repository request other than `GET` or `HEAD` gets `403 this token needs the write scope`, even for changes the `read` role allows, such as opening an issue or commenting. `git fetch` and Git LFS downloads still work with it.

The scope is checked only after Diffinery has found a repository the caller can see, so a `read` token's write to a private repository it can't see gets `404 repository not found`, not a scope error that would reveal the repository.

Account-level changes check the scope directly and refuse tokens restricted to repositories (`403 this token is limited to repositories and can't change account settings`). Creating repositories needs `write`; creating organizations, inviting people, managing organization secrets, disabling agents and revoking tokens need `admin`. No token can create a token or an agent: those need a browser session, so a leaked token can't mint another one. Job and sandbox tokens can't start sandboxes either, and a sandbox's credentials last 24 hours at most, and a new token can only be restricted to repositories the account can see (any other name gets `422 unknown repository <name>`). Scopes sent to the API are checked: an empty list or an unknown name is refused with `422 scopes must be a non-empty list of: read, write, admin`, and leaving them out gives `["write"]`. Every new token triggers a security email, and for tokens valid longer than 8 days you get a reminder about 7 days before the token expires. See [Tokens](/docs/accounts/tokens) and [Permissions](/docs/accounts/permissions).

## Repository access

Each request to a repository resolves the caller's role (read, triage, write, maintain or admin) from ownership, organization membership and collaborator grants, then applies the token's scope and repository restriction. Roles are computed on every request, so removing someone from an organization or a repository takes effect immediately, including for tokens they already have. Private repositories return `404 repository not found` to anyone without access, so their existence is not revealed. See [Permissions](/docs/accounts/permissions).

### Anonymous callers only read

Without a token or a session, a caller gets the `read` role on public repositories and nothing on private ones. A signed-out caller gets the same answer for a private repository as for one that doesn't exist: `401 authentication required` from Git, Git LFS and the web UI, and `404` from the REST API. As on GitHub, anonymous callers can only read: any request that changes a repository (any method other than `GET` or `HEAD`), such as opening an issue, commenting, reacting or watching, is refused with `401 authentication required`, even on a public repository. Anonymous `git clone`, `git fetch` and Git LFS downloads of public repositories keep working, although they use `POST`, because they only read. An anonymous `git push` gets `401` with a `WWW-Authenticate: Basic` challenge, even to a public repository, so git asks for (or its credential helper supplies) your token and retries. Unknown paths under `/api/` answer with a JSON `404` (`{"message": "Not Found", "documentation_url": "..."}`), not the web UI's error page.

### Archived repositories

An archived repository is read-only, for everyone including admins, as on GitHub:

- `git push` is refused, and scheduled workflows (`on: schedule`) stop running.
- The web UI shows code, issues and pull requests without any forms to change them. A conversation shows `This repository is archived; the conversation is read-only.`
- Every write through the web UI, the REST API and MCP is refused with `403` and `repository is archived (read-only)`, whatever role the endpoint needs: issues, comments, reviews, pull requests, merges, labels, reactions, releases, statuses, check runs, deployments, git data, and the admin settings (collaborators, branch protection, webhooks, secrets and variables). Reading still works.
- Only these still work: unarchiving, deleting the repository, watching or unwatching it, and linking a container image to it. See [Archive a repository](/docs/repositories/overview#archive-a-repository).

A repository admin archives or unarchives a repository under **Settings**, **General**, with the **Archive** (or **Unarchive**) button and a confirmation. Both are recorded in the [audit log](/docs/security/audit-log) as `repo.archive` and `repo.unarchive`.

## Agent guardrails

Agents are accounts that act on behalf of a person or an organization. They use tokens only, and Diffinery enforces these limits on the server, for git, the REST API, MCP and every other path:

- An agent's role is capped by its **Maximum role** (default write) and never exceeds its owner's role.
- Agents cannot push to the default branch or to protected branches, unless a branch protection rule allows it (`agentsMayPush`).
- Agents cannot merge pull requests into the default branch or protected branches, unless a rule allows it (`agentsMayMerge`).
- Pull requests opened by agents need at least one approval from a person. Only people's approvals count toward required approvals; approvals from agents and workflow tokens never do.
- Agents cannot change branch protection, delete repositories, create agents, or bypass push protection.
- Whatever their role, agents cannot create, update or delete Actions secrets (repository, environment or organization), and cannot create, change or delete Actions variables (repository or environment). They get `403 agents cannot manage secrets` or `403 agents cannot manage variables`.
- Agents never bypass branch protection when merging, even with the admin role.
- Agents cannot create, change or delete [environments](/docs/actions/environments) or their deployment branch policies, and cannot set or delete environment secrets (`only repository admins (people, not agents) can manage environments`).
- Agents cannot dismiss pull request reviews (`agents can't dismiss reviews`).
- Commit statuses and check runs that agents report are shown, but never satisfy a required check in branch protection or in a merge queue. A deployment created without `required_contexts` also ignores contexts reported by agents. See [Checks and statuses](/docs/collaboration/checks-and-statuses).
- Runs of code an agent wrote get no repository or organization secrets unless a repository admin who is a person allows it (`agent_runs_use_secrets`). Workflow runs started by agents receive an environment's secrets only when the environment is limited to protected branches. Tags created or moved by agents never match an environment's tag patterns.
- A workflow run whose code came from an agent (an agent triggered it, pushed the branch last, or opened the pull request, every re-run of such a run, whoever starts it, and every `workflow_run` run that follows it) acts as an agent: its job token is held to these same rules, so it can't push or merge agent-written code into the default branch or a protected branch.
- Commits that agents create through the API or MCP (including commits made with the git data API and the merge commit of `update-branch`) carry a `diffinery-agent` header naming the agent and who it acts for.
- The audit log records who an agent acted for, and security emails about an agent (blocked pushes, new tokens) go to its owner.

See [Agents](/docs/agents/overview).

## Branch protection

Branch protection rules decide how matching branches may change: required pull requests, approvals and checks, stale approval dismissal, linear history, force pushes, deletion, agent permissions and merge queues. When several rules match a branch, the rule that names the branch exactly wins; otherwise the oldest matching pattern applies. With linear history required, a merge commit is refused (`405`); squash or rebase instead. The default branch can never be deleted.

Repository admins can bypass rules unless the rule sets `enforceAdmins`. A merge never bypasses silently: an admin who is a person has to ask for it (**Merge without waiting for requirements (bypass)** in the web UI, `"bypass_rules": true` on `PUT /repos/{owner}/{repo}/pulls/{number}/merge`, or `diffinery pr merge --admin`), only when the pull request has no conflicts and isn't a draft, and each bypassed merge is recorded in the audit log as `pull_request.merge_bypassed` with the unmet requirements. Each bypass covers only what it names: `"bypass_rules": true` skips unmet rules (including a merge commit on a linear-history branch), and `"bypass_merge_queue": true` skips only a required merge queue; bypassing linear history or the queue is audited too. See [Branch protection](/docs/repositories/branch-protection).

Required checks are guarded against spoofing. A required check matches check runs and commit statuses by name, and Diffinery decides which reports count:

- When Diffinery Actions reported a check with that name, only the Actions result counts, so another account cannot post a passing status with the same name.
- A rule can bind a check to one reporter with `requiredCheckSources` (for example `{ "ci/external": "ci-bot" }`); then only that account's reports count.
- Reports from agents never count.
- Only the account that created a check run can update it, and check runs from Diffinery Actions cannot be changed through the API at all.

## Push protection

Every `git push` is scanned for credentials (AWS, GitHub, Diffinery, Slack, Stripe live, Google, Anthropic and OpenAI keys, Diffinery's own job, sandbox and model tokens, and private keys) before anything is stored, in file contents (UTF-8 and UTF-16 text) and in commit and tag messages. A push that contains one is rejected as a whole and nothing from it is kept. A file can opt out with a `diffinery:allow-secret` marker (a credential let through that way is still recorded in the audit log), and a repository admin who is a person can push anyway with `git push -o allow-secrets=<reason>`, which is audited and emailed to the repository's admins.

The same scan runs on every commit made without a Git client: the web editor, `POST /repos/{owner}/{repo}/diffinery/commits`, the contents API (`PUT /repos/{owner}/{repo}/contents/{path}`) and the MCP `commit_files` tool, and on the git data API (blobs, trees with inline `content`, and commit and tag messages). A match is refused with `422` and recorded as `api.blocked_secret` against the caller. Only the commits API has a bypass: a repository admin who is a person sends a reason in `allow_secrets`, which is recorded as `api.secret_bypassed` and emailed to the repository's admins. See [Push protection](/docs/security/push-protection).

## Tree entry names

Every write that builds a tree on the server refuses file and directory names that could be dangerous in a checkout. This covers commits made through the web editor, the contents API, `POST /repos/{owner}/{repo}/diffinery/commits`, the MCP `commit_files` tool and `POST /repos/{owner}/{repo}/git/trees`. A path is refused when any of its segments:

- is `.` or `..`,
- is `.git` in any letter case, or a spelling that Windows or macOS treat as `.git`: with trailing dots or spaces (`.git.`, `.git `), the short name `git~1`, or with invisible characters that macOS ignores (such as zero-width joiners),
- contains `\` or a NUL character,
- is longer than 255 characters,

or when the whole path is longer than 4,096 characters. The commit APIs answer `422` with `invalid path "<path>": <reason>` (for example `invalid path ".git/config": '.git' is reserved`), and the git data API with `invalid tree path ...`. Git's own `fsck` rejects the same names. Downloaded `zipball` and `tarball` archives leave such entries, and everything under them, out.

Pushes made with git are checked the way GitHub checks them with git's `fsck`. A push is refused as a whole, and nothing from it is kept, when a tree in it has an entry that is empty, `.`, `..` or a spelling of `.git`, contains `/`, or appears twice; when `.gitmodules` (in any spelling) is a symbolic link; or when a `.gitmodules` file names a submodule with a `..` part, or gives a `url` or `path` that starts with `-`, which older git clients run as an option. Git prints `remote: Push refused: <reason>`. Names with `\` are allowed in pushes, as in git.

## Secrets encryption

Actions secrets (repository, environment and organization) are encrypted at rest with envelope encryption:

1. The instance has one master key, `MASTER_KEY`, a base64-encoded secret configured on the Worker.
2. For each scope (a repository, `repo:<id>`, an environment, `repo:<id>:env:<name>`, or an organization, `org:<id>`), Diffinery derives a separate 256-bit AES-GCM key from the master key with HKDF-SHA-256.
3. Each secret value is encrypted with its scope's key and a random 96-bit IV. The scope is also bound in as additional authenticated data, so a ciphertext copied from one repository into another fails to decrypt.
4. Only the ciphertext is stored, with the ID of the master key that encrypted it. Values are decrypted inside the repository's Durable Object only when a workflow run needs them.
5. The master key can be rotated: while the replaced key is configured as `MASTER_KEY_PREV`, secrets encrypted with it still decrypt, and everything new is encrypted with the new key. See [Rotating MASTER_KEY](/docs/self-hosting/configuration#rotating-master_key).

Secret values are never returned by the API or shown in the web UI after they are saved; you can only replace or delete them. Only accounts with the admin role (organization owners and admins for organization secrets) can manage secrets, and agents can neither set nor delete them. Without `MASTER_KEY`, secrets cannot be saved. See [Secrets and variables](/docs/actions/secrets-and-variables) and, for operators, [Configuration](/docs/self-hosting/configuration).

Environment secrets have extra limits:

- They are never given to runs of pull request refs (`refs/pull/*`).
- An environment that has no deployment branch policy gets a protected-branches-only policy (`protected_branches: true`) when its first secret is added.
- Runs started by agents get them only when the environment allows protected branches only.

See [Environments](/docs/actions/environments).

## Secret masking in logs

The runner replaces every secret value with `***` in job logs, step names, job summaries and failure messages:

- A job's runner receives only the secrets the job names (`secrets.NAME`), as on GitHub, so a compromised step can't read the others.
- All secrets the job receives are masked, including the job's `GITHUB_TOKEN`.
- A multi-line secret is also masked line by line.
- Values shorter than 3 characters are not masked, to keep logs readable.
- `::add-mask::<value>` masks additional values, as on GitHub.
- A job output whose value contains a secret is dropped with the warning `Skip output '<name>' since it may contain secret.`

Masking is a safety net: a workflow that transforms a secret (for example, base64-encodes it) can still print it. See [Secrets and variables](/docs/actions/secrets-and-variables).

## Job tokens

Each workflow job gets its own token, available as `secrets.GITHUB_TOKEN` and `DIFFINERY_TOKEN`:

- It is issued for one job of one repository and stops working as soon as the job completes. Diffinery stores only its hash.
- It acts as `diffinery-actions[bot]` with the job's effective `permissions:` (the job's, else the workflow's, else the repository default). New repositories default to GitHub's restricted set, `contents` and `packages` read; repositories created before the setting existed default to write. Only a repository admin who is a person can change the default, with `PUT /repos/{owner}/{repo}/actions/permissions/workflow`, and each change is audited as `repo.actions_workflow_settings`. See [Workflow permissions](/docs/actions/workflow-permissions).
- Each API endpoint needs its permission; without it the request gets `403 Resource not accessible by integration`. Reads of public repositories are always allowed, and the token can read other public repositories but no other private one.
- Its role never exceeds write, so branch protection applies. It can't change repository settings, secrets, variables, webhooks, runners or branch protection, and it never creates, changes or deletes workflow files (`.github/workflows/`, `.diffinery/workflows/`), by push, API commit or merge.
- It can't open, approve or request changes on pull requests unless an admin allows it (off by default), and its approvals never count toward required approvals.
- A run whose code came from an agent acts as an agent (see [Agent guardrails](#agent-guardrails)).
- For the [container registry](/docs/packages/container-registry), it can pull and push packages of its own repository according to the workflow's `packages` permission.

[Sandboxes](/docs/agents/sandboxes) get a similar token bound to one sandbox, which acts as the person or agent that created it with at most the write role, can also read public repositories, and stops working when the sandbox is closed.

## OIDC id tokens

Jobs that declare `permissions: id-token: write` can request a short-lived OIDC id token to authenticate to cloud providers without stored credentials. Tokens are signed with ES256 by a key configured on the instance, expire after 10 minutes, use the instance URL as issuer (and as the default audience, unless the job asks for another one), and have GitHub's subject forms (`repo:<owner>/<repo>:environment:<name>` for a job with `environment:`, `repo:<owner>/<repo>:pull_request` for pull request runs, `repo:<owner>/<repo>:ref:<ref>` otherwise), with numeric `repository_id` and `repository_owner_id` claims that a reused name doesn't inherit. The public keys are at `https://diffinery.com/.well-known/jwks`. A job without the permission gets `403` with `this job lacks permissions: id-token: write`. See [OIDC](/docs/actions/oidc).

## Webhook signatures

Webhook payload URLs must use HTTPS and name a public host: `localhost`, private, loopback and link-local addresses, and Diffinery's own host are refused when the webhook is created and checked again on every delivery, so a webhook can't reach the internal network or call Diffinery itself. A repository can have at most 20 webhooks. Every delivery is signed with an HMAC-SHA256 of the body using the webhook's secret, sent as `X-Hub-Signature-256: sha256=<hex>`, the same scheme as GitHub. Diffinery does not follow redirects from your endpoint and gives it 10 seconds to respond. A delivery that fails with a network error or timeout, `408`, `429` or a `5xx` status is retried up to five times, after 1 minute, 5 minutes, 30 minutes, 1 hour and 3 hours, with the same `X-GitHub-Delivery` ID, so your endpoint can deduplicate. Retries stop when the webhook is deleted. See [Webhooks](/docs/repositories/webhooks).

## Audit log

Security-relevant actions go to an append-only audit log: sign-ins, passkey and token changes, agent and organization changes, profile pictures, repository settings (collaborators, branch protection, secrets, variables, webhooks, topics, workflow permissions, whether changed on the web or through the API), organization secrets, environment, environment secret and environment variable changes, cache and artifact deletions, pushes, force pushes and ref deletions, merges, admin merges that bypass branch protection or the merge queue, push protection decisions (for pushes and for commits made without Git), and package changes. Each entry records the actor, who an agent acted for, the action, the target and details. Site admins view it under **Settings**, **Audit log**. See [Audit log](/docs/security/audit-log).

## Security emails

Diffinery emails you about security-relevant events on your account. These emails cannot be turned off in your notification settings:

| Email | When |
|---|---|
| New sign-in to your account | A passkey sign-in from a device not seen before, or any recovery sign-in |
| A passkey was added / removed | A passkey is added to or removed from your account |
| A personal access token was added / A token was created for the agent ... | A token is created for you, or for an agent you own (for an organization's agent, its owners and admins get it) |
| Your token expires on ... | About 7 days before a token expires |
| A new agent was added | You create an agent |
| Your push was blocked: possible secrets | Push protection blocked your push (or your agent's) |
| Push protection was bypassed | An admin pushed or committed past push protection in a repository you administer |
| Your account was disabled / enabled | A site admin changes your account's status |

See [Notifications](/docs/accounts/notifications).

## Data isolation

- **One Durable Object per repository.** Each repository's refs, Git objects, issues, pull requests, reviews, checks, workflow runs, Actions secrets, webhooks and protection rules live in that repository's own Durable Object with its own SQLite storage. It is the only writer for that repository, which also makes ref updates and merges strongly consistent.
- **Authorization before routing.** The Worker resolves the caller and checks their role before a request reaches a repository's Durable Object.
- **Scoped credentials.** Job and sandbox tokens name their repository and are verified by that repository's Durable Object, so they cannot change another repository or read another private one (like anyone, they can read public repositories). Secret encryption keys are derived per repository and per organization.
- **Global data** (accounts, organizations, organization secrets, tokens, invites, notifications and the audit log) lives in a separate D1 database.

See [Architecture](/docs/self-hosting/architecture).

## Reporting a vulnerability

Found a security problem? Report it privately with the [report form](/security/report), the first contact in [`/.well-known/security.txt`](/.well-known/security.txt). [Reporting a vulnerability](/docs/security/disclosure) explains what is in scope, the safe harbour for good-faith research and the response times we aim for.
