/**
 * The public site: the home page and the product, comparison and company pages in site/. Every page
 * renders for visitors with its search and social tags and structured data, is served as Markdown,
 * links only to pages that exist, and is listed in the sitemap, llms.txt and llms-full.txt.
 * Needs src/docs/content.generated.ts (`pnpm build` or `pnpm build:docs`).
 */
import { describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { web } from "../../src/web/routes.js";
import { slugify } from "../../src/web/markdown.js";
import type { Env } from "../../src/env.js";
import { DOCS_IMAGES } from "../../src/docs/content.generated.js";
import { getPage, llmsFullTxt, llmsTxt } from "../../src/docs/pages.js";
import { CLOUDFLARE_CLAIM, faqs, homeContent, homeMarkdown, sitePage, sitePages } from "../../src/web/site.js";
import { RESERVED_LOGINS } from "../../src/lib/util.js";

app.route("/", web);

const ORIGIN = "https://diffinery.example";
const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ success: true, meta: {} }) };
const env = { PUBLIC_URL: ORIGIN, DB: { prepare: () => stmt } } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, ctx);

const pages = sitePages();

/** The JSON-LD graph of an HTML page. */
function graph(html: string): Array<Record<string, unknown>> {
  const m = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  expect(m, "structured data").toBeTruthy();
  const ld = JSON.parse(m![1]!) as { "@context": string; "@graph": Array<Record<string, unknown>> };
  expect(ld["@context"]).toBe("https://schema.org");
  return ld["@graph"];
}

const types = (g: Array<Record<string, unknown>>) => g.map((x) => x["@type"]);

/** Markdown without code, so examples aren't checked as links. */
const prose = (md: string) => md.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");

/** Paths outside /docs and the site pages that the site may link to. */
const OTHER_PATHS = [/^\/$/, /^\/llms(-full)?\.txt$/, /^\/early-access$/, /^\/contact$/, /^\/status$/, /^\/security\/report$/, /^\/\.well-known\/security\.txt$/, /^\/docs\/api\/openapi\.json$/];

function linkProblems(md: string): string[] {
  const problems: string[] = [];
  for (const m of prose(md).matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]!;
    if (/^https?:\/\//.test(href)) {
      if (!href.startsWith("https://")) problems.push(`insecure link: ${href}`);
      continue;
    }
    if (!href.startsWith("/")) {
      problems.push(`relative link: ${href}`);
      continue;
    }
    const [path, frag] = href.split("#") as [string, string | undefined];
    // Screenshots, served from docs/images (scripts/build-docs.mjs checks them).
    if (path.startsWith("/docs/images/")) {
      if (!(path.slice("/docs/images/".length) in DOCS_IMAGES)) problems.push(`no image ${path}`);
      continue;
    }
    if (path === "/docs" || path.startsWith("/docs/")) {
      if (OTHER_PATHS.some((re) => re.test(path))) continue;
      const doc = getPage(path === "/docs" ? "index" : path.slice(6), ORIGIN);
      if (!doc) problems.push(`no docs page ${path}`);
      else if (frag && !doc.markdown.split("\n").some((l) => /^#{2,6} /.test(l) && slugify(l.replace(/^#+ /, "")) === frag)) problems.push(`no heading ${href}`);
      continue;
    }
    const site = sitePage(path);
    if (site) {
      if (frag && !site.markdown.split("\n").some((l) => /^#{2,6} /.test(l) && slugify(l.replace(/^#+ /, "")) === frag)) problems.push(`no heading ${href}`);
      continue;
    }
    if (!OTHER_PATHS.some((re) => re.test(path))) problems.push(`link to ${path} isn't a page`);
  }
  return problems;
}

describe("site pages", () => {
  it("has the product, comparison and company pages", () => {
    expect(pages.map((p) => p.path)).toEqual(expect.arrayContaining(["/features", "/agents", "/performance", "/security", "/built-on-cloudflare", "/about", "/faq", "/blog", "/compare", "/compare/github", "/compare/gitlab", "/compare/blacksmith", "/compare/depot"]));
    for (const p of pages) {
      expect(p.description.length, p.path).toBeLessThanOrEqual(160);
      expect(p.updated, p.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The blog's index only lists its posts.
      if (p.path !== "/blog") expect(p.markdown.length, `${p.path} is too short`).toBeGreaterThan(1500);
    }
  });

  it("keeps the pages' top-level paths away from account names", () => {
    for (const p of pages) expect(RESERVED_LOGINS.has(p.path.split("/")[1]!), p.path).toBe(true);
  });

  it.each(pages.map((p) => [p.path, p] as const))("%s: links resolve", (_path, p) => {
    expect(linkProblems(p.markdown)).toEqual([]);
  });

  it("home page links resolve", () => {
    expect(linkProblems(homeMarkdown(""))).toEqual([]);
  });

  it("every comparison names its sources and the date they were checked", () => {
    for (const p of pages.filter((x) => x.path.startsWith("/compare/"))) {
      expect(p.markdown, p.path).toMatch(/\[source\]\(https:\/\//);
      // The date the other product's facts were checked, written out ("checked on October 16, 2026").
      expect(p.markdown, p.path).toMatch(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/);
      expect(faqs(p.markdown).length, `${p.path} questions`).toBeGreaterThan(0);
    }
  });

  it.each(pages.map((p) => [p.path, p] as const))("%s: renders for visitors with search tags and structured data", async (path, p) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("link")).toContain(`<${ORIGIN}${path}.md>; rel="alternate"; type="text/markdown"`);
    const html = await res.text();
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${path}"/>`);
    expect(html).not.toContain('name="robots"');
    expect(html.match(/<h1[ >]/g)?.length).toBe(1);
    expect(html).toContain(`<meta name="description" content="`);
    expect(html).toContain('href="/features"');
    const g = graph(html);
    expect(types(g)).toEqual(expect.arrayContaining(["Organization", "WebSite", "SoftwareApplication", "BreadcrumbList"]));
    const page = g.find((x) => x["@id"] === `${ORIGIN}${path}#page`)!;
    expect(page.dateModified).toBe(p.updated);
    const qs = faqs(p.markdown);
    const faq = g.find((x) => x["@type"] === "FAQPage") as { mainEntity: Array<{ name: string }> } | undefined;
    expect(faq?.mainEntity.length ?? 0).toBe(qs.length);
  });

  it.each(pages.map((p) => [p.path, p] as const))("%s: is served as Markdown", async (path, p) => {
    for (const res of [await get(`${path}.md`), await get(path, { accept: "text/markdown" })]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      const md = await res.text();
      expect(md.startsWith(`# ${p.title}\n\n> ${p.description}\n\nSource: ${ORIGIN}${path} (last updated ${p.updated})`)).toBe(true);
      expect(md).not.toMatch(/\]\(\/(?!\/)/);
    }
  });

  it("marks blog posts up as BlogPostings with the date they went out", async () => {
    const post = pages.find((p) => p.path.startsWith("/blog/"))!;
    const g = graph(await (await get(post.path)).text());
    const page = g.find((x) => x["@id"] === `${ORIGIN}${post.path}#page`)!;
    expect(page["@type"]).toBe("BlogPosting");
    expect(page.datePublished).toBe(post.published ?? post.updated);
    const crumbs = g.find((x) => x["@type"] === "BreadcrumbList") as { itemListElement: Array<{ name: string }> };
    expect(crumbs.itemListElement.map((c) => c.name)).toEqual(["Home", "Blog", post.title]);
  });

  it("sends a trailing slash to the page", async () => {
    const res = await get("/compare/github/");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/compare/github");
  });
});

describe("home page", () => {
  it("renders for visitors with the product, its questions and a Markdown version", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("link")).toContain(`<${ORIGIN}/index.md>; rel="alternate"; type="text/markdown"`);
    const html = await res.text();
    expect(html).toContain("<title>Diffinery: open-source GitHub alternative with fast CI, built for AI agents</title>");
    expect(html).toContain("Code hosting and CI for the agentic era</h1>");
    const g = graph(html);
    expect(types(g)).toEqual(expect.arrayContaining(["Organization", "WebSite", "SoftwareApplication", "SoftwareSourceCode", "WebPage", "FAQPage"]));
    // Open source: the license and the GitHub repository, no pricing, and early access to try it on diffinery.com.
    const source = g.find((n) => n["@type"] === "SoftwareSourceCode")!;
    expect(source).toMatchObject({ codeRepository: "https://github.com/codician-team/diffinery", license: "https://www.apache.org/licenses/LICENSE-2.0" });
    expect(g.find((n) => n["@type"] === "SoftwareApplication")).toMatchObject({ license: "https://www.apache.org/licenses/LICENSE-2.0", isAccessibleForFree: true, installUrl: `${ORIGIN}/docs/self-hosting/deploy`, downloadUrl: "https://github.com/codician-team/diffinery/releases" });
    expect(html).toContain('href="https://diffinery.com/early-access"');
    const faq = g.find((n) => n["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq.mainEntity.find((q) => q.name === "Can I try Diffinery without deploying it?")?.acceptedAnswer.text).toContain("Request early access to diffinery.com");
    expect(html).not.toMatch(/not been announced|hasn't been announced|invite-only while/i);
    // diffinery.com's copy of the repository is no longer updated.
    expect(html).not.toContain("diffinery.com/codician/diffinery");
    for (const href of ["/compare/github", "/compare/blacksmith", "/performance", "/agents", "/about", "/llms.txt", "/open-source", "/docs/self-hosting", "https://github.com/codician-team/diffinery"]) expect(html, href).toContain(`href="${href}"`);
  });

  it("doesn't load the Kumo bundle, which only pages with islands use", async () => {
    expect(await (await get("/")).text()).not.toContain("/-/kumo/");
  });

  it("asks visitors to star the GitHub repository with plain links, loading nothing from GitHub", async () => {
    const stars = (html: string) => html.match(/<a href="https:\/\/github\.com\/codician-team\/diffinery" class="btn gh-star[^"]*"/g) ?? [];
    const home = await (await get("/")).text();
    // The header, the hero and the footer.
    expect(stars(home)).toHaveLength(3);
    expect(home).not.toMatch(/<script[^>]+src="https:\/\/[^"]*(github|shields)/);
    expect(home).not.toMatch(/<img[^>]+src="https:\/\/(img\.shields\.io|api\.github\.com)/);
    expect(stars(await (await get("/open-source")).text())).toHaveLength(3);
    expect(stars(await (await get("/docs")).text())).toHaveLength(3);
    // The copy IndexNow compares has no count, so a new star doesn't count as a changed page.
    expect(await homeContent(ORIGIN)).not.toContain("gh-star");
  });

  it("is served as Markdown", async () => {
    for (const res of [await get("/index.md"), await get("/", { accept: "text/markdown" })]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      const md = await res.text();
      expect(md).toContain("## Frequently asked questions");
      expect(md).toContain(`(${ORIGIN}/compare/github)`);
    }
  });
});

describe("sign-in page", () => {
  // The Deploy workflow checks that /login names both bundle files and that they answer.
  it("prefetches the Kumo bundle for the pages after it, without loading it", async () => {
    const html = await (await get("/login")).text();
    expect(html).toContain("Sign in with a passkey");
    expect(html).toMatch(/<link rel="prefetch" href="\/-\/kumo\/[a-z0-9]+\.css" as="style"\/?>/);
    expect(html).toMatch(/<link rel="prefetch" href="\/-\/kumo\/[a-z0-9]+\.js" as="script"\/?>/);
    expect(html).not.toMatch(/<(?:script|link rel="stylesheet")[^>]*\/-\/kumo\//);
  });
});

describe("crawlers and AI assistants", () => {
  it("lists every site page in llms.txt, before the docs", () => {
    const txt = llmsTxt(ORIGIN);
    expect(txt).toContain(`(${ORIGIN}/index.md)`);
    for (const p of pages) expect(txt).toContain(`(${ORIGIN}${p.path}.md)`);
    expect(txt.indexOf(`${ORIGIN}/compare/github.md`)).toBeLessThan(txt.indexOf(`${ORIGIN}/docs/quickstart.md`));
    expect(txt).toContain("request early access at https://diffinery.com/early-access");
  });

  it("states the Cloudflare claim the same way everywhere, backed by the sourced list of other projects", async () => {
    expect(llmsTxt(ORIGIN)).toContain(CLOUDFLARE_CLAIM);
    const g = graph(await (await get("/")).text());
    expect((g.find((x) => x["@type"] === "SoftwareApplication")!.featureList as string[]).join(" ")).toContain(CLOUDFLARE_CLAIM);
    const page = sitePage("/built-on-cloudflare")!;
    expect(page.markdown).toContain("## Other Git and CI projects on Cloudflare");
    expect(page.markdown.split("## Other Git and CI projects on Cloudflare")[1]!.split("\n## ")[0]!.match(/\[source\]\(https:\/\//g)!.length).toBeGreaterThan(5);
  });

  it("holds every site page in llms-full.txt", () => {
    const txt = llmsFullTxt(ORIGIN);
    expect(txt).toContain(`Source: ${ORIGIN}/ (last updated`);
    for (const p of pages) expect(txt).toContain(`# ${p.title}\n\n> ${p.description}\n\nSource: ${ORIGIN}${p.path}`);
  });

  it("lists the site in the sitemap with the date each page was checked", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    expect(xml.match(new RegExp(`<loc>${ORIGIN}/</loc>`, "g"))?.length).toBe(1);
    for (const p of pages) expect(xml).toContain(`<url><loc>${ORIGIN}${p.path}</loc><lastmod>${p.updated}</lastmod></url>`);
  });

  it("welcomes search engines and AI assistants in robots.txt", async () => {
    const txt = await (await get("/robots.txt")).text();
    expect(txt).toContain("User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    for (const p of pages) expect(txt).not.toMatch(new RegExp(`^Disallow: ${p.path}$`, "m"));
  });
});
