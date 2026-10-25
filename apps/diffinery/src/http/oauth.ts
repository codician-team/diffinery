import { Hono, type Context } from "hono";
import type { Env } from "../env.js";
import type { AppVars } from "../auth/principal.js";
import { OAuth, OAuthError, OWN_CLIENT_PATHS, authorizationServerMetadata, ownClientDocument, protectedResourceMetadata } from "../auth/oauth.js";

/**
 * OAuth's machine endpoints for MCP clients (auth/oauth.ts has the flow; the consent page is in
 * web/oauth.tsx): discovery documents, dynamic client registration, the token endpoint and
 * revocation. They carry no cookies, so any origin may call them (a browser-based MCP client
 * such as the MCP Inspector does), and app.ts lets them through without a session.
 */
export const oauthApi = new Hono<{ Bindings: Env; Variables: AppVars }>();

/** Paths here that app.ts treats as credential-free API calls (no session, no cross-site check). */
export const OAUTH_API_PATH = /^\/oauth\/(?:register|token|revoke)$/;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version", "access-control-max-age": "86400" };
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
const DISCOVERY = { ...CORS, "cache-control": "public, max-age=3600" };

oauthApi.options("/.well-known/oauth-protected-resource/*", (c) => c.body(null, 204, CORS));
oauthApi.options("/.well-known/oauth-protected-resource", (c) => c.body(null, 204, CORS));
oauthApi.options("/.well-known/oauth-authorization-server", (c) => c.body(null, 204, CORS));
oauthApi.options("/oauth/*", (c) => c.body(null, 204, CORS));

// RFC 9728: at the root and at the path of the resource (/mcp), where the 401's header points.
oauthApi.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(c.env), 200, DISCOVERY));
oauthApi.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(c.env), 200, DISCOVERY));
oauthApi.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(c.env), 200, DISCOVERY));
// Clients that put the resource's path after the well-known name (RFC 8414 §3.1 with an issuer path) get the same document.
oauthApi.get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(authorizationServerMetadata(c.env), 200, DISCOVERY));

// The metadata documents of Diffinery's own editor extension and JetBrains plugin, whose client_ids are these URLs.
for (const path of OWN_CLIENT_PATHS) oauthApi.get(path, (c) => c.json(ownClientDocument(c.env, path), 200, DISCOVERY));

const oauthError = (c: Context, e: OAuthError) => {
  const headers: Record<string, string> = { ...CORS, ...NO_STORE };
  if (e.status === 401) headers["www-authenticate"] = 'Basic realm="Diffinery OAuth"';
  return c.json({ error: e.error, error_description: e.description }, e.status as 400 | 401, headers);
};

/** The request's parameters: form-encoded, as OAuth specifies, or JSON, which some clients send. */
async function params(req: Request, max = 16384): Promise<Record<string, string>> {
  if (Number(req.headers.get("content-length") ?? "0") > max) throw new OAuthError("invalid_request", "request too large", 413 as 400);
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length > max) throw new OAuthError("invalid_request", "request too large", 413 as 400);
  const out: Record<string, string> = {};
  if (/^application\/json\b/i.test(type)) {
    let b: unknown;
    try {
      b = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_request", "invalid JSON");
    }
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new OAuthError("invalid_request", "expected a JSON object");
    for (const [k, v] of Object.entries(b)) if (typeof v === "string") out[k] = v;
    return out;
  }
  for (const [k, v] of new URLSearchParams(text)) {
    // RFC 6749 §3.2: a parameter sent twice is an error.
    if (k in out) throw new OAuthError("invalid_request", `${k} was sent more than once`);
    out[k] = v;
  }
  return out;
}

oauthApi.post("/oauth/register", async (c) => {
  try {
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) throw new OAuthError("invalid_client_metadata", "send the client metadata as JSON");
    const text = await c.req.text();
    if (text.length > 16384) throw new OAuthError("invalid_client_metadata", "client metadata too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "invalid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "expected a JSON object");
    const out = await new OAuth(c.env, c.get("dir")).register(body as Record<string, unknown>);
    return c.json(out, 201, { ...CORS, ...NO_STORE });
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(c, e);
    throw e;
  }
});

oauthApi.post("/oauth/token", async (c) => {
  try {
    const form = await params(c.req.raw);
    const oauth = new OAuth(c.env, c.get("dir"));
    const client = await oauth.authenticateClient(form, c.req.header("authorization"));
    if (form.grant_type === "authorization_code") return c.json(await oauth.exchangeCode(client, form), 200, { ...CORS, ...NO_STORE });
    if (form.grant_type === "refresh_token") return c.json(await oauth.refresh(client, form), 200, { ...CORS, ...NO_STORE });
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(c, e);
    throw e;
  }
});

oauthApi.post("/oauth/revoke", async (c) => {
  try {
    const form = await params(c.req.raw);
    const oauth = new OAuth(c.env, c.get("dir"));
    const client = await oauth.authenticateClient(form, c.req.header("authorization"));
    if (!form.token) throw new OAuthError("invalid_request", "token is required");
    await oauth.revokeToken(client, form.token);
    return c.body(null, 200, { ...CORS, ...NO_STORE });
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(c, e);
    throw e;
  }
});
