/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { requireAccount, requireRecentSignIn, type AppContext } from "../auth/principal.js";
import { ACCESS_TTL_S, OAuth, OAuthError, REFRESH_IDLE_DAYS, adminAllowed, canActAs, formActionSource, redirectLabel, requestedScope, type OAuthClient } from "../auth/oauth.js";
import type { Account, TokenScope } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { ICONS } from "./assets.js";
import { csrfToken, type FormData } from "./csrf.js";
import { KRadio } from "./kumo.js";
import { CopyButton, Form, ago, post, render, type WebApp } from "./ui.js";

/**
 * Where a person approves an app that wants to use Diffinery through MCP (auth/oauth.ts has the
 * flow): /oauth/authorize shows who is asking, where they'll be sent back, whom the app acts as and
 * with what access. It needs a passkey sign-in from the last 2 hours, like creating a token.
 * Connected apps are listed, and revoked, on Settings → Access tokens.
 */

const SCOPE_ITEMS = [
  { value: "read", label: "Read", description: "Read code, issues, pull requests, runs and logs." },
  { value: "write", label: "Write", description: "Also push and commit, open and merge pull requests, comment, and run workflows (up to maintain)." },
  { value: "admin", label: "Admin", description: "Everything the account can do, including settings, secrets and variables." },
];

/** The authorization request's parameters, as the app sent them. */
const FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;
type Req = Partial<Record<(typeof FIELDS)[number], string>>;

const reqFrom = (get: (k: string) => string | undefined): Req => Object.fromEntries(FIELDS.map((k) => [k, get(k)]).filter(([, v]) => v !== undefined && v !== "")) as Req;

/** Back to the app with a code or an error, and the issuer (RFC 9207) so it knows who answered. */
function backTo(c: AppContext, redirectUri: string, q: Record<string, string | undefined>): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set("iss", c.env.PUBLIC_URL.replace(/\/$/, ""));
  return c.redirect(u.toString(), 303);
}

const problem = (c: AppContext, message: string, status = 400) =>
  render(
    c,
    { title: "Can't connect this app", status },
    <div class="authcard box">
      <div class="body">
        <div class="authmark" aria-hidden="true">
          {raw(ICONS.code)}
        </div>
        <h1>Can't connect this app</h1>
        <p class="muted">{message}</p>
      </div>
    </div>,
  );

/** The accounts a person may connect an app as: themselves first, then the agents they run. */
async function choices(c: AppContext, me: Account): Promise<Account[]> {
  const dir = c.get("dir");
  const orgs = (await dir.orgsFor(me.id)).filter((o) => o.role === "owner" || o.role === "admin");
  const agents = (await dir.agentsOwnedBy([me.id, ...orgs.map((o) => o.id)])).filter((a) => a.status === "active");
  return [me, ...agents];
}

function person(c: AppContext, next: string): Account {
  const me = requireAccount(c);
  if (me.kind !== "user") throw new HttpError(403, "Only people can connect apps. Agents use their own tokens.");
  const p = c.get("principal");
  if (p.type === "account" && p.via === "token") throw new HttpError(403, "Open this page in your browser, signed in with your passkey.");
  requireRecentSignIn(c, next);
  return me;
}

const Consent: FC<{ c: AppContext; me: Account; client: OAuthClient; redirectUri: string; req: Req; accounts: Account[] }> = ({ c, me, client, redirectUri, req, accounts }) => {
  const t = csrfToken(c);
  const verified = client.kind === "metadata" ? new URL(client.id).host : null;
  const scope: TokenScope = requestedScope(req.scope);
  return (
    <div class="authcard box">
      <div class="body">
        <div class="authmark" aria-hidden="true">
          {raw(ICONS.bot)}
        </div>
        <h1>
          Connect <span>{client.name}</span> to Diffinery
        </h1>
        <p class="muted">
          {verified ? (
            <>
              An app published by <b>{verified}</b> wants to use Diffinery as you choose below.
            </>
          ) : (
            <>
              An app calling itself <b>{client.name}</b> (a name it chose, not checked by Diffinery) wants to use Diffinery as you choose below.
            </>
          )}
        </p>
        <dl class="kv mb">
          <dt>Signed in as</dt>
          <dd>
            <b>{me.login}</b>
          </dd>
          <dt>Sends you back to</dt>
          <dd>
            <b>{redirectLabel(redirectUri)}</b>
          </dd>
        </dl>
        <Form action="/oauth/authorize" t={t}>
          {Object.entries(req).map(([k, v]) => (
            <input type="hidden" name={k} value={v} />
          ))}
          <div class="field">
            <label>Act as</label>
            <KRadio
              name="act_as"
              label="Act as"
              value={me.login}
              items={accounts.map((a) => ({
                value: a.login,
                label: a.id === me.id ? `${a.login} (you)` : `${a.login} (agent)`,
                description: a.id === me.id ? "Changes appear as yours." : "Changes appear as the agent's, on your behalf; its pull requests need a person's approval.",
              }))}
            />
          </div>
          <div class="field">
            <label>Access</label>
            <KRadio name="access" label="Access" value={scope} items={SCOPE_ITEMS.map((i) => (i.value === "admin" && !adminAllowed(me) ? { ...i, disabled: true, description: "Not offered to site administrators: the app would carry site-wide administration." } : i))} />
          </div>
          {me.site_admin ? <p class="muted small">You're a site administrator, so an app acting as you can do what site administrators can, within the access above. Consider connecting it as one of your agents instead.</p> : null}
          <p class="muted small">
            The app gets tokens that last {ACCESS_TTL_S / 3600} hours and renew themselves while it's in use (the connection lapses after {REFRESH_IDLE_DAYS} days unused). It can never do more than the account it acts as, and branch protection still applies. You can disconnect it any time under{" "}
            <a href="/settings/tokens#connected-apps">Settings → Access tokens</a>.
          </p>
          <div class="flash warn small">Only connect an app you are setting up yourself right now. Never approve one because someone sent you a link.</div>
          <div class="row">
            <button class="btn primary grow" name="decision" value="approve">
              Connect
            </button>
            <button class="btn" name="decision" value="deny">
              Cancel
            </button>
          </div>
        </Form>
      </div>
    </div>
  );
};

/** Checks the request. Problems with the app or its redirect URI are shown here; the rest go back to the app. */
async function check(c: AppContext, req: Req): Promise<{ client: OAuthClient; redirectUri: string } | Response> {
  const oauth = new OAuth(c.env, c.get("dir"));
  try {
    return await oauth.checkAuthorize(req);
  } catch (e) {
    if (e instanceof HttpError) return problem(c, e.detail);
    if (e instanceof OAuthError) {
      // checkAuthorize only throws OAuthError once the redirect URI is known to be the app's.
      const client = await oauth.client(req.client_id);
      const uri = req.redirect_uri ?? client?.redirect_uris[0];
      if (uri) return backTo(c, uri, { error: e.error, error_description: e.description, state: req.state });
      return problem(c, e.description);
    }
    throw e;
  }
}

export function registerOAuth(web: WebApp): void {
  web.get("/oauth/authorize", async (c) => {
    const req = reqFrom((k) => c.req.query(k));
    // Signed in first: an app's metadata document is fetched only for a person about to approve it.
    const url = new URL(c.req.url);
    const me = person(c, url.pathname + url.search);
    const ok = await check(c, req);
    if (ok instanceof Response) return ok;
    return render(c, { title: `Connect ${ok.client.name}`, formAction: formActionSource(ok.redirectUri) }, <Consent c={c} me={me} client={ok.client} redirectUri={ok.redirectUri} req={req} accounts={await choices(c, me)} />);
  });

  post(web, "/oauth/authorize", async (c, f: FormData) => {
    const req = reqFrom((k) => f.s(k) || undefined);
    const me = person(c, `/oauth/authorize?${new URLSearchParams(req as Record<string, string>)}`);
    const ok = await check(c, req);
    if (ok instanceof Response) return ok;
    if (f.s("decision") !== "approve") return backTo(c, ok.redirectUri, { error: "access_denied", error_description: "the person cancelled", state: req.state });
    const account = (await choices(c, me)).find((a) => a.login === f.s("act_as"));
    if (!account || !(await canActAs(c.get("dir"), me, account))) return problem(c, "You can connect an app only as yourself or as an agent you run.", 403);
    const scope = SCOPE_ITEMS.find((s) => s.value === f.s("access"))?.value as TokenScope | undefined;
    if (!scope) return problem(c, "Choose the access the app gets.");
    if (scope === "admin" && !adminAllowed(account)) return problem(c, "Admin access can't be given to an app acting as a site administrator. Choose Write, or connect it as an agent.", 403);
    const code = await new OAuth(c.env, c.get("dir")).issueCode({ client: ok.client, redirectUri: ok.redirectUri, challenge: req.code_challenge!, person: me, account, scope });
    return backTo(c, ok.redirectUri, { code, state: req.state });
  });

  post(web, "/settings/connected-apps/:id/revoke", async (c) => {
    const me = requireAccount(c);
    const g = await new OAuth(c.env, c.get("dir")).revokeFor(me.id, c.req.param("id") ?? "");
    if (g) c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "oauth.disconnect", target: g.account_id, detail: { app: g.client_name, client_id: g.client_id } }));
    return c.redirect("/settings/tokens#connected-apps", 303);
  });
}

/** The guides for connecting AI apps over MCP, in the order Settings shows them. */
export const CONNECT_GUIDES: Array<{ label: string; href: string }> = [
  { label: "Claude", href: "/docs/connect/claude" },
  { label: "Claude Code", href: "/docs/connect/claude-code" },
  { label: "Codex", href: "/docs/connect/codex" },
  { label: "Other apps", href: "/docs/connect/other-apps" },
];

/** Settings → Access tokens: how to connect an AI app, the apps this person connected, and a way to disconnect each. */
export const ConnectedApps: FC<{ t: string; grants: Awaited<ReturnType<OAuth["grantsFor"]>>; mcpUrl: string }> = ({ t, grants, mcpUrl }) => (
  <div class="box" id="connected-apps">
    <div class="head">
      <h2>Connected apps</h2>
    </div>
    <div class="body connect-ai">
      <p class="muted">
        Connect Claude, Claude Code, Codex or any other MCP app with this server URL. The app sends you here to choose whom it acts as and what it may do, then shows in this list.
      </p>
      <div class="row">
        <code class="grow connect-url">{mcpUrl}</code>
        <CopyButton text={mcpUrl} size="base" />
      </div>
      <p class="small mt">
        Step-by-step guides:{" "}
        {CONNECT_GUIDES.map((g, i) => (
          <>
            {i ? " · " : ""}
            <a href={g.href}>{g.label}</a>
          </>
        ))}
      </p>
    </div>
    {grants.length ? (
      <table class="tbl">
        <thead>
          <tr>
            <th>App</th>
            <th>Acts as</th>
            <th>Access</th>
            <th>Connected</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr>
              <td>
                <b>{g.client_name}</b>
                <div class="faint small">{g.redirect_host}</div>
              </td>
              <td>{g.account_login}</td>
              <td>{g.scope}</td>
              <td class="small">{ago(g.created_at)}</td>
              <td class="small">{g.last_used_at ? ago(g.last_used_at) : <span class="muted">never</span>}</td>
              <td class="right">
                <Form action={`/settings/connected-apps/${g.id}/revoke`} t={t} class="inline" confirm={`Disconnect ${g.client_name}? It stops working until you connect it again.`}>
                  <button class="btn sm danger">Disconnect</button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div class="empty">
        No apps connected yet. Add the URL above to an app and approve it here when it asks; see <a href="/docs/connect">Connect AI apps</a>.
      </div>
    )}
  </div>
);
