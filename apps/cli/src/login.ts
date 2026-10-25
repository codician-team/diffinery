import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, hostname, platform } from "node:os";
import { Api } from "./api.js";
import type { Ctx } from "./cli.js";
import { CliError, type Io } from "./io.js";
import { VERSION } from "./version.js";

/**
 * Signing in through the browser, so nobody copies a token by hand (the server side is
 * apps/diffinery/src/auth/cli-login.ts):
 *
 * - browserLogin: listen on 127.0.0.1, open /login/cli with a PKCE challenge, and wait for the
 *   browser to come back to /callback with a one-time code; trade it, with the verifier only this
 *   process knows, for a token.
 * - deviceLogin: for machines without a browser. Print a short code to type on /login/device in
 *   any browser, and poll until the person approves.
 */

export type Scope = "read" | "write" | "admin";

export interface TokenGrant {
  access_token: string;
  scope: Scope;
  expires_at: string;
  login: string;
}

interface TokenError {
  error: string;
  error_description?: string;
}

/** How long to wait for the person before giving up. */
const BROWSER_TIMEOUT_MS = 10 * 60_000;

const b64url = (b: Buffer) => b.toString("base64url");

/** What the authorize page shows about this computer, and what the token is named after. */
export function clientInfo(): { host: string; os: string; version: string } {
  return { host: hostname().replace(/\.local$/, "") || "unknown host", os: `${platform()}-${arch()}`, version: VERSION };
}

/**
 * Opens `url` in the default browser: `BROWSER` when set (`BROWSER=none` opens nothing), else
 * open (macOS), rundll32 (Windows, which avoids cmd's handling of `&`) or xdg-open. True when a
 * browser command started; the caller prints the URL either way.
 */
export function openBrowser(io: Io, url: string): Promise<boolean> {
  if (io.openUrl) return io.openUrl(url);
  const pref = io.env.BROWSER?.trim();
  if (pref === "none") return Promise.resolve(false);
  const [cmd, args] = pref ? [pref, [url]] : process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Whether a browser on this machine can reach a server on this machine's 127.0.0.1. */
export function browserLikely(io: Io): boolean {
  if (io.openUrl) return true;
  if (io.env.BROWSER?.trim() && io.env.BROWSER.trim() !== "none") return true;
  // Over SSH the browser runs on another computer, where 127.0.0.1 is not this one.
  if (io.env.SSH_CONNECTION || io.env.SSH_TTY) return false;
  if (process.platform === "linux" || process.platform === "freebsd" || process.platform === "openbsd") return !!(io.env.DISPLAY || io.env.WAYLAND_DISPLAY);
  return true;
}

async function exchange(url: string, body: Record<string, string>): Promise<TokenGrant | TokenError> {
  const res = await new Api(url, null).raw<TokenGrant | TokenError>("POST", "/-/cli/token", { body, allow: [400] });
  return res.data;
}

const isGrant = (v: TokenGrant | TokenError): v is TokenGrant => typeof (v as TokenGrant).access_token === "string";

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;

export async function browserLogin(ctx: Ctx, url: string, scope: Scope): Promise<TokenGrant> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  let settle!: { ok: (g: TokenGrant) => void; fail: (e: Error) => void };
  const done = new Promise<TokenGrant>((ok, fail) => (settle = { ok, fail }));
  done.catch(() => {}); // awaited below; this only keeps an early failure from counting as unhandled
  let busy = false;
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || u.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    // Only the browser this process sent out carries its state; anything else is ignored.
    if (u.searchParams.get("state") !== state || busy) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Not this sign-in", "This link doesn't belong to the <code>diffinery login</code> that is waiting. Run it again if you need to."));
      return;
    }
    busy = true;
    const back = (result: string) => res.writeHead(302, { location: `${url}/login/cli/done?result=${result}`, "cache-control": "no-store" }).end();
    const error = u.searchParams.get("error");
    if (error) {
      back(error === "access_denied" ? "denied" : "failed");
      return settle.fail(new CliError(error === "access_denied" ? "the sign-in was cancelled in the browser" : `the browser returned an error: ${error}`));
    }
    try {
      const got = await exchange(url, { grant_type: "authorization_code", code: u.searchParams.get("code") ?? "", code_verifier: verifier });
      if (!isGrant(got)) throw new CliError(`sign-in failed: ${got.error_description ?? got.error}`);
      back("ok");
      settle.ok(got);
    } catch (e) {
      back("failed");
      settle.fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const port = (server.address() as AddressInfo).port;
  const client = clientInfo();
  const authorize = `${url}/login/cli?${new URLSearchParams({ port: String(port), state, code_challenge: challenge, code_challenge_method: "S256", scope, host: client.host, os: client.os, version: client.version })}`;
  const timer = setTimeout(() => settle.fail(new CliError("timed out waiting for the browser; run `diffinery login` again")), BROWSER_TIMEOUT_MS);
  try {
    const opened = await openBrowser(ctx.io, authorize);
    ctx.err(opened ? `Opening your browser to sign in to ${ctx.c.bold(new URL(url).host)}…` : `Open this link in a browser on this computer to sign in:`);
    ctx.err(opened ? ctx.c.dim(`If it didn't open, visit:\n${authorize}`) : authorize);
    ctx.err(ctx.c.dim("Waiting for you to authorize (Ctrl+C to cancel). No browser here? Run `diffinery login --device`."));
    return await done;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

export async function deviceLogin(ctx: Ctx, url: string, scope: Scope): Promise<TokenGrant> {
  const api = new Api(url, null);
  const d = await api.post<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>("/-/cli/device", { client: clientInfo(), scope });
  ctx.err(`Your one-time code: ${ctx.c.bold(d.user_code)}`);
  ctx.err(`Open ${ctx.c.bold(d.verification_uri)} in a browser on any device, sign in, and enter the code.`);
  ctx.err(ctx.c.dim("Waiting for you to approve (Ctrl+C to cancel)…"));
  let interval = Math.max(1, d.interval) * 1000;
  const end = Date.now() + d.expires_in * 1000;
  while (Date.now() < end) {
    await ctx.io.sleep(interval);
    const got = await exchange(url, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code });
    if (isGrant(got)) return got;
    if (got.error === "authorization_pending") continue;
    if (got.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (got.error === "access_denied") throw new CliError("the sign-in was cancelled in the browser");
    if (got.error === "expired_token") break;
    throw new CliError(`sign-in failed: ${got.error_description ?? got.error}`);
  }
  throw new CliError("the code expired; run `diffinery login --device` again");
}

/** `diffinery logout`: a token a CLI sign-in created is revoked with itself. False for any other token, or when the server can't be reached. */
export async function revokeCliToken(url: string, token: string): Promise<boolean> {
  try {
    const r = await new Api(url, token).raw<{ revoked?: boolean }>("DELETE", "/-/cli/token", { allow: [401, 403, 404] });
    return r.status === 200 && r.data?.revoked === true;
  } catch {
    return false;
  }
}
