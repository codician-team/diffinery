/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { turnstileMode, verifyTurnstile } from "../auth/signup.js";
import type { Account, Directory } from "../lib/directory.js";
import {
  CONFIRM_HOURS,
  EarlyAccess,
  REMOVE_HOURS,
  HOSTING,
  MAX_COMPANY,
  MAX_NAME,
  MAX_USE_CASE,
  REQUEST_STATES,
  UNCONFIRMED_DAYS,
  checkStamp,
  confirmRequest,
  declineRequest,
  deleteRequest,
  earlyAccessOpen,
  formStamp,
  hostingLabel,
  inviteRequest,
  removeByToken,
  requestRemoval,
  submitRequest,
  validateRequest,
  type EarlyAccessRequest,
  type RequestState,
} from "../lib/early-access.js";
import { normalEmail } from "../auth/signup.js";
import { HttpError } from "../lib/util.js";
import type { FormData } from "./csrf.js";
import { ICONS } from "./assets.js";
import { SettingsNav } from "./account.js";
import { csrfToken } from "./csrf.js";
import { ComputePausedBanner } from "./kill-switches.js";
import { KSelect } from "./kumo.js";
import { Form, Pager, Time, act, flash, pageNum, post, prm, qs, render, statusOf, type WebApp } from "./ui.js";

/**
 * Early access in the web UI (lib/early-access.ts): the request form at /early-access that the home
 * page, the sign-in page and a closed /signup lead to, the confirmation page its email links to, and
 * the **Early access** page of site administration, where requests are invited, declined or deleted.
 */

/** Largest request form, in bytes: the use's cap with room for percent-encoded UTF-8. */
const MAX_FORM_BYTES = 32 * 1024;
const BASE = "/settings/admin/early-access";

const TURNSTILE_MISSING = "This instance has no Turnstile configured (TURNSTILE_SITE_KEY and TURNSTILE_SECRET), so it can't take early access requests from the web yet. Ask someone who uses it for an invitation.";

export const STATE_TEXT: Record<RequestState, string> = { confirmed: "Confirmed", unconfirmed: "Unconfirmed", invited: "Invited", declined: "Declined" };
const STATE_BADGE: Record<RequestState, string> = { confirmed: "badge blue", unconfirmed: "badge", invited: "badge green", declined: "badge red" };
const StateBadge: FC<{ state: RequestState }> = ({ state }) => <span class={STATE_BADGE[state]}>{STATE_TEXT[state]}</span>;

interface FormValues {
  email?: string;
  name?: string;
  company?: string;
  useCase?: string;
  hosting?: string;
}

// ---------------------------------------------------------------- the request form

const Point: FC<{ icon: string; title: string; children: Child }> = ({ icon, title, children }) => (
  <li>
    <span class="ic">{raw(icon)}</span>
    <span>
      <b>{title}</b>
      <span class="muted">{children}</span>
    </span>
  </li>
);

async function requestPage(c: AppContext, o: { values?: FormValues; error?: string; status?: number } = {}): Promise<Response> {
  const mode = turnstileMode(c.env);
  const siteKey = mode === "verify" ? c.env.TURNSTILE_SITE_KEY : undefined;
  const v = o.values ?? {};
  const stamp = mode === "missing" ? "" : await formStamp(c.env);
  return render(
    c,
    { title: "Request early access", status: o.status, turnstile: !!siteKey, description: "This Diffinery instance is invite-only. Ask its administrators for an invitation." },
    <div class="ea">
      <section class="ea-head">
        <span class="ea-eyebrow">{raw(ICONS.rocket)} Early access</span>
        <h1>Request early access to Diffinery</h1>
        <p class="ea-lede">
          This Diffinery instance is invite-only. Tell its administrators a little about yourself, and they can email you an invitation. Want Diffinery for your own team? It's open source: <a href="/docs/self-hosting">deploy your own</a>.
        </p>
      </section>
      <section class="ea-more">
        <ul class="ea-points">
          <Point icon={ICONS.repo} title="Git hosting and pull requests">
            Repositories, reviews with intent, issues, releases and a container registry.
          </Point>
          <Point icon={ICONS.play} title="Your GitHub Actions workflows, as they are">
            Bring your workflow YAML. Jobs start in seconds on Cloudflare, with live logs and caches.
          </Point>
          <Point icon={ICONS.bot} title="Built for agents, with a human in the loop">
            Claude Code, Codex and other agents work through their own accounts, with guardrails you set.
          </Point>
        </ul>
        <ol class="ea-steps">
          <li>Send this form.</li>
          <li>Confirm your email address with the link we send you.</li>
          <li>If an administrator invites you, you get an email to create your passkey.</li>
        </ol>
      </section>
      <div class="box ea-card">
        <div class="body">
          {mode === "missing" ? (
            <p class="m0">
              {TURNSTILE_MISSING} Already invited? <a href="/login">Sign in</a>.
            </p>
          ) : (
            <Form action="/early-access" t={csrfToken(c)}>
              <h2>Tell us about you</h2>
              <p class="muted small">Only your email address is required.</p>
              {o.error ? (
                <div class="flash error" role="alert">
                  {o.error}
                </div>
              ) : null}
              <div class="field">
                <label for="ea-email">Work email</label>
                <input id="ea-email" name="email" type="email" required maxlength={254} value={v.email} autocomplete="email" placeholder="you@company.com" />
              </div>
              <div class="formrow" style="margin-bottom:14px">
                <div class="field grow">
                  <label for="ea-name">Name (optional)</label>
                  <input id="ea-name" name="name" type="text" maxlength={MAX_NAME} value={v.name} autocomplete="name" />
                </div>
                <div class="field grow">
                  <label for="ea-company">Company or team (optional)</label>
                  <input id="ea-company" name="company" type="text" maxlength={MAX_COMPANY} value={v.company} autocomplete="organization" />
                </div>
              </div>
              <div class="field">
                <label for="ea-use">What would you use Diffinery for? (optional)</label>
                <textarea id="ea-use" name="use_case" maxlength={MAX_USE_CASE} style="min-height:96px" placeholder="e.g. Moving 40 repositories and their CI off GitHub, and letting our agents open pull requests.">
                  {v.useCase ?? ""}
                </textarea>
              </div>
              <div class="field">
                <label>Where do you host your code today? (optional)</label>
                <KSelect name="hosting" label="Where do you host your code today?" value={v.hosting ?? ""} options={[{ value: "", label: "Choose one" }, ...HOSTING.map((h) => ({ value: h.value, label: h.label }))]} />
              </div>
              <Protections stamp={stamp} siteKey={siteKey} />
              <button class="btn primary block">Request early access</button>
              <p class="ea-privacy">
                We keep what you send only to review your request and invite you, and delete it if you never confirm your address. Site administrators can see it; nobody else can. You can <a href="/early-access/remove">remove your request</a> at any time.
              </p>
            </Form>
          )}
        </div>
      </div>
    </div>,
  );
}

/** What everyone sees after sending the form, whatever happened to it. */
function sentPage(c: AppContext, email: string): Response | Promise<Response> {
  return render(
    c,
    { title: "Check your inbox" },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.envelope)}</span>
      <h1>Check your inbox</h1>
      <p>
        If <b>{email}</b> can get an invitation, we've sent it a link to confirm your request. Open it within {CONFIRM_HOURS} hours and your request joins the list.
      </p>
      <p class="muted">
        Nothing there? Check your spam folder. If this address already asked or already has an account, the email says so instead. Unconfirmed requests are deleted after {UNCONFIRMED_DAYS} days.
      </p>
      <p class="row" style="justify-content:center">
        <a class="btn" href="/">
          Back to the home page
        </a>
        <a class="btn" href="/docs">
          Read the docs meanwhile
        </a>
      </p>
    </div>,
  );
}

/** What everyone sees after asking for a removal link, whether or not there is a request. */
function removalSentPage(c: AppContext, email: string): Response | Promise<Response> {
  return render(
    c,
    { title: "Check your inbox" },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.envelope)}</span>
      <h1>Check your inbox</h1>
      <p>
        If there's an early access request for <b>{email}</b>, we've sent it a link to remove it. The link works once, for {REMOVE_HOURS} hours.
      </p>
      <p class="muted">Nothing is deleted until the link is opened.</p>
    </div>,
  );
}

/** Runs on the confirmation page: takes the token from the fragment (never sent to the server in a request line) into the form. */
const CONFIRM_SCRIPT = `(function(){var f=document.getElementById("ea-confirm"),s=document.getElementById("ea-confirm-status");if(!f||!s)return;function go(){var t=location.hash.slice(1);if(!t){if(!f.elements.token.value){s.textContent="This link is incomplete. Open it again from the email, in full.";}return;}if(!/^[A-Za-z0-9_-]{20,100}$/.test(t)){s.textContent="This link is incomplete. Open it again from the email, in full.";f.style.display="none";return;}history.replaceState(null,"",location.pathname);f.elements.token.value=t;s.textContent="";f.style.display="";}go();addEventListener("hashchange",go);})();`;

function confirmPage(c: AppContext): Response | Promise<Response> {
  return render(
    c,
    { title: "Confirm your request", script: CONFIRM_SCRIPT },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.envelope)}</span>
      <h1>Confirm your early access request</h1>
      <p class="muted" id="ea-confirm-status" aria-live="polite">
        Checking your link…
      </p>
      <noscript>
        <p class="muted">Turn on JavaScript for this page to confirm your request: the link's code stays in your browser until you press the button.</p>
      </noscript>
      <Form action="/early-access/confirm" t={csrfToken(c)} id="ea-confirm" style="display:none">
        <input type="hidden" name="token" value="" />
        <p>Press the button to confirm that this is your email address. Your request then joins the list the team reviews.</p>
        <button class="btn primary">Confirm my request</button>
      </Form>
    </div>,
  );
}

function confirmedPage(c: AppContext, r: EarlyAccessRequest | null): Response | Promise<Response> {
  if (!r)
    return render(
      c,
      { title: "This link doesn't work", status: 410 },
      <div class="ea-done">
        <span class="ic">{raw(ICONS.x)}</span>
        <h1>This link doesn't work any more</h1>
        <p class="muted">
          Confirmation links work once, for {CONFIRM_HOURS} hours, and only the newest one sent to an address works. If you already confirmed, you're on the list and there's nothing else to do.
        </p>
        <p>
          <a class="btn primary" href="/early-access">
            Request early access again
          </a>
        </p>
      </div>,
    );
  return render(
    c,
    { title: "You're on the list" },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.check)}</span>
      <h1>You're on the list</h1>
      <p>
        Thanks for confirming, <b>{r.name || r.email}</b>. The team reviews each request, and we'll email <b>{r.email}</b> an invitation when there's a place for you.
      </p>
      <p class="muted">The invitation lets you pick a username and sign in with a passkey: your fingerprint, face or screen lock, with no password to remember.</p>
      <p class="row" style="justify-content:center">
        <a class="btn" href="/docs">
          Read the docs meanwhile
        </a>
      </p>
    </div>,
  );
}

// ---------------------------------------------------------------- site administration

/** The initial on a request's avatar: its name's or its address's first letter. */
const initial = (r: Pick<EarlyAccessRequest, "name" | "email">) => (r.name || r.email).trim().charAt(0).toUpperCase() || "?";

const Actions: FC<{ r: EarlyAccessRequest; t: string; back: string; hasAccount: boolean }> = ({ r, t, back, hasAccount }) => (
  <>
    {(r.state === "confirmed" || r.state === "unconfirmed") && !hasAccount ? (
      <Form action={`${BASE}/${r.id}/invite`} t={t} class="inline" confirm={`Send ${r.email} an invitation to Diffinery? It works once for 14 days.`}>
        <input type="hidden" name="back" value={back} />
        <button class="btn sm primary">{raw(ICONS.envelope)} Invite</button>
      </Form>
    ) : null}{" "}
    {r.state === "confirmed" || r.state === "unconfirmed" ? (
      <Form action={`${BASE}/${r.id}/decline`} t={t} class="inline">
        <input type="hidden" name="back" value={back} />
        <button class="btn sm">Decline</button>
      </Form>
    ) : null}
    {r.state === "declined" ? (
      <Form action={`${BASE}/${r.id}/restore`} t={t} class="inline">
        <input type="hidden" name="back" value={back} />
        <button class="btn sm">Put back</button>
      </Form>
    ) : null}
  </>
);

type Row = EarlyAccessRequest & { account_login: string | null };

/** Requests with the login of an active account that already uses the address, if any. */
async function withAccounts(db: D1Database, rows: EarlyAccessRequest[]): Promise<Row[]> {
  if (!rows.length) return [];
  const found = (
    await db
      .prepare(`SELECT lower(email) AS email, login FROM accounts WHERE kind = 'user' AND status = 'active' AND lower(email) IN (${rows.map(() => "?").join(", ")})`)
      .bind(...rows.map((r) => r.email.toLowerCase()))
      .all<{ email: string; login: string }>()
  ).results;
  const by = new Map(found.map((f) => [f.email, f.login]));
  return rows.map((r) => ({ ...r, account_login: by.get(r.email.toLowerCase()) ?? null }));
}

/**
 * The checks every public form here makes before it does anything: Turnstile is configured, the
 * honeypot is empty, the timing stamp is genuine and the form wasn't sent faster than a person types
 * ("silent": answer as if it worked and keep nothing), and the Turnstile token is good.
 */
async function guard(c: AppContext, f: FormData): Promise<"ok" | "silent"> {
  const mode = turnstileMode(c.env);
  if (mode === "missing") throw new HttpError(503, TURNSTILE_MISSING);
  const stamp = await checkStamp(c.env, f.s("stamp"));
  if (f.s("website") !== "" || stamp === "fast" || stamp === "bad") return "silent";
  if (stamp === "stale") throw new HttpError(422, "This form was open for a long time. Please check it and send it again.");
  if (mode === "verify" && !(await verifyTurnstile(c.env.TURNSTILE_SECRET!, f.s("cf-turnstile-response"), c.req.header("cf-connecting-ip") ?? null))) throw new HttpError(403, "We couldn't confirm that you're a person. Please try again.");
  return "ok";
}

/** The honeypot, timing stamp and Turnstile widget every public form here carries. */
const Protections: FC<{ stamp: string; siteKey?: string }> = ({ stamp, siteKey }) => (
  <>
    {/* A field people never see or fill in: a script filling every field gives itself away. */}
    <div class="ea-hp" aria-hidden="true">
      <label for="ea-website">Leave this empty</label>
      <input id="ea-website" name="website" type="text" tabindex={-1} autocomplete="off" />
    </div>
    <input type="hidden" name="stamp" value={stamp} />
    {siteKey ? <div class="cf-turnstile" data-sitekey={siteKey} data-theme="auto" style="margin-bottom:12px"></div> : null}
  </>
);

// ---------------------------------------------------------------- removing your own request

async function removePage(c: AppContext, o: { email?: string; error?: string; status?: number } = {}): Promise<Response> {
  const mode = turnstileMode(c.env);
  const siteKey = mode === "verify" ? c.env.TURNSTILE_SITE_KEY : undefined;
  const stamp = mode === "missing" ? "" : await formStamp(c.env);
  return render(
    c,
    { title: "Remove your early access request", status: o.status, turnstile: !!siteKey },
    <div style="max-width:520px;margin:48px auto">
      <h1>Remove your early access request</h1>
      <p class="muted">We'll email the address a link that deletes its request and everything stored about it. Nothing is deleted until the link is opened, so nobody else can remove your request.</p>
      <div class="box ea-card">
        <div class="body">
          {mode === "missing" ? (
            <p class="m0">{TURNSTILE_MISSING}</p>
          ) : (
            <Form action="/early-access/remove" t={csrfToken(c)}>
              {o.error ? (
                <div class="flash error" role="alert">
                  {o.error}
                </div>
              ) : null}
              <div class="field">
                <label for="ea-remove-email">Email address of the request</label>
                <input id="ea-remove-email" name="email" type="email" required maxlength={254} value={o.email} autocomplete="email" />
              </div>
              <Protections stamp={stamp} siteKey={siteKey} />
              <button class="btn block">Email me a removal link</button>
            </Form>
          )}
        </div>
      </div>
    </div>,
  );
}

/** Runs on the removal page: the same as CONFIRM_SCRIPT, for the removal form. */
const REMOVE_SCRIPT = CONFIRM_SCRIPT.replace('"ea-confirm"', '"ea-remove"').replace('"ea-confirm-status"', '"ea-remove-status"');

const backTo = (v: string): string => (v.startsWith(`${BASE}`) && !v.startsWith("//") && !/[\r\n]/.test(v) ? v : BASE);

export function registerEarlyAccess(web: WebApp): void {
  // ------------------------------------------------------------ the form

  web.get("/early-access", (c) => {
    if (!earlyAccessOpen(c.env)) return c.redirect("/signup", 302);
    // Local development's fixed identity (DEV_AUTH) still sees the form, like /signup.
    const p = c.get("principal");
    if (p.type === "account" && p.via !== "dev") return c.redirect("/", 302);
    return requestPage(c);
  });

  post(
    web,
    "/early-access",
    async (c, f) => {
      if (!earlyAccessOpen(c.env)) return c.redirect("/signup", 303);
      const values: FormValues = { email: f.s("email").slice(0, 254), name: f.s("name").slice(0, MAX_NAME * 2), company: f.s("company").slice(0, MAX_COMPANY * 2), useCase: f.s("use_case").slice(0, MAX_USE_CASE * 2), hosting: f.s("hosting").slice(0, 40) };
      try {
        // A filled honeypot or a form sent faster than a person types: answer as if it worked, keep nothing.
        if ((await guard(c, f)) === "silent") return sentPage(c, values.email?.trim() || "your address");
        const ip = c.req.header("cf-connecting-ip") ?? null;
        const input = validateRequest({ email: values.email, name: values.name, company: values.company, useCase: values.useCase, hosting: values.hosting });
        await submitRequest(c.env, input, ip);
        return sentPage(c, input.email);
      } catch (e) {
        const s = statusOf(e);
        if (s.status >= 500 && s.status !== 503) throw e;
        return requestPage(c, { values, error: s.message, status: s.status });
      }
    },
    { maxBytes: MAX_FORM_BYTES },
  );

  web.get("/early-access/confirm", (c) => confirmPage(c));

  post(
    web,
    "/early-access/confirm",
    async (c, f) => {
      const r = await confirmRequest(c.env, (e) => c.get("dir").audit(e), f.s("token").slice(0, 200));
      return confirmedPage(c, r);
    },
    { maxBytes: 4096 },
  );

  web.get("/early-access/remove", (c) => removePage(c));

  post(
    web,
    "/early-access/remove",
    async (c, f) => {
      const typed = f.s("email").slice(0, 254);
      try {
        if ((await guard(c, f)) === "silent") return removalSentPage(c, typed.trim() || "your address");
        const email = normalEmail(typed);
        if (!email) throw new HttpError(422, "Enter a valid email address, like you@example.com.");
        await requestRemoval(c.env, email, c.req.header("cf-connecting-ip") ?? null);
        return removalSentPage(c, email);
      } catch (e) {
        const s = statusOf(e);
        if (s.status >= 500 && s.status !== 503) throw e;
        return removePage(c, { email: typed, error: s.message, status: s.status });
      }
    },
    { maxBytes: 8192 },
  );

  web.get("/early-access/remove/confirm", (c) =>
    render(
      c,
      { title: "Remove your request", script: REMOVE_SCRIPT },
      <div class="ea-done">
        <span class="ic">{raw(ICONS.trash)}</span>
        <h1>Remove your early access request</h1>
        <p class="muted" id="ea-remove-status" aria-live="polite">
          Checking your link…
        </p>
        <noscript>
          <p class="muted">Turn on JavaScript for this page to remove your request: the link's code stays in your browser until you press the button.</p>
        </noscript>
        <Form action="/early-access/remove/confirm" t={csrfToken(c)} id="ea-remove" style="display:none">
          <input type="hidden" name="token" value="" />
          <p>Press the button to delete your request and everything stored about it. This can't be undone; you can always ask again later.</p>
          <button class="btn danger">Remove my request</button>
        </Form>
      </div>,
    ),
  );

  post(
    web,
    "/early-access/remove/confirm",
    async (c, f) => {
      const ok = await removeByToken(c.env, (e) => c.get("dir").audit(e), f.s("token").slice(0, 200));
      return render(
        c,
        { title: ok ? "Request removed" : "This link doesn't work", status: ok ? 200 : 410 },
        <div class="ea-done">
          <span class="ic">{raw(ok ? ICONS.check : ICONS.x)}</span>
          <h1>{ok ? "Your request is removed" : "This link doesn't work any more"}</h1>
          <p class="muted">{ok ? "We deleted your early access request and everything stored about it. If you change your mind, you're welcome to ask again." : `Removal links work once, for ${REMOVE_HOURS} hours, and only the newest one sent to an address works. If you already used it, your request is gone.`}</p>
          <p>
            <a class="btn" href={ok ? "/" : "/early-access/remove"}>
              {ok ? "Back to the home page" : "Ask for a new link"}
            </a>
          </p>
        </div>,
      );
    },
    { maxBytes: 4096 },
  );

  // ------------------------------------------------------------ site administration: Early access

  /** Requests don't exist for anyone but site administrators: 404, not 403. */
  const requireSiteAdmin = (c: AppContext): Account => {
    const me = requireAccount(c);
    if (!me.site_admin || me.kind !== "user") throw new HttpError(404, "not found");
    return me;
  };

  const page = (c: AppContext, me: Account, title: string, body: Child) =>
    render(
      c,
      { title },
      <div class="grid left">
        <SettingsNav me={me} tab="early-access" db={c.env.DB} />
        <div>
          <ComputePausedBanner env={c.env} />
          {body}
        </div>
      </div>,
    );

  const PER_PAGE = 50;

  web.get(BASE, async (c) => {
    const me = requireSiteAdmin(c);
    const qState = c.req.query("state");
    const state: RequestState | "all" = qState === "all" ? "all" : REQUEST_STATES.includes(qState as RequestState) ? (qState as RequestState) : "confirmed";
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const pg = pageNum(c);
    const store = new EarlyAccess(c.env.DB);
    const [list, counts] = await Promise.all([store.list({ state: state === "all" ? undefined : state, q, limit: PER_PAGE, offset: (pg - 1) * PER_PAGE }), store.counts()]);
    const rows = await withAccounts(c.env.DB, list.items);
    const total = counts.confirmed + counts.unconfirmed + counts.invited + counts.declined;
    const here = `${BASE}${qs({ state: state === "confirmed" ? undefined : state, q, page: pg > 1 ? pg : undefined })}`;
    const t = csrfToken(c);
    const tab = (s: RequestState | "all", label: string, n: number) => (
      <a href={`${BASE}${qs({ state: s === "confirmed" ? undefined : s, q })}`} class={state === s ? "on" : ""}>
        {label} <span class="n">{n}</span>
      </a>
    );
    return page(
      c,
      me,
      "Early access",
      <>
        <h1>Early access</h1>
        <p class="muted">
          Requests from <a href="/early-access">/early-access</a>, where people without an invitation ask for one. A request is confirmed once its address follows the emailed link. Inviting sends the usual <a href="/settings/admin">instance invitation</a>; declining emails nobody. Every decision is in the <a href="/settings/audit">audit log</a>.
        </p>
        <nav class="tabs mb" aria-label="Requests by state">
          {tab("confirmed", "Confirmed", counts.confirmed)}
          {tab("unconfirmed", "Unconfirmed", counts.unconfirmed)}
          {tab("invited", "Invited", counts.invited)}
          {tab("declined", "Declined", counts.declined)}
          {tab("all", "All", total)}
        </nav>
        <form method="get" action={BASE} class="row mb" role="search">
          {state === "confirmed" ? null : <input type="hidden" name="state" value={state} />}
          <input type="search" name="q" value={q} maxlength={100} placeholder="Search by email, name, company or use" aria-label="Search requests" class="grow" style="max-width:420px" />
          <button class="btn">{raw(ICONS.search)} Search</button>
          {q ? (
            <a class="btn" href={`${BASE}${qs({ state: state === "confirmed" ? undefined : state })}`}>
              Clear
            </a>
          ) : null}
        </form>
        <div class="box">
          {rows.length ? (
            <ul class="list ea-list">
              {rows.map((r) => (
                <li>
                  <span class="ea-av" aria-hidden="true">
                    {initial(r)}
                  </span>
                  <div class="grow" style="min-width:0">
                    <div class="row" style="gap:6px;flex-wrap:wrap">
                      <a class="title" href={`${BASE}/${r.id}`}>
                        {r.name || r.email}
                      </a>
                      {r.name ? <span class="muted small">{r.email}</span> : null}
                      <StateBadge state={r.state} />
                      {r.account_login ? <span class="badge amber">has an account: {r.account_login}</span> : null}
                    </div>
                    <div class="meta">
                      {[r.company, hostingLabel(r.hosting) ? `hosts on ${hostingLabel(r.hosting)}` : null].filter(Boolean).join(" · ")}
                      {r.company || r.hosting ? " · " : ""}
                      requested <Time at={r.created_at} />
                      {r.decided_by ? (
                        <>
                          {" "}
                          · {r.state === "invited" ? "invited" : "declined"} by {r.decided_by} <Time at={r.decided_at} />
                        </>
                      ) : null}
                    </div>
                    {r.use_case ? <div class="ea-use">{r.use_case}</div> : null}
                  </div>
                  <div class="ea-actions nowrap">
                    <Actions r={r} t={t} back={here} hasAccount={!!r.account_login} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">{q ? "No requests match your search." : state === "confirmed" ? "No confirmed requests are waiting. New ones show up here once their address confirms." : state === "all" ? "No early access requests yet." : `No ${STATE_TEXT[state].toLowerCase()} requests.`}</div>
          )}
        </div>
        <Pager page={pg} hasNext={list.more} href={(p) => `${BASE}${qs({ state: state === "confirmed" ? undefined : state, q, page: p > 1 ? p : undefined })}`} />
      </>,
    );
  });

  web.get(`${BASE}/:id`, async (c) => {
    const me = requireSiteAdmin(c);
    const found = await new EarlyAccess(c.env.DB).get(prm(c, "id"));
    if (!found) throw new HttpError(404, "no early access request with that id");
    const [r] = (await withAccounts(c.env.DB, [found])) as [Row];
    const t = csrfToken(c);
    const here = `${BASE}/${r.id}`;
    return page(
      c,
      me,
      `Early access: ${r.name || r.email}`,
      <>
        <p class="small">
          <a href={BASE}>← Early access</a>
        </p>
        <div class="row mb" style="gap:12px;align-items:center">
          <span class="ea-av lg" aria-hidden="true">
            {initial(r)}
          </span>
          <div class="grow" style="min-width:0">
            <h1 class="m0" style="overflow-wrap:anywhere">{r.name || r.email}</h1>
            <div class="row" style="gap:6px;margin-top:4px">
              <StateBadge state={r.state} />
              {r.account_login ? <span class="badge amber">has an account: {r.account_login}</span> : null}
            </div>
          </div>
          <div class="nowrap">
            <Actions r={r} t={t} back={here} hasAccount={!!r.account_login} />
          </div>
        </div>
        <div class="box">
          <div class="body">
            <dl class="kv m0">
              <dt>Email</dt>
              <dd style="overflow-wrap:anywhere">
                <a href={`mailto:${r.email}`}>{r.email}</a>
              </dd>
              <dt>Name</dt>
              <dd>{r.name ?? <span class="muted">not given</span>}</dd>
              <dt>Company or team</dt>
              <dd>{r.company ?? <span class="muted">not given</span>}</dd>
              <dt>Hosts code on</dt>
              <dd>{hostingLabel(r.hosting) ?? <span class="muted">not given</span>}</dd>
              <dt>Requested</dt>
              <dd>
                <Time at={r.created_at} /> <span class="muted small">{r.created_at}</span>
              </dd>
              <dt>Confirmed</dt>
              <dd>{r.confirmed_at ? <Time at={r.confirmed_at} /> : <span class="muted">not yet: the address hasn't followed the emailed link</span>}</dd>
              {r.decided_by ? (
                <>
                  <dt>{r.state === "invited" ? "Invited" : "Declined"}</dt>
                  <dd>
                    by {r.decided_by} <Time at={r.decided_at} />
                  </dd>
                </>
              ) : null}
              {r.account_login ? (
                <>
                  <dt>Account</dt>
                  <dd>
                    <a href={`/${r.account_login}`}>{r.account_login}</a> <span class="muted small">already uses this address</span>
                  </dd>
                </>
              ) : null}
              <dt>Reference</dt>
              <dd class="mono">{r.id}</dd>
            </dl>
          </div>
        </div>
        <h2>What they'd use Diffinery for</h2>
        <div class="box">
          {/* Plain text exactly as sent: never rendered as Markdown or HTML. */}
          {r.use_case ? (
            <pre class="body m0" style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--sans);font-size:14px">
              {r.use_case}
            </pre>
          ) : (
            <div class="empty">Not given.</div>
          )}
        </div>
        <h2>Delete</h2>
        <Form action={`${BASE}/${r.id}/delete`} t={t} class="box" confirm={`Delete the request from ${r.email} and everything stored about it? This can't be undone.`}>
          <div class="body row between" style="gap:12px;flex-wrap:wrap">
            <span class="muted">
              For someone who asks for their data to be removed. The audit log keeps that a request was deleted, not what it said.
              {r.state === "invited" ? " The invitation already sent stays; revoke it in People and invitations." : ""}
            </span>
            <button class="btn danger">{raw(ICONS.trash)} Delete request</button>
          </div>
        </Form>
      </>,
    );
  });

  const audit = (c: AppContext) => (e: Parameters<Directory["audit"]>[0]) => c.get("dir").audit(e);

  post(web, `${BASE}/:id/invite`, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, backTo(f.s("back")), async () => {
      const r = await inviteRequest(c.env, c.get("dir"), audit(c), me, prm(c, "id"), "web");
      return void flashNotice(c, `Invited ${r.email}. They'll get the invitation email shortly.`);
    });
  });
  post(web, `${BASE}/:id/decline`, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, backTo(f.s("back")), async () => {
      const r = await declineRequest(c.env.DB, audit(c), me, prm(c, "id"), false, "web");
      return void flashNotice(c, `Declined the request from ${r.email}. Nobody was emailed.`);
    });
  });
  post(web, `${BASE}/:id/restore`, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, backTo(f.s("back")), async () => {
      const r = await declineRequest(c.env.DB, audit(c), me, prm(c, "id"), true, "web");
      return void flashNotice(c, `The request from ${r.email} is ${STATE_TEXT[r.state].toLowerCase()} again.`);
    });
  });
  post(web, `${BASE}/:id/delete`, async (c) => {
    const me = requireSiteAdmin(c);
    return act(c, `${BASE}/${encodeURIComponent(prm(c, "id"))}`, async () => {
      await deleteRequest(c.env.DB, audit(c), me, prm(c, "id"), "web");
      flashNotice(c, "Request deleted.");
      return BASE;
    });
  });
}

const flashNotice = (c: AppContext, message: string) => flash(c, "notice", message);
