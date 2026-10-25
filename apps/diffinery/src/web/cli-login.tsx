/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { requireAccount, requireRecentSignIn, type AppContext } from "../auth/principal.js";
import { CLI_TOKEN_DAYS, CliLogins, cleanClient, formatUserCode, isB64urlParam, loopbackPort, normalizeUserCode, parseClient, scopeOf, type CliClient } from "../auth/cli-login.js";
import type { Account, TokenScope } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { ICONS } from "./assets.js";
import { csrfToken, type FormData } from "./csrf.js";
import { KRadio } from "./kumo.js";
import { Form, ago, post, render, type WebApp } from "./ui.js";

/**
 * The pages a person approves a CLI sign-in on (auth/cli-login.ts has the flows):
 *   /login/cli      `diffinery login` opened this with its loopback port and PKCE challenge
 *   /login/device   type the code a `diffinery login --device` printed
 *   /login/cli/done where the CLI sends the browser once it has its token
 * Both need a passkey sign-in from the last 2 hours, like creating a token in Settings.
 */

const SCOPE_ITEMS = [
  { value: "read", label: "Read", description: "Clone, and view repositories, issues, pull requests and runs." },
  { value: "write", label: "Write", description: "Also push, open and merge pull requests, comment, and run workflows (up to maintain)." },
  { value: "admin", label: "Admin", description: "Everything you can do, including settings, secrets and variables." },
];

const Card: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <div class="authcard box">
    <div class="body">
      <div class="authmark" aria-hidden="true">
        {raw(ICONS.code)}
      </div>
      <h1>{title}</h1>
      {children}
    </div>
  </div>
);

const ClientDetails: FC<{ client: CliClient; from?: { ip: string | null; location: string | null; at: string } }> = ({ client, from }) => (
  <dl class="kv mb">
    <dt>Computer</dt>
    <dd>
      <b>{client.host}</b>
      {client.os ? <span class="muted"> · {client.os}</span> : null}
    </dd>
    {client.version ? (
      <>
        <dt>CLI</dt>
        <dd>diffinery {client.version}</dd>
      </>
    ) : null}
    {from ? (
      <>
        <dt>Requested</dt>
        <dd>
          {ago(from.at)}
          {from.location || from.ip ? <span class="muted"> from {[from.location, from.ip].filter(Boolean).join(" · ")}</span> : null}
        </dd>
      </>
    ) : null}
  </dl>
);

/**
 * Where a device code was asked from, compared with the browser approving it. Device-code phishing
 * means someone else's code: it was almost always asked for from another network, often another
 * country, so the page says so plainly.
 */
export function placeMismatch(from: { ip: string | null; location: string | null }, here: { ip?: string; country?: string }): "country" | "network" | null {
  // Stored as "City, CC" or "CC": the country is the two-letter code after the last comma. A city with no code is no country.
  const last = from.location?.split(",").at(-1)?.trim();
  const theirs = last && /^[A-Z]{2}$/.test(last) ? last : null;
  if (theirs && here.country && theirs !== here.country) return "country";
  if (from.ip && here.ip && from.ip !== here.ip) return "network";
  return null;
}

/** A phisher's CLI can ask for any scope, so the page never preselects more than write: admin is always a deliberate pick. */
export const preselectedScope = (requested: TokenScope): TokenScope => (requested === "admin" ? "write" : requested);

/** The approval form both flows share: the details, a scope, and Authorize or Cancel. */
const Approve: FC<{ c: AppContext; me: Account; action: string; client: CliClient; scope: TokenScope; hidden: Record<string, string>; from?: { ip: string | null; location: string | null; at: string }; code?: string }> = (p) => {
  const t = csrfToken(p.c);
  // Only the edge's request.cf: a client can send a CF-IPCountry header of its choosing.
  const cf = (p.c.req.raw as { cf?: { country?: string } }).cf;
  const mismatch = p.from ? placeMismatch(p.from, { ip: p.c.req.header("cf-connecting-ip"), country: cf?.country }) : null;
  return (
    <Card title="Authorize the Diffinery CLI">
      <p class="muted">
        A Diffinery command-line client wants to sign in as <b>{p.me.login}</b>.
      </p>
      {p.code ? (
        <p>
          Check that your terminal shows this code: <span class="usercode">{p.code}</span>
        </p>
      ) : null}
      <ClientDetails client={p.client} from={p.from} />
      {mismatch === "country" ? (
        <div class="flash error" role="alert">
          <b>This code was asked for from another country</b> ({p.from!.location}) than the one you're in now. If you didn't run <code>diffinery login --device</code> there yourself, someone may be trying to get into your account: click Cancel.
        </div>
      ) : mismatch === "network" ? (
        <div class="flash warn">This code was asked for from a different network ({p.from!.ip}) than this browser's. That's expected when the computer and this browser are on different connections; if you didn't start it yourself, click Cancel.</div>
      ) : null}
      <Form action={p.action} t={t}>
        {Object.entries(p.hidden).map(([k, v]) => (
          <input type="hidden" name={k} value={v} />
        ))}
        <div class="field">
          <label>Access</label>
          <KRadio name="scope" label="Access" value={preselectedScope(p.scope)} items={SCOPE_ITEMS} />
          {p.scope === "admin" ? <div class="hint">The CLI asked for Admin. Choose it above only if you want this computer to change settings, secrets and variables.</div> : null}
        </div>
        <p class="muted small">
          The CLI gets its own token, valid for {CLI_TOKEN_DAYS} days. It's listed under <a href="/settings/tokens">Settings → Access tokens</a>, where you can revoke it, and <code>diffinery logout</code> revokes it too.
        </p>
        <div class="flash warn small">Only authorize a sign-in you started yourself by running <code>diffinery login</code>. Never approve one because someone asked you to.</div>
        <div class="row">
          <button class="btn primary grow" name="decision" value="approve">
            Authorize
          </button>
          <button class="btn" name="decision" value="deny">
            Cancel
          </button>
        </div>
      </Form>
    </Card>
  );
};

const Done: FC<{ title: string; children: Child }> = ({ title, children }) => <Card title={title}>{children}</Card>;

/** The browser flow's parameters, validated; null when anything is missing or malformed. */
function browserParams(get: (k: string) => string | undefined): { port: number; state: string; challenge: string; client: CliClient; scope: TokenScope } | null {
  const port = loopbackPort(get("port"));
  const state = get("state");
  const challenge = get("code_challenge");
  const method = get("code_challenge_method");
  if (!port || !isB64urlParam(state) || !isB64urlParam(challenge, 43) || (method !== undefined && method !== "" && method !== "S256")) return null;
  return { port, state, challenge, client: cleanClient({ host: get("host"), os: get("os"), version: get("version") }), scope: scopeOf(get("scope")) };
}

/** The CLI's callback on this computer. Only 127.0.0.1, so the code never leaves the machine. */
const callback = (port: number, q: Record<string, string>) => `http://127.0.0.1:${port}/callback?${new URLSearchParams(q)}`;

function person(c: AppContext, next: string): Account {
  const me = requireAccount(c);
  if (me.kind !== "user") throw new HttpError(403, "only people can sign the CLI in; agents use their own tokens");
  requireRecentSignIn(c, next);
  return me;
}

const badLink = (c: AppContext) =>
  render(
    c,
    { title: "Sign-in link incomplete", status: 400 },
    <Done title="This sign-in link is incomplete">
      <p class="muted">
        Run <code>diffinery login</code> again and use the page it opens.
      </p>
    </Done>,
  );

const DeviceForm: FC<{ c: AppContext; error?: string; value?: string }> = ({ c, error, value }) => (
  <Card title="Sign in the Diffinery CLI">
    <p class="muted">
      Enter the code your terminal shows after <code>diffinery login --device</code>.
    </p>
    {error ? (
      <div class="flash error" role="alert">
        {error}
      </div>
    ) : null}
    <Form action="/login/device" t={csrfToken(c)}>
      <div class="field">
        <label for="code">Code</label>
        <input id="code" name="code" type="text" class="usercode-input" required autocomplete="off" autocapitalize="characters" spellcheck={false} maxlength={12} placeholder="XXXX-XXXX" value={value ?? ""} autofocus />
      </div>
      <button class="btn primary block">Continue</button>
    </Form>
  </Card>
);

export function registerCliLogin(web: WebApp): void {
  // ---------------------------------------------------------------- browser flow

  web.get("/login/cli", async (c) => {
    const q = browserParams((k) => c.req.query(k));
    if (!q) return badLink(c);
    const url = new URL(c.req.url);
    const me = person(c, url.pathname + url.search);
    return render(
      c,
      // Authorize leads the browser to the CLI's callback on this computer.
      { title: "Authorize the Diffinery CLI", formAction: `http://127.0.0.1:${q.port}` },
      <Approve c={c} me={me} action="/login/cli" client={q.client} scope={q.scope} hidden={{ port: String(q.port), state: q.state, code_challenge: q.challenge, host: q.client.host, os: q.client.os, version: q.client.version }} />,
    );
  });

  post(web, "/login/cli", async (c, f: FormData) => {
    const q = browserParams((k) => f.s(k));
    if (!q) return badLink(c);
    const back = `/login/cli?${new URLSearchParams({ port: String(q.port), state: q.state, code_challenge: q.challenge, code_challenge_method: "S256", scope: q.scope, host: q.client.host, os: q.client.os, version: q.client.version })}`;
    const me = person(c, back);
    if (f.s("decision") !== "approve") return c.redirect(callback(q.port, { error: "access_denied", state: q.state }), 303);
    const code = await new CliLogins(c.env, c.get("dir")).approveBrowser(me, q.client, scopeOf(f.s("scope"), q.scope), q.challenge);
    return c.redirect(callback(q.port, { code, state: q.state }), 303);
  });

  // Where the CLI sends the browser when it's done; it says which outcome, nothing else.
  web.get("/login/cli/done", (c) => {
    const result = c.req.query("result");
    if (result === "ok") {
      return render(
        c,
        { title: "CLI signed in" },
        <Done title="You're signed in">
          <p class="muted">The Diffinery CLI is signed in. You can close this tab and go back to your terminal.</p>
        </Done>,
      );
    }
    const denied = result === "denied";
    return render(
      c,
      { title: denied ? "Sign-in cancelled" : "Sign-in failed" },
      <Done title={denied ? "Sign-in cancelled" : "The CLI couldn't finish signing in"}>
        <p class="muted">{denied ? "Nothing was signed in. You can close this tab." : "Go back to your terminal for the details, then run diffinery login again."}</p>
      </Done>,
    );
  });

  // ---------------------------------------------------------------- device flow

  web.get("/login/device", async (c) => {
    person(c, "/login/device");
    return render(c, { title: "Sign in the Diffinery CLI" }, <DeviceForm c={c} />);
  });

  post(web, "/login/device", async (c, f) => {
    const me = person(c, "/login/device");
    const typed = f.s("code").trim();
    const row = normalizeUserCode(typed) ? await new CliLogins(c.env, c.get("dir")).pendingDevice(typed) : null;
    if (!row) return render(c, { title: "Sign in the Diffinery CLI", status: 404 }, <DeviceForm c={c} value={typed.slice(0, 12)} error="That code isn't valid or has expired. Check the code in your terminal, or run diffinery login --device again." />);
    return render(
      c,
      { title: "Authorize the Diffinery CLI" },
      <Approve c={c} me={me} action="/login/device/decide" client={parseClient(row.client)} scope={scopeOf(row.requested_scope)} hidden={{ id: row.id }} from={{ ip: row.ip, location: row.location, at: row.created_at }} code={formatUserCode(row.user_code ?? "")} />,
    );
  });

  post(web, "/login/device/decide", async (c, f) => {
    const me = person(c, "/login/device");
    const approve = f.s("decision") === "approve";
    const ok = await new CliLogins(c.env, c.get("dir")).decideDevice(f.s("id"), me, approve, scopeOf(f.s("scope")));
    if (!ok) return render(c, { title: "Sign in the Diffinery CLI", status: 410 }, <DeviceForm c={c} error="That sign-in expired or was already answered. Run diffinery login --device again." />);
    return render(
      c,
      { title: approve ? "CLI signed in" : "Sign-in cancelled" },
      approve ? (
        <Done title="You're signed in">
          <p class="muted">The Diffinery CLI will finish signing in within a few seconds. You can close this tab.</p>
        </Done>
      ) : (
        <Done title="Sign-in cancelled">
          <p class="muted">The CLI was not signed in. You can close this tab.</p>
        </Done>
      ),
    );
  });
}
