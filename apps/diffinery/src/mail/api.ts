import { devAuth } from "../auth/dev.js";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, requireAccountScope, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { loadRepo } from "../http/common.js";
import { HttpError, now } from "../lib/util.js";
import { MailStore, isDigestHour, isTimeZone, mergePrefs, type WatchLevel } from "./prefs.js";
import { sampleJobs } from "./samples.js";
import { deliver, senderAddress } from "./send.js";
import { Suppressions } from "./suppression.js";
import { adminSuppress, adminUnsuppress, sendDigestNow, sendTest, sendVerification, suppressionJson } from "./web.js";

/**
 * Email over the REST API: repository watching in GitHub's shape
 * (`/repos/{owner}/{repo}/subscription`), plus Diffinery's own notification
 * settings, email log, test email, whether your address is suppressed and,
 * for site admins, delivery status, the suppression list and "send every
 * template".
 */
export const mailApi = new Hono<{ Bindings: Env; Variables: AppVars }>().basePath("/api/v3");

const user = (c: AppContext): Account => {
  const a = requireAccount(c);
  if (a.kind !== "user") throw new HttpError(403, "only people have notification settings");
  return a;
};

/** Changing settings needs a browser session or a write (or admin) token. */
const writer = (c: AppContext): Account => {
  const a = user(c);
  const p = c.get("principal");
  if (p.type === "account" && p.via === "token" && !p.scopes.some((s) => s === "write" || s === "admin")) throw new HttpError(403, "this needs a write or admin token");
  return a;
};

const siteAdmin = (c: AppContext, scope: "read" | "admin"): Account => {
  const a = user(c);
  if (!a.site_admin) throw new HttpError(403, "site administrators only");
  const p = c.get("principal");
  if (scope === "admin" && p.type === "account" && p.via === "token" && !p.scopes.includes("admin")) throw new HttpError(403, "this needs an admin token");
  return a;
};

async function json<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

const subscriptionJson = (c: AppContext, owner: string, name: string, level: WatchLevel) => ({
  subscribed: level === "all",
  ignored: level === "ignore",
  reason: null,
  created_at: null,
  url: `${c.env.PUBLIC_URL}/api/v3/repos/${owner}/${name}/subscription`,
  repository_url: `${c.env.PUBLIC_URL}/api/v3/repos/${owner}/${name}`,
});

// GitHub: 404 when you have not watched or ignored the repository.
mailApi.get("/repos/:owner/:repo/subscription", async (c) => {
  const me = user(c);
  const l = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "read");
  const level = await new MailStore(c.env.DB).watchLevel(me.id, l.repo.id);
  if (level === "participating") throw new HttpError(404, "not subscribed");
  return c.json(subscriptionJson(c, l.repo.owner_login, l.repo.name, level));
});

mailApi.put("/repos/:owner/:repo/subscription", async (c) => {
  const me = writer(c);
  const l = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "read", { whileArchived: true, whileImporting: true });
  const b = await json<{ subscribed?: boolean; ignored?: boolean }>(c);
  const level: WatchLevel = b.ignored ? "ignore" : b.subscribed === false ? "participating" : "all";
  await new MailStore(c.env.DB).setWatch(me.id, l.repo.id, level);
  return c.json(subscriptionJson(c, l.repo.owner_login, l.repo.name, level));
});

mailApi.delete("/repos/:owner/:repo/subscription", async (c) => {
  const me = writer(c);
  const l = await loadRepo(c, c.req.param("owner"), c.req.param("repo"), "read", { whileArchived: true, whileImporting: true });
  await new MailStore(c.env.DB).setWatch(me.id, l.repo.id, "participating");
  return c.body(null, 204);
});

mailApi.get("/diffinery/notification-settings", async (c) => c.json(await new MailStore(c.env.DB).prefs(user(c).id)));

/** Partial update: send only the groups to change. */
mailApi.put("/diffinery/notification-settings", async (c) => {
  requireAccountScope(c, "write");
  const me = writer(c);
  const store = new MailStore(c.env.DB);
  const cur = await store.prefs(me.id);
  const b = await json<Record<string, unknown>>(c);
  const merged: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(b)) {
    const base = (cur as unknown as Record<string, unknown>)[k];
    if (base === undefined) throw new HttpError(422, `unknown setting ${k}`);
    merged[k] = base && typeof base === "object" && v && typeof v === "object" ? { ...base, ...v } : v;
  }
  // mergePrefs drops what it doesn't know; say so instead of saving something else.
  const d = b.digest as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    if ("hour" in d && !isDigestHour(d.hour)) throw new HttpError(422, "digest.hour must be a whole number from 0 to 23");
    if ("timeZone" in d && !isTimeZone(d.timeZone)) throw new HttpError(422, "digest.timeZone must be an IANA time zone, such as Europe/Istanbul or UTC");
  }
  const next = mergePrefs(merged);
  await store.setPrefs(me.id, next);
  return c.json(next);
});

/** Your recent emails; site admins can pass ?all=1 for everyone's. */
mailApi.get("/diffinery/emails", async (c) => {
  const me = user(c);
  const all = c.req.query("all") === "1";
  if (all && !me.site_admin) throw new HttpError(403, "site administrators only");
  const rows = await new MailStore(c.env.DB).recent({
    accountId: all ? undefined : me.id,
    kind: c.req.query("kind") || undefined,
    since: c.req.query("since") || undefined,
    limit: Number(c.req.query("per_page") ?? 50) || 50,
  });
  // The full message is kept only in local development, for tests.
  return c.json(rows.map((r) => ({ ...r, dev_copy: devAuth(c.env, c.req.url) && r.dev_copy ? JSON.parse(r.dev_copy) : undefined })));
});

/** Send yourself a test email right away; returns what Cloudflare said. */
mailApi.post("/diffinery/emails/test", async (c) => {
  requireAccountScope(c, "write");
  const me = writer(c);
  return c.json(await sendTest(c, me));
});

/** Your morning digest, now (digest.ts): sent even when it has nothing in it or is turned off. */
mailApi.post("/diffinery/emails/digest", async (c) => {
  requireAccountScope(c, "write");
  const me = writer(c);
  return c.json(await sendDigestNow(c, me));
});

/** Your address, and whether it is on the suppression list (suppression.ts). */
mailApi.get("/diffinery/email", async (c) => {
  const me = user(c);
  const s = me.email ? await new Suppressions(c.env.DB).get(me.email) : null;
  return c.json({ email: me.email ?? null, suppressed: s ? suppressionJson(s) : null });
});

/** Email yourself the link that lifts a bounce or complaint on your address. */
mailApi.post("/diffinery/email/verification", async (c) => {
  requireAccountScope(c, "write");
  const me = writer(c);
  return c.json(await sendVerification(c, me));
});

mailApi.get("/diffinery/admin/email/suppressions", async (c) => {
  siteAdmin(c, "read");
  return c.json((await new Suppressions(c.env.DB).list()).map(suppressionJson));
});

mailApi.put("/diffinery/admin/email/suppressions/:email", async (c) => {
  requireAccountScope(c, "admin");
  const me = siteAdmin(c, "admin");
  const b = await json<{ note?: unknown }>(c).catch(() => ({}) as { note?: unknown });
  return c.json(suppressionJson(await adminSuppress(c, me, c.req.param("email"), typeof b.note === "string" ? b.note.trim() : "")));
});

mailApi.delete("/diffinery/admin/email/suppressions/:email", async (c) => {
  requireAccountScope(c, "admin");
  const me = siteAdmin(c, "admin");
  await adminUnsuppress(c, me, c.req.param("email"));
  return c.body(null, 204);
});

mailApi.get("/diffinery/admin/email", async (c) => {
  siteAdmin(c, "read");
  const store = new MailStore(c.env.DB);
  const [day, last] = await Promise.all([store.counts(new Date(Date.now() - 86400_000).toISOString()), store.recent({ limit: 1 })]);
  return c.json({ sending: !!c.env.EMAIL, queue: !!c.env.MAIL, from: senderAddress(c.env), event_intake: !!c.env.MAIL_EVENTS_SECRET, last_24h: day, last: last[0] ? { ...last[0], dev_copy: undefined } : null });
});

/**
 * Send every template (or `only` some) to yourself now, ignoring your
 * notification settings, and return each result with Cloudflare's message id.
 */
mailApi.post("/diffinery/admin/emails/samples", async (c) => {
  requireAccountScope(c, "admin");
  const me = siteAdmin(c, "admin");
  const b = await json<{ only?: string[] }>(c).catch(() => ({}) as { only?: string[] });
  const samples = sampleJobs(c.env.PUBLIC_URL, { accountId: me.id }, me.login).filter((s) => !b.only?.length || b.only.includes(s.id));
  const results = [];
  for (const s of samples) {
    const r = await deliver(c.env, { ...s.job, force: true }).catch((e: Error) => ({ status: "failed" as const, detail: e.message, messageId: undefined }));
    results.push({ id: s.id, label: s.label, ...r });
  }
  return c.json({ to: me.email, sent: results.filter((r) => r.status === "sent").length, total: results.length, results });
});
