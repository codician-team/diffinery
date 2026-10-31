/**
 * The public docs: every page builds, every link and anchor resolves, the
 * generated references match the code, and the agent formats are complete.
 * Needs src/docs/content.generated.ts (`pnpm build` or `pnpm build:docs`).
 */
import { describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { web } from "../../src/web/routes.js";
import { slugify } from "../../src/web/markdown.js";
import type { Env } from "../../src/env.js";
import { mcpTools } from "../../src/mcp/server.js";
import { DOCS_TOOLS, docsSlug } from "../../src/mcp/docs.js";
import { ACCOUNT_SCOPES, API_DOCS } from "../../src/docs/api-meta.js";
import { allPages, getPage, headings, llmsFullTxt, llmsSmallTxt, llmsTxt, searchDocs, SECTIONS, sectionLlmsFullTxt, SLUGS } from "../../src/docs/pages.js";
import { sitePage, sitePages } from "../../src/web/site.js";
import { apiOperations, openApiDocument, openApiPath, OTHER_ENDPOINTS } from "../../src/docs/reference.js";

// index.ts mounts the web UI last; do the same here (it can't load Durable Objects under Node).
app.route("/", web);

const ORIGIN = "https://diffinery.example";
// An empty D1: the docs need no data, and the sitemap finds no public repositories.
const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ success: true, meta: {} }) };
const env = { PUBLIC_URL: ORIGIN, DB: { prepare: () => stmt } } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, ctx);

const pages = allPages(ORIGIN);

/** Markdown with fenced code blocks and inline code removed, so examples aren't checked as prose. */
function prose(md: string): string {
  return md.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, "").replace(/`[^`\n]*`/g, "");
}

/** Every heading id on a page (all levels). */
function ids(md: string): Set<string> {
  const out = new Set<string>();
  for (const line of prose(md).split("\n")) {
    const h = /^ {0,3}#{1,6} +(.+?)\s*#*\s*$/.exec(line);
    if (h) out.add(slugify(h[1]!));
  }
  return out;
}

/** Paths outside /docs that pages may link to: real routes of the app. */
const SITE_PATHS = [/^\/$/, /^\/llms(-full|-small)?\.txt$/, /^\/-\/cli\/diffinery\.mjs$/, /^\/settings(\/[\w/-]*)?$/, /^\/new$/, /^\/login$/, /^\/notifications$/, /^\/auth\/access$/, /^\/mcp$/, /^\/api\/v3(\/.*)?$/, /^\/\.well-known\/[\w.-]+$/, /^\/security\/report$/, /^\/early-access(\/remove)?$/, /^\/contact$/, /^\/status$/, /^\/healthz$/];

describe("docs pages", () => {
  it("has every page in the navigation, in order", () => {
    expect(pages.map((p) => p.slug)).toEqual(SLUGS);
    expect(SLUGS.length).toBeGreaterThan(40);
    for (const p of pages) {
      expect(p.title, p.slug).toBeTruthy();
      expect(p.description.length, `${p.slug} description`).toBeGreaterThan(20);
      expect(p.markdown.length, `${p.slug} is too short`).toBeGreaterThan(400);
    }
  });

  it.each(pages.map((p) => [p.slug, p] as const))("%s: links and anchors resolve", (slug, p) => {
    const problems: string[] = [];
    const text = prose(p.markdown);
    for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = m[1]!;
      if (/^https?:\/\//.test(href)) {
        if (href.startsWith(ORIGIN) || href.startsWith("https://diffinery.com/docs")) problems.push(`absolute link to the docs (use a /docs/... path): ${href}`);
        continue;
      }
      if (href.startsWith("#")) {
        if (!ids(p.markdown).has(href.slice(1))) problems.push(`no heading for ${href}`);
        continue;
      }
      if (!href.startsWith("/")) {
        problems.push(`relative link (use an absolute /docs/... path): ${href}`);
        continue;
      }
      const [path, frag] = href.split("#") as [string, string | undefined];
      if (path === "/docs" || path.startsWith("/docs/")) {
        if (path === "/docs/api/openapi.json") continue;
        if (path.startsWith("/docs/images/")) continue; // checked when the docs are built (scripts/build-docs.mjs)
        const llms = /^\/docs\/([\w-]+)\/llms(-full)?\.txt$/.exec(path);
        if (llms) {
          if (!SECTIONS.some((x) => x.slug === llms[1])) problems.push(`no docs section for ${href}`);
          continue;
        }
        const target = path === "/docs" ? "index" : path.slice(6).replace(/\.md$/, "");
        const t = getPage(target, ORIGIN);
        if (!t) problems.push(`no docs page for ${href}`);
        else if (frag && !ids(t.markdown).has(frag)) problems.push(`no heading #${frag} on ${target}`);
      } else if (sitePage(path)) {
        // The product, comparison and company pages (site/).
        if (frag && !ids(sitePage(path)!.markdown).has(frag)) problems.push(`no heading #${frag} on ${path}`);
      } else if (!SITE_PATHS.some((re) => re.test(path))) problems.push(`link to ${path} isn't a docs page or a known site path`);
    }
    expect(problems.join("\n"), slug).toBe("");
  });

  it.each(pages.map((p) => [p.slug, p] as const))("%s: headings are unique and there is no raw HTML", (slug, p) => {
    const seen = new Map<string, number>();
    for (const h of headings(p.markdown)) seen.set(h.id, (seen.get(h.id) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([id]) => id), `${slug}: duplicate headings`).toEqual([]);
    // The renderer escapes HTML, so a tag in prose would show up as literal text. (Placeholders like <name> are fine.)
    expect(prose(p.markdown).match(/<\/?(a|b|i|em|strong|br|p|div|span|img|table|tr|td|th|ul|ol|li|details|summary|code|pre|kbd|sup|sub|hr|h[1-6])(\s[^>]*)?\/?>/gi) ?? [], `${slug}: raw HTML`).toEqual([]);
  });
});

describe("generated references", () => {
  it("has notes only for endpoints that exist", () => {
    const routes = new Set(apiOperations().map((o) => `${o.method} ${o.path}`));
    expect(Object.keys(API_DOCS).filter((k) => !routes.has(k))).toEqual([]);
    expect(Object.keys(ACCOUNT_SCOPES).filter((k) => !routes.has(k))).toEqual([]);
  });

  it("documents every endpoint under /api/v3", () => {
    const ops = apiOperations();
    expect(ops.length).toBeGreaterThan(100);
    for (const o of ops) expect(o.doc.summary, `${o.method} ${o.path}`).toMatch(/\w/);
    const page = getPage("api", ORIGIN)!.markdown;
    for (const o of ops) expect(page, `${o.method} ${o.path}`).toContain(`${o.method} /api/v3${o.path === "/" ? "" : o.path}`);
  });

  it("lists other endpoints that are really routed", () => {
    const routed = app.routes.map((r) => openApiPath(r.path));
    for (const [endpoint] of OTHER_ENDPOINTS) {
      const path = endpoint.replace(/^[A-Z, ]+ /, "").replace(".git/", "/").replace("{run_id}", "{runId}").replace("{owner}/{repo}", "{owner}/{repo}");
      const want = path === "/v2/..." ? "/v2/{path}" : path;
      const docs = ["/llms.txt", "/llms-full.txt", "/docs/{page}.md", "/docs/api/openapi.json"].includes(want);
      expect(docs || routed.includes(want), endpoint).toBe(true);
    }
  });

  it("builds a valid OpenAPI 3.1 document", () => {
    const doc = openApiDocument(ORIGIN, "test") as { openapi: string; paths: Record<string, Record<string, { operationId: string }>> };
    expect(doc.openapi).toBe("3.1.0");
    const opIds = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(new Set(opIds).size).toBe(opIds.length);
    expect(opIds.length).toBe(apiOperations().length);
  });

  it("documents every MCP tool", () => {
    const page = getPage("reference/mcp-tools", ORIGIN)!.markdown;
    const tools = mcpTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(page).toContain(`### ${t.name}`);
    }
  });

  it("documents every CLI command", () => {
    const page = getPage("reference/cli", ORIGIN)!.markdown;
    for (const cmd of ["login", "repo create", "pr create", "pr merge", "issue create", "run list", "workflow run", "secret set", "runner", "migrate"]) {
      expect(page, cmd).toMatch(new RegExp(`#+ diffinery ${cmd}\\b`));
    }
  });
});

describe("agent formats", () => {
  it("llms.txt links every page as Markdown", () => {
    const txt = llmsTxt(ORIGIN);
    expect(txt.startsWith("# Diffinery\n\n> ")).toBe(true);
    for (const s of SLUGS) expect(txt).toContain(`(${ORIGIN}/docs/${s}.md)`);
  });

  it("llms-full.txt holds every page", () => {
    const txt = llmsFullTxt(ORIGIN);
    for (const p of pages) expect(txt).toContain(`# ${p.title}\n\n> ${p.description}\n\nSource: ${ORIGIN}`);
    expect(txt).not.toMatch(/\]\(\/docs/);
  });

  it("finds pages by search, the site's comparison pages included", () => {
    expect(searchDocs(ORIGIN, "merge queue")[0]?.page).toBeTruthy();
    expect(searchDocs(ORIGIN, "zzzz-not-a-word")).toEqual([]);
    const hit = searchDocs(ORIGIN, "blacksmith")[0]!;
    expect(hit.page).toBe("/compare/blacksmith");
    expect(hit.url).toMatch(new RegExp(`^${ORIGIN}/compare/blacksmith(#|$)`));
    expect(hit.markdown_url).toBe(`${ORIGIN}/compare/blacksmith.md`);
  });

  it("read_docs reads site pages by path or URL", async () => {
    for (const page of ["/compare/github", "compare/github", `${ORIGIN}/compare/github.md`]) {
      const r = (await DOCS_TOOLS.read_docs!.run({ env } as never, { page })) as { page: string; markdown: string };
      expect(r.page, page).toBe("/compare/github");
      expect(r.markdown.startsWith(`# ${sitePage("/compare/github")!.title}\n`)).toBe(true);
    }
  });

  it("splits the docs into one llms file per section, and a small file with the site and the essentials", () => {
    const full = llmsTxt(ORIGIN);
    for (const sec of SECTIONS) {
      expect(full).toContain(`${ORIGIN}/docs/${sec.slug}/llms-full.txt`);
      const txt = sectionLlmsFullTxt(ORIGIN, sec.slug)!;
      for (const slug of sec.pages) expect(txt).toContain(`Source: ${ORIGIN}${slug === "index" ? "/docs" : `/docs/${slug}`}\n`);
    }
    expect(sectionLlmsFullTxt(ORIGIN, "no-such-section")).toBeNull();
    const small = llmsSmallTxt(ORIGIN);
    for (const p of sitePages()) expect(small).toContain(`Source: ${ORIGIN}${p.path} (last updated`);
    expect(small).toContain(`Source: ${ORIGIN}/docs/quickstart\n`);
    expect(small).not.toContain("# REST API reference\n");
    // Small enough for an assistant's context: well under a tenth of llms-full.txt.
    expect(small.length).toBeLessThan(llmsFullTxt(ORIGIN).length / 4);
  });

  it("read_docs accepts slugs, paths and URLs, with .md, queries and anchors", () => {
    for (const input of ["actions/events", "/docs/actions/events", `${ORIGIN}/docs/actions/events.md`, `${ORIGIN}/docs/actions/events.md#push`, "/docs/actions/events/?x=1#push"]) expect(docsSlug(input), input).toBe("actions/events");
    for (const input of ["", "/docs", `${ORIGIN}/docs/`, "index.md", `${ORIGIN}/docs/index.md#start-here`]) expect(docsSlug(input), input).toBe("index");
  });
});

describe("docs routes", () => {
  it("serves the docs without signing in", async () => {
    const res = await get("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Overview</h1>");
    expect(html).toContain('rel="alternate" type="text/markdown" href="/docs/index.md"');
    expect(html).not.toContain('name="robots"');
  });

  it("highlights code examples", async () => {
    const html = await (await get("/docs/actions/workflow-syntax")).text();
    expect(html).toMatch(/<pre[^>]*><code[^>]*>[\s\S]*?<span style="/);
  });

  it("serves every page as HTML and as Markdown", async () => {
    for (const s of SLUGS) {
      const html = await get(s === "index" ? "/docs" : `/docs/${s}`);
      expect(html.status, s).toBe(200);
      const md = await get(`/docs/${s}.md`);
      expect(md.status, `${s}.md`).toBe(200);
      expect(md.headers.get("content-type")).toContain("text/markdown");
    }
    const neg = await get("/docs/quickstart", { accept: "text/markdown, text/html;q=0.8" });
    expect(neg.headers.get("content-type")).toContain("text/markdown");
    // Renders and highlights every page twice: about 1 s alone, several times that on a busy CI runner.
  }, 30_000);

  it("serves llms.txt, llms-full.txt, OpenAPI, the search index and the CLI", async () => {
    for (const [path, type] of [
      ["/llms.txt", "text/plain"],
      ["/llms-full.txt", "text/plain"],
      ["/llms-small.txt", "text/plain"],
      ["/docs/actions/llms.txt", "text/plain"],
      ["/docs/actions/llms-full.txt", "text/plain"],
      ["/docs/api/openapi.json", "application/json"],
      ["/docs/search.json", "application/json"],
      ["/-/cli/diffinery.mjs", "text/javascript"],
    ]) {
      const res = await get(path!);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
    }
    expect(await (await get("/-/cli/diffinery.mjs")).text()).toMatch(/^#!\/usr\/bin\/env node\n/);
  });

  it("serves the install scripts, pointed at this server", async () => {
    for (const path of ["/install", "/install.sh"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const sh = await res.text();
      expect(sh).toMatch(/^#!\/usr\/bin\/env bash\n/);
      expect(sh).toContain(`server=\${DIFFINERY_URL:-${ORIGIN}}`);
      expect(sh).not.toContain("__DIFFINERY_URL__");
      expect(sh).toContain(`curl -fsSL ${ORIGIN}/install | bash`); // what to run when piped into sh
    }
    const ps1 = await (await get("/install.ps1")).text();
    expect(ps1).toContain(`'${ORIGIN}'`);
    expect(ps1).toContain("/-/cli/diffinery.mjs");
  });

  it("serves the JetBrains plugin and the plugin repository the IDEs install and update it from", async () => {
    const xml = await get("/-/jetbrains/updatePlugins.xml");
    expect(xml.status).toBe(200);
    expect(xml.headers.get("content-type")).toContain("application/xml");
    const body = await xml.text();
    const plugin = body.match(/<plugin id="com\.diffinery" url="([^"]+)" version="([^"]+)">/);
    expect(plugin, body).not.toBeNull();
    const [, url, version] = plugin!;
    expect(url).toBe(`${ORIGIN}/-/jetbrains/diffinery-jetbrains-${version}.zip`);
    expect(body).toMatch(/<idea-version since-build="\d+"\/>/);
    expect(body).toContain(`${ORIGIN}/docs/repositories/clone-in-jetbrains-ides`);
    for (const path of [new URL(url).pathname, "/-/jetbrains/diffinery-jetbrains.zip"]) {
      const zip = await get(path);
      expect(zip.status, path).toBe(200);
      expect(zip.headers.get("x-diffinery-plugin-version")).toBe(version);
      const bytes = new Uint8Array(await zip.arrayBuffer());
      expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      expect(zip.headers.get("x-diffinery-plugin-sha256")).toBe(sha);
    }
  });

  it("serves the Claude Code plugins for claude.ai's Upload plugin", async () => {
    for (const name of ["diffinery", "diffinery-ci"]) {
      const latest = await get(`/-/claude/${name}.zip`);
      expect(latest.status, name).toBe(200);
      expect(latest.headers.get("content-type")).toBe("application/zip");
      const version = latest.headers.get("x-diffinery-plugin-version")!;
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(latest.headers.get("content-disposition")).toBe(`attachment; filename="${name}-${version}.zip"`);
      const bytes = new Uint8Array(await latest.arrayBuffer());
      expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      expect(latest.headers.get("x-diffinery-plugin-sha256")).toBe(sha);
      const pinned = await get(`/-/claude/${name}-${version}.zip`);
      expect(new Uint8Array(await pinned.arrayBuffer())).toEqual(bytes);
      expect((await get(`/-/claude/${name}-0.0.0.zip`)).status).toBe(404);
    }
    for (const path of ["/-/claude/other.zip", "/-/claude/diffinery", "/-/claude/constructor.zip"]) expect((await get(path)).status, path).toBe(404);
  });

  it("serves the screenshots in docs/images", async () => {
    const res = await get("/docs/images/connected-apps.webp");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer()).slice(8, 12)).toEqual(new TextEncoder().encode("WEBP"));
    expect((await get("/docs/images/nope.webp")).status).toBe(404);
    expect((await get("/docs/images/constructor")).status).toBe(404);
    // Pages show them through their own origin, not the image proxy.
    expect(await (await get("/docs/connect")).text()).toContain('<img src="/docs/images/connected-apps.webp"');
  });

  it("sends moved pages to their new address, as HTML and as Markdown", async () => {
    const html = await get("/docs/agents/claude-and-codex");
    expect(html.status).toBe(301);
    expect(html.headers.get("location")).toBe("/docs/connect");
    expect((await get("/docs/agents/claude-and-codex.md")).headers.get("location")).toBe("/docs/connect.md");
  });

  it("points agents at the connect guides, the plugin and gh from llms.txt", () => {
    const txt = llmsTxt(ORIGIN);
    expect(txt).toContain(`${ORIGIN}/docs/connect.md`);
    expect(txt).toContain("codex plugin marketplace add codician-team/diffinery");
    expect(txt).not.toContain("/codician/diffinery");
    expect(txt).toContain(`\`diffinery setup\` adds both`);
    expect(txt).toContain(`${ORIGIN}/docs/connect/ci-status-in-claude.md`);
    expect(txt).toContain("diffinery auth setup-gh");
  });

  it("returns 404 for unknown pages", async () => {
    expect((await get("/docs/no-such-page")).status).toBe(404);
    expect((await get("/docs/no-such-page.md")).status).toBe(404);
  });

  it("lists the docs in the sitemap, with the date a page was last reviewed when it has one", async () => {
    const res = await get("/sitemap.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`${ORIGIN}/docs/quickstart`);
    const dated = pages.find((p) => p.updated)!;
    expect(xml).toContain(`<url><loc>${ORIGIN}/docs/${dated.slug}</loc><lastmod>${dated.updated}</lastmod></url>`);
  });

  it("returns 404 for an unknown section's llms files", async () => {
    expect((await get("/docs/no-such-section/llms-full.txt")).status).toBe(404);
    expect((await get("/docs/no-such-section/llms.txt")).status).toBe(404);
  });

  it("gives every page structured data: a TechArticle with breadcrumbs, its review date and its questions", async () => {
    for (const p of pages) {
      const html = await (await get(p.slug === "index" ? "/docs" : `/docs/${p.slug}`)).text();
      const m = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
      expect(m, p.slug).toBeTruthy();
      const g = (JSON.parse(m![1]!) as { "@graph": Array<Record<string, unknown>> })["@graph"];
      const article = g.find((x) => x["@type"] === "TechArticle")!;
      expect(article.headline, p.slug).toBe(p.title);
      expect(article.dateModified, p.slug).toBe(p.updated);
      expect(g.some((x) => x["@type"] === "BreadcrumbList"), p.slug).toBe(true);
      expect(g.some((x) => x["@type"] === "FAQPage"), p.slug).toBe(/^## Frequently asked questions\s*$/m.test(p.markdown));
    }
  }, 30_000);
});
