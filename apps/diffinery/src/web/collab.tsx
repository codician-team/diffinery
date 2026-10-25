/** @jsxImportSource hono/jsx */
import { FixIt, pullReviewCtx, RequestAgentReview, type PullReviewCtx } from "../agentic/review-web.js";
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import type { AppContext } from "../auth/principal.js";
import { hiddenAuthors, loadRepo, watchLevelOnce } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import type { Check, Comment, Issue, Mergeability, Review } from "../repo/collab.js";
import { atLeast, type Role } from "../repo/types.js";
import { ICONS } from "./assets.js";
import { KCheckbox, KRadio, KSelect } from "./kumo.js";
import { csrfToken } from "./csrf.js";
import { MailStore, type WatchLevel } from "../mail/prefs.js";
import { mentions } from "../mail/notify.js";
import { CheckName } from "./checks.js";
import { CommentMenu, Minimized, MoreMenu, ReportItem } from "./moderation.js";
import {
  Actor,
  Avatar,
  CommitRow,
  DiffStats,
  DiffView,
  FileSummary,
  Form,
  Label,
  Markdown,
  Pager,
  Status,
  Time,
  act,
  duration,
  encPath,
  flash,
  onBehalfOf,
  pageNum,
  post,
  qs,
  render,
  repoUrl,
  shortSha,
  statusOf,
  type DiffFile,
  type LineThread,
  type WebApp,
  prm,
  principalAccount,
} from "./ui.js";

type Loaded = Awaited<ReturnType<typeof loadRepo>>;
type LabelDef = { name: string; color: string; description: string };

/** Load a repo for a state-changing action by a signed-in account. */
async function forAction(c: AppContext, min: Role = "read"): Promise<Loaded> {
  if (c.get("principal").type !== "account") throw new HttpError(401, "sign in required");
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), min);
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  return l;
}

function issueNumber(c: AppContext): number {
  const n = Number(prm(c, "n"));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "not found");
  return n;
}

const kindPath = (i: Pick<Issue, "kind">) => (i.kind === "pull" ? "pull" : "issues");

const StateBadge: FC<{ i: Issue }> = ({ i }) => {
  if (i.kind === "pull") {
    if (i.pull?.merged)
      return (
        <span class="state merged">
          {raw(ICONS.prMerged)} Merged
        </span>
      );
    if (i.state === "closed")
      return (
        <span class="state closed">
          {raw(ICONS.prClosed)} Closed
        </span>
      );
    if (i.pull?.draft)
      return (
        <span class="state draft">
          {raw(ICONS.pr)} Draft
        </span>
      );
    return (
      <span class="state open">
        {raw(ICONS.pr)} Open
      </span>
    );
  }
  return i.state === "open" ? (
    <span class="state open">
      {raw(ICONS.issueOpen)} Open
    </span>
  ) : (
    <span class="state merged" style={i.stateReason === "not_planned" ? "background:var(--fg3)" : ""}>
      {raw(ICONS.issueClosed)} Closed
    </span>
  );
};

const StateIcon: FC<{ i: Issue }> = ({ i }) => {
  if (i.kind === "pull") {
    if (i.pull?.merged) return <span class="st merged">{raw(ICONS.prMerged)}</span>;
    if (i.state === "closed") return <span class="st bad">{raw(ICONS.prClosed)}</span>;
    return <span class={`st ${i.pull?.draft ? "faint" : "ok"}`}>{raw(ICONS.pr)}</span>;
  }
  return i.state === "open" ? <span class="st ok">{raw(ICONS.issueOpen)}</span> : <span class="st merged">{raw(ICONS.issueClosed)}</span>;
};

// ---------------------------------------------------------------- lists

async function listPage(c: AppContext, kind: "issue" | "pull"): Promise<Response> {
  // Suspended authors are left out of the list: start that lookup before the repository's.
  hiddenAuthors(c).catch(() => {});
  const { repo, caller, stub } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
  const base = repoUrl(repo);
  const state = c.req.query("state") === "closed" ? "closed" : "open";
  const label = c.req.query("label") ?? "";
  const q = (c.req.query("q") ?? "").slice(0, 200);
  const author = c.req.query("author") ?? "";
  const ms = /^\d+$/.test(c.req.query("milestone") ?? "") ? Number(c.req.query("milestone")) : undefined;
  const page = pageNum(c);
  const per = 25;
  const filter = { kind, label: label || undefined, q: q || undefined, author: author || undefined, milestone: ms, hide: await hiddenAuthors(c) };
  const [list, other, labels, milestone] = await Promise.all([
    stub.issues({ ...filter, state, limit: per, offset: (page - 1) * per }),
    stub.issues({ ...filter, state: state === "open" ? "closed" : "open", limit: 1 }),
    stub.labels(),
    ms === undefined ? null : stub.milestones("all").then((all) => all.find((m) => m.number === ms) ?? null),
  ]);
  const colors = new Map(labels.map((l) => [l.name, l.color]));
  const path = kind === "pull" ? "pulls" : "issues";
  const href = (p: Record<string, string | number | undefined>) => `${base}/${path}${qs({ state: state === "closed" ? "closed" : undefined, label: label || undefined, q: q || undefined, author: author || undefined, milestone: ms, ...p })}`;
  const openCount = state === "open" ? list.total : other.total;
  const closedCount = state === "closed" ? list.total : other.total;
  const isAccount = c.get("principal").type === "account";
  const behalf = await onBehalfOf(c, list.items.map((i) => i.author));
  return render(
    c,
    { title: `${kind === "pull" ? "Pull requests" : "Issues"} · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: kind === "pull" ? "pulls" : "issues" } },
    <div>
      <div class="row between mb">
        <form method="get" action={`${base}/${path}`} class="row grow" style="max-width:640px">
          <input type="hidden" name="state" value={state === "closed" ? "closed" : ""} />
          {label ? <input type="hidden" name="label" value={label} /> : null}
          {ms !== undefined ? <input type="hidden" name="milestone" value={String(ms)} /> : null}
          <input type="search" name="q" value={q} placeholder={`Search ${kind === "pull" ? "pull requests" : "issues"}…  ( / )`} class="grow" style="flex:1" />
        </form>
        <div class="row">
          <a class="btn" href={`${base}/labels`}>
            {raw(ICONS.tag)} Labels
          </a>
          {kind === "pull" ? (
            <a class="btn primary" href={`${base}/compare`}>
              New pull request
            </a>
          ) : isAccount && !repo.archived ? (
            <a class="btn primary" href={`${base}/issues/new`}>
              New issue
            </a>
          ) : null}
        </div>
      </div>
      <div class="box">
        <div class="head">
          <a href={href({ state: undefined, page: undefined })} style={state === "open" ? "font-weight:600;color:var(--fg)" : "color:var(--fg2)"}>
            {raw(kind === "pull" ? ICONS.pr : ICONS.issueOpen)} {openCount} Open
          </a>
          <a href={href({ state: "closed", page: undefined })} style={state === "closed" ? "font-weight:600;color:var(--fg)" : "color:var(--fg2)"}>
            {raw(ICONS.check)} {closedCount} Closed
          </a>
          <span class="grow" />
          {label ? (
            <span class="small">
              Label: <Label name={label} color={colors.get(label)} /> <a href={`${base}/${path}${qs({ state: state === "closed" ? "closed" : undefined, q: q || undefined })}`}>clear</a>
            </span>
          ) : null}
          {author ? (
            <span class="small">
              Author: <b>{author}</b> <a href={href({ author: undefined })}>clear</a>
            </span>
          ) : null}
          {ms !== undefined ? (
            <span class="small">
              Milestone: <b>{milestone?.title ?? `#${ms}`}</b> <a href={href({ milestone: undefined, page: undefined })}>clear</a>
            </span>
          ) : null}
          {labels.length ? (
            <details class="menu">
              <summary class="btn sm">Label ▾</summary>
              <div class="pop right">
                {labels.map((l) => (
                  <a href={href({ label: l.name, page: undefined })}>
                    <Label name={l.name} color={l.color} />
                    <span class="muted small">{l.description}</span>
                  </a>
                ))}
              </div>
            </details>
          ) : null}
        </div>
        {list.items.length ? (
          <ul class="list">
            {list.items.map((i) => (
              <li>
                <StateIcon i={i} />
                <div class="grow">
                  <a class="title" href={`${base}/${kindPath(i)}/${i.number}`}>
                    {i.title}
                  </a>{" "}
                  {i.labels.map((l) => (
                    <Label name={l} color={colors.get(l)} href={href({ label: l, page: undefined })} />
                  ))}
                  {i.pull?.draft && i.state === "open" ? <span class="badge">draft</span> : null}
                  <div class="meta">
                    #{i.number} {i.state === "open" ? "opened" : i.pull?.merged ? "merged" : "closed"} <Time at={i.state === "open" ? i.createdAt : (i.pull?.mergedAt ?? i.closedAt ?? i.updatedAt)} /> by{" "}
                    <a href={href({ author: i.author.login, page: undefined })}>{i.author.login}</a>
                    {i.author.kind === "agent" ? (
                      <>
                        {" "}
                        <span class="badge agent">agent</span>
                        {behalf.get(i.author.login) ? <span> on behalf of {behalf.get(i.author.login)}</span> : null}
                      </>
                    ) : null}
                    {i.pull ? (
                      <span class="mono">
                        {" "}
                        · {i.pull.head} → {i.pull.base}
                      </span>
                    ) : null}
                  </div>
                </div>
                {i.comments ? (
                  <a class="muted small nowrap" href={`${base}/${kindPath(i)}/${i.number}`}>
                    {raw(ICONS.comment)} {i.comments}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">
            {q || label || author ? "No results match your filters." : state === "open" ? `There are no open ${kind === "pull" ? "pull requests" : "issues"}.` : `No closed ${kind === "pull" ? "pull requests" : "issues"}.`}
          </div>
        )}
      </div>
      <Pager page={page} hasNext={page * per < list.total} href={(p) => href({ page: p > 1 ? p : undefined })} />
    </div>,
  );
}

// ---------------------------------------------------------------- conversation pieces

interface ConvCtx {
  c: AppContext;
  l: Loaded;
  issue: Issue;
  comments: Comment[];
  reviews: Review[];
  labels: LabelDef[];
  behalf: Map<string, string>;
  /** The signed-in person's thread subscription (explicit choice, if any) and repository watch level. */
  sub?: { explicit: boolean | null; watch: WatchLevel };
  milestones: Array<{ number: number; title: string; state: "open" | "closed" }>;
  /** Set when agent review is on and the viewer can ask for one (agentic/review-web.tsx). */
  agentReview?: PullReviewCtx | null;
}

/** Whether the viewer may hide (minimize) comments here: people with write access, as on GitHub. */
const canHide = (x: ConvCtx): boolean => x.c.get("principal").type === "account" && x.l.caller.kind === "user" && atLeast(x.l.caller.role, "write");

const CommentCard: FC<{ x: ConvCtx; author: { login: string; kind: string }; at: string; body: string; verb?: string; id?: string; extra?: Child; cls?: string; comment?: Comment }> = ({ x, author, at, body, verb, id, extra, cls, comment }) => {
  const head = (
    <div class="head">
      <Actor login={author.login} kind={author.kind} onBehalfOf={x.behalf.get(author.login)} />
      <span class="muted">
        {verb ?? "commented"} <Time at={at} />
      </span>
      <span class="grow" />
      {author.login === x.issue.author.login ? <span class="badge">Author</span> : null}
      {extra}
      {comment ? <CommentMenu c={x.c} repo={`${x.l.repo.owner_login}/${x.l.repo.name}`} id={comment.id} minimized={!!comment.minimized} canHide={canHide(x)} /> : null}
    </div>
  );
  const content = (
    <div class="body">
      <Markdown text={body} base={{ owner: x.l.repo.owner_login, repo: x.l.repo.name, ref: x.l.repo.default_branch, dir: "" }} />
    </div>
  );
  // A hidden comment shows collapsed behind its reason (lib/moderation.ts).
  if (comment?.minimized)
    return (
      <div class={`comment minimized ${cls ?? ""}`} id={id}>
        <Minimized reason={comment.minimized.reason}>
          {head}
          {content}
        </Minimized>
      </div>
    );
  return (
    <div class={`comment ${cls ?? ""}`} id={id}>
      {head}
      {content}
    </div>
  );
};

const LineComments: FC<{ x: ConvCtx; list: Comment[] }> = ({ x, list }) => {
  const base = repoUrl(x.l.repo);
  return (
    <div>
      {list.map((cm) => (
        <div class="linec" id={`c-${cm.id}`}>
          <div class="row small" style="gap:8px">
            <a class="where" href={`${base}/pull/${x.issue.number}/files#diff-${encodeURIComponent(cm.path ?? "")}`}>
              {cm.path}
              {cm.line ? `:${cm.line}` : ""}
            </a>
            {cm.commitId && x.issue.pull && cm.commitId !== x.issue.pull.headSha ? <span class="badge">outdated</span> : null}
            {cm.resolved ? <span class="badge green">resolved</span> : null}
            <span class="grow" />
            <Actor login={cm.author.login} kind={cm.author.kind} avatar={false} />
            <Time at={cm.createdAt} />
            <CommentMenu c={x.c} repo={`${x.l.repo.owner_login}/${x.l.repo.name}`} id={cm.id} minimized={!!cm.minimized} canHide={canHide(x)} />
          </div>
          {cm.minimized ? (
            <Minimized reason={cm.minimized.reason}>
              <Markdown text={cm.body} />
            </Minimized>
          ) : (
            <Markdown text={cm.body} />
          )}
          {x.issue.pull && x.issue.state === "open" ? <FixIt l={x.l} pr={x.issue.number} comment={cm} /> : null}
        </div>
      ))}
    </div>
  );
};

const Timeline: FC<{ x: ConvCtx }> = ({ x }) => {
  type Item = { at: string; node: Child };
  const items: Item[] = [];
  for (const cm of x.comments.filter((c) => !c.reviewId)) {
    items.push({ at: cm.createdAt, node: <CommentCard x={x} author={cm.author} at={cm.createdAt} body={cm.body} id={`c-${cm.id}`} comment={cm} /> });
  }
  for (const rv of x.reviews) {
    const lines = x.comments.filter((c) => c.reviewId === rv.id);
    const cls = rv.state === "APPROVED" ? "approved" : rv.state === "CHANGES_REQUESTED" ? "changes" : "";
    const verb = rv.state === "APPROVED" ? "approved these changes" : rv.state === "CHANGES_REQUESTED" ? "requested changes" : rv.state === "DISMISSED" ? "reviewed (dismissed)" : "reviewed";
    items.push({
      at: rv.submittedAt,
      node: (
        <div>
          <div class={`event ${cls}`}>
            <span class="ic">{raw(rv.state === "APPROVED" ? ICONS.check : rv.state === "CHANGES_REQUESTED" ? ICONS.x : ICONS.eye)}</span>
            <Actor login={rv.author.login} kind={rv.author.kind} onBehalfOf={x.behalf.get(rv.author.login)} avatar={false} />
            <span>
              {verb} <Time at={rv.submittedAt} />
            </span>
            <span class="faint mono small">on {shortSha(rv.commitId)}</span>
          </div>
          {rv.body.trim() || lines.length ? (
            <div class="comment" style="margin-left:24px">
              <div class="body">
                {rv.body.trim() ? <Markdown text={rv.body} /> : null}
                {lines.length ? <LineComments x={x} list={lines} /> : null}
              </div>
            </div>
          ) : null}
        </div>
      ),
    });
  }
  if (x.issue.state === "closed" && x.issue.closedAt) {
    items.push({
      at: x.issue.closedAt,
      node: (
        <div class="event">
          <span class="ic" style={x.issue.pull?.merged ? "color:var(--purple)" : ""}>
            {raw(x.issue.pull?.merged ? ICONS.prMerged : ICONS.issueClosed)}
          </span>
          {x.issue.pull?.merged ? (
            <span>
              <b>{x.issue.pull.mergedBy}</b> merged commit{" "}
              {x.issue.pull.mergeCommit ? (
                <a class="sha" href={`${repoUrl(x.l.repo)}/commit/${x.issue.pull.mergeCommit}`}>
                  {shortSha(x.issue.pull.mergeCommit)}
                </a>
              ) : null}{" "}
              into <span class="mono">{x.issue.pull.base}</span> <Time at={x.issue.pull.mergedAt} />
            </span>
          ) : (
            <span>
              Closed{x.issue.stateReason && x.issue.stateReason !== "completed" ? ` as ${x.issue.stateReason.replace(/_/g, " ")}` : ""} <Time at={x.issue.closedAt} />
            </span>
          )}
        </div>
      ),
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  return <div class="timeline">{items.map((i) => i.node)}</div>;
};

const CommentForm: FC<{ x: ConvCtx }> = ({ x }) => {
  const p = x.c.get("principal");
  if (p.type !== "account") return <div class="blank">Sign in to join the conversation.</div>;
  if (x.l.repo.archived) return <div class="blank">This repository is archived; the conversation is read-only.</div>;
  const base = repoUrl(x.l.repo);
  const canState = x.issue.author.id === x.l.caller.id || atLeast(x.l.caller.role, "triage");
  const merged = !!x.issue.pull?.merged;
  return (
    <Form action={`${base}/issues/${x.issue.number}/comment`} t={csrfToken(x.c)} class="comment">
      <div class="head">
        <b>Add a comment</b>
        <span class="muted small">Markdown supported</span>
      </div>
      <div class="body">
        <textarea name="body" placeholder="Leave a comment" aria-label="Comment"></textarea>
        <div class="row end mt">
          {canState && !merged ? (
            x.issue.state === "open" ? (
              <>
                {x.issue.kind === "issue" ? (
                  <button class="btn" name="action" value="not_planned">
                    Close as not planned
                  </button>
                ) : null}
                <button class="btn" name="action" value="close">
                  {raw(ICONS.issueClosed)} Close {x.issue.kind === "pull" ? "pull request" : "issue"}
                </button>
              </>
            ) : (
              <button class="btn" name="action" value="reopen">
                Reopen
              </button>
            )
          ) : null}
          <button class="btn primary" name="action" value="comment">
            Comment
          </button>
        </div>
      </div>
    </Form>
  );
};

/** Why the signed-in person gets notifications for this thread, and a button to change it (like GitHub's sidebar). */
const SubscriptionBox: FC<{ x: ConvCtx; sub: NonNullable<ConvCtx["sub"]> }> = ({ x, sub }) => {
  const me = principalAccount(x.c)!;
  const i = x.issue;
  const why =
    i.author.login === me.login
      ? "you authored it"
      : i.assignees.includes(me.login)
        ? "you were assigned"
        : i.pull?.requestedReviewers.includes(me.login)
          ? "your review was requested"
          : x.reviews.some((r) => r.author.login === me.login)
            ? "you reviewed it"
            : x.comments.some((c) => c.author.login === me.login)
              ? "you commented"
              : mentions([i.body, ...x.comments.map((c) => c.body)].join("\n")).includes(me.login.toLowerCase())
                ? "you were mentioned"
                : sub.watch === "all"
                  ? "you're watching this repository"
                  : null;
  const on = sub.explicit ?? (why !== null && sub.watch !== "ignore");
  const what = i.kind === "pull" ? "pull request" : "issue";
  return (
    <section>
      <h3>Notifications</h3>
      <Form action={`${repoUrl(x.l.repo)}/issues/${i.number}/subscription`} t={csrfToken(x.c)}>
        <input type="hidden" name="subscribed" value={on ? "0" : "1"} />
        <button class="btn sm" style="width:100%">
          {raw(ICONS.bell)} {on ? "Unsubscribe" : "Subscribe"}
        </button>
      </Form>
      <p class="muted small" style="margin:6px 0 0">
        {sub.explicit === true
          ? `You're subscribed to this ${what}.`
          : sub.explicit === false
            ? `You muted this ${what}. You'll still hear about it if you're @mentioned, assigned or asked to review.`
            : on
              ? `You're receiving notifications because ${why}.`
              : `You're not receiving notifications for this ${what}.`}
      </p>
    </section>
  );
};

const Sidebar: FC<{ x: ConvCtx }> = ({ x }) => {
  const base = repoUrl(x.l.repo);
  const t = csrfToken(x.c);
  const canTriage = atLeast(x.l.caller.role, "triage") && !x.l.repo.archived && x.c.get("principal").type === "account";
  const colors = new Map(x.labels.map((l) => [l.name, l.color]));
  const participants = [...new Map([x.issue.author, ...x.comments.map((c) => c.author), ...x.reviews.map((r) => r.author)].map((a) => [a.login, a])).values()];
  return (
    <aside class="side">
      {x.issue.pull ? (
        <section>
          <h3>Reviewers</h3>
          {x.reviews.length || x.issue.pull.requestedReviewers.length ? (
            <div>
              {[...new Map(x.reviews.filter((r) => r.state !== "COMMENTED").map((r) => [r.author.login, r])).values()].map((r) => (
                <div class="row small" style="margin:4px 0">
                  <Actor login={r.author.login} kind={r.author.kind} />
                  <span class="grow" />
                  <span class={r.state === "APPROVED" ? "ok" : r.state === "CHANGES_REQUESTED" ? "bad" : "faint"}>{r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes requested" : "dismissed"}</span>
                </div>
              ))}
              {x.issue.pull.requestedReviewers.map((r) => (
                <div class="row small" style="margin:4px 0">
                  <Actor login={r} />
                  <span class="grow" />
                  <span class="warn">pending</span>
                </div>
              ))}
            </div>
          ) : (
            <p class="muted small m0">No reviews yet.</p>
          )}
          {x.agentReview && x.issue.state === "open" ? <RequestAgentReview c={x.c} l={x.l} pr={x.issue.number} ctx={x.agentReview} /> : null}
        </section>
      ) : null}
      <section>
        <h3>Labels</h3>
        {x.issue.labels.length ? (
          <div>
            {x.issue.labels.map((l) => (
              <Label name={l} color={colors.get(l)} href={`${base}/${x.issue.kind === "pull" ? "pulls" : "issues"}${qs({ label: l })}`} />
            ))}
          </div>
        ) : (
          <p class="muted small m0">None yet</p>
        )}
        {canTriage ? (
          <details class="mt" style="margin-top:8px">
            <summary class="small" style="cursor:pointer;color:var(--accent)">
              Edit labels
            </summary>
            <Form action={`${base}/issues/${x.issue.number}/labels`} t={t} class="mt" style="margin-top:8px">
              <div class="kstack">
                {x.labels.map((l) => (
                  <KCheckbox name="labels" value={l.name} checked={x.issue.labels.includes(l.name)} label={<Label name={l.name} color={l.color} />} />
                ))}
                {x.issue.labels
                  .filter((l) => !colors.has(l))
                  .map((l) => (
                    <KCheckbox name="labels" value={l} checked label={<Label name={l} />} />
                  ))}
              </div>
              <input type="text" name="new_label" placeholder="New label…" style="margin:6px 0" />
              <button class="btn sm">Apply</button>
            </Form>
          </details>
        ) : null}
      </section>
      <section>
        <h3>Milestone</h3>
        {x.issue.milestone ? (
          <p class="small m0">
            <a href={`${base}/${x.issue.kind === "pull" ? "pulls" : "issues"}${qs({ milestone: x.issue.milestone.number })}`}>{x.issue.milestone.title}</a>{" "}
            {x.issue.milestone.state === "closed" ? <span class="badge">closed</span> : null}
            {x.issue.milestone.dueOn ? <span class="muted"> · due {x.issue.milestone.dueOn.slice(0, 10)}</span> : null}
          </p>
        ) : (
          <p class="muted small m0">No milestone</p>
        )}
        {canTriage && (x.milestones.length || x.issue.milestone) ? (
          <details style="margin-top:8px">
            <summary class="small" style="cursor:pointer;color:var(--accent)">
              Set milestone
            </summary>
            <Form action={`${base}/issues/${x.issue.number}/milestone`} t={t} style="margin-top:8px">
              <KSelect
                name="milestone"
                block
                size="sm"
                label="Milestone"
                value={x.issue.milestone ? String(x.issue.milestone.number) : ""}
                options={[{ value: "", label: "No milestone" }, ...x.milestones.map((m) => ({ value: String(m.number), label: m.title }))]}
              />
              <button class="btn sm" style="margin-top:6px">
                Save
              </button>
            </Form>
          </details>
        ) : null}
      </section>
      <section>
        <h3>Assignees</h3>
        {x.issue.assignees.length ? (
          x.issue.assignees.map((a) => (
            <div style="margin:4px 0">
              <Actor login={a} />
            </div>
          ))
        ) : (
          <p class="muted small m0">No one assigned</p>
        )}
        {canTriage ? (
          <details style="margin-top:8px">
            <summary class="small" style="cursor:pointer;color:var(--accent)">
              Edit assignees
            </summary>
            <Form action={`${base}/issues/${x.issue.number}/assignees`} t={t} style="margin-top:8px">
              <input type="text" name="assignees" value={x.issue.assignees.join(", ")} placeholder="login, login" />
              <button class="btn sm" style="margin-top:6px">
                Save
              </button>
            </Form>
          </details>
        ) : null}
      </section>
      {x.sub ? <SubscriptionBox x={x} sub={x.sub} /> : null}
      <section>
        <h3>Participants</h3>
        <div class="row" style="gap:4px">
          {participants.map((a) => (
            <a href={`/${encodeURIComponent(a.login)}`} title={a.login}>
              <Avatar login={a.login} kind={a.kind} />
            </a>
          ))}
        </div>
      </section>
    </aside>
  );
};

const TitleEditor: FC<{ x: ConvCtx }> = ({ x }) => {
  const can = x.c.get("principal").type === "account" && !x.l.repo.archived && (x.issue.author.id === x.l.caller.id || atLeast(x.l.caller.role, "triage"));
  if (!can) return null;
  return (
    <details class="menu">
      <summary class="btn">{raw(ICONS.edit)} Edit</summary>
      <div class="pop right" style="width:min(560px,90vw)">
        <Form action={`${repoUrl(x.l.repo)}/issues/${x.issue.number}/edit`} t={csrfToken(x.c)} style="padding:8px">
          <div class="field">
            <label>Title</label>
            <input type="text" name="title" value={x.issue.title} required />
          </div>
          <div class="field">
            <label>Description</label>
            <textarea name="body">{x.issue.body}</textarea>
          </div>
          <button class="btn primary">Save</button>
        </Form>
      </div>
    </details>
  );
};

const IssueHeader: FC<{ x: ConvCtx }> = ({ x }) => {
  const i = x.issue;
  const base = repoUrl(x.l.repo);
  return (
    <div class="mb" data-fragment="header">
      <div class="row between" style="align-items:flex-start">
        <h1 class="grow" style="font-size:24px;font-weight:500">
          {i.title} <span class="faint">#{i.number}</span>
        </h1>
        <div class="row">
          <TitleEditor x={x} />
          {x.c.get("principal").type === "account" ? (
            <MoreMenu label={i.kind === "pull" ? "Pull request actions" : "Issue actions"}>
              <ReportItem s={{ kind: i.kind === "pull" ? "pull_request" : "issue", repository: `${x.l.repo.owner_login}/${x.l.repo.name}`, number: i.number }} label="Report content" />
            </MoreMenu>
          ) : null}
          {i.kind === "issue" ? (
            <a class="btn primary" href={`${base}/issues/new`}>
              New issue
            </a>
          ) : null}
        </div>
      </div>
      <div class="row" style="gap:8px">
        <StateBadge i={i} />
        <Actor login={i.author.login} kind={i.author.kind} onBehalfOf={x.behalf.get(i.author.login)} avatar={false} />
        {i.pull ? (
          <span class="muted">
            {i.pull.merged ? "merged" : "wants to merge"} into <a class="sha" href={`${base}/tree/${encPath(i.pull.base)}`}>{i.pull.base}</a> from{" "}
            <a class="sha" href={`${base}/tree/${encPath(i.pull.head)}`}>
              {i.pull.head}
            </a>
          </span>
        ) : (
          <span class="muted">
            opened this issue <Time at={i.createdAt} /> · {i.comments} comment{i.comments === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
};

const PullTabs: FC<{ x: ConvCtx; tab: "conversation" | "commits" | "files" | "checks" }> = ({ x, tab }) => {
  const b = `${repoUrl(x.l.repo)}/pull/${x.issue.number}`;
  return (
    <nav class="tabs mb" style="border-bottom:1px solid var(--border);margin-top:0">
      <a href={b} class={tab === "conversation" ? "on" : ""}>
        {raw(ICONS.comment)} Conversation <span class="n">{x.issue.comments}</span>
      </a>
      <a href={`${b}/commits`} class={tab === "commits" ? "on" : ""}>
        {raw(ICONS.commit)} Commits
      </a>
      <a href={`${b}/checks`} class={tab === "checks" ? "on" : ""}>
        {raw(ICONS.play)} Checks
      </a>
      <a href={`${b}/files`} class={tab === "files" ? "on" : ""}>
        {raw(ICONS.file)} Files changed
      </a>
    </nav>
  );
};

// ---------------------------------------------------------------- merge box and review

const MergeBox: FC<{ x: ConvCtx; m: Mergeability | null; checks: Check[] }> = ({ x, m, checks }) => {
  const i = x.issue;
  const p = i.pull!;
  const base = repoUrl(x.l.repo);
  const caller = x.l.caller;
  const isAccount = x.c.get("principal").type === "account";
  if (p.merged) {
    return (
      <div class="mergebox merged" data-fragment="merge">
        <div class="row">
          <span class="st merged">{raw(ICONS.prMerged)}</span>
          <div>
            <b>Pull request successfully merged and closed</b>
            <div class="muted small">
              {p.mergedBy} merged {p.mergeCommit ? <a href={`${base}/commit/${p.mergeCommit}`}>{shortSha(p.mergeCommit)}</a> : null} into {p.base} <Time at={p.mergedAt} />
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (i.state === "closed") {
    return (
      <div class="mergebox" data-fragment="merge">
        <div>
          <b>This pull request is closed.</b>
          <span class="muted"> Reopen it to continue.</span>
        </div>
      </div>
    );
  }
  if (!m) return <div class="mergebox" data-fragment="merge" />;
  const headline =
    m.state === "clean"
      ? "This branch has no conflicts with the base branch"
      : m.state === "conflicting"
        ? "This branch has conflicts that must be resolved"
        : m.state === "draft"
          ? "This pull request is still a work in progress"
          : "Merging is blocked";
  const bypass = !m.mergeable && caller.role === "admin" && caller.kind === "user" && !m.enforceAdmins && m.conflicts.length === 0 && !p.draft;
  const showChecks = checks.length ? checks : m.checks.map((ch) => ({ name: ch.name, status: ch.state === "queued" || ch.state === "in_progress" ? ch.state : "completed", conclusion: ch.state, runId: null, jobId: null, output: null }) as unknown as Check);
  const failing = showChecks.filter((ch) => ch.status === "completed" && ch.conclusion !== "success" && ch.conclusion !== "skipped" && ch.conclusion !== "neutral").length;
  const pending = showChecks.filter((ch) => ch.status !== "completed").length;
  const canReady = p.draft && isAccount && (caller.id === i.author.id || atLeast(caller.role, "write")) && !x.l.repo.archived;
  return (
    <div class={`mergebox ${m.state}`} data-fragment="merge">
      {canReady ? (
        <Form action={`${base}/pull/${i.number}/ready`} t={csrfToken(x.c)} class="row" style="margin-bottom:8px">
          <span class="grow">This pull request is still a draft and can't be merged yet.</span>
          <button class="btn">Ready for review</button>
        </Form>
      ) : null}
      {showChecks.length ? (
        <div>
          <div class="row mb" style="margin-bottom:6px">
            <Status status={pending ? "in_progress" : "completed"} conclusion={failing ? "failure" : "success"} />
            <b>{pending ? "Some checks haven't completed yet" : failing ? `${failing} failing check${failing === 1 ? "" : "s"}` : "All checks have passed"}</b>
            <span class="muted small">
              {showChecks.length} check{showChecks.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul class="checks">
            {showChecks.map((ch) => (
              <li>
                <Status status={ch.status} conclusion={ch.conclusion} />
                <CheckName base={base} ch={ch} />
                <span class="muted small grow">{ch.output?.title && ch.output.title !== ch.conclusion ? ch.output.title : ""}</span>
                <span class="muted small">{ch.startedAt ? duration(ch.startedAt, ch.completedAt) : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <div class="row">
          <Status conclusion={m.approvals >= m.requiredApprovals && !m.changesRequested.length ? "success" : "pending"} />
          <span>
            <b>
              {m.approvals} approval{m.approvals === 1 ? "" : "s"}
            </b>
            {m.requiredApprovals ? <span class="muted"> of {m.requiredApprovals} required</span> : null}
            {m.changesRequested.length ? <span class="bad"> · changes requested by {m.changesRequested.join(", ")}</span> : null}
          </span>
        </div>
      </div>
      <div>
        <div class="row">
          <Status conclusion={m.mergeable ? "success" : m.state === "conflicting" ? "failure" : "pending"} />
          <b>{headline}</b>
        </div>
        {m.conflicts.length ? (
          <ul class="small mono" style="margin:6px 0 0 24px">
            {m.conflicts.map((f) => (
              <li>{f}</li>
            ))}
          </ul>
        ) : null}
        {m.blockers.length ? (
          <ul class="small" style="margin:6px 0 0 24px;color:var(--fg2)">
            {m.blockers.map((b) => (
              <li>{b}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <AutoMergeRow x={x} canAct={isAccount && atLeast(caller.role, "write") && !x.l.repo.archived} queue={!!m.mergeQueue} />
      {m.mergeQueue ? (
        <QueueBox x={x} m={m} canAct={isAccount && atLeast(caller.role, "write") && !x.l.repo.archived} adminBypass={caller.role === "admin" && caller.kind === "user" && !m.enforceAdmins && m.conflicts.length === 0 && !p.draft} />
      ) : isAccount && atLeast(caller.role, "write") && !x.l.repo.archived ? (
        <div>
          <Form action={`${base}/pull/${i.number}/merge`} t={csrfToken(x.c)} class="row" confirm={bypass ? "Merge without meeting the branch requirements?" : undefined}>
            <input type="hidden" name="expected_head" value={p.headSha} />
            {bypass ? <input type="hidden" name="bypass_rules" value="1" /> : null}
            <KSelect
              name="method"
              label="Merge method"
              value={m.linearHistory ? "squash" : "merge"}
              options={[
                ...(m.linearHistory ? [] : [{ value: "merge", label: "Create a merge commit" }]),
                { value: "squash", label: "Squash and merge" },
                { value: "rebase", label: "Rebase and merge (fast-forward)" },
              ]}
            />
            <KCheckbox
              name="delete_branch"
              checked
              label={
                <>
                  Delete <span class="mono">{p.head}</span> after merge
                </>
              }
            />
            <span class="grow" />
            {m.mergeable ? (
              <button class="btn green">Merge pull request</button>
            ) : bypass ? (
              <button class="btn danger">Merge without waiting for requirements (bypass)</button>
            ) : (
              <button class="btn" disabled>
                Merge pull request
              </button>
            )}
          </Form>
          {!m.mergeable && !p.autoMerge && m.conflicts.length === 0 && !p.draft ? <EnableAutoMerge x={x} linearHistory={!!m.linearHistory} /> : null}
          {!p.autoMerge && !m.requiredChecks && showChecks.length > 0 && caller.kind === "user" && atLeast(caller.role, "admin") ? <MergeOnGreenHint x={x} /> : null}
        </div>
      ) : null}
    </div>
  );
};

/** While auto-merge is on: who turned it on, how it will merge, and the button to turn it off. */
const AutoMergeRow: FC<{ x: ConvCtx; canAct: boolean; queue: boolean }> = ({ x, canAct, queue }) => {
  const a = x.issue.pull?.autoMerge;
  if (!a) return null;
  const by = a.enabledBy;
  const text = (
    <>
      <Status status="in_progress" />
      <span class="grow">
        <b>Auto-merge is on</b>
        <span class="muted">
          {" "}
          ·{" "}
          {a.byRule ? (
            <>
              turned on by the branch rule <span class="mono">{a.byRule}</span> for <Actor login={by.login} kind={by.kind} onBehalfOf={by.onBehalfOf} avatar={false} />
            </>
          ) : a.byDefault ? (
            <>
              turned on by <Actor login={by.login} kind={by.kind} onBehalfOf={by.onBehalfOf} avatar={false} />'s own setting
            </>
          ) : (
            <>
              turned on by <Actor login={by.login} kind={by.kind} onBehalfOf={by.onBehalfOf} avatar={false} />
            </>
          )}{" "}
          · {queue ? `joins the merge queue (${METHOD_LABELS[a.method].toLowerCase()}) once every requirement is met` : `${METHOD_LABELS[a.method].toLowerCase()} once every requirement is met`}
          {a.deleteBranch ? (
            <>
              {" "}
              · then deletes <span class="mono">{x.issue.pull?.head}</span>
            </>
          ) : null}
        </span>
      </span>
    </>
  );
  return canAct ? (
    <Form action={`${repoUrl(x.l.repo)}/pull/${x.issue.number}/auto-merge/disable`} t={csrfToken(x.c)} class="row">
      {text}
      <button class="btn">Disable auto-merge</button>
    </Form>
  ) : (
    <div class="row">{text}</div>
  );
};

/** Auto-merge: merge (or join the merge queue) by itself once checks and reviews allow it. */
const EnableAutoMerge: FC<{ x: ConvCtx; linearHistory: boolean; queueMethod?: "merge" | "squash" | "rebase" }> = ({ x, linearHistory, queueMethod }) => (
  <Form action={`${repoUrl(x.l.repo)}/pull/${x.issue.number}/auto-merge`} t={csrfToken(x.c)} class="row" style="margin-top:8px">
    <span class="muted small grow">{queueMethod ? "Join the merge queue by itself once every requirement is met." : "Merge by itself once every requirement is met."}</span>
    <KSelect
      name="method"
      label="Auto-merge method"
      value={queueMethod ?? (linearHistory ? "squash" : "merge")}
      options={(["merge", "squash", "rebase"] as const).filter((v) => !(linearHistory && v === "merge")).map((v) => ({ value: v, label: METHOD_LABELS[v] }))}
    />
    <KCheckbox
      name="delete_branch"
      checked
      label={
        <>
          Delete <span class="mono">{x.issue.pull?.head}</span> after merge
        </>
      }
    />
    <button class="btn">Enable auto-merge</button>
  </Form>
);

/** For admins, where the base branch has no required check: auto-merge can't wait for CI, and one page sets that up. */
const MergeOnGreenHint: FC<{ x: ConvCtx }> = ({ x }) => (
  <p class="small muted" style="margin:8px 0 0">
    {x.issue.pull?.base} has no required checks, so auto-merge wouldn't wait for CI. To have pull requests merge by themselves once checks pass, <a href={`${repoUrl(x.l.repo)}/settings/merge-on-green`}>set up merge on green</a>.
  </p>
);

const METHOD_LABELS = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" } as const;

/** The merge box's footer when the base branch merges through a merge queue. */
const QueueBox: FC<{ x: ConvCtx; m: Mergeability; canAct: boolean; adminBypass: boolean }> = ({ x, m, canAct, adminBypass }) => {
  const i = x.issue;
  const p = i.pull!;
  const base = repoUrl(x.l.repo);
  const q = m.mergeQueue!;
  const e = q.entry;
  const queueUrl = `${base}/queue/${encPath(p.base)}`;
  return (
    <div>
      {e ? (
        <div>
          <div class="row">
            <Status status="in_progress" />
            <span>
              <b>Queued to merge</b>
              <span class="muted">
                {" "}
                · position {e.position} in the <a href={queueUrl}>{p.base} merge queue</a> ·{" "}
                {e.state === "checking" && e.groupSha ? (
                  <>
                    checking merge group <a class="sha" href={`${base}/commit/${e.groupSha}`}>{shortSha(e.groupSha)}</a>
                  </>
                ) : (
                  "waiting for the pull requests ahead of it"
                )}
              </span>
            </span>
          </div>
          {e.checks.length ? (
            <ul class="checks" style="margin-top:6px">
              {e.checks.map((ch) => (
                <li>
                  <Status status={ch.state === "queued" || ch.state === "in_progress" || ch.state === "expected" ? "in_progress" : "completed"} conclusion={ch.state} />
                  <span>{ch.name}</span>
                  <span class="muted small grow">{ch.state}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {canAct ? (
            <Form action={`${base}/pull/${i.number}/dequeue`} t={csrfToken(x.c)} class="row" style="margin-top:8px">
              <span class="muted small grow">It merges into {p.base} once its merge group passes the required checks.</span>
              <button class="btn">Remove from queue</button>
            </Form>
          ) : null}
        </div>
      ) : canAct ? (
        <div>
          <Form action={`${base}/pull/${i.number}/enqueue`} t={csrfToken(x.c)} class="row">
            <KSelect name="method" label="Merge method" value={q.method} options={(["merge", "squash", "rebase"] as const).map((v) => ({ value: v, label: METHOD_LABELS[v] }))} />
            <KCheckbox
              name="delete_branch"
              checked
              label={
                <>
                  Delete <span class="mono">{p.head}</span> after merge
                </>
              }
            />
            <span class="grow" />
            {m.mergeable ? (
              <button class="btn green">Merge when ready</button>
            ) : (
              <button class="btn" disabled>
                Merge when ready
              </button>
            )}
          </Form>
          {!m.mergeable && !p.autoMerge && m.conflicts.length === 0 && !p.draft ? <EnableAutoMerge x={x} linearHistory={!!m.linearHistory} queueMethod={q.method} /> : null}
          <div class="row muted small" style="margin-top:6px">
            <span class="grow">
              {p.base} merges through a <a href={queueUrl}>merge queue</a>: the pull request is tested together with the ones ahead of it before it merges.
            </span>
            {adminBypass ? (
              // Skipping the queue alone merges only a pull request that meets the rules; otherwise the button
              // says it also bypasses them, and asks for that (audited) explicitly.
              <Form
                action={`${base}/pull/${i.number}/merge`}
                t={csrfToken(x.c)}
                confirm={m.mergeable ? "Merge directly, bypassing the merge queue?" : "Merge directly, bypassing the merge queue and the unmet requirements?"}
              >
                <input type="hidden" name="expected_head" value={p.headSha} />
                <input type="hidden" name="method" value={m.linearHistory && q.method === "merge" ? "squash" : q.method} />
                <input type="hidden" name="bypass_queue" value="1" />
                {m.mergeable ? null : <input type="hidden" name="bypass_rules" value="1" />}
                <button class="btn sm danger">{m.mergeable ? "Merge now (bypass the queue)" : "Merge now (bypass the queue and the unmet requirements)"}</button>
              </Form>
            ) : null}
          </div>
        </div>
      ) : (
        <div class="muted small">{p.base} merges through a merge queue.</div>
      )}
    </div>
  );
};

const ReviewForm: FC<{ x: ConvCtx }> = ({ x }) => {
  if (x.c.get("principal").type !== "account" || x.issue.state !== "open" || x.l.repo.archived) return null;
  const own = x.issue.author.id === x.l.caller.id;
  const canApprove = !own && atLeast(x.l.caller.role, "write");
  return (
    <details class="box">
      <summary class="head" style="cursor:pointer">
        {raw(ICONS.eye)} <b>Review changes</b>
        <span class="muted small">{own ? "You can comment on your own pull request." : "Approve, request changes or leave a review comment."}</span>
      </summary>
      <Form action={`${repoUrl(x.l.repo)}/pull/${x.issue.number}/review`} t={csrfToken(x.c)} class="body">
        <div class="field">
          <textarea name="body" placeholder="Review summary (Markdown)"></textarea>
        </div>
        <div class="field">
          <KRadio
            name="event"
            label="Review type"
            value="COMMENT"
            items={[
              { value: "COMMENT", label: "Comment" },
              { value: "APPROVE", label: <span class="ok">Approve</span>, disabled: !canApprove },
              { value: "REQUEST_CHANGES", label: <span class="bad">Request changes</span>, disabled: !canApprove },
            ]}
          />
        </div>
        <button class="btn primary">Submit review</button>
      </Form>
    </details>
  );
};

// ---------------------------------------------------------------- pages

/**
 * A conversation and what its page shows around it. `alongside` reads what a page needs once the conversation is known
 * (a pull request's checks, say), at the same time as its authors' owners.
 */
async function loadConv<T = null>(c: AppContext, alongside?: (l: Loaded, issue: Issue) => Promise<T>): Promise<ConvCtx & { extra: T }> {
  // Suspended authors are left out of the conversation (http/common.ts): start that lookup before the repository's.
  hiddenAuthors(c).catch(() => {});
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
  const n = issueNumber(c);
  const me = principalAccount(c);
  // Everything the page needs that doesn't depend on the conversation itself, side by side with it.
  const [data, labels, milestones, sub] = await Promise.all([
    hiddenAuthors(c).then((hidden) => l.stub.issue(n, hidden)),
    l.stub.labels(),
    l.stub.milestones("open"),
    me?.kind === "user" ? Promise.all([new MailStore(c.env.DB).threadSub(me.id, l.repo.id, n), watchLevelOnce(c, l.repo.id)]).then(([explicit, watch]) => ({ explicit, watch })) : undefined,
  ]);
  const [behalf, extra] = await Promise.all([
    onBehalfOf(c, [data.issue.author, ...data.comments.map((x) => x.author), ...data.reviews.map((x) => x.author)]),
    alongside ? alongside(l, data.issue) : (null as T),
  ]);
  return { c, l, issue: data.issue, comments: data.comments, reviews: data.reviews, labels, behalf, sub, milestones, extra };
}

type PullTab = "conversation" | "commits" | "files" | "checks";

/** What a pull request's tab shows besides the conversation, read side by side. */
async function pullTabData(c: AppContext, l: Loaded, i: Issue, tab: PullTab) {
  const { stub, caller } = l;
  const n = i.number;
  const headSha = i.pull?.headSha ?? "";
  const [agentReview, m, checks, commits, runs, diff] = await Promise.all([
    tab === "conversation" ? pullReviewCtx(c, l) : null,
    tab === "conversation" && i.state === "open" ? stub.mergeability(n, caller).catch(() => null) : null,
    tab === "conversation" || tab === "checks" ? stub.checksAndStatuses(headSha).catch(() => [] as Check[]) : ([] as Check[]),
    tab === "commits" ? stub.pullCommits(n).catch(() => []) : [],
    tab === "checks" ? stub.runs({ prNumber: n, limit: 30 }).catch(() => ({ runs: [], total: 0 })) : { runs: [], total: 0 },
    tab === "files" ? stub.pullFiles(n) : null,
  ]);
  return { agentReview, m, checks, commits, runs, diff };
}

async function issuePage(c: AppContext): Promise<Response> {
  const x = await loadConv(c);
  const base = repoUrl(x.l.repo);
  if (x.issue.kind === "pull") return c.redirect(`${base}/pull/${x.issue.number}${new URL(c.req.url).search}`, 302);
  return render(
    c,
    { title: `${x.issue.title} · Issue #${x.issue.number}`, repo: { repo: x.l.repo, caller: x.l.caller, tab: "issues" }, live: `pr:${x.issue.number}` },
    <div>
      <IssueHeader x={x} />
      <div class="grid">
        <div>
          <div data-fragment="timeline">
            <CommentCard x={x} author={x.issue.author} at={x.issue.createdAt} body={x.issue.body} verb="opened" />
            <Timeline x={x} />
          </div>
          <CommentForm x={x} />
        </div>
        <Sidebar x={x} />
      </div>
    </div>,
  );
}

async function pullPage(c: AppContext, tab: PullTab): Promise<Response> {
  const x = await loadConv(c, (l, i) => (i.kind === "pull" && i.pull ? pullTabData(c, l, i, tab) : Promise.resolve(null)));
  const { repo, caller } = x.l;
  const base = repoUrl(repo);
  const i = x.issue;
  if (i.kind !== "pull" || !i.pull || !x.extra) return c.redirect(`${base}/issues/${i.number}`, 302);
  const d = x.extra;
  if (tab === "conversation") x.agentReview = d.agentReview;
  const n = i.number;
  const page = (body: Child, wide = false) =>
    render(
      c,
      { title: `${i.title} · Pull request #${n}`, repo: { repo, caller, tab: "pulls", ref: i.pull!.head }, live: `pr:${n}`, wide },
      <div>
        <IssueHeader x={x} />
        <PullTabs x={x} tab={tab} />
        {body}
      </div>,
    );

  if (tab === "conversation") {
    const { m, checks } = d;
    return page(
      <div class="grid">
        <div>
          <div data-fragment="timeline">
            <CommentCard x={x} author={i.author} at={i.createdAt} body={i.body} verb="opened" />
            {i.pull.intent ? (
              <div class="comment intent">
                <div class="head">
                  {raw(ICONS.zap)} <b>Intent</b>
                  <span class="muted small">what this change is meant to do</span>
                </div>
                <div class="body">
                  <Markdown text={i.pull.intent} />
                </div>
              </div>
            ) : null}
            <Timeline x={x} />
          </div>
          <MergeBox x={x} m={m} checks={checks} />
          <ReviewForm x={x} />
          <CommentForm x={x} />
        </div>
        <Sidebar x={x} />
      </div>,
    );
  }

  if (tab === "commits") {
    const { commits } = d;
    return page(
      <div class="box">
        {commits.length ? (
          <ul class="list">
            {commits.map((cm) => (
              <CommitRow base={base} sha={cm.sha} message={cm.message} author={cm.author} signed={cm.signed} />
            ))}
          </ul>
        ) : (
          <div class="empty">No commits.</div>
        )}
      </div>,
    );
  }

  if (tab === "checks") {
    const { checks, runs } = d;
    return page(
      <div data-fragment="checks">
        <div class="box">
          <div class="head">
            <h3>Checks for {shortSha(i.pull.headSha)}</h3>
          </div>
          {checks.length ? (
            <ul class="list">
              {checks.map((ch) => (
                <li>
                  <Status status={ch.status} conclusion={ch.conclusion} />
                  <div class="grow">
                    <CheckName base={base} ch={ch} class="title" />
                    <div class="meta">
                      {ch.app} · {ch.status === "completed" ? (ch.conclusion ?? "neutral") : ch.status.replace("_", " ")}
                      {ch.output?.summary ? ` · ${ch.output.summary.slice(0, 200)}` : ""}
                    </div>
                  </div>
                  <span class="muted small">{duration(ch.startedAt, ch.completedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">No checks have reported for the latest commit.</div>
          )}
        </div>
        <div class="box">
          <div class="head">
            <h3>Workflow runs</h3>
          </div>
          {runs.runs.length ? (
            <ul class="list">
              {runs.runs.map((r) => (
                <li>
                  <Status status={r.status} conclusion={r.conclusion} />
                  <div class="grow">
                    <a class="title" href={`${base}/actions/runs/${r.id}`}>
                      {r.title}
                    </a>
                    <div class="meta">
                      {r.workflowName} #{r.number} · {r.event} · {shortSha(r.sha)} · <Time at={r.createdAt} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">No workflow runs for this pull request.</div>
          )}
        </div>
      </div>,
    );
  }

  // Files changed
  const diff = d.diff!;
  const threads = new Map<string, LineThread[]>();
  const byKey = new Map<string, Comment[]>();
  for (const cm of x.comments) {
    if (!cm.path || !cm.line) continue;
    const key = `${cm.path}\u0000${cm.side === "LEFT" ? "LEFT" : "RIGHT"}\u0000${cm.line}`;
    byKey.set(key, [...(byKey.get(key) ?? []), cm]);
  }
  for (const [key, list] of byKey) {
    const [path, side, line] = key.split("\u0000") as [string, "LEFT" | "RIGHT", string];
    threads.set(path, [...(threads.get(path) ?? []), { side, line: Number(line), node: <LineComments x={x} list={list} /> }]);
  }
  const canComment = c.get("principal").type === "account" && i.state === "open" && !repo.archived;
  const files = diff.files as DiffFile[];
  return page(
    <div>
      <div class="row between mb">
        <DiffStats files={diff.totalFiles} additions={diff.additions} deletions={diff.deletions} />
        <span class="muted small">
          {diff.mergeBase ? (
            <>
              base <span class="sha">{shortSha(diff.mergeBase)}</span> →{" "}
            </>
          ) : null}
          head <span class="sha">{shortSha(diff.headSha)}</span>
        </span>
      </div>
      {canComment ? (
        <template id="line-comment-tpl">
          <Form action={`${base}/pull/${n}/line-comment`} t={csrfToken(c)}>
            <input type="hidden" name="path" />
            <input type="hidden" name="line" />
            <input type="hidden" name="side" />
            <div class="small muted mb" style="margin-bottom:6px">
              Comment on <span class="where mono" />
            </div>
            <textarea name="body" required placeholder="Leave a comment on this line" style="min-height:80px"></textarea>
            <div class="row end" style="margin-top:6px">
              <button type="button" class="btn sm" data-cancel-line="1">
                Cancel
              </button>
              <button class="btn sm primary">Add comment</button>
            </div>
          </Form>
        </template>
      ) : null}
      <FileSummary files={files} />
      <DiffView files={files} opts={{ commentable: canComment, threads, viewHref: (p) => `${base}/blob/${diff.headSha}/${encPath(p)}` }} />
      {diff.truncated ? <div class="flash info">Only the first {files.length} files are shown.</div> : null}
    </div>,
    true,
  );
}

// ---------------------------------------------------------------- routes

export function registerCollab(web: WebApp): void {
  web.get("/:owner/:repo/issues", (c) => listPage(c, "issue"));
  // GitHub's milestone page (the html_url of a milestone): its issues and pull requests, as a filtered issue list.
  web.get("/:owner/:repo/milestone/:n{[0-9]+}", (c) => c.redirect(`/${prm(c, "owner")}/${prm(c, "repo")}/issues?milestone=${c.req.param("n")}`)),
  web.get("/:owner/:repo/pulls", (c) => listPage(c, "pull"));

  const NewIssue: FC<{ c: AppContext; l: Loaded; labels: LabelDef[]; v: { title: string; body: string; labels: string[] }; error?: string }> = ({ c, l, labels, v, error }) => (
    <div style="max-width:900px">
      <h1>New issue</h1>
      {error ? <div class="flash error">{error}</div> : null}
      <Form action={`${repoUrl(l.repo)}/issues`} t={csrfToken(c)} class="box">
        <div class="body">
          <div class="field">
            <label for="it">Title</label>
            <input id="it" name="title" type="text" required value={v.title} autofocus />
          </div>
          <div class="field">
            <label for="ib">Description</label>
            <textarea id="ib" name="body" style="min-height:220px" placeholder="Markdown is supported.">
              {v.body}
            </textarea>
          </div>
          {labels.length && atLeast(l.caller.role, "triage") ? (
            <div class="field">
              <label>Labels</label>
              <div class="row" style="gap:6px 16px">
                {labels.map((lb) => (
                  <KCheckbox name="labels" value={lb.name} checked={v.labels.includes(lb.name)} label={<Label name={lb.name} color={lb.color} />} />
                ))}
              </div>
            </div>
          ) : null}
          <button class="btn green">Submit new issue</button>
        </div>
      </Form>
    </div>
  );

  web.get("/:owner/:repo/issues/new", async (c) => {
    const l = await forAction(c);
    const labels = await l.stub.labels();
    return render(c, { title: `New issue · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "issues" } }, <NewIssue c={c} l={l} labels={labels} v={{ title: c.req.query("title") ?? "", body: "", labels: [] }} />);
  });

  post(web, "/:owner/:repo/issues", async (c, f) => {
    const l = await forAction(c);
    const v = { title: f.s("title").trim(), body: f.s("body").replace(/\r\n/g, "\n"), labels: atLeast(l.caller.role, "triage") ? f.all("labels") : [] };
    try {
      const issue = await l.stub.createIssue({ title: v.title, body: v.body, labels: v.labels }, l.caller);
      return c.redirect(`${repoUrl(l.repo)}/issues/${issue.number}`, 303);
    } catch (e) {
      const s = statusOf(e);
      if (s.status >= 500) throw e;
      const labels = await l.stub.labels();
      return render(c, { title: "New issue", repo: { repo: l.repo, caller: l.caller, tab: "issues" }, status: s.status }, <NewIssue c={c} l={l} labels={labels} v={v} error={s.message} />);
    }
  });

  web.get("/:owner/:repo/issues/:n", (c) => issuePage(c));
  web.get("/:owner/:repo/pull/:n", (c) => pullPage(c, "conversation"));
  web.get("/:owner/:repo/pull/:n/commits", (c) => pullPage(c, "commits"));
  web.get("/:owner/:repo/pull/:n/files", (c) => pullPage(c, "files"));
  web.get("/:owner/:repo/pull/:n/checks", (c) => pullPage(c, "checks"));
  web.get("/:owner/:repo/pulls/:n", (c) => c.redirect(`/${prm(c, "owner")}/${prm(c, "repo")}/pull/${prm(c, "n")}`, 301));

  const backTo = async (l: Loaded, n: number): Promise<string> => {
    const { issue } = await l.stub.issue(n);
    return `${repoUrl(l.repo)}/${kindPath(issue)}/${n}`;
  };

  post(web, "/:owner/:repo/issues/:n/comment", async (c, f) => {
    const l = await forAction(c);
    const n = issueNumber(c);
    const back = await backTo(l, n);
    const body = f.s("body").replace(/\r\n/g, "\n");
    const action = f.s("action");
    return act(c, back, async () => {
      if (body.trim()) await l.stub.addComment(n, body, l.caller);
      else if (action === "comment") throw new HttpError(422, "write a comment first");
      if (action === "close" || action === "not_planned") await l.stub.updateIssue(n, { state: "closed", stateReason: action === "not_planned" ? "not_planned" : "completed" }, l.caller);
      if (action === "reopen") await l.stub.updateIssue(n, { state: "open" }, l.caller);
    });
  });

  post(web, "/:owner/:repo/issues/:n/edit", async (c, f) => {
    const l = await forAction(c);
    const n = issueNumber(c);
    const back = await backTo(l, n);
    return act(c, back, async () => {
      const title = f.s("title").trim();
      if (!title) throw new HttpError(422, "title is required");
      await l.stub.updateIssue(n, { title, body: f.s("body").replace(/\r\n/g, "\n") }, l.caller);
    });
  });

  post(web, "/:owner/:repo/issues/:n/labels", async (c, f) => {
    const l = await forAction(c, "triage");
    const n = issueNumber(c);
    const back = await backTo(l, n);
    return act(c, back, async () => {
      const labels = new Set(f.all("labels").map((x) => x.trim()).filter(Boolean));
      const fresh = f.s("new_label").trim().slice(0, 50);
      if (fresh) {
        const existing = await l.stub.labels();
        if (!existing.some((x) => x.name === fresh)) await l.stub.setLabel(fresh, LABEL_COLORS[existing.length % LABEL_COLORS.length]!, "");
        labels.add(fresh);
      }
      await l.stub.updateIssue(n, { labels: [...labels] }, l.caller);
    });
  });

  post(web, "/:owner/:repo/issues/:n/assignees", async (c, f) => {
    const l = await forAction(c, "triage");
    const n = issueNumber(c);
    const back = await backTo(l, n);
    return act(c, back, async () => {
      const assignees = [...new Set(f.s("assignees").split(/[\s,]+/).map((s) => s.replace(/^@/, "")).filter(Boolean))].slice(0, 10);
      await l.stub.updateIssue(n, { assignees }, l.caller);
    });
  });

  post(web, "/:owner/:repo/issues/:n/milestone", async (c, f) => {
    const l = await forAction(c, "triage");
    const n = issueNumber(c);
    const back = await backTo(l, n);
    return act(c, back, async () => {
      const m = f.s("milestone");
      await l.stub.setIssueMilestone(n, m ? Number(m) : null);
    });
  });

  post(web, "/:owner/:repo/pull/:n/review", async (c, f) => {
    const l = await forAction(c);
    const n = issueNumber(c);
    const event = (["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const).find((e) => e === f.s("event")) ?? "COMMENT";
    return act(c, `${repoUrl(l.repo)}/pull/${n}`, async () => {
      await l.stub.submitReview(n, { event, body: f.s("body").replace(/\r\n/g, "\n") }, l.caller);
    });
  });

  post(web, "/:owner/:repo/pull/:n/line-comment", async (c, f) => {
    const l = await forAction(c);
    const n = issueNumber(c);
    const line = parseInt(f.s("line"), 10);
    const side = f.s("side") === "LEFT" ? "LEFT" : "RIGHT";
    return act(c, `${repoUrl(l.repo)}/pull/${n}/files`, async () => {
      const body = f.s("body").replace(/\r\n/g, "\n");
      if (!body.trim()) throw new HttpError(422, "comment is empty");
      if (!Number.isInteger(line) || line <= 0 || !f.s("path")) throw new HttpError(422, "invalid line");
      await l.stub.submitReview(n, { event: "COMMENT", comments: [{ path: f.s("path"), line, side, body }] }, l.caller);
    });
  });

  post(web, "/:owner/:repo/pull/:n/ready", async (c) => {
    const l = await forAction(c, "read");
    const n = issueNumber(c);
    return act(c, `${repoUrl(l.repo)}/pull/${n}`, async () => {
      await l.stub.setPullDraft(n, false, l.caller);
    }, "Pull request marked ready for review.");
  });

  post(web, "/:owner/:repo/pull/:n/merge", async (c, f) => {
    const l = await forAction(c, "write");
    const n = issueNumber(c);
    const method = (["merge", "squash", "rebase"] as const).find((m) => m === f.s("method")) ?? "merge";
    return act(
      c,
      `${repoUrl(l.repo)}/pull/${n}`,
      async () => {
        await l.stub.mergePull(n, { method, deleteBranch: f.b("delete_branch"), expectedHeadSha: f.s("expected_head") || undefined, bypassMergeQueue: f.b("bypass_queue"), bypassRules: f.b("bypass_rules") }, l.caller);
        c.executionCtx.waitUntil(c.get("dir").touchPushed(l.repo.id));
      },
      "Pull request merged.",
    );
  });

  post(web, "/:owner/:repo/pull/:n/enqueue", async (c, f) => {
    const l = await forAction(c, "write");
    const n = issueNumber(c);
    const method = (["merge", "squash", "rebase"] as const).find((m) => m === f.s("method"));
    return act(c, `${repoUrl(l.repo)}/pull/${n}`, async () => {
      const r = await l.stub.enqueuePull(n, { method, deleteBranch: f.b("delete_branch") }, l.caller);
      if (r.state === "removed") throw new HttpError(409, `the pull request left the merge queue: ${r.reason ?? "see the conversation"}`);
      flash(c, "notice", r.state === "merged" ? "Merged through the merge queue." : "Added to the merge queue.");
    });
  });

  post(web, "/:owner/:repo/pull/:n/auto-merge", async (c, f) => {
    const l = await forAction(c, "write");
    const n = issueNumber(c);
    return act(c, `${repoUrl(l.repo)}/pull/${n}`, async () => {
      const r = await l.stub.enableAutoMerge(n, { method: f.s("method") || undefined, deleteBranch: f.b("delete_branch") }, l.caller);
      flash(c, "notice", r.state === "merged" ? "Pull request merged." : r.state === "queued" ? "Added to the merge queue." : "Auto-merge is on: it merges once every requirement is met.");
    });
  });

  post(web, "/:owner/:repo/pull/:n/auto-merge/disable", async (c) => {
    const l = await forAction(c, "write");
    const n = issueNumber(c);
    return act(c, `${repoUrl(l.repo)}/pull/${n}`, () => l.stub.disableAutoMerge(n, l.caller), "Auto-merge is off.");
  });

  post(web, "/:owner/:repo/pull/:n/dequeue", async (c) => {
    const l = await forAction(c, "write");
    const n = issueNumber(c);
    return act(c, `${repoUrl(l.repo)}/pull/${n}`, () => l.stub.dequeuePull(n, l.caller), "Removed from the merge queue.");
  });

  // Merge queue of a branch
  web.get("/:owner/:repo/queue/:branch{.+}", async (c) => {
    const { repo, caller, stub } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const base = repoUrl(repo);
    const branch = c.req.param("branch");
    const [settings, entries] = await Promise.all([stub.mergeQueueSettings(branch), stub.mergeQueue(branch)]);
    return render(
      c,
      { title: `Merge queue · ${branch}`, repo: { repo, caller, tab: "pulls" }, live: "repo" },
      <div>
        <h1>
          Merge queue <span class="mono muted">{branch}</span>
        </h1>
        <p class="muted">
          {settings
            ? `Pull requests merge into ${branch} in order once their merge group (the branch, everything ahead of them and their own changes) passes the required checks. Merge method: ${METHOD_LABELS[settings.method ?? "merge"].toLowerCase()}.`
            : `${branch} does not use a merge queue. Turn it on in the branch protection settings.`}
        </p>
        {entries.length === 0 ? (
          <div class="blank mb">The queue is empty.</div>
        ) : (
          <div class="box">
            <ul class="list">
              {entries.map((e) => (
                <li>
                  <span class="muted mono">{e.position}</span>
                  <Status status="in_progress" />
                  <div class="grow">
                    <a class="title" href={`${base}/pull/${e.number}`}>
                      {e.title}
                    </a>{" "}
                    <span class="muted">#{e.number}</span>
                    <div class="meta">
                      queued by {e.enqueuedBy.login} <Time at={e.enqueuedAt} /> ·{" "}
                      {e.groupSha ? (
                        <>
                          checking merge group <a class="sha" href={`${base}/commit/${e.groupSha}`}>{shortSha(e.groupSha)}</a>
                          {e.checks.length ? ` · ${e.checks.map((ch) => `${ch.name}: ${ch.state}`).join(", ")}` : ""}
                        </>
                      ) : (
                        "waiting to be built"
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>,
    );
  });

  // Labels
  web.get("/:owner/:repo/labels", async (c) => {
    const { repo, caller, stub } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const base = repoUrl(repo);
    const t = csrfToken(c);
    const labels = await stub.labels();
    const canEdit = atLeast(caller.role, "triage") && !repo.archived && c.get("principal").type === "account";
    return render(
      c,
      { title: `Labels · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "issues" } },
      <div style="max-width:900px">
        <h1>Labels</h1>
        <div class="box">
          {labels.length ? (
            <ul class="list">
              {labels.map((lb) => (
                <li style="align-items:center">
                  <div style="width:220px">
                    <Label name={lb.name} color={lb.color} href={`${base}/issues${qs({ label: lb.name })}`} />
                  </div>
                  <span class="grow muted small">{lb.description}</span>
                  {canEdit ? (
                    <Form action={`${base}/labels/delete`} t={t} class="inline" confirm={`Delete label ${lb.name}?`}>
                      <input type="hidden" name="name" value={lb.name} />
                      <button class="btn sm danger">Delete</button>
                    </Form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">No labels yet.</div>
          )}
        </div>
        {canEdit ? (
          <Form action={`${base}/labels`} t={t} class="box">
            <div class="head">
              <h3>New label</h3>
            </div>
            <div class="body row" style="align-items:flex-end">
              <div class="field m0">
                <label>Name</label>
                <input name="name" type="text" required maxlength={50} />
              </div>
              <div class="field grow m0">
                <label>Description</label>
                <input name="description" type="text" maxlength={100} />
              </div>
              <div class="field m0">
                <label>Color</label>
                <input name="color" type="color" value={`#${LABEL_COLORS[labels.length % LABEL_COLORS.length]}`} style="width:56px;height:36px;padding:2px" />
              </div>
              <button class="btn primary">Create label</button>
            </div>
          </Form>
        ) : null}
      </div>,
    );
  });

  post(web, "/:owner/:repo/labels", async (c, f) => {
    const l = await forAction(c, "triage");
    return act(c, `${repoUrl(l.repo)}/labels`, async () => {
      const name = f.s("name").trim().slice(0, 50);
      const color = f.s("color").replace(/^#/, "");
      if (!name) throw new HttpError(422, "name is required");
      if (!/^[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(422, "invalid color");
      await l.stub.setLabel(name, color, f.s("description").trim().slice(0, 100));
    });
  });

  post(web, "/:owner/:repo/labels/delete", async (c, f) => {
    const l = await forAction(c, "triage");
    return act(c, `${repoUrl(l.repo)}/labels`, async () => l.stub.setLabel(f.s("name"), null));
  });
}

const LABEL_COLORS = ["d73a4a", "0075ca", "a2eeef", "7057ff", "008672", "e4e669", "d876e3", "fbca04", "0e8a16", "5319e7", "b60205", "1d76db"];
