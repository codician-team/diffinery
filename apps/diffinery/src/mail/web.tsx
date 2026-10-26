/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { loadRepo } from "../http/common.js";
import { HttpError, now } from "../lib/util.js";
import { ADMIN_TABS, SettingsNav, type SettingsTab } from "../web/account.js";
import { ComputePausedBanner } from "../web/kill-switches.js";
import { csrfToken, formData } from "../web/csrf.js";
import { KCheckbox, KSelect, type KOption } from "../web/kumo.js";
import { digestSince } from "./digest.js";
import { Form, Time, WATCH_OPTIONS, act, flash, post, prm, render, repoUrl, type WebApp } from "../web/ui.js";
import { MailStore, WATCH_LEVELS, type EmailLogRow, type NotificationPrefs, type WatchLevel } from "./prefs.js";
import { sampleJobs } from "./samples.js";
import { buildMessage, deliver, enqueueMail, senderAddress } from "./send.js";
import type { Category, MailJob } from "./types.js";
import { readUnsubToken, type UnsubScope, type UnsubToken } from "./unsubscribe.js";
import { normalEmail } from "../auth/signup.js";
import { MAX_DETAIL, MAX_VERIFY_EMAILS_PER_HOUR, REASON_TEXT, Suppressions, VERIFY_HOURS, normalAddress, ownerCanLift, readVerifyToken, verifyToken, type Suppression } from "./suppression.js";

/**
 * Email in the web UI: notification settings, one-click unsubscribe, watching
 * repositories and subscribing to threads, Settings → Email (is my address
 * suppressed, and verifying it again), and the Email page in site
 * administration (delivery status, the suppression list, the log and a
 * gallery of every template).
 */

const CATEGORY_TEXT: Record<Exclude<Category, "security" | "account">, string> = {
  participating: "issues and pull requests you take part in",
  watching: "activity in repositories you watch",
  actions: "workflow runs",
  repos: "repository changes",
  orgs: "organization updates",
  digest: "the morning digest",
};

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

const requireUser = (c: AppContext): Account => {
  const me = requireAccount(c);
  if (me.kind !== "user") throw new HttpError(403, "only people have notification settings");
  return me;
};

const requireSiteAdmin = (c: AppContext): Account => {
  const me = requireUser(c);
  if (!me.site_admin) throw new HttpError(403, "site administrators only");
  return me;
};

/** One-line description of what an unsubscribe link changes. */
function scopeText(s: UnsubScope): string {
  if (s.t === "thread") return `Mute ${s.repo}#${s.number}`;
  if (s.t === "repo") return `Stop watching ${s.repo}`;
  return `Turn off email about ${CATEGORY_TEXT[s.category] ?? s.category}`;
}

const StatusBadge: FC<{ s: EmailLogRow["status"] }> = ({ s }) => <span class={s === "sent" ? "ok" : s === "failed" ? "bad" : "faint"}>{s}</span>;

const EmailLog: FC<{ rows: EmailLogRow[]; showTo?: boolean }> = ({ rows, showTo }) =>
  rows.length ? (
    <div class="box" style="overflow:auto">
      <table class="tbl">
        <thead>
          <tr>
            <th>When</th>
            {showTo ? <th>To</th> : null}
            <th>Email</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td class="small">
                <Time at={r.created_at} />
              </td>
              {showTo ? <td class="small">{r.to_addr || "—"}</td> : null}
              <td>
                <div>{r.subject || r.kind}</div>
                <div class="muted small">
                  {r.kind}
                  {r.message_id ? ` · ${r.message_id}` : ""}
                </div>
              </td>
              <td class="small">
                <StatusBadge s={r.status} />
                {r.detail ? <div class="muted small">{r.detail}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p class="muted">No emails yet.</p>
  );

/** The four-column settings grid: what, on Diffinery, by email. */
const PrefRow: FC<{ title: string; hint: string; web?: { name: string; on: boolean }; email: { name: string; on: boolean; locked?: boolean }; extra?: Child }> = (p) => (
  <tr>
    <td>
      <b>{p.title}</b>
      <div class="muted small">{p.hint}</div>
      {p.extra}
    </td>
    <td>{p.web ? <KCheckbox name={p.web.name} checked={p.web.on} aria={`${p.title} on Diffinery`} /> : <span class="faint">—</span>}</td>
    <td>
      <KCheckbox name={p.email.name} checked={p.email.on} disabled={p.email.locked} aria={`${p.title} by email`} />
    </td>
  </tr>
);

async function notificationsPage(c: AppContext, me: Account): Promise<Response> {
  const store = new MailStore(c.env.DB);
  const dir = c.get("dir");
  const t = csrfToken(c);
  const [p, watches, recent, suppressed, digestNext] = await Promise.all([
    store.prefs(me.id),
    store.watchedRepos(me.id),
    store.recent({ accountId: me.id, limit: 20 }),
    me.email ? new Suppressions(c.env.DB).get(me.email) : null,
    store.digestNext(me.id),
  ]);
  const repos = (await Promise.all(watches.map(async (w) => ({ level: w.level, repo: await dir.repoById(w.repo_id) })))).filter((w) => w.repo);
  return settingsPage(
    c,
    me,
    "notifications",
    "Notifications",
    <>
      <h1>Notifications</h1>
      <p class="muted">
        Emails go to <b>{me.email ?? "no address"}</b> from {senderAddress(c.env)}. Security and account emails always send.
      </p>
      {suppressed ? (
        <div class="flash error" role="alert">
          <SuppressedNote s={suppressed} /> See <a href="/settings/email">Settings → Email</a>.
        </div>
      ) : null}
      <Form action="/settings/notifications" t={t} class="box">
        <table class="tbl">
          <thead>
            <tr>
              <th>Notify me about</th>
              <th>On Diffinery</th>
              <th>Email</th>
            </tr>
          </thead>
          <tbody>
            <PrefRow
              title="Participating"
              hint="Issues and pull requests you opened, commented on, reviewed, were assigned, asked to review, @mentioned in or subscribed to."
              web={{ name: "participating.web", on: p.participating.web }}
              email={{ name: "participating.email", on: p.participating.email }}
            />
            <PrefRow title="Watching" hint="Everything else in repositories you watch with All activity." web={{ name: "watching.web", on: p.watching.web }} email={{ name: "watching.email", on: p.watching.email }} />
            <PrefRow
              title="Actions"
              hint="Workflow runs you started, and scheduled runs in repositories you watch."
              web={{ name: "actions.web", on: p.actions.web }}
              email={{ name: "actions.email", on: p.actions.email }}
              extra={
                <div style="margin-top:6px">
                  <KCheckbox name="actions.failuresOnly" checked={p.actions.failuresOnly} label="Only failed runs" />
                </div>
              }
            />
            <PrefRow title="Repositories" hint="Repositories created or deleted in your organizations, and access granted to you." email={{ name: "repos.email", on: p.repos.email }} />
            <PrefRow title="Organizations" hint="Your organization role, accepted invitations, and access requests and contact messages (for administrators)." email={{ name: "orgs.email", on: p.orgs.email }} />
            <PrefRow title="Security and account" hint="New sign-ins, passkeys, tokens, agents, push protection, invitations and sign-in links." email={{ name: "security", on: true, locked: true }} />
          </tbody>
        </table>
        <DigestSettings p={p} next={digestNext} />
        <div class="body" style="border-top:1px solid var(--border)">
          <div class="kstack">
            <KCheckbox name="ownActivity" checked={p.ownActivity} label="Email me about my own comments and changes" />
            <KCheckbox name="autoWatch" checked={p.autoWatch} label="Watch repositories I create (All activity)" />
          </div>
          <button class="btn primary">Save notification settings</button>
        </div>
      </Form>

      <h2 class="mt">Watched repositories</h2>
      {repos.length ? (
        <div class="box">
          <table class="tbl">
            <tbody>
              {repos.map(({ repo, level }) => (
                <tr>
                  <td>
                    <a href={repoUrl(repo!)}>
                      {repo!.owner_login}/{repo!.name}
                    </a>
                  </td>
                  <td style="text-align:right">
                    <Form action={`${repoUrl(repo!)}/subscription`} t={t} class="inline">
                      <input type="hidden" name="back" value="/settings/notifications" />
                      <KSelect name="level" options={WATCH_OPTIONS} value={level} size="sm" label={`Watch ${repo!.owner_login}/${repo!.name}`} autosubmit />
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">You aren't watching or ignoring any repository. Use the Watch menu at the top of a repository to change that.</p>
      )}

      <h2 class="mt">Recent emails to you</h2>
      <div class="row wrap mb" style="gap:8px">
        <Form action="/settings/notifications/test" t={t} class="inline">
          <button class="btn sm">Send me a test email</button>
        </Form>
        <Form action="/settings/notifications/digest" t={t} class="inline">
          <button class="btn sm">Send me my digest now</button>
        </Form>
      </div>
      <EmailLog rows={recent} />
    </>,
  );
}

/** The time zones the digest offers: every zone the runtime knows, UTC first. */
function timeZones(current: string): KOption[] {
  const all = ((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []).filter((z) => z !== "UTC");
  if (current !== "UTC" && !all.includes(current)) all.push(current);
  return [{ value: BROWSER_TZ, label: "This browser's time zone" }, { value: "UTC", label: "UTC" }, ...all.map((z) => ({ value: z, label: z.replaceAll("_", " ") }))];
}
const BROWSER_TZ = "browser";
const HOURS: KOption[] = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));

/** The morning digest's part of the settings form (phase 5c, digest.ts). */
const DigestSettings: FC<{ p: NotificationPrefs; next: string | null }> = ({ p, next }) => {
  // Someone who never chose a zone gets their browser's; after that, the zone they saved.
  const fresh = !p.digest.email && p.digest.timeZone === "UTC";
  return (
    <div class="body" id="digest" style="border-top:1px solid var(--border)">
      <h3 class="m0">Morning digest</h3>
      <p class="muted small">Today by email, once a day at the hour you pick: what needs you, what your agents are doing, and what merged, released or failed since the last one. A day with nothing in it sends nothing.</p>
      <div class="kstack">
        <KCheckbox name="digest.email" checked={p.digest.email} label="Email me a morning digest" />
        <div class="row wrap" style="gap:8px">
          <KSelect name="digest.hour" options={HOURS} value={String(p.digest.hour)} size="sm" label="Hour" />
          <KSelect name="digest.timeZone" options={timeZones(p.digest.timeZone)} value={fresh ? BROWSER_TZ : p.digest.timeZone} size="sm" label="Time zone" />
        </div>
        <KCheckbox name="digest.weekends" checked={p.digest.weekends} label="On Saturdays and Sundays too" />
        <input type="hidden" name="digest.browserTimeZone" value="" data-browser-tz />
      </div>
      {p.digest.email && next ? (
        <p class="muted small m0" style="margin-top:8px">
          The next one goes out <Time at={next} /> ({String(p.digest.hour).padStart(2, "0")}:00 {p.digest.timeZone.replaceAll("_", " ")}).
        </p>
      ) : null}
    </div>
  );
};

function prefsFromForm(f: { b(name: string): boolean; s(name: string): string }): NotificationPrefs {
  const tz = f.s("digest.timeZone");
  return {
    participating: { web: f.b("participating.web"), email: f.b("participating.email") },
    watching: { web: f.b("watching.web"), email: f.b("watching.email") },
    actions: { web: f.b("actions.web"), email: f.b("actions.email"), failuresOnly: f.b("actions.failuresOnly") },
    repos: { email: f.b("repos.email") },
    orgs: { email: f.b("orgs.email") },
    ownActivity: f.b("ownActivity"),
    autoWatch: f.b("autoWatch"),
    // mergePrefs (prefs.ts) drops an hour or zone it doesn't know.
    digest: { email: f.b("digest.email"), hour: Number(f.s("digest.hour")), timeZone: tz === BROWSER_TZ ? f.s("digest.browserTimeZone") || "UTC" : tz, weekends: f.b("digest.weekends") },
  };
}

/** Test emails one account may send in an hour. */
export const MAX_TEST_EMAILS_PER_HOUR = 5;

/** Send a test email now (not through the queue) so the result shows right away. */
export async function sendTest(c: AppContext, me: Account) {
  const sent = (await new MailStore(c.env.DB).recent({ accountId: me.id, kind: "test", since: new Date(Date.now() - 3600_000).toISOString(), limit: MAX_TEST_EMAILS_PER_HOUR })).length;
  if (sent >= MAX_TEST_EMAILS_PER_HOUR) throw new HttpError(429, `you can send at most ${MAX_TEST_EMAILS_PER_HOUR} test emails an hour; try again later`);
  return deliver(c.env, { kind: "test", data: { by: me.login }, to: { accountId: me.id }, reason: "account", at: now() });
}

/** Digests one account may ask for in an hour, on top of the scheduled one. */
export const MAX_DIGESTS_NOW_PER_HOUR = 3;

/** Send the morning digest now (not through the queue), even when it has nothing in it and whether or not it is turned on. */
export async function sendDigestNow(c: AppContext, me: Account) {
  const store = new MailStore(c.env.DB);
  const sent = (await store.recent({ accountId: me.id, kind: "digest", since: new Date(Date.now() - 3600_000).toISOString(), limit: MAX_DIGESTS_NOW_PER_HOUR + 1 })).length;
  if (sent >= MAX_DIGESTS_NOW_PER_HOUR) throw new HttpError(429, `you can ask for your digest at most ${MAX_DIGESTS_NOW_PER_HOUR} times an hour; try again later`);
  const at = new Date();
  return deliver(c.env, { kind: "digest", data: { since: digestSince(await store.digestLastSent(me.id), at), now: true }, to: { accountId: me.id }, reason: "digest", at: at.toISOString(), force: true });
}

// ---------------------------------------------------------------- the suppression list (suppression.ts)

export const suppressionJson = (s: Suppression) => ({ email: s.email, reason: s.reason, detail: s.detail, source: s.source, created_by: s.created_by, created_at: s.created_at, owner_can_lift: ownerCanLift(s) });

const audit = (c: AppContext, me: Account, action: string, target: string, detail: unknown) => c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action, target, detail });

/**
 * Email yourself a link that lifts a bounce or complaint on your own address. It is sent now and
 * past the suppression list: the only email that is. A manual suppression needs an administrator.
 */
export async function sendVerification(c: AppContext, me: Account) {
  if (!me.email) throw new HttpError(422, "your account has no email address");
  const s = await new Suppressions(c.env.DB).get(me.email);
  if (!s) throw new HttpError(409, "email to your address isn't suppressed, so there is nothing to verify");
  if (!ownerCanLift(s)) throw new HttpError(403, "a site administrator suppressed your address; ask one to remove it");
  const sent = (await new MailStore(c.env.DB).recent({ accountId: me.id, kind: "email_verify", since: new Date(Date.now() - 3600_000).toISOString(), limit: MAX_VERIFY_EMAILS_PER_HOUR })).length;
  if (sent >= MAX_VERIFY_EMAILS_PER_HOUR) throw new HttpError(429, `you can ask for at most ${MAX_VERIFY_EMAILS_PER_HOUR} verification emails an hour; try again later`);
  const expiresAt = Date.now() + VERIFY_HOURS * 3600_000;
  const url = `${c.env.PUBLIC_URL}/settings/email/verify/${await verifyToken(c.env, { accountId: me.id, email: me.email, expiresAt })}`;
  return deliver(c.env, { kind: "email_verify", data: { email: me.email, url, expiresAt: new Date(expiresAt).toISOString() }, to: { accountId: me.id }, reason: "account", at: now() }, { ignoreSuppression: true });
}

/** Follow a verification link: lift the suppression on your own address. Null when it was already lifted. */
export async function liftOwnSuppression(c: AppContext, me: Account, token: string): Promise<Suppression | null> {
  const t = await readVerifyToken(c.env, token);
  if (!t || t.accountId !== me.id) throw new HttpError(404, "this link doesn't work: it expired, or it was sent to another account");
  if (!me.email || normalAddress(me.email) !== t.email) throw new HttpError(409, "your email address changed after this link was sent");
  const list = new Suppressions(c.env.DB);
  const s = await list.get(t.email);
  if (!s) return null;
  if (!ownerCanLift(s)) throw new HttpError(403, "a site administrator suppressed your address; ask one to remove it");
  await list.remove(t.email);
  await audit(c, me, "email.suppression.lift", t.email, { reason: s.reason });
  return s;
}

/** A site administrator stops all email to an address. */
export async function adminSuppress(c: AppContext, me: Account, email: string, note: string): Promise<Suppression> {
  const addr = normalEmail(email);
  if (!addr) throw new HttpError(422, "enter a valid email address");
  const s = await new Suppressions(c.env.DB).add({ email: addr, reason: "manual", detail: note.slice(0, MAX_DETAIL) || null, source: "admin", by: me.login });
  await audit(c, me, "email.suppression.add", addr, { reason: "manual", source: "admin", detail: s.detail });
  return s;
}

/** A site administrator removes an address from the list, whatever put it there. */
export async function adminUnsuppress(c: AppContext, me: Account, email: string): Promise<Suppression> {
  const s = await new Suppressions(c.env.DB).remove(email);
  if (!s) throw new HttpError(404, "that address isn't suppressed");
  await audit(c, me, "email.suppression.remove", s.email, { reason: s.reason, source: s.source });
  return s;
}

const SuppressedNote: FC<{ s: Suppression }> = ({ s }) => (
  <>
    Since <Time at={s.created_at} />, Diffinery sends no email to <b>{s.email}</b> because {REASON_TEXT[s.reason]}
    {s.detail ? <> ({s.detail})</> : null}.
  </>
);

async function emailPage(c: AppContext, me: Account): Promise<Response> {
  const t = csrfToken(c);
  const s = me.email ? await new Suppressions(c.env.DB).get(me.email) : null;
  return settingsPage(
    c,
    me,
    "email-address",
    "Email",
    <>
      <h1>Email</h1>
      <div class="box">
        <div class="head">
          <h2>{me.email ?? "No email address"}</h2>
          {me.email ? s ? <span class="badge red">suppressed</span> : <span class="badge green">receiving email</span> : null}
        </div>
        <div class="body">
          {!me.email ? (
            <p class="m0">Your account has no email address, so Diffinery can't email you.</p>
          ) : !s ? (
            <p class="m0">
              Diffinery emails this address from {senderAddress(c.env)}. Choose what you get in <a href="/settings/notifications">notification settings</a>.
            </p>
          ) : (
            <>
              <p>
                <SuppressedNote s={s} /> That includes sign-in links, account recovery and security alerts.
              </p>
              {ownerCanLift(s) ? (
                <>
                  <p class="muted">If the inbox works again, or the spam report was a mistake, confirm the address: we send one email to it, and following its link while you're signed in turns email back on.</p>
                  <Form action="/settings/email/verify" t={t}>
                    <button class="btn primary">Send a verification email</button>
                  </Form>
                </>
              ) : (
                <p class="muted m0">Only a site administrator can lift a suppression they added. Ask one.</p>
              )}
            </>
          )}
        </div>
      </div>
    </>,
  );
}

async function readToken(c: AppContext): Promise<{ t: UnsubToken; account: Account } | null> {
  const t = await readUnsubToken(c.env, prm(c, "token")).catch(() => null);
  if (!t) return null;
  const account = await c.get("dir").account(t.accountId);
  if (!account || account.status === "disabled") return null;
  return { t, account };
}

async function applyUnsub(c: AppContext, t: UnsubToken, undo = false): Promise<void> {
  const store = new MailStore(c.env.DB);
  const s = t.scope;
  if (s.t === "category") {
    if (!(s.category in CATEGORY_TEXT)) throw new HttpError(400, "unknown kind of email");
    const p = await store.prefs(t.accountId);
    (p[s.category] as { email: boolean }).email = undo;
    await store.setPrefs(t.accountId, p);
  } else if (s.t === "thread") {
    if (undo) await store.clearThreadSub(t.accountId, s.repoId, s.number);
    else await store.setThreadSub(t.accountId, s.repoId, s.number, false);
  } else if (s.t === "repo") {
    await store.setWatch(t.accountId, s.repoId, undo ? "all" : "participating");
  }
}

const UnsubPage: FC<{ title: string; children?: Child }> = ({ title, children }) => (
  <div style="max-width:560px;margin:40px auto">
    <div class="box">
      <div class="body">
        <h1 style="margin-top:0">{title}</h1>
        {children}
      </div>
    </div>
  </div>
);

export function registerMailWeb(web: WebApp): void {
  // ------------------------------------------------------------ settings

  web.get("/settings/notifications", async (c) => notificationsPage(c, requireUser(c)));

  post(web, "/settings/notifications", async (c, f) => {
    const me = requireUser(c);
    return act(c, "/settings/notifications", () => new MailStore(c.env.DB).setPrefs(me.id, prefsFromForm(f)), "Notification settings saved.");
  });

  post(web, "/settings/notifications/test", async (c) => {
    const me = requireUser(c);
    const r = await sendTest(c, me).catch((e) => {
      if (e instanceof HttpError && e.status === 429) return { status: "refused", detail: e.message };
      throw e;
    });
    if (r.status === "sent") flash(c, "notice", `Test email sent to ${me.email}.`);
    else flash(c, "error", `The test email was ${r.status}: ${r.detail ?? "unknown reason"}`);
    return c.redirect("/settings/notifications", 303);
  });

  post(web, "/settings/notifications/digest", async (c) => {
    const me = requireUser(c);
    const r = await sendDigestNow(c, me).catch((e) => {
      if (e instanceof HttpError && e.status === 429) return { status: "refused", detail: e.detail };
      throw e;
    });
    if (r.status === "sent") flash(c, "notice", `Your digest was sent to ${me.email}.`);
    else flash(c, "error", `The digest was ${r.status}: ${r.detail ?? "unknown reason"}`);
    return c.redirect("/settings/notifications", 303);
  });

  // ------------------------------------------------------------ Settings → Email: suppressed or not, and verifying the address again

  web.get("/settings/email", async (c) => emailPage(c, requireUser(c)));

  post(web, "/settings/email/verify", async (c) => {
    const me = requireUser(c);
    return act(c, "/settings/email", async () => {
      const r = await sendVerification(c, me);
      if (r.status === "sent") flash(c, "notice", `We sent a verification email to ${me.email}. Follow its link within ${VERIFY_HOURS} hours, signed in as ${me.login}.`);
      else flash(c, "error", `The verification email was ${r.status}: ${r.detail ?? "unknown reason"}`);
    });
  });

  // The emailed link opens a page with a button: mail scanners that fetch links don't lift anything.
  web.get("/settings/email/verify/:token", async (c) => {
    const me = requireUser(c);
    const t = await readVerifyToken(c.env, prm(c, "token"));
    const ok = !!t && t.accountId === me.id;
    return render(
      c,
      { title: "Confirm your email address", status: ok ? 200 : 404 },
      ok ? (
        <UnsubPage title="Confirm your email address">
          <p>
            Turn email back on for <b>{t!.email}</b>, the address of <b>{me.login}</b>.
          </p>
          <Form action={c.req.path} t={csrfToken(c)}>
            <button class="btn primary">Confirm and get email again</button>
          </Form>
        </UnsubPage>
      ) : (
        <UnsubPage title="This link doesn't work">
          <p>
            It expired, or it was sent to another account. Ask for a new one in <a href="/settings/email">Settings → Email</a>.
          </p>
        </UnsubPage>
      ),
    );
  });

  post(web, "/settings/email/verify/:token", async (c) => {
    const me = requireUser(c);
    return act(c, "/settings/email", async () => {
      const s = await liftOwnSuppression(c, me, prm(c, "token"));
      flash(c, "notice", s ? `Confirmed. Diffinery emails ${me.email} again.` : `${me.email} wasn't suppressed any more.`);
    });
  });

  // ------------------------------------------------------------ unsubscribe (no sign-in: the signed link is the permission)

  web.get("/-/unsubscribe/:token", async (c) => {
    const x = await readToken(c);
    if (!x) return render(c, { title: "Unsubscribe", status: 404 }, <UnsubPage title="This link doesn't work">
        <p>It may be incomplete or the account no longer exists. You can change what you get by email in <a href="/settings/notifications">notification settings</a>.</p>
      </UnsubPage>);
    return render(
      c,
      { title: "Unsubscribe" },
      <UnsubPage title={scopeText(x.t.scope)}>
        <p class="muted">
          For <b>{x.account.login}</b>.
        </p>
        <form method="post" action={c.req.path}>
          <button class="btn primary">{scopeText(x.t.scope)}</button>
        </form>
        <p class="muted small mt">
          Or choose exactly what you get in <a href="/settings/notifications">notification settings</a>.
        </p>
      </UnsubPage>,
    );
  });

  // Mail apps send `List-Unsubscribe=One-Click` here (RFC 8058); the button above posts an empty form.
  web.post("/-/unsubscribe/:token", async (c) => {
    const x = await readToken(c);
    const form = await formData(c).catch(() => null);
    const oneClick = form?.s("List-Unsubscribe").toLowerCase() === "one-click";
    if (!x) return oneClick ? c.text("invalid link", 404) : c.redirect(c.req.path, 303);
    await applyUnsub(c, x.t);
    if (oneClick) return c.text("Unsubscribed.");
    return render(
      c,
      { title: "Unsubscribed" },
      <UnsubPage title="Done">
        <p>{scopeText(x.t.scope)}: done. You won't get these emails any more.</p>
        <form method="post" action={`${c.req.path}/undo`} class="inline">
          <button class="btn">Undo</button>
        </form>{" "}
        <a class="btn" href="/settings/notifications">
          Notification settings
        </a>
      </UnsubPage>,
    );
  });

  web.post("/-/unsubscribe/:token/undo", async (c) => {
    const x = await readToken(c);
    if (!x) return c.redirect(`/-/unsubscribe/${prm(c, "token")}`, 303);
    await applyUnsub(c, x.t, true);
    return render(
      c,
      { title: "Undone" },
      <UnsubPage title="Undone">
        <p>You'll get these emails again.</p>
        <a class="btn" href="/settings/notifications">
          Notification settings
        </a>
      </UnsubPage>,
    );
  });

  // ------------------------------------------------------------ watching and thread subscriptions

  post(web, "/:owner/:repo/subscription", async (c, f) => {
    const me = requireUser(c);
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read", { whileArchived: true, whileImporting: true });
    const back = f.s("back") === "/settings/notifications" ? "/settings/notifications" : repoUrl(l.repo);
    const level = WATCH_LEVELS.find((x) => x === f.s("level")) as WatchLevel | undefined;
    if (!level) throw new HttpError(422, "pick participating, all or ignore");
    const label = WATCH_OPTIONS.find((o) => o.value === level)!.label;
    return act(c, back, () => new MailStore(c.env.DB).setWatch(me.id, l.repo.id, level), `Watching ${l.repo.owner_login}/${l.repo.name}: ${label}.`);
  });

  post(web, "/:owner/:repo/issues/:number/subscription", async (c, f) => {
    const me = requireUser(c);
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read", { whileArchived: true, whileImporting: true });
    const n = Number(prm(c, "number"));
    if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "not found");
    const on = f.s("subscribed") === "1";
    return act(c, `${repoUrl(l.repo)}/issues/${n}`, () => new MailStore(c.env.DB).setThreadSub(me.id, l.repo.id, n, on), on ? "Subscribed. You'll be notified about all activity." : "Unsubscribed. You'll still be notified if you're @mentioned, assigned or asked to review.");
  });

  // ------------------------------------------------------------ site administration: Email

  web.get("/settings/admin/email", async (c) => {
    const me = requireSiteAdmin(c);
    const store = new MailStore(c.env.DB);
    const t = csrfToken(c);
    const since = new Date(Date.now() - 86400_000).toISOString();
    const [counts, rows, suppressed] = await Promise.all([store.counts(since), store.recent({ limit: 100 }), new Suppressions(c.env.DB).list()]);
    const samples = sampleJobs(c.env.PUBLIC_URL, { accountId: me.id }, me.login);
    const pick = samples.find((s) => s.id === c.req.query("sample")) ?? samples[0]!;
    return settingsPage(
      c,
      me,
      "email",
      "Email",
      <>
        <h1>Email</h1>
        <div class="box">
          <div class="body">
            <dl class="kv m0">
              <dt>Sending</dt>
              <dd>{c.env.EMAIL ? <span class="ok">Cloudflare Email Sending is bound</span> : <span class="bad">not configured (no EMAIL binding): emails are logged, not sent</span>}</dd>
              <dt>Queue</dt>
              <dd>{c.env.MAIL ? "diffinery-mail" : <span class="bad">not bound: emails are dropped</span>}</dd>
              <dt>From</dt>
              <dd>{senderAddress(c.env)}</dd>
              <dt>Bounces and complaints</dt>
              <dd>
                From the diffinery-mail-events queue (Email Sending event subscriptions) · signed endpoint {c.env.MAIL_EVENTS_SECRET ? <span class="ok">on</span> : <span class="faint">off (no MAIL_EVENTS_SECRET)</span>}
              </dd>
              <dt>Last 24 hours</dt>
              <dd>
                <span class="ok">{counts.sent} sent</span> · <span class={counts.failed ? "bad" : "faint"}>{counts.failed} failed</span> · <span class="faint">{counts.skipped} skipped</span>
              </dd>
            </dl>
          </div>
        </div>
        <div class="row mt mb">
          <Form action="/settings/notifications/test" t={t} class="inline">
            <button class="btn">Send me a test email</button>
          </Form>
          <Form action="/settings/admin/email/samples" t={t} class="inline" confirm={`Send all ${samples.length} templates to ${me.email}?`}>
            <button class="btn">Send every template to me</button>
          </Form>
        </div>

        <h2 id="suppressions">Suppressed addresses</h2>
        <p class="muted">
          Diffinery sends nothing to these addresses, sign-in links included. Bounces and spam complaints add them; people lift a bounce or complaint on their own address by verifying it in Settings → Email. Adding and removing is in the <a href="/settings/audit">audit log</a>.
        </p>
        <div class="box">
          {suppressed.length ? (
            <table class="tbl">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Why</th>
                  <th>Since</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {suppressed.map((x) => (
                  <tr>
                    <td>{x.email}</td>
                    <td class="small">
                      {x.reason}
                      <div class="muted small">
                        {x.source === "admin" ? `by ${x.created_by ?? "an administrator"}` : x.source === "send" ? "Email Sending refused a send" : `from ${x.source}`}
                        {x.detail ? ` · ${x.detail}` : ""}
                      </div>
                    </td>
                    <td class="small">
                      <Time at={x.created_at} />
                    </td>
                    <td style="text-align:right">
                      <Form action="/settings/admin/email/suppressions/remove" t={t} class="inline" confirm={`Send email to ${x.email} again?`}>
                        <input type="hidden" name="email" value={x.email} />
                        <button class="btn sm">Remove</button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="body">
              <p class="muted m0">No address is suppressed.</p>
            </div>
          )}
        </div>
        <Form action="/settings/admin/email/suppressions" t={t} class="box mb">
          <div class="body">
            <div class="formrow">
              <div class="field">
                <label for="sup-email">Suppress an address</label>
                <input id="sup-email" name="email" type="email" required placeholder="someone@example.com" autocomplete="off" />
              </div>
              <div class="field grow">
                <label for="sup-note">Note</label>
                <input id="sup-note" name="note" maxlength={MAX_DETAIL} placeholder="e.g. asked us to stop all email" />
              </div>
              <button class="btn">Suppress</button>
            </div>
          </div>
        </Form>

        <h2>Templates</h2>
        <form method="get" action="/settings/admin/email" class="row mb">
          <KSelect name="sample" options={samples.map((s) => ({ value: s.id, label: s.label }))} value={pick.id} label="Template" autosubmit />
          <a class="btn" href={`/settings/admin/email/preview/${pick.id}`} target="_blank" rel="noopener">
            Open HTML
          </a>
          <a class="btn" href={`/settings/admin/email/preview/${pick.id}?format=text`} target="_blank" rel="noopener">
            Plain text
          </a>
        </form>
        <iframe src={`/settings/admin/email/preview/${pick.id}`} title={`Preview: ${pick.label}`} style="width:100%;height:720px;border:1px solid var(--border);border-radius:8px;background:#fff" sandbox="" />

        <h2 class="mt">Recent emails</h2>
        <EmailLog rows={rows} showTo />
      </>,
    );
  });

  post(web, "/settings/admin/email/suppressions", async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, "/settings/admin/email#suppressions", async () => {
      const s = await adminSuppress(c, me, f.s("email"), f.s("note").trim());
      flash(c, "notice", `Diffinery sends no email to ${s.email} now.`);
    });
  });

  post(web, "/settings/admin/email/suppressions/remove", async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, "/settings/admin/email#suppressions", async () => {
      const s = await adminUnsuppress(c, me, f.s("email"));
      flash(c, "notice", `Removed ${s.email} from the suppression list: it gets email again.`);
    });
  });

  web.get("/settings/admin/email/preview/:id", async (c) => {
    const me = requireSiteAdmin(c);
    const s = sampleJobs(c.env.PUBLIC_URL, { accountId: me.id }, me.login).find((x) => x.id === c.req.param("id"));
    if (!s) throw new HttpError(404, "no such template");
    const msg = await buildMessage(c.env, s.job, { email: me.email ?? "you@example.com", name: me.name || undefined, login: me.login, accountId: me.id });
    c.header("content-security-policy", "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    c.header("x-frame-options", "SAMEORIGIN");
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "private, no-store");
    if (c.req.query("format") === "text") {
      const head = [`From: ${msg.from.name} <${msg.from.email}>`, `Subject: ${msg.subject}`, ...Object.entries(msg.headers).map(([k, v]) => `${k}: ${v}`)].join("\n");
      return c.text(`${head}\n\n${msg.text}`);
    }
    return c.html(msg.html);
  });

  post(web, "/settings/admin/email/samples", async (c) => {
    const me = requireSiteAdmin(c);
    const jobs = sampleJobs(c.env.PUBLIC_URL, { accountId: me.id }, me.login).map((s) => ({ ...s.job, force: true }) as MailJob);
    await enqueueMail(c.env, jobs);
    flash(c, "notice", `Queued ${jobs.length} emails to ${me.email}. They show up under Recent emails as they're sent.`);
    return c.redirect("/settings/admin/email", 303);
  });
}
