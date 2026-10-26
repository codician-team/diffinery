---
title: REST API
description: How to call Diffinery's GitHub-compatible REST API at /api/v3: authentication, IDs, pagination, errors, search, archives and what works by area.
---

Diffinery has a JSON REST API at `https://diffinery.com/api/v3` with the same paths, JSON shapes and errors as GitHub's REST API v3, so Octokit, `curl` scripts and other GitHub clients work when you point them at it. This page explains how the API behaves as a whole: authentication, IDs, pagination, errors, rate limits, search, archives, what works in each area and what doesn't yet. For every endpoint with its parameters, see the generated [API reference](/docs/api), also available as an OpenAPI 3.1 document at [/docs/api/openapi.json](/docs/api/openapi.json).

## Base URL

Every REST endpoint lives under one base URL:

```text
https://diffinery.com/api/v3
```

A `GET` on the base URL itself needs no authentication and describes the API:

```sh
curl https://diffinery.com/api/v3
```

```json
{ "name": "Diffinery", "api": "v3", "docs": "https://diffinery.com/docs/api", "mcp": "https://diffinery.com/mcp", "graphql": "https://diffinery.com/api/graphql" }
```

`GET /api/v3/meta` returns `{"name": "Diffinery", "oidc": true}`, where `oidc` says whether this instance can issue OpenID Connect tokens to workflow jobs.

Some related HTTP interfaces are not under `/api/v3`:

| Interface | Path | Documented in |
| --- | --- | --- |
| Git smart HTTP and Git LFS | `https://diffinery.com/<owner>/<repo>.git` | [Git](/docs/repositories/git), [Git LFS](/docs/repositories/git-lfs) |
| Release asset uploads (the `upload_url` of a release) | `https://diffinery.com/api/uploads/repos/<owner>/<repo>/releases/<id>/assets` | [Release assets](#release-assets) |
| Release asset downloads (`browser_download_url`) | `https://diffinery.com/<owner>/<repo>/releases/download/<tag>/<name>` | [Release assets](#release-assets) |
| Source archives for browsers | `https://diffinery.com/<owner>/<repo>/archive/<ref>.zip` and `.tar.gz` | [Archives](#archives) |
| Profile pictures | `https://diffinery.com/api/avatars/<login>` | [Diffinery-only endpoints](#diffinery-only-endpoints) |
| MCP server for agents | `https://diffinery.com/mcp` | [MCP](/docs/agents/mcp) |
| Container registry (OCI distribution API) | `https://diffinery.com/v2/` | [Container registry](/docs/packages/container-registry) |
| OIDC discovery for workflow tokens | `/.well-known/openid-configuration`, `/.well-known/jwks` | [OIDC](/docs/actions/oidc) |
| Status page | `/status`, and `GET /api/v3/diffinery/status` as JSON | [Status page](/docs/self-hosting/status-page) |
| Health check | `/healthz` returns `{"ok": true}` | |

## Compatibility with GitHub

Point a GitHub client at `https://diffinery.com/api/v3` and it works:

```js
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.DIFFINERY_TOKEN, baseUrl: "https://diffinery.com/api/v3" });
```

What matches GitHub:

- **Paths and parameters.** `/repos/{owner}/{repo}/pulls`, `/repos/{owner}/{repo}/issues/{number}/comments`, `/repos/{owner}/{repo}/releases`, `/search/issues`, `/user`, `/orgs/{org}/repos` and so on, with GitHub's query parameters and request body fields (`merge_method`, `commit_title`, `event: "APPROVE"`, `required_contexts`, `{"config": {"url": ...}}` on webhooks).
- **Response shapes.** Objects carry GitHub's fields, including `node_id`, `url`, `html_url` and the other `*_url` links, full user objects (`login`, `id`, `node_id`, `avatar_url`, `html_url`, `type`) and full label objects (`id`, `name`, `color`, `description`). Timestamps are ISO 8601 without milliseconds, like `2026-10-13T09:30:00Z`.
- **Numeric IDs.** Repository, user, issue, comment, review, review comment, check run, release, release asset, commit status, deployment and reaction IDs are numbers, as on GitHub. See [IDs](#ids).
- **Account types.** A user object's `type` is `User`, `Organization` or `Bot`. Agents are `Bot`.
- **Pagination.** Lists take `per_page` and `page` and send a `Link` header, so `octokit.paginate()` works. See [Pagination](#pagination).
- **Errors.** Error bodies have `message` and `documentation_url`, and validation errors add GitHub's `errors` array. See [Errors](#errors).
- **Headers.** API responses carry `X-GitHub-Media-Type: github.v3; format=json`, `X-GitHub-Api-Version-Selected: 2022-11-28` and `X-RateLimit-*` headers.
- **Aliases.** Collaborator permissions accept GitHub's `pull` and `push` for `read` and `write`, and `private: false` on a repository makes it public.

Responses also keep a few Diffinery fields that the CLI, the MCP server and the web UI read. Clients that only know GitHub's fields can ignore them:

| Object | Extra fields |
| --- | --- |
| Pull request (`GET /pulls/{n}`) | `merge_blockers` (why the caller can't merge it directly yet), `approvals`, `required_approvals`, `checks`, `merge_queue`; for agents and workflow tokens also `auto_merge_blockers` (why auto-merge or the merge queue can't land it for them yet; `[]` means it would now). People merge and auto-merge on the same terms, so they don't get it. |
| Pull request `auto_merge` | `delete_branch`: whether the head branch is deleted once auto-merge lands it |
| Pull request (every response) | `intent`, a short statement of what the change is for, written for reviewers |
| Repository (`GET /repos/{owner}/{repo}`) | `stats` (counts of open issues and pull requests and more), and `permissions.role` |
| Workflow run | `sha` and `ref` (what the run checked out: the test merge commit for `pull_request` runs) and `pull_request_number` |
| Workflow job | Diffinery's own camelCase job fields next to GitHub's snake_case ones |
| Check run | `run_id` and `job_id` of the workflow behind an Actions check |
| Comparison | `base_sha`, `head_sha` and `merge_base` |
| Release | `latest`, whether it is the repository's latest release |
| Pull request file | `binary` |

Fields that describe GitHub features Diffinery doesn't have are present with fixed values, so typed clients don't break: for example `fork: false`, `forks_count: 0`, `stargazers_count: 0`, `watchers_count: 0`, `language: null`, `license: null` and `has_wiki: false`.

### IDs

| Object | `id` |
| --- | --- |
| Users, organizations, agents, repositories | A positive integer derived from the account's or repository's own ID in Diffinery. It is stable, but nothing looks an account or repository up by it: use the login or `owner/repo` in paths. |
| Issues and pull requests | The `id` equals the `number` (issues and pull requests share one number sequence per repository). |
| Issue comments, review comments, reviews, check runs, releases, release assets, commit statuses, deployments, deployment statuses, reactions, issue events | Integers, as on GitHub. Use them in paths such as `/issues/comments/{id}` and `/check-runs/{id}`. |
| Workflow runs, jobs and check suites | 16-digit integers, so clients that expect GitHub's numbers (such as `gh run`) work. Use them in `/actions/runs/{id}`, `/actions/jobs/{id}` and `/check-suites/{id}`; a run's check suite has the run's `id`. These paths also take the 32-character hexadecimal ids in the web UI's addresses (`html_url`) and in webhook payloads. Getting a run, its jobs, logs and attempts, re-running it and listing its artifacts also accept the run's number (`run_number`, which is `github.run_id` inside a workflow): it picks the latest attempt, and for artifacts it covers every attempt. |
| Artifacts and cache entries | Integers, as on GitHub: `/actions/artifacts/{id}`, `/actions/caches/{id}`. An artifact's `workflow_run.id` is the run number. |
| Workflows | An integer derived from the workflow's path. `/actions/workflows/{id}` also accepts the path, such as `.github/workflows/ci.yml`, or the file name, `ci.yml`. |
| Webhooks and tokens | Strings. |

`node_id` is an opaque string, stable for an object. The [GraphQL API](/docs/reference/graphql-api) accepts the `node_id` of a repository or pull request in `node(id:)` and in its mutations.

### Differences to plan for

| Area | GitHub | Diffinery |
| --- | --- | --- |
| Pull requests | Mergeability spread over several calls | `GET /pulls/{n}` also returns `merge_blockers`, `approvals`, `required_approvals` and `checks`, so one call tells you why a pull request can't merge yet. `GET /pulls/{n}/merge` answers GitHub clients (an `Accept: application/vnd.github...` header) with `204` or `404`, and other clients with Diffinery's full mergeability report. |
| Draft pull requests | Marking ready for review or converting to draft is GraphQL only | `PATCH /repos/{owner}/{repo}/pulls/{n}` accepts `"draft": false` (ready for review) and `"draft": true` (back to draft). |
| Merge queue | GraphQL only | REST: `PUT` and `DELETE /repos/{owner}/{repo}/pulls/{n}/merge-queue`, `GET /repos/{owner}/{repo}/merge-queue/{branch}`. See [Merge queue](/docs/collaboration/merge-queue). |
| Auto-merge | GraphQL only (`enablePullRequestAutoMerge`) | REST: `PUT` and `DELETE /repos/{owner}/{repo}/pulls/{n}/auto-merge`. The pull request's `auto_merge` field is filled in while it is on. See [Auto-merge](/docs/collaboration/pull-requests#auto-merge). |
| Text filter on issue lists | Not on the list endpoints | A `q` parameter on `GET /repos/{owner}/{repo}/issues` and `/pulls` matches text in the title and body. |
| Webhook secret | You always choose it | If you create a webhook without `config.secret`, Diffinery generates one and returns it once as `secret` in the response. |
| Release asset upload host | `uploads.github.com` | The same host as the API, under `/api/uploads`. Use the release's `upload_url` and clients find it. |
| Required checks | Decided by GitHub Apps and statuses | When Diffinery Actions reports a check, it alone decides it; other reporters can be bound per check. See [Commit statuses, checks and required checks](#commit-statuses-checks-and-required-checks). |
| Rate limits | Budgets per hour, reported in headers and `GET /rate_limit` | Per-minute limits that stop floods (sign-in and anonymous requests per IP address, signed-in requests and new content per account). The headers and `GET /rate_limit` report a constant budget. See [Rate limits](#rate-limits). |
| CORS | Allowed for some endpoints | No CORS headers. Call the API from a server, a script, a CI job or the CLI, not from JavaScript on another website. |
| People imported from GitHub | Every author is a GitHub account | In a repository [imported from GitHub](/docs/migrate-from-github), people without a linked Diffinery account are mannequins: a user object with `login` `github:<login>`, `type` `Mannequin`, and `html_url` and `url` pointing at their GitHub profile. They can't sign in, and their imported reviews never count as approvals. Search for them with `author:github:<login>`. |

### Transferred and renamed repositories

After a repository is [transferred](/docs/repositories/overview#transfer-a-repository) or renamed, requests that name it by its old owner and name in the path keep working, as on GitHub, for anyone who can read it:

- `GET` and `HEAD` get `301 Moved Permanently`; every other method gets `307 Temporary Redirect`, so a client that follows it repeats the method and body.
- `Location` holds the same URL with the new owner and name (the query string is kept), and the body is `{"message": "Moved Permanently", "url": "<the new URL>", "documentation_url": "..."}`.
- Callers who can't read the repository get `404` (or `401` without credentials), the same answer as for the repository under its new name.
- Old names that appear elsewhere than in the path (for example `repositories` when creating a token restricted to some repositories) are accepted as the repository they now lead to.

`curl` follows redirects with `-L`, and Octokit follows them by itself. The redirect lasts until a repository is created at the old owner and name. Update stored owner and repository names when you see one, and use the repository's numeric `id`, which never changes, to recognize it.

## Authentication

Most endpoints need you to be signed in. Scripts, CI jobs, agents and the CLI authenticate with a personal access token or an agent token. Tokens start with `dfy_`. Create one under **Settings → Access tokens** (`/settings/tokens`). No token can create another token, so `POST /api/v3/diffinery/tokens` needs a browser session (see [Personal access tokens](/docs/accounts/tokens)).

Send the token in the `Authorization` header. Three schemes are accepted, so any GitHub client works:

| Scheme | Example | Typical sender |
| --- | --- | --- |
| `Bearer` | `Authorization: Bearer dfy_...` | curl, fetch, MCP clients, the Diffinery CLI |
| `token` | `Authorization: token dfy_...` | Octokit and other GitHub libraries |
| `Basic` | `Authorization: Basic base64(diffy:dfy_...)` | git, `curl -u`, Docker |

With `Basic`, Diffinery takes the password as the token and ignores the username, so any username works (`x-token`, your login, anything). If the password is empty, the username is used as the token.

```sh
curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/user
curl -u diffy:dfy_... https://diffinery.com/api/v3/user
```

Inside a workflow job, the job's `GITHUB_TOKEN` works with the API too, with the permissions of the job's `permissions:` rather than token scopes. See [Workflow job tokens](#workflow-job-tokens).

Without an `Authorization` header and without a browser session, you are anonymous. Anonymous callers can read public repositories (and `GET /api/v3`, `/api/v3/meta`, `/rate_limit` and search over public repositories); most other endpoints return `401`. As on GitHub, anonymous callers never change anything: every repository request other than `GET` or `HEAD` (opening an issue, commenting, reacting, watching and so on) gets `401 authentication required`, even on a public repository. Anonymous `git clone` and `git fetch` of public repositories and Git LFS downloads keep working, because they only read.

Authentication errors:

| Status | `message` | Cause and fix |
| --- | --- | --- |
| `401` | `invalid, expired or revoked token` | The `dfy_` token is unknown, past its expiry date, revoked, or its account is disabled or not yet active. Create a new token. |
| `401` | `unrecognised token; create one under Settings → Access tokens` | The credential does not start with `dfy_`. GitHub tokens (`ghp_...`) do not work here. |
| `401` | `authentication required` | You called a private resource anonymously, or tried to change something in a repository without a token. Add the `Authorization` header. Reading a private repository anonymously gets `404`, the same as one that doesn't exist. |
| `401` | `malformed basic credentials` | The `Basic` value isn't valid base64. Encode `user:token` with base64. |
| `401` | `sign in required` | The endpoint needs an account (for example `GET /user`) and you sent no credentials. |
| `403` | `your account is waiting for an invite` | Your account exists but no one has invited you yet. Ask an administrator for an invite. |
| `403` | `your account is disabled` | A site administrator disabled the account. |

Every `401` response carries `WWW-Authenticate: Basic realm="Diffinery", charset="UTF-8"`, which makes git and other HTTP clients prompt for credentials.

If a request carries the `Authorization` header twice (git-lfs does this when `http.extraheader` is set), Diffinery uses the first one.

### Token scopes

A token has one or more scopes. The scope caps what the token can do in each repository, on top of the role its account has there:

| Scope | Highest repository role the token can use | Typical use |
| --- | --- | --- |
| `read` | read | Clone, fetch, read issues, pull requests, releases and runs. Never changes anything. |
| `write` (the default) | maintain | Push, open and merge pull requests, comment, create releases, report statuses and check runs, rerun workflows. |
| `admin` | admin | Everything the account can do, including repository settings, secrets, environments, webhooks, branch protection and revoking tokens. No token can create tokens or agents. |

The effective role is the lower of the account's role and the token's cap. A `write` token for someone who only has read access to a repository still only reads; an `admin` token for a repository writer still only writes. See [Permissions](/docs/accounts/permissions) for what each role allows.

A `read` token never writes, even where the `read` role could (opening issues, commenting, reacting): every repository request other than `GET` or `HEAD` gets `403 this token needs the write scope`. `git fetch` and Git LFS downloads, which use `POST` but only read, are the exceptions. MCP tools that aren't read-only also need a `write` token. A write to a private repository the token can't see is `404 repository not found`, not a scope error, so a `read` token can't find out that the repository exists.

A token can also be restricted to a list of repositories. Requests for any other repository then behave as if the repository does not exist (`404`). The list may only name repositories the account can see; any other name is refused with `422 unknown repository owner/name`, whether or not it exists.

When you create a token (`POST /api/v3/diffinery/tokens` or `POST /api/v3/diffinery/agents/{login}/tokens`) or an agent with a first token (`token.scopes` on `POST /api/v3/diffinery/agents`), `scopes` must be a non-empty list of `read`, `write` and `admin`. Leave it out for `["write"]`. An empty list, a value that isn't a list or an unknown name is refused with `422 scopes must be a non-empty list of: read, write, admin`.

Account-level endpoints check the scope directly, and most of them also refuse tokens restricted to repositories with `403 this token is limited to repositories and can't change account settings`. A browser session can call all of them.

| Endpoint | Needs |
| --- | --- |
| `POST /api/v3/user/repos`, `POST /api/v3/orgs/{org}/repos` | A `write` or `admin` token not restricted to repositories. |
| `PUT /api/v3/notifications`, `PUT /api/v3/diffinery/notification-settings`, `POST /api/v3/diffinery/emails/test` | A `write` or `admin` token not restricted to repositories (`403 this token needs the write scope` for a `read` token). |
| `PUT` and `DELETE /api/v3/repos/{owner}/{repo}/subscription` | A `write` or `admin` token (`403 this needs a write or admin token`). |
| `PUT` and `DELETE /api/v3/user/avatar` and `/api/v3/orgs/{org}/avatar` | A `write` or `admin` token that is not limited to repositories (`403 changing a profile picture needs a write or admin token that is not limited to repositories`). |
| `POST /api/v3/diffinery/tokens` | A browser session. Every token gets `403 creating tokens needs a browser session: sign in at https://diffinery.com/settings/tokens`. |
| `DELETE /api/v3/diffinery/tokens/{id}` | An `admin` token not restricted to repositories. |
| `POST /api/v3/user/orgs`, `PATCH /api/v3/orgs/{org}` | An `admin` token not restricted to repositories. |
| `POST /api/v3/orgs/{org}/invitations`, `POST /api/v3/invitations` | An `admin` token not restricted to repositories. |
| `GET /api/v3/user/repository_invitations`, `GET /api/v3/user/memberships/orgs[/{org}]` | A token not restricted to repositories (any scope). |
| `PATCH` and `DELETE /api/v3/user/repository_invitations/{id}`, `PATCH /api/v3/user/memberships/orgs/{org}` | A `write` or `admin` token not restricted to repositories. |
| `GET`, `PUT` and `DELETE /api/v3/orgs/{org}/actions/secrets[/{name}]` | An `admin` token not restricted to repositories. |
| `POST /api/v3/diffinery/agents`, `POST /api/v3/diffinery/agents/{login}/tokens` | A browser session (they mint tokens). Every token gets `403 creating tokens needs a browser session: sign in at https://diffinery.com/settings/tokens`. |
| `DELETE /api/v3/diffinery/agents/{login}` | An `admin` token not restricted to repositories. |
| `POST /api/v3/diffinery/admin/emails/samples` | A site administrator with an `admin` token not restricted to repositories. |
| `POST`, `PATCH` and `DELETE /api/v3/orgs/{org}/actions/variables[/{name}]` | An `admin` token not restricted to repositories (reading them needs only an organization owner or admin). |
| `POST /api/v3/diffinery/imports` | A `write` or `admin` token (`403 starting an import needs a token with write or admin scope`). An import that should bypass push protection for old secrets needs a person's `admin` token or browser session. |
| `POST /api/v3/diffinery/imports/{id}/cancel`, `/retry` and `/selection` | A `write` or `admin` token not restricted to repositories. |
| `POST /api/v3/diffinery/user/linked-accounts/github/challenge`, `POST /api/v3/diffinery/user/linked-accounts/github`, `DELETE /api/v3/diffinery/user/linked-accounts/{id}` | An `admin` token not restricted to repositories. |
| `DELETE /api/v3/diffinery/admin/linked-accounts/{id}` | A site administrator with an `admin` token not restricted to repositories. |

A token whose scope is too low for one of these gets `403 this token needs the write scope` or `403 this token needs the admin scope`.

Agent accounts have extra guardrails that apply however they authenticate. Among them: they can't push or merge to the default branch or protected branches, bypass branch rules when merging, change branch protection, add, change or delete secrets or Actions variables, change environments or their branch policies, dismiss reviews or delete repositories, and the commit statuses and check runs they report never satisfy a required check. See [Agents](/docs/agents/overview#guardrails).

### Browser sessions and tokens

The web UI uses a session cookie that you get by signing in with a passkey. The API endpoints also accept that cookie. A browser session acts with the full role of its account (like an `admin` token).

Because the cookie is sent automatically by the browser, Diffinery refuses state-changing requests that rely on it from another site:

- The check applies to every method except `GET`, `HEAD` and `OPTIONS`, and only when the request has no `Authorization` credential.
- If the browser sends `Sec-Fetch-Site` and its value is anything other than `same-origin` or `none`, the request is refused.
- If there is no `Sec-Fetch-Site` header but there is an `Origin` header that differs from the instance's own origin (`https://diffinery.com`), the request is refused.
- A refused request gets `403` with `{"message": "cross-site request refused"}`.

Requests that carry a token in the `Authorization` header are exempt: they carry no ambient credentials, so this check does not apply to curl, scripts, the CLI, MCP clients or runners. If you see `cross-site request refused` from a script, it means the script sent no token; add the `Authorization` header.

Machines should always use tokens, never browser cookies. Passkeys and browser sessions can only be managed in the web UI; tokens can't add or remove passkeys, and they can't create tokens or agents. Web forms (`/settings/...`, repository settings and the other pages' buttons) refuse requests that carry a token with `403 web forms need a browser session; use the API with a token`, so a token's scope and repository limits always apply.

### Workflow job tokens

A workflow job's `GITHUB_TOKEN` (`secrets.GITHUB_TOKEN`, or `github.token`) authenticates to the REST API at `github.api_url`, to git and to the container registry while the job runs, and stops working when the job ends. It follows GitHub's permission model, not the scopes of personal access tokens:

- **Its permissions** come from the job's `permissions:`, else the workflow's, else the repository default. The default is a repository setting (`default_workflow_permissions` in `GET` and `PUT /repos/{owner}/{repo}/actions/permissions/workflow`, admins only): `read` gives `contents` and `packages` read and nothing else, `write` gives read and write on every scope except `id-token`. New repositories start with `read`; repositories created before the setting existed keep `write`. A reusable workflow never gets more than its caller, and a run for a pull request from another repository only reads.
- **Each endpoint needs its permission**: `issues` for issues and labels, `pull-requests` for pull requests and reviews, `contents` for code, commits, branches, releases and merges, `statuses`, `checks`, `deployments` (also environments), `actions` for runs, artifacts and caches, and so on. Without it: `403 Resource not accessible by integration (the workflow's GITHUB_TOKEN needs permissions: issues or pull-requests: write)`. Reading a public repository works whatever the permissions.
- **Out of reach:** repository settings, collaborators, webhooks, secrets, variables, runners, branch protection, environment changes and the Actions permissions setting (`403 this endpoint is not available to a workflow's GITHUB_TOKEN`). The token's role never goes above write, so branch protection always applies to it.
- **Workflow files:** a job token never creates, changes or deletes files under `.github/workflows/` or `.diffinery/workflows/`, by push, API commit or merge: `refusing to allow a GitHub App to create or update workflow <path> without workflows permission`.
- **Pull requests:** it can open pull requests and approve or request changes only when the repository allows it (`can_approve_pull_request_reviews`); otherwise `403 GitHub Actions is not permitted to create pull requests` (or `approve`). Its approvals never count toward required approvals. It can't re-run workflows.
- **Other repositories:** it reads public repositories (to clone a public submodule or download a public repository's artifacts) and gets `404` for other private ones.
- **Agents:** a run whose code came from an agent (an agent started it, pushed the branch last or opened the pull request, and re-runs of such runs and `workflow_run` runs that follow them) acts as an agent, so the agent guardrails hold for its token.
- **No loops:** what a job does with its token starts no new workflow runs, except `workflow_dispatch` and `repository_dispatch`.

See [Workflow permissions](/docs/actions/workflow-permissions) for the full model and examples.

### Apps

A GitHub-compatible app signs in with a JWT made with its private key (`Authorization: Bearer <jwt>`) on the app endpoints (`/app`, `/app/installations/...`, `/repos/{owner}/{repo}/installation`), and trades it for installation access tokens (`dia_...`) that last an hour. An installation token reaches the repositories the app is installed on, checked per endpoint with the same permission table as a workflow's `GITHUB_TOKEN`, as `<slug>[bot]`; requests outside its permissions get `403 Resource not accessible by integration (the app needs the issues permission: write)`. It never changes settings, secrets or workflow files, and gets `403` on endpoints for people such as `/user`. See [Apps](/docs/repositories/apps).

## Read-your-writes and the x-d1-bookmark header

Account-level data (accounts, organizations, memberships, tokens, the list of repositories and who can access them, invitations, notifications, the audit log, the package index and email settings) can be served from a copy that briefly lags behind the latest write. Every response that read or wrote this data carries a bookmark header that marks how new the data it saw was:

```http
x-d1-bookmark: 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683
```

How a request picks which data it reads:

| Caller | Reads data that is | Sees its own earlier writes? |
| --- | --- | --- |
| Token request with an `x-d1-bookmark` header | At least as new as that bookmark (possibly from a nearby copy) | Yes, every write made up to that bookmark |
| Token request without the header | The latest | Yes, always (at the cost of a longer round trip) |
| Browser | At least as new as the bookmark in its `__Host-dfy_d1` cookie, which Diffinery sets after a write or once you are signed in | Yes |
| Request without credentials or bookmark | From the nearest copy | Not guaranteed |

For API clients this means:

- **You don't have to do anything to be correct.** Token requests without a bookmark read the latest data, so a `GET` right after your `POST` sees the change.
- **To read faster, echo the bookmark.** Take the `x-d1-bookmark` value from your latest response and send it as a request header on the next request. Diffinery may then answer from a copy near you, and it still includes every write up to your bookmark.
- **To hand consistency to another client,** pass the bookmark along. A second process that sends it sees everything the first process wrote before that response.
- Diffinery ignores a header that doesn't look like a bookmark (hexadecimal groups separated by dashes, at most 128 characters) and falls back to the default for your caller type.

```sh
# Create a repository, then list repositories from a copy that already has it.
bm=$(curl -sS -D - -o /dev/null -X POST https://diffinery.com/api/v3/user/repos \
  -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  --data '{"name":"website","private":true}' | tr -d '\r' | sed -n 's/^x-d1-bookmark: //Ip')
curl -sS https://diffinery.com/api/v3/user/repos \
  -H "Authorization: Bearer dfy_..." -H "x-d1-bookmark: $bm"
```

Repository data (git objects and refs, issues, pull requests, reviews, checks, statuses, releases, deployments, environments, workflow runs, secrets and webhooks) is always strongly consistent. Bookmarks don't affect it: a read always sees every earlier write to the same repository.

## Requests and content types

- Send request bodies as JSON. Setting `Content-Type: application/json` is recommended. A body that does not parse as JSON returns `400`, with `{"message": "request body must be JSON"}` or GitHub's `{"message": "Problems parsing JSON"}` depending on the endpoint.
- Endpoints that take no body ignore one. A few `PUT` and `POST` endpoints accept an empty body and use defaults (for example `PUT /repos/{owner}/{repo}/pulls/{n}/merge` and `PUT /repos/{owner}/{repo}/issues/{n}/lock`).
- File contents in the contents and git data APIs are base64: `PUT /repos/{owner}/{repo}/contents/{path}` takes `content` as base64, `POST /git/blobs` takes `encoding: "utf-8"` (the default) or `"base64"`, and reads return `"encoding": "base64"` with the content split into lines of 60 characters. The Diffinery multi-file commit endpoint takes `encoding: "utf-8"` (the default) or `"base64"` per file.
- Path segments that contain a branch, tag, label or file path are taken as written; URL-encode reserved characters (a label named `50%` is `/labels/50%25`).
- Release asset uploads send the file itself as the request body (not JSON). See [Release assets](#release-assets).

Responses:

| Endpoint | Content type |
| --- | --- |
| Almost everything | `application/json` |
| `GET /repos/{owner}/{repo}/contents/{path}`, `/readme` and `/git/blobs/{sha}` with `Accept: application/vnd.github.raw` (or `application/vnd.github.v3.raw`) | The raw bytes, as `text/plain; charset=utf-8` |
| `GET /repos/{owner}/{repo}/raw/{ref}/{path}` | `text/plain; charset=utf-8` for text files, `application/octet-stream` for binary files |
| `GET /repos/{owner}/{repo}/zipball/{ref}`, `/tarball/{ref}` | `application/zip` or `application/gzip`, as a download (see [Archives](#archives)) |
| `GET /repos/{owner}/{repo}/releases/assets/{id}` with `Accept: application/octet-stream` | The asset's bytes, as a download |
| `GET /repos/{owner}/{repo}/actions/runs/{id}/logs` | `application/zip`, one text file per job |
| `GET /repos/{owner}/{repo}/actions/artifacts/{id}/zip` | A `302` redirect to a signed URL, valid for 10 minutes, that serves the artifact (a zip, or the file itself for an artifact uploaded unzipped) |
| `GET /repos/{owner}/{repo}/actions/jobs/{id}/logs` | `text/plain`, one line per log line prefixed with its timestamp. Add `?format=json` for an array of `{t, step, text}` objects. |
| `DELETE` endpoints and some `PUT` endpoints | No body (`204`) |

Every response also carries security headers (`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`) and, whenever the request read or wrote account-level data, the `x-d1-bookmark` header described above. Answers to signed-in people and tokens that aren't errors also carry a `Server-Timing` header, which browsers' developer tools show under Timing: the whole request (`total`), the database queries it made (`d1`, with their count and, when a query said so, the database region that answered and whether it was the primary or a nearby copy) and the calls to the repository's storage (`do`, with their count), in milliseconds, and the Cloudflare location that answered (`colo`). Parallel calls overlap, so their times can add up to more than the total. Downloads (raw files, archives and release assets) are sent with `Content-Security-Policy: sandbox` and as attachments, so browsers never run them as pages.

## Errors

Every API error is a JSON object with a `message`, a `documentation_url` and an HTTP status code, like GitHub's:

```http
HTTP/1.1 404 Not Found
content-type: application/json

{"message": "repository not found", "documentation_url": "https://docs.github.com/rest"}
```

`documentation_url` points at GitHub's REST documentation, so that clients which expect the field (Octokit's `RequestError`, for example) keep working. Validation errors (`422`) usually add GitHub's `errors` array, which names the resource, the field and a code:

```json
{
  "message": "title is required",
  "documentation_url": "https://docs.github.com/rest",
  "errors": [{ "resource": "Issue", "code": "missing_field", "field": "title" }]
}
```

Unexpected server errors return `500` with `{"message": "internal error", "request_id": "..."}`; the details stay on the server. Every `5xx` answer carries a `request_id` in the body and the same value in the `x-request-id` header (on Cloudflare it is the request's Ray ID). Include it when you report a failure: a site administrator finds the error under [Server errors](/docs/admin/site-administration#server-errors).

Write your client to branch on the status code and show `message` to people. Messages are written for humans and may change wording.

A path under `/api/` that Diffinery doesn't know, or a method a known path doesn't support, gets GitHub's JSON `404`, never the web UI's HTML error page:

```json
{ "message": "Not Found", "documentation_url": "https://docs.github.com/rest" }
```

### Status codes

| Status | Meaning in Diffinery | Examples of `message` |
| --- | --- | --- |
| `200 OK` | Success with a body. Also returned when you add a reaction you had already added. | |
| `201 Created` | Something was created: a repository, issue, comment, pull request, review, release, asset, status, check run, deployment, token, webhook, workflow run, sandbox, commit, ref. Also returned by `PUT .../merge-queue` when the pull request joined the queue, and by `PUT .../environments/{env}/secrets/{name}` for a new secret. | |
| `202 Accepted` | Work started in the background: `POST .../actions/runs/{id}/cancel`, `PUT .../pulls/{n}/update-branch`. Also returned by `POST /repos/{owner}/{repo}/transfer` and `DELETE /orgs/{org}`, which have finished when they answer. | |
| `204 No Content` | Success without a body (deletes, settings changes, `POST .../dispatches`). `POST .../merges` also returns `204` when there was nothing to merge, and `POST .../actions/runners/claim` when no job is waiting. | |
| `301 Moved Permanently` | A `GET` or `HEAD` named a repository by an old owner or name, after a [transfer or rename](#transferred-and-renamed-repositories). `Location` (and `url` in the body) is the same request under the new name. | `Moved Permanently` |
| `302 Found` | `GET .../actions/artifacts/{id}/zip` redirects to a signed download URL. | |
| `307 Temporary Redirect` | Any other method on a transferred or renamed repository's old name. Repeat the request, with its method and body, at `Location`. | `Moved Permanently` |
| `205 Reset Content` | `PUT /api/v3/notifications`: every notification marked as read. | |
| `400 Bad Request` | The body is not valid JSON, or the URL has a malformed percent-encoding. | `request body must be JSON`, `Problems parsing JSON`, `malformed percent-encoding in the URL` |
| `401 Unauthorized` | No credentials where they are needed, or a bad token. | See [Authentication](#authentication). |
| `403 Forbidden` | You are signed in but your role, token scope or account kind doesn't allow this. | `write access required`, `admin access required`, `this token needs the write scope`, `this token is limited to repositories and can't change account settings`, `repository is archived (read-only)`, `agents cannot change branch protection`, `agents cannot manage secrets`, `agents cannot manage variables`, `agents can't dismiss reviews`, `only the app that created a check run can update it`, `cross-site request refused`, `Resource not accessible by integration (...)` (a workflow's `GITHUB_TOKEN`), `Confirm it's you: sign in with your passkey again to do this.` (a sensitive call from a browser session signed in more than 2 hours ago; the body has a `confirm` URL) |
| `404 Not Found` | The resource doesn't exist, or it is private and you can't see it. Diffinery doesn't reveal whether a private repository exists, and draft releases are hidden from readers the same way. | `repository not found`, `Branch not found`, `Not Found` |
| `405 Method Not Allowed` | A pull request merge was refused by policy. | `pull request is not mergeable: ...` (followed by the blockers), `main requires a merge queue: add the pull request to the queue`, `main requires linear history; use squash or rebase` |
| `409 Conflict` | Someone else changed the branch, ref or file first, or a merge conflicts. Fetch the latest state and retry. | `branch moved; refresh and retry`, `head branch was modified; review and try again`, `README.md does not match <sha>`, `Merge conflict`, `Git Repository is empty.`, `Already exists - Variable already exists` |
| `410 Gone` | The artifact has expired; it is still listed, but its content is gone. | `Artifact has expired` |
| `413 Payload Too Large` | An upload or a generated archive is over a limit. | `release assets are limited to 100 MB`, `repository is too large for an on-the-fly archive; clone it with git instead` |
| `422 Unprocessable Entity` | The request is understood but invalid. | `title is required`, `invalid secret name`, `webhook URL must use https`, `state must be one of error, failure, pending, success`, `The search is longer than 256 characters.`, `push protection: possible secret detected (...)`, `scopes must be a non-empty list of: read, write, admin` |
| `429 Too Many Requests` | A per-repository budget ran out (only new source archives have one). | `too many archives were built for this repository in the last hour; try again later or clone it with git` |
| `500 Internal Server Error` | A bug or an outage. The body and the `x-request-id` header carry a `request_id` a site administrator can look up. | `internal error` |
| `503 Service Unavailable` | A sandbox container didn't start. | `the sandbox container did not start; try again` |

Every write to an archived repository returns `403 repository is archived (read-only)`, whatever role it needs: pushes, issues, comments, reviews, labels, branch protection, collaborators, secrets, variables, webhooks and MCP tools alike. Only a few calls still work: unarchiving it with `PATCH /repos/{owner}/{repo}` and `{"archived": false}` (admins), deleting it, watching or unwatching it, and linking a package to it. See [Archive a repository](/docs/repositories/overview#archive-a-repository).

## Pagination

Lists take GitHub's `page` and `per_page` query parameters and answer with a `Link` header that points at the other pages:

```http
link: <https://diffinery.com/api/v3/repos/acme/website/issues?state=all&per_page=50&page=2>; rel="next", <https://diffinery.com/api/v3/repos/acme/website/issues?state=all&per_page=50&page=7>; rel="last"
```

- `page` starts at 1. `per_page` is 30 by default and at most 100; larger values are treated as 100.
- The header has `rel="next"` while there are more pages, `rel="prev"` and `rel="first"` after the first page, and `rel="last"` when the total is known. On the last page there is no `next`.
- Follow `rel="next"` until it is missing. That is what `octokit.paginate()` and `gh api --paginate` do.
- Paging over a list that changes while you read it can skip or repeat items, as on GitHub.

Lists with other defaults or without the header:

| Endpoint | Default `per_page` | Notes |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues` and `/pulls` | 30 | Also sends `x-total-count` with the number of matching items. |
| `GET /repos/{owner}/{repo}/actions/runs` | 25 | `total_count` in the body. |
| `GET /repos/{owner}/{repo}/actions/workflows/{id}/runs` | 30 | `total_count` in the body. No `Link` header: page with `page` until you have `total_count` runs. |
| `GET .../actions/artifacts`, `.../actions/runs/{id}/artifacts`, `.../actions/caches` | 30 | `total_count` in the body, and a `Link` header. |
| `GET /repos/{owner}/{repo}/compare/{base}...{head}` (its `commits`), `GET .../pulls/{n}/commits` | 100 | At most 250 commits in total, as on GitHub. |
| `GET .../git/refs`, `.../git/matching-refs/{ref}` | 100 | |
| `GET .../commits/{ref}/status` (its `statuses`) | 100 | |
| `GET .../environments/{env}/variables` | 10 | As on GitHub. |
| `GET /search/issues`, `/search/repositories` | 30 | Only the first 1,000 results can be paged to. |
| `GET /user/packages/container/{name}/versions` (and the same path under `/users/{owner}` and `/orgs/{owner}`) | 30 | No `Link` header; loop until a page has fewer items than `per_page`. |
| `GET /api/v3/diffinery/emails` | 50 | At most 500, no `page` parameter. |

A few lists return everything in one response, with no paging: `GET /user/orgs`, `/orgs/{org}/members`, `/repos/{owner}/{repo}/actions/workflows`, `/actions/secrets`, `/orgs/{org}/actions/secrets`, `/api/v3/diffinery/tokens`, `/api/v3/diffinery/agents`, and `GET /api/v3/notifications`, which returns up to 100 of your most recent unread notifications (add `all=true` to include read ones).

The repository lists (`GET /user/repos`, `/users/{login}/repos` and `/orgs/{org}/repos`) page over at most 500 repositories, most recently pushed first. `GET /user/repos` lists every repository you can see, including public ones you don't own. See [Limits](/docs/reference/limits) for every cap.

Filters on the issue and pull request lists:

| Parameter | Meaning |
| --- | --- |
| `state` | `open` (default), `closed` or `all` |
| `labels` | Comma-separated label names; an item must have all of them |
| `creator` | The author's login |
| `assignee` | A login, `none` (no assignee) or `*` (any assignee) |
| `since` | Only items updated at or after this ISO 8601 time |
| `head`, `base` | Pull requests from or into this branch (`head` also accepts `owner:branch`) |
| `sort`, `direction` | `created` (default), `updated` or `comments` (`popularity` on pulls); `desc` (default) or `asc` |
| `q` | Diffinery: text in the title or body |

Like GitHub, `/issues` includes pull requests; each pull request item has a `pull_request` field. Other filters: workflow runs take `workflow`, `branch`, `status`, `event` and `head_sha`; commits take `sha` (where to start, default `HEAD`), `path`, `author`, `since` and `until`; deployments take `sha`, `ref`, `task` and `environment`; check runs for a ref take `check_name` and `status`; repository-wide comment lists take `since`, `sort` and `direction`.

## Rate limits

Diffinery limits requests per minute to stop floods and scripted abuse:

| What | Limit | Counted by |
| --- | --- | --- |
| Sign-in, passkey registration, invitation and sign-in links, open sign-up (`POST /signup`, `POST /signup/verify`), security reports (`POST /security/report`), early access requests, confirmations and removals (`POST /early-access`, `/early-access/confirm`, `/early-access/remove`, `/early-access/remove/confirm`), contact messages and their confirmations (`POST /contact`, `/contact/confirm`) | 20 a minute | IP address |
| Anything else without signing in (web pages, API, git) | 300 a minute | IP address |
| Anything with a session or token (web, API, MCP, git) | 2,000 a minute | Account |
| Creating repositories, organizations, forks, issues, pull requests, releases, comments, reviews and reports, and MCP tools that change something | 60 a minute | Account |
| Agents' model requests through the model proxy (`/-/model/*`) | 600 a minute | The person who pays for the run |

Workflow jobs, sandboxes, self-hosted runners and imports use their own credentials and aren't counted. The counts are kept in each Cloudflare location, so they stop bursts rather than meter use exactly. Past a limit, the request answers `429` with a message naming the limit, `retry-after: 60` and `x-ratelimit-remaining: 0`; Octokit's throttling plugin waits and retries.

Other responses under `/api/v3` still carry GitHub's budget headers with a constant, generous value, so clients that check their budget keep working:

```http
x-ratelimit-limit: 15000
x-ratelimit-remaining: 15000
x-ratelimit-used: 0
x-ratelimit-reset: 1791887400
x-ratelimit-resource: core
```

`GET /api/v3/rate_limit` answers like GitHub's, with `resources.core`, `search`, `graphql`, `code_search` and others, and the same `rate`.

Cloudflare's own platform limits still apply to each request (for example the maximum request body size of 100 MB). A few operations have budgets of their own, such as building new source archives (20 per repository per hour). Write clients that back off and retry on `429`, `503` and network errors. Size and count limits, such as 100 MB per git push or 256 jobs per matrix, are listed in [Limits](/docs/reference/limits).

## What works, by area

Each area lists what you can do; the [API reference](/docs/api) has every endpoint with its fields. Unless noted, reading needs read access to the repository and changing needs write access.

### Repositories

- Get, create (`POST /user/repos`, `POST /orgs/{org}/repos`), update (`PATCH`, admin) and delete (`DELETE`, admin, people only). `visibility` is `public` or `private`; `private: false` makes a repository public.
- Topics: `GET` and `PUT /repos/{owner}/{repo}/topics` (admin). At most 20 topics, each starting with a lowercase letter or digit, up to 50 characters of lowercase letters, digits and hyphens.
- `GET /languages`: bytes per language, by file extension, leaving out vendored directories such as `node_modules`, `vendor` and `dist`.
- Collaborators: list, add or change (`PUT` with `permission`), remove (admin). As on GitHub, `PUT` invites a person who doesn't have access yet and answers `201` with the invitation (`id`, `repository`, `invitee`, `inviter`, `permissions`, `created_at`, `expires_at`, `html_url`); they get the role once they accept it. For an agent, an existing direct collaborator, a member of the organization that owns the repository or yourself, the role applies at once and `PUT` answers `204`. See [Add people to a repository](/docs/accounts/invitations#add-people-to-a-repository).
- Pending invitations: `GET /repos/{owner}/{repo}/invitations` lists them and `DELETE /repos/{owner}/{repo}/invitations/{id}` revokes one (admin). Each has `id`, `email` (`null` for an invitation sent to a username), `login` (`null` for one sent to an email address), `role`, `inviter`, `created_at` and `expires_at`.
- Branches (with `protected=true|false`), one branch, tags, README (`GET /readme` and `/readme/{dir}`), commits, one commit with its files and stats, compare (`base...head`), and `GET /commits/{sha}/pulls`.
- `POST /merges` merges a branch or commit into a branch (`201` with the merge commit, `204` when there was nothing to merge, `409 Merge conflict`).
- `POST /dispatches` sends a `repository_dispatch` event: `event_type` (up to 100 characters) and an optional `client_payload` object (at most 10 top-level properties, 64 KiB). It returns `204` and starts workflows with `on: repository_dispatch`.
- `POST /transfer` moves the repository to `new_owner` (your own account, or an organization you own or administer), optionally under `new_name`, and returns `202` with the repository. People only, with an `admin` token that isn't limited to repositories. See [Transfer a repository](/docs/repositories/overview#transfer-a-repository).
- Archived repositories are read-only through the API, for everyone, except unarchiving, deleting, transferring and watching. See [Errors](#errors). `PATCH` and the collaborator endpoints are recorded in the audit log, like changes in the web settings pages.

### Your invitations and organization memberships

As on GitHub, a person invited by username accepts or declines the invitation:

- `GET /user/repository_invitations` lists your pending repository invitations, those sent to your username and those sent to your email address. `PATCH /user/repository_invitations/{id}` accepts one and `DELETE` declines it (both `204`).
- `GET /user/memberships/orgs` lists your organization memberships, pending invitations first (`?state=active` or `?state=pending` for one kind), and `GET /user/memberships/orgs/{org}` returns one. Each has `state` (`active` or `pending`), `role` (`admin` or `member`; owners count as `admin`, as on GitHub), `diffinery_role` (`owner`, `admin` or `member`), `organization` and `user`.
- `PATCH /user/memberships/orgs/{org}` with `{"state": "active"}` accepts a pending invitation to the organization and returns the membership.

An unknown id, or someone else's invitation, answers `404 no pending invitation with this id`. See [Invitations you receive](/docs/accounts/invitations#accept-or-decline-with-the-api).

### Contents

- `GET /contents/{path}` returns a file (base64, with `sha`), a directory listing, or a symlink (with `target`). `ref` picks the branch, tag or commit (default: the default branch). `Accept: application/vnd.github.raw` returns the bytes.
- `PUT /contents/{path}` creates or updates one file with a commit: `message`, base64 `content`, optional `branch`, `author` and `committer`. Updating an existing file needs its current blob `sha`, as on GitHub: without it you get `422 "sha" wasn't supplied`, and a stale one gets `409 <path> does not match <sha>`. It returns `201` for a new file and `200` for an update.
- `DELETE /contents/{path}` removes a file with a commit; `sha` is required.
- Every write refuses unsafe tree entry names: `.`, `..`, `.git` in any case and spellings that some systems treat as `.git` (such as `.git.` or `git~1`), and names with `\` or NUL. Push protection scans new file content as it does for `git push`, here and in `POST /repos/{owner}/{repo}/diffinery/commits`: content that looks like a credential is refused with `422 push protection: possible secret detected (...)`. Only the multi-file commit endpoint takes a bypass: a repository admin who is a person sends `"allow_secrets": "<reason>"`, which is audited as `api.secret_bypassed` and emailed to the repository's admins.

### Git data

- Blobs (`POST /git/blobs`, `GET /git/blobs/{sha}`), trees (`POST /git/trees` with `base_tree`, and entries by `sha` or inline `content`; `GET /git/trees/{sha}` with `recursive=1`, cut at 100,000 entries with `truncated: true`), commits (`POST /git/commits` with `author`, `committer` and `signature`; `GET`), annotated tags (`POST /git/tags`, `GET`).
- Refs: `GET /git/ref/{ref}`, `GET /git/refs`, `GET /git/matching-refs/{prefix}`, `POST /git/refs`, `PATCH /git/refs/{ref}` (with `force`), `DELETE /git/refs/{ref}`. Ref updates follow branch protection and the agent guardrails, like a push.
- One tree request can change at most 10,000 entries.

### Archives

`GET /repos/{owner}/{repo}/zipball/{ref}` and `/tarball/{ref}` return a source archive of a branch, tag or commit (the default branch without `{ref}`), with a top directory named `<owner>-<repo>-<short sha>/`, like GitHub's. Browsers can use `https://diffinery.com/<owner>/<repo>/archive/<ref>.zip` or `.tar.gz` (also `refs/heads/<branch>.zip`). Releases and tags link to these as `zipball_url` and `tarball_url`.

- Archives are built on demand the first time a commit is asked for, then cached in R2. The cache can be evicted at any time; the archive is then built again on the next download.
- An archive holds at most 24 MB of file content and 100,000 tree entries. Bigger repositories fail with `413 repository is too large for an on-the-fly archive; clone it with git instead`.
- A zip holds at most 65,535 files (`413 this repository has too many files for a zip archive (more than 65,535); download the .tar.gz archive or clone it with git`). Use the tarball for more.
- Each repository can build 20 new archives per hour. Downloads of cached archives don't count. Past that you get `429`.
- Entries with unsafe names (see [Contents](#contents)) are left out, and submodules appear as empty directories.

Clone bigger repositories with git.

### Releases

- List (newest first), get by id, get by tag (`/releases/tags/{tag}`), latest (`/releases/latest`), create, update and delete. Drafts are visible to writers only: readers get `404` for them and don't see them in lists.
- Publishing a release whose `tag_name` doesn't exist creates the tag at `target_commitish` (default: the default branch); a draft creates its tag when it is published. Ref rules apply to that tag like any other ref update. Only one published release can exist per tag.
- `make_latest` (`true`, `false` or `legacy`), `prerelease`, `draft`, `generate_release_notes`. The body can be up to 125,000 characters.
- `POST /releases/generate-notes` drafts notes from the pull requests merged since the previous release and honours `.github/release.yml` (or `configuration_file_path`). It creates nothing.
- Releases send the `release` webhook event for every change, and start `on: release` workflows (filter with `types:`, such as `published`, `created`, `edited` or `deleted`). Drafts start no workflows until they are published.
- Reactions work on releases too.

See [Releases](/docs/collaboration/releases) for the web UI and the full model.

### Release assets

Upload an asset to the release's `upload_url`, which looks like `https://diffinery.com/api/uploads/repos/acme/website/releases/42/assets{?name,label}`. Send the file as the raw request body, with its content type, and the file name in the `name` query parameter:

```sh
curl -X POST "https://diffinery.com/api/uploads/repos/acme/website/releases/42/assets?name=website-1.4.0.tar.gz&label=Source" \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/gzip" \
  --data-binary @website-1.4.0.tar.gz
```

- An asset can be up to 100 MB, the largest request body Cloudflare Workers accept (`413 release assets are limited to 100 MB`). The bytes are stored in R2.
- Names are cleaned like GitHub does: characters other than letters, digits and `._+@~-` become `.` (so `tool linux.bin` is stored as `tool.linux.bin`), and a name must be 1 to 255 characters. Each name can appear once per release.
- `GET /releases/{id}/assets` lists assets; `GET`, `PATCH` (`name`, `label`) and `DELETE /releases/assets/{id}` manage one.
- Download an asset from its `browser_download_url` (`https://diffinery.com/<owner>/<repo>/releases/download/<tag>/<name>`), or from `GET /releases/assets/{id}` with `Accept: application/octet-stream`. Both count toward `download_count`. Assets of private repositories need a token.

### Commit statuses, checks and required checks

- **Commit statuses:** `POST /statuses/{sha}` (`state` of `error`, `failure`, `pending` or `success`, `context`, `description`, `target_url`), `GET /commits/{ref}/statuses` (also `/statuses/{ref}`) and the combined status `GET /commits/{ref}/status`. A status counts as a check, so a branch protection's required checks can name a status `context`. `context` defaults to `default`. Each commit can have up to 1,000 statuses per context.
- **Check runs:** create (`POST /check-runs`), update (`PATCH /check-runs/{id}`), get, list for a ref (`GET /commits/{ref}/check-runs`) and annotations (`GET /check-runs/{id}/annotations`).
- **Check suites:** `GET /commits/{ref}/check-suites`, `GET /check-suites/{id}` and its check runs. Each workflow run is a suite, and checks from other reporters are grouped into one suite per reporter.
- **Who decides a required check:** when Diffinery Actions reports a check, it alone decides that check. To have a required check decided by someone else, bind it in branch protection, for example `"requiredCheckSources": { "ci/external": "ci-bot" }` (or `diffinery-actions`). A required check fails if any counted report of it fails. Only the account that created a check run can update it, and Actions check runs can't be changed over REST (`403 check runs from Diffinery Actions can't be changed over the API`). Statuses and check runs reported by agents never satisfy a required check.

See [Checks and commit statuses](/docs/collaboration/checks-and-statuses) and [Branch protection](/docs/repositories/branch-protection).

### Issues and pull requests

- Issues: list, create (`labels` and `assignees` from someone without triage access are dropped without an error, as on GitHub), get, update (including `state_reason`; `labels` and `assignees` from someone without triage access are dropped here too), labels (create, get, update, delete; add, set, remove on an issue), assignees (add, remove, `GET /assignees`, `GET /assignees/{login}`), lock and unlock (`PUT` and `DELETE /issues/{n}/lock`, triage), comments (per issue and repository-wide `GET /issues/comments`; get, edit and delete one), events (`GET /issues/{n}/events`, `/issues/events`, `/issues/events/{id}`) and the timeline (`GET /issues/{n}/timeline`).
- Pull requests: list (with the filters in [Pagination](#pagination)), create, get, update, files, commits, merge (`PUT /pulls/{n}/merge` with `merge_method`, `commit_title`, `commit_message`, `sha`), auto-merge (`PUT` and `DELETE /pulls/{n}/auto-merge`), reviews (list, get, submit with line comments), review comments (list per pull request and repository-wide, get, edit, delete, create, and replies with `POST /pulls/{n}/comments/{id}/replies` or `in_reply_to`), requested reviewers (list, add, remove), review dismissal and `update-branch`.
- `GET /pulls/{n}` reports `mergeable`, `mergeable_state` (`clean`, `blocked`, `dirty`, `unknown` and so on) and `rebaseable`, plus Diffinery's `merge_blockers`.
- **Auto-merge:** GitHub turns auto-merge on and off only through GraphQL; Diffinery has `PUT /pulls/{n}/auto-merge` (optional `merge_method`, `commit_title`, `commit_message`) and `DELETE /pulls/{n}/auto-merge`. `PUT` answers `{"state": "enabled" | "queued" | "merged", "auto_merge": {...}, "merge_commit_sha": ...}`, and pull request objects carry GitHub's `auto_merge` object (`enabled_by`, `merge_method`, `commit_title`, `commit_message`) while it is on. Agents and workflow tokens can use it on the default branch or a protected branch only where the rule sets `allowAgentAutoMerge`. See [Auto-merge](/docs/collaboration/pull-requests#auto-merge).
- **Drafts:** `PATCH /pulls/{n}` with `"draft": false` marks a draft ready for review, and `"draft": true` converts it back (a Diffinery addition; GitHub only offers this through GraphQL). The pull request's author or anyone with write access can do it, only while it is open (`422 the pull request is not open`; others get `403 only the author or someone with write access can change draft status`). It records a `ready_for_review` or `convert_to_draft` event on the timeline (GitHub's names) and sends a `pull_request` webhook with the action `ready_for_review` or `converted_to_draft`. The web UI's **Ready for review** button and `diffinery pr ready` do the same.
- **Merging past branch rules:** a merge that branch protection blocks fails with `405 pull request is not mergeable: ...`. A repository admin who is a person can merge anyway by sending `"bypass_rules": true` with `PUT /pulls/{n}/merge`, unless the rule turns on **Do not allow administrators to bypass these rules** (`enforceAdmins`), and only when the pull request has no conflicts and isn't a draft. Without the flag, admins are blocked like everyone else, and the error ends with `(as an admin you can bypass with bypass_rules)`. Each flag covers only what it names: `"bypass_rules": true` skips unmet rules (and linear history), and `"bypass_merge_queue": true` merges past a required merge queue but not past unmet rules. A merge that bypassed rules, linear history or the queue is recorded in the audit log as `pull_request.merge_bypassed`. `diffinery pr merge --admin` sends both flags. Agents and workflow tokens can't bypass.
- **Linear history:** when the base branch's rule requires linear history, `merge_method: "merge"` is refused with `405 <branch> requires linear history; use squash or rebase` (unless an admin sends `bypass_rules`), and a merge without `merge_method` uses `squash`.
- **Workflow tokens and reviews:** a workflow's `GITHUB_TOKEN` can open pull requests and approve or request changes only when the repository allows it (see [Workflow job tokens](#workflow-job-tokens)), and only people's approvals count toward required approvals.
- Changing an issue's or pull request's title or body sends an `issues` or `pull_request` webhook with the action `edited`.
- `PUT /pulls/{n}/update-branch` merges the base branch into the head branch (optional `expected_head_sha`) and returns `202`.
- `PUT /pulls/{n}/reviews/{id}/dismissals` with a `message` dismisses an approving or change-requesting review. It takes maintain access; the pull request's author can't dismiss reviews on it, and agents can't dismiss reviews at all.
- **Locked conversations** refuse new comments, review comments and reactions from people without triage access.
- **Reactions** (`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`) on issues and pull requests, issue comments, review comments and releases: list (filter with `content`), add (`201`, or `200` if you had already reacted) and delete by id.
- Comment, review, review comment, event and reaction IDs are numbers.
- Team reviewers (`team_reviewers`) are refused with `422 team reviewers are not supported; request people by login`.
- **Milestones:** `GET /milestones` (`state` `open`, `closed` or `all`), `GET /milestones/{n}`, `POST /milestones` and `PATCH /milestones/{n}` (triage). There is no `DELETE`. Set an issue's or pull request's milestone with `PATCH /issues/{n}` and `"milestone": <number>` or `null` (triage); issues and pull requests carry a `milestone` object.

### Moderation

As on GitHub, a person or an organization's owners block people, people report abuse, and site administrators suspend accounts. See [Blocking and reporting](/docs/accounts/blocking-and-reporting) and [Site administration](/docs/admin/site-administration#reports).

- **Blocks:** `GET /user/blocks`, and `GET`, `PUT`, `DELETE /user/blocks/{username}`; `GET /orgs/{org}/blocks`, and `GET`, `PUT`, `DELETE /orgs/{org}/blocks/{username}` (organization owners). `GET` on one answers `204` if blocked and `404` if not. In the blocker's repositories, a blocked person (or their agent) gets `403 you can't open issues or pull requests, comment, review or react in <owner>'s repositories: <owner> blocked you` for new issues, pull requests, comments, reviews and reactions, and adding them as a collaborator fails with `422`.
- **Reports:** `POST /diffinery/reports` (people, `write` scope; at most 20 a day). Site administrators: `GET /admin/reports` (`state` `open`, `resolved` or `all`; `page`, `per_page`; the total is in `x-total-count`), `GET /admin/reports/{id}` and `PATCH /admin/reports/{id}` with `state` (`resolved` with a `resolution` note, or `open`).
- **Suspensions:** `PUT /users/{username}/suspended` with `{"reason": "..."}` and `DELETE /users/{username}/suspended` (site administrators, `admin` scope; GitHub Enterprise's endpoints). While suspended, the person's tokens and their agents' get `401`, and their profile, repositories, issues and pull requests answer `404` to everyone but site administrators; their comments and reviews are left out of lists. Site administrators see `suspended_at` and `suspension_reason` on `GET /users/{username}`.
- **Hidden comments:** `PUT /repos/{owner}/{repo}/diffinery/comments/{id}/minimized` with `reason` (`spam`, `abuse`, `off_topic`, `outdated`, `duplicate` or `resolved`) and `DELETE` on the same path (write access, people only), GitHub's GraphQL `minimizeComment` and `unminimizeComment` as REST. See [Hide a comment](/docs/collaboration/issues#hide-a-comment).

### Deployments and environments

- **Deployments:** create, list, get and delete; deployment statuses: create, list and get. A deployment without `required_contexts` needs every check and status on the commit to have passed, as on GitHub (those reported by agents are not counted); send `"required_contexts": []` to skip the check. A deployment whose contexts haven't passed is refused with `409`.
- **Environments:** list, get, create or update (`PUT /environments/{name}`), delete; deployment branch policies (`protected_branches` or `custom_branch_policies` with branch and tag patterns); environment secrets (names only, never values) and variables. Changing environments, their branch policies and secrets takes admin access, and agents can't do it. Required reviewers (people) and wait timers hold jobs before they start; pending deployments (`GET` and `POST /actions/runs/{run_id}/pending_deployments`) and `GET /actions/runs/{run_id}/approvals` work as on GitHub.
- An environment with no branch policy is limited to protected branches when its first secret is added. Environment secrets never go to `refs/pull/*` runs. Runs started by agents get them only when the environment allows protected branches only. Tags pushed by agents never match an environment's tag patterns.
- A workflow job with `environment:` creates a deployment, gets that environment's secrets and variables, and is refused if the environment's branch policy doesn't allow the ref.

See [Environments](/docs/actions/environments).

### Actions

- Workflows (list, get by path or file name, `POST /actions/workflows/{id}/dispatches`), runs (list, per workflow, get, attempts `GET /actions/runs/{id}/attempts/{n}`, cancel, `rerun` and `rerun-failed-jobs`), jobs (per run, get, `POST /actions/jobs/{id}/rerun`), logs (a zip per run, or text per job).
- **Artifacts:** `GET /actions/artifacts` (every artifact, newest first, `name` filter), `GET /actions/runs/{id}/artifacts` (one run; a run number covers all its attempts), `GET` and `DELETE /actions/artifacts/{id}`, and `GET /actions/artifacts/{id}/zip`, which redirects (`302`) to a signed URL valid for 10 minutes. Artifacts have numeric IDs, `digest`, `expires_at` and `expired`. An artifact past its retention (1 to 90 days, from `retention-days`) loses its content but stays listed with `expired: true` for 90 more days; downloading it gets `410 Artifact has expired`. Deleting needs write access and is audited as `actions.artifact.delete`.
- **Caches:** `GET /actions/caches` (filter with `key` prefix and `ref`, sort by `last_accessed_at`, `created_at` or `size_in_bytes`), `DELETE /actions/caches?key=<key>[&ref=<ref>]` (returns the deleted entries), `DELETE /actions/caches/{id}`, and `GET /actions/cache/usage` (`active_caches_size_in_bytes`, `active_caches_count`). Each entry has its `ref` (like `refs/heads/main`), `key` and `version`. Deleting needs write access and is audited as `actions.cache.delete`. See [Caching and artifacts](/docs/actions/caching-and-artifacts) and [Limits](/docs/reference/limits#caches-and-artifacts).
- **Workflow permissions:** `GET` and `PUT /actions/permissions/workflow` read and change `default_workflow_permissions` (`read` or `write`) and `can_approve_pull_request_reviews`. Admins only, people only; each change is audited as `repo.actions_workflow_settings`.
- Repository secrets (list names, set with `value`, delete; admin, people only), organization secrets (organization owners and admins, people only), repository variables (`GET`, `POST`, `PATCH`, `PUT`, `DELETE`; reading needs write access, changing needs admin), organization variables (`GET`, `POST`, `PATCH`, `DELETE /orgs/{org}/actions/variables`; organization owners and admins, people only), and environment secrets and variables.
- Organization variables reach every repository of the organization as `vars.NAME`; a repository variable with the same name wins. `GET /repos/{owner}/{repo}/actions/variables` lists only the repository's own. Unlike GitHub, `POST` on an existing organization variable replaces its value instead of answering `409`, `PATCH` can't rename, and `visibility` is always `all`. Changes are audited as `org.variable_set` and `org.variable_delete`.
- Changing repository secrets and variables, environment variables and organization secrets is recorded in the audit log (`repo.secret.set`, `repo.variable.set`, `environment.variable.set`, `org.secret.set` and the matching `.delete` actions). Renaming a variable onto a name that exists fails with `409 Already exists - Variable already exists`.
- Secrets are sent as plain `value` over HTTPS and encrypted at rest. GitHub's sealed-box `encrypted_value` is not supported yet: `422 encrypted_value (sealed box) is not supported yet: send the secret as value over HTTPS; it is encrypted at rest`.

### Webhooks

List, create (`config.url` must use `https`, `events` defaults to all) and delete repository webhooks (admin; creating and deleting are audited as `repo.webhook.create` and `repo.webhook.delete`). Webhooks get the `release`, `status`, `deployment`, `deployment_status` and `workflow_dispatch` events as well as pushes, pull requests, issues and the rest, including the `edited`, `ready_for_review` and `converted_to_draft` actions. A delivery that fails with a network error or timeout, `408`, `429` or a `5xx` status is retried up to five times (after 1 minute, 5 minutes, 30 minutes, 1 hour and 3 hours) with the same `X-GitHub-Delivery` ID. See [Webhooks](/docs/repositories/webhooks) and [Webhook events](/docs/reference/webhook-events).

### Workflows started by API calls

- A release starts `on: release` workflows (with `types:` matching the action, such as `published`). Drafts start nothing until they are published.
- `POST /repos/{owner}/{repo}/dispatches` starts `on: repository_dispatch` workflows (with `types:` matching `event_type`), with `client_payload` in `github.event.client_payload`.
- `POST /actions/workflows/{id}/dispatches` starts a `workflow_dispatch` run.
- As on GitHub, events caused by a job's `GITHUB_TOKEN` don't start new workflow runs, except `workflow_dispatch` and `repository_dispatch`.

See [Events that trigger workflows](/docs/actions/events).

## Search

`GET /search/issues` searches issues and pull requests, and `GET /search/repositories` searches repositories, with GitHub's query syntax in `q`:

```sh
curl -sS -G https://diffinery.com/api/v3/search/issues \
  -H "Authorization: Bearer dfy_..." \
  --data-urlencode 'q=repo:acme/website is:pr is:open label:bug "contact sales"' \
  --data-urlencode 'sort=updated'
```

The response is `{"total_count": ..., "incomplete_results": false, "items": [...]}`; items are issue or repository objects with `score: 1`.

Search only covers repositories you can read. Anonymous callers search public repositories, and a workflow job's token searches its own repository.

### Issue and pull request search

| Qualifier | Meaning |
| --- | --- |
| `repo:owner/name` | Only this repository (repeat it for several) |
| `user:`, `org:`, `owner:` | Only repositories of this account |
| `is:issue`, `is:pr` (also `type:`) | Issues or pull requests |
| `is:open`, `is:closed` (also `state:`) | By state |
| `is:merged`, `is:unmerged` | Merged or unmerged pull requests |
| `is:draft`, `draft:true`, `draft:false` | Draft pull requests |
| `is:locked`, `is:unlocked` | Locked conversations |
| `label:bug` | Has this label. `label:a,b` and repeated `label:` qualifiers require every label. |
| `-label:wontfix` | Doesn't have this label |
| `no:label`, `no:assignee` | Has no labels, or no assignee |
| `author:diffy`, `-author:diffy` | Opened, or not opened, by this login |
| `assignee:diffy` | Assigned to this login |
| `head:branch`, `base:branch` | Pull requests from or into this branch |
| `in:title`, `in:body`, `in:comments` | Where words must match (default: title and body); combine as `in:title,body` |
| `created:`, `updated:`, `closed:` | Dates: `2026-10-01`, `>2026-10-01`, `>=`, `<`, `<=`, `2026-09-01..2026-09-30`, `2026-09-01..*` |
| `sort:created-desc` | `created`, `updated` or `comments`, with `-asc` or `-desc`. The `sort` and `order` query parameters override it. |

Words without a qualifier must all appear (case-insensitive), `"quoted phrases"` match as written, and `-word` excludes items that contain the word. Unknown qualifiers are searched as text. Without a sort, results are newest first.

### Repository search

| Qualifier | Meaning |
| --- | --- |
| `user:`, `org:`, `owner:` | Repositories of this account |
| `repo:owner/name` | This repository |
| `topic:docs` | Has this topic (repeat for several) |
| `is:public`, `is:private` | By visibility |
| `archived:true`, `archived:false` | Archived or not |
| `in:name`, `in:description`, `in:topics` | Where words must match (default: all three) |

Words match the name, `owner/name`, description and topics. `sort=updated` sorts by the last push; otherwise the most recently pushed repositories come first. The qualifiers `fork:`, `language:`, `stars:`, `forks:`, `size:`, `pushed:` and `created:` are accepted but ignored: Diffinery has no forks, stars or language index.

### Search limits

| Limit | Value |
| --- | --- |
| Query length | 256 characters (`422 The search is longer than 256 characters.`). An empty `q` returns `422 Validation Failed`. |
| Results you can page to | The first 1,000 (`422 Only the first 1000 search results are available`) |
| Repositories one issue search looks at | 50 readable repositories (10 without signing in), taken from the up to 500 most recently pushed repositories you can see. When more matched, `incomplete_results` is `true`; narrow the search with `repo:` or `org:`. |
| Repositories one repository search checks | 300 candidates, from the same up to 500. More sets `incomplete_results`. |
| Issues scanned per repository | The 5,000 most recent issues and pull requests |
| Comments read for `in:comments` | The 2,000 most recent comments per repository |

Code search and commit search are not supported yet.

## Not supported yet

- GraphQL (`/api/graphql`) beyond repositories, pull requests and CI. See [GraphQL API](/docs/reference/graphql-api) for what it answers.
- Setting secrets with a sealed-box `encrypted_value`; send `value` instead.
- Team reviewers and custom deployment protection rules on environments.
- Forks, and team reviewers.
- Apps: signing people in with an app's OAuth (user-to-server tokens), the app manifest flow, and GraphQL with installation tokens.
- Code search and commit search. Search qualifiers for stars, forks and languages are accepted but ignored.

An Octokit method for an endpoint Diffinery doesn't have fails, usually with `404`. Check the [API reference](/docs/api) before you reuse a GitHub script.

## Diffinery-only endpoints

Endpoints that have no GitHub equivalent live under `/api/v3/diffinery` (or `/repos/{owner}/{repo}/diffinery/...` when they belong to a repository):

| Endpoint | What it does |
| --- | --- |
| `GET`, `POST /diffinery/tokens`, `DELETE /diffinery/tokens/{id}` | List, create and revoke your tokens. `POST` takes `name`, `scopes` (a non-empty list of `read`, `write`, `admin`; default `["write"]`), `repositories` (`["acme/website"]`, only repositories you can see) and `expires_in_days`, and returns the token once. Creating needs a browser session; revoking needs an `admin` token not restricted to repositories. |
| `GET`, `POST /diffinery/agents` | List the agents you or your organizations own, and create an agent (it comes with a first `write` token valid for 90 days unless you pass `token`). Creating needs a browser session. |
| `POST /diffinery/agents/{login}/tokens` | Create another token for an agent you own. Needs a browser session. |
| `DELETE /diffinery/agents/{login}` | Disable an agent and revoke its tokens. Needs an `admin` token not restricted to repositories. |
| `POST /repos/{owner}/{repo}/diffinery/commits` | Commit several files at once without a git client: `branch`, `message`, optional `base` (creates the branch from it) and `expected_head_sha` (fails with `409` if the branch moved), and `files` (each with `path`, `content`, `encoding`, `mode` or `delete`). Push protection applies; a repository admin who is a person can pass `allow_secrets` with a reason. Needs write access. |
| `POST /repos/{owner}/{repo}/diffinery/sandboxes` | Start a sandbox container with the repository checked out. See [Sandboxes](/docs/agents/sandboxes). |
| `POST /repos/{owner}/{repo}/diffinery/sandboxes/{id}/exec`, `/read`, `/write`, `/close` | Run a command, read or write a file, or stop the sandbox. |
| `GET`, `PUT /diffinery/notification-settings` | Your notification settings. `PUT` is a partial update: send only the groups you change. |
| `GET /diffinery/emails` | Emails Diffinery sent you recently (`per_page`, `kind`, `since`). Site administrators can add `all=1`. |
| `POST /diffinery/emails/test` | Send yourself a test email now. |
| `GET /diffinery/admin/email`, `POST /diffinery/admin/emails/samples` | Site administrators: email delivery status, and send every email template to yourself. |
| `GET`, `POST /diffinery/imports`, `GET /diffinery/imports/{id}`, `POST /diffinery/imports/{id}/cancel`, `/retry`, `/selection` | Import repositories from GitHub, follow and manage the imports. See [Imports](#imports). |
| `GET /diffinery/user/linked-accounts`, `POST /diffinery/user/linked-accounts/github/challenge`, `POST /diffinery/user/linked-accounts/github`, `DELETE /diffinery/user/linked-accounts/{id}` | Link your GitHub account (gist proof, no token), so imports attribute your GitHub work to you. |
| `DELETE /diffinery/admin/linked-accounts/{id}` | Site administrators: clear anyone's GitHub link. |
| `POST /diffinery/reports` | Report a person, repository, issue, pull request or comment to the site administrators. See [Moderation](#moderation). |
| `PUT`, `DELETE /repos/{owner}/{repo}/diffinery/comments/{id}/minimized` | Hide (minimize) a comment with a reason, or show it again. |
| `GET /diffinery/status` | The [status page](/docs/self-hosting/status-page) as JSON, shaped like Statuspage's summary: `status`, `components`, unresolved `incidents` and `updated_at`. No authentication needed. |
| `GET`, `POST /diffinery/admin/status/incidents`, `POST /diffinery/admin/status/incidents/{id}/updates` | Site administrators: list and open status incidents, and post updates that resolve them. See [Site administration](/docs/admin/site-administration#status). |

Other Diffinery additions sit next to the GitHub-shaped endpoints:

- `POST /api/v3/user/orgs` creates an organization; `POST /api/v3/invitations` (site administrators) and `POST /api/v3/orgs/{org}/invitations` invite people by email. `GET /api/v3/orgs/{org}` and `PATCH /api/v3/orgs/{org}` (owners) follow GitHub: `default_repository_permission` is the organization's base permission (`none`, `read`, `write` or `admin`), shown to members and site administrators, and `PATCH` also takes the display `name`. See [Base permission](/docs/accounts/organizations#base-permission).
- `PUT /api/v3/user/avatar` sets your profile picture from the raw image in the request body (JPEG, PNG or WebP, up to 5 MB and 3072×3072 pixels), and `DELETE` goes back to generated initials. `PUT` and `DELETE /api/v3/orgs/{org}/avatar` do the same for an organization (owners only). Both return `{"avatar_url": ...}`. `GET /api/avatars/{login}?s=64|128|256` serves the picture to anyone, as WebP, or initials as SVG; it is the `avatar_url` of every user object.
- `PUT`, `DELETE /repos/{owner}/{repo}/pulls/{n}/merge-queue` and `GET /repos/{owner}/{repo}/merge-queue/{branch}` drive the merge queue.
- `PUT /repos/{owner}/{repo}/pulls/{n}/auto-merge` turns on auto-merge (GitHub's `enablePullRequestAutoMerge`, which it offers through GraphQL only) with `merge_method`, `commit_title`, `commit_message`, `delete_branch` and `sha` (`409` if the head moved); `DELETE` turns it off (`diffinery pr merge --auto` and `--disable-auto`). It returns `{"state": "enabled" | "queued" | "merged", "auto_merge": ..., "merge_commit_sha": ...}`.
- `POST /repos/{owner}/{repo}/actions/runners/claim` is how self-hosted runners pick up jobs, with the runner token they get from `POST .../actions/runners/register` and a registration token (`POST .../actions/runners/registration-token`). `GET .../actions/runners` and `DELETE .../actions/runners/{id}` list and remove them (see [Runners](/docs/actions/runners#manage-runners)).
- `GET /repos/{owner}/{repo}/raw/{ref}/{path}` returns a file's raw bytes.
- `GET /repos/{owner}/{repo}/packages` lists container images linked to a repository, and `PATCH` on a package changes its visibility or linked repository.

```sh
curl -X PUT https://diffinery.com/api/v3/user/avatar \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: image/png" --data-binary @me.png
```

The [API reference](/docs/api) lists every endpoint with its request and response fields.

## Imports

Diffinery imports repositories from GitHub.com or GitHub Enterprise Server on the server: Git history with LFS objects, issues and pull requests with their original numbers, comments, reviews, labels, milestones, branch protection, Actions variables, deployment environments and releases. You start an import with one request and poll it; nothing goes through your machine. The web form (**Import from GitHub**), `diffinery migrate github` and the MCP tool `start_github_import` use the same service. For the whole procedure, what is and isn't copied, and how people are attributed, read [Migrate from GitHub](/docs/migrate-from-github).

```sh
# Import one repository into the acme organization
curl -sS -X POST https://diffinery.com/api/v3/diffinery/imports \
  -H "Authorization: Bearer dfy_..." -H "Content-Type: application/json" \
  -d '{"source": "diffy/hello-world", "owner": "acme", "name": "website", "github_token": "ghp_..."}'

# Follow it until status is succeeded, failed or cancelled
curl -sS https://diffinery.com/api/v3/diffinery/imports/<id> -H "Authorization: Bearer dfy_..."
```

| Endpoint | What it does |
| --- | --- |
| `POST /diffinery/imports` | Start an import: `source` (one repository) or `source_owner` (a GitHub organization or user, with optional `repositories`, `exclude_forks`, `exclude_archived` and `concurrency`), `owner`, and optional `name`, `visibility` (`keep`, `private` or `public`), `github_token`, `github_api_url` and `options`. Returns `201` with the import. |
| `GET /diffinery/imports`, `GET /diffinery/imports/{id}` | Your imports, and one import with its `status`, per-step progress (`steps`), the Git transfer (`git`), `summary` (counts, secret names to set by hand, push protection findings), `warnings`, `error` and, for an organization import, `children`. |
| `POST /diffinery/imports/{id}/cancel` | Stop an import that hasn't finished. |
| `POST /diffinery/imports/{id}/retry` | Run a failed or cancelled import again (`202`), optionally with a new `github_token`. Only whoever started it. |
| `POST /diffinery/imports/{id}/selection` | Start an organization import that was drafted in the web form, with the chosen `repositories`. |

Things to know when you script imports:

- **Token:** starting one needs a `write` or `admin` token (or a browser session). Old history with credentials in it is imported with an audited push protection bypass only when a person who administers the target started the import with an `admin` token or the web UI; otherwise the import fails and names the findings. See [Push protection](/docs/security/push-protection).
- **Agents** can import only into an organization that owns them or that their owner owns or administers. Their imports never bypass push protection and skip Actions variables and environments.
- **Secret values are never read or copied.** Only secret names are listed in `summary`, for a repository admin to set by hand.
- **Limits:** one organization import and three repository imports at a time per account and per target (`429`), and more. See [Limits](/docs/reference/limits#imports).
- **The GitHub token** is encrypted, used only by that import and deleted when it ends. It is never returned.

Every endpoint, with its fields and errors, is in the [API reference](/docs/api).

## Using the API

The examples below list open pull requests in `acme/website` and open a new issue. Replace `dfy_...` with your token.

### curl

```sh
export DIFFINERY_TOKEN=dfy_...

# Who am I?
curl -sS https://diffinery.com/api/v3/user -H "Authorization: Bearer $DIFFINERY_TOKEN"

# Open pull requests
curl -sS "https://diffinery.com/api/v3/repos/acme/website/pulls?state=open" \
  -H "Authorization: Bearer $DIFFINERY_TOKEN"

# Open an issue
curl -sS -X POST https://diffinery.com/api/v3/repos/acme/website/issues \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" \
  -H "content-type: application/json" \
  --data '{"title": "Broken link on the pricing page", "body": "The FAQ link returns 404.", "labels": ["bug"]}'

# Report an external CI result on a commit
curl -sS -X POST https://diffinery.com/api/v3/repos/acme/website/statuses/9be41d07 \
  -H "Authorization: Bearer $DIFFINERY_TOKEN" -H "content-type: application/json" \
  --data '{"state": "success", "context": "ci/external", "target_url": "https://ci.example.com/builds/812"}'
```

Add `-f` (`--fail`) in scripts so curl exits non-zero on `4xx` and `5xx`, or `--fail-with-body` to still print Diffinery's `message`.

To follow the `Link` header in a shell script:

```sh
url="https://diffinery.com/api/v3/repos/acme/website/issues?state=all&per_page=100"
while [ -n "$url" ]; do
  curl -fsS -D headers.txt "$url" -H "Authorization: Bearer $DIFFINERY_TOKEN" | jq -r '.[] | "#\(.number) \(.title)"'
  url=$(tr -d '\r' < headers.txt | sed -n 's/^link: .*<\([^>]*\)>; rel="next".*/\1/Ip')
done
```

### fetch

From Node.js 22 or later, Deno, Bun or a Cloudflare Worker:

```js
const base = "https://diffinery.com/api/v3";
const headers = { authorization: `Bearer ${process.env.DIFFINERY_TOKEN}`, "content-type": "application/json" };

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.message ?? res.statusText}`);
  return data;
}

const pulls = await api("GET", "/repos/acme/website/pulls?state=open");
for (const pr of pulls) console.log(`#${pr.number} ${pr.title} (${pr.head.ref})`);

const issue = await api("POST", "/repos/acme/website/issues", { title: "Broken link on the pricing page" });
console.log(issue.html_url);
```

Browsers on other websites can't call the API: Diffinery sends no CORS headers.

### Octokit

Point Octokit at Diffinery with `baseUrl`. Octokit sends the token as `Authorization: token dfy_...`, which Diffinery accepts, and its pagination, errors and release uploads work as they do against GitHub:

```js
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ baseUrl: "https://diffinery.com/api/v3", auth: process.env.DIFFINERY_TOKEN });
const R = { owner: "acme", repo: "website" };

const { data: repo } = await octokit.rest.repos.get(R);
console.log(repo.default_branch, repo.html_url);

// Every open issue and pull request, following the Link header.
const all = await octokit.paginate(octokit.rest.issues.listForRepo, { ...R, state: "open", per_page: 100 });
console.log(`${all.length} open issues and pull requests`);

await octokit.rest.issues.createComment({ ...R, issue_number: 42, body: "Looks good to me." });
await octokit.rest.pulls.merge({ ...R, pull_number: 42, merge_method: "squash" });

// A release with an asset.
const { data: release } = await octokit.rest.repos.createRelease({ ...R, tag_name: "v1.4.0", generate_release_notes: true });
await octokit.rest.repos.uploadReleaseAsset({
  ...R,
  release_id: release.id,
  url: release.upload_url,
  name: "website-1.4.0.tar.gz",
  data: await readFile("website-1.4.0.tar.gz"),
  headers: { "content-type": "application/gzip" },
});

// Errors carry status, message and documentation_url.
try {
  await octokit.rest.repos.getContent({ ...R, path: "missing.txt" });
} catch (e) {
  console.log(e.status, e.response.data.message); // 404 Not Found
}
```

Things to know when you reuse GitHub code:

- Use [Personal access tokens](/docs/accounts/tokens) or agent tokens from Diffinery, not GitHub tokens or GitHub App credentials.
- Methods for features Diffinery doesn't have (see [Not supported yet](#not-supported-yet)) fail, usually with `404` or `422`.
- `octokit.paginate()` doesn't work on `listWorkflowRunsForWorkflow` or on package versions, which send no `Link` header; page those with `page`.
- Workflow run and job IDs are strings. TypeScript types say `number`; pass the value you got back unchanged.

### The Diffinery CLI

The `diffinery` CLI wraps the API with commands for common tasks (`diffinery pr list`, `diffinery issue create`, `diffinery run watch`) and has a raw `api` command for anything else:

```sh
curl -fsSL https://diffinery.com/install | bash
diffinery login                    # in a browser; scripts use --token dfy_... or DIFFINERY_TOKEN
```

`diffinery api METHOD PATH` sends an authenticated request and prints the JSON response. `PATH` is relative to `/api/v3`. `-f key=value` adds a string field to the JSON body (or to the query string for `GET`), and `--input FILE` (or `-` for stdin) sends a JSON body from a file. It exits with status 1 on any `4xx` or `5xx` response.

```sh
diffinery api GET /repos/acme/website/pulls -f state=open
diffinery api POST /repos/acme/website/issues -f title="Broken link on the pricing page"
echo '{"event":"APPROVE","body":"Ship it"}' | diffinery api POST /repos/acme/website/pulls/42/reviews --input -
```

The CLI reads `DIFFINERY_URL` and `DIFFINERY_TOKEN` from the environment before its config file, which is handy in CI. See the [CLI reference](/docs/reference/cli) for every command.

## Versioning

There is one version of the API, `v3`, named after the GitHub REST API version it follows. It is part of the path (`/api/v3`). Diffinery does not read GitHub's `X-GitHub-Api-Version` request header, so sending it is harmless; responses report `X-GitHub-Api-Version-Selected: 2022-11-28`. New endpoints and new response fields are added within `v3`; clients should ignore fields they don't know. The [API reference](/docs/api) and [/docs/api/openapi.json](/docs/api/openapi.json) are generated from the running code, so they always describe the version of Diffinery that serves them.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401 unrecognised token; create one under Settings → Access tokens` | The client sent a GitHub token or another credential. Use a `dfy_` token. |
| `404 repository not found` for a repository you expect | The token is restricted to other repositories, your role doesn't reach it, or (for an agent) its owner can't see it. |
| `404` from an Octokit method that works on GitHub | The endpoint isn't implemented (the body is `{"message": "Not Found", ...}`). Check the [API reference](/docs/api). |
| `401 authentication required` when opening an issue or commenting on a public repository | Anonymous callers can only read. Send a token. |
| `403 this token needs the write scope` | The token has only the `read` scope. Use a `write` token. |
| `403 this token needs the admin scope` or `403 this token is limited to repositories and can't change account settings` | Account-level endpoints (organizations, invitations, agents, organization secrets, revoking tokens) need an `admin` token without a repository list. See [Token scopes](#token-scopes). |
| `405 pull request is not mergeable: ... (as an admin you can bypass with bypass_rules)` | Meet the requirements, or, as an admin, send `"bypass_rules": true`. `bypass_merge_queue` alone doesn't skip rules. The bypass is audited. |
| `403 Resource not accessible by integration (...)` from a workflow | The job's `permissions:` don't grant what the endpoint needs. Add the permission the message names, for example `issues: write`. See [Workflow job tokens](#workflow-job-tokens). |
| `403 GitHub Actions is not permitted to create pull requests` (or `approve`) | An admin allows it with `PUT /repos/{owner}/{repo}/actions/permissions/workflow` and `{"can_approve_pull_request_reviews": true}`. |
| `refusing to allow a GitHub App to create or update workflow ...` | A workflow's token can't change workflow files. Push that change with a personal or agent token. |
| `410 Artifact has expired` | The artifact passed its retention. Upload it again with a longer `retention-days` (at most 90). |
| `403 repository is archived (read-only)` | Unarchive the repository first (admin): `PATCH /repos/{owner}/{repo}` with `{"archived": false}`. |
| `301` or `307` with `{"message": "Moved Permanently", "url": ...}` | The repository was transferred or renamed. Follow `Location` (`curl -L`, Octokit follows it), and update the owner and name your client uses. See [Transferred and renamed repositories](#transferred-and-renamed-repositories). |
| `409 <path> does not match <sha>` from the contents API | The file changed since you read it. Read it again and send the new `sha`. |
| `422 push protection: possible secret detected (...)` | The content looks like a credential. Remove it; see [Push protection](/docs/security/push-protection). |
| `413` or `429` from `zipball` or `tarball` | The repository is too big for an archive, or too many new archives were built this hour. Clone it with git. |
| `413 release assets are limited to 100 MB` | Split the file, or host it elsewhere and link to it from the release notes. |
| `search` returns `incomplete_results: true` | More than 50 repositories matched. Add `repo:` or `org:` to the query. |
| A list stops after one page | The client doesn't follow `Link`. Use `octokit.paginate()` or loop on `rel="next"`. |
| `429 too many repository imports are already running (at most 3 at a time); wait for one to finish` | You, or the account you import into, already run three repository imports (or one organization import: `an organization import is already in progress`). Wait, or cancel one with `POST /diffinery/imports/{id}/cancel`. |
| `422 github_api_url is required when a github_token is given and the source names a GitHub Enterprise host` | Send `github_api_url` (such as `https://ghe.example.com/api/v3`) on the same host as the source. Diffinery never sends a token to a host taken only from the source URL. |
