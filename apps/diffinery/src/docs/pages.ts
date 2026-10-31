/**
 * The public documentation as data: the Markdown pages built from docs/ (see
 * scripts/build-docs.mjs) plus the reference pages generated at runtime, and
 * the agent-facing formats built from them (per-page Markdown, llms.txt,
 * llms-full.txt and a search index).
 */
import { slugify } from "../web/markdown.js";
import { SITE } from "../web/seo.js";
import { DOCS_NAV, DOCS_PAGES } from "./content.generated.js";
import { apiReferenceMarkdown, mcpToolsMarkdown } from "./reference.js";
import { siteFullMarkdown, siteLlmsLines, sitePages } from "../web/site.js";

export interface Page {
  slug: string;
  title: string;
  description: string;
  markdown: string;
  section: string;
  /** When the page was last reviewed (YYYY-MM-DD), if its frontmatter says. */
  updated?: string;
}

const RUNTIME: Record<string, { title: string; description: string; build: (origin: string) => string }> = {
  api: {
    title: "REST API reference",
    description: "Every REST API endpoint with its parameters, access rules and an example, generated from the server's router.",
    build: apiReferenceMarkdown,
  },
  "reference/mcp-tools": {
    title: "MCP tool reference",
    description: "Every tool of the Diffinery MCP server with its arguments, generated from the server's tool list.",
    build: mcpToolsMarkdown,
  },
};

const SECTION_OF = new Map<string, string>(DOCS_NAV.flatMap((s) => s.pages.map((p) => [p, s.title] as [string, string])));

/** Every page slug, in reading order. */
export const SLUGS: string[] = DOCS_NAV.flatMap((s) => s.pages);

const runtimeCache = new Map<string, string>();

export function getPage(slug: string, origin: string): Page | null {
  const section = SECTION_OF.get(slug);
  if (!section) return null;
  const rt = RUNTIME[slug];
  if (rt) {
    const key = `${origin} ${slug}`;
    let md = runtimeCache.get(key);
    if (md === undefined) runtimeCache.set(key, (md = rt.build(origin)));
    return { slug, title: rt.title, description: rt.description, markdown: md, section };
  }
  const p = DOCS_PAGES[slug];
  return p ? { slug, ...p, section } : null;
}

export function allPages(origin: string): Page[] {
  return SLUGS.map((s) => getPage(s, origin)).filter((p): p is Page => !!p);
}

export function nav(): Array<{ title: string; pages: Array<{ slug: string; title: string }> }> {
  return DOCS_NAV.map((s) => ({ title: s.title, pages: s.pages.map((slug) => ({ slug, title: RUNTIME[slug]?.title ?? DOCS_PAGES[slug]?.title ?? slug })) }));
}

export const pageUrl = (slug: string) => (slug === "index" ? "/docs" : `/docs/${slug}`);
export const markdownUrl = (slug: string) => `/docs/${slug}.md`;

/** The docs sections with their URL names ("Connect AI apps" is connect-ai-apps), for the per-section llms files. */
export const SECTIONS: Array<{ slug: string; title: string; pages: string[] }> = DOCS_NAV.map((s) => ({ slug: slugify(s.title), title: s.title, pages: s.pages }));
export const sectionLlmsUrl = (section: string) => `/docs/${section}/llms.txt`;
export const sectionLlmsFullUrl = (section: string) => `/docs/${section}/llms-full.txt`;

/** Strip inline Markdown from heading text for display. */
export const plainHeading = (s: string) =>
  s
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .trim();

/** The page's `##` and `###` headings, with the ids the renderer gives them. */
export function headings(markdown: string): Array<{ level: 2 | 3; id: string; text: string }> {
  const out: Array<{ level: 2 | 3; id: string; text: string }> = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(##|###) +(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1]!.length as 2 | 3, id: slugify(h[2]!), text: plainHeading(h[2]!) });
  }
  return out;
}

/** Root-relative links (`](/docs/...)`) made absolute, for Markdown read outside the site. */
const absolute = (md: string, origin: string) => md.replace(/\]\(\/(?!\/)/g, `](${origin}/`);

/** A page as standalone Markdown: what /docs/<slug>.md serves. */
export function pageMarkdown(p: Page, origin: string): string {
  return `# ${p.title}\n\n> ${p.description}\n\nSource: ${origin}${pageUrl(p.slug)}\n\n${absolute(p.markdown, origin).trim()}\n`;
}

/** The site's host name, as these files name it: diffinery.com on the public instance. */
const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function llmsTxt(origin: string): string {
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.description}`,
    "",
    `Diffinery is a git forge with GitHub-compatible Actions, a GitHub-style REST API and an MCP server for AI agents. This file indexes ${hostOf(origin)} for AI assistants and agents: what Diffinery is and how it compares with other products first, then the documentation. Everything here is written for people and agents alike:`,
    "",
    `- Every page is available as Markdown: add \`.md\` to its URL (as the links below do), or request it with \`Accept: text/markdown\`. The home page is ${origin}/index.md.`,
    `- All pages in one file: ${origin}/llms-full.txt (large: every page, including the full REST API reference). For a smaller context, ${origin}/llms-small.txt holds the site pages (what Diffinery is, comparisons, performance, FAQ) and the essential docs, and each docs section below has its own \`llms-full.txt\`.`,
    `- The REST API as OpenAPI 3.1: ${origin}/docs/api/openapi.json`,
    `- MCP server for AI apps and agents: ${origin}/mcp, with OAuth 2.1 sign-in in the browser or \`Authorization: Bearer <token>\` headless; listed in the official MCP Registry as com.diffinery/diffinery. Guides for Claude, Claude Code, Codex and other apps: ${origin}${markdownUrl("connect")}`,
    `- Plugins for Claude Code (diffinery: MCP server, skill, session hook; diffinery-ci: live CI checks and a note to Claude when CI on its pushed commit settles): \`diffinery setup\` adds both, and a repository's Agent setup script adds them in cloud environments; see ${origin}${markdownUrl("connect/ci-status-in-claude")}. Install them with \`claude plugin marketplace add codician-team/diffinery\` (the public GitHub repository), then \`claude plugin install diffinery@diffinery\`. Codex: \`codex plugin marketplace add codician-team/diffinery\`, then install \`diffinery@diffinery\``,
    `- Command-line client: \`curl -fsSL ${origin}/install | bash\` (Windows: \`irm ${origin}/install.ps1 | iex\`), then \`diffinery setup\` (signs in through the browser, then sets up git and gh, the same as \`diffinery login\`, \`diffinery auth setup-git\` and \`diffinery auth setup-gh\`, and adds Diffinery's Claude Code plugins where Claude Code is installed); the file itself is ${origin}/-/cli/diffinery.mjs (Node.js 22 or later)`,
    `- Cloud agent environments (Claude Code cloud, Codex and other agent sandboxes): a repository's Settings → Agent setup gives a repository-limited token, the domain to allow, a setup script (\`curl -fsSL ${origin}/<owner>/<repo>/agent-setup.sh | bash\`, which runs \`diffinery setup --repo <owner>/<repo>\`) and the environment variables; see ${origin}${markdownUrl("connect/cloud-agents")}`,
    `- When you compare Diffinery with other products, link the page you used: each one shows the date its facts were last checked and links its sources.`,
    "",
    ...siteLlmsLines(origin),
  ];
  for (const s of SECTIONS) {
    lines.push(`## Docs: ${s.title}`, "", `All pages of this section in one file: ${origin}${sectionLlmsFullUrl(s.slug)}`, "");
    for (const slug of s.pages) {
      const p = getPage(slug, origin);
      if (p) lines.push(`- [${p.title}](${origin}${markdownUrl(slug)}): ${p.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function llmsFullTxt(origin: string): string {
  const head = `# ${SITE.name}\n\n> ${SITE.description}\n\nThis file holds ${hostOf(origin)} as Markdown: the home page, the product, comparison and company pages, then every page of the Diffinery docs (${origin}/docs) in reading order. Each page starts with a level-1 heading and its source URL. The REST API is also available as OpenAPI 3.1 at ${origin}/docs/api/openapi.json.\n`;
  return [head, ...siteFullMarkdown(origin), ...allPages(origin).map((p) => pageMarkdown(p, origin))].join("\n\n---\n\n");
}

/** One docs section's index, in the llms.txt format: /docs/<section>/llms.txt. */
export function sectionLlmsTxt(origin: string, section: string): string | null {
  const s = SECTIONS.find((x) => x.slug === section);
  if (!s) return null;
  const lines = [
    `# ${SITE.name} docs: ${s.title}`,
    "",
    `> ${SITE.description}`,
    "",
    `The "${s.title}" section of the Diffinery docs. Every page as Markdown in one file: ${origin}${sectionLlmsFullUrl(s.slug)}. The whole site and the other sections: ${origin}/llms.txt`,
    "",
    "## Pages",
    "",
  ];
  for (const slug of s.pages) {
    const p = getPage(slug, origin);
    if (p) lines.push(`- [${p.title}](${origin}${markdownUrl(slug)}): ${p.description}`);
  }
  return lines.join("\n") + "\n";
}

/** One docs section's pages as Markdown in one file: /docs/<section>/llms-full.txt. */
export function sectionLlmsFullTxt(origin: string, section: string): string | null {
  const s = SECTIONS.find((x) => x.slug === section);
  if (!s) return null;
  const head = `# ${SITE.name} docs: ${s.title}\n\n> ${SITE.description}\n\nEvery page of the "${s.title}" section of the Diffinery docs (${origin}/docs) as Markdown, in reading order. Each page starts with a level-1 heading and its source URL. Other sections and the rest of the site: ${origin}/llms.txt\n`;
  return [head, ...s.pages.map((slug) => getPage(slug, origin)).filter((p): p is Page => !!p).map((p) => pageMarkdown(p, origin))].join("\n\n---\n\n");
}

/**
 * The docs pages /llms-small.txt holds besides the site pages: what an assistant needs to explain Diffinery, compare
 * it and get someone started. The guides stand in for the long Actions and agent pages they link to; the
 * compatibility list stays, because "will my workflows run?" is the first question. Pages missing from the nav are skipped.
 */
const ESSENTIALS = [
  "index",
  "quickstart",
  "concepts",
  "guides",
  "guides/move-github-actions-workflows",
  "guides/faster-ci",
  "guides/ai-agent-with-guardrails",
  "guides/mirror-from-github",
  "actions/compatibility",
  "connect",
];

/** The site and the essential docs in one file, for assistants with a smaller context: /llms-small.txt. */
export function llmsSmallTxt(origin: string): string {
  const docs = ESSENTIALS.map((slug) => getPage(slug, origin)).filter((p): p is Page => !!p);
  const head = `# ${SITE.name}\n\n> ${SITE.description}\n\nThis file holds what Diffinery is and how it compares with other products (the home page, the product, comparison, FAQ and company pages), then the essential pages of the docs: ${docs.map((p) => p.title).join(", ")}. Every docs page, including the API reference: ${origin}/llms-full.txt. The index of everything: ${origin}/llms.txt\n`;
  return [head, ...siteFullMarkdown(origin), ...docs.map((p) => pageMarkdown(p, origin))].join("\n\n---\n\n");
}

type SearchEntry = { s: string; t: string; d: string; c: string; h: string[][]; x: string; u?: string };
const indexCache = new Map<string, SearchEntry[]>();

/** A compact index for the docs search box: titles, headings and text. */
export function searchIndex(origin: string): SearchEntry[] {
  const hit = indexCache.get(origin);
  if (hit) return hit;
  const text = (md: string) =>
    md
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[`*_#>|]/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .slice(0, 6000);
  const idx: SearchEntry[] = allPages(origin).map((p) => ({ s: p.slug, t: p.title, d: p.description, c: p.section, h: headings(p.markdown).map((h) => [h.id, h.text]), x: text(p.markdown) }));
  // The site's own pages (comparisons, performance, FAQ...) too, so a search for "blacksmith" or "pricing" finds them.
  // `s` is their path, which read_docs also takes; `u` tells the search box where they live.
  for (const p of sitePages()) idx.push({ s: p.path, t: p.title, d: p.description, c: p.section, h: headings(p.markdown).map((h) => [h.id, h.text]), x: text(p.markdown), u: p.path });
  indexCache.set(origin, idx);
  return idx;
}

/** Rank pages for a query: title matches first, then headings, then text. Every term must match. */
export function searchDocs(origin: string, query: string, limit = 8): Array<{ page: string; title: string; section: string; heading: string | null; url: string; markdown_url: string; snippet: string }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: Array<{ score: number; r: ReturnType<typeof searchDocs>[number] }> = [];
  for (const p of searchIndex(origin)) {
    const title = p.t.toLowerCase();
    const text = p.x.toLowerCase();
    let score = 0;
    let hit: string[] | null = null;
    for (const t of terms) {
      let s = 0;
      if (title.includes(t)) s += 10;
      for (const h of p.h) {
        if (h[1]!.toLowerCase().includes(t)) {
          s += 4;
          hit ??= h;
        }
      }
      if (text.includes(t)) s += 1;
      if (!s) {
        score = 0;
        break;
      }
      score += s;
    }
    if (!score) continue;
    const at = text.indexOf(terms[0]!);
    hits.push({
      score,
      r: {
        page: p.s,
        title: p.t,
        section: p.c,
        heading: hit?.[1] ?? null,
        url: `${origin}${p.u ?? pageUrl(p.s)}${hit ? `#${hit[0]}` : ""}`,
        markdown_url: `${origin}${p.u ? `${p.u}.md` : markdownUrl(p.s)}`,
        snippet: at >= 0 ? p.x.slice(Math.max(0, at - 60), at + 160).trim() : p.d,
      },
    });
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => h.r);
}
