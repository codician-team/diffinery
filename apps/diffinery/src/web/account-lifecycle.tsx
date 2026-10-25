/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { deleteCookie } from "hono/cookie";
import { requireAccount, requireRecentSignIn, type AppContext } from "../auth/principal.js";
import { SESSION_COOKIE } from "../auth/sessions.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { EXPORT_DAYS, exportArchive, exportsFor, requestExport, type ExportRow } from "../accounts/export.js";
import { LOGIN_COOLDOWN_DAYS, deleteAccount, deletionBlockers, setSiteAdmin } from "../accounts/lifecycle.js";
import { ADMIN_TABS, SettingsNav, type SettingsTab } from "./account.js";
import { ComputePausedBanner } from "./kill-switches.js";
import { csrfToken } from "./csrf.js";
import { Form, Time, act, flash, fmtBytes, post, prm, render, type WebApp } from "./ui.js";

/**
 * The account lifecycle in the web UI (accounts/): Settings → Account (export your data, delete your account),
 * and in Site administration deleting someone's account and making people site administrators. Deleting,
 * exporting and changing site administrators all ask for a sign-in from the last 2 hours.
 */

const settingsPage = (c: AppContext, me: Account, tab: SettingsTab, title: string, body: Child) =>
  render(
    c,
    { title },
    <div class="grid left">
      <SettingsNav me={me} tab={tab} db={c.env.DB} />
      <div>
        {ADMIN_TABS.includes(tab) ? <ComputePausedBanner env={c.env} /> : null}
        {body}
      </div>
    </div>,
  );

const requireSiteAdmin = (c: AppContext): Account => {
  const me = requireAccount(c);
  if (!me.site_admin) throw new HttpError(403, "site administrators only");
  return me;
};

/** A person (not an organization, agent or deleted account), by id. */
async function person(c: AppContext, id: string): Promise<Account> {
  const a = await c.get("dir").account(id);
  if (!a || a.kind !== "user" || a.deleted_at) throw new HttpError(404, "user not found");
  return a;
}

const DangerBox: FC<{ title: string; children?: Child }> = ({ title, children }) => (
  <div class="box" style="border-color:color-mix(in srgb,var(--red) 45%,transparent)">
    <div class="head" style="background:var(--red-soft)">
      <h2 class="bad">{title}</h2>
    </div>
    {children}
  </div>
);

const Blockers: FC<{ blockers: string[] }> = ({ blockers }) =>
  blockers.length ? (
    <div class="flash error" role="alert" data-blockers>
      {blockers.map((b) => (
        <div>{b}</div>
      ))}
    </div>
  ) : null;

/** What deleting an account removes and keeps, for the person and for administrators. */
const WhatGoes: FC<{ who: string; repos: number }> = ({ who, repos }) => (
  <ul class="small muted">
    <li>
      {who} {repos === 1 ? "repository" : `${repos} repositories`} with their history, issues, pull requests, runs and secrets, {who === "Your" ? "your" : "their"} container images, access tokens, passkeys, agents, settings and memberships are deleted. Every browser is signed out.
    </li>
    <li>Issues, pull requests and comments written in other people's repositories stay, shown as written by ghost.</li>
    <li>The username can be used again, by anyone, {LOGIN_COOLDOWN_DAYS} days later.</li>
  </ul>
);

const ExportStatus: FC<{ e: ExportRow }> = ({ e }) => {
  if (e.status === "ready")
    return (
      <li data-export="ready">
        <div class="grow">
          <b>Export ready</b> <span class="badge green">{fmtBytes(e.size ?? 0)}</span>
          <div class="meta">
            Made <Time at={e.finished_at} /> · available until {e.expires_at?.slice(0, 10)}
          </div>
        </div>
        <a class="btn sm primary" href={`/settings/account/exports/${e.id}/download`}>
          Download
        </a>
      </li>
    );
  if (e.status === "failed")
    return (
      <li data-export="failed">
        <div class="grow">
          <b class="bad">The export failed</b>
          <div class="meta">{e.error}</div>
        </div>
      </li>
    );
  return (
    <li data-export="building">
      <div class="grow">
        <b>Preparing your export…</b>
        <div class="meta">
          Asked <Time at={e.created_at} />. We'll email you when it's ready; this page shows it too.
        </div>
      </div>
    </li>
  );
};

export function registerAccountLifecycle(web: WebApp): void {
  // ------------------------------------------------------------ Settings → Account
  web.get("/settings/account", async (c) => {
    const me = requireAccount(c);
    if (me.kind !== "user") throw new HttpError(403, "only people have these settings");
    const t = csrfToken(c);
    const [exports, blockers, repos] = await Promise.all([
      exportsFor(c.env, me.id),
      deletionBlockers(c.env, me, true),
      c.env.DB.prepare("SELECT count(*) AS n FROM repos WHERE owner_id = ?").bind(me.id).first<{ n: number }>(),
    ]);
    const building = exports.some((e) => e.status === "queued" || e.status === "running");
    return render(
      c,
      { title: "Account", refresh: building ? 10 : undefined },
      <div class="grid left">
        <SettingsNav me={me} tab="account" db={c.env.DB} />
        <div>
          <h1>Account</h1>
          <div class="box">
            <div class="head">
              <h2>Export your data</h2>
            </div>
            <div class="body">
              <p class="muted m0">
                Download an archive of your account: your profile and settings, each repository you own as a Git bundle (clone it with <code>git clone name.bundle</code>), and the issues, pull requests, comments and reviews you wrote. We build it in the background and email you when it's ready; you can download it here for {EXPORT_DAYS} days. Tokens and passkeys are listed by name only.
              </p>
            </div>
            {exports.length ? (
              <ul class="list">
                {exports.map((e) => (
                  <ExportStatus e={e} />
                ))}
              </ul>
            ) : null}
            <div class="body" style="border-top:1px solid var(--border)">
              <Form action="/settings/account/export" t={t} class="inline">
                <button class="btn" disabled={building}>
                  {exports.some((e) => e.status === "ready") ? "Start a new export" : "Start export"}
                </button>
              </Form>
            </div>
          </div>
          <DangerBox title="Delete your account">
            <Form action="/settings/account/delete" t={t} match={me.login} class="body">
              <Blockers blockers={blockers} />
              <WhatGoes who="Your" repos={repos?.n ?? 0} />
              <p class="muted small">
                This can't be undone. Type your username, <b class="mono">{me.login}</b>, to confirm.
              </p>
              <div class="row">
                <input name="confirm" type="text" required autocomplete="off" style="max-width:320px" aria-label="Confirm your username" />
                <button class="btn danger" disabled={blockers.length > 0}>
                  Delete your account
                </button>
              </div>
            </Form>
          </DangerBox>
        </div>
      </div>,
    );
  });

  post(web, "/settings/account/export", async (c) => {
    const me = requireAccount(c);
    return act(c, "/settings/account", async () => {
      if (me.kind !== "user") throw new HttpError(403, "only people can export their account");
      requireRecentSignIn(c, "/settings/account");
      const e = await requestExport(c.env, me);
      c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "account.export", detail: { id: e.id } }));
      flash(c, "notice", e.status === "ready" ? "Your export is ready." : "We're preparing your export. We'll email you when it's ready.");
    });
  });

  web.get("/settings/account/exports/:id/download", async (c) => {
    const me = requireAccount(c);
    // The archive holds every repository and the account's data: only the person in a browser, never a token
    // (a repository-limited or read-only token would otherwise reach all of it).
    const p = c.get("principal");
    if (p.type !== "account" || (p.via !== "session" && p.via !== "dev")) throw new HttpError(403, "downloading an account export needs a browser session");
    requireRecentSignIn(c, "/settings/account");
    const a = await exportArchive(c.env, me.id, prm(c, "id"));
    c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "account.export_download", detail: { id: prm(c, "id"), size: a.size } }));
    return new Response(a.body, { headers: { "content-type": "application/x-tar", "content-length": String(a.size), "content-disposition": `attachment; filename="${a.name}"`, "cache-control": "private, no-store" } });
  });

  post(web, "/settings/account/delete", async (c, f) => {
    const me = requireAccount(c);
    return act(c, "/settings/account", async () => {
      if (me.kind !== "user") throw new HttpError(403, "only people can delete their account here");
      if (f.s("confirm").trim() !== me.login) throw new HttpError(422, `type your username, ${me.login}, to confirm`);
      requireRecentSignIn(c, "/settings/account");
      await deleteAccount(c.env, c.get("dir"), me, me, "settings");
      deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
      flash(c, "notice", `Your account ${me.login} was deleted.`);
      return "/login";
    });
  });

  // ------------------------------------------------------------ Site administration
  web.get("/settings/admin/users/:id/delete", async (c) => {
    const me = requireSiteAdmin(c);
    const target = await person(c, prm(c, "id"));
    const [blockers, repos] = await Promise.all([deletionBlockers(c.env, target, target.id === me.id), c.env.DB.prepare("SELECT count(*) AS n FROM repos WHERE owner_id = ?").bind(target.id).first<{ n: number }>()]);
    return settingsPage(
      c,
      me,
      "admin",
      `Delete ${target.login}`,
      <>
        <h1>Delete {target.login}</h1>
        <p class="muted">
          <a href="/settings/admin">Site administration</a> · {target.email ?? "no email address"} · joined <Time at={target.created_at} />
        </p>
        <DangerBox title={`Delete the account ${target.login}`}>
          <Form action={`/settings/admin/users/${target.id}/delete`} t={csrfToken(c)} match={target.login} class="body">
            <Blockers blockers={blockers} />
            <WhatGoes who={target.id === me.id ? "Your" : `${target.login}'s`} repos={repos?.n ?? 0} />
            <p class="muted small">
              They get an email saying a site administrator deleted their account. This can't be undone. Type <b class="mono">{target.login}</b> to confirm.
            </p>
            <div class="row">
              <input name="confirm" type="text" required autocomplete="off" style="max-width:320px" aria-label="Confirm the username" />
              <button class="btn danger" disabled={blockers.length > 0}>
                Delete this account
              </button>
            </div>
          </Form>
        </DangerBox>
      </>,
    );
  });

  post(web, "/settings/admin/users/:id/delete", async (c, f) => {
    const me = requireSiteAdmin(c);
    const back = `/settings/admin/users/${prm(c, "id")}/delete`;
    return act(c, back, async () => {
      const target = await person(c, prm(c, "id"));
      if (f.s("confirm").trim() !== target.login) throw new HttpError(422, `type ${target.login} to confirm deletion`);
      requireRecentSignIn(c, back);
      await deleteAccount(c.env, c.get("dir"), target, me, "admin");
      if (target.id === me.id) {
        deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
        return "/login";
      }
      flash(c, "notice", `Deleted the account ${target.login}.`);
      return "/settings/admin";
    });
  });

  post(web, "/settings/admin/users/:id/site-admin", async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, "/settings/admin", async () => {
      const target = await person(c, prm(c, "id"));
      const grant = f.s("grant") === "1";
      requireRecentSignIn(c, "/settings/admin");
      const changed = await setSiteAdmin(c.env, c.get("dir"), target, grant, me);
      flash(c, "notice", !changed ? `${target.login} ${grant ? "already is" : "isn't"} a site administrator.` : grant ? `${target.login} is now a site administrator.` : `${target.login} is no longer a site administrator.`);
      // Removing yourself takes you out of these pages.
      return !grant && changed && target.id === me.id ? "/settings" : undefined;
    });
  });
}
