import type { Env } from "../env.js";

/**
 * Unexpected server errors (5xx answers), kept in D1 so site administrators can read them
 * without Cloudflare log access. A 5xx answer carries its request id, which finds the record.
 * Records hold the method, route, path, status, message and stack, never request bodies,
 * query strings or headers; token-like strings in a message or stack are masked.
 */
export const KEEP_ERRORS = 500;

export interface ServerError {
  id: string;
  at: string;
  method: string;
  route: string | null;
  path: string;
  status: number;
  message: string;
  stack: string | null;
}

/** The id a 5xx answer reports: Cloudflare's ray id when there is one, so it also finds the request in Cloudflare's logs. */
export function requestId(req: Request): string {
  const ray = req.headers.get("cf-ray");
  return ray && /^[\w-]{8,64}$/.test(ray) ? ray : crypto.randomUUID();
}

/** Masks credentials an error message might quote: Diffinery and GitHub tokens, bearer and basic auth, and URL user info. */
export function redact(s: string): string {
  return s
    .replace(/\b(dfy|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, "$1_…")
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 …")
    .replace(/(\w+:\/\/)[^/\s@]+@/g, "$1…@");
}

/** A request path to keep: a route that carries a secret in the path (`/signin/:token`) keeps its pattern instead. */
export function pathToKeep(path: string, route: string | null): string {
  return route && /:(token|code|secret|key)\b/i.test(route) ? route : path.slice(0, 500);
}

export function errorRecord(e: unknown, r: { id: string; method: string; route: string | null; path: string; status: number }): ServerError {
  const err = e instanceof Error ? e : null;
  return {
    id: r.id,
    at: new Date().toISOString(),
    method: r.method,
    route: r.route,
    path: pathToKeep(r.path, r.route),
    status: r.status,
    message: redact(err ? `${err.name}: ${err.message}` : String(e)).slice(0, 2000),
    stack: err?.stack ? redact(err.stack).slice(0, 8000) : null,
  };
}

/** Saves an error and drops all but the newest KEEP_ERRORS. Never throws: the database may be what failed. */
export async function recordServerError(env: Env, rec: ServerError): Promise<void> {
  try {
    await env.DB.prepare("INSERT OR REPLACE INTO server_errors (id, at, method, route, path, status, message, stack) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(rec.id, rec.at, rec.method, rec.route, rec.path, rec.status, rec.message, rec.stack)
      .run();
    await env.DB.prepare("DELETE FROM server_errors WHERE at < (SELECT at FROM server_errors ORDER BY at DESC LIMIT 1 OFFSET ?)").bind(KEEP_ERRORS - 1).run();
  } catch (x) {
    console.error("could not record a server error", x);
  }
}

/** The newest errors first, or the one with request id `id`. */
export async function serverErrors(env: Env, o: { limit?: number; id?: string } = {}): Promise<ServerError[]> {
  if (o.id) return (await env.DB.prepare("SELECT * FROM server_errors WHERE id = ?").bind(o.id).all<ServerError>()).results;
  const limit = Math.min(Math.max(o.limit ?? 100, 1), KEEP_ERRORS);
  return (await env.DB.prepare("SELECT * FROM server_errors ORDER BY at DESC LIMIT ?").bind(limit).all<ServerError>()).results;
}
