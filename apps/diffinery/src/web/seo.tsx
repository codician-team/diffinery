/** @jsxImportSource hono/jsx */
/**
 * Favicons, app icons, the social preview image, robots.txt, sitemap.xml and the
 * search/social meta tags every page carries.
 *
 * The PNG and ICO files come from scripts/make-icons.py (icons.generated.ts). Google
 * shows a site's favicon in results when it is crawlable, square and a multiple of
 * 48px, so /favicon.ico (16–64px) and /favicon-48.png are linked from every page.
 */
import { raw } from "hono/html";
import type { AppContext } from "../auth/principal.js";
import type { WebApp } from "./ui.js";
import { ICON_FILES } from "./icons.generated.js";
import { docsSitemapEntries } from "../docs/web.js";
import { CONTACT, siteSitemapEntries } from "./site.js";
import { indexNowKey } from "./indexnow.js";

export const SITE = {
  name: "Diffinery",
  tagline: "Code hosting and CI for the agentic era",
  description:
    "Diffinery is open-source code hosting and CI for the agentic era: Git repositories, pull requests with intent, GitHub Actions compatible workflows and AI agents as first-class collaborators, running on your own Cloudflare account.",
  color: "#f6821f",
};

/** The mark on an orange tile, for browsers that take SVG favicons. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.3" fill="${SITE.color}"/><g transform="translate(2.4 2.4) scale(.8)" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.3 7.2c4 1 7.4 2.2 7.6 3.3M8.3 16.8c4-1 7.4-2.2 7.6-3.3"/></g></svg>`;

const TYPES: Record<string, string> = { ico: "image/x-icon", png: "image/png" };
const bytes = new Map<string, Uint8Array<ArrayBuffer>>();
function file(name: string): Uint8Array<ArrayBuffer> | null {
  const b64 = ICON_FILES[name];
  if (!b64) return null;
  let b = bytes.get(name);
  if (!b) {
    const bin = atob(b64);
    b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    bytes.set(name, b);
  }
  return b;
}

const CACHE = "public, max-age=604800";

/** Paths that are never useful in search results. */
const PRIVATE = /^\/(login|logout|auth|signin|signup|invite|settings|notifications|new|admin|request-access|early-access\/(?:confirm|remove)|contact\/confirm|-)(\/|$)/;

export function registerSeo(web: WebApp): void {
  for (const name of Object.keys(ICON_FILES)) {
    const type = TYPES[name.split(".").pop()!]!;
    web.get(`/${name}`, (c) => c.body(file(name)!, 200, { "content-type": type, "cache-control": CACHE, "x-content-type-options": "nosniff" }));
  }
  web.get("/favicon.svg", (c) => c.body(FAVICON_SVG, 200, { "content-type": "image/svg+xml", "cache-control": CACHE, "x-content-type-options": "nosniff" }));
  web.get("/site.webmanifest", (c) =>
    c.body(
      JSON.stringify({
        name: SITE.name,
        short_name: SITE.name,
        description: SITE.description,
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: SITE.color,
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      }),
      200,
      { "content-type": "application/manifest+json", "cache-control": CACHE },
    ),
  );
  web.get("/robots.txt", (c) => {
    const origin = c.env.PUBLIC_URL.replace(/\/$/, "");
    const lines = [
      // Search engines and AI assistants are welcome on every public page: the site, the docs, llms.txt
      // and public repositories. Content-Signal (contentsignals.org) says so explicitly, for crawlers that read it.
      "User-agent: *",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
      "Allow: /",
      ...["/api/", "/mcp", "/runner/", "/auth/", "/login", "/signin", "/invite/", "/settings", "/notifications", "/new", "/admin", "/request-access", "/early-access/confirm", "/early-access/remove", "/contact/confirm", "/-/", "/*.git/", "/*/raw/"].map((p) => `Disallow: ${p}`),
      "",
      `Sitemap: ${origin}/sitemap.xml`,
      "",
      `# For AI assistants: ${origin}/llms.txt indexes the site and the docs as Markdown; ${origin}/llms-full.txt holds all of it in one file, and ${origin}/llms-small.txt the site and the essential docs.`,
      "",
    ];
    return c.text(lines.join("\n"), 200, { "cache-control": "public, max-age=86400" });
  });
  // The IndexNow key file (web/indexnow.ts): /<key>.txt holds the key, which proves submissions come from this site.
  web.get("/:file{[0-9a-f]+\\.txt}", async (c) => {
    const key = await indexNowKey(c.env);
    if (!key || c.req.param("file") !== `${key}.txt`) return c.notFound();
    return c.text(key, 200, { "cache-control": "public, max-age=3600" });
  });
  web.get("/sitemap.xml", async (c) => {
    const origin = c.env.PUBLIC_URL.replace(/\/$/, "");
    const repos = await c.get("dir").publicRepos(5000);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const url = (loc: string, lastmod?: string | null) => `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${esc(lastmod.slice(0, 10))}</lastmod>` : ""}</url>`;
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      // The home page, then the product, comparison and company pages (web/site.tsx).
      ...siteSitemapEntries().map((e) => url(`${origin}${e.path}`, e.updated)),
      // The contact form (web/contact.tsx), for people and AI assistants looking for how to reach the team.
      url(`${origin}${CONTACT.path}`, CONTACT.updated),
      ...docsSitemapEntries().map((e) => url(`${origin}${e.path}`, e.updated)),
      ...repos.map((r) => url(`${origin}/${encodeURIComponent(r.owner_login)}/${encodeURIComponent(r.name)}`, r.pushed_at ?? r.updated_at)),
      "</urlset>",
    ].join("\n");
    return c.body(body, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
  });
}

export type SeoOpts = {
  title: string;
  description?: string;
  /** Keep the page out of search results. */
  noindex?: boolean;
  /** The home page. */
  home?: boolean;
  /** Structured data (schema.org objects, without @context), as one JSON-LD graph. */
  jsonLd?: object[];
  /** The date an article's facts were last checked (YYYY-MM-DD): marks the page as an article. */
  modified?: string;
  nonce: string;
};

/** Icons plus search and social meta tags for the page's <head>. */
export function SeoHead(c: AppContext, o: SeoOpts) {
  const origin = c.env.PUBLIC_URL.replace(/\/$/, "");
  const path = c.req.path;
  const url = `${origin}${path}`;
  const description = o.description?.trim() || SITE.description;
  const noindex = o.noindex || PRIVATE.test(path);
  const image = `${origin}/og-image.png`;
  const ld = o.jsonLd?.length && !noindex ? JSON.stringify({ "@context": "https://schema.org", "@graph": o.jsonLd }).replace(/</g, "\\u003c") : null;
  return (
    <>
      <meta name="description" content={description} />
      {noindex ? <meta name="robots" content="noindex, nofollow" /> : <link rel="canonical" href={url} />}
      <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48 64x64" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="icon" href="/favicon-48.png" sizes="48x48" type="image/png" />
      <link rel="icon" href="/favicon-96.png" sizes="96x96" type="image/png" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="manifest" href="/site.webmanifest" />
      <meta name="theme-color" content={SITE.color} />
      <meta name="application-name" content={SITE.name} />
      <meta name="apple-mobile-web-app-title" content={SITE.name} />
      <meta property="og:type" content={o.modified ? "article" : "website"} />
      {o.modified ? <meta property="article:modified_time" content={o.modified} /> : null}
      <meta property="og:site_name" content={SITE.name} />
      <meta property="og:title" content={o.title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={image} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content={`${SITE.name}: ${SITE.tagline}`} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={o.title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
      {ld ? <script type="application/ld+json" nonce={o.nonce}>{raw(ld)}</script> : null}
    </>
  );
}
