import type { DiffineryEvent } from "@diffinery/shared";
import type { AppContext } from "../auth/principal.js";
import type { Env } from "../env.js";
import type { loadRepo } from "../http/common.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { HttpError, now } from "../lib/util.js";
import { atLeast } from "../repo/types.js";
import { taskCaller, TaskAccessError } from "./access.js";
import { ModelKeys, PROVIDERS, type Provider } from "./keys.js";
import type { FindingRow } from "./ProjectDO.js";
import { asksForReview, REPO_DAILY_DEFAULT, REPO_DAILY_MAX, REVIEW_TOKENS_DEFAULT, REVIEW_TOKENS_MAX, REVIEW_TOKENS_MIN, REVIEW_APP, REVIEW_CHECK, REVIEW_CREATOR, TRIGGERS, AUTHORS, type ReviewAuthors, type ReviewSettings, type ReviewTrigger } from "./review.js";
import { isRuntime, MAX_COMMAND, RUNTIMES, runtimeNeeds, type RuntimeId } from "./runtimes.js";
import { modelRoute, projectStub, requirePersonSession } from "./tasks.js";
import { payerFor, reviewRefusal, type Payer } from "./org-policy.js";

/**
 * Agent code review in the Worker: who may turn it on, who may ask for a
 * review, and which pull request events start one (agentic/review.ts has the
 * rest; ProjectDO runs the reviews).
 *
 * - Settings: a repository admin, in a browser session, who can drive the
 *   agent and has the runtime's key. They opt in to every review on the
 *   repository spending their key.
 * - Asking for a review: people with write access (never agents), with the
 *   button, the REST API, a `@agent review` comment, or by requesting the
 *   agent as a reviewer.
 * - Automatic reviews follow the settings: on every push, once, or never.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

export const reviewSettings = (env: Env, repoId: string) => projectStub(env, repoId).reviewSettings();

export interface SettingsInput {
  enabled?: unknown;
  agent?: unknown;
  runtime?: unknown;
  command?: unknown;
  provider?: unknown;
  model?: unknown;
  trigger?: unknown;
  drafts?: unknown;
  authors?: unknown;
  autofix?: unknown;
  daily_limit?: unknown;
  tokens_per_review?: unknown;
  accept?: unknown;
}

const isTrigger = (v: unknown): v is ReviewTrigger => typeof v === "string" && v in TRIGGERS;
const isAuthors = (v: unknown): v is ReviewAuthors => typeof v === "string" && v in AUTHORS;

/** Turn reviews on (or change them) as the signed-in admin, who becomes the one whose key reviews spend. */
export async function saveReviewSettings(c: AppContext, l: Loaded, input: SettingsInput): Promise<ReviewSettings | null> {
  const me = requirePersonSession(c);
  if (!atLeast(l.caller.role, "admin")) throw new HttpError(403, "only repository admins can change agent review");
  const stub = projectStub(c.env, l.repo.id);
  if (input.enabled === false) {
    const current = await stub.reviewSettings();
    if (current) await stub.setReviewSettings({ ...current, enabled: false, updatedAt: now() });
    return current ? { ...current, enabled: false } : null;
  }
  const refused = await reviewRefusal(c.env, l.repo);
  if (refused) throw new HttpError(403, refused);
  const runtime = typeof input.runtime === "string" ? input.runtime : "claude-code";
  if (!isRuntime(runtime)) throw new HttpError(422, "`runtime` must be claude-code, codex or custom");
  const command = runtime === "custom" ? (typeof input.command === "string" ? input.command.trim() : "") : null;
  if (runtime === "custom" && !command) throw new HttpError(422, "`command` is required for the custom runtime");
  if (command && command.length > MAX_COMMAND) throw new HttpError(422, `\`command\` is longer than ${MAX_COMMAND} characters`);
  const trigger = input.trigger === undefined ? "push" : input.trigger;
  if (!isTrigger(trigger)) throw new HttpError(422, "`trigger` must be push, open or request");
  const authors = input.authors === undefined ? "all" : input.authors;
  if (!isAuthors(authors)) throw new HttpError(422, "`authors` must be all, people or agents");
  const agentLogin = typeof input.agent === "string" ? input.agent.trim() : "";
  const agent = agentLogin ? await c.get("dir").accountByLogin(agentLogin) : null;
  if (!agent || agent.kind !== "agent") throw new HttpError(422, "`agent` must be the login of one of your agents");
  try {
    await taskCaller(c.get("dir"), me, agent, l.repo);
  } catch (e) {
    if (e instanceof TaskAccessError) throw new HttpError(403, e.message);
    throw e;
  }
  const route = modelRoute(runtime, input.provider, input.model);
  await payerFor(c.env, c.get("dir"), l.repo, me, runtime, route.via);
  const dailyLimit = input.daily_limit === undefined || input.daily_limit === "" ? REPO_DAILY_DEFAULT : Number(input.daily_limit);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > REPO_DAILY_MAX) throw new HttpError(422, `\`daily_limit\` must be a whole number from 1 to ${REPO_DAILY_MAX}`);
  const tokensPerReview = input.tokens_per_review === undefined || input.tokens_per_review === "" ? REVIEW_TOKENS_DEFAULT : Number(input.tokens_per_review);
  if (!Number.isInteger(tokensPerReview) || tokensPerReview < REVIEW_TOKENS_MIN || tokensPerReview > REVIEW_TOKENS_MAX) throw new HttpError(422, `\`tokens_per_review\` must be a whole number from ${REVIEW_TOKENS_MIN} to ${REVIEW_TOKENS_MAX}`);
  if (input.accept !== true) throw new HttpError(422, "confirm that every agent review on this repository, including ones other people ask for, uses your model key");
  const at = now();
  const settings: ReviewSettings = {
    enabled: true,
    agent: { id: agent.id, login: agent.login },
    person: { id: me.id, login: me.login },
    runtime,
    command,
    via: route.via,
    model: route.model,
    trigger,
    drafts: input.drafts === true,
    authors,
    autofix: input.autofix === true,
    dailyLimit,
    tokensPerReview,
    optedInAt: at,
    updatedAt: at,
  };
  await stub.setReviewSettings(settings);
  return settings;
}

export type ReviewOutcome = { status: "started" | "queued" | "skipped" | "limited"; task?: number; reason?: string };

/** Review `pr` now (or after its current review), as the repository's settings say. */
export async function startReview(env: Env, dir: Directory, repo: Repo, pr: number, requestedBy: Account | null): Promise<ReviewOutcome> {
  const settings = await reviewSettings(env, repo.id);
  if (!settings?.enabled) return { status: "skipped", reason: "agent review isn't turned on for this repository" };
  const stub = env.REPO.get(env.REPO.idFromName(repo.id));
  const { issue } = await stub.issue(pr);
  if (!issue.pull) return { status: "skipped", reason: `#${pr} is an issue, not a pull request` };
  if (issue.state !== "open") return { status: "skipped", reason: `#${pr} is closed` };
  const head = issue.pull.headSha;
  const blocked = async (reason: string): Promise<ReviewOutcome> => {
    await stub
      .upsertCheck({ sha: head, name: REVIEW_CHECK, status: "completed", conclusion: "action_required", output: { title: "Agent review couldn't run", summary: reason }, app: REVIEW_APP, creator: { ...REVIEW_CREATOR } })
      .catch((e) => console.error("agent review check failed", e));
    return { status: "skipped", reason };
  };
  // The person whose key reviews spend, re-checked every time: still allowed, key still there.
  const [person, agent] = await Promise.all([dir.account(settings.person.id), dir.account(settings.agent.id)]);
  if (!person || !agent) return blocked(`the agent or the person whose key agent review uses no longer exists; an admin can set agent review up again`);
  try {
    await taskCaller(dir, person, agent, repo);
  } catch (e) {
    if (e instanceof TaskAccessError) return blocked(`${settings.person.login} can no longer run reviews as ${settings.agent.login} (${e.message}); an admin can set agent review up again`);
    throw e;
  }
  // The organization's policy (phase 5b): reviews allowed, and whose key pays, decided now for this review.
  const refused = await reviewRefusal(env, repo);
  if (refused) return blocked(refused);
  let payer: Payer;
  try {
    payer = await payerFor(env, dir, repo, person, settings.runtime, settings.via ?? null);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return blocked(e.status === 422 && e.detail.includes("Settings → Model access") ? `${settings.person.login}'s ${runtimeNeeds(settings.runtime, settings.via ?? null).map((p) => PROVIDERS[p].name).join(" and ")} API key is gone; they can add it in Settings → Model access` : `${e.detail}; an admin can set agent review up again`);
  }
  const r = await projectStub(env, repo.id).requestReview({ repoId: repo.id, pr, head: issue.pull.head, base: issue.pull.base, headSha: head, settings, providers: payer.providers, keyOwner: payer.keyOwner, requestedBy: requestedBy?.login ?? null });
  return { status: r.status, task: r.task, ...(r.status === "skipped" ? { reason: "this head was already reviewed" } : r.reason ? { reason: r.reason } : {}) };
}

/** A person with write access asks for a review (button, REST). */
export async function askForReview(c: AppContext, l: Loaded, pr: number): Promise<ReviewOutcome> {
  if (l.caller.kind !== "user" || !atLeast(l.caller.role, "write")) throw new HttpError(403, "only people with write access can ask for an agent review");
  const p = c.get("principal");
  const me = p.type === "account" ? p.account : null;
  if (!me || me.kind !== "user") throw new HttpError(403, "only people can ask for an agent review");
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  const settings = await reviewSettings(c.env, l.repo.id);
  if (!settings?.enabled) throw new HttpError(422, "agent review isn't turned on for this repository: an admin can turn it on under Settings → Agent review");
  const out = await startReview(c.env, c.get("dir"), l.repo, pr, me);
  if (out.status === "limited") throw new HttpError(429, out.reason ?? "a daily review limit was reached");
  if (out.status === "skipped") throw new HttpError(422, out.reason ?? "the review couldn't start");
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "review.request", target: `${l.repo.owner_login}/${l.repo.name}#${pr}` }));
  return out;
}

/**
 * Pull request events that may start a review (called from the event queue;
 * best effort: an error is logged, never retried).
 */
export async function onReviewEvent(env: Env, dir: Directory, ev: DiffineryEvent): Promise<void> {
  if (ev.type !== "pull_request" && ev.type !== "issue_comment") return;
  const settings = await reviewSettings(env, ev.repoId);
  if (!settings?.enabled) return;
  const repo = await dir.repoById(ev.repoId);
  if (!repo || repo.archived) return;
  // A person with write access asked: by requesting the agent as a reviewer, or with `@agent review`.
  const asker = async (actorId: string): Promise<Account | null> => {
    const a = await dir.account(actorId);
    if (!a || a.kind !== "user" || a.status !== "active") return null;
    return atLeast(await dir.roleFor(a, repo), "write") ? a : null;
  };
  if (ev.type === "issue_comment") {
    if (ev.action !== "created") return;
    const { issue, comments } = await env.REPO.get(env.REPO.idFromName(repo.id)).issue(ev.number);
    const comment = comments.find((c) => c.id === ev.commentId);
    if (!issue.pull || !comment || !asksForReview(comment.body, settings.agent.login)) return;
    const who = await asker(ev.actor.id);
    if (who) await startReview(env, dir, repo, ev.number, who);
    return;
  }
  if (ev.action === "review_requested") {
    if (!(ev.reviewers ?? []).some((r) => r.toLowerCase() === settings.agent.login.toLowerCase())) return;
    const who = await asker(ev.actor.id);
    if (who) await startReview(env, dir, repo, ev.number, who);
    return;
  }
  const on = settings.trigger === "push" ? ["opened", "reopened", "ready_for_review", "synchronize"] : settings.trigger === "open" ? ["opened", "ready_for_review"] : [];
  if (!on.includes(ev.action)) return;
  const { issue } = await env.REPO.get(env.REPO.idFromName(repo.id)).issue(ev.number);
  if (!issue.pull || issue.state !== "open") return;
  if (issue.pull.draft && !settings.drafts) return;
  const byAgent = issue.author.kind === "agent";
  if ((settings.authors === "people" && byAgent) || (settings.authors === "agents" && !byAgent)) return;
  // Never automatically on someone without write access: a person with write access asks instead, like approving a run.
  const author = await dir.account(issue.author.id);
  if (!author || author.status !== "active" || !atLeast(await dir.roleFor(author, repo), "write")) {
    await env.REPO.get(env.REPO.idFromName(repo.id))
      .upsertCheck({ sha: issue.pull.headSha, name: REVIEW_CHECK, status: "completed", conclusion: "action_required", output: { title: "Waiting for a request", summary: `${issue.author.login} doesn't have write access, so this pull request isn't reviewed automatically. Someone with write access can ask for a review.` }, app: REVIEW_APP, creator: { ...REVIEW_CREATOR } })
      .catch((e) => console.error("agent review check failed", e));
    return;
  }
  // "Once": a pull request that already has a review isn't reviewed again unless someone asks.
  if (settings.trigger === "open" && (await projectStub(env, repo.id).reviewTask(ev.number))?.reviewed_sha) return;
  await startReview(env, dir, repo, ev.number, null);
}

// ---------------------------------------------------------------- JSON

export const reviewSettingsJson = (s: ReviewSettings | null) =>
  s
    ? {
        enabled: s.enabled,
        agent: { login: s.agent.login, type: "Bot" },
        uses_key_of: { login: s.person.login, type: "User" },
        runtime: s.runtime,
        ...(s.command ? { command: s.command } : {}),
        provider: s.via ?? RUNTIMES[s.runtime].needs[0] ?? null,
        model: s.model ?? null,
        trigger: s.trigger,
        drafts: s.drafts,
        authors: s.authors,
        autofix: s.autofix,
        daily_limit: s.dailyLimit ?? REPO_DAILY_DEFAULT,
        tokens_per_review: s.tokensPerReview ?? REVIEW_TOKENS_DEFAULT,
        opted_in_at: s.optedInAt,
        updated_at: s.updatedAt,
      }
    : { enabled: false };

export const findingJson = (base: string, repoFull: string, f: FindingRow) => ({
  id: `F${f.n}`,
  path: f.path,
  line: f.line,
  side: f.side,
  severity: f.severity,
  title: f.title,
  body: f.body,
  suggestion: f.suggestion,
  state: f.state,
  fixed_in: f.fixed_sha,
  comment_id: f.comment_id,
  task_url: `${base}/${repoFull}/tasks/${f.task}`,
  created_at: f.created_at,
});

