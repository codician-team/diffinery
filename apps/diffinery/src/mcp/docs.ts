import { HttpError } from "../lib/util.js";
import { getPage, pageMarkdown, searchDocs, SLUGS } from "../docs/pages.js";
import { sitePage, sitePageMarkdown, sitePages } from "../web/site.js";
import type { Tool } from "./server.js";

const origin = (c: { env: { PUBLIC_URL: string } }) => c.env.PUBLIC_URL.replace(/\/$/, "");

/** The public docs, for agents that are already connected over MCP. */
export const DOCS_TOOLS: Record<string, Tool> = {
  search_docs: {
    description: "Search the Diffinery documentation (workflows, API, git, agents, settings) and the site's product, comparison and FAQ pages. Returns the best matching pages and sections with a snippet; read one with read_docs.",
    input: { query: { type: "string", description: "Words to look for, like 'merge queue' or 'workflow_dispatch inputs'" } },
    required: ["query"],
    readOnly: true,
    run: async (c, a) => {
      const q = typeof a.query === "string" ? a.query.trim() : "";
      if (!q) throw new HttpError(422, "query is required");
      return { results: searchDocs(origin(c), q) };
    },
  },
  read_docs: {
    description: `Read a Diffinery documentation page as Markdown. Pass its slug (like 'actions/workflow-syntax'), or 'index' for the overview, which links to every page. Site pages work too, by path (like '/compare/github' or '/faq').`,
    input: { page: { type: "string", description: "Page slug or docs URL" } },
    required: ["page"],
    readOnly: true,
    run: async (c, a) => {
      const raw = typeof a.page === "string" ? a.page.trim() : "";
      const slug = docsSlug(raw);
      const p = getPage(slug, origin(c));
      if (p) return { page: p.slug, title: p.title, markdown: pageMarkdown(p, origin(c)) };
      // Not a docs page: maybe one of the site's pages (/compare/github, /performance, /faq...), by path or URL.
      const site = sitePage(`/${slug.replace(/^\/+/, "")}`);
      if (site) return { page: site.path, title: site.title, markdown: sitePageMarkdown(site, origin(c)) };
      throw new HttpError(404, `no docs page "${slug}"; pages: ${SLUGS.join(", ")}; site pages: ${sitePages().map((x) => x.path).join(", ")}`);
    },
  },
};

/** A page slug from what an agent passes: a slug, a docs path or URL, with or without `.md`, a query or a #fragment. */
export function docsSlug(raw: string): string {
  return (
    raw
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/[?#].*$/, "")
      .replace(/^\/?docs\/?/, "")
      .replace(/\/+$/, "")
      .replace(/\.md$/, "") || "index"
  );
}
