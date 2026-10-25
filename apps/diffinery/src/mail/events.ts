import { Hono } from "hono";
import type { AppVars } from "../auth/principal.js";
import type { Env } from "../env.js";
import { Directory } from "../lib/directory.js";
import { SIGNATURE_HEADER, checkSignature, recordMailEvents } from "./suppression.js";

/**
 * Bounce and complaint intake, two ways in:
 *
 * - The `diffinery-mail-events` queue, which Cloudflare Email Sending's Event Subscriptions
 *   publish to. Only Cloudflare can put messages there, so they need no signature.
 * - POST /-/email/events, for anything else that can relay events in the same shape. It is off
 *   (404) until MAIL_EVENTS_SECRET is set, and refuses any request without a good, recent
 *   signature (see checkSignature in suppression.ts).
 */

/** Largest signed intake body, in bytes. */
export const MAX_EVENTS_BODY = 1 << 20;

export const mailEvents = new Hono<{ Bindings: Env; Variables: AppVars }>();

mailEvents.post("/-/email/events", async (c) => {
  const secret = c.env.MAIL_EVENTS_SECRET;
  if (!secret) return c.json({ message: "email event intake is off: MAIL_EVENTS_SECRET is not set" }, 404);
  if (Number(c.req.header("content-length") ?? 0) > MAX_EVENTS_BODY) return c.json({ message: "body too large" }, 413);
  const body = await c.req.text();
  if (body.length > MAX_EVENTS_BODY) return c.json({ message: "body too large" }, 413);
  if (!(await checkSignature(secret, c.req.header(SIGNATURE_HEADER), body))) return c.json({ message: "missing or bad signature" }, 401);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return c.json({ message: "body must be JSON" }, 400);
  }
  // One event, an array of them, or {"events": [...]}.
  const events = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events) ? (parsed as { events: unknown[] }).events : [parsed];
  if (events.length > 1000) return c.json({ message: "at most 1000 events at a time" }, 413);
  const dir = c.get("dir");
  const r = await recordMailEvents(c.env.DB, (e) => dir.audit(e), events, "webhook");
  return c.json({ suppressed: r.suppressed.length, ignored: r.ignored });
});

/** Queue consumer for `diffinery-mail-events` (Cloudflare Email Sending's Event Subscriptions). */
export async function mailEventsQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const dir = new Directory(env);
  for (const msg of batch.messages) {
    try {
      await recordMailEvents(env.DB, (e) => dir.audit(e), [msg.body], "cloudflare");
      msg.ack();
    } catch (e) {
      console.error("email event handling failed", e);
      msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** msg.attempts) });
    }
  }
}
