import { getCookie, setCookie } from "hono/cookie";
import { credentialFrom, type AppContext } from "../auth/principal.js";
import { HttpError, randomToken, safeEqual } from "../lib/util.js";

/**
 * Double-submit cookie CSRF protection for the web UI. Every rendered page
 * ensures a random `dfy_csrf` cookie (HttpOnly, SameSite=Strict, Secure) and
 * every form carries the same value in a hidden `_csrf` field.
 */
export const CSRF_COOKIE = "dfy_csrf";
export const CSRF_FIELD = "_csrf";

const memo = new WeakMap<Request, string>();
const VALID = /^[A-Za-z0-9_-]{20,64}$/;

/** The CSRF token for this request; sets the cookie when the browser has none. */
export function csrfToken(c: AppContext): string {
  const cached = memo.get(c.req.raw);
  if (cached) return cached;
  let token = getCookie(c, CSRF_COOKIE);
  if (!token || !VALID.test(token)) {
    token = randomToken(24);
    setCookie(c, CSRF_COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "Strict", maxAge: 60 * 60 * 24 * 30 });
  }
  memo.set(c.req.raw, token);
  return token;
}

export interface FormData {
  /** First string value of a field ("" when absent). */
  s(name: string): string;
  /** All string values of a (repeated) field. */
  all(name: string): string[];
  /** Checkbox semantics: present and not "false"/"0". */
  b(name: string): boolean;
  /** Field names present in the form. */
  keys(): string[];
  /** An uploaded file (multipart forms); null when the field is missing or empty. */
  file(name: string): File | null;
}

/** Form bodies bigger than this are refused before they are read (routes taking files pass a larger cap). */
export const MAX_FORM_BYTES = 10 * 1024 * 1024;

/**
 * Refuse a body over `maxBytes` before anything buffers it. Browsers always
 * send Content-Length with a form, so a body without one is refused too.
 */
export function checkFormSize(c: AppContext, maxBytes = MAX_FORM_BYTES): void {
  const len = c.req.header("content-length");
  if (len === undefined || !/^\d+$/.test(len)) {
    if (c.req.raw.body === null) return;
    throw new HttpError(411, "send the form with a Content-Length header");
  }
  if (Number(len) > maxBytes) throw new HttpError(413, `the form is too large (the limit is ${Math.floor(maxBytes / 1024 / 1024)} MB)`);
}

/** Parse an urlencoded/multipart form once per request (Hono caches the body). */
export async function formData(c: AppContext, maxBytes = MAX_FORM_BYTES): Promise<FormData> {
  checkFormSize(c, maxBytes);
  const raw = (await c.req.parseBody({ all: true })) as Record<string, string | File | Array<string | File>>;
  const all = (name: string): string[] => {
    const v = raw[name];
    const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
    return list.filter((x): x is string => typeof x === "string");
  };
  return {
    s: (name) => all(name)[0] ?? "",
    all,
    b: (name) => {
      const v = all(name)[0];
      return v !== undefined && v !== "" && v !== "false" && v !== "0" && v !== "off";
    },
    keys: () => Object.keys(raw),
    file: (name) => {
      const v = raw[name];
      const f = (Array.isArray(v) ? v : [v]).find((x): x is File => typeof x === "object" && x !== null && typeof (x as File).arrayBuffer === "function");
      return f && f.size > 0 ? f : null;
    },
  };
}

/** Reject state-changing requests without a matching token (and cross-origin requests). */
export async function verifyCsrf(c: AppContext, maxBytes = MAX_FORM_BYTES): Promise<FormData> {
  // Web forms are for people in a browser. A token (personal, agent, job or sandbox) uses the API,
  // where its scope and repository limits apply; here it could forge the double-submit cookie.
  if (credentialFrom(c.req.raw)) throw new HttpError(403, "web forms need a browser session; use the API with a token");
  const origin = c.req.header("origin");
  if (origin && origin !== "null") {
    const self = new URL(c.req.url).origin;
    const pub = c.env.PUBLIC_URL ? new URL(c.env.PUBLIC_URL).origin : null;
    if (origin !== self && origin !== pub) throw new HttpError(403, "cross-origin form submission rejected");
  }
  const type = c.req.header("content-type") ?? "";
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(type)) throw new HttpError(415, "expected a form submission");
  const form = await formData(c, maxBytes);
  const cookie = getCookie(c, CSRF_COOKIE);
  const sent = form.s(CSRF_FIELD);
  if (!cookie || !sent || !safeEqual(cookie, sent)) throw new HttpError(403, "your session token expired or is missing; reload the page and try again");
  return form;
}
