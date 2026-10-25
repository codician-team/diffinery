/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { fileReport, reportTarget, type ReportSubject } from "../http/moderation.js";
import { loadRepo } from "../http/common.js";
import { block, blockList, isBlocked, MAX_REPORT_TEXT, MINIMIZE_REASONS, minimizeReason, minimizedNote, REPORT_REASONS, unblock, visibleTo, type Block, type Report } from "../lib/moderation.js";
import { HttpError } from "../lib/util.js";
import { ICONS } from "./assets.js";
import { csrfToken } from "./csrf.js";
import { KRadio } from "./kumo.js";
import { act, Actor, Form, flash, post, prm, qs, render, Time, type WebApp } from "./ui.js";

/**
 * Moderation in the web UI (lib/moderation.ts): the "⋯" menus with **Report** (and **Block**,
 * **Hide**) on profiles, repositories, issues, pull requests and comments, the report form, blocked
 * users lists, minimized comments, and the pieces of the site administration pages (their routes
 * are in account.tsx).
 */

// ---------------------------------------------------------------- menus

/** The "⋯" menu: links and one-button forms. */
export const MoreMenu: FC<PropsWithChildren<{ label: string; right?: boolean }>> = ({ label, right = true, children }) => (
  <details class="menu more">
    <summary class="btn sm icon" aria-label={label} title={label}>
      {raw(ICONS.more)}
    </summary>
    <div class={`pop${right ? " right" : ""}`}>{children}</div>
  </details>
);

/** Where the report form for something is. */
export const reportHref = (s: ReportSubject): string => `/-/report${qs({ kind: s.kind, login: s.login, repository: s.repository, number: s.number, comment_id: s.comment_id })}`;

export const ReportItem: FC<{ s: ReportSubject; label: string }> = ({ s, label }) => (
  <a href={reportHref(s)}>
    {raw(ICONS.flag)} {label}
  </a>
);

/** On a person's profile: block or unblock them, and report them. */
export const ProfileMenu: FC<{ c: AppContext; user: Account; blocked: boolean }> = ({ c, user, blocked }) => {
  const t = csrfToken(c);
  const back = `/${user.login}`;
  return (
    <MoreMenu label={`More for ${user.login}`} right={false}>
      {blocked ? (
        <Form action={`/settings/blocked-users/${encodeURIComponent(user.login)}/unblock`} t={t}>
          <input type="hidden" name="back" value={back} />
          <button class="mi">{raw(ICONS.prohibit)} Unblock user</button>
        </Form>
      ) : (
        <Form action="/settings/blocked-users" t={t} confirm={`Block ${user.login}? They won't be able to open issues or pull requests, comment or react in your repositories, and you won't get notifications from them.`}>
          <input type="hidden" name="login" value={user.login} />
          <input type="hidden" name="back" value={back} />
          <button class="mi">{raw(ICONS.prohibit)} Block user</button>
        </Form>
      )}
      <ReportItem s={{ kind: "user", login: user.login }} label="Report user" />
    </MoreMenu>
  );
};

/** On a comment: report it, and (for people with write access) hide or show it. */
export const CommentMenu: FC<{ c: AppContext; repo: string; id: string; minimized: boolean; canHide: boolean }> = ({ c, repo, id, minimized, canHide }) => {
  if (c.get("principal").type !== "account") return null;
  const t = csrfToken(c);
  const action = `/${repo}/comments/${encodeURIComponent(id)}`;
  return (
    <MoreMenu label="Comment actions">
      <ReportItem s={{ kind: "comment", repository: repo, comment_id: id }} label="Report content" />
      {canHide && minimized ? (
        <Form action={`${action}/unminimize`} t={t}>
          <button class="mi">{raw(ICONS.eye)} Unhide</button>
        </Form>
      ) : null}
      {canHide && !minimized ? (
        <>
          <h4>Hide comment</h4>
          {(Object.keys(MINIMIZE_REASONS) as Array<keyof typeof MINIMIZE_REASONS>).map((r) => (
            <Form action={`${action}/minimize`} t={t}>
              <input type="hidden" name="reason" value={r} />
              <button class="mi">
                {raw(ICONS.eyeSlash)} {r === "off_topic" ? "Off-topic" : r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            </Form>
          ))}
        </>
      ) : null}
    </MoreMenu>
  );
};

/** A minimized comment: collapsed behind its reason, as on GitHub. */
export const Minimized: FC<PropsWithChildren<{ reason: string }>> = ({ reason, children }) => (
  <details class="minimized" data-minimized={reason}>
    <summary>
      <span class="muted">{minimizedNote(reason)}</span> <span class="small">Show comment</span>
    </summary>
    {children}
  </details>
);

// ---------------------------------------------------------------- blocked users lists

export const BlockList: FC<{ blocks: Block[]; add: string; unblock: (login: string) => string; t: string; title: string; hint: Child; empty: string }> = ({ blocks, add, unblock, t, title, hint, empty }) => (
  <div class="box">
    <div class="head">
      <h2>{title}</h2>
      <span class="badge">{blocks.length}</span>
    </div>
    <Form action={add} t={t} class="body">
      <div class="formrow">
        <div class="field grow">
          <label for="block-login">Block a user</label>
          <input id="block-login" name="login" type="text" required placeholder="username" autocomplete="off" />
        </div>
        <button class="btn danger">{raw(ICONS.prohibit)} Block user</button>
      </div>
      <div class="hint">{hint}</div>
    </Form>
    {blocks.length ? (
      <ul class="list">
        {blocks.map((b) => (
          <li>
            <Actor login={b.account.login} kind="user" version={b.account.avatar_version} />
            <span class="muted small grow">
              blocked <Time at={b.createdAt} />
              {b.createdBy ? <> by {b.createdBy}</> : null}
            </span>
            <Form action={unblock(b.account.login)} t={t} class="inline">
              <button class="btn sm">Unblock</button>
            </Form>
          </li>
        ))}
      </ul>
    ) : (
      <div class="empty">{empty}</div>
    )}
  </div>
);

// ---------------------------------------------------------------- site administration

const KIND_LABEL: Record<string, string> = { user: "User", repository: "Repository", issue: "Issue", pull_request: "Pull request", comment: "Comment" };
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.hash;
  } catch {
    return url;
  }
};

/** The queue on Site administration → Reports. */
export const ReportsList: FC<{ items: Report[]; state: "open" | "resolved"; counts: { open: number; resolved: number } }> = ({ items, state, counts }) => (
  <>
    <h1>Reports</h1>
    <p class="muted">What people reported as abusive. Open one to see what was reported, then resolve it with a note saying what you did.</p>
    <div class="box">
      <div class="head">
        <a href="/settings/admin/reports" style={state === "open" ? "font-weight:600;color:var(--fg)" : "color:var(--fg2)"}>
          {raw(ICONS.flag)} {counts.open} Open
        </a>
        <a href="/settings/admin/reports?state=resolved" style={state === "resolved" ? "font-weight:600;color:var(--fg)" : "color:var(--fg2)"}>
          {raw(ICONS.check)} {counts.resolved} Resolved
        </a>
      </div>
      {items.length ? (
        <ul class="list">
          {items.map((r) => (
            <li>
              <span class="badge">{KIND_LABEL[r.kind] ?? r.kind}</span>
              <div class="grow">
                <a class="title" href={`/settings/admin/reports/${r.id}`}>
                  {r.target}
                </a>{" "}
                <span class="badge amber">{REPORT_REASONS[r.reason] ?? r.reason}</span>
                <div class="meta">
                  reported by {r.reporter_login ?? "someone"} <Time at={r.created_at} />
                  {r.state === "resolved" ? (
                    <>
                      {" "}
                      · resolved by {r.resolved_by} <Time at={r.resolved_at} />
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div class="empty">{state === "open" ? "No open reports." : "No resolved reports."}</div>
      )}
    </div>
  </>
);

/** One report, with what was reported and the form that resolves (or reopens) it. */
export const ReportDetail: FC<{ r: Report; t: string; suspended: boolean | null }> = ({ r, t, suspended }) => (
  <>
    <p class="small">
      <a href="/settings/admin/reports">← Reports</a>
    </p>
    <h1>
      {KIND_LABEL[r.kind] ?? r.kind} report <span class={`badge ${r.state === "open" ? "amber" : "green"}`}>{r.state}</span>
    </h1>
    <div class="box">
      <div class="body">
        <dl class="kv">
          <dt>Reported</dt>
          <dd>
            <a href={pathOf(r.url)}>{r.target}</a>
          </dd>
          <dt>Reason</dt>
          <dd>{REPORT_REASONS[r.reason] ?? r.reason}</dd>
          <dt>Reported by</dt>
          <dd>
            {r.reporter_login ? <a href={`/${r.reporter_login}`}>{r.reporter_login}</a> : "—"} <Time at={r.created_at} />
          </dd>
          <dt>Account</dt>
          <dd>{r.account_login ? <a href={`/${r.account_login}`}>{r.account_login}</a> : "—"}{suspended ? <span class="badge red">suspended</span> : null}</dd>
          {r.state === "resolved" ? (
            <>
              <dt>Resolved</dt>
              <dd>
                by {r.resolved_by} <Time at={r.resolved_at} />
              </dd>
            </>
          ) : null}
        </dl>
        {r.body ? (
          <>
            <h3>Note from the reporter</h3>
            <div class="meta" style="white-space:pre-wrap">{r.body}</div>
          </>
        ) : null}
        {r.excerpt ? (
          <>
            <h3>What was reported, when it was reported</h3>
            <pre class="excerpt" style="white-space:pre-wrap;max-height:320px;overflow:auto">{r.excerpt}</pre>
          </>
        ) : null}
        {r.state === "resolved" && r.resolution ? (
          <>
            <h3>Resolution</h3>
            <div style="white-space:pre-wrap">{r.resolution}</div>
          </>
        ) : null}
      </div>
    </div>
    {r.state === "open" ? (
      <Form action={`/settings/admin/reports/${r.id}/resolve`} t={t} class="box">
        <div class="body">
          <div class="field">
            <label for="resolution">Resolve with a note</label>
            <textarea id="resolution" name="resolution" required maxlength={MAX_REPORT_TEXT} placeholder="What you did: hid the comment, suspended the account, nothing to do…" />
          </div>
          <button class="btn primary">{raw(ICONS.check)} Resolve</button>
        </div>
      </Form>
    ) : (
      <Form action={`/settings/admin/reports/${r.id}/reopen`} t={t} class="inline">
        <button class="btn">Reopen</button>
      </Form>
    )}
    {r.account_login && suspended === false ? (
      <Form action={`/settings/admin/users/${encodeURIComponent(r.account_login)}/suspend`} t={t} class="box" confirm={`Suspend ${r.account_login}? They are signed out, their tokens, agents and runners stop working and their content is hidden until you unsuspend them.`}>
        <div class="body">
          <div class="formrow">
            <div class="field grow">
              <label for="suspend-reason">Suspend {r.account_login}</label>
              <input id="suspend-reason" name="reason" type="text" required maxlength={500} placeholder="Reason (shown to them and kept in the audit log)" />
            </div>
            <input type="hidden" name="back" value={`/settings/admin/reports/${r.id}`} />
            <button class="btn danger">Suspend</button>
          </div>
        </div>
      </Form>
    ) : null}
  </>
);

/** In the Users table: suspend someone with a reason, or lift their suspension. */
export const SuspendControl: FC<{ u: Account; t: string }> = ({ u, t }) =>
  u.suspended_at ? (
    <Form action={`/settings/admin/users/${encodeURIComponent(u.login)}/unsuspend`} t={t} class="inline" confirm={`Unsuspend ${u.login}? Their account, tokens and content come back.`}>
      <button class="btn sm" title={u.suspended_reason ?? ""}>
        Unsuspend
      </button>
    </Form>
  ) : u.site_admin ? null : (
    <details class="menu">
      <summary class="btn sm">Suspend</summary>
      <div class="pop right" style="width:min(340px,90vw)">
        <Form action={`/settings/admin/users/${encodeURIComponent(u.login)}/suspend`} t={t} style="padding:8px">
          <div class="field">
            <label>Reason</label>
            <input name="reason" type="text" required maxlength={500} placeholder="Shown to them and kept in the audit log" />
          </div>
          <button class="btn sm danger">Suspend {u.login}</button>
        </Form>
      </div>
    </details>
  );

// ---------------------------------------------------------------- routes

const subjectOf = (get: (k: string) => string | undefined): ReportSubject => ({
  kind: get("kind") ?? "",
  login: get("login") || undefined,
  repository: get("repository") || undefined,
  number: get("number") ? Number(get("number")) : undefined,
  comment_id: get("comment_id") || undefined,
});

/** A path on this site to go back to (never another site). */
const localBack = (v: string, fallback: string) => (/^\/[^/\\]/.test(v) ? v : fallback);

export function registerModeration(web: WebApp): void {
  // Report something: the form, then the report.
  web.get("/-/report", async (c) => {
    requireAccount(c);
    const s = subjectOf((k) => c.req.query(k));
    const target = await reportTarget(c, s);
    const t = csrfToken(c);
    return render(
      c,
      { title: "Report content" },
      <div style="max-width:720px;margin:24px auto">
        <h1>Report {KIND_LABEL[target.kind]?.toLowerCase() ?? "content"}</h1>
        <p class="muted">
          Reports go to the site administrators of this instance, who decide what to do. <a href={pathOf(target.url)}>{target.target}</a> isn't told who reported it.
        </p>
        {target.excerpt ? (
          <div class="box">
            <div class="body">
              <pre style="white-space:pre-wrap;max-height:200px;overflow:auto;margin:0">{target.excerpt.slice(0, 1000)}</pre>
            </div>
          </div>
        ) : null}
        <Form action={`/-/report${new URL(c.req.url).search}`} t={t} class="box">
          <div class="body">
            <div class="field">
              <label>What is wrong with it?</label>
              <KRadio name="reason" value="spam" items={Object.entries(REPORT_REASONS).map(([value, label]) => ({ value, label }))} label="Reason" />
            </div>
            <div class="field">
              <label for="report-body">Anything the administrators should know</label>
              <textarea id="report-body" name="body" maxlength={MAX_REPORT_TEXT} placeholder="Optional, except for Something else" />
            </div>
            <button class="btn danger">{raw(ICONS.flag)} Send report</button>
          </div>
        </Form>
      </div>,
    );
  });
  post(web, "/-/report", async (c, f) => {
    requireAccount(c);
    const s = subjectOf((k) => c.req.query(k) ?? f.s(k));
    return act(c, `/-/report${new URL(c.req.url).search}`, async () => {
      const r = await fileReport(c, s, { reason: f.s("reason"), body: f.s("body") }, "web");
      return pathOf(r.url);
    }, "Thanks for reporting it. The site administrators will look at it.");
  });

  // Block and unblock, for yourself (from a profile or Settings → Blocked users).
  post(web, "/settings/blocked-users", async (c, f) => {
    const me = requireAccount(c);
    const back = localBack(f.s("back"), "/settings/blocked-users");
    return act(c, back, async () => {
      if (me.kind !== "user") throw new HttpError(403, "only people can block people");
      const user = await c.get("dir").accountByLogin(f.s("login").trim().replace(/^@/, ""));
      if (!user || !visibleTo(user, me)) throw new HttpError(404, "no one has that username");
      if (await block(c.env, me, user, me)) c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "user.block", target: user.login, detail: { via: "web" } }));
      flash(c, "notice", `You blocked ${user.login}.`);
    });
  });
  post(web, "/settings/blocked-users/:login/unblock", async (c, f) => {
    const me = requireAccount(c);
    const back = localBack(f.s("back"), "/settings/blocked-users");
    return act(c, back, async () => {
      const user = await c.get("dir").accountByLogin(prm(c, "login"));
      if (user && (await unblock(c.env, me.id, user.id))) c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "user.unblock", target: user.login, detail: { via: "web" } }));
      flash(c, "notice", `You unblocked ${user?.login ?? prm(c, "login")}.`);
    });
  });

  // An organization's blocked users, managed by its owners on its Settings tab.
  const orgOwner = async (c: AppContext) => {
    const me = requireAccount(c);
    const dir = c.get("dir");
    const org = await dir.accountByLogin(prm(c, "owner"));
    if (!org || org.kind !== "org" || org.status === "disabled") throw new HttpError(404, "not found");
    if (!me.site_admin && (await dir.orgRole(org.id, me.id)) !== "owner") throw new HttpError(403, "organization owners only");
    return { me, org };
  };
  post(web, "/:owner/-/org/blocks", async (c, f) => {
    const { me, org } = await orgOwner(c);
    return act(c, `/${org.login}?tab=settings`, async () => {
      const user = await c.get("dir").accountByLogin(f.s("login").trim().replace(/^@/, ""));
      if (!user || !visibleTo(user, me)) throw new HttpError(404, "no one has that username");
      if (await block(c.env, org, user, me)) c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "org.block", target: org.login, detail: { user: user.login, via: "web" } }));
      flash(c, "notice", `${org.login} blocked ${user.login}.`);
    });
  });
  post(web, "/:owner/-/org/blocks/:login/unblock", async (c) => {
    const { me, org } = await orgOwner(c);
    return act(c, `/${org.login}?tab=settings`, async () => {
      const user = await c.get("dir").accountByLogin(prm(c, "login"));
      if (user && (await unblock(c.env, org.id, user.id))) c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "org.unblock", target: org.login, detail: { user: user.login, via: "web" } }));
      flash(c, "notice", `${org.login} unblocked ${user?.login ?? prm(c, "login")}.`);
    });
  });

  // Hide (minimize) a comment, or show it again: people with write access.
  for (const [path, hide] of [["minimize", true], ["unminimize", false]] as const) {
    post(web, `/:owner/:repo/comments/:id/${path}`, async (c, f) => {
      const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
      const id = prm(c, "id");
      const found = await l.stub.comment(id).catch(() => l.stub.comment(id, true));
      const back = `/${l.repo.owner_login}/${l.repo.name}/${found.isPull ? "pull" : "issues"}/${found.number}${found.comment.reviewId ? "/files" : ""}#c-${found.comment.id}`;
      return act(c, back, async () => {
        const reason = hide ? minimizeReason(f.s("reason")) : null;
        await l.stub.minimizeComment(found.comment.id, reason, l.caller);
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: l.caller.id, actorLogin: l.caller.login, action: hide ? "comment.minimize" : "comment.unminimize", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { comment: found.comment.id, number: found.number, ...(reason ? { reason } : {}), via: "web" } }));
      }, hide ? "Comment hidden." : "Comment shown again.");
    });
  }
}

/** A person's blocked users, for Settings → Blocked users. */
export const personalBlocks = (c: AppContext, me: Account) => blockList(c.env, me.id);

/** For a profile: whether `me` blocked `user`. */
export const hasBlocked = (c: AppContext, me: Account, user: Account): Promise<boolean> => isBlocked(c.env, me.id, [user.id]);
