// Builds the Kumo client islands into build/islands/, which the Worker imports as text
// (wrangler's default Text rule covers *.txt) and serves from /-/kumo/<hash>.{js,css}.
import { build } from "esbuild";
import postcss from "postcss";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { brotliCompressSync, constants } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "build", "islands");
const require = createRequire(import.meta.url);
await mkdir(out, { recursive: true });

/**
 * A brotli copy of an asset, which the Worker imports as data (wrangler's default Data rule covers
 * *.bin) and sends as it is (web/kumo.tsx): otherwise the edge compresses the 470 KB bundle again for
 * every first visit. Workers see every request as accepting br, and the runtime decodes it for a
 * client that doesn't.
 */
async function precompressed(name, text) {
  const raw = Buffer.from(text);
  await writeFile(join(out, `${name}.br.bin`), brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }));
}

const js = await build({
  entryPoints: [join(here, "kumo.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["chrome111", "safari16.4", "firefox128"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  write: false,
  logLevel: "warning",
});
await writeFile(join(out, "kumo.js.txt"), js.outputFiles[0].text);
await precompressed("kumo.js", js.outputFiles[0].text);

/*
 * Kumo's stylesheet is Tailwind v4 output: theme variables, a global preflight reset and utility
 * classes. Only the theme variables stay global. The reset and utilities are confined to island
 * containers (`.dfy-k`), so they can't restyle the rest of the site and the site's own class
 * names (.grid, .grow, .row …) can't collide with Kumo's.
 */
const SCOPED_LAYERS = new Set(["base", "components", "utilities"]);
const scope = (sel) =>
  sel
    .split(/,(?![^(]*\))/)
    .map((s) => s.trim())
    .map((s) => {
      if (/^(html|:root|:host)\b/.test(s)) return ".dfy-k";
      // Theme switches live on <html>, above the island: keep them first.
      const m = /^((?:\[data-(?:mode|theme)[^\]]*\])+)(\s+.*)?$/.exec(s);
      if (m) return m[2] ? `${m[1]} :where(.dfy-k)${m[2]}` : s;
      return `:where(.dfy-k) ${s}`;
    })
    .join(",");
const scoper = {
  postcssPlugin: "dfy-scope",
  Once(root) {
    root.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
      // The site sets color-scheme itself (light dark); Kumo's `:root{color-scheme:light}` would pin islands to light.
      if (/^:root$/.test(rule.selector) && rule.nodes.every((d) => d.type === "decl" && d.prop === "color-scheme")) return void rule.remove();
      // Token definitions (only --kumo-*/--tw-* custom properties) stay global; they style nothing.
      if (rule.nodes.every((d) => d.type === "comment" || (d.type === "decl" && d.prop.startsWith("--")))) return;
      let p = rule.parent;
      let layer = null;
      while (p && p.type !== "root") {
        if (p.type === "atrule" && p.name === "layer") layer = p.params.trim();
        p = p.parent;
      }
      if (layer === null) {
        // Unlayered Kumo rules only target .kumo-* class names and [data-mode] — still scope them.
        if (/^(:root|html)/.test(rule.selector)) return;
        rule.selector = scope(rule.selector);
        return;
      }
      if (SCOPED_LAYERS.has(layer)) rule.selector = scope(rule.selector);
    });
  },
};
const cssIn = await readFile(require.resolve("@cloudflare/kumo/styles/standalone"), "utf8");
const css = (await postcss([scoper]).process(cssIn, { from: undefined })).css;
await writeFile(join(out, "kumo.css.txt"), css);
await precompressed("kumo.css", css);
// The web terminal (phase 4): its own bundle, loaded only on the terminal page.
const term = await build({
  entryPoints: [join(here, "terminal.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["chrome111", "safari16.4", "firefox128"],
  legalComments: "none",
  write: false,
  logLevel: "warning",
});
await writeFile(join(out, "terminal.js.txt"), term.outputFiles[0].text);
await writeFile(join(out, "terminal.css.txt"), await readFile(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));

console.log(`islands: kumo.js ${(js.outputFiles[0].text.length / 1024).toFixed(0)} KB, kumo.css ${(css.length / 1024).toFixed(0)} KB, terminal.js ${(term.outputFiles[0].text.length / 1024).toFixed(0)} KB`);
