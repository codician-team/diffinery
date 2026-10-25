import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireAccount, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { AVATAR_SIZES, MAX_AVATAR_BYTES, makeAvatarImages, type AvatarSize } from "../lib/image.js";
import { HttpError, isValidName } from "../lib/util.js";

/**
 * Profile pictures for people, organizations and agents.
 *
 *   GET    /api/avatars/:login?s=64|128|256[&v=<version>]   the picture (WebP) or generated initials (SVG)
 *   PUT    /api/v3/user/avatar        raw image body          (Diffinery extension)
 *   DELETE /api/v3/user/avatar
 *   PUT    /api/v3/orgs/:org/avatar   org owners
 *   DELETE /api/v3/orgs/:org/avatar
 *
 * Uploads become square WebPs in R2 at avatars/<account id>/<version>/<size>.webp, and
 * accounts.avatar_version points at the current set (NULL: initials). Every upload gets a new
 * version, so `?v=` URLs are immutable; the old version's files are deleted.
 */
export const avatars = new Hono<{ Bindings: Env; Variables: AppVars }>();

// ---------------------------------------------------------------- helpers shared with the web UI

/** Stable hue for a login's initials avatar. */
export function avatarHue(login: string): number {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return h % 360;
}

export const avatarInitial = (login: string): string => (login.replace(/[^A-Za-z0-9]/g, "")[0] ?? "?").toUpperCase();

/** The stored size for a requested pixel size: the smallest one at least that big. */
export function avatarSize(px: number): AvatarSize {
  return AVATAR_SIZES.find((s) => px <= s) ?? AVATAR_SIZES[AVATAR_SIZES.length - 1]!;
}

/** Path of a login's avatar image; pass the account's avatar_version so a new upload shows at once. */
export function avatarPath(login: string, size?: number, version?: number | null): string {
  const q = new URLSearchParams();
  if (size && size !== 128) q.set("s", String(avatarSize(size)));
  if (version) q.set("v", String(version));
  const qs = q.toString();
  return `/api/avatars/${encodeURIComponent(login)}${qs ? `?${qs}` : ""}`;
}

export const avatarUrl = (c: AppContext, login: string, version?: number | null): string => `${c.env.PUBLIC_URL.replace(/\/$/, "")}${avatarPath(login, undefined, version)}`;

/** The initials avatar as a square SVG, matching the `.av` look (font size as at 20, 40 and 96 CSS px). */
export function initialsSvg(login: string, size: AvatarSize): string {
  const font = size <= 64 ? 55 : size <= 128 ? 45 : 42;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="hsl(${avatarHue(login)},55%,55%)"/>` +
    `<text x="50" y="50" dy=".35em" text-anchor="middle" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue','Noto Sans',Arial,sans-serif" font-size="${font}" font-weight="700">${avatarInitial(login)}</text>` +
    `</svg>`
  );
}

const objectKey = (accountId: string, version: number, size: AvatarSize) => `avatars/${accountId}/${version}/${size}.webp`;

const SHORT = "public, max-age=600, stale-while-revalidate=86400";
const IMMUTABLE = "public, max-age=86400, immutable";
/** What the Cache API keeps: short, because a purge only reaches the colo it runs in. */
const EDGE = "public, max-age=600";

const edgeCache = (): Cache | null => (typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default);

function cacheKey(origin: string, login: string, size: AvatarSize, version: number | null): Request {
  return new Request(`${origin}/api/avatars/${encodeURIComponent(login)}?s=${size}${version ? `&v=${version}` : ""}`);
}

const origin = (c: AppContext) => new URL(c.req.url).origin;

/** Forget cached copies of a login's avatar (every size, without `v` and with each given version). */
export async function purgeAvatarCache(c: AppContext, login: string, versions: Array<number | null | undefined>): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  const vs = [null, ...new Set(versions.filter((v): v is number => !!v))];
  await Promise.all(AVATAR_SIZES.flatMap((s) => vs.map((v) => cache.delete(cacheKey(origin(c), login, s, v)).catch(() => false))));
}

/** Delete every stored file of an account's avatars except the version to keep. */
async function deleteStored(env: Env, accountId: string, keep: number | null): Promise<void> {
  const prefix = `avatars/${accountId}/`;
  const listed = await env.BUCKET.list({ prefix, limit: 1000 });
  const stale = listed.objects.map((o) => o.key).filter((k) => keep === null || !k.startsWith(`${prefix}${keep}/`));
  if (stale.length) await env.BUCKET.delete(stale);
}

/** Store a new picture for an account (a user, an org or an agent) and return its version. */
export async function setAvatar(c: AppContext, account: Account, bytes: Uint8Array): Promise<number> {
  const images = await makeAvatarImages(bytes);
  const version = Math.max((account.avatar_version ?? 0) + 1, Math.floor(Date.now() / 1000));
  await Promise.all([...images].map(([size, webp]) => c.env.BUCKET.put(objectKey(account.id, version, size), webp, { httpMetadata: { contentType: "image/webp", cacheControl: IMMUTABLE } })));
  await c.get("dir").setAvatarVersion(account.id, version);
  await Promise.all([purgeAvatarCache(c, account.login, [account.avatar_version, version]), deleteStored(c.env, account.id, version)]);
  return version;
}

/** Go back to initials. */
export async function removeAvatar(c: AppContext, account: Account): Promise<void> {
  await c.get("dir").setAvatarVersion(account.id, null);
  await Promise.all([purgeAvatarCache(c, account.login, [account.avatar_version]), deleteStored(c.env, account.id, null)]);
}

/** Read a request body, refusing more than `limit` bytes without buffering them. */
async function readLimited(req: Request, limit: number): Promise<Uint8Array> {
  const tooBig = () => new HttpError(413, "That picture is larger than 5 MB. Use a smaller file.");
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw tooBig();
  if (!req.body) throw new HttpError(422, "Send the picture as the request body.");
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------- GET /api/avatars/:login

avatars.get("/api/avatars/:login", async (c) => {
  const login = c.req.param("login");
  const size = avatarSize(Number(c.req.query("s")) || 128);
  const v = /^\d{1,15}$/.test(c.req.query("v") ?? "") ? Number(c.req.query("v")) : null;
  const cache = edgeCache();
  const key = cacheKey(origin(c), login, size, v);
  const hit = await cache?.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("cache-control", v ? IMMUTABLE : SHORT);
    return res;
  }

  // Unknown logins get initials too, so the route does not tell who exists.
  const account = isValidName(login) ? await c.get("dir").accountByLogin(login) : null;
  const current = account?.avatar_version ?? null;
  const obj = account && current ? await c.env.BUCKET.get(objectKey(account.id, current, size)) : null;
  const headers = new Headers({ "x-content-type-options": "nosniff" });
  let body: ArrayBuffer | string;
  if (obj) {
    body = await obj.arrayBuffer();
    headers.set("content-type", "image/webp");
  } else {
    body = initialsSvg(login, size);
    headers.set("content-type", "image/svg+xml; charset=utf-8");
    headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  }
  // A `v` that is not the current version (an old link, or a guess) is served but neither cached here nor marked immutable.
  const versioned = v !== null && v === current;
  if (v === null || versioned) {
    const stored = new Response(body, { headers });
    stored.headers.set("cache-control", EDGE);
    c.executionCtx.waitUntil(cache?.put(key, stored).catch(() => {}) ?? Promise.resolve());
  }
  headers.set("cache-control", versioned ? IMMUTABLE : SHORT);
  return new Response(body, { headers });
});

// ---------------------------------------------------------------- REST

/** Only full-account credentials change a profile: browser sessions, or tokens with write or admin scope for all repositories. */
function requireProfileWrite(c: AppContext): Account {
  const me = requireAccount(c);
  const p = c.get("principal");
  if (p.type === "account" && p.via === "token" && (p.repoIds || !p.scopes.some((s) => s === "write" || s === "admin"))) {
    throw new HttpError(403, "changing a profile picture needs a write or admin token that is not limited to repositories");
  }
  return me;
}

async function orgForAvatar(c: AppContext, me: Account): Promise<Account> {
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org") ?? "");
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, me.id);
  if (!role && !me.site_admin) throw new HttpError(404, "not found");
  // Like the organization's name, its picture is the owners' to change (the web settings page agrees).
  if (role !== "owner" && !me.site_admin) throw new HttpError(403, "only organization owners can change its picture");
  return org;
}

function audit(c: AppContext, me: Account, action: "avatar.update" | "avatar.remove", target: Account): void {
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action, target: target.login, detail: { kind: target.kind, via: "api" } }));
}

avatars.put("/api/v3/user/avatar", async (c) => {
  const me = requireProfileWrite(c);
  const version = await setAvatar(c, me, await readLimited(c.req.raw, MAX_AVATAR_BYTES));
  audit(c, me, "avatar.update", me);
  return c.json({ avatar_url: avatarUrl(c, me.login, version) });
});

avatars.delete("/api/v3/user/avatar", async (c) => {
  const me = requireProfileWrite(c);
  await removeAvatar(c, me);
  audit(c, me, "avatar.remove", me);
  return c.json({ avatar_url: avatarUrl(c, me.login) });
});

avatars.put("/api/v3/orgs/:org/avatar", async (c) => {
  const me = requireProfileWrite(c);
  const org = await orgForAvatar(c, me);
  const version = await setAvatar(c, org, await readLimited(c.req.raw, MAX_AVATAR_BYTES));
  audit(c, me, "avatar.update", org);
  return c.json({ avatar_url: avatarUrl(c, org.login, version) });
});

avatars.delete("/api/v3/orgs/:org/avatar", async (c) => {
  const me = requireProfileWrite(c);
  const org = await orgForAvatar(c, me);
  await removeAvatar(c, org);
  audit(c, me, "avatar.remove", org);
  return c.json({ avatar_url: avatarUrl(c, org.login) });
});
