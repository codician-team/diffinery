/** @jsxImportSource hono/jsx */
/**
 * The public site around the product: the home page for visitors (Landing), and the product,
 * comparison and company pages written as Markdown in site/ (built into content.generated.ts by
 * scripts/build-docs.mjs), served at /features, /compare/github and so on.
 *
 * Written for people, search engines and AI assistants alike. Every page is also served as Markdown
 * (/<page>.md, or the page itself with `Accept: text/markdown`; the home page at /index.md), is listed in
 * /llms.txt, /llms-full.txt and the sitemap, and carries schema.org structured data: the organization,
 * the product, breadcrumbs, the date its facts were last checked, and its questions and answers.
 */
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import type { AppContext } from "../auth/principal.js";
import { SITE_NAV, SITE_PAGES } from "../docs/content.generated.js";
import { imageProxy } from "../lib/camo.js";
import { ICONS } from "./assets.js";
import { fenceHighlighter } from "./highlight.js";
import { escapeHtml, fenceLangs, renderMarkdown } from "./markdown.js";
import { SITE } from "./seo.js";
import { render, type WebApp } from "./ui.js";

export interface SitePageInfo {
  /** URL path, e.g. "/compare/github". */
  path: string;
  title: string;
  description: string;
  markdown: string;
  /** The date its facts were last checked, YYYY-MM-DD. */
  updated: string;
  /** Blog posts: the date the post first went out, YYYY-MM-DD (`updated` when it's left out). */
  published?: string;
  seoTitle: string | null;
  /** The site/nav.json section it belongs to ("Product", "Compare", "Company"). */
  section: string;
}

const origin = (c: AppContext) => c.env.PUBLIC_URL.replace(/\/$/, "");

/** Every site page, in the order of site/nav.json. */
export function sitePages(): SitePageInfo[] {
  return SITE_NAV.flatMap((s) => s.pages.map((path) => ({ path, ...SITE_PAGES[path]!, section: s.title })));
}

export function sitePage(path: string): SitePageInfo | null {
  return sitePages().find((p) => p.path === path) ?? null;
}

/** Root-relative links (`](/docs/...)`) made absolute, for Markdown read outside the site. */
const absolute = (md: string, o: string) => md.replace(/\]\(\/(?!\/)/g, `](${o}/`);

const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });

/** A site page as standalone Markdown: what /<page>.md serves. */
export function sitePageMarkdown(p: SitePageInfo, o: string): string {
  return `# ${p.title}\n\n> ${p.description}\n\nSource: ${o}${p.path} (last updated ${p.updated})\n\n${absolute(p.markdown, o).trim()}\n`;
}

// ---------------------------------------------------------------- questions and answers

/** The "## Frequently asked questions" section of a page: each `###` heading and the text under it. */
export function faqs(markdown: string): Array<{ q: string; a: string }> {
  const m = /^## Frequently asked questions\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown);
  if (!m) return [];
  return [...m[1]!.matchAll(/^### +(.+?)\s*$([\s\S]*?)(?=^### |(?![\s\S]))/gm)].map((x) => ({ q: x[1]!.trim(), a: x[2]!.trim() })).filter((x) => x.a);
}

/** Markdown reduced to plain text, for structured data. */
export const plainText = (md: string) =>
  md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------- the home page

/** When the home page's facts were last checked. */
export const HOME_UPDATED = "2026-10-25";

const HOME = {
  // No SITE here: seo.tsx imports this module, so SITE isn't defined yet while it loads.
  title: "Diffinery: open-source GitHub alternative with fast CI, built for AI agents",
  description:
    "Diffinery is open-source code hosting and CI for the agentic era, running on your own Cloudflare account: Git repositories, pull requests, GitHub Actions–compatible CI on 4-vCPU runners, and AI agents with their own accounts and guardrails.",
  h1: "Code hosting and CI for the agentic era",
  lead: "Diffinery is an open-source GitHub alternative for teams of people and AI agents. Git repositories, pull requests, GitHub Actions–compatible CI on fast runners, and agents with their own accounts and guardrails, running entirely on your own Cloudflare account.",
  stats: [
    { value: "4 vCPU", label: "per CI job by default. GitHub's standard runner for private repositories has 2." },
    { value: "3–5 s", label: "from a job being queued to its first step." },
    { value: "Apache-2.0", label: "Open source, with nothing to buy. You run it on your own Cloudflare account." },
    { value: "1 person", label: "approves every agent pull request, enforced by the server." },
  ],
  features: [
    { icon: "repo", title: "Git hosting", text: "Clone, fetch and push over HTTPS with Git LFS. Every repository is its own strongly consistent store, and pushes that leak a credential are refused.", href: "/features#git-hosting" },
    { icon: "pr", title: "Pull requests with intent", text: "Reviews, required approvals and checks, auto-merge and a merge queue. Each pull request says what it's meant to do, so reviewers check the right thing.", href: "/features#pull-requests-reviews-and-issues" },
    { icon: "play", title: "GitHub Actions–compatible CI", text: "The same triggers, expressions, matrices, reusable workflows, secrets, OIDC and Docker. Actions from GitHub run as they do there.", href: "/features#actions-ci-that-runs-your-github-workflows" },
    { icon: "zap", title: "Fast, right-sized runners", text: "4 vCPUs and 12 GiB per job by default, started in seconds. Jobs that only wait move to smaller runners on their own, never at the cost of speed.", href: "/performance" },
    { icon: "bot", title: "AI agents with guardrails", text: "Agents get their own accounts and tokens, an MCP server, sandboxes, tasks and reviews. They can't push to protected branches or reach your secrets.", href: "/agents" },
    { icon: "shield", title: "Secure by default", text: "Passkeys instead of passwords, invite-only sign-up, encrypted secrets, scoped job tokens and an append-only audit log.", href: "/security" },
  ],
  workflow: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest      # 4 vCPU, 12 GiB on Diffinery
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test`,
  compare: {
    cols: ["Diffinery", "GitHub", "GitHub with a runner service"],
    rows: [
      ["Git hosting, pull requests, issues", "Yes", "Yes", "Yes, on GitHub"],
      ["Runs GitHub Actions workflows", "Yes, as they are", "Yes", "Yes, with a new runs-on label"],
      ["Default Linux runner, private repositories", "4 vCPU, 12 GiB", "2 vCPU, 8 GB", "Your choice of size, billed by the vendor"],
      ["Guardrails for AI agents", "Built in for every agent account", "Rulesets and permissions you configure", "Rulesets and permissions you configure"],
      ["Built-in MCP server and agent sandboxes", "Yes", "MCP server, Codespaces", "GitHub's"],
      ["Hosted macOS and Windows runners", "No (self-hosted)", "Yes", "Depends on the vendor"],
      ["Open source", "Yes, Apache-2.0", "No", "No"],
      ["Who runs it", "You, on your own Cloudflare account", "GitHub", "GitHub and the runner vendor"],
    ],
  },
  faq: [
    {
      q: "What is Diffinery?",
      a: "Diffinery is a git forge and CI platform for teams of people and AI agents. It hosts Git repositories, pull requests, issues and releases, runs GitHub Actions workflows on its own hosted runners, and gives AI agents their own accounts, tokens and server-enforced guardrails. It runs entirely on Cloudflare, and it's open source under the Apache License 2.0: you deploy it to your own Cloudflare account.",
    },
    {
      q: "Is Diffinery an alternative to GitHub?",
      a: "Yes, for teams whose work fits it: Diffinery replaces GitHub's code hosting, pull requests and GitHub Actions in one platform. It doesn't have GitHub's hosted macOS and Windows runners, forks, app marketplace, Codespaces, Pages or Discussions. See [Diffinery vs GitHub](/compare/github).",
    },
    {
      q: "Do my GitHub Actions workflows run on Diffinery?",
      a: "Most run without changes. Diffinery reads `.github/workflows/*.yml` with the same syntax, triggers, expressions and actions. Hosted runners are Linux x64; macOS, Windows and Arm jobs need a self-hosted runner. Every difference is listed in [Compatibility with GitHub Actions](/docs/actions/compatibility).",
    },
    {
      q: "Is Diffinery built on Cloudflare?",
      a: "Yes, entirely: Git hosting, pull requests with reviews in a web UI and GitHub Actions–compatible CI, marketplace actions included, all run on Cloudflare. One Cloudflare Worker serves the site, the API, Git and the MCP server; each repository is its own Durable Object, with large objects in R2 and accounts in D1; Workflows and Queues drive CI runs, webhooks and email; and every CI job runs in a Cloudflare Container that exists only while the job runs. There are no servers to manage. See [Built on Cloudflare](/built-on-cloudflare).",
    },
    {
      q: "How is Diffinery different from Blacksmith or Depot?",
      a: "Blacksmith sells faster runners for GitHub Actions, and Depot sells runners, its own CI engine and container builds. With either, your code and pull requests usually stay on GitHub and jobs run on their machines. Diffinery replaces GitHub and GitHub Actions together, with fast runners built in, as one open-source platform you run on your own Cloudflare account. See [Diffinery vs Blacksmith](/compare/blacksmith) and [Diffinery vs Depot](/compare/depot).",
    },
    {
      q: "How does Diffinery work with Claude Code, Codex and other AI agents?",
      a: "Agents connect over MCP at `/mcp` on your instance with a browser sign-in, or use Git, the GitHub CLI and the REST API with an agent token. Each agent is an account of its own: it can't push to protected branches, its pull requests need a person's approval, and runs of its code get no secrets. See [Diffinery for AI agents](/agents).",
    },
    {
      q: "How do I move from GitHub?",
      a: "Diffinery's importer copies a repository or a whole organization from GitHub on the server, with history, issues, pull requests, reviews, releases and branch protection, keeping their numbers. Then you enter your secrets' values and push. See [Migrate from GitHub](/docs/migrate-from-github).",
    },
    {
      q: "Is Diffinery open source?",
      a: "Yes, under the Apache License 2.0, with no paid edition and nothing sold. The source code is at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery) and mirrored to [github.com/codician-team/diffinery](https://github.com/codician-team/diffinery). See [Open source](/open-source).",
    },
    {
      q: "How do I start using Diffinery, and what does it cost?",
      a: "Deploy your own instance to your Cloudflare account and domain with one command, `scripts/setup.sh`, then sign in as its first administrator and invite your team. See [Deploy your own Diffinery](/docs/self-hosting/deploy). Diffinery is free; you pay Cloudflare for what your instance uses, on the Workers Paid plan (a minimum of $5 USD per month per account, plus usage; [Cloudflare's pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked October 25, 2026). There's no hosted service to sign up for: diffinery.com is the project's own instance.",
    },
  ],
};

/** The home page as Markdown, for agents: /index.md, and / with `Accept: text/markdown`. */
export function homeMarkdown(o: string): string {
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${HOME.description}`,
    "",
    `Source: ${o}/ (last updated ${HOME_UPDATED})`,
    "",
    `## ${HOME.h1}`,
    "",
    HOME.lead,
    "",
    ...HOME.stats.map((s) => `- **${s.value}**: ${s.label}`),
    "",
    "## What you get",
    "",
    ...HOME.features.map((f) => `- **[${f.title}](${f.href})**: ${f.text}`),
    "",
    "## Your workflows, as they are",
    "",
    "```yaml",
    HOME.workflow,
    "```",
    "",
    "## How Diffinery compares",
    "",
    `| | ${HOME.compare.cols.join(" | ")} |`,
    `| --- | ${HOME.compare.cols.map(() => "---").join(" | ")} |`,
    ...HOME.compare.rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "Runner services include Blacksmith and Depot. See [all comparisons](/compare).",
    "",
    "## Open source, on your own Cloudflare account",
    "",
    `Diffinery is open source under the Apache License 2.0: [source code](${SOURCE.repo}), [mirror on GitHub](${SOURCE.github}). Deploy it with [Deploy your own Diffinery](/docs/self-hosting/deploy); you pay Cloudflare only for what your instance uses. See [Open source](/open-source).`,
    "",
    "## Frequently asked questions",
    "",
    ...HOME.faq.flatMap((f) => [`### ${f.q}`, "", f.a, ""]),
  ];
  return absolute(lines.join("\n"), o);
}

/** Everything the home page says, for IndexNow (web/indexnow.ts): its Markdown and the landing page's own copy. */
export async function homeContent(o: string): Promise<string> {
  return `${homeMarkdown(o)}\n${await (<Landing />).toString()}`;
}

/**
 * What sets Diffinery apart on Cloudflare, in the words every page uses (llms.txt, structured data). Checked against
 * the other Git and CI projects on Cloudflare listed on /built-on-cloudflare; re-check them when this changes.
 */
export const CLOUDFLARE_CLAIM =
  "an open-source platform where Git hosting, pull requests with reviews in a web UI and GitHub Actions–compatible CI, marketplace actions included, all run on Cloudflare (checked October 25, 2026).";

/** Where Diffinery's source lives, whatever instance serves this page, and its license. */
export const SOURCE = {
  repo: "https://diffinery.com/codician/diffinery",
  github: "https://github.com/codician-team/diffinery",
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  spdx: "Apache-2.0",
};

/** schema.org ids for the site's entities, shared by every page's graph. */
const ids = (o: string) => ({ org: `${o}/#organization`, site: `${o}/#website`, app: `${o}/#software`, source: `${o}/#source` });

function entities(o: string): object[] {
  const id = ids(o);
  return [
    { "@type": "Organization", "@id": id.org, name: SITE.name, url: `${o}/`, logo: { "@type": "ImageObject", url: `${o}/icon-512.png`, width: 512, height: 512 }, description: SITE.description },
    { "@type": "WebSite", "@id": id.site, name: SITE.name, url: `${o}/`, inLanguage: "en", publisher: { "@id": id.org } },
    {
      "@type": "SoftwareApplication",
      "@id": id.app,
      name: SITE.name,
      url: `${o}/`,
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "Git hosting and continuous integration",
      operatingSystem: "Web",
      description: HOME.lead,
      featureList: [...HOME.features.map((f) => `${f.title}: ${f.text}`), `Runs entirely on Cloudflare: ${CLOUDFLARE_CLAIM}`, `Open source under the Apache License 2.0, deployed to your own Cloudflare account`],
      license: SOURCE.license,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free, open-source software. Your instance's Cloudflare usage is billed by Cloudflare." },
      softwareHelp: { "@type": "CreativeWork", url: `${o}/docs/self-hosting/deploy` },
      installUrl: `${o}/docs/self-hosting/deploy`,
      downloadUrl: `${SOURCE.repo}/releases`,
      publisher: { "@id": id.org },
      sameAs: [`${o}/docs`, SOURCE.repo, SOURCE.github],
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": id.source,
      name: SITE.name,
      description: `The source code of ${SITE.name}, which you deploy to your own Cloudflare account.`,
      codeRepository: SOURCE.repo,
      sameAs: [SOURCE.github],
      license: SOURCE.license,
      programmingLanguage: "TypeScript",
      runtimePlatform: "Cloudflare Workers",
      isAccessibleForFree: true,
      targetProduct: { "@id": id.app },
      publisher: { "@id": id.org },
    },
  ];
}

function faqPage(url: string, list: Array<{ q: string; a: string }>): object[] {
  if (!list.length) return [];
  return [{ "@type": "FAQPage", "@id": `${url}#faq`, url, mainEntity: list.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: plainText(f.a) } })) }];
}

/**
 * Structured data for a docs page (docs/web.tsx): a TechArticle in the site's graph, with breadcrumbs (Home, Docs, the
 * page), the date it was last reviewed when its frontmatter says, and its questions and answers.
 */
export function docsJsonLd(o: string, p: { url: string; title: string; description: string; section: string; markdown: string; updated?: string; home?: boolean }): object[] {
  const id = ids(o);
  const trail = [
    { name: "Home", item: `${o}/` },
    { name: "Docs", item: `${o}/docs` },
    ...(p.home ? [] : [{ name: p.title, item: p.url }]),
  ];
  return [
    ...entities(o),
    {
      "@type": "TechArticle",
      "@id": `${p.url}#page`,
      url: p.url,
      name: p.title,
      headline: p.title,
      description: p.description,
      articleSection: p.section,
      inLanguage: "en",
      ...(p.updated ? { dateModified: p.updated } : {}),
      author: { "@id": id.org },
      publisher: { "@id": id.org },
      isPartOf: { "@id": id.site },
      about: { "@id": id.app },
      breadcrumb: { "@id": `${p.url}#breadcrumb` },
    },
    { "@type": "BreadcrumbList", "@id": `${p.url}#breadcrumb`, itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: t.item })) },
    ...faqPage(p.url, faqs(p.markdown)),
  ];
}

const Cta: FC = () => (
  <>
    <a class="btn primary" href="/docs/self-hosting">
      Deploy your own
    </a>
    <a class="btn" href={SOURCE.repo}>
      View the source
    </a>
    <a class="btn" href="/docs">
      Read the docs
    </a>
  </>
);

/** Inline Markdown (links and code) of a home page answer, as HTML. */
const inline = (md: string) => renderMarkdown(md, { idPrefix: "" }).replace(/^<p>|<\/p>\s*$/g, "");

/** The home page for visitors. */
export const Landing: FC = () => (
  <div class="mk">
    <style>{raw(MARKETING_CSS)}</style>
    <section class="hero">
      <a class="ea-eyebrow" href="/open-source">
        {raw(ICONS.code)} Open source under Apache-2.0
      </a>
      <h1>{HOME.h1}</h1>
      <p>{HOME.lead}</p>
      <p class="row" style="justify-content:center">
        <Cta />
      </p>
      <p class="muted small">
        Free, with nothing to buy: you run Diffinery on your own Cloudflare account. Source on <a href={SOURCE.repo}>Diffinery</a> and <a href={SOURCE.github}>GitHub</a>.
      </p>
    </section>
    <ul class="mk-stats" aria-label="Diffinery in numbers">
      {HOME.stats.map((s) => (
        <li>
          <b>{s.value}</b>
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
    <section class="mk-sec">
      <h2>Everything your team and its agents need, in one place</h2>
      <div class="features">
        {HOME.features.map((f) => (
          <a class="box mk-card" href={f.href}>
            <h3>
              {raw(ICONS[f.icon as keyof typeof ICONS])} {f.title}
            </h3>
            <p class="muted m0">{f.text}</p>
          </a>
        ))}
      </div>
    </section>
    <section class="mk-sec mk-split">
      <div>
        <h2>Your workflows, as they are</h2>
        <p>Diffinery reads <code>.github/workflows</code> with the same triggers, expressions, matrices, reusable workflows, environments, secrets and OIDC as GitHub Actions. Common actions such as checkout, setup-node and cache are built into the runner, so they finish in seconds.</p>
        <ul>
          <li>Each job gets a fresh Ubuntu 24.04 container with 4 vCPUs and 12 GiB of memory.</li>
          <li>Caches restore in parallel and extract while they download.</li>
          <li>Self-hosted runners cover macOS, Windows, Arm and GPUs.</li>
        </ul>
        <p>
          <a href="/performance">See the measurements</a> · <a href="/docs/actions/compatibility">Compatibility with GitHub Actions</a>
        </p>
      </div>
      {/* One line: whitespace inside <pre> shows. */}
      {raw(`<pre class="mk-code" aria-label="A GitHub Actions workflow that runs on Diffinery unchanged"><code>${escapeHtml(HOME.workflow)}</code></pre>`)}
    </section>
    <section class="mk-sec">
      <h2>Built for AI coding agents</h2>
      <p class="mk-wide">Claude Code, Codex and other agents work through Git, the GitHub CLI, the REST API or the built-in MCP server, as accounts of their own. The server keeps a person in charge of what lands.</p>
      <div class="features">
        <div class="box mk-card">
          <h3>{raw(ICONS.bot)} Agent accounts</h3>
          <p class="muted m0">Their own logins and tokens, owned by a person or organization, with every commit stamped with who they act for.</p>
        </div>
        <div class="box mk-card">
          <h3>{raw(ICONS.shield)} Guardrails</h3>
          <p class="muted m0">No pushes to protected branches, a person's approval on every agent pull request, and no secrets for agent-written code.</p>
        </div>
        <div class="box mk-card">
          <h3>{raw(ICONS.code)} MCP, sandboxes and tasks</h3>
          <p class="muted m0">One URL connects any MCP app. Agents get sandboxes to build and test in, and tasks turn a goal into a pull request.</p>
        </div>
      </div>
      <p>
        <a href="/agents">Diffinery for AI agents</a> · <a href="/docs/connect">Connect Claude, Claude Code or Codex</a>
      </p>
    </section>
    <section class="mk-sec">
      <h2>How Diffinery compares</h2>
      <div class="table-wrap">
        <table class="mk-table">
          <thead>
            <tr>
              <th></th>
              {HOME.compare.cols.map((h) => (
                <th scope="col">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HOME.compare.rows.map((r) => (
              <tr>
                <th scope="row">{r[0]}</th>
                {r.slice(1).map((v) => (
                  <td>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        Runner services include Blacksmith and Depot. GitHub's runner sizes are from its documentation, checked {longDate(HOME_UPDATED)}. Read the full comparisons with{" "}
        <a href="/compare/github">GitHub</a>, <a href="/compare/gitlab">GitLab</a>, <a href="/compare/blacksmith">Blacksmith</a> and <a href="/compare/depot">Depot</a>.
      </p>
    </section>
    <section class="mk-sec mk-faq" id="faq">
      <h2>Frequently asked questions</h2>
      {HOME.faq.map((f) => (
        <div class="mk-q">
          <h3>{f.q}</h3>
          <p>{raw(inline(f.a))}</p>
        </div>
      ))}
    </section>
    <section class="mk-band">
      <h2>Run Diffinery on your own Cloudflare account</h2>
      <p class="muted">Open source under Apache-2.0. Your workflows, your editor and gh keep working, your agents get guardrails, and you pay Cloudflare only for what you use.</p>
      <p class="row" style="justify-content:center">
        <Cta />
      </p>
    </section>
  </div>
);

/** The home page for signed-out visitors (registerAccount calls this for "/"). */
export function landingPage(c: AppContext): Response | Promise<Response> {
  const o = origin(c);
  if (wantsMarkdown(c)) return markdownResponse(c, homeMarkdown(o));
  c.header("link", `<${o}/index.md>; rel="alternate"; type="text/markdown", <${o}/llms.txt>; rel="describedby"; type="text/plain"`);
  c.header("vary", "Accept");
  return render(
    c,
    {
      title: "",
      home: true,
      seoTitle: HOME.title,
      description: HOME.description,
      jsonLd: [...entities(o), { "@type": "WebPage", "@id": `${o}/#webpage`, url: `${o}/`, name: HOME.title, description: HOME.description, isPartOf: { "@id": ids(o).site }, about: { "@id": ids(o).app }, dateModified: HOME_UPDATED, inLanguage: "en" }, ...faqPage(`${o}/`, HOME.faq)],
      head: <link rel="alternate" type="text/markdown" href="/index.md" title="Diffinery (Markdown)" />,
    },
    <Landing />,
  );
}

// ---------------------------------------------------------------- the Markdown pages (site/)

const wantsMarkdown = (c: AppContext) => /\btext\/markdown\b/i.test(c.req.header("accept") ?? "");
const PUBLIC = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };
const markdownResponse = (c: AppContext, body: string) => c.body(body, 200, { ...PUBLIC, "content-type": "text/markdown; charset=utf-8", vary: "Accept" });

const htmlCache = new Map<string, string>();
async function pageHtml(c: AppContext, p: SitePageInfo): Promise<string> {
  let html = htmlCache.get(p.path);
  if (html === undefined) {
    html = renderMarkdown(p.markdown, { idPrefix: "", highlight: await fenceHighlighter(fenceLangs(p.markdown)), image: imageProxy(c.env) });
    htmlCache.set(p.path, html);
  }
  return html;
}

/** Blog posts: /blog/<post>, not the /blog index. */
const isPost = (p: SitePageInfo) => p.path.startsWith("/blog/");

/** Comparisons, measurements and blog posts are articles: dated, with sources. */
const isArticle = (p: SitePageInfo) => p.path.startsWith("/compare/") || p.path === "/performance" || p.path === "/built-on-cloudflare" || isPost(p);

function crumbs(p: SitePageInfo): Array<{ name: string; path: string }> {
  const out = [{ name: "Home", path: "/" }];
  if (p.path.startsWith("/compare/")) out.push({ name: "Compare", path: "/compare" });
  if (isPost(p)) out.push({ name: "Blog", path: "/blog" });
  out.push({ name: p.title, path: p.path });
  return out;
}

async function sitePageResponse(c: AppContext, p: SitePageInfo): Promise<Response> {
  const o = origin(c);
  const url = `${o}${p.path}`;
  const html = await pageHtml(c, p);
  const id = ids(o);
  const trail = crumbs(p);
  const related = sitePages().filter((x) => x.section === p.section && x.path !== p.path);
  c.header("link", `<${o}${p.path}.md>; rel="alternate"; type="text/markdown", <${o}/llms.txt>; rel="describedby"; type="text/plain"`);
  c.header("vary", "Accept");
  const page = {
    "@type": isPost(p) ? "BlogPosting" : isArticle(p) ? "Article" : p.path === "/about" ? "AboutPage" : "WebPage",
    "@id": `${url}#page`,
    url,
    name: p.title,
    ...(isArticle(p) ? { headline: p.title } : {}),
    description: p.description,
    inLanguage: "en",
    ...(isPost(p) ? { datePublished: p.published ?? p.updated } : {}),
    dateModified: p.updated,
    ...(isArticle(p) ? { author: { "@id": id.org } } : {}),
    publisher: { "@id": id.org },
    isPartOf: { "@id": id.site },
    about: { "@id": id.app },
    breadcrumb: { "@id": `${url}#breadcrumb` },
  };
  const breadcrumb = { "@type": "BreadcrumbList", "@id": `${url}#breadcrumb`, itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: `${o}${t.path}` })) };
  return render(
    c,
    {
      title: p.title,
      seoTitle: p.seoTitle ?? undefined,
      description: p.description,
      modified: isArticle(p) ? p.updated : undefined,
      jsonLd: [...entities(o), page, breadcrumb, ...faqPage(url, faqs(p.markdown))],
      head: <link rel="alternate" type="text/markdown" href={`${p.path}.md`} title={`${p.title} (Markdown)`} />,
    },
    <article class="mk mk-page">
      <style>{raw(MARKETING_CSS)}</style>
      <header class="mk-head">
        <nav class="mk-crumbs" aria-label="Breadcrumb">
          {trail.slice(0, -1).map((t) => (
            <>
              <a href={t.path}>{t.name}</a> <span class="faint">/</span>{" "}
            </>
          ))}
        </nav>
        <h1>{p.title}</h1>
        <p class="mk-lead">{p.description}</p>
        <p class="mk-meta muted small">
          {isPost(p) && p.published && p.published !== p.updated ? (
            <>
              Published <time datetime={p.published}>{longDate(p.published)}</time> ·{" "}
            </>
          ) : null}
          Last updated <time datetime={p.updated}>{longDate(p.updated)}</time> ·{" "}
          <a href={`${p.path}.md`} title="This page as plain Markdown">
            View as Markdown
          </a>
        </p>
      </header>
      <div class="markdown mk-body">{raw(html)}</div>
      <aside class="mk-band">
        <h2>Run Diffinery yourself</h2>
        <p class="muted">Open source under Apache-2.0, deployed to your own Cloudflare account.</p>
        <p class="row" style="justify-content:center">
          <Cta />
        </p>
      </aside>
      {related.length ? (
        <nav class="mk-related" aria-label={`More in ${p.section}`}>
          <h2>More in {p.section}</h2>
          <ul>
            {related.map((r) => (
              <li>
                <a href={r.path}>{r.title}</a>
                <span class="muted small">{r.description}</span>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </article>,
  );
}

/** The sitemap's entries for the site: the home page first, then every page with the date it was last checked. */
export function siteSitemapEntries(): Array<{ path: string; updated: string }> {
  return [{ path: "/", updated: HOME_UPDATED }, ...sitePages().map((p) => ({ path: p.path, updated: p.updated }))];
}

/** The site's part of /llms.txt: what Diffinery is, then every site page as Markdown. */
export function siteLlmsLines(o: string): string[] {
  const lines = [
    "## About Diffinery",
    "",
    `- [Home page](${o}/index.md): ${HOME.description}`,
    `- Open source under the Apache License 2.0 (SPDX: ${SOURCE.spdx}). Source code: ${SOURCE.repo}, mirrored to ${SOURCE.github}. Free, with no paid edition and nothing sold.`,
    `- How to use it: deploy your own instance to your own Cloudflare account and domain (Workers Paid plan); you pay Cloudflare for what it uses. Guide: ${o}/docs/self-hosting/deploy.md. Overview: ${o}/docs/self-hosting.md. There's no hosted service for other teams: diffinery.com is the project's home and its own instance, with accounts by invitation for the people working on Diffinery.`,
    `- Runs entirely on Cloudflare (Workers, Durable Objects, R2, D1, Queues, Workflows, Containers): code, pull requests, CI runners and the agent features alike. It is ${CLOUDFLARE_CLAIM} See ${o}/built-on-cloudflare.md, which compares the other Git and CI projects on Cloudflare.`,
    "- Hosted CI runners: Ubuntu 24.04 x64 containers, 4 vCPU and 12 GiB of memory by default, with smaller sizes chosen per job from its measured runs. No hosted macOS, Windows or Arm runners; self-hosted runners cover them.",
    "- Runs GitHub Actions workflow files from `.github/workflows/` as they are; differences are listed at " + `${o}/docs/actions/compatibility.md`,
    "",
  ];
  for (const s of SITE_NAV) {
    lines.push(`## ${s.title}`, "");
    for (const path of s.pages) {
      const p = sitePage(path)!;
      lines.push(`- [${p.title}](${o}${path}.md): ${p.description} (updated ${p.updated})`);
    }
    lines.push("");
  }
  return lines;
}

/** The site's pages for /llms-full.txt, home page first. */
export function siteFullMarkdown(o: string): string[] {
  return [homeMarkdown(o), ...sitePages().map((p) => sitePageMarkdown(p, o))];
}

export function registerSite(web: WebApp): void {
  web.get("/index.md", (c) => markdownResponse(c, homeMarkdown(origin(c))));
  for (const p of sitePages()) {
    web.get(`${p.path}.md`, (c) => markdownResponse(c, sitePageMarkdown(p, origin(c))));
    web.get(`${p.path}/`, (c) => c.redirect(p.path, 301));
    web.get(p.path, (c) => (wantsMarkdown(c) ? markdownResponse(c, sitePageMarkdown(p, origin(c))) : sitePageResponse(c, p)));
  }
}

export const MARKETING_CSS = `
.mk .hero h1{max-width:820px;margin-left:auto;margin-right:auto;font-size:48px;line-height:1.08}
.mk .hero>p:first-of-type{max-width:720px}
.mk-stats{list-style:none;margin:8px 0 8px;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.mk-stats li{border:1px solid var(--border);border-radius:var(--r);background:var(--bg);padding:16px}
.mk-stats b{display:block;font-size:24px;letter-spacing:-.02em;margin-bottom:4px}
.mk-stats span{color:var(--fg2);font-size:13.5px;line-height:1.45}
.mk-sec{margin:56px 0 0}
.mk-sec>h2,.mk-band h2,.mk-related h2{font-size:26px;letter-spacing:-.02em;margin:0 0 10px}
.mk-wide{max-width:760px;color:var(--fg2);font-size:16px}
.mk .features{grid-template-columns:repeat(3,minmax(0,1fr))}
.mk-card{display:block;color:var(--fg)}a.mk-card:hover{border-color:var(--accent);text-decoration:none}
.mk-card h3{display:flex;align-items:center;gap:8px}.mk-card h3 svg{flex:none;color:var(--accent)}
.mk-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;align-items:center}
.mk-split>*{min-width:0}
.mk .table-wrap{overflow:auto}
.mk-split p,.mk-split li{color:var(--fg2);font-size:15px;line-height:1.65}
.mk-code{margin:0;padding:18px 20px;background:var(--code-bg);border:1px solid var(--border);border-radius:var(--r);overflow:auto;font-size:13px;line-height:1.6}
.mk-table{width:100%;border-collapse:collapse;font-size:14px}
.mk-table th,.mk-table td{border-bottom:1px solid var(--border2);padding:10px 12px;text-align:left;vertical-align:top}
.mk-table thead th{font-weight:600;border-bottom:1px solid var(--border)}.mk-table thead th:nth-child(2){color:var(--accent)}
.mk-table tbody th{font-weight:500;color:var(--fg2)}
.mk-faq .mk-q{border-top:1px solid var(--border2);padding:14px 0}.mk-faq h3{font-size:16px;margin:0 0 6px}.mk-faq p{margin:0;color:var(--fg2);line-height:1.65;max-width:860px}
.mk-band{margin:56px 0 0;padding:36px 20px;text-align:center;border:1px solid var(--border);border-radius:var(--r);background:var(--bg2)}
.mk-band p{margin:0 auto 14px;max-width:620px}
.mk-page{max-width:880px;margin:0 auto}
.mk-head{padding:28px 0 18px;border-bottom:1px solid var(--border2);margin-bottom:8px}
.mk-head h1{font-size:36px;line-height:1.15;letter-spacing:-.025em;margin:8px 0 10px}
.mk-crumbs{font-size:13px;min-height:18px}
.mk-lead{font-size:18px;color:var(--fg2);margin:0 0 10px;line-height:1.55}
.mk-meta{margin:0}
.mk-body{font-size:15.5px;line-height:1.7}
.mk-body h2{font-size:23px;margin-top:38px;scroll-margin-top:64px}.mk-body h3{font-size:17px;margin-top:26px;scroll-margin-top:64px}
.mk-body table{font-size:14px;width:100%}.mk-body td code{white-space:nowrap}
.mk-related{margin:40px 0 0}
.mk-related ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.mk-related li{border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;display:flex;flex-direction:column;gap:4px}
@media (max-width:900px){.mk .features{grid-template-columns:repeat(2,minmax(0,1fr))}.mk-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.mk-split{grid-template-columns:minmax(0,1fr)}}
@media (max-width:600px){.mk .features{grid-template-columns:minmax(0,1fr)}.mk .hero{padding-top:40px}.mk .hero h1{font-size:32px}.mk-head h1{font-size:27px}.mk-stats{grid-template-columns:minmax(0,1fr)}.mk-sec>h2,.mk-band h2{font-size:22px}}
`;
