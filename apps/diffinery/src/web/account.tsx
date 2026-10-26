/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import { OAuth } from "../auth/oauth.js";
import { ConnectedApps } from "./oauth.js";
import type { Child, FC } from "hono/jsx";
import { requireAccount, requireRecentSignIn, type AppContext } from "../auth/principal.js";
import { OrgAgentSettings, orgAgentData } from "../agentic/org-web.js";
import { baseRole, type Account, type Directory, type Repo, type TokenScope } from "../lib/directory.js";
import { loadRepo } from "../http/common.js";
import { movedLoginPath } from "../lib/redirects.js";
import { GHOST, HttpError } from "../lib/util.js";
import { parseAutoMergeDefault } from "../repo/auto-merge.js";
import type { Role } from "../repo/types.js";
import { ICONS } from "./assets.js";
import { KCheckbox, KRadio, KSelect } from "./kumo.js";
import { csrfToken } from "./csrf.js";
import { Auth } from "../auth/sessions.js";
import { repoCreated } from "../mail/notify.js";
import { browserAccount, deviceLabel, invitePasskeyPage, localPath } from "./auth.js";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { APPEARANCE_COOKIE, Actor, Avatar, CopyButton, Form, ROLES, Time, cap, LOGIN_PATTERN, PendingInvites, act, ago, flash, post, publicUrl, render, repoUrl, type Stub, type WebApp, prm } from "./ui.js";
import type { FormData } from "./csrf.js";
import { purgeAvatarCache, removeAvatar, setAvatar } from "../http/avatars.js";
import { MAX_AVATAR_BYTES } from "../lib/image.js";
import { gatherToday } from "../agentic/today.js";
import { ContactMessages } from "../lib/contact.js";
import { EarlyAccess } from "../lib/early-access.js";
import { COLLAPSED_COOKIE, Rows, Section, TodayView, collapsedSections } from "../agentic/web.js";
import { landingPage } from "./site.js";
import { serverErrors } from "../lib/server-errors.js";
import { indexNowStatus } from "./indexnow.js";
import { ComputePausedBanner, KillSwitchesPage } from "./kill-switches.js";
import { changePause, changeSuspension, cleanReason, type Stopped } from "../lib/killswitch.js";
import { blockList, cleanResolution, openReportCount, report, reports, setReportState, suspend, suspendReason, unsuspend, visibleTo } from "../lib/moderation.js";
import { BlockList, hasBlocked, ProfileMenu, ReportDetail, ReportsList, SuspendControl } from "./moderation.js";

// ---------------------------------------------------------------- shared bits

const RepoList: FC<{ repos: Repo[]; showOwner?: boolean; empty?: Child }> = ({ repos, showOwner = true, empty }) =>
  repos.length ? (
    <ul class="list">
      {repos.map((r) => (
        <li>
          <span class="st faint">{raw(r.visibility === "private" ? ICONS.lock : ICONS.repo)}</span>
          <div class="grow">
            <a class="title" href={repoUrl(r)}>
              {showOwner ? `${r.owner_login}/` : ""}
              {r.name}
            </a>{" "}
            <span class="badge">{r.visibility}</span> {r.archived ? <span class="badge amber">archived</span> : null}
            {r.description ? <div class="meta">{r.description}</div> : null}
          </div>
          <span class="small muted nowrap">Updated {ago(r.pushed_at ?? r.updated_at)}</span>
        </li>
      ))}
    </ul>
  ) : (
    <div class="empty">{empty ?? "No repositories yet."}</div>
  );

function parsePolicy(a: Account): { maxRole?: Role } {
  try {
    return a.agent_policy ? (JSON.parse(a.agent_policy) as { maxRole?: Role }) : {};
  } catch {
    return {};
  }
}

async function adminOrgs(c: AppContext, me: Account): Promise<Array<Account & { role: string }>> {
  return (await c.get("dir").orgsFor(me.id)).filter((o) => o.role === "owner" || o.role === "admin");
}

/** Whether `me` may manage an agent (its owner, an admin of its owning org, or a site admin). */
async function canManageAgent(c: AppContext, me: Account, agent: Account): Promise<boolean> {
  if (agent.kind !== "agent" || !agent.owner_id) return false;
  if (me.site_admin || agent.owner_id === me.id) return true;
  const role = await c.get("dir").orgRole(agent.owner_id, me.id);
  return role === "owner" || role === "admin";
}

// ---------------------------------------------------------------- profile pictures (people and organizations)

const TOO_BIG = "That picture is larger than 5 MB. Use a smaller file.";

/** Current picture, an upload control and a Remove button. Uploads go to `action`, removal to `${action}/delete`. */
const AvatarSection: FC<{ account: Account; action: string; t: string }> = ({ account, action, t }) => (
  <div class="box">
    <div class="head">
      <h2>Profile picture</h2>
    </div>
    <div class="body avpick">
      <span data-avatar-preview>
        <Avatar login={account.login} kind={account.kind} size="xl" version={account.avatar_version} />
      </span>
      <div class="grow">
        <Form action={action} t={t} avatar>
          <div class="field">
            <label for="avatar-file">Upload a new picture</label>
            <input id="avatar-file" name="avatar" type="file" accept="image/jpeg,image/png,image/webp" required />
            <div class="hint">JPEG, PNG or WebP, up to 5 MB. It is cropped to a centred square.</div>
          </div>
          <div class="row">
            <button class="btn primary">Save picture</button>
            <span class="muted small" data-avatar-status aria-live="polite"></span>
          </div>
        </Form>
        {account.avatar_version ? (
          <Form action={`${action}/delete`} t={t} class="mt" confirm={account.kind === "org" ? `Remove the picture of ${account.login}?` : "Remove your profile picture?"}>
            <button class="btn sm danger">Remove picture</button>
            <span class="muted small" style="margin-left:8px">
              Shows initials instead.
            </span>
          </Form>
        ) : null}
      </div>
    </div>
  </div>
);

/** Refuse oversized uploads before the form body is parsed. */
function avatarSizeGuard(web: WebApp, path: string, back: (c: AppContext) => string): void {
  web.use(path, async (c, next) => {
    if (c.req.method === "POST" && Number(c.req.header("content-length") ?? 0) > MAX_AVATAR_BYTES + 64 * 1024) {
      flash(c, "error", TOO_BIG);
      return c.redirect(back(c), 303);
    }
    await next();
  });
}

async function uploadAvatar(c: AppContext, f: FormData, me: Account, account: Account): Promise<void> {
  const file = f.file("avatar");
  if (!file) throw new HttpError(422, "Choose a picture to upload.");
  if (file.size > MAX_AVATAR_BYTES) throw new HttpError(413, TOO_BIG);
  await setAvatar(c, account, new Uint8Array(await file.arrayBuffer()));
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "avatar.update", target: account.login, detail: { kind: account.kind, via: "web" } }));
}

async function deleteAvatar(c: AppContext, me: Account, account: Account): Promise<void> {
  await removeAvatar(c, account);
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "avatar.remove", target: account.login, detail: { kind: account.kind, via: "web" } }));
}

const SCOPES: TokenScope[] = ["read", "write", "admin"];
const BASE_ROLE_OPTIONS = [
  { value: "none", label: "No permission: members see only repositories they're given" },
  { value: "read", label: "Read: members can clone and view" },
  { value: "write", label: "Write: members can also push" },
  { value: "admin", label: "Admin: members can also change settings" },
];

// ---------------------------------------------------------------- dashboard (visitors get the landing page, web/site.tsx)

/** The icon for a notification, by the event that raised it. */
function noteIcon(kind: string): string {
  if (kind === "run_failed") return ICONS.failure;
  if (kind.startsWith("pull_request")) return ICONS.pr;
  if (kind === "issues") return ICONS.issueOpen;
  if (kind.endsWith("comment")) return ICONS.comment;
  if (kind === "org_membership") return ICONS.org;
  if (kind === "repo_access") return ICONS.repo;
  if (kind === "invitation" || kind === "early_access" || kind === "contact") return ICONS.envelope;
  return ICONS.bell;
}

/** A person's pending invitations to organizations and repositories, each with Accept and Decline. */
const MyInvitations: FC<{ invites: Awaited<ReturnType<Directory["invitesFor"]>>; t: string }> = ({ invites, t }) => (
  <div class="box">
    {invites.length ? (
      <ul class="list">
        {invites.map((i) => (
          <li>
            <div class="grow">
              <b>{i.org ?? i.repo}</b>
              <span class="badge" style="margin-left:6px">
                {cap(i.role)}
              </span>
              <div class="muted small">
                {i.org ? "Organization" : "Repository"} · invited {i.invitedBy ? `by ${i.invitedBy} ` : ""}
                <Time at={i.createdAt} /> · expires {new Date(i.expiresAt).toLocaleDateString("en-US", { dateStyle: "medium" })}
              </div>
            </div>
            <Form action={`/settings/invitations/${encodeURIComponent(i.id)}/accept`} t={t} class="inline">
              <button class="btn sm primary">Accept</button>
            </Form>
            <Form action={`/settings/invitations/${encodeURIComponent(i.id)}/decline`} t={t} class="inline">
              <button class="btn sm">Decline</button>
            </Form>
          </li>
        ))}
      </ul>
    ) : (
      <div class="empty">No pending invitations.</div>
    )}
  </div>
);

export function registerAccount(web: WebApp): void {
  web.get("/", async (c) => {
    const p = c.get("principal");
    if (p.type !== "account") return landingPage(c);
    const me = p.account;
    const t = csrfToken(c);
    if (me.status === "disabled") {
      return render(
        c,
        { title: "Account disabled", status: 403 },
        <div class="blank" style="max-width:560px;margin:48px auto">
          <h1>Your account is disabled</h1>
          <p class="muted m0">Contact an administrator of this Diffinery instance if you think this is a mistake.</p>
        </div>,
      );
    }
    if (me.status === "pending") {
      const invites = await c.get("dir").invitesFor(me);
      return render(
        c,
        { title: "Waiting for an invite" },
        <div class="box" style="max-width:600px;margin:48px auto">
          <div class="body">
            <h1>Waiting for an invite</h1>
            <p class="muted">
              You are signed in as <b>{me.email ?? me.login}</b>, but this Diffinery instance is invite-only. Ask someone with access to invite your email address, or send a request to the administrators.
            </p>
            {invites.length ? (
              <>
                <h3>Your invitations</h3>
                <MyInvitations invites={invites} t={t} />
              </>
            ) : null}
            <Form action="/request-access" t={t}>
              <div class="field">
                <label for="note">Note to the administrators</label>
                <textarea id="note" name="note" maxlength={500} placeholder="Who are you, and what would you like to work on?" style="min-height:90px"></textarea>
              </div>
              <button class="btn primary">Request access</button>
            </Form>
          </div>
        </div>,
      );
    }
    const dir = c.get("dir");
    // Read once, for the sidebar and for Today.
    const visible = dir.reposVisibleTo(me);
    const memberships = dir.orgsFor(me.id);
    const [repos, orgs, notes, today] = await Promise.all([
      visible,
      memberships,
      dir.notifications(me.id, true),
      // The morning view (agentic/today.ts); the dashboard still renders if it fails.
      gatherToday(c.env, dir, me, { visible, orgs: memberships }).catch((e: unknown) => {
        console.error("today failed", e);
        return null;
      }),
    ]);
    const mine = repos.filter((r) => r.owner_id === me.id || orgs.some((o) => o.id === r.owner_id));
    const others = repos.filter((r) => !mine.includes(r));
    // Someone who owns nothing yet but works in others' repositories sees those instead.
    const side = mine.length ? mine : others;
    const collapsed = collapsedSections(getCookie(c, COLLAPSED_COOKIE));
    return render(
      c,
      { title: "Today" },
      <div class="grid left">
        {/* On phones, Today comes first and the repository list after it. */}
        <aside class="side after">
          <section>
            <div class="row between mb">
              <h3 class="m0">{mine.length || !others.length ? "Your repositories" : "Repositories"}</h3>
              <a class="btn sm primary" href="/new">
                {raw(ICONS.plus)} New
              </a>
            </div>
            {side.length ? (
              <div class="nav">
                {side.slice(0, 40).map((r) => (
                  <a href={repoUrl(r)} class="nowrap" style="overflow:hidden;text-overflow:ellipsis">
                    <Avatar login={r.owner_login} /> {r.owner_login}/<b>{r.name}</b>
                  </a>
                ))}
              </div>
            ) : (
              <p class="muted small">You have no repositories yet.</p>
            )}
          </section>
          <section>
            <h3>Organizations</h3>
            <div class="nav">
              {orgs.map((o) => (
                <a href={`/${o.login}`}>
                  <Avatar login={o.login} version={o.avatar_version} /> {o.login} <span class="faint small">{o.role}</span>
                </a>
              ))}
              <a href="/settings/orgs" class="muted">
                {raw(ICONS.plus)} New organization
              </a>
            </div>
          </section>
        </aside>
        <div>
          {repos.length === 0 ? (
            <div class="box">
              <div class="body">
                <h2>Welcome to Diffinery, {me.name || me.login}</h2>
                <ol class="muted" style="padding-left:20px">
                  <li>
                    <a href="/new">Create a repository</a> (or an <a href="/settings/orgs">organization</a> to share work with friends).
                  </li>
                  <li>
                    <a href="/settings/tokens">Create a personal access token</a> — Git uses it as the password over HTTPS.
                  </li>
                  <li>Push your code, open pull requests and add workflows under <code>.github/workflows</code>.</li>
                  <li>
                    Invite people from an organization's <b>People</b> page or a repository's <b>Settings → Collaborators</b>.
                  </li>
                </ol>
              </div>
            </div>
          ) : today ? (
            <TodayView today={today} name={me.name || me.login} collapsed={collapsed} />
          ) : null}
          {notes.length ? (
            <Section
              id="notifications"
              icon={ICONS.bell}
              title="Unread notifications"
              count={notes.length}
              collapsed={collapsed}
              action={
                <a class="small manage" href="/notifications">
                  View all
                </a>
              }
            >
              <Rows
                items={notes.slice(0, 8)}
                row={(n) => (
                  <li>
                    <div class="grow">
                      <a class="title" href={`/notifications/${n.id}`}>
                        {n.title}
                      </a>
                      <div class="meta">
                        {n.kind.replace(/_/g, " ")} · <Time at={n.createdAt} />
                      </div>
                    </div>
                  </li>
                )}
              />
            </Section>
          ) : null}
          <div class="box">
            <div class="head">
              <h2>Repositories</h2>
              <span class="muted small">{repos.length} you can access</span>
            </div>
            <RepoList repos={[...mine, ...others].slice(0, 100)} empty={<a href="/new">Create your first repository</a>} />
          </div>
        </div>
      </div>,
    );
  });

  post(web, "/request-access", async (c, f) => {
    const p = c.get("principal");
    if (p.type !== "account") throw new HttpError(401, "sign in required");
    if (p.account.status !== "pending") return c.redirect("/", 303);
    return act(c, "/", async () => c.get("dir").requestAccess(p.account.id, f.s("note")), "Request sent. An administrator will review it.");
  });

  // ---------------------------------------------------------------- new repository

  const NewRepoForm: FC<{ t: string; me: Account; orgs: Array<Account & { role: string }>; values: Record<string, string>; error?: string }> = ({ t, me, orgs, values, error }) => (
    <div style="max-width:720px;margin:0 auto">
      <h1>Create a new repository</h1>
      <p class="muted">
        A repository holds your project's files, history, issues, pull requests and workflows. Already on GitHub? <a href="/new/import">Import a repository</a>.
      </p>
      {error ? <div class="flash error">{error}</div> : null}
      <Form action="/new" t={t} class="box">
        <div class="body">
          <div class="row" style="align-items:flex-end">
            <div class="field" style="min-width:180px">
              <label for="owner">Owner</label>
              <KSelect
                id="owner"
                name="owner"
                block
                label="Owner"
                value={orgs.some((o) => o.login === values.owner) ? values.owner : me.login}
                options={[me.login, ...orgs.map((o) => o.login)].map((l) => ({ value: l, label: l }))}
              />
            </div>
            <div class="field" style="padding-bottom:8px">/</div>
            <div class="field grow">
              <label for="name">Repository name</label>
              <input id="name" name="name" type="text" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,99}" value={values.name} autofocus autocomplete="off" />
            </div>
          </div>
          <div class="field">
            <label for="description">
              Description <span class="faint">(optional)</span>
            </label>
            <input id="description" name="description" type="text" value={values.description} maxlength={350} />
          </div>
          <div class="field">
            <label>Visibility</label>
            <KRadio
              name="visibility"
              label="Visibility"
              value={values.visibility || "private"}
              items={(
                [
                  ["private", "Private", "Only you, collaborators and organization members can see it."],
                  ["public", "Public", "Anyone on the internet can see and clone it."],
                ] as const
              ).map(([v, l, d]) => ({ value: v, label: l, description: d }))}
            />
          </div>
          <div class="field" style="max-width:280px">
            <label for="branch">Default branch</label>
            <input id="branch" name="default_branch" type="text" value={values.default_branch || "main"} />
          </div>
          <button class="btn primary">Create repository</button>
        </div>
      </Form>
    </div>
  );

  web.get("/new", async (c) => {
    const me = requireAccount(c);
    const orgs = await c.get("dir").orgsFor(me.id);
    return render(c, { title: "New repository" }, <NewRepoForm t={csrfToken(c)} me={me} orgs={orgs} values={{ owner: c.req.query("owner") ?? me.login }} />);
  });

  post(web, "/new", async (c, f) => {
    const me = requireAccount(c);
    const dir = c.get("dir");
    const values = { owner: f.s("owner"), name: f.s("name").trim(), description: f.s("description").trim(), visibility: f.s("visibility"), default_branch: f.s("default_branch").trim() };
    try {
      const owner = values.owner === me.login ? me : await dir.accountByLogin(values.owner);
      if (!owner || owner.kind === "agent") throw new HttpError(422, "unknown owner");
      const visibility = (["private", "public"] as const).find((v) => v === values.visibility) ?? "private";
      const repo = await dir.createRepo(owner, me, { name: values.name, description: values.description, visibility, defaultBranch: values.default_branch || "main" });
      c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "repo.create", target: `${repo.owner_login}/${repo.name}` }));
      c.executionCtx.waitUntil(repoCreated(c.env, dir, repo, me, { viaToken: false }));
      return c.redirect(repoUrl(repo), 303);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      const orgs = await dir.orgsFor(me.id);
      return render(c, { title: "New repository", status: e.status }, <NewRepoForm t={csrfToken(c)} me={me} orgs={orgs} values={values} error={e.detail} />);
    }
  });

  // ---------------------------------------------------------------- notifications

  web.get("/notifications", async (c) => {
    const me = requireAccount(c);
    const t = csrfToken(c);
    const all = c.req.query("all") === "1";
    const notes = await c.get("dir").notifications(me.id, !all);
    return render(
      c,
      { title: "Notifications" },
      <div style="max-width:900px;margin:0 auto">
        <div class="row between mb">
          <h1 class="m0">Notifications</h1>
          <div class="row">
            <div class="subnav">
              <a href="/notifications" class={!all ? "on" : ""}>
                Unread
              </a>
              <a href="/notifications?all=1" class={all ? "on" : ""}>
                All
              </a>
            </div>
            <Form action="/notifications/read" t={t} class="inline">
              <button class="btn">{raw(ICONS.check)} Mark all as read</button>
            </Form>
            <a class="btn icon" href="/settings/notifications" title="Notification settings" aria-label="Notification settings">
              {raw(ICONS.gear)}
            </a>
          </div>
        </div>
        <div class="box">
          {notes.length ? (
            <ul class="list">
              {notes.map((n) => (
                <li>
                  <span class={`st ${n.readAt ? "faint" : ""}`} style={n.readAt ? "" : n.kind === "run_failed" ? "color:var(--red)" : "color:var(--accent)"}>
                    {raw(noteIcon(n.kind))}
                  </span>
                  <div class="grow">
                    <a class="title" href={`/notifications/${n.id}`} style={n.readAt ? "font-weight:400" : ""}>
                      {n.title}
                    </a>
                    <div class="meta">
                      {n.kind.replace(/_/g, " ")} · <Time at={n.createdAt} />
                    </div>
                  </div>
                  {!n.readAt ? (
                    <Form action="/notifications/read" t={t} class="inline">
                      <input type="hidden" name="id" value={n.id} />
                      <button class="btn sm" title="Mark as read">
                        {raw(ICONS.check)}
                      </button>
                    </Form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">{all ? "No notifications." : "All caught up — no unread notifications."}</div>
          )}
        </div>
      </div>,
    );
  });

  web.get("/notifications/:id", async (c) => {
    const me = requireAccount(c);
    const dir = c.get("dir");
    const id = prm(c, "id");
    const n = (await dir.notifications(me.id)).find((x) => x.id === id);
    if (!n) throw new HttpError(404, "notification not found");
    await dir.markRead(me.id, id);
    const base = publicUrl(c);
    let to = n.url;
    if (to.startsWith(base)) to = to.slice(base.length) || "/";
    return c.redirect(localPath(to) ?? "/notifications", 302);
  });

  post(web, "/notifications/read", async (c, f) => {
    const me = requireAccount(c);
    const id = f.s("id");
    return act(c, c.req.header("referer")?.includes("/notifications") ? "/notifications" : "/", async () => c.get("dir").markRead(me.id, id || undefined));
  });

  // ---------------------------------------------------------------- invites

  web.get("/invite/:token", async (c) => {
    const p = c.get("principal");
    if (p.type !== "account") return invitePasskeyPage(c, prm(c, "token"));
    if (p.account.status === "disabled") throw new HttpError(403, "your account is disabled");
    return render(
      c,
      { title: "Accept invite" },
      <div class="box" style="max-width:560px;margin:48px auto">
        <div class="body">
          <h1>You have been invited</h1>
          <p class="muted">
            Accept this invite as <b>{p.account.login}</b> ({p.account.email ?? "no email"}). Invites only work for the email address they were sent to.
          </p>
          <Form action={`/invite/${encodeURIComponent(prm(c, "token"))}`} t={csrfToken(c)}>
            <button class="btn primary">Accept invite</button>
          </Form>
        </div>
      </div>,
    );
  });

  post(web, "/invite/:token", async (c) => {
    const p = c.get("principal");
    if (p.type !== "account") throw new HttpError(401, "sign in to accept this invite");
    if (p.account.status === "disabled") throw new HttpError(403, "your account is disabled");
    const dir = c.get("dir");
    const res = await dir.acceptInvite(prm(c, "token"), p.account);
    let to = "/";
    if (res.repoId) {
      const r = await dir.repoById(res.repoId);
      if (r) to = repoUrl(r);
    } else if (res.orgId) {
      const o = await dir.account(res.orgId);
      if (o) to = `/${o.login}`;
    }
    c.executionCtx.waitUntil(dir.audit({ actorId: p.account.id, actorLogin: p.account.login, action: "invite.accept", target: to }));
    return c.redirect(to, 303);
  });

  // ---------------------------------------------------------------- palette data

  web.get("/-/palette.json", async (c) => {
    const me = requireAccount(c);
    const repos = (await c.get("dir").reposVisibleTo(me)).slice(0, 300).map((r) => `${r.owner_login}/${r.name}`);
    const param = c.req.query("repo") ?? "";
    let files: string[] = [];
    let ref: string | undefined;
    const m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/.exec(param);
    if (m) {
      try {
        const { stub, repo } = await loadRepo(c, m[1]!, m[2]!, "read");
        ref = c.req.query("ref") || repo.default_branch;
        files = await listFiles(stub, ref);
      } catch {
        files = [];
      }
    }
    return c.json({ repos, files, ref }, 200, { "cache-control": "private, max-age=30" });
  });

  // ---------------------------------------------------------------- personal settings

  registerSettings(web);
  registerProfiles(web);
}

/** Breadth-first file listing for "go to file" (bounded). */
async function listFiles(stub: Stub, ref: string): Promise<string[]> {
  const out: string[] = [];
  let queue = [""];
  let reads = 0;
  while (queue.length && reads < 120 && out.length < 5000) {
    const batch = queue.slice(0, 12);
    queue = queue.slice(12);
    reads += batch.length;
    const trees = await Promise.all(batch.map((p) => stub.tree(ref, p).catch(() => null)));
    for (const t of trees) {
      if (!t) continue;
      for (const it of t.items) {
        if (it.type === "tree") {
          if (!/^(node_modules|\.git|vendor|dist|target)$/.test(it.name)) queue.push(it.path);
        } else if (it.type === "blob") out.push(it.path);
      }
    }
  }
  return out.slice(0, 5000);
}

// ---------------------------------------------------------------- /settings

const AUTO_MERGE_METHODS = [
  { value: "default", label: "As the branch merges" },
  { value: "squash", label: "Squash and merge" },
  { value: "merge", label: "Create a merge commit" },
  { value: "rebase", label: "Rebase and merge" },
];

export type SettingsTab = "profile" | "account" | "appearance" | "pull-requests" | "security" | "tokens" | "apps" | "installations" | "agents" | "model-access" | "orgs" | "invitations" | "notifications" | "email-address" | "blocked" | "linked" | "admin" | "reports" | "email" | "audit" | "kill-switches" | "errors" | "security-reports" | "status" | "early-access" | "contact" | "search-engines";
/** The site administration pages: they show when hosted compute is paused. */
export const ADMIN_TABS: readonly SettingsTab[] = ["admin", "early-access", "contact", "reports", "email", "audit", "kill-switches", "errors", "security-reports", "status", "search-engines"];

/** The number of confirmed early access requests waiting, next to Early access in the sidebar (lib/early-access.ts). */
const EarlyAccessWaiting = async ({ db }: { db?: D1Database }) => {
  const n = db ? await new EarlyAccess(db).waiting().catch(() => 0) : 0;
  return n ? (
    <span class="badge blue" style="margin-left:6px" title={`${n} confirmed request${n === 1 ? "" : "s"} waiting`}>
      {n}
    </span>
  ) : (
    <></>
  );
};

/** The number of new contact messages, next to Contact messages in the sidebar (lib/contact.ts). */
const ContactWaiting = async ({ db }: { db?: D1Database }) => {
  const n = db ? await new ContactMessages(db).waiting().catch(() => 0) : 0;
  return n ? (
    <span class="badge blue" style="margin-left:6px" title={`${n} new message${n === 1 ? "" : "s"}`}>
      {n}
    </span>
  ) : (
    <></>
  );
};

/** On People and invitations: a pointer to the early access requests waiting, when there are any. */
const EarlyAccessCallout = async ({ db }: { db: D1Database }) => {
  const n = await new EarlyAccess(db).waiting().catch(() => 0);
  return n ? (
    <div class="flash notice row between" style="gap:12px">
      <span>
        {n} confirmed early access request{n === 1 ? " is" : "s are"} waiting for you to invite or decline.
      </span>
      <a class="btn sm" href="/settings/admin/early-access">
        Review requests
      </a>
    </div>
  ) : (
    <></>
  );
};

/** The Settings sidebar. `db` lets it show how many early access requests and contact messages wait (site administrators only). */
export const SettingsNav: FC<{ me: Account; tab: SettingsTab; db?: D1Database }> = ({ me, tab, db }) => (
  <aside class="side vt-side">
    <section>
      <div class="row mb">
        <Avatar login={me.login} size="lg" version={me.avatar_version} />
        <div>
          <b>{me.name || me.login}</b>
          <div class="muted small">{me.login}</div>
        </div>
      </div>
      <div class="nav">
        <a href="/settings" class={tab === "profile" ? "on" : ""}>
          Profile
        </a>
        <a href="/settings/account" class={tab === "account" ? "on" : ""}>
          Account
        </a>
        <a href="/settings/appearance" class={tab === "appearance" ? "on" : ""}>
          Appearance
        </a>
        <a href="/settings/pull-requests" class={tab === "pull-requests" ? "on" : ""}>
          Pull requests
        </a>
        <a href="/settings/security" class={tab === "security" ? "on" : ""}>
          Passkeys and sessions
        </a>
        <a href="/settings/tokens" class={tab === "tokens" ? "on" : ""}>
          Access tokens
        </a>
        <a href="/settings/agents" class={tab === "agents" ? "on" : ""}>
          Agents
        </a>
        <a href="/settings/installations" class={tab === "installations" ? "on" : ""}>
          Installed apps
        </a>
        <a href="/settings/apps" class={tab === "apps" ? "on" : ""}>
          Apps
        </a>
        <a href="/settings/model-access" class={tab === "model-access" ? "on" : ""}>
          Model access
        </a>
        <a href="/settings/orgs" class={tab === "orgs" ? "on" : ""}>
          Organizations
        </a>
        <a href="/settings/invitations" class={tab === "invitations" ? "on" : ""}>
          Invitations
        </a>
        <a href="/settings/notifications" class={tab === "notifications" ? "on" : ""}>
          Notifications
        </a>
        <a href="/settings/email" class={tab === "email-address" ? "on" : ""}>
          Email
        </a>
        <a href="/settings/blocked-users" class={tab === "blocked" ? "on" : ""}>
          Blocked users
        </a>
        <a href="/settings/linked-accounts" class={tab === "linked" ? "on" : ""}>
          Linked accounts
        </a>
        <a href="/imports">Imports</a>
        {me.site_admin ? (
          <>
            <h4>Site administration</h4>
            <a href="/settings/admin" class={tab === "admin" ? "on" : ""}>
              People and invitations
            </a>
            <a href="/settings/admin/early-access" class={tab === "early-access" ? "on" : ""}>
              Early access
              <EarlyAccessWaiting db={db} />
            </a>
            <a href="/settings/admin/contact" class={tab === "contact" ? "on" : ""}>
              Contact messages
              <ContactWaiting db={db} />
            </a>
            <a href="/settings/admin/reports" class={tab === "reports" ? "on" : ""}>
              Reports
            </a>
            <a href="/settings/admin/email" class={tab === "email" ? "on" : ""}>
              Email
            </a>
            <a href="/settings/admin/kill-switches" class={tab === "kill-switches" ? "on" : ""}>
              Kill switches
            </a>
            <a href="/settings/admin/security-reports" class={tab === "security-reports" ? "on" : ""}>
              Security reports
            </a>
            <a href="/settings/admin/status" class={tab === "status" ? "on" : ""}>
              Status
            </a>
            <a href="/settings/admin/search-engines" class={tab === "search-engines" ? "on" : ""}>
              Search engines
            </a>
            <a href="/settings/audit" class={tab === "audit" ? "on" : ""}>
              Audit log
            </a>
            <a href="/settings/admin/errors" class={tab === "errors" ? "on" : ""}>
              Server errors
            </a>
          </>
        ) : null}
      </div>
    </section>
  </aside>
);

const TokenOnce: FC<{ token: string; title: string; c: AppContext; note?: Child }> = ({ token, title, c, note }) => (
  <div class="box" style="border-color:var(--amber)">
    <div class="body">
      <h3>{title}</h3>
      <p class="muted">Copy it now — it will not be shown again.</p>
      <div class="row">
        <div class="secret grow">{token}</div>
        <CopyButton text={token} size="base" />
      </div>
      {note}
      <details class="mt">
        <summary class="small" style="cursor:pointer">
          How to use it
        </summary>
        <pre class="cmd mt">
          {`# Git over HTTPS: use your username and this token as the password\ngit clone ${publicUrl(c)}/OWNER/REPO.git\n\n# Remember it (or use your OS keychain helper)\ngit config --global credential.helper store\n\n# HTTP APIs and MCP clients\nAuthorization: Bearer <token>`}
        </pre>
      </details>
    </div>
  </div>
);

function registerSettings(web: WebApp): void {
  const page = (c: AppContext, me: Account, tab: SettingsTab, title: string, body: Child, status?: number) =>
    render(
      c,
      { title, status },
      <div class="grid left">
        <SettingsNav me={me} tab={tab} db={c.env.DB} />
        <div>
          {ADMIN_TABS.includes(tab) ? <ComputePausedBanner env={c.env} /> : null}
          {body}
        </div>
      </div>,
    );

  // Profile
  web.get("/settings", async (c) => {
    const me = requireAccount(c);
    const t = csrfToken(c);
    return page(
      c,
      me,
      "profile",
      "Settings",
      <>
        <h1>Profile</h1>
        <AvatarSection account={me} action="/settings/avatar" t={t} />
        <Form action="/settings/profile" t={t} class="box">
          <div class="body">
            <div class="field">
              <label for="login">Username</label>
              <input id="login" name="login" type="text" value={me.login} required pattern={LOGIN_PATTERN} />
              <div class="hint">Changing your username changes the URLs of your repositories. Existing clones need a new remote URL.</div>
            </div>
            <div class="field">
              <label for="name">Display name</label>
              <input id="name" name="name" type="text" value={me.name ?? ""} />
            </div>
            <dl class="kv mb">
              <dt>Email</dt>
              <dd>{me.email ?? "—"}</dd>
              <dt>Account type</dt>
              <dd>{me.kind}</dd>
              <dt>Joined</dt>
              <dd>
                <Time at={me.created_at} />
              </dd>
              <dt>Site admin</dt>
              <dd>{me.site_admin ? "yes" : "no"}</dd>
            </dl>
            <button class="btn primary">Save profile</button>
          </div>
        </Form>
      </>,
    );
  });

  post(web, "/settings/profile", async (c, f) => {
    const me = requireAccount(c);
    return act(
      c,
      "/settings",
      async () => {
        const login = f.s("login").trim();
        if (login && login !== me.login) requireRecentSignIn(c, "/settings");
        await c.get("dir").updateAccount(me.id, { login: login && login !== me.login ? login : undefined, name: f.s("name").trim() });
        // The old login's cached picture must not outlive the rename.
        if (login && login !== me.login) c.executionCtx.waitUntil(purgeAvatarCache(c, me.login, [me.avatar_version]));
      },
      "Profile saved.",
    );
  });

  // Appearance
  web.get("/settings/appearance", async (c) => {
    const me = requireAccount(c);
    const current = me.appearance === "light" || me.appearance === "dark" ? me.appearance : "auto";
    return page(
      c,
      me,
      "appearance",
      "Appearance",
      <>
        <h1>Appearance</h1>
        <p class="muted">Choose how Diffinery looks to you. The choice follows your account to every browser you sign in to.</p>
        <Form action="/settings/appearance" t={csrfToken(c)} class="box">
          <div class="body">
            <div class="field">
              <label>Theme</label>
              <KRadio
                name="appearance"
                label="Theme"
                value={current}
                items={(
                  [
                    ["auto", "Sync with system", "Light or dark, following your device's setting."],
                    ["light", "Light", "Always light."],
                    ["dark", "Dark", "Always dark."],
                  ] as const
                ).map(([v, l, d]) => ({ value: v, label: <span class="theme-opt"><span class={`theme-prev ${v}`} aria-hidden="true"><i /><i /><i /></span>{l}</span>, description: d }))}
              />
            </div>
            <button class="btn primary">Save appearance</button>
          </div>
        </Form>
      </>,
    );
  });

  post(web, "/settings/appearance", async (c, f) => {
    const me = requireAccount(c);
    const v = f.s("appearance");
    const appearance = v === "light" || v === "dark" ? v : null;
    await c.get("dir").setAppearance(me.id, appearance);
    // Signed-out pages (sign-in, invites) in this browser keep the choice too.
    if (appearance) setCookie(c, APPEARANCE_COOKIE, appearance, { path: "/", secure: true, sameSite: "Lax", maxAge: 400 * 86400 });
    else deleteCookie(c, APPEARANCE_COOKIE, { path: "/", secure: true });
    flash(c, "notice", "Appearance saved.");
    return c.redirect("/settings/appearance", 303);
  });

  // Pull requests: turn on auto-merge for the pull requests you open (repo/auto-merge.ts applyOwn).
  web.get("/settings/pull-requests", async (c) => {
    const me = requireAccount(c);
    const current = parseAutoMergeDefault(me.auto_merge);
    return page(
      c,
      me,
      "pull-requests",
      "Pull requests",
      <>
        <h1>Pull requests</h1>
        <p class="muted">
          Have your pull requests merge by themselves once their checks pass. See <a href="/docs/collaboration/merge-on-green">Merge on green automatically</a>.
        </p>
        <Form action="/settings/pull-requests" t={csrfToken(c)} class="box">
          <div class="body fbody">
            <div class="fchecks">
              <KCheckbox
                name="auto_merge"
                checked={!!current}
                label="Turn on auto-merge for pull requests I open"
                description="As you open a pull request (or mark your draft ready), Diffinery turns on auto-merge for you, in every repository, wherever the branch has required checks. It merges once those pass and every rule of the branch is met, approvals included; it never skips a rule. Turn it off on any one pull request from its page, or open it with diffinery pr create --no-auto."
              />
            </div>
            <div class="fgrid c3">
              <div class="field">
                <label for="am-method">Merge method</label>
                <KSelect id="am-method" name="method" label="Merge method" block value={current ?? "default"} options={AUTO_MERGE_METHODS} />
                <div class="hint">Where a branch requires linear history, a merge commit becomes the branch's own method.</div>
              </div>
            </div>
            <div class="factions">
              <button class="btn primary">Save</button>
            </div>
          </div>
        </Form>
        <p class="small muted">
          Your agents have the same setting, in <a href="/settings/agents">Agents</a>. To make a repository's pull requests merge when its checks pass, an admin opens its Settings → <b>Merge on green</b>.
        </p>
      </>,
    );
  });

  post(web, "/settings/pull-requests", async (c, f) => {
    const me = requireAccount(c);
    const v = f.b("auto_merge") ? (parseAutoMergeDefault(f.s("method")) ?? "default") : null;
    await c.get("dir").setAutoMerge(me.id, v);
    c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "account.auto_merge", target: me.login, detail: { merge_method: v } }));
    flash(c, "notice", v ? "Auto-merge now turns on by itself for pull requests you open." : "Auto-merge no longer turns on by itself for your pull requests.");
    return c.redirect("/settings/pull-requests", 303);
  });

  avatarSizeGuard(web, "/settings/avatar", () => "/settings");
  post(web, "/settings/avatar", async (c, f) => {
    const me = requireAccount(c);
    return act(c, "/settings", () => uploadAvatar(c, f, me, me), "Profile picture updated.");
  });

  post(web, "/settings/avatar/delete", async (c) => {
    const me = requireAccount(c);
    return act(c, "/settings", () => deleteAvatar(c, me, me), "Profile picture removed.");
  });

  // Passkeys and sessions
  web.get("/settings/security", async (c) => {
    const me = requireAccount(c);
    const t = csrfToken(c);
    const auth = new Auth(c.env);
    const p = c.get("principal");
    const current = p.type === "account" ? p.sessionId : undefined;
    const [keys, sessions] = await Promise.all([auth.passkeys(me.id), auth.sessions(me.id)]);
    const recovery = !!(c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD);
    return page(
      c,
      me,
      "security",
      "Passkeys and sessions",
      <>
        <h1>Passkeys and sessions</h1>
        <p class="muted">You sign in to Diffinery with passkeys instead of a password. A passkey lives on your device or in your password manager and is unlocked with your fingerprint, face or screen lock.</p>
        <div class="box">
          <div class="head">
            <h2>Passkeys</h2>
            <span class="badge">{keys.length}</span>
          </div>
          {keys.length ? (
            <ul class="list">
              {keys.map((k) => (
                <li>
                  <span class="st faint">{raw(ICONS.key)}</span>
                  <div class="grow">
                    <b>{k.name}</b> {k.backed_up ? <span class="badge blue" title="Backed up by your password manager or platform, so it syncs to your other devices">synced</span> : <span class="badge" title="Stored only on one device or security key">this device only</span>}
                    <div class="meta">
                      Added <Time at={k.created_at} /> · {k.last_used_at ? <>last used <Time at={k.last_used_at} /></> : "never used to sign in"}
                    </div>
                  </div>
                  {keys.length > 1 ? (
                    <Form action={`/settings/security/passkeys/${encodeURIComponent(k.id)}/delete`} t={t} class="inline" confirm={`Remove the passkey "${k.name}"? Sessions it signed in are signed out.`}>
                      <button class="btn sm danger">Remove</button>
                    </Form>
                  ) : (
                    <span class="small faint" title="Add another passkey before removing this one">Only passkey</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">No passkeys yet. Add one so you can sign in.</div>
          )}
          <div class="body" style="border-top:1px solid var(--border)">
            <form data-passkey="register" data-next="/settings/security">
              <div class="formrow">
                <div class="field grow">
                  <label for="pklabel">Add a passkey</label>
                  <input id="pklabel" name="label" type="text" maxlength={100} placeholder={deviceLabel(c.req.header("user-agent"))} />
                </div>
                <button class="btn primary">{raw(ICONS.key)} Add a passkey</button>
              </div>
              <div class="hint">Add one on each device you use, or keep it in a password manager that syncs.</div>
            </form>
            <div class="mt">
              <div class="flash error" data-passkey-msg role="alert" hidden></div>
            </div>
          </div>
        </div>
        <div class="box">
          <div class="head">
            <h2>Signed-in browsers</h2>
            <span class="badge">{sessions.length}</span>
          </div>
          {sessions.length ? (
            <ul class="list">
              {sessions.map((s) => (
                <li>
                  <div class="grow">
                    <b>{deviceLabel(s.user_agent ?? undefined)}</b> {s.id === current ? <span class="badge green">this browser</span> : null}
                    <div class="meta">
                      Signed in <Time at={s.created_at} /> with {s.method === "access" ? "email recovery" : s.method === "link" ? "a sign-in link" : "a passkey"} · active <Time at={s.last_seen_at} />
                    </div>
                  </div>
                  {s.id !== current ? (
                    <Form action={`/settings/security/sessions/${encodeURIComponent(s.id)}/revoke`} t={t} class="inline" confirm={`Sign out ${deviceLabel(s.user_agent ?? undefined)}?`}>
                      <button class="btn sm">Sign out</button>
                    </Form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">No browser sessions.</div>
          )}
          <div class="body small muted" style="border-top:1px solid var(--border)">
            A browser stays signed in for 30 days after you last use it, and at most 90 days after you sign in. Adding passkeys, creating tokens and agents, and deleting or transferring repositories ask you to sign in again when your sign-in is more than 2 hours old. Recovering your account by email or with a sign-in link signs out every other browser; access tokens keep working.
          </div>
          {sessions.some((s) => s.id !== current) ? (
            <div class="body" style="border-top:1px solid var(--border)">
              <Form action="/settings/security/sessions/others" t={t} class="inline" confirm="Sign out every other browser?">
                <button class="btn">Sign out everywhere else</button>
              </Form>
            </div>
          ) : null}
        </div>
        <p class="muted small">
          Lost every passkey? {recovery ? <>Use <a href="/auth/access">email recovery</a>, then add a new passkey here.</> : "Ask a site administrator for a one-time sign-in link."} Git, the CLI and agents use <a href="/settings/tokens">access tokens</a> instead of passkeys.
        </p>
      </>,
    );
  });

  post(web, "/settings/security/passkeys/:id/delete", async (c) => {
    const me = browserAccount(c);
    const auth = new Auth(c.env);
    const id = prm(c, "id");
    return act(
      c,
      "/settings/security",
      async () => {
        const keys = await auth.passkeys(me.id);
        const key = keys.find((k) => k.id === id);
        if (!key) throw new HttpError(404, "passkey not found");
        if (keys.length < 2) throw new HttpError(422, "Add another passkey before removing your last one.");
        requireRecentSignIn(c, "/settings/security");
        const p = c.get("principal");
        await auth.deletePasskey(me.id, id, p.type === "account" ? (p.sessionId ?? null) : null);
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "passkey.remove", detail: { name: key.name } }));
      },
      "Passkey removed.",
    );
  });

  post(web, "/settings/security/sessions/:id/revoke", async (c) => {
    const me = browserAccount(c);
    const id = prm(c, "id");
    return act(
      c,
      "/settings/security",
      async () => {
        if (!(await new Auth(c.env).endSessionById(me.id, id))) throw new HttpError(404, "That browser is already signed out.");
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "session.revoke" }));
      },
      "Signed out of that browser.",
    );
  });

  post(web, "/settings/security/sessions/others", async (c) => {
    const me = browserAccount(c);
    const p = c.get("principal");
    return act(c, "/settings/security", async () => void (await new Auth(c.env).endOtherSessions(me.id, p.type === "account" ? (p.sessionId ?? null) : null)), "Signed out of every other browser.");
  });

  // Tokens
  const tokensPage = async (c: AppContext, me: Account, created?: { token: string }) => {
    const dir = c.get("dir");
    const t = csrfToken(c);
    const [tokens, repos, grants] = await Promise.all([dir.tokens(me.id), dir.reposVisibleTo(me), new OAuth(c.env, dir).grantsFor(me.id)]);
    const repoName = new Map(repos.map((r) => [r.id, `${r.owner_login}/${r.name}`]));
    return page(
      c,
      me,
      "tokens",
      "Access tokens",
      <>
        <h1>Personal access tokens</h1>
        <p class="muted">Tokens authenticate Git over HTTPS, the REST API, the CLI and MCP clients. Use your username (or anything) as the Git username and the token as the password.</p>
        <p class="muted">
          For the CLI you don't need one: run <code>diffinery login</code> and approve the sign-in in your browser. Each CLI sign-in gets its own token, listed here. Nor for MCP apps such as claude.ai, Claude Code and Codex: they <a href="#connected-apps">connect through your browser</a> and appear under Connected apps.
        </p>
        {created ? <TokenOnce c={c} token={created.token} title="Your new token" /> : null}
        <div class="box">
          <div class="head">
            <h2>Active tokens</h2>
          </div>
          {tokens.length ? (
            <table class="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scopes</th>
                  <th>Repositories</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((k) => (
                  <tr>
                    <td>
                      <b>{k.name}</b> {k.client === "cli" ? <span class="badge" title="Created by signing in with diffinery login">CLI sign-in</span> : null}
                      <div class="faint mono small">{k.prefix}…</div>
                    </td>
                    <td>{k.scopes.join(", ")}</td>
                    <td class="small">{k.repoIds ? k.repoIds.map((id) => repoName.get(id) ?? id.slice(0, 8)).join(", ") : <span class="muted">all</span>}</td>
                    <td class="small">{new Date(k.expiresAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</td>
                    <td class="small">{k.lastUsedAt ? ago(k.lastUsedAt) : <span class="muted">never</span>}</td>
                    <td class="right">
                      <Form action={`/settings/tokens/${k.id}/revoke`} t={t} class="inline" confirm={`Revoke token "${k.name}"? Anything using it stops working.`}>
                        <button class="btn sm danger">Revoke</button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="empty">No tokens yet.</div>
          )}
        </div>
        <ConnectedApps t={t} grants={grants} mcpUrl={`${publicUrl(c)}/mcp`} />
        <Form action="/settings/tokens" t={t} class="box">
          <div class="head">
            <h2>Create a token</h2>
          </div>
          <div class="body">
            <div class="row" style="align-items:flex-start">
              <div class="field grow">
                <label for="tname">Name</label>
                <input id="tname" name="name" type="text" required placeholder="laptop, ci, claude-code…" maxlength={80} />
              </div>
              <div class="field" style="width:140px">
                <label for="days">Expires in (days)</label>
                <input id="days" name="days" type="number" min={1} max={366} value="90" />
              </div>
            </div>
            <div class="field">
              <label>Scope</label>
              <KRadio name="scope" label="Scope" orientation="horizontal" value="write" items={SCOPES.map((s) => ({ value: s, label: cap(s) }))} />
              <div class="hint">read: clone and view · write: push, issues, pull requests, runs (up to maintain) · admin: everything you can do, including settings.</div>
            </div>
            <div class="field">
              <label for="repos">
                Restrict to repositories <span class="faint">(optional)</span>
              </label>
              <KSelect
                id="repos"
                name="repos"
                multiple
                block
                label="Restrict to repositories"
                placeholder="Every repository you can access"
                options={repos.map((r) => ({ value: String(r.id), label: `${r.owner_login}/${r.name}` }))}
              />
              <div class="hint">Leave empty for access to every repository you can access.</div>
            </div>
            <button class="btn primary">Create token</button>
          </div>
        </Form>
      </>,
    );
  };

  web.get("/settings/tokens", async (c) => tokensPage(c, requireAccount(c)));

  post(web, "/settings/tokens", async (c, f) => {
    const me = requireAccount(c);
    requireRecentSignIn(c, "/settings/tokens");
    const dir = c.get("dir");
    const scope = SCOPES.find((s) => s === f.s("scope")) ?? "write";
    const visible = new Set((await dir.reposVisibleTo(me)).map((r) => r.id));
    const repoIds = f.all("repos").filter((id) => visible.has(id));
    const name = f.s("name").trim() || "token";
    const created = await dir.createToken(me, { name, scopes: [scope], repoIds: repoIds.length ? repoIds : null, expiresInDays: parseInt(f.s("days"), 10) || 90 });
    c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "token.create", target: me.login, detail: { name, scope, repos: repoIds.length } }));
    return tokensPage(c, me, created);
  });

  post(web, "/settings/tokens/:id/revoke", async (c) => {
    const me = requireAccount(c);
    return act(
      c,
      "/settings/tokens",
      async () => {
        await c.get("dir").revokeToken(me.id, prm(c, "id"));
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "token.revoke", target: prm(c, "id") }));
      },
      "Token revoked.",
    );
  });

  // Agents
  const agentsPage = async (c: AppContext, me: Account, created?: { token: string; agent: string }) => {
    const dir = c.get("dir");
    const t = csrfToken(c);
    const orgs = await adminOrgs(c, me);
    const agents = await dir.agentsOwnedBy([me.id, ...orgs.map((o) => o.id)]);
    const ownerName = new Map<string, string>([[me.id, me.login], ...orgs.map((o) => [o.id, o.login] as [string, string])]);
    const tokenLists = await Promise.all(agents.map((a) => dir.tokens(a.id)));
    return page(
      c,
      me,
      "agents",
      "Agents",
      <>
        <h1>Agents</h1>
        <p class="muted">
          Agents are accounts for AI tools and automation. They act on behalf of their owner, are capped by a policy, cannot push to protected or default branches, and their pull requests need a human approval. Give each agent its own token.
        </p>
        {created ? <TokenOnce c={c} token={created.token} title={`Token for ${created.agent}`} /> : null}
        <div class="box">
          <div class="head">
            <h2>Your agents</h2>
          </div>
          {agents.length ? (
            <ul class="list">
              {agents.map((a, i) => {
                const policy = parsePolicy(a);
                const toks = tokenLists[i] ?? [];
                return (
                  <li style="display:block">
                    <div class="row">
                      <Actor login={a.login} kind="agent" version={a.avatar_version} />
                      <span class="muted small">
                        owned by <b>{ownerName.get(a.owner_id ?? "") ?? "?"}</b> · max role <b>{policy.maxRole ?? "write"}</b> · {a.status}
                      </span>
                      <span class="grow" />
                      <Form action={`/settings/agents/${a.id}/status`} t={t} class="inline">
                        <input type="hidden" name="status" value={a.status === "active" ? "disabled" : "active"} />
                        <button class={`btn sm ${a.status === "active" ? "danger" : ""}`}>{a.status === "active" ? "Disable" : "Enable"}</button>
                      </Form>
                    </div>
                    {toks.length ? (
                      <div class="small muted mt" style="margin-top:6px">
                        Tokens:{" "}
                        {toks.map((k) => (
                          <span class="row" style="display:inline-flex;gap:4px;margin-right:10px">
                            <span class="mono">{k.name}</span> ({k.scopes.join(",")}, last used {k.lastUsedAt ? ago(k.lastUsedAt) : "never"})
                            <Form action={`/settings/agents/${a.id}/tokens/${k.id}/revoke`} t={t} class="inline" confirm="Revoke this agent token?">
                              <button class="btn sm link bad">revoke</button>
                            </Form>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <Form action={`/settings/agents/${a.id}/auto-merge`} t={t} class="row" style="margin-top:6px">
                      <KCheckbox
                        name="auto_merge"
                        checked={!!parseAutoMergeDefault(a.auto_merge)}
                        label="Merge its pull requests on green"
                        description="Turns on auto-merge for each pull request it opens. Where a repository allows agents' auto-merge, they merge once required checks pass (and a person approved, unless the repository waives it); a workflow change still needs a person."
                      />
                      <button class="btn sm">Save</button>
                    </Form>
                    <details style="margin-top:6px">
                      <summary class="small" style="cursor:pointer;color:var(--accent)">
                        Create a token for {a.login}
                      </summary>
                      <Form action={`/settings/agents/${a.id}/token`} t={t} class="row mt" style="align-items:flex-end">
                        <div class="field grow m0">
                          <label>Name</label>
                          <input name="name" type="text" required value="default" />
                        </div>
                        <div class="field m0">
                          <label>Scope</label>
                          <KSelect name="scope" label="Scope" value="write" options={SCOPES.map((s) => ({ value: s, label: cap(s) }))} />
                        </div>
                        <div class="field m0" style="width:110px">
                          <label>Days</label>
                          <input name="days" type="number" min={1} max={366} value="30" />
                        </div>
                        <button class="btn primary">Create token</button>
                      </Form>
                    </details>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div class="empty">No agents yet.</div>
          )}
        </div>
        <Form action="/settings/agents" t={t} class="box">
          <div class="head">
            <h2>Create an agent</h2>
          </div>
          <div class="body">
            <div class="row" style="align-items:flex-start">
              <div class="field grow">
                <label for="alogin">Agent username</label>
                <input id="alogin" name="login" type="text" required pattern={LOGIN_PATTERN} placeholder="review-bot" />
              </div>
              <div class="field grow">
                <label for="aname">Display name</label>
                <input id="aname" name="name" type="text" placeholder="Review bot" />
              </div>
            </div>
            <div class="row" style="align-items:flex-start">
              <div class="field grow">
                <label for="aowner">Owner</label>
                <KSelect
                  id="aowner"
                  name="owner"
                  block
                  label="Owner"
                  value="me"
                  options={[{ value: "me", label: `${me.login} (you)` }, ...orgs.map((o) => ({ value: String(o.id), label: `${o.login} (organization)` }))]}
                />
                <div class="hint">An agent can never do more than its owner.</div>
              </div>
              <div class="field grow">
                <label for="arole">Maximum role</label>
                <KSelect id="arole" name="maxRole" block label="Maximum role" value="write" options={ROLES.map((r) => ({ value: r, label: cap(r) }))} />
              </div>
            </div>
            <div class="fchecks mb">
              <KCheckbox
                name="auto_merge"
                label="Merge its pull requests on green"
                description="Turns on auto-merge for each pull request it opens, so it lands once required checks pass wherever a repository allows agents' auto-merge (Settings → Merge on green). You can change it later."
              />
            </div>
            <button class="btn primary">Create agent</button>
          </div>
        </Form>
      </>,
    );
  };

  web.get("/settings/agents", async (c) => agentsPage(c, requireAccount(c)));

  post(web, "/settings/agents", async (c, f) => {
    const me = requireAccount(c);
    requireRecentSignIn(c, "/settings/agents");
    const dir = c.get("dir");
    return act(
      c,
      "/settings/agents",
      async () => {
        const maxRole = ROLES.find((r) => r === f.s("maxRole")) ?? "write";
        const a = await dir.createAgent(me, { login: f.s("login").trim(), name: f.s("name").trim() || undefined, orgId: f.s("owner") && f.s("owner") !== "me" ? f.s("owner") : undefined, policy: { maxRole } });
        if (f.b("auto_merge")) await dir.setAutoMerge(a.id, "default");
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "agent.create", target: a.login, detail: { maxRole, auto_merge: f.b("auto_merge") } }));
      },
      "Agent created. Create a token for it below.",
    );
  });

  const loadAgent = async (c: AppContext, me: Account): Promise<Account> => {
    const agent = await c.get("dir").account(prm(c, "id"));
    if (!agent || !(await canManageAgent(c, me, agent))) throw new HttpError(404, "agent not found");
    return agent;
  };

  post(web, "/settings/agents/:id/token", async (c, f) => {
    const me = requireAccount(c);
    requireRecentSignIn(c, "/settings/agents");
    const agent = await loadAgent(c, me);
    const dir = c.get("dir");
    const scope = SCOPES.find((s) => s === f.s("scope")) ?? "write";
    const created = await dir.createToken(agent, { name: f.s("name").trim() || "agent", scopes: [scope], expiresInDays: parseInt(f.s("days"), 10) || 30 });
    c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "agent.token.create", target: agent.login, detail: { scope } }));
    return agentsPage(c, me, { token: created.token, agent: agent.login });
  });

  post(web, "/settings/agents/:id/auto-merge", async (c, f) => {
    const me = requireAccount(c);
    const agent = await loadAgent(c, me);
    const on = f.b("auto_merge");
    return act(
      c,
      "/settings/agents",
      async () => {
        await c.get("dir").setAutoMerge(agent.id, on ? "default" : null);
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "agent.auto_merge", target: agent.login, detail: { merge_method: on ? "default" : null } }));
      },
      on ? `Auto-merge now turns on by itself for ${agent.login}'s pull requests.` : `Auto-merge no longer turns on by itself for ${agent.login}'s pull requests.`,
    );
  });

  post(web, "/settings/agents/:id/tokens/:tid/revoke", async (c) => {
    const me = requireAccount(c);
    const agent = await loadAgent(c, me);
    return act(c, "/settings/agents", async () => c.get("dir").revokeToken(agent.id, prm(c, "tid")), "Token revoked.");
  });

  post(web, "/settings/agents/:id/status", async (c, f) => {
    const me = requireAccount(c);
    const agent = await loadAgent(c, me);
    const status = f.s("status") === "active" ? "active" : "disabled";
    return act(c, "/settings/agents", async () => {
      await c.get("dir").setStatus(agent.id, status);
      c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: `agent.${status === "active" ? "enable" : "disable"}`, target: agent.login }));
    });
  });

  // Organizations
  // Invitations to organizations and repositories: someone added by username joins once they accept.
  // Blocked users (lib/moderation.ts): the people you blocked, and a form to block someone.
  web.get("/settings/blocked-users", async (c) => {
    const me = requireAccount(c);
    const t = csrfToken(c);
    return page(
      c,
      me,
      "blocked",
      "Blocked users",
      <>
        <h1>Blocked users</h1>
        <BlockList
          blocks={await blockList(c.env, me.id)}
          add="/settings/blocked-users"
          unblock={(login) => `/settings/blocked-users/${encodeURIComponent(login)}/unblock`}
          t={t}
          title="People you blocked"
          hint="They can still see your public repositories, but can't open issues or pull requests, comment or react in them, aren't collaborators on them, and can't invite you. You get no notifications from them. They aren't told."
          empty="You haven't blocked anyone."
        />
      </>,
    );
  });

  web.get("/settings/invitations", async (c) => {
    const p = c.get("principal");
    // Someone still waiting for an invite sees theirs on the home page.
    if (p.type === "account" && p.account.status === "pending") return c.redirect("/", 303);
    const me = requireAccount(c);
    const invites = await c.get("dir").invitesFor(me);
    return page(
      c,
      me,
      "invitations",
      "Invitations",
      <>
        <h1>Invitations</h1>
        <p class="muted">Invitations to join an organization or collaborate on a repository. You get access once you accept; declining tells nobody, and the invitation goes away.</p>
        <MyInvitations invites={invites} t={csrfToken(c)} />
      </>,
    );
  });

  for (const accept of [true, false]) {
    post(web, `/settings/invitations/:id/${accept ? "accept" : "decline"}`, async (c) => {
      const p = c.get("principal");
      if (p.type !== "account") throw new HttpError(401, "sign in required");
      // Someone waiting for an invite may accept one; that lets them in.
      if (p.account.status === "disabled") throw new HttpError(403, "your account is disabled");
      const dir = c.get("dir");
      const back = p.account.status === "pending" ? "/" : "/settings/invitations";
      return act(c, back, async () => {
        const res = await dir.answerInvite(prm(c, "id"), p.account, accept);
        c.executionCtx.waitUntil(dir.audit({ actorId: p.account.id, actorLogin: p.account.login, action: accept ? "invite.accept" : "invite.decline", detail: { id: prm(c, "id") } }));
        if (!accept) {
          flash(c, "notice", "Invitation declined.");
          return;
        }
        if (res.repoId) {
          const r = await dir.repoById(res.repoId);
          if (r) return repoUrl(r);
        } else if (res.orgId) {
          const o = await dir.account(res.orgId);
          if (o) return `/${o.login}`;
        }
      });
    });
  }

  web.get("/settings/orgs", async (c) => {
    const me = requireAccount(c);
    const t = csrfToken(c);
    const orgs = await c.get("dir").orgsFor(me.id);
    return page(
      c,
      me,
      "orgs",
      "Organizations",
      <>
        <h1>Organizations</h1>
        <p class="muted">Organizations group people, agents and repositories. Members get the organization's base permission (read for new organizations) on its repositories; owners and admins manage everything.</p>
        <div class="box">
          {orgs.length ? (
            <ul class="list">
              {orgs.map((o) => (
                <li>
                  <Avatar login={o.login} version={o.avatar_version} />
                  <div class="grow">
                    <a class="title" href={`/${o.login}`}>
                      {o.login}
                    </a>
                    {o.name && o.name !== o.login ? <span class="muted"> · {o.name}</span> : null}
                  </div>
                  <span class="badge">{o.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">You are not a member of any organization.</div>
          )}
        </div>
        <Form action="/settings/orgs" t={t} class="box">
          <div class="head">
            <h2>New organization</h2>
          </div>
          <div class="body">
            <div class="row" style="align-items:flex-start">
              <div class="field grow">
                <label for="olog">Organization name</label>
                <input id="olog" name="login" type="text" required pattern={LOGIN_PATTERN} placeholder="my-team" />
              </div>
              <div class="field grow">
                <label for="oname">Display name</label>
                <input id="oname" name="name" type="text" />
              </div>
            </div>
            <button class="btn primary">Create organization</button>
          </div>
        </Form>
      </>,
    );
  });

  post(web, "/settings/orgs", async (c, f) => {
    const me = requireAccount(c);
    const dir = c.get("dir");
    return act(c, "/settings/orgs", async () => {
      const org = await dir.createOrg(f.s("login").trim(), f.s("name").trim(), me);
      c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.create", target: org.login }));
      return `/${org.login}?tab=people`;
    });
  });

  // Site administration
  const requireSiteAdmin = (c: AppContext): Account => {
    const me = requireAccount(c);
    if (!me.site_admin) throw new HttpError(403, "site administrators only");
    return me;
  };

  const adminPage = async (c: AppContext, me: Account, invite?: { url: string; title: string; note: string }) => {
    const dir = c.get("dir");
    const t = csrfToken(c);
    const [users, requests, invites] = await Promise.all([dir.users(), dir.accessRequests(), dir.invites({ site: true, pending: true })]);
    return page(
      c,
      me,
      "admin",
      "Site administration",
      <>
        <h1>Site administration</h1>
        {invite ? (
          <div class="box" style="border-color:var(--amber)">
            <div class="body">
              <h3>{invite.title}</h3>
              <p class="muted">{invite.note}</p>
              <div class="row">
                <div class="secret grow">{invite.url}</div>
                <CopyButton text={invite.url} size="base" />
              </div>
            </div>
          </div>
        ) : null}
        <EarlyAccessCallout db={c.env.DB} />
        <div class="box">
          <div class="head">
            <h2>Pending access requests</h2>
            <span class="badge">{requests.length}</span>
          </div>
          {requests.length ? (
            <ul class="list">
              {requests.map((r) => (
                <li>
                  <Avatar login={r.account.login} version={r.account.avatar_version} />
                  <div class="grow">
                    <b>{r.account.email ?? r.account.login}</b> <span class="muted small">requested <Time at={r.createdAt} /></span>
                    {r.note ? <div class="meta" style="white-space:pre-wrap">{r.note}</div> : null}
                  </div>
                  <Form action={`/settings/admin/users/${r.account.id}/status`} t={t} class="inline">
                    <input type="hidden" name="status" value="active" />
                    <button class="btn sm green">Approve</button>
                  </Form>
                  <Form action={`/settings/admin/users/${r.account.id}/status`} t={t} class="inline">
                    <input type="hidden" name="status" value="disabled" />
                    <button class="btn sm danger">Deny</button>
                  </Form>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">No pending requests.</div>
          )}
        </div>
        <Form action="/settings/admin/invite" t={t} class="box">
          <div class="head">
            <h2>Invite someone to this instance</h2>
          </div>
          <div class="body">
            <div class="formrow">
              <div class="field grow">
                <label for="iemail">Email address</label>
                <input id="iemail" name="email" type="email" required placeholder="friend@example.com" />
              </div>
              <button class="btn primary">{raw(ICONS.envelope)} Send invitation</button>
            </div>
            <div class="hint">We email them a link. Opening it lets them pick a username and create a passkey.</div>
          </div>
        </Form>
        <PendingInvites invites={invites} revoke={(id) => `/settings/admin/invites/${id}/revoke`} t={t} roles={false} />
        <div class="box">
          <div class="head">
            <h2>Users</h2>
            <span class="badge">{users.length}</span>
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Joined</th>
                <th>Status</th>
                <th>Site admin</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr>
                  <td>
                    <Actor login={u.login} kind="user" version={u.avatar_version} /> {u.site_admin ? <span class="badge blue">admin</span> : null}
                  </td>
                  <td class="small">{u.email ?? "—"}</td>
                  <td class="small">{ago(u.created_at)}</td>
                  <td>
                    {u.suspended_at ? (
                      <span class="badge red" title={`Suspended by ${u.suspended_by ?? "a site administrator"}: ${u.suspended_reason ?? ""}`}>
                        suspended
                      </span>
                    ) : u.id === me.id ? (
                      <span class="badge green">{u.status}</span>
                    ) : (
                      <Form action={`/settings/admin/users/${u.id}/status`} t={t} class="row" style="gap:6px;flex-wrap:nowrap">
                        <KSelect name="status" size="sm" label={`Status of ${u.login}`} value={u.status} options={(["active", "pending", "disabled"] as const).map((s) => ({ value: s, label: cap(s) }))} />
                        <button class="btn sm">Save</button>
                      </Form>
                    )}
                  </td>
                  <td>
                    {u.site_admin ? (
                      <Form action={`/settings/admin/users/${u.id}/site-admin`} t={t} class="inline" confirm={u.id === me.id ? "Stop being a site administrator? You lose access to these pages." : `Remove ${u.login} from the site administrators?`}>
                        <input type="hidden" name="grant" value="0" />
                        <button class="btn sm">Remove admin</button>
                      </Form>
                    ) : u.status === "active" ? (
                      <Form action={`/settings/admin/users/${u.id}/site-admin`} t={t} class="inline" confirm={`Make ${u.login} a site administrator? They get admin on every repository and organization, and these pages.`}>
                        <input type="hidden" name="grant" value="1" />
                        <button class="btn sm">Make admin</button>
                      </Form>
                    ) : (
                      <span class="faint small">—</span>
                    )}
                  </td>
                  <td class="right nowrap">
                    {u.id === me.id ? null : <SuspendControl u={u} t={t} />}{" "}
                    <Form action={`/settings/admin/users/${u.id}/signin-link`} t={t} class="inline" confirm={`Create a one-time link that adds a passkey to ${u.login}? Only send it to them.`}>
                      <button class="btn sm" title="For a lost passkey or a first sign-in">Sign-in link</button>
                    </Form>{" "}
                    <a class="btn sm danger" href={`/settings/admin/users/${u.id}/delete`}>
                      Delete
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  };

  web.get("/settings/admin", async (c) => adminPage(c, requireSiteAdmin(c)));

  post(web, "/settings/admin/users/:id/status", async (c, f) => {
    const me = requireSiteAdmin(c);
    const dir = c.get("dir");
    const status = (["active", "pending", "disabled"] as const).find((s) => s === f.s("status"));
    return act(
      c,
      "/settings/admin",
      async () => {
        if (!status) throw new HttpError(422, "invalid status");
        const target = await dir.account(prm(c, "id"));
        if (!target || target.kind !== "user") throw new HttpError(404, "user not found");
        if (target.id === me.id) throw new HttpError(422, "you cannot change your own status");
        await dir.setStatus(target.id, status);
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: `user.${status}`, target: target.login }));
      },
      "User updated.",
    );
  });

  post(web, "/settings/admin/users/:id/signin-link", async (c) => {
    const me = requireSiteAdmin(c);
    const dir = c.get("dir");
    const target = await dir.account(prm(c, "id"));
    if (!target || target.kind !== "user") throw new HttpError(404, "user not found");
    requireRecentSignIn(c, "/settings/admin");
    if (target.status === "disabled") throw new HttpError(422, "enable this account first");
    const link = await new Auth(c.env).createSigninLink(me, target);
    c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "signin_link.create", target: target.login }));
    return adminPage(c, me, { url: link.url, title: `Sign-in link for ${target.login}`, note: `We emailed it to ${target.email ?? "them"}; you can also send it yourself. Send it only to them: it works once within 24 hours and adds a passkey to their account.` });
  });

  // Suspension (lib/moderation.ts): with a reason, from the Users table or a report.
  const suspendTarget = async (c: AppContext) => {
    const user = await c.get("dir").accountByLogin(prm(c, "login"));
    if (!user || user.kind !== "user") throw new HttpError(404, "user not found");
    return user;
  };
  const backFrom = (f: { s(name: string): string }) => (/^\/settings\/admin(\/|$)/.test(f.s("back")) ? f.s("back") : "/settings/admin");
  post(web, "/settings/admin/users/:login/suspend", async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, backFrom(f), async () => {
      const user = await suspendTarget(c);
      const stopped = await suspend(c.env, (e) => c.get("dir").audit(e), me, user, suspendReason(f.s("reason")), "web");
      flash(c, "notice", `Suspended ${user.login}.${stoppedNote(stopped)}`);
    });
  });
  post(web, "/settings/admin/users/:login/unsuspend", async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, backFrom(f), async () => {
      const user = await suspendTarget(c);
      if (!(await unsuspend(c.env, (e) => c.get("dir").audit(e), me, user, "web"))) throw new HttpError(422, `${user.login} isn't suspended`);
      flash(c, "notice", `${user.login} is no longer suspended.`);
    });
  });

  // Reports (lib/moderation.ts): the queue, one report, resolving and reopening.
  web.get("/settings/admin/reports", async (c) => {
    const me = requireSiteAdmin(c);
    const state = c.req.query("state") === "resolved" ? "resolved" : "open";
    const [list, open, resolved] = await Promise.all([reports(c.env, state, 100), openReportCount(c.env), reports(c.env, "resolved", 1)]);
    return page(c, me, "reports", "Reports", <ReportsList items={list.items} state={state} counts={{ open, resolved: resolved.total }} />);
  });
  web.get("/settings/admin/reports/:id", async (c) => {
    const me = requireSiteAdmin(c);
    const r = await report(c.env, prm(c, "id"));
    if (!r) throw new HttpError(404, "no report with that id");
    const account = r.account_id ? await c.get("dir").account(r.account_id) : null;
    return page(c, me, "reports", "Report", <ReportDetail r={r} t={csrfToken(c)} suspended={account?.kind === "user" && !account.site_admin && account.id !== me.id ? !!account.suspended_at : null} />);
  });
  for (const [path, state] of [["resolve", "resolved"], ["reopen", "open"]] as const) {
    post(web, `/settings/admin/reports/:id/${path}`, async (c, f) => {
      const me = requireSiteAdmin(c);
      const back = `/settings/admin/reports/${encodeURIComponent(prm(c, "id"))}`;
      return act(c, back, async () => {
        const note = state === "resolved" ? cleanResolution(f.s("resolution")) : null;
        const r = await setReportState(c.env, prm(c, "id"), me, state, note);
        if (!r) throw new HttpError(404, "no report with that id");
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: state === "resolved" ? "report.resolve" : "report.reopen", target: r.target, detail: { id: r.id, ...(note ? { resolution: note } : {}), via: "web" } }));
        return state === "resolved" ? "/settings/admin/reports" : back;
      }, state === "resolved" ? "Report resolved." : "Report reopened.");
    });
  }

  post(web, "/settings/admin/invite", async (c, f) => {
    const me = requireSiteAdmin(c);
    const email = f.s("email").trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(422, "enter a valid email address");
    const inv = await c.get("dir").createInvite(me, { email, role: "read" });
    c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "invite.create", target: email }));
    return adminPage(c, me, { url: inv.url, title: `Invite created for ${email}`, note: `We emailed it to ${email}; you can also send it yourself. It expires in 14 days and works once: they pick a username and create a passkey.` });
  });

  post(web, "/settings/admin/invites/:id/revoke", async (c) => {
    const me = requireSiteAdmin(c);
    const dir = c.get("dir");
    return act(
      c,
      "/settings/admin",
      async () => {
        if (!(await dir.revokeInvite(prm(c, "id"), {}))) throw new HttpError(404, "this invitation was already used, revoked or never existed");
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "invite.revoke", detail: { id: prm(c, "id") } }));
      },
      "Invitation revoked.",
    );
  });

  // Kill switches (lib/killswitch.ts)
  web.get("/settings/admin/kill-switches", async (c) => {
    const me = requireSiteAdmin(c);
    return page(c, me, "kill-switches", "Kill switches", <KillSwitchesPage env={c.env} t={csrfToken(c)} />);
  });
  const KS = "/settings/admin/kill-switches";
  const auditFn = (c: AppContext) => (e: Parameters<Directory["audit"]>[0]) => c.get("dir").audit(e);
  const stoppedNote = (s: Stopped | null) => (s ? ` Stopped ${s.runs} runs, ${s.jobs} jobs and ${s.sandboxes} sandboxes${s.failed ? `; ${s.failed} repositories didn't answer, so their work stops when it next tries to start` : ""}.` : "");
  post(web, `${KS}/pause`, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, KS, async () => {
      const stopped = await changePause(c.env, auditFn(c), me, cleanReason(f.s("reason")), "web");
      flash(c, "notice", `Hosted compute is paused.${stoppedNote(stopped)}`);
    });
  });
  post(web, `${KS}/resume`, async (c) => {
    const me = requireSiteAdmin(c);
    return act(c, KS, async () => changePause(c.env, auditFn(c), me, null, "web").then(() => undefined), "Hosted compute is running again. Nothing that was stopped restarts.");
  });
  const accountTarget = async (c: AppContext, login: string) => {
    const account = await c.get("dir").accountByLogin(login.trim());
    if (!account || account.kind === "agent") throw new HttpError(404, "no person or organization with that name");
    return { kind: "account" as const, id: account.id, login: account.login };
  };
  const repoTarget = async (c: AppContext, owner: string, name: string) => {
    const repo = await c.get("dir").repo(owner.trim(), name.trim());
    if (!repo) throw new HttpError(404, "no repository with that name; use owner/name");
    return { kind: "repo" as const, id: repo.id, name: `${repo.owner_login}/${repo.name}` };
  };
  post(web, `${KS}/accounts`, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, KS, async () => {
      const target = await accountTarget(c, f.s("login"));
      const stopped = await changeSuspension(c.env, auditFn(c), me, target, cleanReason(f.s("reason")), "web");
      flash(c, "notice", `Actions are suspended for every repository of ${target.login}.${stoppedNote(stopped)}`);
    });
  });
  post(web, `${KS}/accounts/:login/lift`, async (c) => {
    const me = requireSiteAdmin(c);
    return act(c, KS, async () => {
      const target = await accountTarget(c, prm(c, "login"));
      await changeSuspension(c.env, auditFn(c), me, target, null, "web");
      flash(c, "notice", `Actions are no longer suspended for ${target.login}.`);
    });
  });
  post(web, `${KS}/repos`, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, KS, async () => {
      const [owner, name, extra] = f.s("repo").trim().replace(/^\/+|\/+$/g, "").split("/");
      if (!owner || !name || extra !== undefined) throw new HttpError(422, "enter the repository as owner/name");
      const target = await repoTarget(c, owner, name);
      const stopped = await changeSuspension(c.env, auditFn(c), me, target, cleanReason(f.s("reason")), "web");
      flash(c, "notice", `Actions are suspended for ${target.name}.${stoppedNote(stopped)}`);
    });
  });
  post(web, `${KS}/repos/:owner/:repo/lift`, async (c) => {
    const me = requireSiteAdmin(c);
    return act(c, KS, async () => {
      const target = await repoTarget(c, prm(c, "owner"), prm(c, "repo"));
      await changeSuspension(c.env, auditFn(c), me, target, null, "web");
      flash(c, "notice", `Actions are no longer suspended for ${target.name}.`);
    });
  });

  web.get("/settings/audit", async (c) => {
    const me = requireSiteAdmin(c);
    const rows = await c.get("dir").auditLog(200);
    return page(
      c,
      me,
      "audit",
      "Audit log",
      <>
        <h1>Audit log</h1>
        <p class="muted">The 200 most recent security-relevant events.</p>
        <div class="box" style="overflow:auto">
          <table class="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class="small nowrap">
                    <Time at={r.at} />
                  </td>
                  <td class="small">
                    {r.actor_login ?? "system"}
                    {r.on_behalf_of ? <span class="muted"> for {r.on_behalf_of}</span> : null}
                  </td>
                  <td>
                    <span class="badge">{r.action}</span>
                  </td>
                  <td class="small mono">{r.target ?? ""}</td>
                  <td class="small mono muted" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={r.detail ?? ""}>
                    {r.detail ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <div class="empty">No events yet.</div> : null}
        </div>
      </>,
    );
  });

  // Unexpected server errors (lib/server-errors.ts); ?id= finds the one a 5xx answer's request ID names.
  web.get("/settings/admin/search-engines", async (c) => {
    const me = requireSiteAdmin(c);
    return page(c, me, "search-engines", "Search engines", <SearchEngines s={await indexNowStatus(c.env)} />);
  });
  web.get("/settings/admin/errors", async (c) => {
    const me = requireSiteAdmin(c);
    const id = c.req.query("id")?.trim() || undefined;
    const rows = await serverErrors(c.env, { id, limit: 200 });
    return page(
      c,
      me,
      "errors",
      "Server errors",
      <>
        <h1>Server errors</h1>
        <p class="muted">
          {id ? (
            <>
              The error with request ID <span class="mono">{id}</span>.
            </>
          ) : (
            <>
              The 200 most recent answers with a 5xx status. Each such answer carries its request ID (<span class="mono">request_id</span> and the <span class="mono">x-request-id</span> header).
            </>
          )}{" "}
          No request bodies, query strings or headers are kept.
        </p>
        <form method="get" action="/settings/admin/errors" class="row" style="gap:8px;margin-bottom:12px">
          <input type="search" name="id" placeholder="Request ID" value={id ?? ""} class="mono" style="flex:1;max-width:360px" />
          <button class="btn" type="submit">
            Find
          </button>
          {id ? (
            <a class="btn" href="/settings/admin/errors">
              Show all
            </a>
          ) : null}
        </form>
        <div class="box" style="overflow:auto">
          <table class="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Request</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td class="small nowrap">
                    <Time at={r.at} />
                  </td>
                  <td class="small mono">
                    <div>
                      {r.method} {r.route ?? r.path}
                    </div>
                    <div class="muted">{r.id}</div>
                  </td>
                  <td>
                    <span class="badge">{r.status}</span>
                  </td>
                  <td class="small mono" style="max-width:520px">
                    {r.stack ? (
                      <details>
                        <summary style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{r.message}</summary>
                        <pre class="muted" style="white-space:pre-wrap">{r.stack}</pre>
                      </details>
                    ) : (
                      r.message
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <div class="empty">{id ? "No error with that request ID; only the newest 500 are kept." : "No server errors."}</div> : null}
        </div>
      </>,
    );
  });
}

// ---------------------------------------------------------------- site administration: search engines

const SearchEngines: FC<{ s: Awaited<ReturnType<typeof indexNowStatus>> }> = ({ s }) => (
  <>
    <h1>Search engines</h1>
    <p class="muted">
      Diffinery tells search engines through <a href="https://www.indexnow.org">IndexNow</a> when public pages are added, change or go away: after each deploy, the site and docs pages it changed (and their Markdown versions and llms.txt), and every hour, public repositories pushed since. Private repositories and pages behind sign-in are never sent. See{" "}
      <a href="/docs/admin/site-administration#search-engines">the docs</a>.
    </p>
    <div class="box">
      <div class="body">
        {s.off ? (
          <p>
            <span class="badge">off</span> {s.off}.
          </p>
        ) : (
          <p>
            <span class="badge green">on</span> Key file:{" "}
            <a class="mono" href={s.keyLocation!}>
              {s.keyLocation}
            </a>
          </p>
        )}
        <p class="small muted" style="margin:0">
          Tracking {s.site} site and docs pages and {s.repos} public repositories; {s.queued} waiting to be submitted.
          {s.retryAt && Date.parse(s.retryAt) > Date.now() ? (
            <>
              {" "}
              Trying again <Time at={s.retryAt} />.
            </>
          ) : null}
          {s.reposCheckedAt ? (
            <>
              {" "}
              Repositories checked <Time at={s.reposCheckedAt} />.
            </>
          ) : null}
        </p>
      </div>
    </div>
    <h2>Submissions</h2>
    <div class="box" style="overflow:auto">
      <table class="tbl">
        <thead>
          <tr>
            <th>When</th>
            <th>URLs</th>
            <th>IndexNow</th>
            <th>Pages</th>
          </tr>
        </thead>
        <tbody>
          {s.submissions.map((r) => (
            <tr>
              <td class="small nowrap">
                <Time at={r.at} />
              </td>
              <td>{r.urls}</td>
              <td class="small">
                <span class={`badge${r.status === 200 || r.status === 202 ? " green" : " red"}`}>{r.status ?? "unreachable"}</span> <span class="muted">{r.endpoint ? `${r.endpoint}, ` : ""}{r.ms} ms</span>
                {r.error ? <div class="mono muted">{r.error}</div> : null}
              </td>
              <td class="small mono" style="max-width:520px">
                <details>
                  <summary style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{r.paths.slice(0, 3).join(", ")}{r.urls > 3 ? ", …" : ""}</summary>
                  <div class="muted" style="white-space:pre-wrap">
                    {r.paths.join("\n")}
                    {r.urls > r.paths.length ? `\n… and ${r.urls - r.paths.length} more` : ""}
                  </div>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.submissions.length === 0 ? <div class="empty">Nothing submitted yet. The first submission follows within five minutes of a deploy.</div> : null}
    </div>
  </>
);

// ---------------------------------------------------------------- /:owner profiles

type OrgTab = "repositories" | "people" | "agents" | "settings";

/** An organization's name and tab bar, shared by its profile tabs and its packages pages. */
export function OrgHeader({ org, role, isOwner, tab }: { org: Account; role: "owner" | "admin" | "member" | null; isOwner: boolean; tab: OrgTab | "packages" }) {
  const base = `/${org.login}`;
  return (
    <>
      <div class="row mb" style="gap:16px">
        <Avatar login={org.login} size="lg" version={org.avatar_version} />
        <div>
          <h1 class="m0">{org.name || org.login}</h1>
          <div class="muted small">
            Organization · {org.login}
            {role ? ` · you are ${role === "owner" ? "an owner" : `a${role === "admin" ? "n" : ""} ${role}`}` : ""}
          </div>
        </div>
      </div>
      <nav class="tabs mb vt-tabs" style="border-bottom:1px solid var(--border)">
        {(
          [
            ["repositories", "Repositories", true],
            ["people", "People", true],
            ["agents", "Agents", true],
            ["settings", "Settings", isOwner],
          ] as const
        )
          .filter((x) => x[2])
          .map(([k, label]) => (
            <a href={`${base}?tab=${k}`} class={tab === k ? "on" : ""}>
              {label}
            </a>
          ))}
        <a href={`${base}/-/packages`} class={tab === "packages" ? "on" : ""}>
          Packages
        </a>
      </nav>
    </>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** The invitation link right after inviting someone by email (it's also in their inbox). */
const InviteOnce: FC<{ email: string; url: string }> = ({ email, url }) => (
  <div class="box" style="border-color:var(--amber)">
    <div class="body">
      <h3>Invitation sent to {email}</h3>
      <p class="muted">We emailed them an invitation. You can also send them this link yourself. It works once and expires in 14 days: they join when they accept it, creating an account and passkey first if they don't have one.</p>
      <div class="row nowrap">
        <div class="secret grow">{url}</div>
        <CopyButton text={url} size="base" />
      </div>
    </div>
  </div>
);

function registerProfiles(web: WebApp): void {
  const orgContext = async (c: AppContext) => {
    const me = requireAccount(c);
    const dir = c.get("dir");
    const org = await dir.accountByLogin(prm(c, "owner"));
    if (!org || (org.kind === "org" && org.status === "disabled")) throw new HttpError(404, "not found");
    if (org.kind !== "org") throw new HttpError(404, "not an organization");
    const role = await dir.orgRole(org.id, me.id);
    const isAdmin = !!me.site_admin || role === "owner" || role === "admin";
    const isOwner = !!me.site_admin || role === "owner";
    return { me, org, role, isAdmin, isOwner, dir };
  };

  const profile = async (c: AppContext, invite?: { url: string; email: string }) => {
    const me = requireAccount(c);
    const dir = c.get("dir");
    const t = csrfToken(c);
    const acct = await dir.accountByLogin(prm(c, "owner"));
    if (!acct && prm(c, "owner").toLowerCase() === GHOST.login) {
      return render(
        c,
        { title: GHOST.login },
        <div style="max-width:720px;margin:24px auto" class="box">
          <div class="body row" style="gap:18px">
            <Avatar login={GHOST.login} size="xl" />
            <div>
              <h1 class="m0">{GHOST.login}</h1>
              <p class="muted">This is a placeholder for people who deleted their accounts. Issues, pull requests and comments they wrote in other people's repositories are shown as written by ghost.</p>
            </div>
          </div>
        </div>,
      );
    }
    if (!acct) {
      // A renamed person's or organization's old login leads to the new one.
      const renamed = await dir.renamedAccount(prm(c, "owner"));
      const url = new URL(c.req.url);
      if (renamed) return c.redirect(`${movedLoginPath(url.pathname, prm(c, "owner"), renamed.login) ?? `/${renamed.login}`}${url.search}`, 301);
      throw new HttpError(404, "not found");
    }
    // A deleted organization keeps its account row for the audit log (Directory.deleteOrg); its page is gone.
    if (acct.kind === "org" && acct.status === "disabled") throw new HttpError(404, "not found");
    // So does a deleted person's (accounts/lifecycle.ts).
    if (acct.deleted_at) throw new HttpError(404, "not found");
    // A suspended person's profile is hidden from everyone but site administrators (lib/moderation.ts).
    if (!visibleTo(acct, me)) throw new HttpError(404, "not found");
    if (acct.login !== prm(c, "owner")) return c.redirect(`/${acct.login}${new URL(c.req.url).search}`, 301);

    if (acct.kind === "agent") {
      const owner = acct.owner_id ? await dir.account(acct.owner_id) : null;
      const policy = parsePolicy(acct);
      return render(
        c,
        { title: acct.login },
        <div style="max-width:720px;margin:24px auto" class="box">
          <div class="body row" style="gap:18px">
            <Avatar login={acct.login} kind="agent" size="xl" version={acct.avatar_version} />
            <div>
              <h1 class="m0">
                {acct.name || acct.login} <span class="badge agent">agent</span>
              </h1>
              <p class="muted">{acct.login}</p>
              <dl class="kv">
                <dt>Acts on behalf of</dt>
                <dd>{owner ? <a href={`/${owner.login}`}>{owner.login}</a> : "—"}</dd>
                <dt>Maximum role</dt>
                <dd>{policy.maxRole ?? "write"}</dd>
                <dt>Status</dt>
                <dd>{acct.status}</dd>
                <dt>Created</dt>
                <dd>
                  <Time at={acct.created_at} />
                </dd>
              </dl>
            </div>
          </div>
        </div>,
      );
    }

    const repos = await dir.reposVisibleTo(me, acct.id);
    if (acct.kind === "user") {
      const orgs = await dir.orgsFor(acct.id);
      return render(
        c,
        { title: acct.login },
        <div class="grid left">
          <aside class="side">
            <section>
              <Avatar login={acct.login} size="xl" version={acct.avatar_version} />
              <h1 class="mt m0">{acct.name || acct.login}</h1>
              <p class="muted">
                {acct.login} {acct.suspended_at ? <span class="badge red">suspended</span> : null}
              </p>
              {acct.id === me.id ? (
                <a class="btn sm" href="/settings">
                  Edit profile
                </a>
              ) : me.kind === "user" ? (
                <ProfileMenu c={c} user={acct} blocked={await hasBlocked(c, me, acct)} />
              ) : null}
            </section>
            {orgs.length ? (
              <section>
                <h3>Organizations</h3>
                <div class="nav">
                  {orgs.map((o) => (
                    <a href={`/${o.login}`}>
                      <Avatar login={o.login} version={o.avatar_version} /> {o.login}
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>
          <div>
            <div class="row between mb">
              <h2 class="m0">Repositories</h2>
              <div class="row">
                <a class="btn sm" href={`/${acct.login}/-/packages`}>
                  {raw(ICONS.package)} Packages
                </a>
                {acct.id === me.id ? (
                  <a class="btn sm primary" href="/new">
                    {raw(ICONS.plus)} New
                  </a>
                ) : null}
              </div>
            </div>
            <div class="box">
              <RepoList repos={repos} showOwner={false} />
            </div>
          </div>
        </div>,
      );
    }

    // Organization
    const role = await dir.orgRole(acct.id, me.id);
    const isAdmin = !!me.site_admin || role === "owner" || role === "admin";
    const isOwner = !!me.site_admin || role === "owner";
    const requested = (c.req.query("tab") ?? "repositories") as OrgTab;
    // The old Invites tab is part of People now.
    const tab: OrgTab = invite || (requested as string) === "invites" ? "people" : (["repositories", "people", "agents", "settings"] as const).includes(requested) ? requested : "repositories";
    if (tab === "settings" && !isOwner) throw new HttpError(403, "organization owners only");
    let body: Child = null;
    const base = `/${acct.login}`;
    if (tab === "repositories") {
      body = (
        <>
          <div class="row between mb">
            <h2 class="m0">Repositories</h2>
            {role ? (
              <span class="row" style="gap:6px">
                {isAdmin ? (
                  <a class="btn sm" href={`/new/import?owner=${encodeURIComponent(acct.login)}&mode=owner`}>
                    Import from GitHub
                  </a>
                ) : null}
                <a class="btn sm primary" href={`/new?owner=${encodeURIComponent(acct.login)}`}>
                  {raw(ICONS.plus)} New repository
                </a>
              </span>
            ) : null}
          </div>
          <div class="box">
            <RepoList repos={repos} showOwner={false} />
          </div>
        </>
      );
    } else if (tab === "people") {
      const [members, invites] = await Promise.all([dir.orgMembers(acct.id), isAdmin ? dir.invites({ orgId: acct.id, pending: true }) : Promise.resolve([])]);
      const roles = (isOwner ? ["member", "admin", "owner"] : ["member", "admin"]).map((r) => ({ value: r, label: ROLE_LABEL[r]! }));
      body = (
        <>
          <div class="row between mb">
            <h2 class="m0">People</h2>
            <span class="muted small">
              {members.length} member{members.length === 1 ? "" : "s"}
              {invites.length ? ` · ${invites.length} pending invitation${invites.length === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {invite ? <InviteOnce email={invite.email} url={invite.url} /> : null}
          {isAdmin ? (
            <Form action={`${base}/-/org/people`} t={t} class="box">
              <div class="head">
                <h3>{raw(ICONS.userPlus)} Add people</h3>
              </div>
              <div class="body">
                <div class="formrow">
                  <div class="field grow">
                    <label for="who">Username or email</label>
                    <input id="who" name="who" type="text" required autocomplete="off" spellcheck={false} placeholder="diffy or name@example.com" />
                  </div>
                  <div class="field">
                    <label for="role">Role</label>
                    <KSelect id="role" name="role" label="Role" value="member" options={roles} />
                  </div>
                  <button class="btn primary">Add</button>
                </div>
                <div class="hint">Everyone gets an invitation and joins {acct.login} when they accept it: a username in their Settings → Invitations (with an email and a notification), an email address by a link that also creates an account if they don't have one.</div>
              </div>
            </Form>
          ) : null}
          <div class="box">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  {isAdmin ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr>
                    <td>
                      <Actor login={m.login} kind="user" version={m.avatar_version} /> {m.name && m.name !== m.login ? <span class="muted small">{m.name}</span> : null}
                    </td>
                    <td>
                      {isAdmin && (isOwner || m.role !== "owner") ? (
                        <Form action={`${base}/-/org/members`} t={t} class="row nowrap" style="gap:6px">
                          <input type="hidden" name="login" value={m.login} />
                          <KSelect name="role" size="sm" label={`Role of ${m.login}`} value={m.role} options={(isOwner ? ["owner", "admin", "member"] : ["admin", "member"]).map((r) => ({ value: r, label: ROLE_LABEL[r]! }))} />
                          <button class="btn sm">Save</button>
                        </Form>
                      ) : (
                        <span class="badge">{ROLE_LABEL[m.role] ?? m.role}</span>
                      )}
                    </td>
                    {isAdmin ? (
                      <td class="right">
                        {isOwner || m.role !== "owner" ? (
                          <Form action={`${base}/-/org/members`} t={t} class="inline" confirm={`Remove ${m.login} from ${acct.login}?`}>
                            <input type="hidden" name="login" value={m.login} />
                            <input type="hidden" name="role" value="remove" />
                            <button class="btn sm danger">Remove</button>
                          </Form>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PendingInvites invites={invites} revoke={(id) => `${base}/-/org/invites/${id}/revoke`} t={t} />
        </>
      );
    } else if (tab === "agents") {
      const agents = await dir.agentsOwnedBy([acct.id]);
      body = (
        <>
          <div class="row between mb">
            <h2 class="m0">Agents</h2>
            {isAdmin ? (
              <a class="btn sm primary" href="/settings/agents">
                Manage agents
              </a>
            ) : null}
          </div>
          <div class="box">
            {agents.length ? (
              <ul class="list">
                {agents.map((a) => (
                  <li>
                    <Actor login={a.login} kind="agent" version={a.avatar_version} />
                    <span class="grow" />
                    <span class="muted small">max role {parsePolicy(a).maxRole ?? "write"}</span>
                    <span class={`badge ${a.status === "active" ? "green" : ""}`}>{a.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div class="empty">This organization has no agents.</div>
            )}
          </div>
        </>
      );
    } else {
      const agentData = await orgAgentData(c.env, acct.id);
      body = (
        <>
          <h2>Settings</h2>
          <AvatarSection account={acct} action={`${base}/-/org/avatar`} t={t} />
          <Form action={`${base}/-/org/settings`} t={t} class="box">
            <div class="body">
              <div class="field">
                <label>Organization name</label>
                <input name="login" type="text" value={acct.login} required pattern={LOGIN_PATTERN} />
                <div class="hint">Renaming changes every repository URL in this organization.</div>
              </div>
              <div class="field">
                <label>Display name</label>
                <input name="name" type="text" value={acct.name ?? ""} />
              </div>
              <div class="field">
                <label for="base_role">Base permission</label>
                <KSelect id="base_role" name="base_role" block label="Base permission" value={baseRole(acct)} options={BASE_ROLE_OPTIONS} />
                <div class="hint">What every member can do in all of this organization's repositories. Owners and admins always have admin access, and repository settings can give people more.</div>
              </div>
              <button class="btn primary">Save</button>
            </div>
          </Form>
          <OrgAgentSettings org={acct} data={agentData} t={t} />
          <BlockList
            blocks={await blockList(c.env, acct.id)}
            add={`${base}/-/org/blocks`}
            unblock={(login) => `${base}/-/org/blocks/${encodeURIComponent(login)}/unblock`}
            t={t}
            title="Blocked users"
            hint={`They can't open issues or pull requests, comment or react in ${acct.login}'s repositories, be added as collaborators or be invited to ${acct.login}. Members can't be blocked; remove them first.`}
            empty="This organization hasn't blocked anyone."
          />
          <div class="box" style="border-color:color-mix(in srgb,var(--red) 45%,transparent)">
            <div class="head" style="background:var(--red-soft)">
              <h2 class="bad">Danger zone</h2>
            </div>
            <Form action={`${base}/-/org/delete`} t={t} match={acct.login} class="body">
              <b>Delete this organization</b>
              <p class="muted small">
                Transfer or delete its repositories and container images first. Its members, invitations, secrets and variables are removed and its agents disabled; repositories transferred out of it keep their old URLs working. Type <b class="mono">{acct.login}</b> to confirm.
              </p>
              <div class="row">
                <input name="confirm" type="text" required autocomplete="off" style="max-width:320px" aria-label="Confirm organization name" />
                <button class="btn danger">Delete this organization</button>
              </div>
            </Form>
          </div>
        </>
      );
    }
    return render(
      c,
      { title: acct.login },
      <>
        <OrgHeader org={acct} role={role} isOwner={isOwner} tab={tab} />
        {body}
      </>,
    );
  };

  web.get("/:owner", async (c) => profile(c));

  // Add people: a username or an email. Both get an invitation to accept (Directory.addOrgPerson).
  post(web, "/:owner/-/org/people", async (c, f) => {
    const { me, org, isAdmin, isOwner, dir } = await orgContext(c);
    const back = `/${org.login}?tab=people`;
    const role = (["member", "admin", "owner"] as const).find((r) => r === f.s("role")) ?? "member";
    let invited: { email: string; url: string } | undefined;
    const res = await act(c, back, async () => {
      if (!isAdmin) throw new HttpError(403, "organization admins only");
      if (role === "owner" && !isOwner) throw new HttpError(403, "only owners can add owners");
      const r = await dir.addOrgPerson(org, me, f.s("who"), role);
      if ("added" in r) {
        flash(c, "notice", `Added ${r.added.login} to ${org.login} as ${ROLE_LABEL[role]!.toLowerCase()}. We let them know.`);
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.member.set", target: org.login, detail: { user: r.added.login, role } }));
      } else if ("invitedUser" in r) {
        flash(c, "notice", r.renewed ? `${r.invitedUser.login} already had a pending invitation; it now offers the ${ROLE_LABEL[role]!.toLowerCase()} role.` : `Invited ${r.invitedUser.login} to ${org.login} as ${ROLE_LABEL[role]!.toLowerCase()}. They join once they accept.`);
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.invite", target: org.login, detail: { user: r.invitedUser.login, role } }));
      } else {
        invited = r.invited;
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.invite", target: org.login, detail: { email: r.invited.email, role } }));
      }
    });
    return invited ? profile(c, invited) : res;
  });

  // The old invite form posts here.
  post(web, "/:owner/-/org/invites", async (c) => c.redirect(`/${prm(c, "owner")}?tab=people`, 303));

  post(web, "/:owner/-/org/invites/:id/revoke", async (c) => {
    const { me, org, isAdmin, dir } = await orgContext(c);
    return act(
      c,
      `/${org.login}?tab=people`,
      async () => {
        if (!isAdmin) throw new HttpError(403, "organization admins only");
        if (!(await dir.revokeInvite(prm(c, "id"), { orgId: org.id }))) throw new HttpError(404, "this invitation was already used, revoked or never existed");
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.invite.revoke", target: org.login, detail: { id: prm(c, "id") } }));
      },
      "Invitation revoked.",
    );
  });

  post(web, "/:owner/-/org/members", async (c, f) => {
    const { me, org, isAdmin, isOwner, dir } = await orgContext(c);
    const back = `/${org.login}?tab=people`;
    return act(c, back, async () => {
      if (!isAdmin) throw new HttpError(403, "organization admins only");
      const user = await dir.accountByLogin(f.s("login").trim());
      if (!user || user.kind !== "user") throw new HttpError(404, "user not found");
      const current = await dir.orgRole(org.id, user.id);
      const role = f.s("role");
      if ((current === "owner" || role === "owner") && !isOwner) throw new HttpError(403, "only owners can manage owners");
      // Someone who isn't a member yet gets an invitation, as with Add people.
      if (!current && role !== "remove") {
        if (role !== "owner" && role !== "admin" && role !== "member") throw new HttpError(422, "invalid role");
        const r = await dir.addOrgPerson(org, me, user.login, role);
        if ("invitedUser" in r) flash(c, "notice", r.renewed ? `${user.login} already had a pending invitation; it now offers the ${ROLE_LABEL[role]!.toLowerCase()} role.` : `Invited ${user.login} to ${org.login} as ${ROLE_LABEL[role]!.toLowerCase()}. They join once they accept.`);
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "added" in r ? "org.member.set" : "org.invite", target: org.login, detail: { user: user.login, role } }));
        return;
      }
      if (role === "remove") await dir.setOrgMember(org.id, user.id, null, me);
      else if (role === "owner" || role === "admin" || role === "member") await dir.setOrgMember(org.id, user.id, role, me);
      else throw new HttpError(422, "invalid role");
      c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: role === "remove" ? "org.member.remove" : "org.member.set", target: org.login, detail: { user: user.login, role } }));
    });
  });

  post(web, "/:owner/-/org/settings", async (c, f) => {
    const { me, org, isOwner, dir } = await orgContext(c);
    return act(c, `/${org.login}?tab=settings`, async () => {
      if (!isOwner) throw new HttpError(403, "organization owners only");
      const login = f.s("login").trim();
      // One validated write: a bad base permission doesn't leave a half-applied rename behind.
      await dir.updateAccount(org.id, { login: login && login !== org.login ? login : undefined, name: f.s("name").trim(), baseRole: f.s("base_role") || undefined });
      if (login && login !== org.login) c.executionCtx.waitUntil(purgeAvatarCache(c, org.login, [org.avatar_version]));
      c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.update", target: org.login, detail: { login, base_role: f.s("base_role") || undefined } }));
      return `/${login || org.login}?tab=settings`;
    }, "Organization updated.");
  });

  post(web, "/:owner/-/org/delete", async (c, f) => {
    const { me, org, isOwner, dir } = await orgContext(c);
    return act(
      c,
      `/${org.login}?tab=settings`,
      async () => {
        if (!isOwner) throw new HttpError(403, "organization owners only");
        if (f.s("confirm").trim() !== org.login) throw new HttpError(422, `type ${org.login} to confirm deletion`);
        requireRecentSignIn(c, `/${org.login}?tab=settings`);
        await dir.deleteOrg(org);
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.delete", target: org.login }));
        return "/";
      },
      `Deleted ${org.login}.`,
    );
  });

  avatarSizeGuard(web, "/:owner/-/org/avatar", (c) => `/${c.req.param("owner")}?tab=settings`);
  post(web, "/:owner/-/org/avatar", async (c, f) => {
    const { me, org, isOwner } = await orgContext(c);
    return act(c, `/${org.login}?tab=settings`, async () => {
      if (!isOwner) throw new HttpError(403, "organization owners only");
      await uploadAvatar(c, f, me, org);
    }, "Organization picture updated.");
  });

  post(web, "/:owner/-/org/avatar/delete", async (c) => {
    const { me, org, isOwner } = await orgContext(c);
    return act(c, `/${org.login}?tab=settings`, async () => {
      if (!isOwner) throw new HttpError(403, "organization owners only");
      await deleteAvatar(c, me, org);
    }, "Organization picture removed.");
  });
}
