import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, requireAccountScope, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { StatusIncidents, incidentJson, openIncident, postUpdate, statusSummary, summaryJson, validateIncident, validateUpdate } from "../lib/status.js";
import { HttpError } from "../lib/util.js";

/**
 * The status page over the REST API (lib/status.ts): the public summary, and incidents for site
 * administrators. To anyone else the admin endpoints don't exist (404), like security reports'.
 */
export const statusApi = new Hono<{ Bindings: Env; Variables: AppVars }>().basePath("/api/v3");

const siteAdmin = (c: AppContext, scope: "read" | "admin"): Account => {
  const a = requireAccount(c);
  if (!a.site_admin || a.kind !== "user") throw new HttpError(404, "not found");
  requireAccountScope(c, scope);
  return a;
};

async function body(c: AppContext): Promise<Record<string, unknown>> {
  let b: unknown;
  try {
    b = await c.req.json();
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(422, "Send a JSON object.");
  return b as Record<string, unknown>;
}

/** Public, for anyone and any monitor; shared caches may keep it for 30 seconds. */
statusApi.get("/diffinery/status", async (c) => {
  const s = await statusSummary(c.env);
  return c.json(summaryJson(c.env, s), 200, { "cache-control": "public, max-age=30" });
});

statusApi.get("/diffinery/admin/status/incidents", async (c) => {
  siteAdmin(c, "read");
  const n = Number(c.req.query("per_page") ?? 50);
  const rows = await new StatusIncidents(c.env.DB).list({ limit: Number.isFinite(n) ? n : 50 });
  return c.json(rows.map((i) => incidentJson(c.env, i, { admin: true })));
});

/** Open an incident with its first update. Audited. */
statusApi.post("/diffinery/admin/status/incidents", async (c) => {
  const me = siteAdmin(c, "admin");
  const input = validateIncident(await body(c));
  const i = await openIncident(c.env.DB, (e) => c.get("dir").audit(e), me, input, "api");
  return c.json(incidentJson(c.env, i, { admin: true }), 201);
});

/** Post an update, which moves the incident to its state (resolved resolves it). Audited. */
statusApi.post("/diffinery/admin/status/incidents/:id/updates", async (c) => {
  const me = siteAdmin(c, "admin");
  const input = validateUpdate(await body(c));
  const i = await postUpdate(c.env.DB, (e) => c.get("dir").audit(e), me, c.req.param("id"), input, "api");
  return c.json(incidentJson(c.env, i, { admin: true }), 201);
});
