import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, requireAccountScope, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { REPORT_STATES, SecurityReports, changeReport, reportJson, type ReportState } from "../lib/security-reports.js";
import { HttpError } from "../lib/util.js";

/**
 * Security reports over the REST API (lib/security-reports.ts), for site administrators only.
 * To anyone else these endpoints don't exist (404), like the reports themselves.
 */
export const securityReportsApi = new Hono<{ Bindings: Env; Variables: AppVars }>().basePath("/api/v3");

const siteAdmin = (c: AppContext, scope: "read" | "admin"): Account => {
  const a = requireAccount(c);
  if (!a.site_admin || a.kind !== "user") throw new HttpError(404, "not found");
  requireAccountScope(c, scope);
  return a;
};

securityReportsApi.get("/diffinery/admin/security-reports", async (c) => {
  siteAdmin(c, "read");
  const q = c.req.query("state");
  if (q && !REPORT_STATES.includes(q as ReportState)) throw new HttpError(422, `state must be one of ${REPORT_STATES.join(", ")}`);
  const n = Number(c.req.query("per_page") ?? 100);
  const rows = await new SecurityReports(c.env.DB).list({ state: (q as ReportState) || undefined, limit: Number.isFinite(n) ? n : 100 });
  return c.json(rows.map((r) => reportJson(c.env, r)));
});

securityReportsApi.get("/diffinery/admin/security-reports/:id", async (c) => {
  siteAdmin(c, "read");
  const r = await new SecurityReports(c.env.DB).get(c.req.param("id"));
  if (!r) throw new HttpError(404, "no security report with that id");
  return c.json(reportJson(c.env, r));
});

/** Mark a report triaged or resolved (or new again), with an optional note. Audited. */
securityReportsApi.patch("/diffinery/admin/security-reports/:id", async (c) => {
  const me = siteAdmin(c, "admin");
  let b: { state?: unknown; note?: unknown };
  try {
    b = (await c.req.json()) as typeof b;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (!b || typeof b !== "object") throw new HttpError(422, 'send {"state": "triaged", "note": "..."}');
  const r = await changeReport(c.env.DB, (e) => c.get("dir").audit(e), me, c.req.param("id"), b.state, b.note, "api");
  return c.json(reportJson(c.env, r));
});
