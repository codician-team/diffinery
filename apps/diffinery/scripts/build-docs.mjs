// Builds the public documentation into src/docs/content.generated.ts:
//   - every Markdown page under docs/ (with its frontmatter), in the order of docs/nav.json
//   - the public site's pages under site/ (the product, comparison and company pages around the
//     home page), in the order of site/nav.json
//   - the CLI reference, generated from the CLI's own command registry
//   - the CLI itself as one file, served at /-/cli/diffinery.mjs, and its install scripts
//     (apps/cli/install), served at /install and /install.ps1
//   - the editor extension for VS Code and Cursor (apps/vscode), packed as a .vsix, served at
//     /-/vscode/diffinery.vsix, and its install scripts (apps/vscode/install), served at /install-editor
//     and /install-editor.ps1
//   - the plugin for JetBrains IDEs (apps/jetbrains), built and checked in at apps/jetbrains/dist (the build here has no
//     JDK; scripts/plugin.mjs there refuses a zip built from older sources), served at /-/jetbrains/
//   - the Claude Code plugins in plugins/ at the repository root, packed by scripts/pack-plugins.py, checked in at
//     claude-plugins/, served at /-/claude/
// The REST API and MCP tool references are generated at runtime from the live
// router and tool list (src/docs/reference.ts), so none of the references can drift.
//
// Run by `pnpm build` and `pnpm dev`. Fails on a page missing from the nav (or the
// other way round) and on missing or overlong frontmatter.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const docsDir = path.join(app, "docs");
const cliSrc = path.resolve(app, "../cli/src");
const cliInstall = path.resolve(app, "../cli/install");
const editorPackager = path.resolve(app, "../vscode/scripts/package.mjs");
const editorInstall = path.resolve(app, "../vscode/install");
const jetbrainsReader = path.resolve(app, "../jetbrains/scripts/plugin.mjs");
const siteDir = path.join(app, "site");
const claudePluginsDir = path.join(app, "claude-plugins");
/** The plugins' sources (packed into claude-plugins/ by scripts/pack-plugins.py). */
const pluginSources = path.resolve(app, "../../plugins");
/** The Claude Code plugins Diffinery serves for upload to claude.ai, by name. */
const CLAUDE_PLUGIN_NAMES = new Set(["diffinery", "diffinery-ci"]);
const out = path.join(app, "src/docs/content.generated.ts");

/** Pages produced in code rather than from a Markdown file. */
const RUNTIME_PAGES = new Set(["api", "reference/mcp-tools"]);
const BUILD_PAGES = new Set(["reference/cli"]);

const problems = [];

async function walk(dir) {
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) files.push(p);
  }
  return files;
}

function parsePage(slug, text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n?/g, "\n"));
  if (!m) {
    problems.push(`${slug}.md: missing frontmatter (--- title / description ---)`);
    return { title: slug, description: "", markdown: text };
  }
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!meta.title) problems.push(`${slug}.md: frontmatter has no title`);
  if (!meta.description) problems.push(`${slug}.md: frontmatter has no description`);
  else if (meta.description.length > 200) problems.push(`${slug}.md: description is ${meta.description.length} characters (keep it under 200)`);
  const markdown = text.replace(/\r\n?/g, "\n").slice(m[0].length).trim() + "\n";
  if (/^# /m.test(markdown.replace(/```[\s\S]*?```/g, ""))) problems.push(`${slug}.md: don't use an H1 (the title is the H1)`);
  // Optional on docs pages: the date the page was last reviewed, for the sitemap and structured data.
  if (meta.updated !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(meta.updated)) problems.push(`${slug}.md: updated must be YYYY-MM-DD`);
  return { title: meta.title ?? slug, description: meta.description ?? "", markdown, ...(meta.updated ? { updated: meta.updated } : {}) };
}

// ---------------------------------------------------------------- the CLI

// Lets bundled CommonJS dependencies call require() (same banner as apps/cli's own build).
const REQUIRE_SHIM = "import { createRequire as __diffineryCreateRequire } from 'node:module'; const require = __diffineryCreateRequire(import.meta.url);";

async function bundleCli(tmp) {
  // The registry, for the reference page.
  const regFile = path.join(tmp, "registry.mjs");
  await build({
    stdin: {
      contents: `export { registry } from "./main.ts"; export { optionsFor } from "./cli.ts"; export { VERSION } from "./version.ts";`,
      resolveDir: cliSrc,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: regFile,
    banner: { js: REQUIRE_SHIM },
    logLevel: "error",
  });
  // The CLI itself, minified, for /-/cli/diffinery.mjs.
  const binFile = path.join(tmp, "diffinery.mjs");
  await build({
    entryPoints: [path.join(cliSrc, "bin.ts")],
    bundle: true,
    minify: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: binFile,
    banner: { js: `#!/usr/bin/env node\n${REQUIRE_SHIM}` },
    logLevel: "error",
  });
  const mod = await import(pathToFileURL(regFile).href);
  return { ...mod, bin: await readFile(binFile, "utf8") };
}

function cliReference({ registry, optionsFor, VERSION }) {
  const all = [...registry.groups.flatMap((g) => g.commands), ...registry.commands];
  const groups = [...registry.groups].sort((a, b) => a.name.localeCompare(b.name));
  const singles = [...registry.commands].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    `This page lists every command of the \`diffinery\` command-line client (version ${VERSION}) with all of its options. It is generated from the CLI's own command definitions, so it always matches \`diffinery <command> --help\`.`,
    "",
    "## Install",
    "",
    "```sh",
    "curl -fsSL https://diffinery.com/install | bash      # Linux and macOS",
    "diffinery setup                                     # sign in through your browser, set up git and gh",
    "```",
    "",
    "On Windows, in PowerShell: `powershell -c \"irm https://diffinery.com/install.ps1 | iex\"`. The CLI runs on Node.js 22 or later; the script installs one for it when yours is older or missing. `diffinery upgrade` updates it. See [Install and sign in to the CLI](/docs/accounts/cli-sign-in).",
    "",
    "## Configuration",
    "",
    "| Setting | Where | Notes |",
    "| --- | --- | --- |",
    "| Server URL | `DIFFINERY_URL`, else `url` in the config file, else `https://diffinery.com` | Set this for your own Diffinery instance. |",
    "| Token | `DIFFINERY_TOKEN`, else `token` in the config file | `diffinery login` signs in through the browser and stores the CLI's token in the config file. |",
    "| Config file | `~/.config/diffinery/config.json` (`$XDG_CONFIG_HOME/diffinery/config.json` when set) | Written by `diffinery login`. |",
    "",
    "Commands that work on a repository take `-R OWNER/NAME`. Without it, the CLI uses the `origin` remote of the git repository you are in, when that remote points at the configured server.",
    "",
    "Most read commands take `--json` to print the raw API response, for scripts and agents.",
    "",
    "## Exit codes",
    "",
    "| Code | Meaning |",
    "| --- | --- |",
    "| `0` | Success. |",
    "| `1` | The command failed (an API error, a failed check, a failed run when waiting). |",
    "| `2` | Usage error: unknown command, bad option or missing argument. Help is printed to stderr. |",
    "",
    "## Commands",
    "",
    "| Command | Summary |",
    "| --- | --- |",
    ...[...groups.map((g) => [g.name, g.summary]), ...singles.map((c) => [c.name, c.summary])].sort((a, b) => a[0].localeCompare(b[0])).map(([n, s]) => `| [\`${n}\`](#${slug(`diffinery ${n}`)}) | ${s} |`),
    "",
  ];
  const cmdSection = (cmd, level) => {
    const opts = optionsFor(cmd);
    const usage = `diffinery ${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}${Object.keys(opts).length > 1 ? " [options]" : ""}`;
    lines.push(`${"#".repeat(level)} diffinery ${cmd.name}`, "", cmd.summary.replace(/\.?$/, "."), "", "```text", usage, "```", "");
    if (cmd.description) lines.push(cmd.description.trim(), "");
    const rows = Object.entries(opts).filter(([k]) => k !== "help");
    if (rows.length) {
      lines.push("| Option | Description |", "| --- | --- |");
      for (const [k, o] of rows) {
        const flag = `${o.short ? `-${o.short}, ` : ""}--${k}${o.type === "string" ? ` ${o.arg ?? "VALUE"}` : ""}`;
        lines.push(`| \`${flag}\` | ${o.desc.replace(/\|/g, "\\|")}${o.multiple ? " Repeatable." : ""} |`);
      }
      lines.push("");
    }
  };
  for (const g of groups) {
    lines.push(`### diffinery ${g.name}`, "", g.summary.replace(/\.?$/, "."), "");
    for (const c of [...g.commands].sort((a, b) => a.name.localeCompare(b.name))) cmdSection(c, 4);
  }
  for (const c of singles) cmdSection(c, 3);
  if (all.length < 10) problems.push("the CLI registry looks empty");
  return lines.join("\n");
}

// Same rules as slugify() in src/web/markdown.ts.
function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

// ---------------------------------------------------------------- main

const nav = JSON.parse(await readFile(path.join(docsDir, "nav.json"), "utf8"));
const navSlugs = nav.flatMap((s) => s.pages);
const dupes = navSlugs.filter((s, i) => navSlugs.indexOf(s) !== i);
if (dupes.length) problems.push(`docs/nav.json lists ${dupes.join(", ")} more than once`);

const files = await walk(docsDir);
const pages = {};
for (const f of files) {
  const s = path.relative(docsDir, f).replace(/\\/g, "/").replace(/\.md$/, "");
  pages[s] = parsePage(s, await readFile(f, "utf8"));
}
// DOCS_DRAFT=1 tolerates pages that aren't written yet (local work in progress only).
for (const s of navSlugs) if (!pages[s] && !RUNTIME_PAGES.has(s) && !BUILD_PAGES.has(s) && !process.env.DOCS_DRAFT) problems.push(`docs/nav.json lists "${s}" but docs/${s}.md doesn't exist`);
for (const s of Object.keys(pages)) if (!navSlugs.includes(s)) problems.push(`docs/${s}.md isn't listed in docs/nav.json`);

// Screenshots and other pictures in docs/images/, served at /docs/images/<file>. Every one must be used by
// a page, and every /docs/images/ reference must exist. Raster formats only (an SVG is a document that can
// run script on this origin).
const IMAGE_TYPES = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };
const MAX_IMAGE = 400 * 1024;
const images = {};
const imagesDir = path.join(docsDir, "images");
for (const e of await readdir(imagesDir, { withFileTypes: true }).catch(() => [])) {
  if (!e.isFile()) continue;
  const type = IMAGE_TYPES[path.extname(e.name).toLowerCase()];
  if (!type || !/^[a-z0-9][a-z0-9.-]*$/.test(e.name)) {
    problems.push(`docs/images/${e.name}: use lowercase names ending in .png, .webp or .jpg`);
    continue;
  }
  const data = await readFile(path.join(imagesDir, e.name));
  if (data.length > MAX_IMAGE) problems.push(`docs/images/${e.name} is ${Math.round(data.length / 1024)} KiB (keep it under ${MAX_IMAGE / 1024} KiB)`);
  images[e.name] = { type, data: data.toString("base64") };
}
const usedImages = new Set();
for (const [s, p] of Object.entries(pages)) {
  for (const m of p.markdown.matchAll(/!\[([^\]]*)\]\(\/docs\/images\/([^)\s]+)/g)) {
    usedImages.add(m[2]);
    if (!images[m[2]]) problems.push(`docs/${s}.md shows /docs/images/${m[2]}, which doesn't exist`);
    if (!m[1].trim()) problems.push(`docs/${s}.md shows /docs/images/${m[2]} without alt text (agents and screen readers read it)`);
  }
}
for (const name of Object.keys(images)) if (!usedImages.has(name)) problems.push(`docs/images/${name} isn't used by any page`);

const tmp = await mkdtemp(path.join(tmpdir(), "diffinery-docs-"));
let cli;
try {
  cli = await bundleCli(tmp);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
const editor = await (await import(pathToFileURL(editorPackager).href)).packageExtension();
let jetbrains;
try {
  jetbrains = await (await import(pathToFileURL(jetbrainsReader).href)).readPlugin();
} catch (e) {
  problems.push(e.message);
}
// claude-plugins/<name>-<version>.zip: one per plugin, each a zip with the plugin's manifest at its root.
const claudePlugins = {};
for (const e of await readdir(claudePluginsDir, { withFileTypes: true }).catch(() => [])) {
  if (!e.isFile() || e.name === "README.md") continue;
  const m = /^([a-z][a-z0-9-]*?)-(\d+\.\d+\.\d+)\.zip$/.exec(e.name);
  if (!m || !CLAUDE_PLUGIN_NAMES.has(m[1])) {
    problems.push(`claude-plugins/${e.name}: expected <name>-<version>.zip for one of ${[...CLAUDE_PLUGIN_NAMES].join(", ")}`);
    continue;
  }
  if (claudePlugins[m[1]]) {
    problems.push(`claude-plugins/ holds two versions of ${m[1]}: keep only the newest`);
    continue;
  }
  const zip = await readFile(path.join(claudePluginsDir, e.name));
  // Zip entry names are stored as written: the manifest's path shows in the bytes of a zip that has one.
  if (zip.readUInt32LE(0) !== 0x04034b50 || !zip.includes(Buffer.from(".claude-plugin/plugin.json"))) {
    problems.push(`claude-plugins/${e.name} isn't a zip with .claude-plugin/plugin.json at its root`);
    continue;
  }
  // A zip that lags its sources' version would serve an old plugin under a new manifest: repack it.
  const source = await readFile(path.join(pluginSources, m[1], ".claude-plugin/plugin.json"), "utf8").then(JSON.parse, () => null);
  if (source?.version !== m[2]) problems.push(`claude-plugins/${e.name}: plugins/${m[1]} is version ${source?.version ?? "(missing)"}; run python3 scripts/pack-plugins.py ${m[1]} and replace the zip`);
  claudePlugins[m[1]] = { version: m[2], sha256: createHash("sha256").update(zip).digest("hex"), zip: zip.toString("base64") };
}
for (const name of CLAUDE_PLUGIN_NAMES) if (!claudePlugins[name]) problems.push(`claude-plugins/ has no ${name}-<version>.zip`);

pages["reference/cli"] = {
  title: "CLI reference",
  description: "Every command and option of the diffinery command-line client, generated from its source.",
  markdown: cliReference(cli) + "\n",
};

// ---------------------------------------------------------------- the public site (site/)

// site/<path>.md is served at /<path> (site/compare/index.md at /compare; the home page is web/site.tsx), with the same frontmatter as a
// docs page plus `updated` (the date its facts were last checked, shown on the page), optional
// `seo_title` (the <title>, when the H1 is too long or too plain for a search result) and, on blog posts,
// optional `published` (the date the post first went out; `updated` when it's left out).
const siteNav = JSON.parse(await readFile(path.join(siteDir, "nav.json"), "utf8"));
const sitePaths = siteNav.flatMap((s) => s.pages);
const site = {};
for (const f of await walk(siteDir)) {
  const rel = path.relative(siteDir, f).replace(/\\/g, "/").replace(/\.md$/, "");
  const url = `/${rel.replace(/(^|\/)index$/, "")}`.replace(/(.)\/$/, "$1");
  const text = (await readFile(f, "utf8")).replace(/\r\n?/g, "\n");
  const page = parsePage(`site/${rel}`, text);
  const meta = Object.fromEntries([...(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "").matchAll(/^(\w+):\s*(.*)$/gm)].map((m) => [m[1], m[2].trim().replace(/^(["'])(.*)\1$/, "$2")]));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.updated ?? "")) problems.push(`site/${rel}.md: frontmatter needs updated: YYYY-MM-DD`);
  if (meta.published !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(meta.published)) problems.push(`site/${rel}.md: published must be YYYY-MM-DD`);
  if (meta.seo_title && meta.seo_title.length > 70) problems.push(`site/${rel}.md: seo_title is ${meta.seo_title.length} characters (keep it to 70)`);
  if (page.description.length > 160) problems.push(`site/${rel}.md: description is ${page.description.length} characters (search results show about 160)`);
  if (!sitePaths.includes(url)) problems.push(`site/${rel}.md isn't listed in site/nav.json`);
  site[url] = { ...page, updated: meta.updated ?? "", seoTitle: meta.seo_title ?? null, ...(meta.published ? { published: meta.published } : {}) };
}
for (const u of sitePaths) if (!site[u]) problems.push(`site/nav.json lists "${u}" but there's no page for it in site/`);

if (problems.length) {
  console.error(`docs: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

const ordered = Object.fromEntries(navSlugs.filter((s) => pages[s]).map((s) => [s, pages[s]]));
const src = `// Generated by scripts/build-docs.mjs from docs/, site/, claude-plugins/, apps/cli, apps/vscode and apps/jetbrains/dist. Do not edit.
/* eslint-disable */
export interface DocPage { title: string; description: string; markdown: string; updated?: string }
export interface DocSection { title: string; pages: string[] }
export const DOCS_NAV: DocSection[] = ${JSON.stringify(nav)};
export const DOCS_PAGES: Record<string, DocPage> = ${JSON.stringify(ordered)};
/** docs/images/: content type and base64 bytes by file name. */
export interface SitePage { title: string; description: string; markdown: string; updated: string; seoTitle: string | null; published?: string }
export interface SiteSection { title: string; pages: string[] }
/** The public site's pages (site/), by URL path, and their sections in reading order. The home page is code (web/site.tsx). */
export const SITE_NAV: SiteSection[] = ${JSON.stringify(siteNav)};
export const SITE_PAGES: Record<string, SitePage> = ${JSON.stringify(Object.fromEntries(sitePaths.filter((u) => site[u]).map((u) => [u, site[u]])))};
export const DOCS_IMAGES: Record<string, { type: string; data: string }> = ${JSON.stringify(images)};
export const CLI_VERSION = ${JSON.stringify(cli.VERSION)};
export const CLI_BUNDLE = ${JSON.stringify(cli.bin)};
export const EDITOR_EXTENSION_VERSION = ${JSON.stringify(editor.version)};
export const EDITOR_EXTENSION_SHA256 = ${JSON.stringify(createHash("sha256").update(editor.vsix).digest("hex"))};
export const EDITOR_EXTENSION_VSIX_B64 = ${JSON.stringify(editor.vsix.toString("base64"))};
export const EDITOR_INSTALL_SH = ${JSON.stringify(await readFile(path.join(editorInstall, "install.sh"), "utf8"))};
export const EDITOR_INSTALL_PS1 = ${JSON.stringify(await readFile(path.join(editorInstall, "install.ps1"), "utf8"))};
export const JETBRAINS_PLUGIN_VERSION = ${JSON.stringify(jetbrains.version)};
export const JETBRAINS_PLUGIN_SINCE_BUILD = ${JSON.stringify(jetbrains.sinceBuild)};
export const JETBRAINS_PLUGIN_DESCRIPTION = ${JSON.stringify(jetbrains.description)};
export const JETBRAINS_PLUGIN_SHA256 = ${JSON.stringify(createHash("sha256").update(jetbrains.zip).digest("hex"))};
export const JETBRAINS_PLUGIN_ZIP_B64 = ${JSON.stringify(jetbrains.zip.toString("base64"))};
/** claude-plugins/: the Claude Code plugins served at /-/claude/<name>.zip, base64. */
export const CLAUDE_PLUGINS: Record<string, { version: string; sha256: string; zip: string }> = ${JSON.stringify(claudePlugins)};
export const CLI_INSTALL_SH = ${JSON.stringify(await readFile(path.join(cliInstall, "install.sh"), "utf8"))};
export const CLI_INSTALL_PS1 = ${JSON.stringify(await readFile(path.join(cliInstall, "install.ps1"), "utf8"))};
export const CLI_SHA256 = ${JSON.stringify(createHash("sha256").update(cli.bin).digest("hex"))};
export const AGENT_SETUP_SH = ${JSON.stringify(await readFile(path.join(cliInstall, "agent-setup.sh"), "utf8"))};
`;
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, src);
console.log(`docs: ${Object.keys(ordered).length} pages (+${RUNTIME_PAGES.size} generated at runtime), ${Object.keys(site).length} site pages, ${Object.keys(images).length} images, CLI ${cli.VERSION} (${Math.round(cli.bin.length / 1024)} KiB), editor extension ${editor.version} (${Math.round(editor.vsix.length / 1024)} KiB), JetBrains plugin ${jetbrains.version} (${Math.round(jetbrains.zip.length / 1024)} KiB), Claude Code plugins ${Object.entries(claudePlugins).map(([n, p]) => `${n} ${p.version}`).join(", ")}`);
