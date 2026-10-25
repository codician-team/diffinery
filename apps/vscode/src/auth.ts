import * as http from "node:http";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { Api } from "./api";
import { chooseServer } from "./servers";
import { authorizeUrl, clientId, editorRedirect, normalizeServer, pkce, readCallback } from "./util";

export const AUTH_ID = "diffinery";
/** What the extension asks for: push and pull, issues and pull requests. The person can lower it on the consent page. */
export const SCOPES = ["write"];
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** Refresh this long before the access token expires (they last 8 hours). */
const REFRESH_MARGIN_MS = 10 * 60_000;

/** A signed-in account as kept in the editor's secret storage. */
export interface Stored {
  id: string;
  server: string;
  login: string;
  accountId: string;
  /** "oauth": approved in the browser, renews itself. "token": an access token someone pasted. */
  kind: "oauth" | "token";
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class SignInError extends Error {}

/**
 * Diffinery as an account provider in the editor (the Accounts menu), signed in through Diffinery's OAuth
 * (the browser asks the person to approve, with their passkey) or with a pasted access token. Tokens from
 * OAuth last 8 hours and are renewed with the refresh token before they run out, so Git never sees an
 * expired one while the editor is open.
 */
export class DiffineryAuth implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.changes.event;
  /** Fired in the window that changed the stored account (sign-in, renewal, sign-out), for Git's credential store. */
  private readonly stored = new vscode.EventEmitter<{ before?: Stored; after?: Stored }>();
  readonly onDidStore = this.stored.event;

  private readonly callbacks = new Map<string, (query: string) => void>();
  private refreshing: Promise<Stored | undefined> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private last: Stored | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly version: string,
  ) {
    // Another window signed in, renewed or signed out: the secret storage is shared, so follow it.
    this.disposables.push(
      ctx.secrets.onDidChange(async (e) => {
        if (e.key === this.key()) await this.syncFromStorage();
      }),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("diffinery.serverUrl")) await this.syncFromStorage();
      }),
    );
    void this.syncFromStorage();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    this.changes.dispose();
    this.stored.dispose();
  }

  server(): string {
    return normalizeServer(vscode.workspace.getConfiguration("diffinery").get<string>("serverUrl"));
  }

  private key(): string {
    let server: string;
    try {
      server = this.server();
    } catch {
      server = "invalid";
    }
    return `diffinery.account:${server}`;
  }

  private async load(): Promise<Stored | undefined> {
    const raw = await this.ctx.secrets.get(this.key());
    if (!raw) return undefined;
    try {
      const s = JSON.parse(raw) as Stored;
      return s.server === this.server() && s.accessToken ? s : undefined;
    } catch {
      return undefined;
    }
  }

  private async save(s: Stored | undefined): Promise<void> {
    const before = this.last;
    if (s) await this.ctx.secrets.store(this.key(), JSON.stringify(s));
    else await this.ctx.secrets.delete(this.key());
    this.announce(s);
    this.stored.fire({ before, after: s });
  }

  /** Tells the editor what changed since it last heard, and plans the next renewal. */
  private announce(s: Stored | undefined): void {
    const before = this.last;
    this.last = s;
    this.schedule(s);
    if (!before && s) this.changes.fire({ added: [toSession(s)], removed: [], changed: [] });
    else if (before && !s) this.changes.fire({ added: [], removed: [toSession(before)], changed: [] });
    else if (before && s && before.id !== s.id) this.changes.fire({ added: [toSession(s)], removed: [toSession(before)], changed: [] });
    else if (before && s && before.accessToken !== s.accessToken) this.changes.fire({ added: [], removed: [], changed: [toSession(s)] });
  }

  private async syncFromStorage(): Promise<void> {
    try {
      this.announce(await this.load());
    } catch (e) {
      this.log.error("reading the stored Diffinery account failed", e);
    }
  }

  private schedule(s: Stored | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!s || s.kind !== "oauth" || !s.expiresAt) return;
    // A little jitter, so several windows don't all renew at the same moment.
    const wait = Math.max(5_000, s.expiresAt - REFRESH_MARGIN_MS - Date.now() + Math.random() * 60_000);
    this.timer = setTimeout(() => void this.fresh().catch((e) => this.log.warn("renewing the Diffinery sign-in failed", e)), Math.min(wait, 2 ** 31 - 1));
  }

  /** The stored account, renewed first when its token is about to expire. Undefined when signed out. */
  async fresh(): Promise<Stored | undefined> {
    const s = await this.load();
    if (!s || s.kind !== "oauth" || !s.expiresAt || s.expiresAt - Date.now() > REFRESH_MARGIN_MS) return s;
    this.refreshing ??= this.refresh(s).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(s: Stored): Promise<Stored | undefined> {
    if (!s.refreshToken) return s;
    let res: TokenResponse;
    try {
      res = await tokenRequest(s.server, { grant_type: "refresh_token", refresh_token: s.refreshToken, client_id: clientId(s.server) });
    } catch (e) {
      if (!(e instanceof SignInError)) {
        // Offline or the server is unreachable: keep the account; Git gets the old token while it lasts.
        this.log.warn("could not reach Diffinery to renew the sign-in", e);
        return s;
      }
      // Another window may have renewed with the same refresh token a moment earlier: use what it stored.
      await new Promise((r) => setTimeout(r, 1500));
      const now = await this.load();
      if (now && now.refreshToken !== s.refreshToken) return now;
      this.log.warn("the Diffinery sign-in ended", e.message);
      await this.save(undefined);
      void vscode.window.showWarningMessage("Your Diffinery sign-in has ended (it was disconnected, or unused for 30 days). Sign in again to keep cloning and pushing.", "Sign In").then((pick) => {
        if (pick) void vscode.commands.executeCommand("diffinery.signIn");
      });
      return undefined;
    }
    const next: Stored = { ...s, accessToken: res.access_token, refreshToken: res.refresh_token ?? s.refreshToken, expiresAt: Date.now() + (res.expires_in ?? 8 * 3600) * 1000 };
    await this.save(next);
    this.log.info(`renewed the Diffinery sign-in for ${s.login}`);
    return next;
  }

  // ------------------------------------------------------------------ AuthenticationProvider

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const s = await this.fresh();
    if (s !== this.last && (s?.accessToken !== this.last?.accessToken || s?.id !== this.last?.id)) this.announce(s);
    return s ? [toSession(s)] : [];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    // Every way in (the Accounts menu, the clone picker, Publish, the commands) first asks which Diffinery, until
    // someone has chosen, so a self-hosted one needs no trip to the settings. It may change diffinery.serverUrl, and
    // with it this.key().
    await chooseServer(this.ctx.globalState);
    const s = this.withToken ? await this.askForToken() : await this.signInWithBrowser();
    // Signing in again replaces the old sign-in, and ends its connection on the server.
    const old = await this.load();
    if (old) await this.removeSession(old.id);
    await this.save(s);
    void vscode.window.showInformationMessage(`Signed in to Diffinery as ${s.login}.`);
    return toSession(s);
  }

  /** Set while "Sign In with an Access Token" runs, so createSession asks for a token instead of opening the browser. */
  private withToken = false;

  async removeSession(id: string): Promise<void> {
    const s = await this.load();
    if (!s || s.id !== id) return;
    await this.save(undefined);
    // Ends the connection on the server too (Settings → Access tokens → Connected apps). A pasted token is the
    // person's own and may be used elsewhere, so it's only forgotten here.
    if (s.kind === "oauth" && s.refreshToken) {
      await fetch(`${s.server}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": `Diffinery-VSCode/${this.version}` },
        body: new URLSearchParams({ token: s.refreshToken, client_id: clientId(s.server) }),
        signal: AbortSignal.timeout(10_000),
      }).catch((e) => this.log.warn("revoking the Diffinery connection failed", e));
    }
  }

  // ------------------------------------------------------------------ signing in

  /** The editor's URL handler: /oauth is where the browser comes back after approving. */
  handleUri(uri: vscode.Uri): boolean {
    if (uri.path !== "/oauth") return false;
    const state = new URLSearchParams(uri.query).get("state") ?? "";
    const done = this.callbacks.get(state);
    if (!done) {
      void vscode.window.showWarningMessage("This Diffinery sign-in link is from an earlier attempt. Sign in again from the editor.");
      return true;
    }
    done(uri.query);
    return true;
  }

  private async signInWithBrowser(): Promise<Stored> {
    if (vscode.env.uiKind === vscode.UIKind.Web) throw new SignInError("Signing in through the browser needs the desktop editor. In a browser-based editor, run “Diffinery: Sign In with an Access Token”.");
    const server = this.server();
    const { verifier, challenge, state } = pkce();
    // The browser comes back to a one-time listener on this computer (RFC 8252): no prompt to open the editor, and
    // no "Allow the extension to open this URI?" dialog. Where that can't work (a browser-based remote), it comes
    // back through the editor's own URL scheme instead.
    let redirectUri: string | null = null;
    let wait: Promise<string> | undefined;
    const loopback = await listenOnce(state).catch((e) => {
      this.log.warn("couldn't listen on 127.0.0.1 for the sign-in", e);
      return undefined;
    });
    if (loopback) {
      const external = new URL((await vscode.env.asExternalUri(vscode.Uri.parse(loopback.uri))).toString(true));
      if (external.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(external.hostname)) {
        redirectUri = `http://127.0.0.1:${external.port || loopback.port}/callback`;
        wait = loopback.result;
      } else {
        loopback.close();
      }
    }
    if (!redirectUri) {
      redirectUri = editorRedirect(vscode.env.uriScheme);
      if (!redirectUri) throw new SignInError("This editor can't receive Diffinery's sign-in. Run “Diffinery: Sign In with an Access Token” instead.");
      wait = new Promise((resolve) => this.callbacks.set(state, resolve));
    }
    try {
      const url = authorizeUrl(server, redirectUri, challenge, state);
      this.log.info(`opening ${server}/oauth/authorize for the editor's sign-in (redirect ${redirectUri})`);
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
      const query = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Signing in to Diffinery", cancellable: true },
        async (progress, cancel) => {
          progress.report({ message: opened ? "Approve the connection in your browser…" : `Open ${url} in your browser and approve the connection…` });
          return Promise.race([
            wait!,
            new Promise<never>((_, reject) => cancel.onCancellationRequested(() => reject(new vscode.CancellationError()))),
            new Promise<never>((_, reject) => setTimeout(() => reject(new SignInError("Signing in to Diffinery timed out. Try again.")), SIGN_IN_TIMEOUT_MS)),
          ]);
        },
      );
      const r = readCallback(query, { state, server });
      if ("error" in r) throw new SignInError(r.error);
      const tok = await tokenRequest(server, { grant_type: "authorization_code", code: r.code, code_verifier: verifier, client_id: clientId(server), redirect_uri: redirectUri });
      const user = await new Api(server, tok.access_token, this.version).user();
      return {
        id: randomUUID(),
        server,
        login: user.login,
        accountId: String(user.id),
        kind: "oauth",
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: Date.now() + (tok.expires_in ?? 8 * 3600) * 1000,
      };
    } finally {
      this.callbacks.delete(state);
      loopback?.close();
    }
  }

  /**
   * Signs in with an access token someone pastes (for an agent account, a self-hosted server, or a browser-based
   * editor). It goes through the editor's own sign-in, like the browser sign-in, so the editor records that this
   * extension may use the account and doesn't ask again on the first clone.
   */
  async signInWithToken(): Promise<void> {
    const signedIn = await this.load();
    this.withToken = true;
    try {
      await vscode.authentication.getSession(AUTH_ID, SCOPES, signedIn ? { forceNewSession: { detail: `Replace ${signedIn.login}'s sign-in with an access token.` } } : { createIfNone: true });
    } finally {
      this.withToken = false;
    }
  }

  private async askForToken(): Promise<Stored> {
    const server = this.server();
    const token = (
      await vscode.window.showInputBox({
        title: "Sign in to Diffinery with an access token",
        prompt: `Paste a token from ${server}/settings/tokens (write access lets you push). It stays in the editor's secret storage.`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (/^\s*\S+\s*$/.test(v) ? null : "Paste the whole token, without spaces."),
      })
    )?.trim();
    if (!token) throw new vscode.CancellationError();
    const user = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking the token with Diffinery…" }, () => new Api(server, token, this.version).user());
    return { id: randomUUID(), server, login: user.login, accountId: String(user.id), kind: "token", accessToken: token };
  }

  /** Who is signed in to the server in the settings, if anyone. */
  async login(): Promise<string | undefined> {
    return (await this.load())?.login;
  }

  async signOut(): Promise<void> {
    const s = await this.load();
    if (!s) {
      void vscode.window.showInformationMessage("You aren't signed in to Diffinery.");
      return;
    }
    await this.removeSession(s.id);
    void vscode.window.showInformationMessage(`Signed out of Diffinery (${s.login}).`);
  }

  /** An API client for the signed-in account, asking the person to sign in when `ask` and nobody is. */
  async api(ask: boolean): Promise<Api | undefined> {
    const session = await vscode.authentication.getSession(AUTH_ID, SCOPES, ask ? { createIfNone: true } : { silent: true });
    return session ? new Api(this.server(), session.accessToken, this.version) : undefined;
  }
}

const toSession = (s: Stored): vscode.AuthenticationSession => ({ id: s.id, accessToken: s.accessToken, account: { id: s.accountId, label: s.login }, scopes: SCOPES });

/** POSTs to the token endpoint. SignInError when the server refuses (the grant is gone); other errors mean it wasn't reached. */
async function tokenRequest(server: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${server}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });
  let body: TokenResponse;
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    throw new Error(`Diffinery's token endpoint answered ${res.status}`);
  }
  if (res.status >= 500) throw new Error(`Diffinery's token endpoint answered ${res.status}`);
  if (!res.ok || !body.access_token) throw new SignInError(body.error_description || body.error || `Diffinery refused the sign-in (${res.status}).`);
  return body;
}

interface Loopback {
  uri: string;
  port: number;
  result: Promise<string>;
  close(): void;
}

/** A listener on 127.0.0.1 that takes one browser callback for this sign-in and says it can be closed. */
function listenOnce(state: string): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let done: (q: string) => void;
    const result = new Promise<string>((r) => (done = r));
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) {
        res.writeHead(404).end();
        return;
      }
      const ok = !u.searchParams.has("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Diffinery</title><body style="font:16px system-ui,sans-serif;margin:15vh auto;max-width:28rem;text-align:center"><h1 style="font-size:20px">${ok ? "You're signed in to Diffinery" : "Sign-in cancelled"}</h1><p>You can close this tab and go back to your editor.</p></body>`,
      );
      done(u.search.slice(1));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ uri: `http://127.0.0.1:${port}/callback`, port, result, close: () => server.close() });
    });
  });
}
