import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, requireAccountScope, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { ContactMessages, MESSAGE_STATES, changeMessage, deleteMessage, messageJson, type MessageState } from "../lib/contact.js";
import { HttpError } from "../lib/util.js";

/**
 * Contact messages over the REST API (lib/contact.ts), for site administrators only.
 * To anyone else these endpoints don't exist (404), like the messages themselves.
 */
export const contactApi = new Hono<{ Bindings: Env; Variables: AppVars }>().basePath("/api/v3");

const siteAdmin = (c: AppContext, scope: "read" | "admin"): Account => {
  const a = requireAccount(c);
  if (!a.site_admin || a.kind !== "user") throw new HttpError(404, "not found");
  requireAccountScope(c, scope);
  return a;
};

const audit = (c: AppContext) => (e: Parameters<AppContext["var"]["dir"]["audit"]>[0]) => c.get("dir").audit(e);

contactApi.get("/diffinery/admin/contact", async (c) => {
  siteAdmin(c, "read");
  const s = c.req.query("state");
  if (s && !MESSAGE_STATES.includes(s as MessageState)) throw new HttpError(422, `state must be one of ${MESSAGE_STATES.join(", ")}`);
  const n = Number(c.req.query("per_page") ?? 100);
  const page = Math.max(1, Math.min(1000, Number(c.req.query("page") ?? 1) || 1));
  const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 500) : 100;
  const { items } = await new ContactMessages(c.env.DB).list({ state: (s as MessageState) || undefined, q: c.req.query("q") ?? "", limit, offset: (page - 1) * limit });
  return c.json(items.map((m) => messageJson(c.env, m)));
});

contactApi.get("/diffinery/admin/contact/:id", async (c) => {
  siteAdmin(c, "read");
  const m = await new ContactMessages(c.env.DB).get(c.req.param("id"));
  if (!m) throw new HttpError(404, "no contact message with that id");
  return c.json(messageJson(c.env, m));
});

/** Mark a message handled or spam, reopen it (`{"state": "new"}`), or set its note. Audited; nobody is emailed. */
contactApi.patch("/diffinery/admin/contact/:id", async (c) => {
  const me = siteAdmin(c, "admin");
  let b: { state?: unknown; note?: unknown };
  try {
    b = (await c.req.json()) as typeof b;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  if (!b || typeof b !== "object") throw new HttpError(422, 'send {"state": "handled"}, "spam" or "new", a "note", or both');
  return c.json(messageJson(c.env, await changeMessage(c.env.DB, audit(c), me, c.req.param("id"), { state: b.state, note: b.note }, "api")));
});

/** Delete a message (data removal). Audited without its content. */
contactApi.delete("/diffinery/admin/contact/:id", async (c) => {
  const me = siteAdmin(c, "admin");
  await deleteMessage(c.env.DB, audit(c), me, c.req.param("id"), "api");
  return c.body(null, 204);
});
