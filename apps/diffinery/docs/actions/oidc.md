---
title: OpenID Connect (OIDC)
description: Let workflows authenticate to AWS, Google Cloud and your own services with short-lived OIDC tokens issued by Diffinery, instead of stored keys.
---

A workflow job can ask Diffinery for an OpenID Connect ID token: a signed JWT that says which repository, branch, commit and workflow the job belongs to. A cloud provider or your own service that trusts Diffinery's issuer can exchange that token for short-lived credentials, so you don't store long-lived cloud keys as secrets. This works like GitHub Actions' OIDC, with Diffinery as the issuer; the differences are listed in [Differences from GitHub](#differences-from-github).

## Requirements

- The job's effective permissions must include `id-token: write`. A job's own `permissions:` replaces the workflow's top-level `permissions:` entirely, as on GitHub, so a job that sets `permissions:` must list `id-token: write` itself. `permissions: write-all` includes it.
- The repository's default permissions never include `id-token`, and neither does `read-all`. `id-token: read` grants nothing.
- It works on hosted and self-hosted runners.
- In a reusable workflow, the called jobs get the calling job's permissions, and anything the called workflow or its jobs declare is lowered to the calling job's permissions. So the calling job's effective permissions must include `id-token: write`, and so must the called workflow's or job's `permissions:` when it sets one. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions#reusable-workflows).

```yaml
permissions:
  id-token: write
  contents: read
```

This job gets no OIDC token, because its own `permissions:` replaces the workflow's:

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read        # id-token is now none for this job
    steps:
      - run: echo "no ACTIONS_ID_TOKEN_REQUEST_URL here"
```

Without the permission, the variables below aren't set, and `core.getIDToken()` in an action fails because `ACTIONS_ID_TOKEN_REQUEST_URL` is missing.

## The issuer

| Item | Value |
|---|---|
| Issuer (`iss`) | `https://diffinery.com` |
| Discovery document | `https://diffinery.com/.well-known/openid-configuration` |
| Signing keys (JWKS) | `https://diffinery.com/.well-known/jwks` |
| Algorithm | `ES256` (ECDSA P-256 with SHA-256) |
| Token lifetime | 10 minutes |

The discovery document:

```json
{
  "issuer": "https://diffinery.com",
  "jwks_uri": "https://diffinery.com/.well-known/jwks",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["ES256"],
  "claims_supported": ["sub", "aud", "iss", "repository", "repository_id", "repository_owner", "repository_owner_id", "environment", "agent_origin", "ref", "ref_type", "sha", "workflow", "event_name", "actor", "actor_id", "run_id"]
}
```

The JWKS document holds the public key as an EC JWK with `"use": "sig"`, `"alg": "ES256"` and a `kid`, which matches the `kid` in each token's header.

## Requesting a token

When a job has `id-token: write`, the runner sets two environment variables, the same ones GitHub sets:

| Variable | Value |
|---|---|
| `ACTIONS_ID_TOKEN_REQUEST_URL` | `https://diffinery.com/runner/jobs/<job id>/oidc?api-version=2.0` |
| `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | The job's token, to send as a bearer token |

Actions that call `core.getIDToken(audience)` from `@actions/core`, such as `aws-actions/configure-aws-credentials` and `google-github-actions/auth`, use them automatically. From a shell step, append `&audience=<value>` and send a `GET` (or `POST`):

```yaml
- name: Get an OIDC token
  run: |
    token=$(curl -fsS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://deploy.example.com" | jq -r .value)
    echo "::add-mask::$token"
    echo "OIDC_TOKEN=$token" >> "$GITHUB_ENV"
```

The response is `{"value": "<JWT>"}`. Without `audience`, the token's `aud` is `https://diffinery.com`. Mask the token with `::add-mask::` before doing anything else with it: it isn't a stored secret, so the runner doesn't know to hide it.

Errors from the endpoint:

| Status and message | Cause |
|---|---|
| `403 this job lacks permissions: id-token: write` | The job doesn't have the permission. |
| `409 job is not running` | The job has finished, or hasn't started. |
| `401 job token required` / `401 token does not match job` | The request didn't send this job's token. |
| `501 OIDC is not configured on this Diffinery instance` | The instance has no signing key. A deploy creates one (`OIDC_PRIVATE_KEY`, see [Worker secrets](/docs/self-hosting/configuration#worker-secrets)); ask the instance's administrators. |

## Claims

Every token has these claims. All values are strings except the timestamps.

| Claim | Example | Meaning |
|---|---|---|
| `iss` | `https://diffinery.com` | Issuer. |
| `aud` | `sts.amazonaws.com` | The requested audience, or `https://diffinery.com` if none was given. A single string. |
| `sub` | `repo:acme/website:ref:refs/heads/main` | As on GitHub: `repo:<owner>/<repo>:environment:<name>` for a job with `environment:`, `repo:<owner>/<repo>:pull_request` for a `pull_request` run, and `repo:<owner>/<repo>:ref:<ref>` otherwise. |
| `iat`, `nbf` | `1760000000` | Issue time and not-before time (the same). |
| `exp` | `1760000600` | Expiry, 10 minutes after issue. |
| `repository` | `acme/website` | Repository that runs the workflow. |
| `repository_id` | `2918374650` | The repository's numeric id. It stays the same when the repository is renamed or transferred, and a new repository with an old name gets a new one. |
| `repository_owner` | `acme` | Its owner (user or organization). |
| `repository_owner_id` | `3482910375` | The owner's numeric id, which a new account with a reused name doesn't get. |
| `environment` | `production` | The environment the job deployed to. Only on jobs with `environment:`, once its protection rules passed, and only when the job may also have the environment's secrets. |
| `agent_origin` | `false` | Diffinery's own claim: `true` when the code the run executes came from an agent (an agent pushed it, or merged it). |
| `ref_type` | `branch` | `branch` or `tag`. |
| `head_ref`, `base_ref` | `feature`, `main` | The pull request's branches, on pull request runs only. |
| `run_number`, `run_attempt` | `128`, `1` | The run's number and attempt. |
| `ref` | `refs/heads/main` | The run's ref. See the table below. |
| `sha` | `9fceb02d0ae598e95dc970b74767f19372d61af8` | The commit the run checked out. |
| `workflow` | `Deploy` | The workflow's `name`, or its file path when it has none. |
| `event_name` | `push` | The event that started the run. |
| `run_id` | `128` | The run number, as a string. It's the same value as `github.run_id`, and stays the same when the run is re-run. |
| `actor` | `diffy` | Who started the run. |
| `actor_id` | `1938475620` | Their numeric id. |
| `job_workflow_ref` | `acme/website/.github/workflows/deploy.yml@refs/heads/main` | The run's top-level workflow file and ref. |

The token header is `{"alg": "ES256", "typ": "JWT", "kid": "..."}`.

The `ref` for each event. It is also the end of `sub`, except in a job with `environment:` and in a `pull_request` run:

| Event | `ref` |
|---|---|
| `push` | The pushed branch or tag, for example `refs/heads/main` or `refs/tags/v1.2.0` |
| `pull_request` | `refs/pull/<number>/merge` |
| `pull_request_target` | The base branch, for example `refs/heads/main` |
| `merge_group` | The merge queue's temporary branch |
| `workflow_dispatch` | The branch or tag it was started on |
| `schedule`, `workflow_run`, `repository_dispatch` | The default branch |
| `release` | The release's tag, for example `refs/tags/v1.4.0` |

> **Important:** `pull_request_target` runs carry the base branch's `ref` and `sub`, and so do `schedule`, `workflow_run` and `repository_dispatch` runs on the default branch. A trust policy that only checks `sub` treats them like pushes to that branch. They run the base branch's own workflow files, so this is safe unless such a workflow checks out and runs pull request code. Where your provider lets you, also check `event_name`.

## Jobs that use an environment

A job with `environment:` gets GitHub's environment form of `sub`, `repo:<owner>/<repo>:environment:<name>`, and an `environment` claim. The token is only issued after the environment's deployment branch policy has passed, so a trust policy on `repo:acme/website:environment:production` only trusts jobs that were allowed to deploy to `production` (see [Deployments and environments](/docs/actions/environments)). A job that the environment lets deploy but keeps its secrets from, such as agent code on a branch the policy doesn't trust agents with, gets the `ref:` or `pull_request` subject instead. To keep agent code out of a role altogether, also require `agent_origin` to be `false`.

To keep trusting a reused name out, also check `repository_id` and `repository_owner_id` where your provider lets you: a repository deleted and recreated, or an owner name taken by a new account, gets new ids.

## AWS

AWS accepts Diffinery tokens through an IAM OIDC identity provider and a role whose trust policy names it.

1. Create the identity provider (once per AWS account), with provider URL `https://diffinery.com` and audience `sts.amazonaws.com`:

   ```sh
   aws iam create-open-id-connect-provider \
     --url https://diffinery.com \
     --client-id-list sts.amazonaws.com
   ```

2. Create a role with this trust policy. Replace the account id, and narrow `sub` to the repositories and branches that may deploy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/diffinery.com" },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "diffinery.com:aud": "sts.amazonaws.com",
             "diffinery.com:sub": "repo:acme/website:ref:refs/heads/main"
           }
         }
       }
     ]
   }
   ```

   To allow every branch and tag of the repository, use `"StringLike": { "diffinery.com:sub": "repo:acme/website:*" }` together with the `aud` check. That pattern also matches `pull_request` runs and jobs in any environment, so a role that deploys should name one `ref:` or `environment:` subject instead. Attach the permissions the workflow needs to the role.

3. Use it from a workflow:

   ```yaml
   name: Deploy to AWS
   on:
     push:
       branches: [main]

   permissions:
     id-token: write
     contents: read

   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: aws-actions/configure-aws-credentials@v4
           with:
             role-to-assume: arn:aws:iam::123456789012:role/diffinery-website-deploy
             aws-region: eu-west-1
         - run: pip install awscli        # the AWS CLI isn't preinstalled on hosted runners
         - run: aws sts get-caller-identity
         - run: aws s3 sync ./dist s3://acme-website --delete
   ```

Without the action, exchange the token yourself:

```sh
token=$(curl -fsS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
aws sts assume-role-with-web-identity \
  --role-arn arn:aws:iam::123456789012:role/diffinery-website-deploy \
  --role-session-name "diffinery-$GITHUB_RUN_ID" \
  --web-identity-token "$token"
```

## Google Cloud

Google Cloud accepts Diffinery tokens through Workload Identity Federation.

1. Create a pool and an OIDC provider for the Diffinery issuer. The attribute condition limits which tokens are accepted at all:

   ```sh
   gcloud iam workload-identity-pools create diffinery \
     --location=global --display-name="Diffinery"

   gcloud iam workload-identity-pools providers create-oidc diffinery \
     --location=global \
     --workload-identity-pool=diffinery \
     --issuer-uri=https://diffinery.com \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name" \
     --attribute-condition="assertion.repository_owner == 'acme'"
   ```

2. Let one repository impersonate a service account (use your project number):

   ```sh
   gcloud iam service-accounts add-iam-policy-binding deployer@acme-prod.iam.gserviceaccount.com \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/diffinery/attribute.repository/acme/website"
   ```

3. Use it from a workflow:

   ```yaml
   permissions:
     id-token: write
     contents: read

   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: google-github-actions/auth@v2
           with:
             workload_identity_provider: projects/123456789012/locations/global/workloadIdentityPools/diffinery/providers/diffinery
             service_account: deployer@acme-prod.iam.gserviceaccount.com
         - uses: google-github-actions/setup-gcloud@v2
         - run: gcloud run deploy website --source . --region europe-west1
   ```

## Your own service on Cloudflare Workers

OIDC tokens also let a workflow call a service you run, such as a deploy hook on Cloudflare Workers, without a shared secret. The Worker verifies the token against Diffinery's published keys:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(new URL("https://diffinery.com/.well-known/jwks"));

export default {
  async fetch(request: Request): Promise<Response> {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return new Response("missing token", { status: 401 });
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: "https://diffinery.com",
        audience: "https://deploy.acme.workers.dev",
        algorithms: ["ES256"],
      });
      if (payload.repository !== "acme/website" || payload.ref !== "refs/heads/main" || payload.event_name !== "push") {
        return new Response("not allowed", { status: 403 });
      }
      // ... do the deploy for payload.sha ...
      return Response.json({ ok: true, sha: payload.sha });
    } catch {
      return new Response("invalid token", { status: 401 });
    }
  },
};
```

The workflow requests a token with the same audience and sends it:

```yaml
permissions:
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: |
          token=$(curl -fsS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://deploy.acme.workers.dev" | jq -r .value)
          echo "::add-mask::$token"
          curl -fsS -X POST https://deploy.acme.workers.dev/ -H "Authorization: Bearer $token"
```

## Verifying tokens yourself

Any service can verify a Diffinery token. Check, in this order:

1. The header's `alg` is `ES256`. Reject anything else.
2. The signature, with the key from `https://diffinery.com/.well-known/jwks` whose `kid` matches the header. Cache the key set, and fetch it again when you see an unknown `kid`.
3. `iss` is exactly `https://diffinery.com`.
4. `aud` is the audience your service expects. Have workflows request an audience unique to your service, so a token meant for another service can't be replayed to yours.
5. `exp` is in the future and `nbf` is in the past (allow a little clock skew).
6. Your authorization rules: `repository`, `ref`, `event_name`, and if needed `sha` or `actor`. Match `repository` exactly, not by prefix.

In Node.js with [jose](https://github.com/panva/jose), `jwtVerify` with `issuer`, `audience` and `algorithms: ["ES256"]` performs steps 1 to 5 (see the Worker example above). In Python with PyJWT:

```text
pip install "pyjwt[crypto]"
```

```text
import jwt

jwks = jwt.PyJWKClient("https://diffinery.com/.well-known/jwks")

def verify(token: str) -> dict:
    key = jwks.get_signing_key_from_jwt(token).key
    claims = jwt.decode(
        token,
        key,
        algorithms=["ES256"],
        audience="https://deploy.example.com",
        issuer="https://diffinery.com",
    )
    if claims["repository"] != "acme/website" or claims["ref"] != "refs/heads/main":
        raise PermissionError("not allowed")
    return claims
```

## Differences from GitHub

| Area | GitHub | Diffinery |
|---|---|---|
| Issuer | `https://token.actions.githubusercontent.com` | `https://diffinery.com` |
| Algorithm | RS256 | ES256 |
| `sub` | `environment:<name>`, `pull_request` or `ref:<ref>` form, and a customizable template | The same three forms; the template can't be customized |
| Claims | Many, including `workflow_ref`, `job_workflow_sha`, `runner_environment` | Only the claims listed in [Claims](#claims) |
| `job_workflow_ref` | The reusable workflow's file when the job is in one | Always the run's top-level workflow |
| Token lifetime | About 5 to 10 minutes | 10 minutes |

When you port a trust policy from GitHub, change the issuer host (`token.actions.githubusercontent.com` to `diffinery.com`) in provider URLs and condition keys, and keep your `sub` patterns as they are, unless they rely on a customized subject template.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable` from an action | The job's effective permissions lack `id-token: write`. Add it to the job's `permissions:` if the job has one, otherwise to the workflow's. In a reusable workflow, the calling job needs it too. See [GITHUB_TOKEN permissions](/docs/actions/workflow-permissions). |
| AWS: `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The trust policy's `sub` or `aud` doesn't match. Decode the token (its middle part is base64url JSON) and compare `sub` and `aud` with the policy. |
| AWS: `No OpenIDConnect provider found in your account for https://diffinery.com` | Create the identity provider with URL `https://diffinery.com`. |
| Google Cloud: `The given credential is rejected by the attribute condition` | The `attribute-condition` on the provider doesn't match the token's claims. |
| Your service rejects the token as expired | Tokens last 10 minutes. Request a new one right before you use it. |
