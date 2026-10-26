/** @jsxImportSource hono/jsx */
/**
 * The public docs at /docs, readable without signing in, plus the formats AI
 * agents read: /docs/<page>.md (or any page with `Accept: text/markdown`),
 * /llms.txt, /llms-full.txt, /llms-small.txt, each section's /docs/<section>/llms.txt and llms-full.txt,
 * /docs/api/openapi.json and /docs/search.json.
 * Also serves the CLI download at /-/cli/diffinery.mjs, and the scripts that install it:
 * `curl -fsSL https://diffinery.com/install | bash` and `irm https://diffinery.com/install.ps1 | iex`;
 * and the extension for VS Code, Cursor and other editors built on VS Code (apps/vscode) at
 * /-/vscode/diffinery.vsix, with /-/vscode/version.json (which it updates itself from) and its
 * install scripts at /install-editor and /install-editor.ps1; and the plugin for JetBrains IDEs (apps/jetbrains) at
 * /-/jetbrains/diffinery-jetbrains.zip, with /-/jetbrains/updatePlugins.xml, the custom plugin repository the IDEs
 * install and update it from; and the Claude Code plugins (claude-plugins/) at /-/claude/<name>.zip, which
 * `diffinery setup` downloads (agent setup scripts included) and claude.ai's Upload plugin takes.
 */
import { raw } from "hono/html";
import type { AppContext } from "../auth/principal.js";
import type { Env } from "../env.js";
import { imageProxy } from "../lib/camo.js";
import { isValidLogin, isValidName } from "../lib/util.js";
import { fenceLangs, renderMarkdown } from "../web/markdown.js";
import { fenceHighlighter } from "../web/highlight.js";
import { ICONS } from "../web/assets.js";
import { render, StarButton, type WebApp } from "../web/ui.js";
import { githubStars } from "../web/github-stars.js";
import { pluginZipFor } from "./claude-plugins.js";
import { AGENT_SETUP_SH, CLAUDE_PLUGINS, CLI_BUNDLE, CLI_INSTALL_PS1, CLI_INSTALL_SH, CLI_SHA256, CLI_VERSION, DOCS_IMAGES, EDITOR_EXTENSION_SHA256, EDITOR_EXTENSION_VERSION, EDITOR_EXTENSION_VSIX_B64, EDITOR_INSTALL_PS1, EDITOR_INSTALL_SH, JETBRAINS_PLUGIN_DESCRIPTION, JETBRAINS_PLUGIN_SHA256, JETBRAINS_PLUGIN_SINCE_BUILD, JETBRAINS_PLUGIN_VERSION, JETBRAINS_PLUGIN_ZIP_B64 } from "./content.generated.js";
import { allPages, getPage, headings, llmsFullTxt, llmsSmallTxt, llmsTxt, markdownUrl, nav, pageMarkdown, pageUrl, searchIndex, sectionLlmsFullTxt, sectionLlmsTxt, SLUGS, type Page } from "./pages.js";
import { docsJsonLd } from "../web/site.js";
import { openApiDocument } from "./reference.js";

const origin = (c: AppContext) => c.env.PUBLIC_URL.replace(/\/$/, "");

/** Static per deploy; a short shared cache keeps them fresh after a deploy. */
const PUBLIC = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };

const htmlCache = new Map<string, string>();
async function pageHtml(p: Page, origin: string, env: Env): Promise<string> {
  const key = `${origin} ${p.slug}`;
  let html = htmlCache.get(key);
  if (html === undefined) {
    html = renderMarkdown(p.markdown, { idPrefix: "", highlight: await fenceHighlighter(fenceLangs(p.markdown)), image: imageProxy(env) });
    htmlCache.set(key, html);
  }
  return html;
}

/** Agents ask for Markdown with `Accept: text/markdown`; browsers never do. */
const wantsMarkdown = (c: AppContext) => /\btext\/markdown\b/i.test(c.req.header("accept") ?? "");

function markdownResponse(c: AppContext, body: string): Response {
  return c.body(body, 200, { ...PUBLIC, "content-type": "text/markdown; charset=utf-8", vary: "Accept" });
}

const Sidebar = ({ current }: { current: string }) => (
  <nav class="docs-nav" aria-label="Documentation">
    <div class="docs-search">
      <input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck={false} data-docs-search="1" />
      <ul class="docs-results" role="listbox" hidden></ul>
    </div>
    {nav().map((s) => (
      <div class="docs-sec">
        <h4>{s.title}</h4>
        <ul>
          {s.pages.map((p) => (
            <li>
              <a href={pageUrl(p.slug)} class={p.slug === current ? "on" : undefined} aria-current={p.slug === current ? "page" : undefined}>
                {p.title}
              </a>
            </li>
          ))}
        </ul>
      </div>
    ))}
    <div class="docs-sec">
      <h4>For AI agents</h4>
      <ul>
        <li>
          <a href="/llms.txt">llms.txt</a>
        </li>
        <li>
          <a href="/llms-full.txt">llms-full.txt</a>
        </li>
        <li>
          <a href="/llms-small.txt">llms-small.txt</a>
        </li>
        <li>
          <a href="/docs/api/openapi.json">OpenAPI 3.1</a>
        </li>
      </ul>
    </div>
  </nav>
);

async function docsPage(c: AppContext, p: Page | null, status = 200): Promise<Response> {
  const o = origin(c);
  const html = p ? await pageHtml(p, o, c.env) : "";
  const slug = p?.slug ?? "";
  const i = SLUGS.indexOf(slug);
  const prev = i > 0 ? getPage(SLUGS[i - 1]!, o) : null;
  const next = i >= 0 && i < SLUGS.length - 1 ? getPage(SLUGS[i + 1]!, o) : null;
  const toc = p ? headings(p.markdown).filter((h) => h.level === 2 || p.markdown.length < 60_000) : [];
  const stars = await githubStars(c);
  const body = (
    <div class="docs">
      <style>{raw(DOCS_CSS)}</style>
      <details class="docs-mnav">
        <summary>{p ? `${p.section}: ${p.title}` : "Documentation"}</summary>
        <Sidebar current={slug} />
      </details>
      <aside class="docs-side">
        <Sidebar current={slug} />
      </aside>
      <article class="docs-main">
        {p ? (
          <>
            <div class="docs-crumbs">
              <a href="/docs">Docs</a> <span class="faint">/</span> <span class="muted">{p.section}</span>
            </div>
            <h1>{p.title}</h1>
            <p class="docs-lead">{p.description}</p>
            <div class="docs-actions">
              <a class="btn sm" href={markdownUrl(slug)} title="This page as plain Markdown">
                {raw(ICONS.file)} View as Markdown
              </a>
              <button type="button" class="btn sm" data-copy-page={markdownUrl(slug)} title="Copy this page as Markdown, to paste into an AI assistant">
                {raw(ICONS.copy)} <span>Copy page</span>
              </button>
            </div>
            <div class="markdown docs-body">{raw(html)}</div>
            <nav class="docs-pn" aria-label="Previous and next page">
              {prev ? (
                <a href={pageUrl(prev.slug)} class="prev">
                  <span class="faint small">Previous</span>
                  <span>{prev.title}</span>
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a href={pageUrl(next.slug)} class="next">
                  <span class="faint small">Next</span>
                  <span>{next.title}</span>
                </a>
              ) : (
                <span />
              )}
            </nav>
          </>
        ) : (
          <>
            <h1>Page not found</h1>
            <p class="docs-lead">There's no docs page at this address. Search the docs, or start from the overview.</p>
            <p>
              <a class="btn primary" href="/docs">
                Go to the overview
              </a>
            </p>
          </>
        )}
      </article>
      <aside class="docs-toc" aria-label="On this page">
        {toc.length ? (
          <>
            <h4>On this page</h4>
            <ul>
              {toc.map((h) => (
                <li class={h.level === 3 ? "l3" : undefined}>
                  <a href={`#${h.id}`}>{h.text}</a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div class="docs-star">
          <p>Diffinery is open source. A star on GitHub helps other people find it.</p>
          <StarButton stars={stars} compact />
        </div>
      </aside>
    </div>
  );
  if (p) {
    c.header("link", `<${o}${markdownUrl(slug)}>; rel="alternate"; type="text/markdown", <${o}/llms.txt>; rel="describedby"; type="text/plain"`);
    c.header("vary", "Accept");
  }
  return render(
    c,
    {
      title: p ? (slug === "index" ? "Documentation" : `${p.title} · Docs`) : "Page not found · Docs",
      description: p?.description,
      status,
      wide: true,
      modified: p?.updated,
      jsonLd: p ? docsJsonLd(o, { url: `${o}${pageUrl(slug)}`, title: p.title, description: p.description, section: p.section, markdown: p.markdown, updated: p.updated, home: slug === "index" }) : undefined,
      head: p ? <link rel="alternate" type="text/markdown" href={markdownUrl(slug)} title={`${p.title} (Markdown)`} /> : null,
      script: DOCS_JS,
    },
    body,
  );
}

/** Pages that moved, old slug to new: links people and agents saved keep working. */
const MOVED: Record<string, string> = {
  "agents/claude-and-codex": "connect",
};

/** The custom plugin repository JetBrains IDEs read: one plugin, the version this deploy serves. */
export function jetbrainsRepository(origin: string, fileName: string): string {
  const description = JETBRAINS_PLUGIN_DESCRIPTION.replaceAll("https://diffinery.com", origin).replaceAll("]]>", "]]]]><![CDATA[>");
  return `<?xml version="1.0" encoding="UTF-8"?>
<plugins>
  <plugin id="com.diffinery" url="${origin}/-/jetbrains/${fileName}" version="${JETBRAINS_PLUGIN_VERSION}">
    <idea-version since-build="${JETBRAINS_PLUGIN_SINCE_BUILD}"/>
    <name>Diffinery</name>
    <vendor url="${origin}">Diffinery</vendor>
    <description><![CDATA[${description}]]></description>
  </plugin>
</plugins>
`;
}

export function registerDocs(web: WebApp): void {
  web.get("/llms.txt", (c) => c.body(llmsTxt(origin(c)), 200, { ...PUBLIC, "content-type": "text/plain; charset=utf-8" }));
  web.get("/llms-full.txt", (c) => c.body(llmsFullTxt(origin(c)), 200, { ...PUBLIC, "content-type": "text/plain; charset=utf-8" }));
  web.get("/llms-small.txt", (c) => c.body(llmsSmallTxt(origin(c)), 200, { ...PUBLIC, "content-type": "text/plain; charset=utf-8" }));
  web.get("/docs/llms.txt", (c) => c.redirect("/llms.txt", 301));
  web.get("/docs/llms-full.txt", (c) => c.redirect("/llms-full.txt", 301));
  // One docs section at a time (pages.ts SECTIONS), for assistants that only need, say, the Actions pages.
  web.get("/docs/:section/llms.txt", (c) => {
    const txt = sectionLlmsTxt(origin(c), c.req.param("section"));
    return txt ? c.body(txt, 200, { ...PUBLIC, "content-type": "text/plain; charset=utf-8" }) : c.text(`No such docs section. See ${origin(c)}/llms.txt\n`, 404);
  });
  web.get("/docs/:section/llms-full.txt", (c) => {
    const txt = sectionLlmsFullTxt(origin(c), c.req.param("section"));
    return txt ? c.body(txt, 200, { ...PUBLIC, "content-type": "text/plain; charset=utf-8" }) : c.text(`No such docs section. See ${origin(c)}/llms.txt\n`, 404);
  });
  web.get("/docs/api/openapi.json", (c) => c.body(JSON.stringify(openApiDocument(origin(c), CLI_VERSION), null, 2), 200, { ...PUBLIC, "content-type": "application/json; charset=utf-8" }));
  web.get("/docs/search.json", (c) => c.body(JSON.stringify(searchIndex(origin(c))), 200, { ...PUBLIC, "content-type": "application/json; charset=utf-8" }));
  web.get("/-/cli/diffinery.mjs", (c) =>
    c.body(CLI_BUNDLE, 200, {
      ...PUBLIC,
      "content-type": "text/javascript; charset=utf-8",
      "content-disposition": 'inline; filename="diffinery.mjs"',
      "x-diffinery-cli-version": CLI_VERSION,
    }),
  );

  // The install scripts download the CLI from the server that served them (a self-hosted instance installs its own build).
  const installScript = (c: AppContext, script: string) =>
    c.body(script.replaceAll("__DIFFINERY_URL__", origin(c)), 200, { ...PUBLIC, "content-type": "text/plain; charset=utf-8", "x-diffinery-cli-version": CLI_VERSION });
  web.get("/install", (c) => installScript(c, CLI_INSTALL_SH));
  web.get("/install.sh", (c) => installScript(c, CLI_INSTALL_SH));
  web.get("/install.ps1", (c) => installScript(c, CLI_INSTALL_PS1));
  // Agent setup's script (lib/agent-setup.ts): the same for everyone, with the repository's name in it. It
  // looks nothing up, so it says nothing about whether the repository exists, and it holds no secret.
  web.get("/:owner/:repo/agent-setup.sh", (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    if (!isValidLogin(owner) || !isValidName(repo)) return c.text("not a repository name\n", 404);
    const script = AGENT_SETUP_SH.replaceAll("__DIFFINERY_URL__", origin(c)).replaceAll("__DIFFINERY_REPO__", `${owner}/${repo}`).replaceAll("__DIFFINERY_CLI_SHA256__", CLI_SHA256);
    return c.body(script, 200, { ...PUBLIC, "content-type": "text/plain; charset=utf-8", "x-diffinery-cli-version": CLI_VERSION });
  });

  const vsixName = `diffinery-${EDITOR_EXTENSION_VERSION}.vsix`;
  let vsix: Uint8Array<ArrayBuffer> | undefined;
  const vsixBody = (c: AppContext) => {
    vsix ??= Uint8Array.from(atob(EDITOR_EXTENSION_VSIX_B64), (ch) => ch.charCodeAt(0));
    return c.body(vsix, 200, {
      ...PUBLIC,
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${vsixName}"`,
      "x-diffinery-extension-version": EDITOR_EXTENSION_VERSION,
    });
  };
  web.get("/-/vscode/diffinery.vsix", vsixBody);
  web.get(`/-/vscode/${vsixName}`, vsixBody);
  web.get("/-/vscode/version.json", (c) =>
    c.json({ version: EDITOR_EXTENSION_VERSION, url: `/-/vscode/${vsixName}`, sha256: EDITOR_EXTENSION_SHA256 }, 200, PUBLIC),
  );
  web.get("/install-editor", (c) => installScript(c, EDITOR_INSTALL_SH));
  web.get("/install-editor.sh", (c) => installScript(c, EDITOR_INSTALL_SH));
  web.get("/install-editor.ps1", (c) => installScript(c, EDITOR_INSTALL_PS1));

  // JetBrains IDEs install the plugin from a custom plugin repository: Settings → Plugins → ⚙ → Manage Plugin
  // Repositories → this updatePlugins.xml. They check it for updates like the Marketplace.
  const pluginName = `diffinery-jetbrains-${JETBRAINS_PLUGIN_VERSION}.zip`;
  let pluginZip: Uint8Array<ArrayBuffer> | undefined;
  const pluginBody = (c: AppContext) => {
    pluginZip ??= Uint8Array.from(atob(JETBRAINS_PLUGIN_ZIP_B64), (ch) => ch.charCodeAt(0));
    return c.body(pluginZip, 200, {
      ...PUBLIC,
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${pluginName}"`,
      "x-diffinery-plugin-version": JETBRAINS_PLUGIN_VERSION,
      "x-diffinery-plugin-sha256": JETBRAINS_PLUGIN_SHA256,
    });
  };
  web.get("/-/jetbrains/diffinery-jetbrains.zip", pluginBody);
  web.get(`/-/jetbrains/${pluginName}`, pluginBody);
  web.get("/-/jetbrains/updatePlugins.xml", (c) =>
    c.body(jetbrainsRepository(origin(c), pluginName), 200, { ...PUBLIC, "content-type": "application/xml; charset=utf-8" }),
  );

  // The Claude Code plugins, for `diffinery setup` (which checks the SHA-256 header) and claude.ai's Upload
  // plugin, neither of which can read the plugin repository. /-/claude/<name>.zip is always the current version; the versioned name stays the same bytes.
  // A self-hosted instance's copies point the plugins at itself (claude-plugins.ts).
  const claudeZips = new Map<string, Promise<{ bytes: Uint8Array; sha256: string }>>();
  web.get("/-/claude/:file", async (c) => {
    const file = c.req.param("file");
    const m = /^([a-z][a-z0-9-]*?)(?:-(\d+\.\d+\.\d+))?\.zip$/.exec(file);
    const plugin = m && Object.hasOwn(CLAUDE_PLUGINS, m[1]!) ? CLAUDE_PLUGINS[m[1]!]! : null;
    if (!m || !plugin || (m[2] !== undefined && m[2] !== plugin.version)) return c.text("Not found", 404);
    const key = `${origin(c)} ${m[1]}`;
    let built = claudeZips.get(key);
    if (!built) {
      claudeZips.set(key, (built = pluginZipFor(origin(c), Uint8Array.from(atob(plugin.zip), (ch) => ch.charCodeAt(0)), plugin.sha256)));
      built.catch(() => claudeZips.delete(key));
    }
    const { bytes, sha256 } = await built;
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      ...PUBLIC,
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${m[1]}-${plugin.version}.zip"`,
      "x-diffinery-plugin-version": plugin.version,
      "x-diffinery-plugin-sha256": sha256,
    });
  });

  // Pictures for the docs pages (docs/images/), decoded once per isolate.
  const images = new Map<string, Uint8Array<ArrayBuffer>>();
  web.get("/docs/images/:file", (c) => {
    const name = c.req.param("file");
    const img = Object.hasOwn(DOCS_IMAGES, name) ? DOCS_IMAGES[name]! : null;
    if (!img) return c.text("Not found", 404);
    let bytes = images.get(name);
    if (!bytes) images.set(name, (bytes = Uint8Array.from(atob(img.data), (ch) => ch.charCodeAt(0))));
    return c.body(bytes, 200, { ...PUBLIC, "cache-control": "public, max-age=86400", "content-type": img.type });
  });

  web.get("/docs", (c) => {
    const p = getPage("index", origin(c))!;
    return wantsMarkdown(c) ? markdownResponse(c, pageMarkdown(p, origin(c))) : docsPage(c, p);
  });
  web.get("/docs/:slug{.+}", (c) => {
    let slug = c.req.param("slug").replace(/\/+$/, "");
    if (c.req.path.endsWith("/") && slug) return c.redirect(pageUrl(slug), 301);
    const md = slug.endsWith(".md");
    if (md) slug = slug.slice(0, -3);
    if (slug === "index" && !md) return c.redirect("/docs", 301);
    if (Object.hasOwn(MOVED, slug)) return c.redirect(md ? markdownUrl(MOVED[slug]!) : pageUrl(MOVED[slug]!), 301);
    const p = getPage(slug, origin(c));
    if (!p) {
      if (md) return c.body(`# Not found\n\nThere is no docs page "${slug}". See ${origin(c)}/llms.txt for every page.\n`, 404, { "content-type": "text/markdown; charset=utf-8" });
      return docsPage(c, null, 404);
    }
    return md || wantsMarkdown(c) ? markdownResponse(c, pageMarkdown(p, origin(c))) : docsPage(c, p);
  });
}

/** Every docs URL for the sitemap, with the date the page was last reviewed when its frontmatter says. */
export const docsSitemapEntries = (): Array<{ path: string; updated?: string }> => SLUGS.map((slug) => ({ path: pageUrl(slug), updated: getPage(slug, "")?.updated }));
export { allPages };

const DOCS_CSS = `
main.wrap:has(.docs){padding-top:0}
.docs{display:grid;grid-template-columns:248px minmax(0,1fr) 220px;gap:40px;max-width:1240px;margin:0 auto}
.docs-side,.docs-toc{position:sticky;top:52px;align-self:start;max-height:calc(100vh - 52px);overflow:auto;padding:20px 0 40px}
.docs-nav h4,.docs-toc h4{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin:18px 0 6px;font-weight:600}
.docs-nav ul,.docs-toc ul{list-style:none;margin:0;padding:0}
.docs-nav li a{display:block;padding:4px 10px;border-radius:6px;color:var(--fg2);font-size:13.5px}
.docs-nav li a:hover{background:var(--bg-hover);color:var(--fg);text-decoration:none}
.docs-nav li a.on{background:var(--accent-soft);color:var(--fg);font-weight:550}
.docs-search{position:relative}
.docs-results{position:absolute;z-index:30;left:0;right:-160px;top:calc(100% + 4px);background:var(--bg);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);list-style:none;margin:0;padding:4px;max-height:60vh;overflow:auto}
.docs-results li a{display:block;padding:7px 10px;border-radius:6px;color:var(--fg)}
.docs-results li a:hover,.docs-results li.sel a{background:var(--bg-hover);text-decoration:none}
.docs-results .r-t{font-weight:550}.docs-results .r-s{display:block;font-size:12px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.docs-results .r-none{padding:8px 10px;color:var(--fg2)}
.docs-main{padding:28px 0 60px;min-width:0}
.docs-main h1{font-size:30px;letter-spacing:-.02em;margin:6px 0 8px}
.docs-crumbs{font-size:13px}
.docs-lead{font-size:16px;color:var(--fg2);margin:0 0 14px}
.docs-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 22px;padding-bottom:18px;border-bottom:1px solid var(--border2)}
.docs-actions .st svg{width:14px;height:14px}
.docs-body{font-size:15px;line-height:1.7}
.docs-body h2{font-size:21px;margin-top:34px;scroll-margin-top:64px}.docs-body h3{font-size:16.5px;margin-top:26px;scroll-margin-top:64px}.docs-body h4{scroll-margin-top:64px}
.docs-body pre{position:relative}.docs-body pre .cp{position:absolute;top:6px;right:6px;opacity:0;transition:opacity .15s}
.docs-body pre:hover .cp,.docs-body pre .cp:focus{opacity:1}
.docs-body blockquote{background:var(--bg2);border-left-color:var(--accent);border-radius:0 6px 6px 0;padding:10px 14px;color:var(--fg)}
.docs-body blockquote p:last-child{margin:0}
.docs-body table{font-size:13.5px}.docs-body td code{white-space:nowrap}
.docs-body p>img{display:block;width:auto;max-width:100%;max-height:640px;margin:18px auto;border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow)}
.docs-pn{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:40px;padding-top:20px;border-top:1px solid var(--border2)}
.docs-pn a{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--r);color:var(--fg)}
.docs-pn a:hover{border-color:var(--accent);text-decoration:none}.docs-pn .next{text-align:right}
.docs-toc li a{display:block;padding:3px 0 3px 10px;border-left:2px solid var(--border2);color:var(--fg2);font-size:12.5px;line-height:1.4}
.docs-toc li.l3 a{padding-left:22px}
.docs-toc li a:hover{color:var(--fg);text-decoration:none}.docs-toc li a.on{color:var(--fg);border-left-color:var(--accent)}
.docs-star{margin-top:22px;padding-top:16px;border-top:1px solid var(--border2)}.docs-star p{margin:0 0 10px;font-size:12.5px;line-height:1.5;color:var(--fg2)}
.docs-mnav{display:none}
@media (max-width:1180px){.docs{grid-template-columns:232px minmax(0,1fr);gap:32px}.docs-toc{display:none}}
@media (max-width:820px){.docs{grid-template-columns:minmax(0,1fr);gap:0}.docs-side{display:none}
.docs-mnav{display:block;position:sticky;top:52px;z-index:15;background:var(--canvas);border-bottom:1px solid var(--border);margin:0 -12px;padding:0 12px}
.docs-mnav summary{padding:10px 0;cursor:pointer;font-weight:550}.docs-mnav[open]{max-height:calc(100vh - 52px);overflow:auto}
.docs-results{right:0}.docs-main{padding-top:16px}.docs-main h1{font-size:25px}}
`;

const DOCS_JS = `(()=>{
const d=document,$=(s,r=d)=>r.querySelector(s),$$=(s,r=d)=>[...r.querySelectorAll(s)];
// Copy buttons on code blocks.
$$('.docs-body pre').forEach(pre=>{const b=d.createElement('button');b.type='button';b.className='btn sm cp';b.textContent='Copy';
  b.addEventListener('click',()=>{const t=(pre.querySelector('code')||pre).innerText;navigator.clipboard.writeText(t).then(()=>{b.textContent='Copied';setTimeout(()=>{b.textContent='Copy'},1200)})});pre.appendChild(b)});
// Copy the whole page as Markdown.
$$('[data-copy-page]').forEach(b=>b.addEventListener('click',async()=>{const s=b.querySelector('span');
  try{const r=await fetch(b.dataset.copyPage,{headers:{accept:'text/markdown'}});await navigator.clipboard.writeText(await r.text());s.textContent='Copied'}catch(_){s.textContent='Copy failed'}
  setTimeout(()=>{s.textContent='Copy page'},1500)}));
// Highlight the current section in "On this page".
const toc=$$('.docs-toc a');if(toc.length&&'IntersectionObserver'in window){const map=new Map(toc.map(a=>[decodeURIComponent(a.hash.slice(1)),a]));
  const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){toc.forEach(a=>a.classList.remove('on'));const a=map.get(e.target.id);a&&a.classList.add('on')}})},{rootMargin:'-60px 0px -70% 0px'});
  $$('.docs-body h2[id],.docs-body h3[id]').forEach(h=>io.observe(h))}
// Search: a small index fetched on first use, ranked by title, heading and text matches.
let idx=null,loading=null;const load=()=>loading||(loading=fetch('/docs/search.json').then(r=>r.json()).then(j=>{idx=j.map(p=>Object.assign(p,{tl:p.t.toLowerCase(),xl:p.x.toLowerCase(),hl:p.h.map(h=>h[1].toLowerCase())}))}));
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function search(q){const terms=q.toLowerCase().split(/\\s+/).filter(Boolean);if(!terms.length||!idx)return[];const out=[];
  for(const p of idx){let score=0,hit=null;for(const t of terms){let s=0;if(p.tl.includes(t))s+=10;p.hl.forEach((h,i)=>{if(h.includes(t)){s+=4;if(!hit)hit=p.h[i]}});if(p.xl.includes(t))s+=1;if(!s){score=0;break}score+=s}
    if(score){const pos=p.xl.indexOf(terms[0]);out.push({p,score,hit,snip:pos>=0?p.x.slice(Math.max(0,pos-40),pos+90):p.d})}}
  return out.sort((a,b)=>b.score-a.score).slice(0,12)}
$$('[data-docs-search]').forEach(inp=>{const list=inp.parentElement.querySelector('.docs-results');let sel=-1;
  const show=()=>{const q=inp.value.trim();if(!q){list.hidden=true;return}const rs=search(q);sel=-1;list.hidden=false;
    list.innerHTML=rs.length?rs.map(r=>{const href=(r.p.u||(r.p.s==='index'?'/docs':'/docs/'+r.p.s))+(r.hit?'#'+r.hit[0]:'');
      return '<li><a href="'+esc(href)+'"><span class="r-t">'+esc(r.p.t)+(r.hit?' › '+esc(r.hit[1]):'')+'</span><span class="r-s">'+esc(r.p.c+' · '+r.snip)+'</span></a></li>'}).join(''):'<li class="r-none">No results</li>'};
  inp.addEventListener('focus',()=>{load().then(show)});inp.addEventListener('input',()=>{load().then(show)});
  inp.addEventListener('keydown',e=>{const items=$$('li a',list);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();sel=(sel+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;
      $$('li',list).forEach((li,i)=>li.classList.toggle('sel',i===sel))}else if(e.key==='Enter'){const a=items[sel<0?0:sel];if(a){e.preventDefault();location.assign(a.href)}}else if(e.key==='Escape'){list.hidden=true;inp.blur()}});
  d.addEventListener('click',e=>{if(!inp.parentElement.contains(e.target))list.hidden=true})});
d.addEventListener('keydown',e=>{if(e.key==='/'&&!/input|textarea|select/i.test((e.target.tagName||''))&&!e.target.isContentEditable){const i=$$('[data-docs-search]').find(x=>x.offsetParent);if(i){e.preventDefault();i.focus()}}});
})();`;
