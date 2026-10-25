import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import type { Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import type { IssueEvent, Reaction } from "../repo/social.js";
import { baseOf, ghComment, ghIssue, ghLabel, ghReview, ghReviewComment, ghUser, isoSeconds, nodeId, pageOf, paginate, repoApi, setLinks, type IssueCtx } from "./gh.js";
import { intParam, issueCtx, jsonBody, loadTarget, pullsOut, repoParams, type Stub } from "./ghctx.js";
import { hiddenAuthors } from "./common.js";

/**
 * Issue and pull request sub-resources bots and workflows use: labels and
 * assignees on one issue, single and repository-wide comments, locking,
 * reactions, events and timelines, review comment replies, dismissing reviews,
 * removing requested reviewers and updating a pull request's branch.
 */
export const issues = new Hono<{ Bindings: Env; Variables: AppVars }>();

const R = "/repos/:owner/:repo";
const load = (c: AppContext, min: "read" | "triage" | "write" = "read") => loadTarget(c, min);
const labelJson = (c: AppContext, repo: Repo, l: { id?: number; name: string; color?: string; description?: string }) => ghLabel(baseOf(c), repo.owner_login, repo.name, l);
const names = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { labels?: unknown }).labels) ? (v as { labels: unknown[] }).labels : null;
  if (!list) throw new HttpError(422, "labels must be an array of names", { errors: [{ resource: "Label", code: "invalid", field: "labels" }] });
  return list.map((l) => (typeof l === "string" ? l : String((l as { name?: unknown })?.name ?? ""))).filter(Boolean);
};

// ---------------------------------------------------------------- labels

issues.get(`${R}/labels/:name`, async (c) => {
  const { stub, repo } = await load(c);
  return c.json(labelJson(c, repo, await stub.label(c.req.param("name"))));
});
issues.patch(`${R}/labels/:name`, async (c) => {
  const { stub, caller, repo } = await load(c, "triage");
  const b = await jsonBody<{ new_name?: string; color?: string; description?: string }>(c);
  return c.json(labelJson(c, repo, await stub.updateLabel(c.req.param("name"), b, caller)));
});
issues.delete(`${R}/labels/:name`, async (c) => {
  const { stub, caller } = await load(c, "triage");
  await stub.deleteLabel(c.req.param("name"), caller);
  return c.body(null, 204);
});

issues.get(`${R}/issues/:number/labels`, async (c) => {
  const { stub, repo } = await load(c);
  return c.json(paginate(c, (await stub.issueLabels(intParam(c, "number"))).map((l) => labelJson(c, repo, l))));
});
issues.post(`${R}/issues/:number/labels`, async (c) => {
  const { stub, caller, repo } = await load(c, "triage");
  const list = await stub.addIssueLabels(intParam(c, "number"), names(await jsonBody(c)), caller);
  return c.json(list.map((l) => labelJson(c, repo, l)));
});
issues.put(`${R}/issues/:number/labels`, async (c) => {
  const { stub, caller, repo } = await load(c, "triage");
  const list = await stub.setIssueLabels(intParam(c, "number"), names(await jsonBody(c, true)), caller);
  return c.json(list.map((l) => labelJson(c, repo, l)));
});
issues.delete(`${R}/issues/:number/labels`, async (c) => {
  const { stub, caller } = await load(c, "triage");
  await stub.setIssueLabels(intParam(c, "number"), [], caller);
  return c.body(null, 204);
});
issues.delete(`${R}/issues/:number/labels/:name`, async (c) => {
  const { stub, caller, repo } = await load(c, "triage");
  const list = await stub.removeIssueLabel(intParam(c, "number"), c.req.param("name"), caller);
  return c.json(list.map((l) => labelJson(c, repo, l)));
});

// ---------------------------------------------------------------- assignees and locking

const oneIssue = async (c: AppContext, repo: Repo, stub: Stub, n: number) => {
  const { issue } = await stub.issue(n);
  return ghIssue(await issueCtx(c, repo, stub, [issue]), issue);
};

issues.post(`${R}/issues/:number/assignees`, async (c) => {
  const { stub, caller, repo } = await load(c, "triage");
  const n = intParam(c, "number");
  const b = await jsonBody<{ assignees?: unknown }>(c);
  await stub.assignIssue(n, Array.isArray(b.assignees) ? b.assignees.map(String) : [], true, caller);
  return c.json(await oneIssue(c, repo, stub, n), 201);
});
issues.delete(`${R}/issues/:number/assignees`, async (c) => {
  const { stub, caller, repo } = await load(c, "triage");
  const n = intParam(c, "number");
  const b = await jsonBody<{ assignees?: unknown }>(c, true);
  await stub.assignIssue(n, Array.isArray(b.assignees) ? b.assignees.map(String) : [], false, caller);
  return c.json(await oneIssue(c, repo, stub, n));
});
issues.get(`${R}/assignees`, async (c) => {
  const { repo } = await load(c);
  const people = (await c.get("dir").collaborators(repo.id)).filter((x) => x.role !== "read").map((x) => ghUser(baseOf(c), x.account));
  const owner = ghUser(baseOf(c), { id: repo.owner_id, login: repo.owner_login, kind: repo.owner_kind });
  return c.json(paginate(c, repo.owner_kind === "org" || people.some((p) => p?.login === owner?.login) ? people : [owner, ...people]));
});
issues.get(`${R}/assignees/:login`, async (c) => {
  const { repo } = await load(c);
  const login = c.req.param("login").toLowerCase();
  if (login === repo.owner_login.toLowerCase()) return c.body(null, 204);
  const ok = (await c.get("dir").collaborators(repo.id)).some((x) => x.account.login.toLowerCase() === login && x.role !== "read");
  if (!ok) throw new HttpError(404, "Not Found");
  return c.body(null, 204);
});

issues.put(`${R}/issues/:number/lock`, async (c) => {
  const { stub, caller } = await load(c, "triage");
  const b = await jsonBody<{ lock_reason?: string }>(c, true);
  await stub.lockIssue(intParam(c, "number"), b.lock_reason ?? null, caller);
  return c.body(null, 204);
});
issues.delete(`${R}/issues/:number/lock`, async (c) => {
  const { stub, caller } = await load(c, "triage");
  await stub.unlockIssue(intParam(c, "number"), caller);
  return c.body(null, 204);
});

// ---------------------------------------------------------------- comments (repository-wide and single)

issues.get(`${R}/issues/comments`, async (c) => {
  const { stub, repo } = await load(c);
  const p = pageOf(c);
  const res = await stub.repoComments({ review: false, since: c.req.query("since"), sort: c.req.query("sort"), direction: c.req.query("direction"), limit: p.perPage, offset: p.offset, hide: await hiddenAuthors(c) });
  setLinks(c, p, res.total);
  const x = await issueCtx(c, repo, stub, [], res.items.map((i) => `comment:${i.comment.id}`));
  return c.json(res.items.map((i) => ghComment(x, i.number, i.isPull, i.comment)));
});
issues.get(`${R}/issues/comments/:id`, async (c) => {
  const { stub, repo } = await load(c);
  const found = await stub.comment(c.req.param("id"), false, await hiddenAuthors(c));
  return c.json(ghComment(await issueCtx(c, repo, stub, [], [`comment:${found.comment.id}`]), found.number, found.isPull, found.comment));
});
issues.delete(`${R}/issues/comments/:id`, async (c) => {
  const { stub, caller } = await load(c);
  await stub.deleteComment(c.req.param("id"), false, caller);
  return c.body(null, 204);
});

// ---------------------------------------------------------------- pull request review comments

issues.get(`${R}/pulls/comments`, async (c) => {
  const { stub, repo } = await load(c);
  const p = pageOf(c);
  const res = await stub.repoComments({ review: true, since: c.req.query("since"), sort: c.req.query("sort"), direction: c.req.query("direction"), limit: p.perPage, offset: p.offset, hide: await hiddenAuthors(c) });
  setLinks(c, p, res.total);
  const x = await issueCtx(c, repo, stub, [], res.items.map((i) => `review_comment:${i.comment.id}`));
  return c.json(res.items.map((i) => ghReviewComment(x, i.number, i.comment)));
});
issues.get(`${R}/pulls/comments/:id`, async (c) => {
  const { stub, repo } = await load(c);
  const found = await stub.comment(c.req.param("id"), true, await hiddenAuthors(c));
  return c.json(ghReviewComment(await issueCtx(c, repo, stub, [], [`review_comment:${found.comment.id}`]), found.number, found.comment));
});
issues.patch(`${R}/pulls/comments/:id`, async (c) => {
  const { stub, caller, repo } = await load(c);
  const b = await jsonBody<{ body?: string }>(c);
  if (typeof b.body !== "string" || !b.body.trim()) throw new HttpError(422, "body is required", { errors: [{ resource: "PullRequestReviewComment", code: "missing_field", field: "body" }] });
  await stub.comment(c.req.param("id"), true);
  await stub.editComment(c.req.param("id"), b.body, caller);
  const found = await stub.comment(c.req.param("id"), true);
  return c.json(ghReviewComment(await issueCtx(c, repo, stub, []), found.number, found.comment));
});
issues.delete(`${R}/pulls/comments/:id`, async (c) => {
  const { stub, caller } = await load(c);
  await stub.deleteComment(c.req.param("id"), true, caller);
  return c.body(null, 204);
});
issues.post(`${R}/pulls/:number/comments`, async (c) => {
  const { stub, caller, repo } = await load(c);
  const n = intParam(c, "number");
  const b = await jsonBody<{ body?: string; commit_id?: string; path?: string; line?: number; position?: number; side?: "LEFT" | "RIGHT"; in_reply_to?: string | number }>(c);
  const cm = await stub.createReviewComment(n, { ...b, in_reply_to: b.in_reply_to === undefined ? undefined : String(b.in_reply_to) }, caller);
  return c.json(ghReviewComment(await issueCtx(c, repo, stub, []), n, cm), 201);
});
issues.post(`${R}/pulls/:number/comments/:id/replies`, async (c) => {
  const { stub, caller, repo } = await load(c);
  const n = intParam(c, "number");
  const b = await jsonBody<{ body?: string }>(c);
  const cm = await stub.createReviewComment(n, { body: b.body, in_reply_to: c.req.param("id") }, caller);
  return c.json(ghReviewComment(await issueCtx(c, repo, stub, []), n, cm), 201);
});

// ---------------------------------------------------------------- reviews and reviewers

issues.get(`${R}/pulls/:number/reviews/:id`, async (c) => {
  const { stub, repo } = await load(c);
  const n = intParam(c, "number");
  return c.json(ghReview(await issueCtx(c, repo, stub, []), n, await stub.review(n, c.req.param("id"))));
});
issues.put(`${R}/pulls/:number/reviews/:id/dismissals`, async (c) => {
  const { stub, caller, repo } = await load(c, "write");
  const n = intParam(c, "number");
  const b = await jsonBody<{ message?: string; event?: string }>(c);
  if (typeof b.message !== "string" || !b.message.trim()) throw new HttpError(422, "message is required", { errors: [{ resource: "PullRequestReview", code: "missing_field", field: "message" }] });
  return c.json(ghReview(await issueCtx(c, repo, stub, []), n, await stub.dismissReview(n, c.req.param("id"), b.message, caller)));
});
issues.get(`${R}/pulls/:number/requested_reviewers`, async (c) => {
  const { stub, repo } = await load(c);
  const { issue } = await stub.issue(intParam(c, "number"));
  if (!issue.pull) throw new HttpError(404, "Not Found");
  const [pull] = await pullsOut(c, repo, stub, [issue]);
  return c.json({ users: pull!.requested_reviewers, teams: [] });
});
issues.delete(`${R}/pulls/:number/requested_reviewers`, async (c) => {
  const { stub, caller, repo } = await load(c);
  const n = intParam(c, "number");
  const b = await jsonBody<{ reviewers?: unknown }>(c, true);
  await stub.removeReviewers(n, Array.isArray(b.reviewers) ? b.reviewers.map(String) : [], caller);
  return c.json((await pullsOut(c, repo, stub, [(await stub.issue(n)).issue]))[0]);
});
issues.put(`${R}/pulls/:number/update-branch`, async (c) => {
  const { stub, caller } = await load(c, "write");
  const n = intParam(c, "number");
  const b = await jsonBody<{ expected_head_sha?: string }>(c, true);
  await stub.updatePullBranch(n, b.expected_head_sha, caller);
  return c.json({ message: "Updating pull request branch.", url: `${repoApi(baseOf(c), repoParams(c).owner, repoParams(c).repo)}/pulls/${n}` }, 202);
});
issues.get(`${R}/commits/:sha/pulls`, async (c) => {
  const { stub, repo } = await load(c);
  const sha = await stub.resolve(c.req.param("sha"));
  if (!sha) throw new HttpError(422, `No commit found for SHA: ${c.req.param("sha")}`);
  const numbers = paginate(c, await stub.pullsForCommit(sha));
  const list = [];
  for (const n of numbers) list.push((await stub.issue(n)).issue);
  return c.json(await pullsOut(c, repo, stub, list));
});

// ---------------------------------------------------------------- reactions

function reactionJson(c: AppContext, r: Reaction) {
  return { id: r.id, node_id: nodeId("Reaction", r.id), user: ghUser(baseOf(c), r.user), content: r.content, created_at: isoSeconds(r.createdAt) };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** Reaction routes for one kind of subject; `subject` maps the path to `issue:N`, `comment:ID`, ... and `visible` checks the caller may see it. */
function reactionRoutes(path: string, subject: (c: AppContext) => string, visible?: (c: AppContext, r: Loaded) => Promise<unknown>) {
  const open = async (c: AppContext) => {
    const r = await load(c);
    if (visible) await visible(c, r);
    return r;
  };
  issues.get(`${R}/${path}/reactions`, async (c) => {
    const { stub } = await open(c);
    return c.json(paginate(c, (await stub.reactions(subject(c), c.req.query("content") || undefined)).map((r) => reactionJson(c, r))));
  });
  issues.post(`${R}/${path}/reactions`, async (c) => {
    const { stub, caller } = await open(c);
    const b = await jsonBody<{ content?: string }>(c);
    const r = await stub.react(subject(c), String(b.content ?? ""), caller);
    return c.json(reactionJson(c, r.reaction), r.created ? 201 : 200);
  });
  issues.delete(`${R}/${path}/reactions/:reaction`, async (c) => {
    const { stub, caller } = await open(c);
    await stub.unreact(subject(c), intParam(c, "reaction"), caller);
    return c.body(null, 204);
  });
}
reactionRoutes("issues/comments/:id", (c) => `comment:${c.req.param("id")}`);
reactionRoutes("pulls/comments/:id", (c) => `review_comment:${c.req.param("id")}`);
reactionRoutes("issues/:number", (c) => `issue:${intParam(c, "number")}`);
// Draft releases are hidden from readers, and so are their reactions.
reactionRoutes("releases/:id", (c) => `release:${intParam(c, "id")}`, (c, r) => r.stub.getRelease(intParam(c, "id"), r.caller));

// ---------------------------------------------------------------- events and timeline

function eventJson(x: IssueCtx, e: IssueEvent, withIssue?: ReturnType<typeof ghIssue>): Record<string, unknown> {
  const api = repoApi(x.base, x.owner, x.repo);
  const d = JSON.parse(e.detail) as Record<string, unknown>;
  const commit = typeof d.commit_id === "string" ? d.commit_id : null;
  const person = (login: unknown) => (typeof login === "string" ? ghUser(x.base, x.people?.get(login.toLowerCase()) ?? { id: login, login }) : undefined);
  return {
    id: e.id,
    node_id: nodeId("IssueEvent", `${x.repoId}/${e.id}`),
    url: `${api}/issues/events/${e.id}`,
    actor: ghUser(x.base, e.actor),
    event: e.event,
    commit_id: commit,
    commit_url: commit ? `${api}/commits/${commit}` : null,
    created_at: isoSeconds(e.createdAt),
    performed_via_github_app: null,
    ...(d.label ? { label: d.label } : {}),
    ...(d.assignee ? { assignee: person(d.assignee), assigner: ghUser(x.base, e.actor) } : {}),
    ...(d.rename ? { rename: d.rename } : {}),
    ...("lock_reason" in d ? { lock_reason: d.lock_reason ?? null } : {}),
    ...(d.requested_reviewer ? { requested_reviewer: person(d.requested_reviewer), review_requester: ghUser(x.base, e.actor) } : {}),
    ...(d.dismissed_review ? { dismissed_review: d.dismissed_review } : {}),
    ...(d.state_reason ? { state_reason: d.state_reason } : {}),
    ...(withIssue ? { issue: withIssue } : {}),
  };
}

issues.get(`${R}/issues/events`, async (c) => {
  const { stub, repo } = await load(c);
  const p = pageOf(c);
  const res = await stub.repoIssueEvents(p.perPage, p.offset);
  setLinks(c, p, res.total);
  const numbers = [...new Set(res.items.map((e) => e.number))];
  const hide = await hiddenAuthors(c);
  const list = [];
  // A suspended author's issues stay hidden here too: their events are left out.
  for (const n of numbers) {
    const found = await stub.issue(n, hide).catch((e) => (e instanceof Error && /not found/.test(e.message) ? null : Promise.reject(e)));
    if (found) list.push(found.issue);
  }
  const x = await issueCtx(c, repo, stub, list);
  const byNumber = new Map(list.map((i) => [i.number, ghIssue(x, i)]));
  return c.json(res.items.filter((e) => byNumber.has(e.number)).map((e) => eventJson(x, e, byNumber.get(e.number))));
});
issues.get(`${R}/issues/events/:id`, async (c) => {
  const { stub, repo } = await load(c);
  const e = await stub.issueEvent(intParam(c, "id"));
  const { issue } = await stub.issue(e.number, await hiddenAuthors(c));
  const x = await issueCtx(c, repo, stub, [issue]);
  return c.json(eventJson(x, e, ghIssue(x, issue)));
});
issues.get(`${R}/issues/:number/events`, async (c) => {
  const { stub, repo } = await load(c);
  await stub.issue(intParam(c, "number"), await hiddenAuthors(c));
  const x = await issueCtx(c, repo, stub, []);
  return c.json(paginate(c, (await stub.issueEvents(intParam(c, "number"))).map((e) => eventJson(x, e))));
});
issues.get(`${R}/issues/:number/timeline`, async (c) => {
  const { stub, repo } = await load(c);
  const n = intParam(c, "number");
  const hide = await hiddenAuthors(c);
  const { issue } = await stub.issue(n, hide);
  const items = await stub.issueTimeline(n, hide);
  const x = await issueCtx(c, repo, stub, [], items.flatMap((i) => (i.kind === "comment" ? [`comment:${i.comment.id}`] : [])));
  const isPull = issue.kind === "pull";
  return c.json(
    paginate(
      c,
      items.map((i) =>
        i.kind === "event"
          ? eventJson(x, i)
          : i.kind === "comment"
            ? { event: "commented", actor: ghUser(x.base, i.comment.author), ...ghComment(x, n, isPull, i.comment) }
            : { event: "reviewed", actor: ghUser(x.base, i.review.author), ...ghReview(x, n, i.review), state: i.review.state.toLowerCase() },
      ),
    ),
  );
});
