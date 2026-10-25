---
title: Webhooks
description: Send repository events to your own HTTPS endpoint, verify their signatures, and check delivery status, with GitHub-compatible headers and payloads.
---

A webhook sends an HTTPS `POST` with a JSON payload to a URL you choose whenever something happens in a repository: a push, a pull request opened, edited or merged, an issue comment, a workflow run started by hand or finished, a published release, a commit status or a deployment. Use webhooks to connect chat bots, deploy systems, external CI or any service that reacts to repository activity.

## How webhooks work

- Webhooks belong to one repository. You need the **admin** role on it to create, list or delete them.
- Each webhook has a payload URL (HTTPS only), a list of events, and a signing secret. The secret is stored encrypted with a key of its own and is never shown again after creation.
- When an event happens, Diffinery puts it on an internal queue. Within a few seconds the queue delivers it to every active webhook of the repository that subscribes to that event, in parallel.
- Each delivery is signed with an HMAC-SHA256 of the body using the webhook's secret, in the `X-Hub-Signature-256` header, the same scheme GitHub uses.
- A delivery that fails with a network error, a timeout, `408`, `429` or a `5xx` status is retried up to five times over about four and a half hours, with the same `X-GitHub-Delivery` id. See [Retries](#retries).
- Diffinery records the HTTP status and time of the most recent delivery attempt of each webhook.

## Events

| Event | Sent when | Actions |
|---|---|---|
| `push` | A branch or tag is created, updated or deleted, by `git push`, the web editor, the contents or Git data API, MCP, a merge, the merge queue, or a release that creates its tag | none |
| `pull_request` | A pull request is opened, updated, edited, closed, merged, reopened, assigned, gets a review request, is marked ready for review or converted to a draft, enters or leaves the merge queue, or has auto-merge turned on or off | `opened`, `synchronize`, `edited`, `closed`, `reopened`, `assigned`, `review_requested`, `ready_for_review`, `converted_to_draft`, `enqueued`, `dequeued`, `auto_merge_enabled`, `auto_merge_disabled` |
| `pull_request_review` | A review is submitted | `submitted` |
| `issues` | An issue is opened, edited (title or body), closed, reopened or assigned | `opened`, `edited`, `closed`, `reopened`, `assigned` |
| `issue_comment` | A comment is added to an issue or a pull request | `created` |
| `workflow_run` | A workflow run is created or finishes | `requested`, `completed` |
| `release` | A release is created, published, edited, unpublished or deleted, including drafts | `created`, `published`, `released`, `prereleased`, `edited`, `unpublished`, `deleted` |
| `status` | A commit status is posted | none |
| `deployment` | A deployment is created, with the REST API or by a workflow job with `environment:` | `created` |
| `deployment_status` | A deployment gets a new status, from the REST API or from a workflow job with `environment:` | `created` |
| `deployment_review` | A run starts waiting on an environment's [required reviewers](/docs/actions/environments#required-reviewers-and-wait-timers), or a reviewer approves or rejects it | `requested`, `approved`, `rejected` |
| `repository_dispatch` | Someone calls `POST /repos/{owner}/{repo}/dispatches` | the `event_type` that was sent |
| `workflow_dispatch` | Someone starts a workflow by hand (web UI, CLI, REST API or MCP) | none |
| `*` | Every event above | |

A merged pull request is delivered as `pull_request` with `"action": "closed"` and `"pull_request": { "merged": true }`, like GitHub. `edited` is sent when the title or body actually changes, not for label or assignee changes. The `release`, `status`, `deployment`, `deployment_status` and `repository_dispatch` payloads have GitHub's shape (for example `release` holds the same release object as the REST API). The full payload of each event, with examples, is in [Webhook events](/docs/reference/webhook-events).

## Creating a webhook

### In the web UI

1. Open the repository, for example `https://diffinery.com/acme/website`.
2. Select **Settings**, then **Webhooks** in the sidebar (`https://diffinery.com/acme/website/settings/webhooks`).
3. Under **Add a webhook**, enter the **Payload URL**. It must start with `https://` and name a public host: not `localhost`, a private or loopback address, or Diffinery itself.
4. Under **Events**, keep **Everything** checked to receive all events, or uncheck it and check the events you want: `push`, `pull_request`, `pull_request_review`, `issues`, `issue_comment`, `workflow_run`, `workflow_dispatch`. If **Everything** stays checked, the webhook receives every event regardless of the other boxes, including `release`, `status`, `deployment`, `deployment_status`, `deployment_review` and `repository_dispatch`. If you uncheck every box, the webhook also receives every event.
5. Optionally enter a **Secret**. Leave it empty to have Diffinery generate one.
6. Select **Add webhook**.

The page then shows **Webhook created for** your URL with the signing secret. Copy it now: it is not shown again. If you lose it, delete the webhook and create a new one.

> **Note:** The web form only offers the events listed above as separate checkboxes. To subscribe to `release`, `status`, `deployment`, `deployment_status`, `deployment_review` or `repository_dispatch` without receiving everything, create the webhook with the API and list the events you want.

### With the API

`POST /api/v3/repos/{owner}/{repo}/hooks` creates a webhook. It needs a token with the `admin` scope for an account with the admin role on the repository.

```sh
curl -sS -X POST \
  -H "Authorization: Bearer dfy_..." \
  -H "Content-Type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/hooks \
  -d '{
    "config": { "url": "https://example.com/hooks/diffinery", "secret": "my-long-random-secret" },
    "events": ["push", "release", "status"]
  }'
```

| Field | Required | Description |
|---|---|---|
| `config.url` | yes | The payload URL. Must start with `https://`, otherwise the request fails with `422` and `webhook URL must use https`. It must name a public host: `localhost`, private and loopback addresses fail with `webhook URL must be a public host`, and Diffinery's own host with `webhook URL can't point at Diffinery itself`. A repository can have at most 20 webhooks. |
| `config.secret` | no | The signing secret. When omitted, Diffinery generates a random one. |
| `events` | no | Event names to subscribe to. Omitted, empty or not a list means `["*"]` (every event). |

A request without `config.url` fails with `422` and `config.url is required`.

The response (`201`) is the webhook, in GitHub's hook format. When you didn't send a secret, it also contains the generated `secret`, once:

```json
{
  "type": "Repository",
  "id": "0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b",
  "name": "web",
  "active": true,
  "events": ["push", "release", "status"],
  "config": { "url": "https://example.com/hooks/diffinery", "content_type": "json", "insecure_ssl": "0" },
  "updated_at": "2026-10-13T09:00:00Z",
  "created_at": "2026-10-13T09:00:00Z",
  "url": "https://diffinery.com/api/v3/repos/acme/website/hooks/0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b",
  "ping_url": "https://diffinery.com/api/v3/repos/acme/website/hooks/0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b/pings",
  "deliveries_url": "https://diffinery.com/api/v3/repos/acme/website/hooks/0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b/deliveries",
  "last_response": { "code": null, "status": "unused", "message": null }
}
```

When you send `config.secret`, the response has no `secret` field: store your own copy. Webhook ids are 32-character hexadecimal strings. Other GitHub fields such as `name`, `active` and `config.content_type` are ignored on create. Payloads are always JSON. Event names are not validated: a name that is not in the table above never matches anything.

The same request with the CLI (install it with `curl -fsSL https://diffinery.com/install | bash`, then `diffinery login`):

```sh
cat > hook.json <<'EOF'
{ "config": { "url": "https://example.com/hooks/diffinery" }, "events": ["push"] }
EOF
diffinery api POST /repos/acme/website/hooks --input hook.json
```

### Listing and deleting webhooks

```sh
# List (the secret is never included)
curl -sS -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/hooks

# Delete
curl -sS -X DELETE -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/repos/acme/website/hooks/0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b
```

The list (paginated with `per_page` and `page`) returns the same objects, never with the secret:

```json
[
  {
    "type": "Repository",
    "id": "0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b",
    "name": "web",
    "active": true,
    "events": ["push", "release", "status"],
    "config": { "url": "https://example.com/hooks/diffinery", "content_type": "json", "insecure_ssl": "0" },
    "updated_at": "2026-10-13T09:30:02Z",
    "created_at": "2026-10-13T09:00:00Z",
    "url": "https://diffinery.com/api/v3/repos/acme/website/hooks/0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b",
    "ping_url": "https://diffinery.com/api/v3/repos/acme/website/hooks/0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b/pings",
    "deliveries_url": "https://diffinery.com/api/v3/repos/acme/website/hooks/0b9a6f3e2c1d4f5a8e7b6c5d4e3f2a1b/deliveries",
    "last_response": { "code": 200, "status": "active", "message": null }
  }
]
```

| Field | Description |
|---|---|
| `last_response.code` | HTTP status of the most recent delivery, `0` when it got no response, `null` before the first delivery |
| `last_response.status` | `unused` (no delivery yet), `active` (last delivery got a `2xx`) or `failed` |
| `updated_at` | Time of the most recent delivery, or the creation time before the first one |

`ping_url` and `deliveries_url` are included for GitHub clients, but Diffinery has no ping or delivery-history endpoints, so requests to them return `404`.

`DELETE` returns `204`. There is no endpoint to edit a webhook: to change its URL, events or secret, delete it and create a new one. In the web UI, select **Delete** next to the webhook.

## Delivery

### Request

```http
POST /hooks/diffinery HTTP/1.1
Host: example.com
Content-Type: application/json
User-Agent: Diffinery-Hookshot/1
X-GitHub-Event: pull_request
X-GitHub-Delivery: 7d3f0c2a9b8e4d1fa6c5b4e3d2c1b0a9
X-Diffinery-Event: pull_request
X-Hub-Signature-256: sha256=4b1c0e2f...

{"action":"opened","number":42,"headRef":"fix-typo", ...}
```

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Diffinery-Hookshot/1` |
| `X-GitHub-Event` | The event name, for example `push` or `pull_request` |
| `X-Diffinery-Event` | The same event name |
| `X-GitHub-Delivery` | A unique id for this delivery: 32 hexadecimal characters |
| `X-Hub-Signature-256` | `sha256=` followed by the hex HMAC-SHA256 of the raw body, keyed with the webhook's secret |

The body is compact JSON (no extra whitespace). Every payload has `repository` and `sender` objects. `repository` is GitHub's full repository object, the same one `GET /api/v3/repos/{owner}/{repo}` returns: its `id` is a number, and `private` and `visibility` give the repository's real visibility (`false` and `public` for a public repository). See [Webhook events](/docs/reference/webhook-events#the-repository-object).

### Timeouts, redirects and retries

| Behavior | Detail |
|---|---|
| Timeout | Your endpoint has 10 seconds to respond. After that the delivery counts as failed with status `0`. |
| Redirects | Not followed. A `3xx` response is recorded as that status and counts as failed. Use the final URL. |
| Success | Any `2xx` status. The response body is ignored. |
| Failed deliveries | Recorded (the status, or `0` for a timeout, DNS or connection error). Network errors, timeouts, `408`, `429` and `5xx` are retried; see [Retries](#retries). Other statuses are not. |
| Duplicates | A retry repeats the same delivery with the same `X-GitHub-Delivery` id, so your endpoint can see a delivery again if it processed it but answered too slowly or with an error. Diffinery's own failures don't cause new deliveries: webhooks and notifications for an event are handled separately, and a step that fails before any webhook was called (for example while loading the repository's webhooks) is tried again on its own after 30 seconds, 2 minutes, 10 minutes, 30 minutes and 1 hour. Still, make your handler idempotent, for example by remembering delivery ids. |
| Order | Deliveries are not guaranteed to arrive in the order the events happened. Use the `at` timestamp in the payload, or the `created_at` and `updated_at` fields of the GitHub-shaped events. |

Respond quickly with a `2xx` and do slow work afterwards, so that deliveries don't time out.

### Retries

When an attempt fails in a way that may be temporary, Diffinery tries the same delivery again later:

| Result of an attempt | Retried |
|---|---|
| `2xx` | No: delivered |
| No response: network error, DNS failure, refused connection, or no answer within 10 seconds (recorded as `0`) | Yes |
| `408 Request Timeout`, `429 Too Many Requests` | Yes |
| `500` and above | Yes |
| `3xx` (redirects are not followed) | No |
| Any other `4xx`, for example `400`, `401`, `403`, `404` or `410` | No |

The retries come 1 minute after the first failed attempt, then 5 minutes, 30 minutes, 1 hour and 3 hours after each further failure: at most six attempts, the last about 4 hours 36 minutes after the first. The delays are minimums; queue processing can add a few seconds.

- Every attempt of one delivery has the same `X-GitHub-Delivery` id, the same `X-GitHub-Event` and the same body, so you can use the id to drop repeats.
- Each attempt is signed and sent with the webhook's URL and secret as they are at that moment. If the webhook was deleted in the meantime, the remaining retries are dropped.
- The delivery fails for good when an attempt gets a status that isn't retried, or when the sixth attempt also fails. Diffinery then stops without further notice: there is no email, no automatic disabling of the webhook, and no manual redelivery. The webhook's last status shows the result of the final attempt.
- Every attempt updates the webhook's last delivery status and time, so a delivery that succeeds on a retry shows as successful.
- Deliveries for other events are not held back while one is being retried, so a retried delivery can arrive after newer ones.

### Delivery status

Diffinery keeps the status and time of the **most recent** delivery attempt of each webhook (retries included), not a full history:

- On the **Webhooks** settings page, each webhook shows a status icon (green for `2xx`, red otherwise), its events, whether it is active, and `last delivery <status> <time>`, or `no deliveries yet`.
- `GET /api/v3/repos/{owner}/{repo}/hooks` returns `last_response.code` and `last_response.status`, with the delivery time in `updated_at`.

A status of `0` means the request did not get an HTTP response: a timeout after 10 seconds, a DNS failure or a refused connection. Failed deliveries are [retried](#retries) automatically, but there is no redelivery button and no ping event: to test a webhook, trigger a real event, for example by pushing a branch or opening an issue.

## Verifying signatures

Always verify `X-Hub-Signature-256` before trusting a payload. Compute the HMAC-SHA256 of the **raw request body bytes** with your secret as the key (UTF-8), hex-encode it, prefix `sha256=`, and compare it with the header using a constant-time comparison. Do not parse and re-serialize the JSON before computing the HMAC.

### Node.js

```js
import crypto from "node:crypto";
import http from "node:http";

const secret = process.env.WEBHOOK_SECRET;

function verify(rawBody, header) {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (!verify(body, req.headers["x-hub-signature-256"])) {
        res.writeHead(401).end("bad signature");
        return;
      }
      const event = req.headers["x-github-event"];
      const payload = JSON.parse(body.toString("utf8"));
      console.log(event, payload.action ?? "", payload.repository.full_name, payload.sender.login);
      res.writeHead(204).end();
    });
  })
  .listen(3000);
```

### Python

Standard library only:

```text
import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["WEBHOOK_SECRET"].encode("utf-8")

def verify(body: bytes, header: str | None) -> bool:
    if not header or not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)

class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not verify(body, self.headers.get("X-Hub-Signature-256")):
            self.send_response(401)
            self.end_headers()
            return
        payload = json.loads(body)
        print(self.headers.get("X-GitHub-Event"), payload.get("action"), payload["repository"]["full_name"])
        self.send_response(204)
        self.end_headers()

HTTPServer(("", 3000), Hook).serve_forever()
```

### Check a signature by hand

```sh
printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.*= /sha256=/'
```

## GitHub compatibility

Diffinery webhooks use GitHub's delivery format, so many GitHub webhook receivers and signature-verification libraries work unchanged:

- The same headers: `X-GitHub-Event`, `X-GitHub-Delivery` and `X-Hub-Signature-256`, plus `X-Diffinery-Event`.
- The same signature scheme (HMAC-SHA256, `sha256=` prefix, hex).
- The same event names and the same `action` values for the actions Diffinery sends.
- Payloads have GitHub's full `repository` object (numeric `id`, `node_id`, `owner`, `private`, `visibility`, `default_branch`, URLs and so on), a `sender`, GitHub-style `pull_request` and `issue` objects, and `pull_request.merged` on `closed`.
- `release`, `status`, `deployment`, `deployment_status`, `deployment_review` and `repository_dispatch` payloads have GitHub's structure, with the release, status and deployment fields GitHub receivers read. `workflow_dispatch` has GitHub's `inputs`, `ref` and `workflow` fields.
- The hooks API returns GitHub's hook object (`type`, `name`, `config`, `last_response`, ...).

Differences to plan for:

| GitHub | Diffinery |
|---|---|
| Rich payloads (full pull request, issue, comment, commit list) for every event | `push`, `pull_request`, `pull_request_review`, `issues`, `issue_comment` and `workflow_run` have small payloads: ids, refs, SHAs and links. Fetch details from the [REST API](/docs/api) when you need them. For example, `issue_comment` does not include the comment body, and `push` has no `commits` array. |
| Numeric ids everywhere | `repository.id` is a number, but `sender.id`, `commentId`, `runId` and webhook ids are 32-character hexadecimal strings. |
| `X-Hub-Signature` (SHA-1) is also sent | Only `X-Hub-Signature-256`. |
| `ping` event when a webhook is created | No ping event. |
| Failed deliveries are not retried automatically; they can be redelivered by hand; delivery history | Network errors, timeouts, `408`, `429` and `5xx` are retried automatically up to five times; no manual redelivery; only the last status and time. `ping_url` and `deliveries_url` return `404`. |
| Webhooks can be edited (`PATCH`) | Delete and recreate. |
| Payload can be form-encoded | Always JSON. |
| Organization webhooks | Repository webhooks only. |
| `check_run`, `check_suite` and many other events | Only the events in the table above. |
| `events` defaults to `["push"]` in the API | Defaults to `["*"]` (every event). |
| Secrets are never returned | A generated secret is returned once by the create request. |

Diffinery-specific fields in the small payloads use camelCase, for example `headRef`, `headSha`, `baseRef`, `commentId`, `runId` and `at`.

## Security

- Payload URLs must use HTTPS.
- The secret is stored with the webhook and is shown only once in the web UI (and returned once by the create API). Use a long random value, and keep it in your receiver's secret store.
- Verify the signature on every request, and reject requests without one.
- Creating a webhook is recorded in the [audit log](/docs/security/audit-log) as `repo.webhook.create`, and deleting one as `repo.webhook.delete`, both from the web UI and from the API (API changes carry `"via": "api"` in the detail).
- On an archived repository, webhooks can't be created or deleted: the request fails with `403` and `repository is archived (read-only)`.
- Payloads from a private repository say so (`"private": true`, `"visibility": "private"`), so a receiver can decide what it may show or forward.
- Payloads never contain Actions secrets, tokens or file contents.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `webhook URL must use https` | Use an `https://` URL. Plain HTTP endpoints are not supported. |
| Last delivery status `0` | Your endpoint did not answer within 10 seconds, or could not be reached. Check DNS, TLS and firewall rules, and respond before doing slow work. |
| Last delivery status `301` or `302` | Redirects are not followed. Update the payload URL to the final address (for example, add the trailing slash or `www`). |
| Signature mismatch | You are hashing a re-serialized body or the wrong secret. Hash the raw bytes exactly as received. If you lost the secret, recreate the webhook. |
| The same `X-GitHub-Delivery` id arrives more than once | A [retry](#retries): an earlier attempt failed or took longer than 10 seconds. Answer with a `2xx` within 10 seconds, and skip ids you already handled. |
| Last delivery status `404`, `401` or `403`, and no retries | Client errors other than `408` and `429` are not retried. Fix the payload URL or your endpoint's authentication; the next event is delivered normally. |
| No `edited` event after changing labels | `edited` is sent only when the title or body changes. Label changes send no webhook event. |
| No `release`, `status` or `deployment` deliveries | The webhook was created in the web UI with individual events checked, which can't include these. Recreate it with **Everything** checked, or with the API listing the events. |
| Three `release` deliveries for one new release | Publishing a release sends `created`, `published` and `released` (or `prereleased`), like GitHub. Act on the one you need, usually `published`. |
| A `deployment` and a `deployment_status` delivery for one workflow job | A job with `environment:` creates a deployment when it starts (`deployment` with `created`) and reports its progress as `deployment_status` events (`in_progress` when the job starts, then `success`, `failure` or `inactive`), as on GitHub. |
| `config.url is required` | Send the payload URL as `config.url`, not as a top-level `url`. |
| A webhook stopped receiving events | Check that it still exists on the **Webhooks** page and that the events it subscribes to are the ones you expect. |
