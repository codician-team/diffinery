---
title: Limits
description: Every hard limit in Diffinery and where it applies: quotas, egress, sign-in, tokens, API, search, archives, releases, git, Actions, sandboxes, agent tasks, agent review, packages, imports, email.
---

This page lists the fixed limits built into Diffinery: sizes, counts, timeouts and lifetimes. Use it when a push, a workflow, an upload or an API call fails with a size or count error, or when you plan something large. Values come from the code of the running version. Where a limit comes from Cloudflare rather than from Diffinery, the table says so.

Units: 1 KiB is 1,024 bytes, 1 MiB is 1,048,576 bytes, and 1 GB in the cache and artifact rows is 1,073,741,824 bytes. Sizes Diffinery checks itself and writes as "MB" (pushes, release assets, archives, profile pictures, forms) are in MiB: "100 MB" for pushes means 104,857,600 bytes.

## Sign-in and sessions

| Limit | Value | Applies to |
| --- | --- | --- |
| Browser session lifetime | 30 days, extended to 30 days from now on each day the session is used, never past 90 days after sign-in | The session cookie you get after signing in with a passkey, a sign-in link or email recovery. An unused session ends 30 days after its last extension, and every session ends 90 days after its sign-in. |
| Recent sign-in for sensitive actions | 2 hours | Adding or removing a passkey, creating a token, an agent or an agent token, changing your username, issuing a sign-in link, deleting, transferring or purging unreachable objects of a repository, and deleting an organization. An older browser sign-in gets **Confirm it's you** (`403` with a `confirm` URL over the API). See [Confirming it's you](/docs/security/overview#confirming-its-you). |
| Passkey browser prompt | 2 minutes | Time to complete the browser's passkey dialog when signing in or adding a passkey. |
| Passkey sign-in attempt | 5 minutes | A sign-in or registration that started more than 5 minutes ago can't be completed; start again. |
| Sign-in link lifetime | 24 hours, single use | Links a site administrator sends with **Sign-in link** in **Settings → People and invitations**. |
| Invitation lifetime | 14 days | Invitations to the site, an organization or a repository. |
| Sign-up code | 10 minutes, single use, 5 tries | With open sign-up (`SIGNUP=open`): the 6-digit code emailed from `/signup`. After 5 codes entered for it, right or wrong, it stops working (`That code has expired or was entered wrong too many times`). Sending a new code ends the old one. |
| Sign-up codes per address | 5 in 24 hours | Codes asked for one email address, counting the note sent instead when the address already has an account. The next one gets `429 We have sent several codes to <address> today`. |
| Sign-up codes per IP address | 20 in 24 hours | Codes asked for from one IP address. The next one gets `429 Too many sign-ups from your network today`. |
| Sign-up passkey step | 30 minutes, single use | After the code is accepted, the page for picking a username and creating a passkey. Start again at `/signup` once it runs out. |
| Email recovery session at Cloudflare Access | 15 minutes | The Cloudflare Access application that guards `/auth/access` (set by `scripts/bootstrap.sh`). It only covers the email check; the Diffinery session that follows lasts 30 days. |
| Username when joining from an invite or signing up | 39 characters | Letters, digits, `-` and `_`. Some names are reserved (for example `api`, `settings`, `login`, `admin`, `docs`). |
| Display name when joining | 100 characters | Longer names are cut off. |
| Passkey name | 100 characters | Longer names are cut off. |
| Repository, organization and agent names | 1 to 100 characters | Start with a letter or digit; then letters, digits, `.`, `_` and `-`. Repository names can't end in `.git`. Organization and agent names can't contain `.` and can't be a reserved name. |
| Early access requests | 10 per IP address, 3 emails per address and 500 emails in total, in 24 hours | The [early access](/docs/accounts/early-access) form and its removal form together. The 11th from one network answers `Too many requests from your network today`; past the other two the page looks the same and no email is sent. |
| Early access links | 48 hours to confirm, 24 hours to remove, single use | Only the newest link sent to an address works. Unconfirmed requests are deleted 7 days after they were last sent. |
| Early access fields | name 100, company or team 120, use 1,000 characters | Longer is refused, not cut. |
| Note on an access request | 500 characters | The note someone without an invite sends to site administrators. Up to 20 site administrators are emailed about each request. |

## Tokens

| Limit | Value | Applies to |
| --- | --- | --- |
| Token lifetime | 1 to 366 days, default 90 | Personal access tokens and agent tokens. Values outside the range are clamped. |
| An agent's first token | 90 days, `write` scope | The token created together with an agent, unless you pass `token.expires_in_days` or `token.scopes`. |
| Expiry reminder email | 7 days before expiry | Sent once per token, and only for tokens that were valid for more than 8 days. |
| "Last used" accuracy | 1 hour | A token's last-used time is updated at most once an hour. |
| Creating tokens through the API | A browser session | No token can create a token or an agent: `POST /api/v3/diffinery/tokens` and the agent endpoints return `403 creating tokens needs a browser session: sign in at https://diffinery.com/settings/tokens` for every token. Each name in `repositories` must be a repository you can see, or the request fails with `422 unknown repository acme/website`. |
| Sandbox token lifetime | 24 hours | A sandbox's git and API credentials stop working 24 hours after it starts, or earlier when it is closed or its creator loses access. |
| Token scopes | `read`, `write` or `admin`; default `["write"]` | A new token (personal or agent) without `scopes` gets `write`. An empty list or any other name returns `422 scopes must be a non-empty list of: read, write, admin`. Repeated names are stored once. |
| Writes with a `read` token | Refused | Every change returns `403 this token needs the write scope`. Git fetch and Git LFS downloads still work. |
| Account-level actions | `write` to create repositories, mark notifications read, change notification settings and send a test email; `admin` for creating organizations, invitations, organization secrets, agents and revoking tokens | A token restricted to some repositories can't do any of these (`403 this token is limited to repositories and can't change account settings`). |

## REST API

| Limit | Value | Applies to |
| --- | --- | --- |
| Rate limits | Per minute: 20 sign-in attempts and 300 other requests per IP address without signing in; 2,000 requests and 60 new repositories, organizations, forks, issues, pull requests, releases, comments or reviews per account | Past a limit, `429` with `retry-after: 60`. Jobs, sandboxes, runners and imports aren't counted. See [Rate limits](/docs/reference/rest-api#rate-limits). |
| Request body size | 100 MB | Cloudflare refuses larger request bodies before they reach Diffinery. |
| Items per page | 30 by default, 100 at most | Every paginated list (`per_page`). Larger values are treated as 100. `page` can go up to 100,000. |
| Workflow runs per page | 25 by default, 100 at most | `GET /repos/{owner}/{repo}/actions/runs`. |
| Commits in a comparison or pull request | 250 in total, 100 per page | `GET /repos/{owner}/{repo}/compare/{base}...{head}` and `GET .../pulls/{n}/commits`. |
| Refs per page | 100 by default | `GET .../git/refs` and `.../git/matching-refs/{ref}`. |
| Environment variables per page | 10 by default, 100 at most | `GET .../environments/{env}/variables`. |
| Commits listed by paging | The first 10,000 commits from where the listing starts | `GET /repos/{owner}/{repo}/commits` answers `422 In order to keep the API fast for everyone, pagination is limited for this resource.` past that, as GitHub does, and the web commit list stops there too. To go further back, start a new listing at an older commit with `sha=`. |
| Commits searched for a path | The latest 2,000 commits | `GET /repos/{owner}/{repo}/commits?path=...` and the history of a file in the web UI only look at the 2,000 most recent commits. |
| Package versions per page | 30 by default, 100 at most | `GET .../packages/container/{name}/versions`. |
| Repository lists | 500 repositories | `GET /user/repos`, `/users/{login}/repos`, `/orgs/{org}/repos` page over at most 500 repositories (most recently pushed first). |
| Notifications | 100 | `GET /api/v3/notifications` returns your 100 most recent (unread unless `all=true`). Notifications older than 180 days are deleted. |
| Email log | 50 by default, 500 at most | `GET /api/v3/diffinery/emails?per_page=`. |
| Job log lines per call while a job runs | 5,000 | `GET /repos/{owner}/{repo}/actions/jobs/{id}/logs`. Pass `after=<seq>` with `format=json` to read the next lines. A finished job's log comes back whole. |
| Recursive tree listing | 100,000 entries | `GET .../git/trees/{sha}?recursive=1` stops there and returns `truncated: true`. |
| Entries changed by one tree request | 10,000 | `POST .../git/trees` (`a tree request can change at most 10000 entries`). |
| File and directory names | 255 characters per name, 4,096 per path | Every API write (contents, git trees, multi-file commits). Names `.`, `..`, `.git` (in any case, and spellings such as `.git.` or `git~1`) and names with `\` or NUL are refused. |
| Topics | 20 per repository, 50 characters each | `PUT .../topics`. Lowercase letters, digits and hyphens, starting with a letter or digit. |
| Labels | Names up to 100 characters; 100 labels per issue | The REST API. The web UI's label form allows names up to 50 characters. |
| Assignees | 10 per issue or pull request | `an issue can have at most 10 assignees`. |
| Issue and pull request text | Titles up to 256 characters; bodies, comments and review text up to 65,536 characters | As on GitHub, everywhere they're written (web, REST, MCP). Longer text fails with `422 body is too long (maximum is 65536 characters)`. |
| MCP batch | 20 requests | One `POST /mcp` with a JSON-RPC batch of more than 20 requests answers `400` with `at most 20 requests in one batch`. |
| `repository_dispatch` | `event_type` up to 100 characters; `client_payload` up to 10 top-level properties and 64 KiB | `POST .../dispatches`. |
| Check run name | 255 characters | `POST .../check-runs`. |
| Deployment `required_contexts` | 100 contexts | `POST .../deployments`. |
| Environment name | 1 to 255 characters | No `/`, `\` or control characters. |
| Required reviewers | 6 people per environment | `PUT .../environments/{env}`: `422 an environment can have at most 6 required reviewers`. See [Required reviewers and wait timers](/docs/actions/environments#required-reviewers-and-wait-timers). |
| Wait timer | 0 to 43,200 minutes (30 days) | `wait_timer` on `PUT .../environments/{env}`. |
| Waiting for a reviewer | 30 days | A job still waiting for its environment's reviewers after 30 days fails. |
| Deployment review comment | 4,000 characters | `POST .../actions/runs/{run_id}/pending_deployments`: `422 comment is longer than 4000 characters`. |

## Search

| Limit | Value | Applies to |
| --- | --- | --- |
| Query length | 256 characters | `q` of `GET /search/issues` and `/search/repositories`. Longer queries fail with `422 The search is longer than 256 characters.` |
| Results you can page to | 1,000 | Asking for a page past the first 1,000 results fails with `422 Only the first 1000 search results are available`. |
| Repositories an issue search covers | 50 | The first 50 repositories you can read, out of the up to 500 most recently pushed repositories visible to you. More sets `incomplete_results: true`; add `repo:` or `org:` to narrow it. |
| Repositories a repository search checks | 300 | Candidates checked for access, out of the same up to 500. More sets `incomplete_results: true`. |
| Issues scanned per repository | 5,000 | The most recent issues and pull requests in each repository. |
| Comments read for `in:comments` | 2,000 per repository | The most recent comments. |
| Issue search box in the web UI | 200 characters | The search query on the issues and pull requests pages. |

## Source archives

| Limit | Value | Applies to |
| --- | --- | --- |
| File content per archive | 24 MB | `zipball`, `tarball` and `/<owner>/<repo>/archive/<ref>.zip` or `.tar.gz`. Larger repositories fail with `413 repository is too large for an on-the-fly archive; clone it with git instead`. |
| Tree entries per archive | 100,000 | Every entry visited counts, including repeated subtrees. More fails with `413 the tree has more than 100,000 entries; clone it with git instead`. |
| Directory depth | 128 levels | Deeper trees fail with `413 the tree is nested too deeply`. |
| Files in a zip | 65,535 | More fails with `413`; download the `.tar.gz` archive instead. |
| New archives per repository | 20 per hour | Archives already built and cached don't count. Past the limit: `429 too many archives were built for this repository in the last hour; try again later or clone it with git`. |
| Cache | Not guaranteed | A built archive is cached in R2 and can be evicted at any time; it is then built again. |

## Releases

| Limit | Value | Applies to |
| --- | --- | --- |
| Asset size | 100 MB | Each asset uploaded to a release's `upload_url`, the largest request body Cloudflare Workers accept (`413 release assets are limited to 100 MB`). |
| Asset size through MCP | 25 MB | The `upload_release_asset` tool (`MCP uploads are limited to 25 MB; use the upload_url of the REST API for larger files`). |
| Files per web form submission | 100 MB in total | The release form in the web UI. Upload larger files with the REST API. |
| Asset name | 1 to 255 characters | After unusual characters are replaced with `.`. Each name once per release. |
| Release notes | 125,000 characters | `body` of a release. |
| Releases listed through MCP | 100 | `list_releases` (`limit`, default 30). |

## Commit statuses and checks

| Limit | Value | Applies to |
| --- | --- | --- |
| Statuses per commit and context | 1,000 | `422 this SHA and context has reached the maximum number of statuses`. |
| Status context | 255 characters | Longer contexts are cut. Without `context`, it is `default`. |
| Status description | 1,024 characters | Longer descriptions are cut. |

## Profile pictures

| Limit | Value | Applies to |
| --- | --- | --- |
| Upload size | 5 MB | Pictures for people and organizations, in the web UI and through `PUT /api/v3/user/avatar` or `/orgs/{org}/avatar` (`That picture is larger than 5 MB. Use a smaller file.`). |
| Image size | 3072×3072 pixels | Larger images are refused. |
| Formats | JPEG, PNG and WebP | Other files fail with `Use a JPEG, PNG or WebP image.` |
| Stored sizes | 64, 128 and 256 pixels square | The picture is cropped to a square and stored as WebP. `GET /api/avatars/{login}?s=` serves the smallest stored size at least as large as asked. |

## Git

| Limit | Value | Applies to |
| --- | --- | --- |
| Push size | 100 MB per push | The whole push request after decompression. A larger push is rejected with `push exceeds 100 MB; split it into smaller pushes`. Push in several steps (for example a range of commits at a time). |
| Pushes to one repository at once | Large ones unpack one at a time | Small pushes (up to 1 MiB) unpack side by side. A larger push needs the repository's full memory share to unpack, so large pushes to the same repository take turns, oldest first; one that waits keeps its connection open and goes through once the push before it is done. Pushes to different repositories don't wait for each other. |
| Fetch request size | 16 MB | The request a client sends to fetch or clone (its wants and haves), after decompression. A larger one is refused with `413 fetch request exceeds 16 MB`. |
| File size in a push | Up to the push size | A single file (blob) can be as large as fits in one push (GitHub allows files up to 100 MB). Files of 4 MiB or more are checked and stored from their compressed bytes, so they never need to fit in memory inflated. |
| Unpacked size of a push | 512 MiB | What a push's pack inflates to, deltas resolved. A pack that unpacks to more is refused with `pack unpacks to more than 512 MiB; split it into smaller pushes`, however small it is on the wire: a long history of one large file can, since each version counts whole. |
| Tree size in a push | 8 MiB | One directory's listing (a tree object). A larger one is refused with `fsck error: tree <id>: larger than 8 MiB`. 100,000 files in one directory come to about 4 MiB. |
| Commit or tag size in a push | 4 MiB | A commit or annotated tag object, message and signature included. A larger one is refused with `fsck error: commit <id>: larger than 4 MiB` (or `tag`). |
| Objects in a push unpacked in pieces | 1,000,000 | A push over 16 MB is unpacked from storage in pieces, and so is a smaller one whose objects don't all fit in memory at once (a long history, such as flask's or tornado's). Inflating its objects again to check and store them may take at most four times the unpacked size limit, and reading it from storage at most 500 requests, counting bases read from the repository and each object stored on its own (jQuery's 37 MB history takes about 50). Past any of these, it is refused with a message that ends `split it into smaller pushes`. Its deltas count toward the storage quota at their full size. |
| Memory to unpack a push | 80 MiB | What unpacking a push holds at once. Up to 16 MB: its files under 4 MiB inflated, and about 768 bytes for each object. Unpacked in pieces: 24 MiB of caches and scratch, up to 16 MiB of deltas kept to rebuild them, each object while it is in use (a file, a delta's base and its result, a base read from the repository), about 128 bytes for each object, and 640 more for each delta named by its base's id rather than its place in the pack (git sends those only for bases the repository already has). Two versions of a file over about 25 MB, which git stores as a delta, need more; a long history of one file holds two versions at a time. A base from the repository is checked before it is read. A push that needs more is refused with `pack needs more than 80 MiB of memory to unpack; split it into smaller pushes`. Deltas are resolved in one pass, however the pack orders them. |
| Git protocol | Version 2 for fetch and clone | Clients older than git 2.26 must run `git config --global protocol.version 2`, or the server answers `Diffinery requires Git protocol v2`. |
| Secret scanning coverage | Every new text file | Push protection scans every new text file in a push, whatever its size. The rejection message lists up to 10 findings. |
| Linear history check | 1,000 new commits | A protected branch with "require linear history" checks up to 1,000 new commits in a push for merge commits. |

## Git LFS

| Limit | Value | Applies to |
| --- | --- | --- |
| Objects per batch request | 1,000 | Objects beyond the first 1,000 in one LFS batch request are ignored; the git-lfs client batches in smaller groups by default. |
| Upload and download links | 1 hour | The `expires_in` of the transfer links the batch API returns. |
| Object size | 100 MB | Each object is uploaded in one request, and Cloudflare refuses request bodies over 100 MB. |

## Pull requests, diffs and the web UI

| Limit | Value | Applies to |
| --- | --- | --- |
| Files in a diff | 300 | Commit, compare and pull request diffs (web UI, REST and MCP) include the first 300 changed files and mark the diff as truncated. |
| Size of one file's diff | 1 MiB (old and new version together) | Larger files show no line diff ("This diff is too large to display."). |
| Content diffed per request | 16 MiB | One commit, comparison or pull request diffs at most 16 MiB of file content; later files are listed without a line diff. |
| Changed lines diffed exactly | 1,000 per file, about 2,000 per request | A file with more changed lines, or one diffed after the request's budget is spent, is shown as one block: the lines both versions share at the start and end stay as context, and everything between is removed and added. The line counts stay right; the diff is just not minimal. |
| Automatic line merges | 2,000 changed lines per side | Merging a pull request, a file both sides changed by more than this is a conflict to resolve yourself. |
| Commits listed in a comparison or pull request | 250 | `GET /repos/{owner}/{repo}/compare/{base}...{head}`, `GET .../pulls/{n}/commits` and the matching web pages. |
| Viewing or editing a file in the browser | 1 MiB | Larger files show "This file is too large to display" with a **View raw** link, and can't be edited in the browser. READMEs over 1 MiB are not rendered. |
| Markdown source | 512 KiB | Longer Markdown (READMEs, issue and pull request bodies, comments) is shown as plain preformatted text. |
| Markdown nesting | 12 levels | Deeper nested lists and quotes are shown as plain text. |
| Markdown inline run | 60,000 characters | A longer paragraph is shown without inline formatting. |
| Web list pages | Page 1,000 | Paginated lists in the web UI stop at page 1,000. |
| Syntax highlighting | 2,000 lines and 200,000 characters per file | Larger files are shown without highlighting. Lines over 2,000 characters are not highlighted. |
| Web form size | 10 MB | Forms in the web UI, except the release form (100 MB of files) and profile pictures (5 MB). |
| Required approvals | 0 to 10 | The **Required approvals** setting of a branch protection rule in the repository settings page. |
| Assignees per edit | 10 | Assigning people from the issue or pull request sidebar. |
| Label name and description | 50 and 100 characters | Labels created in the web UI. |
| Merge queue build concurrency | 1 to 20, default 5 | How many merge groups a queue builds and tests at the same time (`mergeQueue.buildConcurrency`). |
| Merge queue check timeout | 1 to 360 minutes, default 60 | How long a merge group's required checks may take before the pull request leaves the queue (`mergeQueue.checkTimeoutMinutes`). |

## Account quotas

Quotas are per account, and the account they count against is the one that owns the repository (a person or an organization), whoever started the work. A site administrator can change any of them for one account (`PATCH /api/v3/admin/accounts/{login}/quotas`), and an operator can change the defaults with the `QUOTA_*` variables in [Configuration](/docs/self-hosting/configuration). Accounts run by a site administrator have no quotas: their own account, and organizations with a site administrator as an owner. See what an account uses with `GET /api/v3/user/usage` or `GET /api/v3/orgs/{org}/usage` (owners and admins).

| Quota | Default | What happens past it |
| --- | --- | --- |
| Hosted minutes per month | 3,000 | Hosted Actions jobs and agent sandboxes (including agent tasks, reviews and terminals) add up their running time, rounded up to the minute, per calendar month in UTC. Once it is used up, a hosted job fails without starting ("The job was not started: this account has used its 3000 hosted minutes for this month ..."), and a new sandbox is refused with `429`. Self-hosted runners don't count. |
| Hosted jobs at once | 20 | Across all the account's repositories, like GitHub's per-account limit (20 on its Free plan). Further jobs wait as queued and start, oldest first, as running ones finish (checked at least once a minute). A job that waits 6 hours fails with "The job waited 6 hours for a hosted runner (one of this account's hosted jobs to finish, or a free runner), and was not started." Accounts run by a site administrator have no quota but are still held to half the fleet (see [Actions](#actions)). |
| Agent sandboxes open at once | 5 | Across all the account's repositories, including agent tasks', reviews' and terminals' sandboxes. A new one is refused with `429 this account already has 5 agent sandboxes open; close one or wait for one to finish`. |
| Repositories | 500 | Creating, importing or transferring in a repository past it is refused with `403 <account> has reached its limit of 500 repositories; delete one or ask a site administrator to raise it`. |
| Storage | 10 GB (10,737,418,240 bytes) | What the account's repositories store (git objects as stored, compressed; Git LFS objects; release assets) and its container images' blobs and manifests (a blob several of its images use counts once). Actions artifacts and caches don't count: they have their own limits per repository (see [Caches and artifacts](#caches-and-artifacts)) and expire. A write that would take the account past it is refused with `<account> has reached its storage limit of 10737418240 bytes (git objects, Git LFS objects, release assets and packages); delete some or ask a site administrator to raise it`: a push that brings new objects (git shows `remote: Push refused: ...` and rejects every ref with `storage limit reached`), Git LFS uploads (each object gets error `507` in the batch response), release asset uploads, files and blobs written through the API, the web editor or MCP (`403`), container image uploads (`403 DENIED`), and starting a GitHub import (`403`); an import that reaches it on the way stops with the same message. Reads, merges, deletes and pushes that only delete or move refs keep working. A deleted branch's objects stay stored until you [purge unreachable objects](/docs/security/push-protection#removing-a-secret-that-was-pushed); deleting releases, assets, image versions or the repository frees their bytes. Repositories made before this quota existed are measured the first time their account's storage is checked. |

## Egress

| Limit | Value | Applies to |
| --- | --- | --- |
| Network access of hosted compute | The whole internet by default; HTTP and HTTPS (ports 80 and 443) and DNS with `EGRESS=web` | Hosted Actions jobs and agent sandboxes, including tasks, reviews and terminals. Under `web` a connection to any other port fails: SSH (`git@...` remotes), SMTP (25, 465, 587), IRC and the like. The account that owns the repository decides, and accounts run by a site administrator stay open. Self-hosted runners aren't limited. See [EGRESS](/docs/self-hosting/configuration#egress). |
| HTTPS under `EGRESS=web` | Intercepted, re-signed with a Cloudflare CA | The runner agent makes the system store, Node.js and Python's `requests` trust the CA. Tools with their own CA list, certificate pinning, client certificates and HTTPS from Docker containers a job starts fail their certificate checks. |

## Actions

| Limit | Value | Applies to |
| --- | --- | --- |
| Job timeout | 360 minutes (6 hours), default and maximum | `jobs.<id>.timeout-minutes`. Higher values are lowered to 360. A job that runs out of time ends with conclusion `timed_out` and the message "The job exceeded its timeout of N minutes." |
| Step timeout | No maximum beyond the job's | `steps[*].timeout-minutes`. |
| Waiting for a concurrency group | 6 hours | A run whose `concurrency` group is busy (without `cancel-in-progress`) checks once a minute for up to 6 hours. |
| Jobs in one matrix | 256 | More combinations fail the job with "A matrix may produce at most 256 jobs." |
| Matrix combinations before `exclude` | 4,096 | The product of the matrix's vectors. A larger matrix is refused without being expanded: "the matrix has <n> combinations before exclusions; at most 4096 are allowed (and a matrix may produce at most 256 jobs)". |
| Matrix `include` and `exclude` entries | 256 each | "matrix.include has <n> entries; at most 256 are allowed". |
| Workflow files read per commit | 256 | Of `.github/workflows` and `.diffinery/workflows` together, in name order; later files are ignored. |
| Workflow file size | 512 KiB | A larger file is listed as invalid ("the workflow file is larger than 512 KiB") and never runs. |
| Reusable workflow nesting | 4 levels | "reusable workflows can be nested at most 4 levels deep" |
| Reusable workflows per run | 20 calls | "a run can call at most 20 reusable workflows" |
| `workflow_run` chains | 3 levels | A run started by `workflow_run` that is itself three links down a chain triggers nothing (A starts B starts C starts D; D's runs start nothing). |
| Schedule granularity | 5 minutes | Scheduled workflows are checked every 5 minutes. A cron that fires more often still runs at most once per 5-minute window. Only workflows on the default branch of repositories that aren't archived are scheduled. |
| Schedule catch-up | 60 minutes | A check that comes late, or fails, is caught up by the next one, up to an hour back. Each schedule starts once per check, however many of its minutes the check covers. |
| Running job whose runner stops responding | Ended 10 minutes after its `timeout-minutes` | Counted from when its runner fetched the job. The runner ends a job at its timeout itself; Diffinery only steps in when it hasn't reported by then, stops its container and fails it as timed out. |
| Run whose jobs have all finished but that hasn't finished | Repaired 5 minutes after its last job, finished by 30 minutes | Diffinery signals the run's orchestration again after 5 minutes, and finishes the run itself after 30 (or after 5, when the orchestration has stopped), so it no longer holds its concurrency group. Jobs it never started fail the run and are named in a `Set up workflow` job. |
| Hosted runner sizes | large: `standard-4` (4 vCPU, 12 GiB of memory, 20 GB of disk); medium: `standard-3` (2 vCPU, 8 GiB, 16 GB); small: `standard-1` (1/2 vCPU, 4 GiB, 8 GB); tiny: `basic` (1/4 vCPU, 1 GiB, 4 GB) | Each hosted job runs in its own container. A job runs on large unless `runs-on` names a size or its earlier runs show a smaller one fits with headroom ([Runner sizes](/docs/actions/runners#runner-sizes)). |
| Hosted job containers at once | 100 per size | `max_instances` of each runner container class. |
| Hosted jobs at once on the instance | 80 | `HOSTED_JOBS_LIMIT`, kept under the container classes' `max_instances` with room for jobs starting side by side. Past it, every account's next hosted job waits as queued, as for its own quota, until one finishes. Self-hosted jobs don't count. |
| Hosted jobs at once per account | Half the instance's, 40 | Whatever the account's quota says, so no account can keep the others' jobs from starting. A repository can use all of its account's share. Further jobs stay queued and start, oldest first, as running ones finish. |
| No free container | Wait, then retry, 8 times | When the platform has no container free for a job (many jobs starting at once, or just after a deploy), the start fails on the platform's side in a way that passes ("Container sidecar is shutting down", a dropped connection, the platform's own `internal error; reference = ...`, a new container object out of memory, a container that didn't come up in time), or the job's container stops before its runner fetched the job, the job goes back to queued and starts again after 30 seconds, then 1, 2, 4 and 5 minutes. The first time a job's container stops before its runner fetched the job (the platform stops a share of the containers a burst starts), or its start fails with an internal error or a dropped connection, it starts again after 5 seconds instead, and that try isn't counted. After 8 tries, about half an hour, it fails with `No hosted runner could be started`. Only jobs whose runner never fetched the job are retried: a runner that fetches it after its start was given up on is turned away, so no step runs twice. Other start errors fail the job at once with `Could not start a runner`. |
| Runner on the previous image during a deploy | Retried every 20 s, up to 30 times | While a deploy rolls out a new runner image, a runner that comes up on the previous image is turned away before it runs anything and the job starts again 20 s later. These waits don't count toward the 8 above. After 30 (about 10 minutes, longer than a rollout takes) the job runs on whichever image it gets. |
| Unfinished runs per repository | 500 | Past it, a `workflow_dispatch` or `repository_dispatch` is refused with `429 this repository has 500 unfinished workflow runs, the most allowed; wait for some to finish`, and other events start no run. |
| Self-hosted runners per repository | 100, each with at most 20 labels | Registering one more gets `429 this repository has 100 self-hosted runners, the most allowed; remove one first`. A registration token works for an hour. |
| Purging unreachable objects | Repositories of up to 300,000 objects | A larger repository gets `422`; ask a site administrator. See [Removing a secret that was pushed](/docs/security/push-protection#removing-a-secret-that-was-pushed). |
| Jobs during a deploy | Not interrupted | A deploy doesn't replace the container of a running hosted job: it finishes on the version it started with. If the platform replaces a job's container anyway, the job keeps going for up to 13 minutes, then is cancelled. |
| Service container health check | 15 minutes | How long a job waits for a `services:` container's health check to pass. |
| Log line length | 16,384 characters | Longer lines are cut and end with `…`. |
| Log size per job | 16 MiB of text | The log ends with "The log is cut off here: a job's log is limited to 16 MiB of text." and later lines are dropped; the job keeps running. |
| Log shown in the web UI | 20,000 lines | The job page shows the first 20,000 lines and links to the full log. |
| Job log retention | 90 days | A finished job's log is stored for 90 days, then deleted. The run and its jobs stay listed. |
| OIDC token lifetime | 10 minutes | ID tokens from `permissions: id-token: write`. |

## Caches and artifacts

These apply to `actions/cache` and `actions/upload-artifact` (and the matching built-ins) in hosted and self-hosted jobs. See [Artifacts and caches](/docs/reference/rest-api#actions) in the REST API reference for listing and deleting them.

| Limit | Value | Applies to |
| --- | --- | --- |
| Cache storage per repository | 10 GB | Every cache entry of the repository together, on all branches. When saving a cache would go over 10 GB, the least recently used entries are deleted until it fits. |
| Unused caches | Deleted after 7 days | An entry that no job restored for 7 days is deleted the next time a job saves a cache in the repository. |
| Cache entry size | 10 GB | A larger entry fails with `413 a cache entry may be at most 10737418240 bytes`. If caches still being uploaded by other jobs fill the budget, saving fails with `413 uploads in progress use the repository's whole cache budget`. |
| Cache key | 512 characters, no commas | Longer keys or keys with `,` fail with `400 invalid cache key`. Up to 20 restore keys per lookup. |
| Saving an existing cache key | Skipped | A key and version that already exist for the branch are not replaced; the save is skipped with a warning. |
| Which caches a job can restore | Its own branch, then the base branch, then the default branch | A pull request job also restores caches of its base branch, a merge queue job those of the target branch. |
| Artifact storage per repository | 10 GB by default | Artifacts that haven't expired plus uploads in progress. Past the quota, an upload fails with `413 the repository's artifact storage quota (N bytes) is used up; delete artifacts or wait for them to expire`. Operators change it with `ARTIFACT_QUOTA_BYTES` (see [Configuration](/docs/self-hosting/configuration#worker-variables)). |
| Artifact retention | 1 to 90 days, default 90 | `retention-days`. Values outside the range are clamped. |
| Expired artifacts | Listed for 90 more days | After its retention the content is deleted. The artifact stays in the API with `expired: true`, and downloading it returns `410 Artifact has expired`. |
| Artifact name | 256 characters, unique per run | Names can't contain `"`, `:`, `<`, `>`, `|`, `*`, `?`, `\`, `/` or line breaks. A second artifact with the same name in a run fails with `409 an artifact with this name already exists on the workflow run`. |
| Upload request size | 256 MiB, and Cloudflare's 100 MB request limit | `actions/cache` and `actions/upload-artifact` upload in blocks, so cache entries and artifacts can be larger than one request. On plans where Cloudflare refuses request bodies over 100 MB, that is the effective block size. |
| Blocks per upload | 50,000 | More fails with `Too many blocks.` |
| Download links | 1 hour, or 10 minutes from the REST API | The signed links a job gets to restore a cache or download an artifact, and the redirect from `GET .../actions/artifacts/{id}/zip`. |
| Runtime token | While the job runs | `ACTIONS_RUNTIME_TOKEN` works only while its job is in progress, and at most until 30 minutes after the job's timeout. |

## Agent sandboxes

| Limit | Value | Applies to |
| --- | --- | --- |
| Sandbox size | Cloudflare Containers `standard-1` | Each sandbox runs in its own container of this instance type. |
| Sandboxes at once | 50 | `max_instances` of the sandbox container class, across the whole instance. |
| Open sandboxes per account and repository | 5 | A sixth is refused with `429 you have 5 open sandboxes in this repository, the most allowed; close one first`. A sandbox counts until it is closed or its credentials expire after 24 hours. Agent task sandboxes don't count. |
| Start-up wait | Up to 3 minutes | Creating a sandbox waits up to 3 minutes for its container (longer than usual right after a deploy, while the host pulls the image). If it doesn't start, creation fails with `503 the sandbox container did not start; try again`. |
| Idle time | 30 minutes | A sandbox that receives no requests for 30 minutes is stopped. |
| Command timeout | 10 minutes by default | `exec` in the REST API (`timeoutMs`) and `sandbox_exec` in MCP (`timeout_seconds`) can set another value. A command that times out returns exit code `124` and `timedOut: true`. |
| Command output | 1 MiB each for stdout and stderr | Longer output is cut and the response has `truncated: true`. |
| Request body | 64 MiB | Larger `exec`, `read` or `write` requests fail with `413 request body too large`. |
| File read | 64 MiB | Reading a larger file fails with `413 file too large`. |

## Agent tasks

| Limit | Value | Details |
| --- | --- | --- |
| Run length | 6 hours | A run still going after 6 hours is stopped and fails with `The run took longer than 6 hours and was stopped.` |
| Installing the runtime | 10 minutes | Installing Claude Code or Codex in the sandbox. |
| Goal and follow-up length | 20,000 characters | ``422 `goal` is longer than 20000 characters`` (or `body` for a follow-up). |
| Plan length | 20,000 characters | A [plan-first](/docs/agents/tasks#plan-first) run's plan is cut there and ends with `… (plan cut at 20000 characters)`. |
| Fix runs for failing checks | 1 per commit, 3 per task | With **Fix failing checks**, a fix run gets the last 80 log lines of each failing check. After 3, the task's conversation says the checks still fail. See [Verify and land](/docs/agents/tasks#verify-and-land). |
| Attempts per task | 1 to 4 | ``422 `attempts` must be a whole number from 1 to 4``. Each attempt counts toward how many tasks run at once. A task on a pull request's branch runs one. See [Best of N](/docs/agents/tasks#best-of-n). |
| Custom command length | 2,000 characters | ``422 `command` is longer than 2000 characters``. |
| Transcript | 20,000 lines per run, 32 KiB per line | Later output lines of a run aren't stored (Diffinery's own notes still are); a longer line is cut. |
| Transcript lines per MCP call | 500 | `agent_task` returns at most 500 lines after `after`. |
| Tasks running at once per repository | 1 to 10, default 3 | Set under **Settings → Project**. Further tasks, follow-ups and retries queue and start oldest first. Agent reviews don't count. See [Projects](/docs/agents/projects#how-many-at-once). |
| Project memory | 40,000 characters, last 50 versions kept | ``422 memory is longer than 40000 characters``. |
| Project instructions | 10,000 characters | ``422 `instructions` is longer than 10000 characters``. |
| Coordinator | 5 tasks per post, 20 per person and project per 24 hours | A coordinator run lasts at most 30 minutes and 200 model requests, within its token budget (1M by default); each run of a task it starts has its own budget (2M by default). Both budgets are 100,000 to 50,000,000 tokens. See [Coordinator](/docs/agents/projects#coordinator). |
| Project conversation post | 20,000 characters | ``422 `body` is longer than 20000 characters``. The conversation API and `project_posts` return at most 100 posts per call. |
| Model requests per person | 600 a minute, across all the runs you pay for | The model proxy answers `429` with `retry-after: 60`; the run goes on, and Claude Code and Codex retry. Counted in each Cloudflare location, like the [rate limits](/docs/reference/rest-api#rate-limits), so it isn't a global total. |
| Usage report | 1 to 90 days, 200 lines | `GET /diffinery/model-usage` and **Settings → Model access**. See [Usage and cost](/docs/agents/tasks#usage-and-cost). |
| An organization's tasks at once per repository | 1 to 10, default 10 | Set in its [agent policy](/docs/agents/organizations#other-policies); each project's own setting is held to it. |
| Tokens per person on an organization's keys | 10,000 to 10 billion a calendar month (UTC), no limit by default | The model proxy refuses a request that could go over with `403`, and the task stops. See [Monthly allowance per person](/docs/agents/organizations#monthly-allowance-per-person). |
| Model requests at once | 4 per review or budgeted run, and 4 per person on an organization's keys while it sets an allowance | The model proxy answers `429` with `retry-after: 5`, and the CLI tries again. A request still streaming after 15 minutes stops counting. |
| An organization's usage report | 1 to 90 days, 500 lines | `GET /orgs/{org}/diffinery/model-usage` and the organization's **Settings** tab. |

See [Agent tasks](/docs/agents/tasks). For the Today view's limits (repositories active in the last 30 days, at most 100 of them, 50 open pull requests each), see [Today](/docs/agents/today).

## Agent review

| Limit | Value | Details |
| --- | --- | --- |
| Review length | 30 minutes | The review stops and its **Agent review** check fails with "The review didn't finish". |
| Model requests per review | 200 | The model proxy answers `429` to the next request and stops the review; its check fails. |
| Tokens per review | 2,000,000 by default, settable from 100,000 to 50,000,000 (`tokens_per_review`) | Counted by the model proxy from the provider's usage (cache reads as a tenth). A request whose booked estimate could pass the budget is refused, and the review stops. |
| Automatic reviews per pull request | 10 in 24 hours | Later pushes get an action-required check; people with write access can still ask. |
| Reviews per pull request | 20 in 24 hours, asked for or automatic | The check asks for action, and asking returns `429`. |
| Reviews per repository | 50 reviews and autofix runs in 24 hours by default, settable from 1 to 1000 (`daily_limit`) | The check asks for action, asking returns `429`, autofix waits, and the admin whose key reviews use gets a `review_limit_reached` email at most once a day. |
| Inline findings per review | 25 | Findings outside the changed lines go in the review's summary. |
| Changed files in the prompt | 300 | The rest are summed up as `… and N more`. |
| Review rules in the prompt | 48 KiB | Of the base branch's `REVIEW.md` and `.cursor/BUGBOT.md` files. |
| Autofix tasks per pull request | 3 | Only for pull requests whose author has write access. Autofix runs count toward the repository's daily limit. |

See [Agent review](/docs/agents/review).

## Container registry

| Limit | Value | Applies to |
| --- | --- | --- |
| Request body | 100 MB | Cloudflare refuses larger requests. `docker push` from a hosted workflow splits large layers into chunks automatically; other clients need chunked uploads for layers over 100 MB. Pulls have no size limit. |
| Manifest size | 4 MiB | Larger manifests fail with `413 MANIFEST_INVALID: manifests are limited to 4 MiB`. |
| Image name | 255 characters | `<owner>/<name>`, lowercase letters, digits, `.`, `_`, `-` and `/`. |
| Tags per tag-list page | 10,000 | `GET /v2/<owner>/<name>/tags/list?n=`. |
| Packages listed per owner | 1,000 | `GET /api/v3/users/{owner}/packages`, `/orgs/{owner}/packages`, `/user/packages`. |

## Imports

Limits of [imports from GitHub](/docs/migrate-from-github), from the web form, `diffinery migrate github`, `POST /api/v3/diffinery/imports` and the MCP tool `start_github_import`.

| Limit | Value | Applies to |
| --- | --- | --- |
| Imports at a time | 1 organization import and 3 repository imports | Counted per person or agent who starts them and per account imported into. Organization imports count while `draft`, `queued` or `running`; repository imports while `queued` or `running`, not counting the repositories inside an organization import. Over the limit: `429 an organization import is already in progress (at most 1 at a time); wait for it to finish or cancel it` or `429 too many repository imports are already running (at most 3 at a time); wait for one to finish`. |
| Repository size | 10 GB by default | GitHub's reported size of the repository in a one-repository import, checked before the import starts: `422 the repository is about N GB, over the M GB import limit; ask an administrator to raise IMPORT_MAX_REPO_KB or split the repository`. Operators change it with `IMPORT_MAX_REPO_KB` (see [Configuration](/docs/self-hosting/configuration#worker-variables)). Each repository of an organization import is checked too, and one over the limit fails before anything is copied. |
| Repositories per organization import | 1,000 | The `repositories` list (`422 at most 1000 repositories per import`), and the repositories read from the GitHub organization or user. |
| Repositories imported at once | 1 to 8, default 3 | One organization import's `concurrency` (**Repositories at a time** in the form). `422 concurrency must be between 1 and 8`. |
| Git transfer | 6 hours | Copying the Git data in the import container. After that the import fails with `the Git transfer did not finish within 6 hours`. A transfer that fails for another reason is tried once more, except when push protection stopped it. |
| Size of each push in the transfer | 32 MiB | The import agent pushes history in chunks of at most this size, below the 100 MB push limit, and smaller ones if a push is still refused as too large. |
| Retries of each import step | 5, 15 seconds apart at first and backing off exponentially | Each step of the import's durable workflow, which may run for at most 15 minutes per call. |
| Calls per paged step | 2,000 | Steps that page through GitHub (issues, comments, reviews and the rest). Each call reads up to 10 pages of 100 items (30 pull requests for reviews). More fails the import with `the <step> step did not finish within 2000 pages`. |
| GitHub rate limits | Waits 5 seconds to 1 hour at a time | When GitHub answers with a rate limit, the import sleeps until it resets and continues; it doesn't fail. |
| GitHub responses | 8 MiB each, 30 seconds per request | A larger response fails with `GitHub response is too large` or `GitHub response exceeded the size limit`. Redirects are followed only on the same host. |
| Organization import duration | 1 week | An organization import waits up to 168 hours for its repositories. Any still unfinished then count as not imported, and the organization import fails. |
| Draft organization imports | 7 days | An organization import started in the web form whose repositories were never chosen is cancelled (`draft expired`) and its GitHub token erased. |
| Release assets | 2 GiB each | Larger assets, and assets that can't be downloaded, are skipped with a warning. |
| Warnings | 500 per import, 1,000 characters each | Further warnings are not recorded. |
| Imports listed | 100 | The most recent imports you started, in `GET /api/v3/diffinery/imports`, `list_imports` and the **Imports** page. |
| GitHub token | 400 characters, no spaces | `422 github_token is not a valid token`. Deleted when the import ends. |
| Push token of the transfer | 1 day, one repository | The token the import container pushes with. It works only for Git, Git LFS and the import's own agent endpoints, and is revoked when the transfer ends. |
| Copied repository details | 20 topics, 1,000 characters of description, 500 of homepage | Taken from the GitHub repository. |

## Webhooks and events

| Limit | Value | Applies to |
| --- | --- | --- |
| Webhook URL | `https://` to a public host | Other schemes fail with `webhook URL must use https`. `localhost`, single-label names, `.local` and `.internal` names, and private, loopback and link-local addresses fail with `webhook URL must be a public host`; Diffinery's own host and its subdomains fail with `webhook URL can't point at Diffinery itself`. A webhook saved before these checks that points at such an address is never delivered to (recorded status `0`). |
| Webhooks per repository | 20 | The 21st fails with `422` and `a repository can have at most 20 webhooks`, as on GitHub. |
| Delivery timeout | 10 seconds | A receiver that takes longer counts as failed (recorded status `0`). |
| Redirects | Not followed | A `3xx` answer is recorded as the delivery's status. |
| Failed deliveries | Retried up to 5 times | A network error, a timeout, `408`, `429` or a `5xx` status is retried 1 minute, 5 minutes, 30 minutes, 1 hour and 3 hours after successive failures (6 attempts at most, about 4 hours and 36 minutes in all), with the same `X-GitHub-Delivery` ID. Other statuses, including `3xx` and other `4xx`, are not retried. A retry is dropped if the webhook was deleted. Each attempt updates the last status and time shown on the webhook. See [Retries](/docs/repositories/webhooks#retries). |
| Event processing retries | 8, then the dead-letter queue | If processing an event fails (audit log, webhooks, notifications), it is retried with backoff (starting at 20 seconds and doubling, at most 5 minutes) up to 8 times, then moved to `diffinery-events-dlq`. |

## Email

| Limit | Value | Applies to |
| --- | --- | --- |
| Email log retention | 90 days | **Settings → Email** and `GET /api/v3/diffinery/emails` show emails from the last 90 days. Older entries are deleted once a day. |
| Audit log retention | 2 years | Entries older than 730 days are deleted every hour (see [Audit log](/docs/security/audit-log#how-long-entries-are-kept)). |
| Sending retries | 6 attempts | A temporary sending failure (rate limit, internal error or delivery failure reported by Cloudflare) is retried with backoff (starting at 30 seconds and doubling, at most 10 minutes). Other failures are logged as failed at once. After 6 attempts the email is logged as failed. |
| Message body | 20,000 characters | Longer issue, pull request or comment text in an email is cut and ends with `…`. |
| Subject | 900 characters | |
| Commits in a push email | 10 | |
| Jobs in a workflow run email | 20 | |
| Line comments in a review email | 20 | |
| Mentions per event | 60 | Only the first 60 distinct `@mentions` in one comment or description are notified. |
| Recipients per event | 200 | At most 200 people are notified about one event, in the app or by email. |
| Invitations | 50 per person per 24 hours | Invitations to an organization, a repository or the site, counted per inviter. The 51st answers `429 you can send at most 50 invitations in 24 hours; try again later`. Site administrators aren't limited. |
| Test emails | 5 per account per hour | **Send me a test email** and `POST /api/v3/diffinery/emails/test`; the 6th answers `429 you can send at most 5 test emails an hour; try again later`. |
| Morning digest | Once a day at the hour you choose, within 5 minutes; up to 8 lines per section | **Send me my digest now** and `POST /api/v3/diffinery/emails/digest`: 3 an hour, then `429 you can ask for your digest at most 3 times an hour; try again later`. "Since the last digest" reaches back at most 7 days. |
| Images in emails | Linked, not loaded | An image in issue, pull request or comment text that isn't on Diffinery itself shows in the email as a link (`[alt text]`), so opening the email doesn't tell the image's host that you read it. |

## Platform limits for operators

These come from `apps/diffinery/wrangler.jsonc` and matter when you run your own instance (see [Configuration](/docs/self-hosting/configuration)).

| Limit | Value | Applies to |
| --- | --- | --- |
| Worker CPU time | 300,000 ms per request | `limits.cpu_ms`. |
| Live update connection | 10 minutes, up to 10 topics | A page's WebSocket is closed with code `4001` after 10 minutes and reconnects at once, so access is checked again. |
| Runner containers | Up to 100 instances of each size: `standard-4`, `standard-3`, `standard-1` and `basic` | `containers[RunnerContainer]`, `[RunnerContainerMedium]`, `[RunnerContainerSmall]`, `[RunnerContainerTiny]`. |
| Sandbox containers | `standard-1`, up to 50 instances | `containers[SandboxContainer]`. |
| Import containers | `standard-4`, up to 20 instances | `containers[ImportContainer]`: one container per Git transfer of an import. |
| Container rollout grace period | 23,400 seconds for runners, 25,200 for imports, 3,600 for sandboxes | `rollout_active_grace_period`. A deploy doesn't replace a container younger than this, so running jobs (6 hours at most) and import transfers finish first. |
| Container rollout steps | One step of 100% | `rollout_step_percentage`. Containers started after a deploy get the new image at once, so a new job doesn't start on the old one and get replaced. |
| Event queue | Batches of up to 50 messages (2 seconds), 8 retries | `diffinery-events`, dead-letter queue `diffinery-events-dlq`. |
| Mail queue | Batches of up to 20 messages (2 seconds), 8 retries | `diffinery-mail`, dead-letter queue `diffinery-mail-dlq`. The consumer itself gives up after 6 attempts. |
| Workflow scheduler | Every 5 minutes | `SchedulerDO`'s own alarm (`SCHEDULE_TICK_MINUTES`, 1 to 60) starts scheduled workflows, up to 16 repositories at a time. |
| Cron trigger | Every 5 minutes | `*/5 * * * *`: token expiry reminders, email log pruning, container registry cleanup, cancelling draft imports older than 7 days, and setting the scheduler's alarm if it isn't set. |
