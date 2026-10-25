import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, requireAccountScope, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { EarlyAccess, REQUEST_STATES, declineRequest, deleteRequest, inviteRequest, requestJson, type RequestState } from "../lib/early-access.js";
import { HttpError } from "../lib/util.js";

/**
 * Early access requests over the REST API (lib/early-access.ts), for site administrators only.
 * To anyone else these endpoints don't exist (404), like the requests themselves.
 */
export const earlyAccessApi = new Hono<{ Bindings: Env; Variables: AppVars }>().basePath("/api/v3");

const siteAdmin = (c: AppContext, scope: "read" | "admin"): Account => {
  const a = requireAccount(c);
  if (!a.site_admin || a.kind !== "user") throw new HttpError(404, "not found");
  requireAccountScope(c, scope);
  return a;
};

const audit = (c: AppContext) => (e: Parameters<AppContext["var"]["dir"]["audit"]>[0]) => c.get("dir").audit(e);

earlyAccessApi.get("/diffinery/admin/early-access", async (c) => {
  siteAdmin(c, "read");
  const s = c.req.query("state");
  if (s && !REQUEST_STATES.includes(s as RequestState)) throw new HttpError(422, `state must be one of ${REQUEST_STATES.join(", ")}`);
  const n = Number(c.req.query("per_page") ?? 100);
  const page = Math.max(1, Math.min(1000, Number(c.req.query("page") ?? 1) || 1));
  const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 500) : 100;
  const { items } = await new EarlyAccess(c.env.DB).list({ state: (s as RequestState) || undefined, q: c.req.query("q") ?? "", limit, offset: (page - 1) * limit });
  return c.json(items.map((r) => requestJson(c.env, r)));
});

earlyAccessApi.get("/diffinery/admin/early-access/:id", async (c) => {
  siteAdmin(c, "read");
  const r = await new EarlyAccess(c.env.DB).get(c.req.param("id"));
  if (!r) throw new HttpError(404, "no early access request with that id");
  return c.json(requestJson(c.env, r));
});

/** Send the request's address the instance's invitation email. Audited. */
earlyAccessApi.post("/diffinery/admin/early-access/:id/invite", async (c) => {
  const me = siteAdmin(c, "admin");
  return c.json(requestJson(c.env, await inviteRequest(c.env, c.get("dir"), audit(c), me, c.req.param("id"), "api")));
});

/** Decline a request (`{"state": "declined"}`) or put a declined one back (`{"state": "confirmed"}`). Audited; nobody is emailed. */
earlyAccessApi.patch("/diffinery/admin/early-access/:id", async (c) => {
  const me = siteAdmin(c, "admin");
  let b: { state?: unknown };
  try {
    b = (await c.req.json()) as typeof b;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (!b || typeof b !== "object" || (b.state !== "declined" && b.state !== "confirmed")) throw new HttpError(422, 'send {"state": "declined"} to decline, or {"state": "confirmed"} to put a declined request back');
  return c.json(requestJson(c.env, await declineRequest(c.env.DB, audit(c), me, c.req.param("id"), b.state === "confirmed", "api")));
});

/** Delete a request and its daily-limit rows (data removal). Audited without its content. */
earlyAccessApi.delete("/diffinery/admin/early-access/:id", async (c) => {
  const me = siteAdmin(c, "admin");
  await deleteRequest(c.env.DB, audit(c), me, c.req.param("id"), "api");
  return c.body(null, 204);
});
