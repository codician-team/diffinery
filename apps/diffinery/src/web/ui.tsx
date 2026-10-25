/** @jsxImportSource hono/jsx */
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { tryGetContext } from "hono/context-storage";
import { html, raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { Account, Repo } from "../lib/directory.js";
import type { Env } from "../env.js";
import type { AppContext, AppVars } from "../auth/principal.js";
import { HttpError, randomToken } from "../lib/util.js";
import { atLeast, type Caller } from "../repo/types.js";
import { noteServerError, RepoMoved, watchLevelOnce, type repoStub } from "../http/common.js";
import { CSS, ICONS, JS, type IconName } from "./assets.js";
import { CSRF_FIELD, csrfToken, verifyCsrf, type FormData } from "./csrf.js";
import { fenceLangs, renderMarkdown, type MarkdownBase } from "./markdown.js";
import { diffLineTokens, fenceHighlighter, langForPath, LIMITS, ready, tokenize, type Lang, type TokLine } from "./highlight.js";
import { KSelect, kumoAssets } from "./kumo.js";
import type { WatchLevel } from "../mail/prefs.js";
import { MoreMenu, ReportItem } from "./moderation.js";
import { SeoHead, SITE } from "./seo.js";
import { avatarPath } from "../http/avatars.js";
import { TURNSTILE_ORIGIN, TURNSTILE_SCRIPT } from "../auth/signup.js";
import { imageProxy } from "../lib/camo.js";

export type WebApp = Hono<{ Bindings: Env; Variables: AppVars }>;
export type Stub = ReturnType<typeof repoStub>;

// ---------------------------------------------------------------- small helpers

export const encPath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");
export const repoUrl = (r: Pick<Repo, "owner_login" | "name">): string => `/${r.owner_login}/${r.name}`;
export const shortSha = (sha: string): string => sha.slice(0, 7);
export const firstLine = (s: string): string => s.split("\n")[0] ?? "";

export function publicUrl(c: AppContext): string {
  return (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, "");
}

export function cloneUrl(c: AppContext, repo: Repo): string {
  return `${publicUrl(c)}/${repo.owner_login}/${repo.name}.git`;
}

export function fmtBytes(n: number | undefined | null): string {
  if (n === undefined || n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return "";
  return fmtDuration((end ? Date.parse(end) : Date.now()) - Date.parse(start));
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export const Time: FC<{ at: string | null | undefined }> = ({ at }) => (at ? <time datetime={at} title={at}>{ago(at)}</time> : <span />);

export const Icon: FC<{ name: IconName; class?: string }> = ({ name, class: cls }) => <span class={`st ${cls ?? ""}`}>{raw(ICONS[name])}</span>;

/** Status icon for runs, jobs, checks and steps. */
export const Status: FC<{ status?: string | null; conclusion?: string | null }> = ({ status, conclusion }) => {
  if (status && status !== "completed") {
    if (status === "in_progress") return <span class="st spin run" title="In progress">{raw(ICONS.running)}</span>;
    return <span class="st warn" title={status === "approval" ? "Waiting for approval" : status === "waiting" ? "Waiting" : status === "pending" ? "Pending" : "Queued"}>{raw(ICONS.queued)}</span>;
  }
  switch (conclusion) {
    case "success":
      return <span class="st ok" title="Success">{raw(ICONS.success)}</span>;
    case "failure":
    case "timed_out":
    case "startup_failure":
      return <span class="st bad" title={conclusion === "timed_out" ? "Timed out" : "Failed"}>{raw(ICONS.failure)}</span>;
    case "cancelled":
      return <span class="st faint" title="Cancelled">{raw(ICONS.cancelled)}</span>;
    case "skipped":
      return <span class="st faint" title="Skipped">{raw(ICONS.skipped)}</span>;
    case "in_progress":
      return <span class="st spin run" title="In progress">{raw(ICONS.running)}</span>;
    case "queued":
    case "waiting":
    case "pending":
      return <span class="st warn" title="Queued">{raw(ICONS.queued)}</span>;
    default:
      return <span class="st faint" title={conclusion ?? "Neutral"}>{raw(ICONS.neutral)}</span>;
  }
};

/** CSS pixels of each avatar size, and the stored square (2×) served for it. */
const AVATAR_PX = { sm: [20, 64], lg: [40, 128], xl: [96, 256] } as const;

/** Profile picture, or generated initials. Pass the account's avatar_version when it is at hand, so a new upload shows at once. */
export const Avatar: FC<{ login: string; kind?: string; size?: "lg" | "xl"; version?: number | null }> = ({ login, kind, size, version }) => {
  const [css, px] = AVATAR_PX[size ?? "sm"];
  return <img class={`av ${size ?? ""} ${kind === "agent" || kind === "system" ? "bot" : ""}`} src={avatarPath(login, px, version)} width={css} height={css} alt="" loading="lazy" decoding="async" />;
};

/**
 * Linked actor name with an "agent" badge and the human it acts for. People imported from
 * GitHub without a Diffinery account (kind "github", or logins stored as "github:<login>")
 * are shown with a "GitHub" badge and no link.
 */
export const Actor: FC<{ login: string; kind?: string; onBehalfOf?: string | null; avatar?: boolean; version?: number | null }> = ({ login, kind, onBehalfOf, avatar = true, version }) =>
  kind === "github" || login.startsWith("github:") ? (
    <span class="who" title="Imported from GitHub; not linked to a Diffinery account">
      {avatar ? <Avatar login={login.replace(/^github:/, "")} /> : null}
      <span>{login.replace(/^github:/, "")}</span>
      <span class="badge">GitHub</span>
    </span>
  ) : (
  <span class="who">
    {avatar ? <Avatar login={login} kind={kind} version={version} /> : null}
    {kind === "system" ? <span>{login}</span> : <a href={`/${encodeURIComponent(login)}`} style="color:inherit">{login}</a>}
    {kind === "agent" ? <span class="badge agent">agent</span> : null}
    {kind === "system" ? <span class="badge">bot</span> : null}
    {onBehalfOf ? (
      <span class="muted small" style="font-weight:400">
        on behalf of <a href={`/${encodeURIComponent(onBehalfOf)}`}>{onBehalfOf}</a>
      </span>
    ) : null}
  </span>
);

export const Label: FC<{ name: string; color?: string; href?: string }> = ({ name, color, href }) => {
  const c = color && /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : "#8b929c";
  return href ? (
    <a class="lbl" style={`--lc:${c}`} href={href}>
      {name}
    </a>
  ) : (
    <span class="lbl" style={`--lc:${c}`}>{name}</span>
  );
};

/**
 * User-written Markdown. Images from other sites go through Diffinery's image proxy (lib/camo.ts),
 * so they can't learn who reads the page; outside a request (no settings to sign with) they show
 * as their alt text.
 */
export const Markdown: FC<{ text: string; base?: MarkdownBase; empty?: string }> = async ({ text, base, empty }) =>
  text.trim() ? (
    <div class="markdown">{raw(renderMarkdown(text, { base, highlight: await fenceHighlighter(fenceLangs(text)), image: imageProxy(tryGetContext<{ Bindings: Env }>()?.env) }))}</div>
  ) : (
    <p class="muted m0">
      <em>{empty ?? "No description provided."}</em>
    </p>
  );

/** Highlighted code tokens (children of an element with class "sh"). */
export const tokens = (line: TokLine): Child[] => line.map((t) => (t.style ? <span style={t.style}>{t.text}</span> : t.text));

/** CSRF-protected POST form. `avatar` makes it a multipart picture upload (shrunk in the browser first, see assets.ts). */
export const Form: FC<PropsWithChildren<{ action: string; t: string; class?: string; confirm?: string; match?: string; id?: string; style?: string; avatar?: boolean }>> = (p) => (
  <form method="post" action={p.action} class={p.class} data-confirm={p.confirm} data-match={p.match} id={p.id} style={p.style} enctype={p.avatar ? "multipart/form-data" : undefined} data-avatar={p.avatar ? "1" : undefined}>
    <input type="hidden" name={CSRF_FIELD} value={p.t} />
    {p.children}
  </form>
);

/** Copy-to-clipboard button: small by default; `size="base"` next to 36px fields, `icon` for an icon-only button. */
export const CopyButton: FC<{ text: string; label?: string; class?: string; size?: "sm" | "base"; icon?: boolean }> = ({ text, label, class: cls, size = "sm", icon }) => (
  <button type="button" class={`btn ${size === "sm" ? "sm" : ""} ${icon ? "icon" : ""} ${cls ?? ""}`} data-copy={text} data-copy-icon={icon ? "1" : undefined} title="Copy to clipboard" aria-label={icon ? "Copy to clipboard" : undefined}>
    {icon ? raw(ICONS.copy) : (label ?? "Copy")}
  </button>
);

export const Pager: FC<{ page: number; hasNext: boolean; href: (page: number) => string }> = ({ page, hasNext, href }) =>
  page > 1 || hasNext ? (
    <div class="pager">
      {page > 1 ? <a class="btn sm" href={href(page - 1)}>← Newer</a> : <span class="btn sm" aria-disabled="true" style="opacity:.4">← Newer</span>}
      <span class="muted small" style="align-self:center">Page {page}</span>
      {hasNext ? <a class="btn sm" href={href(page + 1)}>Older →</a> : <span class="btn sm" aria-disabled="true" style="opacity:.4">Older →</span>}
    </div>
  ) : null;

export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

/** A required route parameter (404 when missing). */
export function prm(c: AppContext, name: string): string {
  const v = c.req.param(name);
  if (!v) throw new HttpError(404, "not found");
  return v;
}

export const pageNum = (c: AppContext): number => Math.max(1, Math.min(1000, parseInt(c.req.query("page") ?? "1", 10) || 1));

// ---------------------------------------------------------------- errors, flash and actions

export function statusOf(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.detail };
  const msg = (e as Error)?.message ?? String(e);
  const m = /^(\d{3}): ([\s\S]*)$/.exec(msg);
  if (m) return { status: Number(m[1]), message: m[2]! };
  return { status: 500, message: "internal error" };
}

const FLASH = "dfy_flash";

export function flash(c: AppContext, kind: "error" | "notice", message: string): void {
  setCookie(c, FLASH, encodeURIComponent(JSON.stringify({ kind, message: message.slice(0, 600) })), { path: "/", httpOnly: true, secure: true, sameSite: "Strict", maxAge: 60 });
}

function takeFlash(c: AppContext): { kind: "error" | "notice"; message: string } | null {
  const v = getCookie(c, FLASH);
  if (!v) return null;
  deleteCookie(c, FLASH, { path: "/", secure: true });
  try {
    const f = JSON.parse(decodeURIComponent(v)) as { kind: string; message: string };
    if (typeof f.message !== "string") return null;
    return { kind: f.kind === "notice" ? "notice" : "error", message: f.message };
  } catch {
    return null;
  }
}

/** Run a state-changing action and redirect (303); client errors become a flash message on `back`. */
/** Where to confirm a sign-in before a sensitive action (see requireRecentSignIn), when `e` asks for that. */
export function confirmUrl(e: unknown): string | null {
  return e instanceof HttpError && typeof e.extra?.confirm === "string" ? e.extra.confirm : null;
}

export async function act(c: AppContext, back: string, fn: () => Promise<string | void>, notice?: string): Promise<Response> {
  try {
    const to = await fn();
    if (notice) flash(c, "notice", notice);
    return c.redirect(to ?? back, 303);
  } catch (e) {
    const confirm = confirmUrl(e);
    if (confirm) return c.redirect(confirm, 303);
    const s = statusOf(e);
    if (s.status >= 500) throw e;
    flash(c, "error", s.message);
    return c.redirect(back, 303);
  }
}

/** Register a CSRF-checked POST route. */
export function post(app: WebApp, path: string, handler: (c: AppContext, form: FormData) => Promise<Response>, opts?: { maxBytes?: number }): void {
  app.post(path, async (c) => handler(c, await verifyCsrf(c, opts?.maxBytes)));
}

export function principalAccount(c: AppContext): Account | null {
  const p = c.get("principal");
  return p?.type === "account" ? p.account : null;
}

// ---------------------------------------------------------------- layout

export interface RepoCtx {
  repo: Repo;
  caller: Caller;
  tab?: "code" | "issues" | "pulls" | "actions" | "project" | "packages" | "settings" | "";
  /** Current ref, used by the palette's "go to file". */
  ref?: string;
  counts?: { issues?: number; pulls?: number };
}

export interface PageOpts {
  title: string;
  repo?: RepoCtx;
  /** WebSocket topics for live updates (e.g. "run:abc,pr:3"). */
  live?: string;
  liveMode?: "reload" | "log";
  lastSeq?: number;
  status?: number;
  /** Full-width page (diffs, logs). */
  wide?: boolean;
  /** Meta description for search results and link previews. */
  description?: string;
  /** The home page: a descriptive title and structured data for search engines. */
  home?: boolean;
  /** The whole <title>, when the page's own wording is better for search results than "<title> · Diffinery". */
  seoTitle?: string;
  /** Structured data (schema.org objects) for search engines and AI assistants. */
  jsonLd?: object[];
  /** An article (comparisons, measurements): its last-checked date goes in the social meta tags. */
  modified?: string;
  /** Extra elements for <head> (e.g. alternate links). */
  head?: Child;
  /** A page script, run after the site's own (it gets the page's CSP nonce). */
  script?: string;
  /** Same-origin script files for this page only (e.g. the web terminal's bundle), loaded with the nonce. */
  scriptSrc?: string[];
  /** Reload the page every this many seconds (progress pages without live updates). */
  refresh?: number;
  /** Load Cloudflare Turnstile (the sign-up page): its script and iframe come from challenges.cloudflare.com. */
  turnstile?: boolean;
  /** Fetch the Kumo islands bundle at low priority on a page without islands, for the pages that follow it (sign-in). */
  prefetchKumo?: boolean;
  /** Another place this page's forms may lead (CSP form-action), e.g. the CLI's loopback callback after approving a sign-in. */
  formAction?: string;
}

export const WATCH_OPTIONS = [
  { value: "participating", label: "Participating and @mentions" },
  { value: "all", label: "All activity" },
  { value: "ignore", label: "Ignore" },
];

/** Watch / unwatch control in the repository header. */
const WatchControl: FC<{ base: string; level: WatchLevel; t: string }> = ({ base, level, t }) => (
  <form method="post" action={`${base}/subscription`} class="inline" title="Which activity in this repository notifies you">
    <input type="hidden" name={CSRF_FIELD} value={t} />
    <KSelect name="level" options={WATCH_OPTIONS.map((o) => ({ value: o.value, label: o.value === "participating" ? "Watch: participating" : o.value === "all" ? "Watch: all activity" : "Watch: ignore" }))} value={level} size="sm" label="Watch" autosubmit />
  </form>
);

const RepoHeader: FC<{ r: RepoCtx; watch?: WatchLevel; t: string }> = ({ r, watch, t }) => {
  const base = repoUrl(r.repo);
  const tab = r.tab ?? "";
  const vis = r.repo.visibility;
  return (
    <div class="repohead">
      <div class="wrap">
        {watch ? (
          <div style="float:right" class="row">
            <WatchControl base={base} level={watch} t={t} />
            <MoreMenu label="Repository actions">
              <ReportItem s={{ kind: "repository", repository: `${r.repo.owner_login}/${r.repo.name}` }} label="Report repository" />
            </MoreMenu>
          </div>
        ) : null}
        <h1>
          <span class="st faint">{raw(vis === "public" ? ICONS.globe : ICONS.lock)}</span>
          <a href={`/${r.repo.owner_login}`}>{r.repo.owner_login}</a>
          <span class="faint">/</span>
          <strong>
            <a href={base}>{r.repo.name}</a>
          </strong>
          <span class="badge">{vis}</span>
          {r.repo.archived ? <span class="badge amber">archived</span> : null}
        </h1>
        {r.repo.description ? <p class="muted m0">{r.repo.description}</p> : null}
        <nav class="tabs">
          <a href={base} class={tab === "code" ? "on" : ""}>
            {raw(ICONS.code)} Code
          </a>
          <a href={`${base}/issues`} class={tab === "issues" ? "on" : ""}>
            {raw(ICONS.issueOpen)} Issues {r.counts?.issues ? <span class="n">{r.counts.issues}</span> : null}
          </a>
          <a href={`${base}/pulls`} class={tab === "pulls" ? "on" : ""}>
            {raw(ICONS.pr)} Pull requests {r.counts?.pulls ? <span class="n">{r.counts.pulls}</span> : null}
          </a>
          <a href={`${base}/actions`} class={tab === "actions" ? "on" : ""}>
            {raw(ICONS.play)} Actions
          </a>
          {atLeast(r.caller.role, "write") ? (
            <a href={`${base}/project`} class={tab === "project" ? "on" : ""}>
              {raw(ICONS.bot)} Project
            </a>
          ) : null}
          <a href={`${base}/packages`} class={tab === "packages" ? "on" : ""}>
            {raw(ICONS.package)} Packages
          </a>
          {atLeast(r.caller.role, "admin") || (atLeast(r.caller.role, "write") && r.caller.kind === "user") ? (
            <a href={atLeast(r.caller.role, "admin") ? `${base}/settings` : `${base}/settings/agent-setup`} class={tab === "settings" ? "on" : ""}>
              {raw(ICONS.gear)} Settings
            </a>
          ) : null}
        </nav>
      </div>
    </div>
  );
};

function csp(nonce: string, c: AppContext, turnstile?: boolean, formAction?: string): string {
  const host = new URL(c.req.url).host;
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
    ...(turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "style-src 'self' 'unsafe-inline'",
    // Images from other sites in Markdown come through the image proxy (/-/camo/, lib/camo.ts), so
    // no page loads one directly. blob: previews a picture before it is uploaded.
    "img-src 'self' data: blob:",
    `connect-src 'self' wss://${host} ws://${host}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action 'self'${formAction ? ` ${formAction}` : ""}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Render a full page. */
export function render(c: AppContext, opts: PageOpts, body: Child): Response | Promise<Response> {
  const p = c.get("principal");
  const me = p?.type === "account" ? p.account : null;
  if (opts.repo && me?.status === "active" && me.kind === "user" && c.env.DB) {
    return watchLevelOnce(c, opts.repo.repo.id)
      .catch(() => "participating" as const)
      .then((w) => renderPage(c, opts, body, w));
  }
  return renderPage(c, opts, body);
}

export type Appearance = "light" | "dark";
export const APPEARANCE_COOKIE = "dfy_theme";

/** The chosen theme, or null to follow the system. Signed-out visitors keep the last choice made in this browser. */
export function appearanceOf(c: AppContext): Appearance | null {
  const p = c.get("principal");
  const v = p?.type === "account" ? p.account.appearance : getCookie(c, APPEARANCE_COOKIE);
  return v === "light" || v === "dark" ? v : null;
}

/** Links to the public site for visitors: every page reachable from every page, for people and crawlers. */
const SiteFooter: FC = () => (
  <div class="wrap foot-main">
    <div class="foot-brand">
      <a class="brand" href="/" aria-label="Diffinery home">
        {raw(ICONS.logo)} <span>Diffinery</span>
      </a>
      <p>
        <strong>{SITE.tagline}.</strong> Open-source repositories, pull requests and GitHub Actions–compatible CI for teams of people and AI agents, on your own Cloudflare account.
      </p>
      <a href="/docs/self-hosting" class="btn sm">
        Deploy your own
      </a>
    </div>
    {[
      { title: "Product", links: [["/features", "Features"], ["/agents", "For AI agents"], ["/performance", "Performance"], ["/security", "Security"], ["/built-on-cloudflare", "Built on Cloudflare"], ["/open-source", "Open source"], ["/docs/migrate-from-github", "Migrate from GitHub"]] },
      { title: "Compare", links: [["/compare", "All comparisons"], ["/compare/github", "vs GitHub"], ["/compare/gitlab", "vs GitLab"], ["/compare/blacksmith", "vs Blacksmith"], ["/compare/depot", "vs Depot"]] },
      { title: "Resources", links: [["/docs", "Docs"], ["/docs/self-hosting", "Self-hosting"], ["/docs/guides", "Guides"], ["/docs/connect", "Connect AI apps"], ["/llms.txt", "llms.txt"], ["/status", "Status"], ["/docs/security/disclosure", "Report a vulnerability"]] },
      { title: "Company", links: [["/about", "About"], ["/faq", "FAQ"], ["/blog", "Blog"], ["https://diffinery.com/codician/diffinery", "Source code"], ["https://github.com/codician-team/diffinery", "GitHub mirror"], ["/privacy", "Privacy"]] },
    ].map((col) => (
      <nav aria-label={col.title}>
        <h2>{col.title}</h2>
        {col.links.map(([href, label]) => (
          <a href={href}>{label}</a>
        ))}
      </nav>
    ))}
  </div>
);

/** Kumo islands' placeholders (kumo.tsx), which the islands bundle mounts. */
const ISLAND = ' data-k="';

async function renderPage(c: AppContext, opts: PageOpts, body: Child, watch?: WatchLevel): Promise<Response> {
  // The body first (it waits for async components such as highlighted Markdown and diffs): the Kumo islands bundle,
  // about 480 KB of script and 150 KB of style, loads only on pages with an island to mount. Repository pages have
  // one in their header, and live updates can bring some in later fragments.
  const content = await (<>{body}</>).toString();
  const kumo = !!opts.repo || !!opts.live || content.includes(ISLAND);
  csrfToken(c);
  const nonce = randomToken(16);
  const fl = takeFlash(c);
  const p = c.get("principal");
  const me = p?.type === "account" ? p.account : null;
  const active = me?.status === "active";
  c.header("content-security-policy", csp(nonce, c, opts.turnstile, opts.formAction));
  c.header("x-frame-options", "DENY");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
  c.header("cache-control", "private, no-store");
  const r = opts.repo;
  const title = opts.seoTitle ?? (opts.home ? `${SITE.name}: ${SITE.tagline}` : opts.title ? `${opts.title} · ${SITE.name}` : SITE.name);
  const theme = appearanceOf(c);
  const page = (
    <html lang="en" data-theme={theme ?? undefined} data-mode={theme ?? undefined}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content={theme ?? "light dark"} />
        {opts.refresh ? <meta http-equiv="refresh" content={String(opts.refresh)} /> : null}
        <title>{title}</title>
        {SeoHead(c, {
          title,
          description: opts.description ?? (r?.repo.description ? `${r.repo.description} · ${r.repo.owner_login}/${r.repo.name} on Diffinery` : r ? `${r.repo.owner_login}/${r.repo.name} on Diffinery` : undefined),
          noindex: (opts.status ?? 200) >= 400 || (r !== undefined && r.repo.visibility !== "public"),
          home: opts.home,
          jsonLd: opts.jsonLd,
          modified: opts.modified,
          nonce,
        })}
        <style>{raw(CSS)}</style>
        {kumo ? <link rel="stylesheet" href={kumoAssets().css} /> : null}
        {!kumo && opts.prefetchKumo ? (
          <>
            <link rel="prefetch" href={kumoAssets().css} as="style" />
            <link rel="prefetch" href={kumoAssets().js} as="script" />
          </>
        ) : null}
        {opts.head ?? null}
        {opts.turnstile ? <script nonce={nonce} src={TURNSTILE_SCRIPT} async defer></script> : null}
      </head>
      <body
        data-repo={r ? `${r.repo.owner_login}/${r.repo.name}` : undefined}
        data-ref={r?.ref ?? r?.repo.default_branch}
        data-live={opts.live}
        data-live-mode={opts.live ? (opts.liveMode ?? "reload") : undefined}
        data-last-seq={opts.lastSeq !== undefined ? String(opts.lastSeq) : undefined}
      >
        <header class="top">
          <div class="wrap">
            <a class="brand" href="/" aria-label="Diffinery home">
              {raw(ICONS.logo)} <span>Diffinery</span>
            </a>
            {active ? (
              <button type="button" class="pal-btn" data-palette="1" aria-label="Open command palette">
                {raw(ICONS.search)}
                <span>Jump to…</span>
                <kbd>Ctrl K</kbd>
              </button>
            ) : null}
            <nav>
              {!active ? (
                <>
                  <a href="/features" class="nav-site">
                    Product
                  </a>
                  <a href="/compare" class="nav-site">
                    Compare
                  </a>
                </>
              ) : null}
              <a href="/docs" title="Documentation">
                Docs
              </a>
              {active && me ? (
                <>
                  <a href="/new" title="New repository">
                    {raw(ICONS.plus)}
                  </a>
                  <a href="/notifications" title="Notifications">
                    {raw(ICONS.bell)}
                  </a>
                  <a href="/settings" title="Settings" aria-label={`Settings (${me.login})`} class="who">
                    <Avatar login={me.login} version={me.avatar_version} /> <span>{me.login}</span>
                  </a>
                </>
              ) : null}
              {p?.type === "account" && p.via === "session" ? (
                <form method="post" action="/auth/logout" class="inline">
                  <input type="hidden" name={CSRF_FIELD} value={csrfToken(c)} />
                  <button class="navbtn">Sign out</button>
                </form>
              ) : null}
              {!p || p.type === "anonymous" ? (
                c.req.path === "/login" ? null : (
                  <a href={`/login${c.req.path === "/" ? "" : `?next=${encodeURIComponent(c.req.path)}`}`} class="btn primary sm">
                    Sign in
                  </a>
                )
              ) : null}
            </nav>
          </div>
        </header>
        {r ? <RepoHeader r={r} watch={watch} t={csrfToken(c)} /> : null}
        <main class="wrap" style={opts.wide ? "max-width:none" : undefined}>
          {fl ? <div class={`flash ${fl.kind}`} role={fl.kind === "error" ? "alert" : "status"}>{fl.message}</div> : null}
          {raw(content)}
        </main>
        <footer class="site-foot">
          {active ? null : <SiteFooter />}
          <div class="wrap">
            <div class="foot-bar">
              <span>© {new Date().getUTCFullYear()} Diffinery</span>
              {active ? (
                <nav aria-label="Footer">
                  <a href="/docs">Docs</a>
                  <a href="/docs/security/disclosure">Security</a>
                  <a href="/status">Status</a>
                </nav>
              ) : (
                <a href="/built-on-cloudflare">Runs entirely on Cloudflare</a>
              )}
            </div>
          </div>
        </footer>
        {active ? (
          <dialog id="palette" aria-label="Command palette">
            <input type="text" placeholder="Jump to a repository, file, page or #number…" autocomplete="off" spellcheck={false} />
            <ul role="listbox"></ul>
            <div class="foot">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> navigate
              </span>
              <span>
                <kbd>Enter</kbd> open
              </span>
              <span>
                <kbd>g</kbd> then <kbd>c</kbd>/<kbd>i</kbd>/<kbd>p</kbd>/<kbd>a</kbd> code, issues, pulls, actions
              </span>
            </div>
          </dialog>
        ) : null}
        {kumo ? <script nonce={nonce} src={kumoAssets().js} defer></script> : null}
        <script nonce={nonce}>{raw(JS)}</script>
        {opts.script ? <script nonce={nonce}>{raw(opts.script)}</script> : null}
        {(opts.scriptSrc ?? []).map((src) => (
          <script nonce={nonce} src={src} defer></script>
        ))}
      </body>
    </html>
  );
  // `html` waits for async components (highlighted Markdown and diffs).
  return c.html(html`<!doctype html>${page}`, (opts.status ?? 200) as 200);
}

/** Friendly error page for HttpErrors (and DO errors carrying a status prefix). */
export function errorPage(c: AppContext, e: unknown): Response | Promise<Response> {
  // A transferred or renamed repository: its old URLs lead to the new ones.
  if (e instanceof RepoMoved) return c.redirect(e.location, e.status as 301 | 307);
  const confirm = confirmUrl(e);
  if (confirm) return c.redirect(confirm, 303);
  const s = statusOf(e);
  if (s.status >= 500) console.error(e);
  // Site administrators find the error by this id (Settings -> Server errors).
  const requestId = s.status >= 500 ? noteServerError(c, e, s.status) : null;
  // Signed-out visitors who open a page go straight to sign-in, and come back afterwards.
  if (s.status === 401 && c.req.method === "GET" && c.get("principal")?.type === "anonymous" && !c.req.path.startsWith("/auth/")) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }
  const titles: Record<number, string> = { 401: "Sign in required", 403: "Access denied", 404: "Not found", 405: "Not allowed", 409: "Conflict", 422: "Could not complete the request" };
  const title = titles[s.status] ?? (s.status >= 500 ? "Something went wrong" : "Request failed");
  const p = c.get("principal");
  return render(
    c,
    { title, status: s.status },
    <div class="blank" style="max-width:640px;margin:48px auto">
      <div class="faint" style="font-size:48px;font-weight:700;letter-spacing:-.03em">{s.status}</div>
      <h1>{title}</h1>
      {s.status === 401 ? (
        <>
          <p class="muted">{p?.type === "account" ? s.message : "Sign in with your passkey to continue."}</p>
          <p>
            <a class="btn primary" href={`/login?next=${encodeURIComponent(c.req.path)}`}>
              Sign in
            </a>
          </p>
        </>
      ) : s.status === 404 ? (
        <p class="muted">The page or repository does not exist, or you do not have access to it.</p>
      ) : (
        <p class="muted">{s.status >= 500 ? "An unexpected error occurred. Please try again." : s.message}</p>
      )}
      {requestId ? (
        <p class="small muted">
          Request ID <span class="mono">{requestId}</span>
        </p>
      ) : null}
      {s.status === 403 && p?.type === "account" && p.account.status === "pending" ? (
        <p>
          <a class="btn primary" href="/">
            Request access
          </a>
        </p>
      ) : s.status === 401 ? null : (
        <p>
          <a class="btn" href="/">
            Go to dashboard
          </a>
        </p>
      )}
    </div>,
  );
}

// ---------------------------------------------------------------- refs and paths

/** Path segments after a fixed number of leading segments, decoded. */
export function restOfPath(c: AppContext, skip: number): string {
  const parts = new URL(c.req.url).pathname.split("/").slice(skip + 1);
  return parts
    .filter((p) => p !== "")
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    })
    .join("/");
}

/** Split "feature/x/src/a.ts" into the longest matching ref and the path inside it. */
export async function splitRefPath(stub: Stub, rest: string): Promise<{ ref: string; path: string }> {
  const segs = rest.split("/").filter(Boolean);
  if (segs.length <= 1) return { ref: segs[0] ?? "", path: "" };
  const names = new Set((await stub.refs("refs/")).map((r) => r.name.replace(/^refs\/(heads|tags)\//, "")));
  for (let i = segs.length; i >= 1; i--) {
    const cand = segs.slice(0, i).join("/");
    if (names.has(cand)) return { ref: cand, path: segs.slice(i).join("/") };
  }
  return { ref: segs[0]!, path: segs.slice(1).join("/") };
}

/** Branch/tag switcher; `to` builds the target URL for a ref. */
export const RefSwitcher: FC<{ current: string; branches: string[]; tags: string[]; to: (ref: string) => string }> = ({ current, branches, tags, to }) => (
  <details class="menu">
    <summary class="btn sm">
      {raw(/^[0-9a-f]{40}$/.test(current) ? ICONS.commit : tags.includes(current) && !branches.includes(current) ? ICONS.tag : ICONS.branch)}
      <span class="mono">{/^[0-9a-f]{40}$/.test(current) ? shortSha(current) : current}</span>
      {raw(ICONS.caret)}
    </summary>
    <div class="pop">
      <h4>Branches</h4>
      {branches.length ? (
        branches.map((b) => (
          <a href={to(b)}>
            {b === current ? raw(ICONS.check) : <span style="width:16px;display:inline-block" />} {b}
          </a>
        ))
      ) : (
        <p class="muted small" style="margin:4px 8px">No branches</p>
      )}
      {tags.length ? <h4>Tags</h4> : null}
      {tags.map((t) => (
        <a href={to(t)}>
          {t === current ? raw(ICONS.check) : <span style="width:16px;display:inline-block" />} {t}
        </a>
      ))}
    </div>
  </details>
);

export async function refNames(stub: Stub): Promise<{ branches: string[]; tags: string[] }> {
  const refs = await stub.refs("refs/");
  return {
    branches: refs.filter((r) => r.name.startsWith("refs/heads/")).map((r) => r.name.slice(11)),
    tags: refs.filter((r) => r.name.startsWith("refs/tags/")).map((r) => r.name.slice(10)),
  };
}

// ---------------------------------------------------------------- diffs

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  truncated?: boolean;
}

export interface LineThread {
  side: "LEFT" | "RIGHT";
  line: number;
  node: Child;
}

const StatBar: FC<{ a: number; d: number }> = ({ a, d }) => {
  const total = a + d;
  const blocks = 5;
  const ga = total ? Math.round((a / total) * blocks) : 0;
  const gd = total ? Math.min(blocks - ga, Math.round((d / total) * blocks)) : 0;
  return (
    <span class="bar" aria-hidden="true">
      {Array.from({ length: blocks }, (_, i) => (
        <i class={i < ga ? "a" : i < ga + gd ? "d" : ""} />
      ))}
    </span>
  );
};

export const DiffStats: FC<{ files: number; additions: number; deletions: number }> = ({ files, additions, deletions }) => (
  <span class="row" style="gap:10px">
    <span>
      <b>{files}</b> file{files === 1 ? "" : "s"} changed
    </span>
    <span class="stat-add">+{additions}</span>
    <span class="stat-del">−{deletions}</span>
    <StatBar a={additions} d={deletions} />
  </span>
);

export interface DiffOptions {
  /** Link to view the file at the new revision. */
  viewHref?: (path: string) => string | null;
  /** Show "+" buttons for line comments (requires the line comment template on the page). */
  commentable?: boolean;
  /** Existing review threads per file path. */
  threads?: Map<string, LineThread[]>;
}

const LINE_BUDGET = 20000;
const HIGHLIGHT_BUDGET = 3000;

const diffLines = (f: DiffFile): number => f.hunks.reduce((n, h) => n + h.lines.length, 0);

/** Syntax tokens per file, hunk and line, for the rendered files that fit the highlighting budget. */
async function diffTokens(files: DiffFile[]): Promise<Map<DiffFile, Array<Array<TokLine | null>>>> {
  const out = new Map<DiffFile, Array<Array<TokLine | null>>>();
  const picked: Array<[DiffFile, Lang]> = [];
  let budget = LINE_BUDGET;
  let hlBudget = HIGHLIGHT_BUDGET;
  for (const f of files) {
    const lines = diffLines(f);
    const rendered = budget > 0 && !f.binary && !f.truncated;
    budget -= lines;
    const lang = langForPath(f.path);
    if (!rendered || !lang || lines > LIMITS.lines || lines > hlBudget) continue;
    hlBudget -= lines;
    picked.push([f, lang]);
  }
  const hl = picked.length ? await ready(picked.map(([, l]) => l)) : null;
  if (hl) for (const [f, lang] of picked) out.set(f, f.hunks.map((h) => diffLineTokens(h.lines, (code) => tokenize(hl, code, lang))));
  return out;
}

/** Unified diff with line numbers; each file is collapsible. */
export const DiffView: FC<{ files: DiffFile[]; opts?: DiffOptions }> = async ({ files, opts = {} }) => {
  const toks = await diffTokens(files);
  let budget = LINE_BUDGET;
  return (
    <div>
      {files.map((f) => {
        const lines = diffLines(f);
        const big = lines > 800;
        const ft = toks.get(f);
        const render = budget > 0 && !f.binary && !f.truncated;
        budget -= lines;
        const threads = opts.threads?.get(f.path) ?? [];
        const view = opts.viewHref?.(f.path);
        return (
          <details class="file" open={!big && render} id={`diff-${encodeURIComponent(f.path)}`}>
            <summary class="filehead">
              <span class={`badge ${f.status === "added" ? "green" : f.status === "deleted" ? "red" : "amber"}`}>{f.status}</span>
              <span class="mono grow" style="font-weight:600;word-break:break-all">{f.path}</span>
              <span class="stat-add small">+{f.additions}</span>
              <span class="stat-del small">−{f.deletions}</span>
              {view && f.status !== "deleted" ? (
                <a class="btn sm" href={view}>
                  View file
                </a>
              ) : null}
            </summary>
            {f.binary ? (
              <div class="empty">Binary file not shown.</div>
            ) : f.truncated ? (
              <div class="empty">This diff is too large to display.</div>
            ) : !render ? (
              <div class="empty">Diff not rendered to keep this page fast. {view ? <a href={view}>View the file</a> : null}</div>
            ) : f.hunks.length === 0 ? (
              <div class="empty">{f.status === "added" ? "Empty file added." : f.status === "deleted" ? "Empty file deleted." : "Mode change only."}</div>
            ) : (
              <div class="code-wrap">
                <table class="diff">
                  {f.hunks.map((h, hi) => {
                    const ht = ft?.[hi];
                    let oldN = h.oldStart;
                    let newN = h.newStart;
                    return (
                      <>
                        <tr class="hunk">
                          {opts.commentable ? <td class="act" /> : null}
                          <td class="ln" />
                          <td class="ln" />
                          <td class="code">
                            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                          </td>
                        </tr>
                        {h.lines.map((l, li) => {
                          const k = l[0];
                          const lt = ht?.[li];
                          if (k === "\\") {
                            return (
                              <tr class="meta">
                                {opts.commentable ? <td class="act" /> : null}
                                <td class="ln" />
                                <td class="ln" />
                                <td class="code">{l}</td>
                              </tr>
                            );
                          }
                          const cls = k === "+" ? "add" : k === "-" ? "del" : "ctx";
                          const o = k === "+" ? null : oldN++;
                          const n = k === "-" ? null : newN++;
                          const side = k === "-" ? "LEFT" : "RIGHT";
                          const lineNo = side === "LEFT" ? o : n;
                          const here = threads.filter((t) => t.side === side && t.line === lineNo);
                          return (
                            <>
                              <tr class={cls}>
                                {opts.commentable ? (
                                  <td class="act">
                                    <button type="button" class="addc" title="Comment on this line" data-comment-line={String(lineNo)} data-path={f.path} data-side={side}>
                                      +
                                    </button>
                                  </td>
                                ) : null}
                                <td class="ln">{o ?? ""}</td>
                                <td class="ln">{n ?? ""}</td>
                                <td class={lt ? "code sh" : "code"}>
                                  {k === "+" || k === "-" ? k : " "}
                                  {lt ? tokens(lt) : l.slice(1)}
                                </td>
                              </tr>
                              {here.length ? (
                                <tr class="thread">
                                  <td colspan={opts.commentable ? 4 : 3}>{here.map((t) => t.node)}</td>
                                </tr>
                              ) : null}
                            </>
                          );
                        })}
                      </>
                    );
                  })}
                </table>
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
};

/** Changed-files summary list with anchors into the diff. */
export const FileSummary: FC<{ files: DiffFile[] }> = ({ files }) =>
  files.length > 3 ? (
    <details class="box">
      <summary class="head" style="cursor:pointer">
        <span>Files ({files.length})</span>
      </summary>
      <ul class="list">
        {files.map((f) => (
          <li style="padding:6px 14px">
            <a class="mono grow" href={`#diff-${encodeURIComponent(f.path)}`}>
              {f.path}
            </a>
            <span class="stat-add small">+{f.additions}</span>
            <span class="stat-del small">−{f.deletions}</span>
          </li>
        ))}
      </ul>
    </details>
  ) : null;

/** Commit list row. */
export const CommitRow: FC<{ base: string; sha: string; message: string; author: { name: string; email?: string; timestamp: number }; signed?: boolean; extra?: Child }> = ({ base, sha, message, author, signed, extra }) => (
  <li>
    <div class="grow">
      <a class="title" href={`${base}/commit/${sha}`}>
        {firstLine(message)}
      </a>
      <div class="meta">
        <b>{author.name}</b> committed <Time at={new Date(author.timestamp * 1000).toISOString()} />
        {signed ? <span class="badge green" style="margin-left:6px">signed</span> : null}
      </div>
    </div>
    {extra}
    <span class="btngroup">
      <CopyButton text={sha} icon />
      <a class="btn sm mono" href={`${base}/commit/${sha}`} title="View commit">
        {shortSha(sha)}
      </a>
      <a class="btn sm icon" href={`${base}/tree/${sha}`} title="Browse the repository at this point" aria-label="Browse the repository at this point">
        {raw(ICONS.code)}
      </a>
    </span>
  </li>
);

/** Look up agents' owners for "on behalf of" labels. */
export async function onBehalfOf(c: AppContext, actors: Array<{ login: string; kind: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const logins = [...new Set(actors.filter((a) => a.kind === "agent").map((a) => a.login))].slice(0, 20);
  if (!logins.length) return out;
  // Every agent and its owner in one query.
  const r = await c.env.DB.prepare(`SELECT a.login, o.login AS owner FROM accounts a JOIN accounts o ON o.id = a.owner_id WHERE a.login IN (${logins.map(() => "?").join(", ")})`)
    .bind(...logins)
    .all<{ login: string; owner: string }>();
  // Logins match without regard to case, as in the single lookups.
  const owners = new Map(r.results.map((row) => [row.login.toLowerCase(), row.owner]));
  for (const login of logins) {
    const owner = owners.get(login.toLowerCase());
    if (owner) out.set(login, owner);
  }
  return out;
}

export const ROLES = ["read", "triage", "write", "maintain", "admin"] as const;

/** "write" → "Write", for showing a stored value as a label. */
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export type PendingInvite = { id: string; email: string | null; login?: string | null; role: string; createdAt: string; expiresAt: string; invitedBy: string | null };

/** Pending invitations with a Revoke button each; `revoke` gives the form action for an invitation id. */
export const PendingInvites: FC<{ invites: PendingInvite[]; revoke: (id: string) => string; t: string; roles?: boolean }> = ({ invites, revoke, t, roles = true }) =>
  invites.length ? (
    <div class="box">
      <div class="head">
        <h3>{raw(ICONS.envelope)} Pending invitations</h3>
      </div>
      <table class="tbl">
        <tbody>
          {invites.map((i) => (
            <tr>
              <td>
                <b>{i.login ? `@${i.login}` : i.email}</b>
                <div class="muted small">
                  Invited {i.invitedBy ? `by ${i.invitedBy} ` : ""}
                  <Time at={i.createdAt} /> · expires {new Date(i.expiresAt).toLocaleDateString("en-US", { dateStyle: "medium" })}
                </div>
              </td>
              {roles ? (
                <td>
                  <span class="badge">{cap(i.role)}</span>
                </td>
              ) : null}
              <td class="right">
                <Form action={revoke(i.id)} t={t} class="inline" confirm={i.login ? `Revoke the invitation for @${i.login}?` : `Revoke the invitation for ${i.email}? The link stops working.`}>
                  <button class="btn sm danger">Revoke</button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;

/** The browser's check for usernames, organization and agent names; the server's isValidLogin agrees (no dots). */
export const LOGIN_PATTERN = "[A-Za-z0-9][A-Za-z0-9_\\-]{0,99}";
