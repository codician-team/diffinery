import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { getCookie } from "hono/cookie";
import type { DiffineryEvent } from "@diffinery/shared";
import type { Env } from "./env.js";
import { credentialFrom, resolvePrincipal, type AppVars } from "./auth/principal.js";
import { Directory, pruneAuditLog } from "./lib/directory.js";
import { pruneExpired } from "./lib/retention.js";
import { getFirst } from "./lib/storage-keys.js";
import { BOOKMARK_COOKIE, BOOKMARK_HEADER, d1Session, sessionConstraint } from "./lib/d1.js";
import { SESSION_COOKIE } from "./auth/sessions.js";
import { newId, now } from "./lib/util.js";
import { bucketsFor, overLimit, tooMany } from "./lib/rate-limit.js";
import { deliverWebhook, type WebhookDeps, type WebhookRetry } from "./lib/webhooks.js";
import { APP_HOOK_PREFIX, appHook, appWebhookDeps, deliverToApps } from "./apps/service.js";
import { localOnly } from "./auth/dev.js";
import { Apps } from "./apps/store.js";
import { runStages, type Stage, type StageRetry } from "./lib/stages.js";
import { apiNotFound, errorResponse, loadRepo, repoStub } from "./http/common.js";
import { git } from "./http/git.js";
import { runner } from "./http/runner.js";
import { actionsRuntime } from "./http/actions-runtime.js";
import { api, wellKnown } from "./http/api.js";
import { avatars } from "./http/avatars.js";
import { camo } from "./http/camo.js";
import { mailApi } from "./mail/api.js";
import { files } from "./http/files.js";
import { webhookPayload } from "./lib/webhook-payload.js";
import { mcp } from "./mcp/server.js";
import { graphql } from "./http/graphql.js";
import { registry } from "./registry/http.js";
import { packagesApi } from "./registry/api.js";
import { RegistryStore } from "./registry/store.js";
import { mailCron, notifyEvent } from "./mail/notify.js";
import { schedulerStub } from "./lib/schedules.js";
import { mailQueue } from "./mail/send.js";
import { mailEvents, mailEventsQueue } from "./mail/events.js";
import { securityTxtRoutes } from "./http/security-txt.js";
import { securityReportsApi } from "./http/security-reports.js";
import { earlyAccessApi } from "./http/early-access.js";
import { statusApi } from "./http/status.js";
import { onReviewEvent } from "./agentic/reviews.js";
import { onVerifyEvent } from "./agentic/tasks.js";
import { recordActivity } from "./agentic/today.js";
import { modelProxy } from "./agentic/proxy.js";
import type { MailJob } from "./mail/types.js";
import { expireExports } from "./accounts/export.js";
import { cliLogin } from "./http/cli-login.js";
import { CliLogins } from "./auth/cli-login.js";
import { OAUTH_API_PATH, oauthApi } from "./http/oauth.js";
import { OAuth } from "./auth/oauth.js";
import { Timing, timedEnv } from "./lib/timing.js";
import { kumoAsset } from "./web/kumo.js";

export const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

app.onError((e, c) => errorResponse(e, c));
app.notFound((c) => (c.req.path.startsWith("/api/") ? apiNotFound() : c.text("404 Not Found", 404)));

// The model proxy for agent tasks: its own task-scoped token, not an account credential (agentic/proxy.ts).
app.all("/-/model/:provider/*", (c) => modelProxy(c));

// The islands bundle: public and immutable, sent as built before any session lookup (web/kumo.tsx).
app.get("/-/kumo/:file", (c) => kumoAsset(c.req.raw));

// The request's context, for code that renders without it in hand (the Markdown component signs image proxy URLs with its settings).
app.use("*", contextStorage());

// Security headers on every response, then identity: tokens, Access JWT, or anonymous.
app.use("*", async (c, next) => {
  // Browser sessions ride on cookies, so refuse state-changing requests that come from another site.
  // Token-authenticated calls (git, CLI, MCP, runners) carry no ambient credentials and are exempt.
  // OAuth's token, registration and revocation endpoints use no cookies and take client credentials
  // of their own (http/oauth.ts): any site's MCP client may call them, and they skip the session lookup.
  const oauthCall = OAUTH_API_PATH.test(c.req.path);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !oauthCall && !credentialFrom(c.req.raw)) {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const ours = new URL(c.env.PUBLIC_URL).origin;
    if ((site && site !== "same-origin" && site !== "none") || (!site && origin && origin !== ours)) {
      return c.json({ message: "cross-site request refused" }, 403);
    }
  }
  // One D1 session per request: replica reads that still see this client's earlier writes (see lib/d1.ts).
  const token = !oauthCall && !!credentialFrom(c.req.raw);
  const cookie = getCookie(c, BOOKMARK_COOKIE);
  const d1 = d1Session(c.env, sessionConstraint({ header: c.req.header(BOOKMARK_HEADER), cookie, token }));
  const timing = new Timing();
  c.env = timedEnv(d1.env, timing);
  const dir = new Directory(c.env);
  c.set("dir", dir);
  // The Actions runtime services authenticate with their own signed tokens and URLs (http/actions-runtime.ts).
  const runtime = c.req.path.startsWith("/twirp/") || c.req.path.startsWith("/_runtime/");
  // Avatar and proxied Markdown images are public and on every page many times over: skip the session lookup for them.
  const avatar = (c.req.method === "GET" || c.req.method === "HEAD") && (c.req.path.startsWith("/api/avatars/") || c.req.path.startsWith("/-/camo/"));
  c.set("principal", runtime || avatar || oauthCall ? { type: "anonymous" } : await resolvePrincipal(c.req.raw, c.env, dir));
  const limited = await overLimit(c.env, bucketsFor(c.req.method, c.req.path, c.get("principal"), c.req.header("cf-connecting-ip") ?? "unknown"));
  if (limited) c.res = tooMany(c, limited);
  else await next();
  if (c.res.status === 101) return;
  const h = c.res.headers;
  const bookmark = d1.bookmark();
  if (bookmark) {
    h.set(BOOKMARK_HEADER, bookmark);
    // Browsers: remember it once they have written something or are signed in.
    const browser = !token && (!["GET", "HEAD"].includes(c.req.method) || cookie !== undefined || getCookie(c, SESSION_COOKIE) !== undefined);
    if (browser && !avatar && bookmark !== cookie) h.append("set-cookie", `${BOOKMARK_COOKIE}=${bookmark}; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax`);
  }
  h.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  if (!h.has("x-frame-options")) h.set("x-frame-options", "DENY");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  // Where the time went, for signed-in people's developer tools (lib/timing.ts).
  if (c.get("principal").type === "account" && c.res.status < 400 && !h.has("server-timing")) h.set("server-timing", timing.header((c.req.raw.cf as { colo?: string } | undefined)?.colo));
});

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", avatars);
app.route("/", camo);
app.route("/", cliLogin);
app.route("/", oauthApi);
app.route("/", wellKnown);
app.route("/", securityTxtRoutes);
app.route("/", git);
app.route("/", runner);
app.route("/", mailApi);
app.route("/", securityReportsApi);
app.route("/", earlyAccessApi);
app.route("/", statusApi);
app.route("/", mailEvents);
app.route("/", registry);
app.route("/", packagesApi);
app.route("/", actionsRuntime);
app.route("/", graphql);
app.route("/", api);
app.route("/", files);
app.route("/", mcp);

// Live updates: authorise in the Worker, then hand the WebSocket to the repository's Durable Object.
app.get("/:owner/:repo/live", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  const { stub } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "read", { follow: true });
  return stub.fetch(c.req.raw);
});

app.get("/:owner/:repo/actions/runs/:runId/artifacts/:name", async (c) => {
  const { stub } = await loadRepo(c, c.req.param("owner"), c.req.param("repo"));
  // By name, or by id (the artifact-url output of upload-artifact).
  const name = c.req.param("name");
  const all = await stub.artifacts(c.req.param("runId"));
  const artifact = all.find((a) => a.name === name) ?? (/^\d+$/.test(name) ? all.find((a) => a.id === Number(name)) : undefined);
  if (!artifact) return c.json({ message: "artifact not found" }, 404);
  const obj = await getFirst(c.env.BUCKET, artifact.r2Keys);
  if (!obj) return c.json({ message: "artifact expired" }, 410);
  return new Response(obj.body, {
    headers: {
      "content-type": artifact.contentType,
      "content-length": String(obj.size),
      "content-disposition": `attachment; filename="${artifact.fileName.replace(/[^\w.-]+/g, "_")}"`,
    },
  });
});

// ---------------------------------------------------------------- events queue

const GITHUB_EVENT: Record<DiffineryEvent["type"], string> = {
  push: "push",
  pull_request: "pull_request",
  issues: "issues",
  issue_comment: "issue_comment",
  pull_request_review: "pull_request_review",
  workflow_run: "workflow_run",
  workflow_dispatch: "workflow_dispatch",
  release: "release",
  status: "status",
  deployment: "deployment",
  deployment_status: "deployment_status",
  deployment_review: "deployment_review",
  repository_dispatch: "repository_dispatch",
  audit: "audit",
};

async function deliverWebhooks(env: Env, ev: Exclude<DiffineryEvent, { type: "audit" }>): Promise<void> {
  const stub = repoStub(env, ev.repoId);
  const [all, row] = await Promise.all([stub.deliverableWebhooks(), new Directory(env).repoById(ev.repoId)]);
  const hooks = all.filter((h) => h.events.includes("*") || h.events.includes(GITHUB_EVENT[ev.type]));
  const payload = webhookPayload(env.PUBLIC_URL, ev, row);
  // Apps installed on the repository that subscribed to the event (apps/service.ts), each on its own.
  const apps = row ? deliverToApps(env, row, GITHUB_EVENT[ev.type], payload).catch((e) => console.error("app webhooks failed", ev.type, e)) : null;
  if (!hooks.length) return void (await apps);
  const body = JSON.stringify(payload);
  // Each hook retries on its own (deliverWebhook requeues it). Once a hook may have been sent to,
  // an error must not fail the stage, or the stage retry would send every hook again.
  const sent = await Promise.allSettled(hooks.map((h) => deliverWebhook(webhookDeps(env), { type: "webhook_retry", repoId: ev.repoId, hookId: h.id, event: GITHUB_EVENT[ev.type], diffineryEvent: ev.type, body, delivery: newId(), attempt: 0 }, h)));
  for (const r of sent) if (r.status === "rejected") console.error("webhook delivery bookkeeping failed", ev.type, r.reason);
  await apps;
}

/** Repository webhooks, and apps' webhooks (hook ids `app:<id>`) whose retries come back through the same queue. */
const webhookDeps = (env: Env): WebhookDeps => ({
  ownHost: new URL(env.PUBLIC_URL).hostname,
  local: localOnly(env),
  hook: async (repoId, hookId) => (hookId.startsWith(APP_HOOK_PREFIX) ? appHook(env, hookId) : ((await repoStub(env, repoId).deliverableWebhooks()).find((h) => h.id === hookId) ?? null)),
  record: (repoId, hookId, status) => (hookId.startsWith(APP_HOOK_PREFIX) ? appWebhookDeps(env).record(repoId, hookId, status) : repoStub(env, repoId).recordDelivery(hookId, status)),
  requeue: async (r, delaySeconds) => {
    await env.EVENTS.send(r as unknown as DiffineryEvent, { delaySeconds });
  },
});

async function handleEvent(env: Env, dir: Directory, ev: DiffineryEvent): Promise<void> {
  if (ev.type === "audit") {
    await dir.audit({ actorId: ev.actor.id, actorLogin: ev.actor.login, onBehalfOf: ev.actor.onBehalfOf, action: ev.action, target: ev.target, detail: ev.detail, at: ev.at });
    return;
  }
  // The Today view finds repositories by their latest activity (agentic/today.ts).
  await recordActivity(env, ev);
  if (ev.type === "push") {
    await dir.audit({ actorId: ev.actor.id, actorLogin: ev.actor.login, onBehalfOf: ev.actor.onBehalfOf, action: ev.forced ? "git.force_push" : ev.deleted ? "git.delete_ref" : "git.push", target: `${ev.owner}/${ev.repo}:${ev.ref}`, detail: { before: ev.before, after: ev.after }, at: ev.at });
  }
  if (ev.type === "pull_request" && ev.action === "merged") {
    await dir.audit({ actorId: ev.actor.id, actorLogin: ev.actor.login, onBehalfOf: ev.actor.onBehalfOf, action: "pull.merge", target: `${ev.owner}/${ev.repo}#${ev.number}`, at: ev.at });
  }
  // Agent code review (agentic/reviews.ts): opt-in per repository, best effort, never retried.
  await onReviewEvent(env, dir, ev).catch((e) => console.error("agent review event failed", e));
  // Agent tasks' Fix failing checks (agentic/tasks.ts): opt-in per task, best effort.
  await onVerifyEvent(env, ev).catch((e) => console.error("agent task verify failed", e));
  await runEventStages(env, dir, ev, ["webhooks", "notify"]);
}

type RepoEvent = Exclude<DiffineryEvent, { type: "audit" }>;

/** Webhooks and notifications run independently; a failed one is retried alone (see lib/stages.ts). */
function runEventStages(env: Env, dir: Directory, ev: RepoEvent, stages: Stage[], attempt = 0): Promise<void> {
  return runStages(
    ev,
    stages,
    (stage) => (stage === "webhooks" ? deliverWebhooks(env, ev) : notifyEvent(env, dir, ev)),
    async (r, delaySeconds) => {
      await env.EVENTS.send(r as unknown as DiffineryEvent, { delaySeconds });
    },
    attempt,
  );
}

export async function queue(batch: MessageBatch<DiffineryEvent | MailJob>, env: Env): Promise<void> {
  // Bounces and complaints from Cloudflare Email Sending's Event Subscriptions (mail/events.ts).
  if (batch.queue.startsWith("diffinery-mail-events")) return mailEventsQueue(batch as MessageBatch<unknown>, env);
  // Email has its own queue (diffinery-mail): its jobs can hold sign-in and invite links, so they stay out of the event archive.
  if (batch.queue.startsWith("diffinery-mail")) return mailQueue(batch as MessageBatch<MailJob>, env);
  return events(batch as MessageBatch<DiffineryEvent>, env);
}

async function events(batch: MessageBatch<DiffineryEvent>, env: Env): Promise<void> {
  const dir = new Directory(env);
  // Keep an append-only copy of every event in R2 for long-term audit retention.
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
  const fresh = batch.messages.filter((m) => !["webhook_retry", "stage_retry"].includes((m.body as { type: string }).type));
  if (fresh.length) await env.BUCKET.put(`events/${day}/${Date.now()}-${newId()}.jsonl`, fresh.map((m) => JSON.stringify(m.body)).join("\n")).catch((e) => console.error("event archive failed", e));
  for (const msg of batch.messages) {
    try {
      const body = msg.body as DiffineryEvent | WebhookRetry | StageRetry<RepoEvent>;
      if (body.type === "webhook_retry") await deliverWebhook(webhookDeps(env), body);
      else if (body.type === "stage_retry") await runEventStages(env, dir, body.event, [body.stage], body.attempt);
      else await handleEvent(env, dir, body);
      msg.ack();
    } catch (e) {
      console.error("event handling failed", msg.body.type, e);
      msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** msg.attempts) });
    }
  }
}

// ---------------------------------------------------------------- cron: housekeeping

export async function scheduled(controller: ScheduledController, env: Env, ctx?: ExecutionContext): Promise<void> {
  // Container registry housekeeping: abandoned uploads and bytes no image uses any more.
  const cleanup = new RegistryStore(env).cleanup().catch((e) => console.error("registry cleanup failed", e));
  if (ctx) ctx.waitUntil(cleanup);
  else await cleanup;
  const at = new Date(controller.scheduledTime);
  at.setUTCSeconds(0, 0);
  await Promise.all([
    // Workflow schedules fire from the scheduler's own alarm (src/scheduler.ts); this trigger only makes sure it is set.
    schedulerStub(env).ensure().catch((e) => console.error("scheduler alarm check failed", e)),
    // Token expiry reminders and email log pruning.
    mailCron(env, new Directory(env), at).catch((e) => console.error("mail cron failed", e)),
    // Audit log entries past their 2 years, and expired sessions, old notifications and compute
    // records (lib/retention.ts): a bounded batch each hour, which keeps up with a busy instance.
    (at.getUTCMinutes() < 5 ? pruneAuditLog(env.DB, at) : Promise.resolve(0)).catch((e) => console.error("audit log pruning failed", e)),
    (at.getUTCMinutes() < 5 ? pruneExpired(env.DB, at) : Promise.resolve(null)).catch((e) => console.error("retention pruning failed", e)),
    // Tell search engines about public pages a deploy added, changed or removed, and public repositories pushed since (web/indexnow.ts). Never throws.
    // Imported here: web/indexnow.ts reaches the docs, whose API reference imports this module.
    import("./web/indexnow.js").then((m) => m.indexNowCron(env, new Directory(env))).catch((e) => console.error("indexnow failed", e)),
    // CLI sign-ins a day past their expiry (auth/cli-login.ts).
    new CliLogins(env).prune().catch((e) => console.error("cli sign-in pruning failed", e)),
    // Spent OAuth codes, expired connected-app tokens, old connections and unused registrations (auth/oauth.ts).
    new OAuth(env).prune().catch((e) => console.error("oauth pruning failed", e)),
    // Installation tokens of apps a day past their expiry (apps/store.ts).
    new Apps(env).prune().catch((e) => console.error("app token pruning failed", e)),
    // Account exports past their 7 days (accounts/export.ts).
    expireExports(env).catch((e) => console.error("export expiry failed", e)),
    // Expire abandoned draft bulk imports after 7 days, and null their stored GitHub token (Low 5).
    env.DB.prepare("UPDATE imports SET status = 'cancelled', token_ciphertext = NULL, error = 'draft expired', finished_at = ?, updated_at = ? WHERE status = 'draft' AND created_at < ?")
      .bind(now(), now(), new Date(Date.now() - 7 * 86400_000).toISOString())
      .run()
      .catch((e) => console.error("draft import expiry failed", e)),
  ]);
}
