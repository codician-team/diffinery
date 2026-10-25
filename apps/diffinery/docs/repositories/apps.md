---
title: Apps
description: Build or connect integrations as GitHub-compatible apps on Diffinery, with app JWTs, installation access tokens, per-repository permissions and signed webhooks.
---

Apps are how deploy services, CI systems, code review bots and other integrations work with your repositories on Diffinery. They work like GitHub Apps: a service registers an app, people install it on their account or organization for all or some repositories, and the app signs in with its own private key to get short-lived tokens for exactly those repositories. It never uses anyone's personal token.

Because the endpoints, tokens and webhooks are GitHub's, an integration that already works with GitHub Enterprise Server usually works with Diffinery by changing its API URL to `https://diffinery.com/api/v3`.

## How apps work

- **An app** has a name, an owner (a person or an organization), the repository permissions it asks for, the webhook events it subscribes to, and one or more private keys. Its bot signs its work as `<slug>[bot]`.
- **An installation** is the app on one account. Someone who administers that account (the person themselves, or an owner or administrator of the organization) chooses **all repositories** or **only select repositories**, and can change that, suspend the app or uninstall it at any time.
- **The app's JWT** is a JSON Web Token the app signs with its private key (RS256, `iss` set to the app ID or client ID, valid for at most 10 minutes). It works only on the app endpoints below.
- **An installation access token** (`dia_…`) is what the app trades its JWT for. It lasts one hour and reaches only the installation's repositories, with only the installation's permissions; the app can narrow it further to some repositories or permissions.

## Register an app

1. Go to **Settings → Apps** and choose **New app**. You need to be signed in with your passkey, recently.
2. Give it a name (it can't change later), a homepage URL, and if you want: a setup URL (where people land after installing it, with `installation_id` and `setup_action=install` in the query), a webhook URL and secret, and whether anyone can install it. A private app installs only on its owner's account.
3. Choose its **repository permissions** and **events**, then **Register app**.
4. Copy or download the **private key** now. Diffinery keeps only the public half and can't show it again. Generate more keys, or add a public key you made yourself (`openssl rsa -in key.pem -pubout`), on the app's settings page; delete old ones when you rotate.

The app's settings page shows its **App ID**, **Client ID** and the API URL to configure in the integration.

## Permissions and events

| Permission | Read | Write |
| --- | --- | --- |
| Metadata | Always granted: repository details | — |
| Contents | Code, commits, branches, tags, releases, `git clone` and fetch | Push commits, create branches and releases, merge pull requests |
| Pull requests | Pull requests, reviews and their comments | Open, comment on and review pull requests |
| Issues | Issues, labels, milestones and comments | Open and comment on issues |
| Checks | Check runs | Report check runs on commits |
| Commit statuses | Commit statuses | Report commit statuses |
| Deployments | Deployments and environments | Create deployments and their statuses |
| Actions | Workflows, runs, jobs, logs and artifacts | Re-run and cancel runs |

Each request with an installation token needs the permission for its endpoint, the same table a workflow's `GITHUB_TOKEN` is checked against ([Workflow permissions](/docs/actions/workflow-permissions)). A request it doesn't cover gets GitHub's `403 Resource not accessible by integration`.

Apps are never offered administration, secrets, variables, webhooks, collaborators or workflow permissions. An app can't change a repository's settings, read or set its secrets, or add or change a workflow file in `.github/workflows` or `.diffinery/workflows`, by push, API commit or merge.

Webhook events an app can subscribe to: `push`, `pull_request`, `pull_request_review`, `issues`, `issue_comment`, `release`, `status`, `deployment`, `deployment_status`, `deployment_review`, `workflow_run`, `workflow_dispatch` and `repository_dispatch`. Each needs one of its permissions. Every app with a webhook also receives `installation` (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`) and `installation_repositories` (`added`, `removed`).

## Install an app

Open the app's page at `https://diffinery.com/apps/<slug>` and choose **Install**. Pick the account, then all repositories or the ones you select. The app gets the permissions shown there. You need to be signed in with your passkey in a browser: no token, agent or app can install an app or give it more repositories.

Manage installed apps under **Settings → Installed apps**:

- **Repository access**: switch between all and selected repositories, or change the selection. The app gets an `installation_repositories` webhook.
- **New permissions**: when an app asks for more than it had, it keeps the old permissions on each installation until someone who administers the account accepts the new ones. When it asks for less, that applies at once, also to tokens already made.
- **Suspend**: the app's tokens stop working and it gets no webhooks until you unsuspend it. An app can suspend its own installation, but can't lift a suspension you made.
- **Uninstall**: removes the installation; its tokens stop working at once.

## Use the API as an app

Sign a JWT with the private key, as any GitHub App library does, and call the app endpoints with `Authorization: Bearer <jwt>`:

```sh
# Ruby, Python, Go and Node libraries for GitHub Apps all make this JWT
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | base64 | tr -d '=\n' | tr '/+' '_-')
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now-60)) $((now+540)) "$APP_ID" | base64 | tr -d '=\n' | tr '/+' '_-')
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign app.private-key.pem | base64 | tr -d '=\n' | tr '/+' '_-')
JWT="$header.$payload.$sig"

curl -H "Authorization: Bearer $JWT" https://diffinery.com/api/v3/app/installations
curl -X POST -H "Authorization: Bearer $JWT" https://diffinery.com/api/v3/app/installations/$INSTALLATION_ID/access_tokens
```

With Octokit (or any GitHub client), point it at Diffinery:

```js
import { App, Octokit } from "octokit";

const app = new App({ appId: process.env.APP_ID, privateKey: process.env.PRIVATE_KEY, Octokit: Octokit.defaults({ baseUrl: "https://diffinery.com/api/v3" }) });
const octokit = await app.getInstallationOctokit(installationId);
await octokit.rest.checks.create({ owner, repo, name: "Deploy", head_sha, status: "completed", conclusion: "success" });
```

Git works with the installation token as the password:

```sh
git clone https://x-access-token:$TOKEN@diffinery.com/OWNER/REPO.git
```

| Endpoint | Credential | What it does |
| --- | --- | --- |
| `GET /app` | JWT | The app |
| `GET /app/installations` | JWT | Its installations |
| `GET`, `DELETE /app/installations/{id}` | JWT | One installation; uninstall |
| `POST /app/installations/{id}/access_tokens` | JWT | An installation access token, optionally with `repositories`, `repository_ids` and `permissions` |
| `PUT`, `DELETE /app/installations/{id}/suspended` | JWT | Suspend or unsuspend its installation |
| `GET /repos/{owner}/{repo}/installation`, `GET /orgs/{org}/installation`, `GET /users/{username}/installation` | JWT | Its installation that covers a repository or account |
| `GET /installation/repositories` | Installation token | The repositories the token reaches |
| `DELETE /installation/token` | Installation token | Revoke the token |
| `GET /apps/{slug}` | Any | A public app |
| `GET /user/installations`, `GET /user/installations/{id}/repositories` | Your token or session | Installations on accounts you administer |
| `PUT`, `DELETE /user/installations/{id}/repositories/{repository_id}` | Browser session | Add or remove a repository |

Diffinery's own endpoints manage apps: `GET` and `POST /api/v3/diffinery/apps`, `GET`, `PATCH` and `DELETE /api/v3/diffinery/apps/{slug}`, `GET`, `POST` and `DELETE /api/v3/diffinery/apps/{slug}/keys`, `POST /api/v3/diffinery/apps/{slug}/installations`, and `GET`, `PATCH`, `DELETE /api/v3/diffinery/installations/{id}`, `PUT` and `DELETE …/suspended` and `POST …/accept_permissions`. Reading needs a token or session; registering, keys and installing need a passkey session in a browser.

## Webhooks

An app with a webhook URL receives, for every repository it's installed on, the events it subscribed to, with an `installation` object (`id`, `node_id`) in the payload. Deliveries use the same headers, signature and retries as [repository webhooks](/docs/repositories/webhooks): verify `X-Hub-Signature-256` with the app's webhook secret.

## Not yet

- Signing people in to the app with OAuth (GitHub's user-to-server tokens) and the app manifest flow.
- GraphQL with installation tokens: use the REST API.
- Organization permissions (members, teams, administration).

## Related

- [Webhooks](/docs/repositories/webhooks) for one repository's own webhooks
- [Checks and statuses](/docs/collaboration/checks-and-statuses), which apps report
- [Deploy to Cloudflare Workers](/docs/actions/deploy-to-cloudflare-workers)
- [Access tokens](/docs/accounts/tokens) for scripts acting as you
