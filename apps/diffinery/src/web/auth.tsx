/** @jsxImportSource hono/jsx */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import { RECENT_SIGNIN_MS, accessToken, requireRecentSignIn, type AppContext } from "../auth/principal.js";
import { Auth, CHALLENGE_COOKIE, SESSION_COOKIE, SESSION_DAYS, type PasskeyRow, type Subject } from "../auth/sessions.js";
import type { Account } from "../lib/directory.js";
import { verifyAccessJwt } from "../lib/jwt.js";
import { HttpError, b64url, fromB64url, isValidLogin, newId, now, sha256 } from "../lib/util.js";
import { ICONS } from "./assets.js";
import { Form, act, confirmUrl, flash, post, prm, render, statusOf, type WebApp } from "./ui.js";
import { csrfToken } from "./csrf.js";
import { validInviteProof } from "../auth/invite-proof.js";
import { CODE_MINUTES, Signups, normalEmail, signupOpen, turnstileMode, verifyTurnstile } from "../auth/signup.js";
import { enqueueMail } from "../mail/send.js";

/**
 * Passkey (WebAuthn) sign-in. Browsers sign in with a passkey and get a
 * session cookie. New people create their passkey from an invite link (or,
 * with SIGNUP=open, after confirming their email at /signup), and admins can
 * issue one-time sign-in links to add a passkey to an existing account. Cloudflare Access, when configured, protects only /auth/access and
 * serves as an email-based recovery path.
 */

const CEREMONY_TIMEOUT = 120_000;

/**
 * `path` when it is a path on this site, otherwise null. Browsers drop tabs and newlines
 * from URLs and read a backslash as `/`, so `/<tab>/evil.com` and `/\evil.com` lead off-site.
 */
export function localPath(path: unknown): string | null {
  if (typeof path !== "string" || /[\x00-\x1f\x7f]/.test(path)) return null;
  return /^\/(?![/\\])/.test(path) ? path : null;
}

/** Only same-site relative paths are allowed as post-sign-in destinations. */
export function safeNext(next: unknown): string {
  return localPath(next) ?? "/";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A login suggestion from an email address. */
export function loginFromEmail(email: string): string {
  return (email.split("@")[0] ?? "").replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 39) || "user";
}

/** A friendly default name for a new passkey, from the browser's user agent. */
export function deviceLabel(ua: string | undefined): string {
  const u = ua ?? "";
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Mac OS X|Macintosh/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /CrOS/.test(u) ? "ChromeOS" : /Linux/.test(u) ? "Linux" : "";
  const browser = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "";
  return [os, browser].filter(Boolean).join(" · ") || "Passkey";
}

/** Where a sign-in came from, for the audit log and the "new sign-in" email. */
export function signinContext(c: AppContext): { device: string; ip?: string; location?: string } {
  const cf = (c.req.raw as { cf?: { city?: string; region?: string; country?: string } }).cf;
  const location = [cf?.city, cf?.country].filter(Boolean).join(", ") || undefined;
  return { device: deviceLabel(c.req.header("user-agent")), ip: c.req.header("cf-connecting-ip") ?? undefined, location };
}

/** Sign this browser in; returns the new session's id. */
async function startSession(c: AppContext, auth: Auth, accountId: string, method: "passkey" | "access" | "link", passkeyId: string | null): Promise<string> {
  const old = getCookie(c, SESSION_COOKIE);
  if (old) await auth.endSession(old);
  const token = await auth.createSession(accountId, method, passkeyId, c.req.header("user-agent") ?? null);
  setCookie(c, SESSION_COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: SESSION_DAYS * 86400 });
  return sha256(token);
}

/** What recovering an account (by email, or with a sign-in link) does to the account's other browsers. */
const RECOVERY_NOTE = "Every other browser signed in to your account was signed out; your access tokens keep working.";

function setChallenge(c: AppContext, token: string): void {
  setCookie(c, CHALLENGE_COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "Strict", maxAge: 300 });
}

function takeChallengeCookie(c: AppContext): string | undefined {
  const v = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/", secure: true });
  return v;
}

/** JSON endpoint for the browser's passkey script: JSON in, JSON out, JSON errors. */
function jsonPost(web: WebApp, path: string, handler: (c: AppContext, body: Record<string, unknown>) => Promise<Response>): void {
  web.post(path, async (c) => {
    try {
      // A JSON content type forces a CORS preflight, so other sites cannot drive these endpoints.
      if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) throw new HttpError(415, "expected JSON");
      const body = await c.req.json<Record<string, unknown>>().catch(() => {
        throw new HttpError(400, "invalid JSON");
      });
      if (!body || typeof body !== "object") throw new HttpError(400, "invalid JSON");
      return await handler(c, body);
    } catch (e) {
      const s = statusOf(e);
      if (s.status >= 500) console.error(e);
      const confirm = confirmUrl(e);
      return c.json({ message: s.status >= 500 ? "Something went wrong. Please try again." : s.message, ...(confirm ? { confirm } : {}) }, s.status as 400);
    }
  });
}

const transportsOf = (k: PasskeyRow): AuthenticatorTransport[] | undefined => (k.transports ? (JSON.parse(k.transports) as AuthenticatorTransport[]) : undefined);

// ---------------------------------------------------------------- pages

const KeyMark: FC = () => (
  <div class="authmark" aria-hidden="true">
    {raw(ICONS.key)}
  </div>
);

/** Error slot that the passkey script fills in. */
const PasskeyMessage: FC = () => <div class="flash error" data-passkey-msg role="alert" hidden></div>;

const AuthCard: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <div class="authcard box">
    <div class="body">
      <KeyMark />
      <h1>{title}</h1>
      {children}
    </div>
  </div>
);

function accessConfigured(c: AppContext): boolean {
  return !!(c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD);
}

/** Username and display name for a new account (invites and open sign-up). */
const NewAccountFields: FC<{ email: string }> = ({ email }) => (
  <>
    <div class="field">
      <label for="login">Username</label>
      <input id="login" name="login" type="text" value={loginFromEmail(email)} required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,38}" autocomplete="username" />
      <div class="hint">Your repositories live at /{"{username}"}/…</div>
    </div>
    <div class="field">
      <label for="name">Display name</label>
      <input id="name" name="name" type="text" maxlength={100} autocomplete="name" />
    </div>
  </>
);

/** The username and display name a new account asked for, once they check out. */
async function newAccountNames(c: AppContext, body: Record<string, unknown>, email: string): Promise<{ login: string; name: string }> {
  const login = str(body.login).trim() || loginFromEmail(email);
  if (!isValidLogin(login) || login.length > 39) throw new HttpError(422, "Usernames use letters, numbers and dashes (up to 39), and some names are reserved.");
  if (await c.get("dir").loginTaken(login)) throw new HttpError(409, `The username ${login} is taken. Pick another one.`);
  return { login, name: str(body.name).trim().slice(0, 100) };
}

/**
 * Runs on the invite page: an invitation email carries its proof in the URL's fragment
 * (`#proof=...`), which browsers never send, so it stays out of request logs. The page posts it
 * to the server in a form body instead, with the fragment taken out of the address bar first.
 */
const INVITE_PROOF_SCRIPT = `(function(){function go(){var m=/^#proof=([A-Za-z0-9_-]{16,128})$/.exec(location.hash);var f=document.getElementById("invite-proof");if(!m||!f)return;history.replaceState(null,"",location.pathname);f.elements.proof.value=m[1];f.submit();}go();addEventListener("hashchange",go);})();`;

/** Runs on /signin: takes a sign-in link's token from the fragment and shows which account it adds a passkey to. */
const SIGNIN_LINK_SCRIPT = `(function(){function go(){var s=document.getElementById("signin-link-status"),f=document.getElementById("signin-link-form");var t=location.hash.slice(1);if(!t&&f.elements.link.value)return;if(!/^[A-Za-z0-9_-]{20,100}$/.test(t)){s.textContent="This link is incomplete. Open it again from the email or message it came in, in full.";f.style.display="none";return;}history.replaceState(null,"",location.pathname);fetch("/auth/passkey/link-info",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({link:t}),credentials:"same-origin"}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.message||"This sign-in link is invalid, already used, or expired.");return j;});}).then(function(j){s.textContent="This link lets you add a passkey to "+j.login+(j.email?" ("+j.email+")":"")+". It works once. After that, sign in with the passkey.";f.elements.link.value=t;f.style.display="";}).catch(function(e){s.textContent=e.message;f.style.display="none";});}go();addEventListener("hashchange",go);})();`;

/** Invite landing for someone without an account: create a passkey and join in one step. */
export async function invitePasskeyPage(c: AppContext, token: string, posted?: string): Promise<Response> {
  const auth = new Auth(c.env);
  const inv = await auth.invite(token);
  if (!inv) throw new HttpError(404, "this invite is invalid, already used, or expired");
  const next = `/invite/${encodeURIComponent(token)}`;
  // The link alone isn't enough to create the account: the copy emailed to the address carries a proof.
  // Ask for it before saying whether the address has an account, since the inviter has the link too.
  // Emails sent now carry it in the fragment (posted here by INVITE_PROOF_SCRIPT); older ones in the query.
  const proof = posted ?? c.req.query("proof");
  if (inv.email && !(await validInviteProof(c.env, inv.hash, proof))) {
    return render(
      c,
      { title: "Join Diffinery", script: posted === undefined ? INVITE_PROOF_SCRIPT : undefined },
      <AuthCard title="Confirm your email">
        <p class="muted">
          This invitation is for <b>{inv.email}</b>. To make sure it's you, open the link in the invitation email sent to that address. If you can't find it, we can send it again.
        </p>
        <Form action={`/invite/${encodeURIComponent(token)}/proof`} t={csrfToken(c)} id="invite-proof" style="display:none">
          <input type="hidden" name="proof" value="" />
        </Form>
        <Form action={`/invite/${encodeURIComponent(token)}/email`} t={csrfToken(c)}>
          <button class="btn primary block">Email me the link</button>
        </Form>
        <p class="muted small">
          Already have an account? <a href={`/login?next=${encodeURIComponent(next)}`}>Sign in</a> to accept.
        </p>
      </AuthCard>,
    );
  }
  const exists = inv.email ? await c.get("dir").accountByEmail(inv.email) : null;
  if (!inv.email || exists) {
    return render(
      c,
      { title: "Accept invite" },
      <AuthCard title="You have been invited">
        <p class="muted">
          {inv.email ? (
            <>
              <b>{inv.email}</b> already has a Diffinery account. Sign in with its passkey, and this page will let you accept the invite.
            </>
          ) : (
            "Sign in to accept this invite."
          )}
        </p>
        <a class="btn primary block" href={`/login?next=${encodeURIComponent(next)}`}>
          Sign in
        </a>
      </AuthCard>,
    );
  }
  return render(
    c,
    { title: "Join Diffinery" },
    <AuthCard title="Join Diffinery">
      <p class="muted">
        You were invited as <b>{inv.email}</b>. Pick a username, then create a passkey. Your device keeps it and unlocks it with your fingerprint, face or screen lock, so there is no password to remember.
      </p>
      <form data-passkey="register" data-next="/">
        <input type="hidden" name="invite" value={token} />
        <input type="hidden" name="proof" value={proof} />
        <NewAccountFields email={inv.email} />
        <PasskeyMessage />
        <button class="btn primary block">Create a passkey and join</button>
      </form>
    </AuthCard>,
  );
}

const PasskeyUnsupported: FC = () => (
  <noscript>
    <p class="flash error">Passkeys need JavaScript.</p>
  </noscript>
);

// ---------------------------------------------------------------- open sign-up (SIGNUP=open, auth/signup.ts)

const TURNSTILE_MISSING = "Sign-up needs Turnstile configured: this instance has no TURNSTILE_SITE_KEY and TURNSTILE_SECRET. Ask its administrators for an invite.";

const StepError: FC<{ error?: string }> = ({ error }) => (error ? <div class="flash error" role="alert">{error}</div> : null);

/** Step 1: the email address (and the Turnstile widget). */
function signupPage(c: AppContext, o: { email?: string; error?: string; status?: number } = {}): Response | Promise<Response> {
  const mode = turnstileMode(c.env);
  const siteKey = mode === "verify" ? c.env.TURNSTILE_SITE_KEY : undefined;
  return render(
    c,
    { title: "Create an account", status: mode === "missing" ? 503 : o.status, turnstile: !!siteKey },
    <AuthCard title="Create your Diffinery account">
      {mode === "missing" ? (
        <StepError error={TURNSTILE_MISSING} />
      ) : (
        <>
          <p class="muted">Enter your email address. We'll send you a code to confirm it, then you pick a username and create a passkey. There is no password.</p>
          <StepError error={o.error} />
          <Form action="/signup" t={csrfToken(c)}>
            <div class="field">
              <label for="email">Email address</label>
              <input id="email" name="email" type="email" value={o.email} required maxlength={254} autocomplete="email" />
            </div>
            {siteKey ? <div class="cf-turnstile" data-sitekey={siteKey} data-theme="auto" style="margin-bottom:12px"></div> : null}
            <button class="btn primary block">Email me a code</button>
          </Form>
        </>
      )}
      <div class="authfoot muted small">
        <p>
          Already have an account? <a href="/login">Sign in</a>.
        </p>
      </div>
    </AuthCard>,
  );
}

/** Step 2: the code from the email. */
function signupCodePage(c: AppContext, o: { email: string; error?: string; status?: number }): Response | Promise<Response> {
  return render(
    c,
    { title: "Enter your code", status: o.status },
    <AuthCard title="Check your email">
      <p class="muted">
        We sent a code to <b>{o.email}</b>. Enter it here within {CODE_MINUTES} minutes.
      </p>
      <StepError error={o.error} />
      <Form action="/signup/verify" t={csrfToken(c)}>
        <input type="hidden" name="email" value={o.email} />
        <div class="field">
          <label for="code">Code</label>
          <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} required autocomplete="one-time-code" />
        </div>
        <button class="btn primary block">Continue</button>
      </Form>
      <div class="authfoot muted small">
        <p>
          No email? Check your spam folder, or <a href="/signup">send a new code</a>.
        </p>
      </div>
    </AuthCard>,
  );
}

/** Step 3: a username and a passkey, bound to the single-use ticket for the confirmed address. */
function signupPasskeyPage(c: AppContext, email: string, ticket: string): Response | Promise<Response> {
  return render(
    c,
    { title: "Join Diffinery" },
    <AuthCard title="Join Diffinery">
      <p class="muted">
        <b>{email}</b> is confirmed. Pick a username, then create a passkey. Your device keeps it and unlocks it with your fingerprint, face or screen lock, so there is no password to remember.
      </p>
      <PasskeyUnsupported />
      <form data-passkey="register" data-next="/">
        <input type="hidden" name="signup" value={ticket} />
        <NewAccountFields email={email} />
        <PasskeyMessage />
        <button class="btn primary block">Create a passkey and join</button>
      </form>
    </AuthCard>,
  );
}

/** Run a sign-up step. A refusal shows on that step's page with its status, keeping what was typed. */
async function signupStep(fn: () => Promise<Response>, page: (error: string, status: number) => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const s = statusOf(e);
    if (s.status >= 500 && s.status !== 503) throw e;
    return page(s.message, s.status);
  }
}

export function registerAuth(web: WebApp): void {
  web.get("/login", async (c) => {
    const next = safeNext(c.req.query("next"));
    const p = c.get("principal");
    // A sensitive action asked a signed-in person to confirm it's them (requireRecentSignIn).
    if (c.req.query("confirm") === "1" && p.type === "account" && p.via === "session" && !(p.sessionAt && Date.now() - Date.parse(p.sessionAt) < RECENT_SIGNIN_MS)) {
      return render(
        c,
        { title: "Confirm it's you" },
        <AuthCard title="Confirm it's you">
          <p class="muted">
            You're signed in as <b>{p.account.login}</b>. Adding passkeys, creating tokens and agents, and deleting or transferring repositories need a sign-in from the last 2 hours. Use your passkey to continue.
          </p>
          <PasskeyUnsupported />
          <form data-passkey="login" data-next={next}>
            <PasskeyMessage />
            <button class="btn primary block">Confirm with a passkey</button>
          </form>
          <div class="authfoot muted small">
            {accessConfigured(c) ? (
              <p>
                No passkey on this device? <a href={`/auth/access?next=${encodeURIComponent(next)}`}>Confirm by email</a>.
              </p>
            ) : null}
            <p>
              <a href={next}>Cancel</a>
            </p>
          </div>
        </AuthCard>,
      );
    }
    if (p.type === "account" && p.via !== "dev") return c.redirect(next, 302);
    return render(
      c,
      // The pages people land on after signing in mount Kumo islands: fetch the bundle while they sign in.
      { title: "Sign in", prefetchKumo: true },
      <AuthCard title="Sign in to Diffinery">
        <p class="muted">Use the passkey saved on this device, your phone or your password manager.</p>
        <PasskeyUnsupported />
        <form data-passkey="login" data-next={next}>
          <PasskeyMessage />
          <button class="btn primary block">Sign in with a passkey</button>
        </form>
        <div class="authfoot muted small">
          {signupOpen(c.env) ? (
            <p>
              New here? <a href="/signup">Create an account</a>.
            </p>
          ) : (
            <p>
              New here? Diffinery is invite-only. Open the invite link someone sent you to create your passkey{turnstileMode(c.env) !== "missing" ? <>, or <a href="/early-access">request early access</a></> : null}.
            </p>
          )}
          {accessConfigured(c) ? (
            <p>
              Lost your passkey? <a href={`/auth/access?next=${encodeURIComponent(next)}`}>Recover your account by email</a>. Recovering signs out every other browser; access tokens keep working.
            </p>
          ) : (
            <p>Lost your passkey? Ask an administrator for a sign-in link.</p>
          )}
        </div>
      </AuthCard>,
    );
  });

  // Admin-issued sign-in link: add a passkey to an existing account. Links carry the token in the
  // fragment (/signin#<token>), which browsers never send, so request logs never hold a usable copy:
  // SIGNIN_LINK_SCRIPT reads it, takes it out of the address bar, and asks which account it is for.
  web.get("/signin", (c) =>
    render(
      c,
      { title: "Add a passkey", script: SIGNIN_LINK_SCRIPT },
      <AuthCard title="Add a passkey">
        <p class="muted" id="signin-link-status">
          Checking this sign-in link…
        </p>
        <p class="muted small">Using it signs out every other browser signed in to this account, in case a lost device is still signed in. Access tokens keep working.</p>
        <form data-passkey="register" data-next="/settings/security" id="signin-link-form" style="display:none">
          <input type="hidden" name="link" value="" />
          <div class="field">
            <label for="label">Name for this passkey</label>
            <input id="label" name="label" type="text" maxlength={100} placeholder={deviceLabel(c.req.header("user-agent"))} />
          </div>
          <PasskeyMessage />
          <button class="btn primary block">Create a passkey</button>
        </form>
      </AuthCard>,
    ),
  );

  // Which account a sign-in link is for, for the page above; the token comes in the body, never the URL.
  jsonPost(web, "/auth/passkey/link-info", async (c, body) => {
    const link = await new Auth(c.env).signinLink(str(body.link));
    if (!link) throw new HttpError(404, "This sign-in link is invalid, already used, or expired.");
    return c.json({ login: link.account.login, email: link.account.email ?? null });
  });

  // Links sent before the token moved to the fragment.
  web.get("/signin/:token", async (c) => {
    const token = prm(c, "token");
    const link = await new Auth(c.env).signinLink(token);
    if (!link) throw new HttpError(404, "this sign-in link is invalid, already used, or expired");
    return render(
      c,
      { title: "Add a passkey" },
      <AuthCard title="Add a passkey">
        <p class="muted">
          This link lets you add a passkey to <b>{link.account.login}</b>
          {link.account.email ? ` (${link.account.email})` : ""}. It works once. After that, sign in with the passkey.
        </p>
        <p class="muted small">Using it signs out every other browser signed in to this account, in case a lost device is still signed in. Access tokens keep working.</p>
        <form data-passkey="register" data-next="/settings/security">
          <input type="hidden" name="link" value={token} />
          <div class="field">
            <label for="label">Name for this passkey</label>
            <input id="label" name="label" type="text" maxlength={100} placeholder={deviceLabel(c.req.header("user-agent"))} />
          </div>
          <PasskeyMessage />
          <button class="btn primary block">Create a passkey</button>
        </form>
      </AuthCard>,
    );
  });

  // ------------------------------------------------------------ sign in

  jsonPost(web, "/auth/passkey/login/options", async (c) => {
    const auth = new Auth(c.env);
    const rp = auth.rp();
    // No allowCredentials: the browser offers any passkey it holds for this site (discoverable credentials).
    const opts = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required", timeout: CEREMONY_TIMEOUT });
    setChallenge(c, await auth.saveChallenge("login", opts.challenge, { kind: "login" }));
    return c.json(opts);
  });

  jsonPost(web, "/auth/passkey/login/verify", async (c, body) => {
    const auth = new Auth(c.env);
    const dir = c.get("dir");
    const rp = auth.rp();
    const ch = await auth.takeChallenge(takeChallengeCookie(c), "login");
    if (!ch) throw new HttpError(400, "This sign-in attempt expired. Please try again.");
    const response = body.response as AuthenticationResponseJSON | undefined;
    if (!response || typeof response.id !== "string") throw new HttpError(400, "missing passkey response");
    const key = await auth.passkey(response.id);
    if (!key) throw new HttpError(401, "This passkey is not registered with Diffinery. It may have been removed.");
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: { id: key.id, publicKey: new Uint8Array(fromB64url(key.public_key)), counter: key.counter, transports: transportsOf(key) },
    }).catch((e: Error) => {
      throw new HttpError(401, `Passkey check failed: ${e.message}`);
    });
    if (!result.verified) throw new HttpError(401, "Passkey check failed.");
    const account = await dir.account(key.account_id);
    if (!account) throw new HttpError(401, "This passkey's account no longer exists.");
    if (account.status === "disabled") throw new HttpError(403, "Your account is disabled.");
    await auth.passkeyUsed(key.id, result.authenticationInfo.newCounter, result.authenticationInfo.credentialBackedUp);
    await startSession(c, auth, account.id, "passkey", key.id);
    c.executionCtx.waitUntil(dir.audit({ actorId: account.id, actorLogin: account.login, action: "session.create", detail: { method: "passkey", passkey: key.name, passkeyId: key.id, ...signinContext(c) } }));
    return c.json({ redirect: safeNext(body.next) });
  });

  // ------------------------------------------------------------ register a passkey

  jsonPost(web, "/auth/passkey/register/options", async (c, body) => {
    const auth = new Auth(c.env);
    const dir = c.get("dir");
    const rp = auth.rp();
    let subject: Subject;
    let user: { id: string; name: string; displayName: string };
    let existing: PasskeyRow[] = [];
    const inviteToken = str(body.invite);
    const linkToken = str(body.link);
    const signupToken = str(body.signup);
    if (inviteToken) {
      const inv = await auth.invite(inviteToken);
      if (!inv) throw new HttpError(404, "This invite is invalid, already used, or expired.");
      if (!inv.email) throw new HttpError(422, "This invite has no email address. Sign in first, then open it again.");
      if (!(await validInviteProof(c.env, inv.hash, str(body.proof)))) throw new HttpError(403, `Open the link in the invitation email sent to ${inv.email} to create your account.`);
      if (await dir.accountByEmail(inv.email)) throw new HttpError(409, `${inv.email} already has an account. Sign in with its passkey, then open this invite again.`);
      const { login, name } = await newAccountNames(c, body, inv.email);
      const id = newId();
      subject = { kind: "invite", inviteHash: inv.hash, email: inv.email, login, name, accountId: id };
      user = { id, name: login, displayName: name || login };
    } else if (signupToken) {
      if (!signupOpen(c.env)) throw new HttpError(404, "Sign-up is closed on this instance.");
      const signups = new Signups(c.env);
      const ticket = await signups.ticket(signupToken);
      if (!ticket) throw new HttpError(404, "This sign-up expired or was already used. Start again at /signup.");
      if (await signups.accountFor(ticket.email)) throw new HttpError(409, `${ticket.email} already has an account. Sign in with its passkey.`);
      const { login, name } = await newAccountNames(c, body, ticket.email);
      const id = newId();
      subject = { kind: "signup", ticketHash: ticket.hash, email: ticket.email, login, name, accountId: id };
      user = { id, name: login, displayName: name || login };
    } else if (linkToken) {
      const link = await auth.signinLink(linkToken);
      if (!link) throw new HttpError(404, "This sign-in link is invalid, already used, or expired.");
      if (link.account.status === "disabled") throw new HttpError(403, "This account is disabled.");
      subject = { kind: "link", linkHash: link.hash, accountId: link.account.id };
      user = { id: link.account.id, name: link.account.login, displayName: link.account.name || link.account.login };
      existing = await auth.passkeys(link.account.id);
    } else {
      const me = browserAccount(c);
      requireRecentSignIn(c, "/settings/security");
      subject = { kind: "account", accountId: me.id };
      user = { id: me.id, name: me.login, displayName: me.name || me.login };
      existing = await auth.passkeys(me.id);
    }
    const opts = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: user.name,
      userDisplayName: user.displayName,
      userID: new Uint8Array(new TextEncoder().encode(user.id)),
      attestationType: "none",
      excludeCredentials: existing.map((k) => ({ id: k.id, transports: transportsOf(k) })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: CEREMONY_TIMEOUT,
    });
    setChallenge(c, await auth.saveChallenge("register", opts.challenge, subject));
    return c.json(opts);
  });

  jsonPost(web, "/auth/passkey/register/verify", async (c, body) => {
    const auth = new Auth(c.env);
    const dir = c.get("dir");
    const rp = auth.rp();
    const ch = await auth.takeChallenge(takeChallengeCookie(c), "register");
    if (!ch) throw new HttpError(400, "This attempt expired. Please try again.");
    const response = body.response as RegistrationResponseJSON | undefined;
    if (!response || typeof response.id !== "string") throw new HttpError(400, "missing passkey response");
    const result = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true }).catch((e: Error) => {
      throw new HttpError(400, `The passkey could not be verified: ${e.message}`);
    });
    if (!result.verified) throw new HttpError(400, "The passkey could not be verified.");
    const info = result.registrationInfo;
    if (await auth.passkey(info.credential.id)) throw new HttpError(409, "This passkey is already registered.");
    const label = str(body.label).trim() || deviceLabel(c.req.header("user-agent"));
    const key = {
      id: info.credential.id,
      public_key: b64url(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports?.length ? JSON.stringify(info.credential.transports) : null,
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp ? 1 : 0,
      name: label,
    };
    const s = ch.subject;
    let account: Account;
    let redirect: string;
    if (s.kind === "account") {
      const me = browserAccount(c);
      if (me.id !== s.accountId) throw new HttpError(403, "You signed in as someone else while adding this passkey.");
      requireRecentSignIn(c, "/settings/security");
      await auth.addPasskey({ ...key, account_id: me.id });
      c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "passkey.add", detail: { name: label, passkeyId: key.id, ...signinContext(c) } }));
      flash(c, "notice", `Passkey "${label}" added.`);
      return c.json({ redirect: "/settings/security" });
    } else if (s.kind === "invite") {
      // Re-check: the invite or the username may have been taken while the browser was busy.
      const inv = await auth.inviteByHash(s.inviteHash);
      if (!inv) throw new HttpError(404, "This invite was used or expired in the meantime.");
      if (await dir.accountByEmail(s.email)) throw new HttpError(409, `${s.email} already has an account.`);
      if (await dir.loginTaken(s.login)) throw new HttpError(409, `The username ${s.login} was just taken. Pick another one.`);
      // Creating the account accepts every open invite for this email, including this one.
      account = await dir.userForEmail(s.email, { login: s.login, name: s.name || undefined, id: s.accountId });
      // Two registrations racing for one invite: only the one that created the account gets a passkey on it.
      if (account.id !== s.accountId) throw new HttpError(409, `${s.email} already has an account.`);
      await auth.addPasskey({ ...key, account_id: account.id });
      c.executionCtx.waitUntil(dir.audit({ actorId: account.id, actorLogin: account.login, action: "invite.accept", detail: { method: "passkey", passkeyId: key.id, ...signinContext(c) } }));
      flash(c, "notice", `Welcome to Diffinery, ${account.login}. You can sign in with this passkey from now on.`);
      // Land where they were invited to: the organization or the repository.
      const repo = inv.repo_id ? await dir.repoById(inv.repo_id) : null;
      const org = !repo && inv.org_id ? await dir.account(inv.org_id) : null;
      redirect = repo ? `/${repo.owner_login}/${repo.name}` : org ? `/${org.login}` : "/";
    } else if (s.kind === "signup") {
      if (!signupOpen(c.env)) throw new HttpError(404, "Sign-up is closed on this instance.");
      const signups = new Signups(c.env);
      if (await signups.accountFor(s.email)) throw new HttpError(409, `${s.email} already has an account.`);
      if (await dir.loginTaken(s.login)) throw new HttpError(409, `The username ${s.login} was just taken. Pick another one.`);
      if (!(await signups.useTicket(s.ticketHash))) throw new HttpError(404, "This sign-up was used or expired in the meantime. Start again at /signup.");
      // Open sign-up makes an active account (and accepts any open invites for the address).
      account = await dir.userForEmail(s.email, { login: s.login, name: s.name || undefined, id: s.accountId, active: true });
      if (account.id !== s.accountId) throw new HttpError(409, `${s.email} already has an account.`);
      await auth.addPasskey({ ...key, account_id: account.id });
      c.executionCtx.waitUntil(dir.audit({ actorId: account.id, actorLogin: account.login, action: "signup", detail: { method: "passkey", email: s.email, passkeyId: key.id, ...signinContext(c) } }));
      flash(c, "notice", `Welcome to Diffinery, ${account.login}. You can sign in with this passkey from now on.`);
      redirect = "/";
    } else if (s.kind === "link") {
      if (!(await auth.useSigninLink(s.linkHash))) throw new HttpError(404, "This sign-in link was used or expired in the meantime.");
      const found = await dir.account(s.accountId);
      if (!found || found.status === "disabled") throw new HttpError(403, "This account is disabled.");
      account = found;
      await auth.addPasskey({ ...key, account_id: account.id });
      c.executionCtx.waitUntil(dir.audit({ actorId: account.id, actorLogin: account.login, action: "passkey.add", detail: { name: label, via: "signin-link", passkeyId: key.id, ...signinContext(c) } }));
      flash(c, "notice", `Passkey "${label}" added. Use it to sign in from now on. ${RECOVERY_NOTE}`);
      redirect = "/settings/security";
    } else {
      throw new HttpError(400, "unexpected sign-in attempt");
    }
    const sid = await startSession(c, auth, account.id, s.kind === "link" ? "link" : "passkey", key.id);
    // A sign-in link is account recovery: a lost or stolen device may still be signed in, so only this browser stays.
    if (s.kind === "link") {
      const signedOut = await auth.endOtherSessions(account.id, sid);
      c.executionCtx.waitUntil(dir.audit({ actorId: account.id, actorLogin: account.login, action: "session.revoke_others", detail: { via: "signin-link", sessions: signedOut } }));
    }
    return c.json({ redirect });
  });

  // ------------------------------------------------------------ invitations: resend the email that proves the address

  // The proof from an invitation email's fragment, posted by the invite page (INVITE_PROOF_SCRIPT).
  post(web, "/invite/:token/proof", async (c, form) => {
    const token = prm(c, "token");
    // Signed in: the invite is accepted as that account, with no proof needed.
    if (c.get("principal").type === "account") return c.redirect(`/invite/${encodeURIComponent(token)}`, 303);
    return invitePasskeyPage(c, token, form.s("proof"));
  });

  post(web, "/invite/:token/email", async (c) => {
    const token = prm(c, "token");
    const back = `/invite/${encodeURIComponent(token)}`;
    const inv = await new Auth(c.env).invite(token);
    if (!inv?.email) throw new HttpError(404, "this invite is invalid, already used, or expired");
    return act(c, back, async () => {
      // At most one email every 2 minutes and 5 a day for an address, counting the first one.
      const since = (ms: number) => new Date(Date.now() - ms).toISOString();
      const sent = await c.env.DB.prepare("SELECT sum(created_at > ?) AS recent, count(*) AS day FROM email_log WHERE kind = 'invite' AND lower(to_addr) = lower(?) AND created_at > ?")
        .bind(since(120_000), inv.email, since(86400_000))
        .first<{ recent: number | null; day: number }>();
      if ((sent?.recent ?? 0) > 0) throw new HttpError(429, `We emailed ${inv.email} a moment ago. Check that inbox (and its spam folder) for the link.`);
      if ((sent?.day ?? 0) >= 5) throw new HttpError(429, `We have emailed ${inv.email} several times today. Ask the person who invited you to send a new invitation.`);
      const row = await c.env.DB.prepare("SELECT id, email, org_id, repo_id, role, invited_by, expires_at FROM invites WHERE id = ?").bind(inv.id).first<{ id: string; email: string; org_id: string | null; repo_id: string | null; role: string; invited_by: string | null; expires_at: string }>();
      if (!row) throw new HttpError(404, "this invite is invalid, already used, or expired");
      await c.get("dir").mailInvite(row, token);
    }, `We emailed the link to ${inv.email}. Open it from that inbox to create your account.`);
  });

  // ------------------------------------------------------------ open sign-up

  // Off, sign-up doesn't exist: its pages answer 404 like any unknown path, before any CSRF check.
  // Only the sign-up page itself leads to the early access request instead (web/early-access.tsx).
  for (const path of ["/signup", "/signup/*"]) {
    web.use(path, async (c, next) => {
      if (!signupOpen(c.env) && c.req.method === "GET" && c.req.path === "/signup" && turnstileMode(c.env) !== "missing") return c.redirect("/early-access", 302);
      if (!signupOpen(c.env)) throw new HttpError(404, "not found");
      await next();
    });
  }

  web.get("/signup", async (c) => {
    const p = c.get("principal");
    if (p.type === "account" && p.via !== "dev") return c.redirect("/", 302);
    return signupPage(c);
  });

  post(web, "/signup", async (c, form) => {
    const typed = form.s("email").trim().slice(0, 254);
    return signupStep(
      async () => {
        const mode = turnstileMode(c.env);
        if (mode === "missing") throw new HttpError(503, TURNSTILE_MISSING);
        const email = normalEmail(typed);
        if (!email) throw new HttpError(422, "Enter a valid email address.");
        const ip = c.req.header("cf-connecting-ip") ?? null;
        if (mode === "verify" && !(await verifyTurnstile(c.env.TURNSTILE_SECRET!, form.s("cf-turnstile-response"), ip))) throw new HttpError(403, "We couldn't confirm that you're a person. Please try again.");
        const signups = new Signups(c.env);
        const existing = await signups.accountFor(email);
        const issued = await signups.issue(email, ip ?? "unknown");
        // The next page reads the same either way, so it never tells whether an address has an account.
        // Its owner learns from the email: a code, or (no code) a note that they already have one.
        await enqueueMail(c.env, [
          existing ? { kind: "signup_attempt", data: { email }, to: { accountId: existing.id }, reason: "account", at: now() } : { kind: "signup_code", data: issued, to: { email }, reason: "signup", at: now() },
        ]);
        return signupCodePage(c, { email });
      },
      (error, status) => signupPage(c, { email: typed, error, status }),
    );
  });

  post(web, "/signup/verify", async (c, form) => {
    const email = normalEmail(form.s("email"));
    if (!email) return signupPage(c, { error: "Enter a valid email address.", status: 422 });
    return signupStep(
      async () => {
        const signups = new Signups(c.env);
        const r = await signups.check(email, form.s("code").trim());
        if (!r.ok && r.left > 0) throw new HttpError(400, `That code is wrong. You can try ${r.left} more time${r.left === 1 ? "" : "s"}.`);
        if (!r.ok) throw new HttpError(410, "That code has expired or was entered wrong too many times. Send a new code.");
        return signupPasskeyPage(c, email, await signups.createTicket(email));
      },
      (error, status) => signupCodePage(c, { email, error, status }),
    );
  });

  // ------------------------------------------------------------ sign out

  post(web, "/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await new Auth(c.env).endSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.redirect("/login", 303);
  });

  // ------------------------------------------------------------ recovery through Cloudflare Access

  // Cloudflare Access protects only this path. It verifies the person's email,
  // and this handler turns that into a session so they can add a new passkey.
  web.get("/auth/access", async (c) => {
    if (!accessConfigured(c)) throw new HttpError(404, "Account recovery by email is not set up on this instance. Ask an administrator for a sign-in link.");
    const jwt = accessToken(c.req.raw);
    if (!jwt) throw new HttpError(401, "Cloudflare Access did not sign this request. Open this page again to start the email check.");
    const claims = await verifyAccessJwt(jwt, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD).catch((e: Error) => {
      throw new HttpError(401, `Cloudflare Access sign-in was rejected: ${e.message}`);
    });
    const email = typeof claims.email === "string" ? claims.email : null;
    if (!email) throw new HttpError(401, "Cloudflare Access did not provide an email address.");
    const dir = c.get("dir");
    const account = await dir.userForEmail(email, { name: typeof claims.name === "string" ? claims.name : undefined });
    if (account.status === "disabled") throw new HttpError(403, "Your account is disabled.");
    const auth = new Auth(c.env);
    // Someone already signed in to this account here is confirming it's them (requireRecentSignIn); anyone else is
    // recovering the account, and a lost or stolen device may still be signed in: every other browser is signed out.
    const p = c.get("principal");
    const confirming = p.type === "account" && p.via === "session" && p.account.id === account.id;
    const sid = await startSession(c, auth, account.id, "access", null);
    const signedOut = confirming ? 0 : await auth.endOtherSessions(account.id, sid);
    c.executionCtx.waitUntil(dir.audit({ actorId: account.id, actorLogin: account.login, action: "session.create", detail: { method: "access", ...signinContext(c) } }));
    if (signedOut) c.executionCtx.waitUntil(dir.audit({ actorId: account.id, actorLogin: account.login, action: "session.revoke_others", detail: { via: "access", sessions: signedOut } }));
    if (account.status === "pending") return c.redirect("/", 302);
    const keys = await auth.passkeys(account.id);
    if (keys.length) {
      if (signedOut) flash(c, "notice", `You're signed in. ${RECOVERY_NOTE}`);
      return c.redirect(safeNext(c.req.query("next")), 302);
    }
    flash(c, "notice", `You're signed in.${signedOut ? ` ${RECOVERY_NOTE}` : ""} Add a passkey now so you can sign in directly next time.`);
    return c.redirect("/settings/security", 302);
  });
}

/** The account behind a browser session (or dev sign-in). API tokens cannot manage passkeys. */
export function browserAccount(c: AppContext): Account {
  const p = c.get("principal");
  if (p.type !== "account" || p.via === "token") throw new HttpError(401, "Sign in with your passkey first.");
  if (p.account.kind !== "user") throw new HttpError(403, "only people can have passkeys");
  if (p.account.status === "disabled") throw new HttpError(403, "your account is disabled");
  return p.account;
}
