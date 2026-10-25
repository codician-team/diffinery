/**
 * Who hears about what. GitHub's rules, applied to Diffinery's events:
 *
 * - Participating: you opened the thread, commented or reviewed, are assigned
 *   or asked to review, were @mentioned, or subscribed by hand.
 * - Watching: "All activity" on a repository adds every new issue, pull
 *   request, comment, review and state change there.
 * - Ignoring a repository or muting a thread stops them (a direct @mention,
 *   assignment or review request in the same event still gets through a mute).
 * - Your own actions never notify you, unless you turn on "Include your own updates" for email.
 * - People you blocked never notify you, @mentions included (lib/moderation.ts).
 * - Workflow runs notify whoever triggered them (an agent's owner for agents;
 *   watchers for scheduled runs), for failures unless they ask for every run,
 *   and not while they ignore the repository.
 * - Security emails (sign-ins, passkeys, tokens, agents, push protection) can't be turned off.
 *
 * Every recipient must still be able to read the repository.
 */
import type { DiffineryEvent } from "@diffinery/shared";
import type { Env } from "../env.js";
import { repoStub } from "../http/common.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { sha256 } from "../lib/util.js";
import { blockersOf } from "../lib/moderation.js";
import { MailStore, type NotificationPrefs } from "./prefs.js";
import { digestCron } from "./digest.js";
import { enqueueMail } from "./send.js";
import type { JobInfo, RunInfo } from "../repo/actions.js";
import type { MailJob, Reason, ThreadData } from "./types.js";

type ThreadEvent = Extract<DiffineryEvent, { type: "pull_request" | "issues" | "issue_comment" | "pull_request_review" }>;

/** Logins @mentioned in Markdown, ignoring code. */
export function mentions(md: string | undefined | null): string[] {
  if (!md) return [];
  const text = md.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ").replace(/`[^`\n]*`/g, " ");
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w`/@.-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w@-]|\.\w)/g)) {
    out.add(m[1]!.toLowerCase());
    if (out.size >= 50) break;
  }
  return [...out];
}

/** Reasons in priority order: the first that applies is the one the email gives. */
const PRIORITY: Reason[] = ["review_requested", "assign", "mention", "author", "comment", "manual", "state_change", "subscribed"];
const DIRECT: Reason[] = ["review_requested", "assign", "mention"];

class Recipients {
  readonly map = new Map<string, Reason>();
  add(id: string | undefined | null, reason: Reason): void {
    if (!id) return;
    const cur = this.map.get(id);
    if (!cur || PRIORITY.indexOf(reason) < PRIORITY.indexOf(cur)) this.map.set(id, reason);
  }
}

async function accountsByLogin(dir: Directory, logins: string[]): Promise<Account[]> {
  return dir.accountsByLogins([...new Set(logins.map((x) => x.toLowerCase()))].slice(0, 60));
}

/** Recipients who may still read the repository, with their accounts. */
async function readable(dir: Directory, repo: Repo, ids: string[]): Promise<Account[]> {
  const first = ids.slice(0, 200);
  const byId = new Map((await dir.accountsByIds(first)).map((a) => [a.id, a]));
  const accounts = first.map((id) => byId.get(id)).filter((a): a is Account => !!a && a.kind !== "org" && a.status === "active");
  const readers = await dir.readersOf(repo, accounts);
  return accounts.filter((a) => readers.has(a.id));
}

async function threadEvent(env: Env, dir: Directory, ev: ThreadEvent): Promise<void> {
  if (ev.type === "pull_request" && (ev.action === "enqueued" || ev.action === "dequeued" || ev.action === "edited" || ev.action === "auto_merge_enabled" || ev.action === "auto_merge_disabled")) return;
  if (ev.type === "issues" && ev.action === "edited") return;
  const repo = await dir.repoById(ev.repoId);
  if (!repo) return;
  const stub = repoStub(env, ev.repoId);
  const { issue, comments, reviews } = await stub.issue(ev.number);
  const isPull = issue.kind === "pull";
  const threadUrl = `${env.PUBLIC_URL}/${ev.owner}/${ev.repo}/${isPull ? "pull" : "issues"}/${ev.number}`;
  const d: ThreadData = { repo: `${ev.owner}/${ev.repo}`, repoId: ev.repoId, number: ev.number, kind: issue.kind, title: issue.title, event: "opened", actor: ev.actor.login, url: threadUrl, base: issue.pull?.base, head: issue.pull?.head, intent: issue.pull?.intent ?? null, labels: issue.labels };
  const r = new Recipients();
  let text: string | undefined;
  let participantsOnly = false;

  if ((ev.type === "issues" || ev.type === "pull_request") && ev.action === "opened") {
    d.event = "opened";
    d.body = issue.body;
    d.assignees = issue.assignees;
    d.reviewers = issue.pull?.requestedReviewers;
    text = issue.body;
    for (const a of await accountsByLogin(dir, issue.assignees)) r.add(a.id, "assign");
    for (const a of await accountsByLogin(dir, issue.pull?.requestedReviewers ?? [])) r.add(a.id, "review_requested");
    if (isPull) d.commits = (await stub.pullCommits(ev.number).catch(() => [])).slice(-10).map((c) => ({ sha: c.sha, message: c.message }));
  } else if (ev.type === "issue_comment") {
    const cm = comments.find((c) => c.id === ev.commentId);
    if (!cm) return;
    d.event = "comment";
    d.body = cm.body;
    d.url = `${threadUrl}#c-${cm.id}`;
    text = cm.body;
  } else if (ev.type === "pull_request_review") {
    const rv = [...reviews].reverse().find((x) => x.author.id === ev.actor.id);
    d.event = "review";
    d.state = ev.state;
    const lineComments = rv ? comments.filter((c) => c.reviewId === rv.id) : [];
    d.body = [rv?.body ?? "", ...lineComments.slice(0, 20).map((c) => `**${c.path}${c.line ? `:${c.line}` : ""}**\n\n${c.body}`)].filter((x) => x.trim()).join("\n\n---\n\n");
    text = d.body;
  } else if (ev.action === "closed" || ev.action === "merged" || ev.action === "reopened") {
    if (ev.type === "pull_request" && ev.action === "closed" && issue.pull?.merged) return; // the "merged" event covers it
    d.event = ev.action;
    d.stateReason = issue.stateReason;
  } else if (ev.type === "pull_request" && ev.action === "synchronize") {
    d.event = "pushed";
    d.commits = (await stub.pullCommits(ev.number).catch(() => [])).slice(-10).map((c) => ({ sha: c.sha, message: c.message }));
    participantsOnly = true;
  } else if (ev.action === "assigned") {
    d.event = "assigned";
    d.assignees = ev.assignees ?? [];
    for (const a of await accountsByLogin(dir, d.assignees)) r.add(a.id, "assign");
    participantsOnly = true;
  } else if (ev.type === "pull_request" && ev.action === "review_requested") {
    d.event = "review_requested";
    d.reviewers = ev.reviewers ?? [];
    for (const a of await accountsByLogin(dir, d.reviewers)) r.add(a.id, "review_requested");
    participantsOnly = true;
  } else return;

  for (const a of await accountsByLogin(dir, mentions(text))) r.add(a.id, "mention");
  r.add(issue.author.id, "author");
  for (const c of comments) r.add(c.author.id, "comment");
  for (const rv of reviews) r.add(rv.author.id, "comment");
  // Assignees and requested reviewers take part in the thread from then on.
  if (d.event !== "assigned") for (const a of await accountsByLogin(dir, issue.assignees)) r.add(a.id, "assign");
  if (d.event !== "review_requested") for (const a of await accountsByLogin(dir, issue.pull?.requestedReviewers ?? [])) r.add(a.id, "review_requested");

  const store = new MailStore(env.DB);
  const [subs, watch] = await Promise.all([store.threadSubs(ev.repoId, ev.number), store.watchers(ev.repoId)]);
  for (const [id, on] of subs) if (on) r.add(id, "manual");
  // Assignments, review requests and pushes go to the people involved, not to every watcher.
  if (!participantsOnly) for (const id of watch.all) r.add(id, "subscribed");
  const direct = new Set([...(ev.type === "pull_request" && ev.action === "review_requested" ? d.reviewers ?? [] : []), ...(ev.action === "assigned" ? d.assignees ?? [] : []), ...mentions(text)].map((x) => x.toLowerCase()));

  // Whoever blocked the actor (or the person an agent acts for) hears nothing from them.
  const actorIds = [ev.actor.id, ev.actor.kind === "agent" && ev.actor.onBehalfOf ? (await dir.accountByLogin(ev.actor.onBehalfOf))?.id : null];
  const blockers = await blockersOf(env, actorIds);
  const candidates = [...r.map.keys()].filter((id) => !watch.ignore.has(id) && !blockers.has(id));
  const accounts = await readable(dir, repo, candidates);
  const prefs = await store.prefsFor(accounts.map((a) => a.id));
  const web = new Map<Reason, string[]>();
  const jobs: MailJob[] = [];
  for (const a of accounts) {
    let reason = r.map.get(a.id)!;
    if (subs.get(a.id) === false && !(DIRECT.includes(reason) && direct.has(a.login.toLowerCase()))) continue;
    const p = prefs.get(a.id)!;
    const own = a.id === ev.actor.id;
    if (own) reason = "your_activity";
    const group: keyof NotificationPrefs = reason === "subscribed" ? "watching" : "participating";
    if (!own && p[group].web) web.set(reason, [...(web.get(reason) ?? []), a.id]);
    if (a.kind === "user" && (!own || p.ownActivity)) jobs.push({ kind: "thread", data: d, to: { accountId: a.id }, reason, at: ev.at });
  }
  const verb: Record<ThreadData["event"], string> = { opened: "opened", comment: "commented on", review: "reviewed", closed: "closed", merged: "merged", reopened: "reopened", assigned: "assigned", review_requested: "requested review on", pushed: "pushed to" };
  const title = `${ev.actor.login} ${d.event === "review" ? `reviewed (${(ev as { state?: string }).state?.toLowerCase().replace(/_/g, " ")})` : verb[d.event]} ${d.repo}#${ev.number}: ${issue.title}`;
  const webIds = [...web.values()].flat();
  await Promise.all([webIds.length ? dir.notify(webIds.slice(0, 200), { repoId: ev.repoId, kind: ev.type, title, url: d.url }) : null, enqueueMail(env, jobs)]);
}

async function workflowRun(env: Env, dir: Directory, ev: Extract<DiffineryEvent, { type: "workflow_run" }>): Promise<void> {
  if (ev.action !== "completed") return;
  const failed = ev.conclusion === "failure" || ev.conclusion === "timed_out";
  if (!failed && ev.conclusion !== "success") return;
  const repo = await dir.repoById(ev.repoId);
  if (!repo) return;
  const store = new MailStore(env.DB);
  const watch = await store.watchers(ev.repoId);
  let ids: string[] = [];
  if (ev.actor.kind === "user") ids = [ev.actor.id];
  else if (ev.actor.kind === "agent" && ev.actor.onBehalfOf) {
    const owner = await dir.accountByLogin(ev.actor.onBehalfOf);
    if (owner?.kind === "user") ids = [owner.id];
  } else ids = watch.all;
  // Ignoring a repository silences its runs too, even the ones you started.
  const accounts = await readable(dir, repo, ids.filter((id) => !watch.ignore.has(id)));
  if (!accounts.length) return;
  const prefs = await store.prefsFor(accounts.map((a) => a.id));
  const url = `${env.PUBLIC_URL}/${ev.owner}/${ev.repo}/actions/runs/${ev.runId}`;
  const webIds = failed ? accounts.filter((a) => prefs.get(a.id)!.actions.web).map((a) => a.id) : [];
  const mailTo = accounts.filter((a) => a.kind === "user" && (failed || !prefs.get(a.id)!.actions.failuresOnly));
  let jobs: MailJob[] = [];
  if (mailTo.length) {
    // The RPC return type is too deep for TypeScript to instantiate; it is exactly getRun()'s.
    const run = (await (repoStub(env, ev.repoId).run as unknown as (id: string) => Promise<unknown>)(ev.runId)) as RunInfo & { jobs: JobInfo[] };
    const data = {
      repo: `${ev.owner}/${ev.repo}`,
      repoId: ev.repoId,
      runId: ev.runId,
      runNumber: run.number,
      workflow: run.workflowName,
      title: run.title,
      conclusion: ev.conclusion ?? "",
      event: run.event,
      branch: run.headBranch || run.ref.replace(/^refs\/(heads|tags)\//, ""),
      sha: run.headSha || run.sha,
      actor: run.actor.login,
      url,
      // What the email shows (mail/templates.ts): the first 20 jobs, each failure's first 160
      // characters. A large matrix with long failures would pass the queue's 128 KB per message.
      jobs: run.jobs.slice(0, 20).map((j) => ({ name: j.name, conclusion: j.conclusion, url: `${url}/job/${j.id}`, failure: j.failure?.message?.slice(0, 160) ?? null })),
    };
    jobs = mailTo.map((a) => ({ kind: "run" as const, data, to: { accountId: a.id }, reason: "ci_activity" as const, at: ev.at }));
  }
  await Promise.all([webIds.length ? dir.notify(webIds, { repoId: ev.repoId, kind: "run_failed", title: `Workflow run failed in ${ev.owner}/${ev.repo}`, url }) : null, enqueueMail(env, jobs)]);
}

/** Web notifications and emails for one event from the events queue. */
export async function notifyEvent(env: Env, dir: Directory, ev: DiffineryEvent): Promise<void> {
  if (ev.type === "workflow_run") return workflowRun(env, dir, ev);
  if (ev.type === "deployment_review" && ev.action === "requested") return deploymentReview(env, dir, ev);
  if (ev.type === "pull_request" || ev.type === "issues" || ev.type === "issue_comment" || ev.type === "pull_request_review") return threadEvent(env, dir, ev);
}

/**
 * A run's jobs wait on an environment's required reviewers: each reviewer who can still read the
 * repository gets a notification and an email (unless they turned Actions email off).
 */
async function deploymentReview(env: Env, dir: Directory, ev: Extract<DiffineryEvent, { payload: unknown }>): Promise<void> {
  const p = ev.payload as { environment?: string; workflow_run?: { id?: string; run_number?: number; name?: string; display_title?: string; head_sha?: string; head_branch?: string }; reviewers?: Array<{ reviewer?: { id?: string } }> };
  const repo = await dir.repoById(ev.repoId);
  const run = p.workflow_run;
  if (!repo || !run?.id || !p.environment) return;
  const ids = (p.reviewers ?? []).map((r) => r.reviewer?.id).filter((x): x is string => typeof x === "string" && x !== ev.actor.id);
  const accounts = (await readable(dir, repo, ids)).filter((a) => a.kind === "user");
  if (!accounts.length) return;
  const url = `${env.PUBLIC_URL}/${ev.owner}/${ev.repo}/actions/runs/${run.id}`;
  const prefs = await new MailStore(env.DB).prefsFor(accounts.map((a) => a.id));
  const data = { repo: `${ev.owner}/${ev.repo}`, environment: p.environment, workflow: run.name ?? "", runNumber: run.run_number ?? 0, title: run.display_title ?? "", branch: run.head_branch ?? "", sha: run.head_sha ?? "", requestor: ev.actor.login, url };
  await Promise.all([
    dir.notify(
      accounts.filter((a) => prefs.get(a.id)?.actions.web !== false).map((a) => a.id),
      { repoId: ev.repoId, kind: "deployment_review", title: `Deployment to ${p.environment} in ${ev.owner}/${ev.repo} is waiting for your review`, url },
    ),
    enqueueMail(env, accounts.map((a) => ({ kind: "deployment_review_requested" as const, data, to: { accountId: a.id }, reason: "review_requested" as const, at: ev.at }))),
  ]);
}

// ---------------------------------------------------------------- account and security emails

/** People who administer a repository: its owner (or the org's owners and admins) and admin collaborators. */
export async function repoAdmins(dir: Directory, repo: Repo): Promise<string[]> {
  const ids = new Set<string>();
  if (repo.owner_kind === "org") for (const m of await dir.orgMembers(repo.owner_id)) if (m.role === "owner" || m.role === "admin") ids.add(m.id);
  if (repo.owner_kind === "user") ids.add(repo.owner_id);
  for (const c of await dir.collaborators(repo.id)) if (c.role === "admin" && c.account.kind === "user") ids.add(c.account.id);
  return [...ids];
}

/** The people an account's security emails go to: the person, or an agent's owner (or its org's owners). */
export async function humansFor(dir: Directory, accountId: string | undefined | null): Promise<string[]> {
  if (!accountId) return [];
  const a = await dir.account(accountId);
  if (!a) return [];
  if (a.kind === "user") return [a.id];
  if (a.kind === "agent" && a.owner_id) {
    const o = await dir.account(a.owner_id);
    if (o?.kind === "user") return [o.id];
    if (o?.kind === "org") return (await dir.orgMembers(o.id)).filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.id);
  }
  return [];
}

export interface AuditEntry {
  actorId?: string;
  actorLogin?: string;
  action: string;
  target?: string;
  detail?: unknown;
  at?: string;
}

/** A sign-in device: the passkey (when there is one) plus the browser and OS. */
export async function deviceFingerprint(device: string, passkeyId?: string | null): Promise<string> {
  return (await sha256(`${passkeyId ?? "-"}|${device}`)).slice(0, 32);
}

/** Security emails for audited actions. Called for every audit entry; ignores the rest. */
export async function mailForAudit(env: Env, dir: Directory, e: AuditEntry): Promise<void> {
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  const at = e.at ?? new Date().toISOString();
  const to = (ids: string[], body: Omit<MailJob, "to" | "at" | "reason">, reason: Reason = "security_alert") => ids.map((id) => ({ ...body, to: { accountId: id }, reason, at }) as MailJob);
  const store = new MailStore(env.DB);
  let jobs: MailJob[] = [];
  switch (e.action) {
    case "session.create": {
      if (!e.actorId) return;
      const device = s("device") ?? "an unknown browser";
      const method = (s("method") ?? "passkey") as "passkey" | "access" | "link";
      const fresh = await store.seeDevice(e.actorId, await deviceFingerprint(device, s("passkeyId")), device);
      if (!fresh && method === "passkey") return;
      jobs = to([e.actorId], { kind: "signin_new", data: { method, device, ip: s("ip"), location: s("location"), passkey: s("passkey") } });
      break;
    }
    case "passkey.add":
      if (!e.actorId) return;
      if (s("device")) await store.seeDevice(e.actorId, await deviceFingerprint(s("device")!, s("passkeyId")), s("device")!);
      jobs = to([e.actorId], { kind: "passkey_added", data: { name: s("name") ?? "passkey", via: s("via") === "signin-link" ? "signin-link" : "settings" } });
      break;
    case "passkey.remove":
      if (!e.actorId) return;
      jobs = to([e.actorId], { kind: "passkey_removed", data: { name: s("name") ?? "passkey" } });
      break;
    case "agent.create":
      if (!e.actorId || !e.target) return;
      jobs = to([e.actorId], { kind: "agent_created", data: { agent: e.target } });
      break;
    case "push.secret_bypassed":
    case "api.secret_bypassed":
    case "push.blocked_secret":
    case "api.blocked_secret": {
      const [owner, name] = (e.target ?? "").split(":")[0]!.split("/");
      if (!owner || !name) return;
      const repo = await dir.repo(owner, name);
      if (!repo) return;
      const kinds = Array.isArray(d.kinds) ? [...new Set(d.kinds as string[])] : [];
      const refs = Array.isArray(d.refs) ? (d.refs as string[]) : undefined;
      const pusher = await humansFor(dir, e.actorId);
      // A commit made without git (web editor, API, MCP) names the files instead of refs.
      const paths = Array.isArray(d.paths) ? (d.paths as string[]) : [];
      if (e.action === "push.blocked_secret") jobs = to(pusher, { kind: "push_blocked", data: { repo: `${owner}/${name}`, kinds, refs } });
      else if (e.action === "api.blocked_secret") jobs = to(pusher, { kind: "push_blocked", data: { repo: `${owner}/${name}`, kinds, paths } });
      else jobs = to([...new Set([...pusher, ...(await repoAdmins(dir, repo))])], { kind: "push_bypassed", data: { repo: `${owner}/${name}`, pusher: e.actorLogin ?? "someone", kinds, reason: s("reason") ?? "", refs } });
      break;
    }
    case "invite.accept":
    case "signup":
      // A new account made from an invite or open sign-up (with a passkey) gets a welcome email.
      if (e.actorId && s("method") === "passkey") {
        if (s("device")) await store.seeDevice(e.actorId, await deviceFingerprint(s("device")!, s("passkeyId")), s("device")!);
        jobs = to([e.actorId], { kind: "welcome", data: { login: e.actorLogin ?? "" } }, "account");
      }
      break;
    case "repo.delete": {
      const [owner, name] = (e.target ?? "").split("/");
      const ownerAcc = owner ? await dir.accountByLogin(owner) : null;
      if (!ownerAcc || !name) return;
      // The person who deleted it already knows.
      const ids = (ownerAcc.kind === "org" ? (await dir.orgMembers(ownerAcc.id)).filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.id) : [ownerAcc.id]).filter((id) => id !== e.actorId);
      jobs = to(ids, { kind: "repo_deleted", data: { repo: `${owner}/${name}`, actor: e.actorLogin ?? "someone" } }, "admin");
      break;
    }
    case "repo.transfer": {
      // The admins of both owners: the old one's lose the repository, the new one's gain it.
      const from = s("from");
      const dest = s("to");
      if (!from || !dest) return;
      const admins = async (login: string) => {
        const acc = await dir.accountByLogin(login);
        if (!acc) return [];
        return acc.kind === "org" ? (await dir.orgMembers(acc.id)).filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.id) : acc.kind === "user" ? [acc.id] : [];
      };
      const ids = [...new Set([...(await admins(from.split("/")[0]!)), ...(await admins(dest.split("/")[0]!))])].filter((id) => id !== e.actorId);
      jobs = to(ids, { kind: "repo_transferred", data: { from, to: dest, actor: e.actorLogin ?? "someone" } }, "admin");
      break;
    }
    default:
      return;
  }
  await enqueueMail(env, jobs);
}

/** A token was created for a person or an agent (from the web, the API or the CLI). */
export async function tokenCreated(env: Env, dir: Directory, account: Account, t: { name: string; scopes: string[] }): Promise<void> {
  const at = new Date().toISOString();
  const ids = await humansFor(dir, account.id);
  await enqueueMail(env, ids.map((id) => ({ kind: "token_created" as const, data: { name: t.name, scopes: t.scopes, agent: account.kind === "agent" ? account.login : undefined }, to: { accountId: id }, reason: "security_alert" as const, at })));
}

/** A repository was created: tell its creator (unless a script did it with a token) and the org's other owners and admins; the creator watches it. */
export async function repoCreated(env: Env, dir: Directory, repo: Repo, creator: Account, opts: { viaToken: boolean }): Promise<void> {
  const store = new MailStore(env.DB);
  const human = creator.kind === "user";
  if (human && (await store.prefs(creator.id)).autoWatch) await store.setWatch(creator.id, repo.id, "all");
  const data = { repo: `${repo.owner_login}/${repo.name}`, creator: creator.login, visibility: repo.visibility, defaultBranch: repo.default_branch, description: repo.description };
  const at = new Date().toISOString();
  const jobs: MailJob[] = [];
  if (human && !opts.viaToken) jobs.push({ kind: "repo_created", data, to: { accountId: creator.id }, reason: "your_activity", at });
  if (repo.owner_kind === "org") {
    for (const m of await dir.orgMembers(repo.owner_id)) {
      if ((m.role === "owner" || m.role === "admin") && m.id !== creator.id && m.id !== creator.owner_id) jobs.push({ kind: "repo_created", data, to: { accountId: m.id }, reason: "admin", at });
    }
  }
  await enqueueMail(env, jobs);
}

/** Jobs from the five-minute cron trigger: token expiry reminders, morning digests that are due, and log pruning. */
export async function mailCron(env: Env, dir: Directory, at: Date): Promise<void> {
  const store = new MailStore(env.DB);
  const now = at.toISOString();
  const soon = new Date(at.getTime() + 7 * 86400_000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, account_id, name, prefix, expires_at FROM tokens WHERE revoked_at IS NULL AND expiry_notified_at IS NULL AND expires_at > ? AND expires_at <= ? AND julianday(expires_at) - julianday(created_at) > 8 LIMIT 50",
  )
    .bind(now, soon)
    .all<{ id: string; account_id: string; name: string; prefix: string; expires_at: string }>();
  const jobs: MailJob[] = [];
  for (const t of results) {
    const a = await dir.account(t.account_id);
    if (a && a.status === "active") {
      const ids = await humansFor(dir, a.id);
      for (const id of ids) jobs.push({ kind: "token_expiring", data: { name: t.name, prefix: t.prefix, expiresAt: t.expires_at, agent: a.kind === "agent" ? a.login : undefined }, to: { accountId: id }, reason: "security_alert", at: now });
    }
    await env.DB.prepare("UPDATE tokens SET expiry_notified_at = ? WHERE id = ?").bind(now, t.id).run();
  }
  await enqueueMail(env, jobs);
  await digestCron(env.DB, at, (ids) => store.prefsFor(ids), (digests) => enqueueMail(env, digests));
  if (at.getUTCHours() === 3 && at.getUTCMinutes() < 5) await store.prune();
}
