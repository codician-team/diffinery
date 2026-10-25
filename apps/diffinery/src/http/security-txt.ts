import { Hono } from "hono";
import type { AppVars } from "../auth/principal.js";
import type { Env } from "../env.js";

/**
 * /.well-known/security.txt (RFC 9116): where to report a vulnerability in this instance. The
 * first contact is always the instance's own private report form, /security/report
 * (web/security-reports.tsx), so the file is served without an email address; any entries of
 * SECURITY_CONTACT follow it. Expires is a year from the request, so the file never goes stale.
 */

/** How far ahead Expires is (RFC 9116 recommends less than a year). */
export const EXPIRES_DAYS = 360;

/** One Contact URI per entry of SECURITY_CONTACT: email addresses become mailto: URIs; https URLs stay as they are. */
export function contactUris(v: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (v ?? "").split(",")) {
    const s = raw.trim();
    if (!s) continue;
    if (/^mailto:[^\s@]+@[^\s@]+$/i.test(s) || /^https:\/\/\S+$/i.test(s) || /^tel:\+?[\d-]+$/i.test(s)) out.push(s);
    else if (/^[^\s@:/]+@[^\s@/]+\.[^\s@/]+$/.test(s)) out.push(`mailto:${s}`);
  }
  return out;
}

/** The private report form's URL: the first Contact. */
export const reportUrl = (publicUrl: string): string => `${new URL(publicUrl).origin}/security/report`;

/** The file's text. */
export function securityTxt(env: Pick<Env, "PUBLIC_URL" | "SECURITY_CONTACT">, nowMs = Date.now()): string {
  const base = new URL(env.PUBLIC_URL).origin;
  const form = reportUrl(env.PUBLIC_URL);
  const contacts = [form, ...contactUris(env.SECURITY_CONTACT).filter((c) => c !== form)];
  const expires = new Date(nowMs + EXPIRES_DAYS * 86400_000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    ...contacts.map((c) => `Contact: ${c}`),
    `Expires: ${expires.toISOString().replace(".000Z", "Z")}`,
    `Policy: ${base}/docs/security/disclosure`,
    "Preferred-Languages: en",
    `Canonical: ${base}/.well-known/security.txt`,
    "",
  ].join("\n");
}

export const securityTxtRoutes = new Hono<{ Bindings: Env; Variables: AppVars }>();

securityTxtRoutes.get("/.well-known/security.txt", (c) => c.body(securityTxt(c.env), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" }));
