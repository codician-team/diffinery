import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppVars } from "../auth/principal.js";
import { CliLoginError, CliLogins, cleanClient, formatUserCode, isB64urlParam, requireScopeName } from "../auth/cli-login.js";
import { HttpError } from "../lib/util.js";

/**
 * What the CLI calls to sign in through the browser (auth/cli-login.ts): start a device sign-in,
 * trade a code for a token, and revoke its own token on `diffinery logout`. JSON in and out, no
 * cookies; the pages people approve on are in web/cli-login.tsx.
 */
export const cliLogin = new Hono<{ Bindings: Env; Variables: AppVars }>();

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "expected JSON");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 8192) throw new HttpError(413, "request too large");
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "invalid JSON");
  return b as Record<string, unknown>;
}

cliLogin.post("/-/cli/device", async (c) => {
  const b = await jsonBody(c.req.raw);
  const client = cleanClient((b.client ?? {}) as Record<string, unknown>);
  const scope = requireScopeName(b.scope);
  const cf = (c.req.raw as { cf?: { city?: string; country?: string } }).cf;
  const location = [cf?.city, cf?.country].filter(Boolean).join(", ") || undefined;
  const d = await new CliLogins(c.env, c.get("dir")).startDevice(client, scope, { ip: c.req.header("cf-connecting-ip") ?? undefined, location });
  const base = c.env.PUBLIC_URL.replace(/\/$/, "");
  return c.json(
    {
      device_code: d.deviceCode,
      user_code: formatUserCode(d.userCode),
      // No verification_uri_complete: the code is typed, never carried in a link someone could send.
      verification_uri: `${base}/login/device`,
      expires_in: d.expiresIn,
      interval: d.interval,
    },
    200,
    NO_STORE,
  );
});

cliLogin.post("/-/cli/token", async (c) => {
  const b = await jsonBody(c.req.raw);
  const logins = new CliLogins(c.env, c.get("dir"));
  try {
    let grant: Parameters<CliLogins["exchange"]>[0];
    if (b.grant_type === "authorization_code" && typeof b.code === "string" && isB64urlParam(b.code_verifier, 43)) grant = { type: "code", code: b.code, verifier: b.code_verifier };
    else if (b.grant_type === "urn:ietf:params:oauth:grant-type:device_code" && typeof b.device_code === "string") grant = { type: "device", deviceCode: b.device_code };
    else throw new CliLoginError("invalid_request", "send grant_type authorization_code with code and code_verifier, or the device code grant with device_code");
    const t = await logins.exchange(grant);
    return c.json({ access_token: t.token, token_type: "bearer", scope: t.scope, expires_at: t.expiresAt, login: t.login }, 200, NO_STORE);
  } catch (e) {
    if (!(e instanceof CliLoginError)) throw e;
    return c.json({ error: e.error, error_description: e.description }, 400, NO_STORE);
  }
});

cliLogin.delete("/-/cli/token", async (c) => {
  const p = c.get("principal");
  if (p.type !== "account" || p.via !== "token" || !p.tokenId) throw new HttpError(401, "send the token to revoke as the Authorization header");
  const revoked = await new CliLogins(c.env, c.get("dir")).revokeCliToken(p.account.id, p.tokenId);
  if (revoked) c.executionCtx.waitUntil(c.get("dir").audit({ actorId: p.account.id, actorLogin: p.account.login, action: "token.revoke", target: p.tokenId, detail: { via: "diffinery logout" } }));
  return c.json({ revoked }, 200, NO_STORE);
});
