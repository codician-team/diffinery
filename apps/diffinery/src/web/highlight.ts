/**
 * Syntax highlighting with Shiki (JavaScript regex engine, fine-grained grammars
 * loaded on first use). Tokens carry both GitHub themes as CSS variables
 * (--shiki-light / --shiki-dark); the site stylesheet picks one. Everything here
 * fails soft: an unknown language, an oversized input or an error means plain text.
 */
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemedToken, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { escapeHtml } from "./markdown.js";

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS = {
  astro: () => import("shiki/langs/astro.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  fsharp: () => import("shiki/langs/fsharp.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  ocaml: () => import("shiki/langs/ocaml.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
} satisfies Record<string, Grammar>;

export type Lang = keyof typeof GRAMMARS;
export const LANGS = Object.keys(GRAMMARS) as Lang[];

const EXT: Record<string, Lang> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", webmanifest: "json", geojson: "json", jsonc: "jsonc", json5: "json5",
  yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", markdown: "markdown", mdown: "markdown", mkd: "markdown",
  html: "html", htm: "html", xhtml: "html",
  css: "css", scss: "scss", sass: "sass", less: "less",
  py: "python", pyi: "python", pyw: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", "c++": "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp",
  cs: "csharp", csx: "csharp", php: "php", phtml: "php", rb: "ruby", rake: "ruby", gemspec: "ruby", ru: "ruby",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", ksh: "shellscript", command: "shellscript", fish: "fish",
  ps1: "powershell", psm1: "powershell", psd1: "powershell", bat: "bat", cmd: "bat",
  sql: "sql", graphql: "graphql", gql: "graphql",
  xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml", svg: "xml", plist: "xml", csproj: "xml", fsproj: "xml", vbproj: "xml", props: "xml", targets: "xml", resx: "xml", xaml: "xml", rss: "xml", atom: "xml",
  lua: "lua", dart: "dart", scala: "scala", sc: "scala", sbt: "scala", r: "r", pl: "perl", pm: "perl",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell",
  vue: "vue", svelte: "svelte", astro: "astro", tf: "terraform", tfvars: "terraform", hcl: "hcl", nomad: "hcl",
  ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "dotenv",
  mk: "make", mak: "make", cmake: "cmake", diff: "diff", patch: "diff", proto: "proto", zig: "zig",
  m: "objective-c", groovy: "groovy", gradle: "groovy", gvy: "groovy", clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure",
  ml: "ocaml", mli: "ocaml", fs: "fsharp", fsi: "fsharp", fsx: "fsharp", jl: "julia", nix: "nix",
};

const NAMES: Record<string, Lang | null> = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", "cmakelists.txt": "cmake",
  gemfile: "ruby", rakefile: "ruby", podfile: "ruby", vagrantfile: "ruby", brewfile: "ruby", guardfile: "ruby", fastfile: "ruby", "gemfile.lock": null,
  jenkinsfile: "groovy", "nginx.conf": "nginx", "cargo.lock": "toml", "go.mod": null, "go.sum": null,
  ".bashrc": "shellscript", ".bash_profile": "shellscript", ".bash_aliases": "shellscript", ".zshrc": "shellscript", ".zprofile": "shellscript", ".zshenv": "shellscript", ".profile": "shellscript",
  ".gitconfig": "ini", ".editorconfig": "ini", ".npmrc": "ini", ".gitmodules": "ini",
  ".babelrc": "json", ".eslintrc": "json", ".prettierrc": "json", ".swcrc": "json",
  ".gitignore": null, ".dockerignore": null, ".npmignore": null, ".gitattributes": null, ".prettierignore": null, ".eslintignore": null,
};

/** Shiki language for a repository path, or null when unknown (rendered as plain text). */
export function langForPath(path: string): Lang | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (name in NAMES) return NAMES[name]!;
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "docker";
  if (name.startsWith("makefile.")) return "make";
  if (/^(tsconfig|jsconfig)(\.[\w-]+)*\.json$/.test(name) || /(^|\/)\.vscode\/[^/]+\.json$/i.test(path) || name === "devcontainer.json") return "jsonc";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? (EXT[name.slice(dot + 1)] ?? null) : null;
}

const ALIASES: Record<string, Lang> = {
  ...EXT,
  typescript: "typescript", javascript: "javascript", node: "javascript", python: "python", python3: "python", py3: "python", golang: "go", rust: "rust",
  kotlin: "kotlin", csharp: "csharp", "c#": "csharp", cpp: "cpp", "objective-c": "objective-c", objc: "objective-c", objectivec: "objective-c",
  ruby: "ruby", shell: "shellscript", shellscript: "shellscript", console: "shellscript", shellsession: "shellscript", powershell: "powershell", pwsh: "powershell", ps: "powershell",
  batch: "bat", docker: "docker", dockerfile: "docker", make: "make", makefile: "make", perl: "perl", elixir: "elixir", erlang: "erlang", haskell: "haskell",
  terraform: "terraform", nginx: "nginx", dotenv: "dotenv", protobuf: "proto", "f#": "fsharp", fsharp: "fsharp", ocaml: "ocaml", julia: "julia", clojure: "clojure",
  postgres: "sql", postgresql: "sql", psql: "sql", mysql: "sql", sqlite: "sql", plpgsql: "sql", jsonl: "json", "objective-cpp": "cpp",
};

/** Shiki language for a Markdown fence info string ("ts", "yaml", "c++" …), or null. */
export function langForFence(info: string): Lang | null {
  const name = info.trim().toLowerCase().replace(/^\{?\.?/, "").replace(/\}$/, "");
  return name in GRAMMARS ? (name as Lang) : (ALIASES[name] ?? null);
}

// ---------------------------------------------------------------- highlighter

/** Highlighting limits: beyond them, plain text. Workers have little CPU to spare. */
export const LIMITS = { lines: 2000, bytes: 200_000, lineLength: 2000, lineMs: 500 };

export interface Tok {
  text: string;
  /** CSS custom properties (--shiki-light etc.); absent for the default foreground. */
  style?: string;
}
export type TokLine = Tok[];

const PAIR = "github-pair";

/**
 * GitHub's light and dark default themes share one rule list (same scopes and font styles,
 * different colors). Tokenizing once with a theme whose rule colors are
 * placeholders, then decoding each placeholder to both palettes, gives exactly
 * Shiki's dual-theme output at half the CPU (dual themes tokenize once per theme).
 */
function pairThemes(light: ThemeRegistration, dark: ThemeRegistration): { theme: ThemeRegistration; palette: Map<string, [string, string]> } {
  const lr = light.tokenColors ?? [];
  const dr = dark.tokenColors ?? [];
  const fg = (t: ThemeRegistration) => (t.fg ?? t.colors?.["editor.foreground"] ?? "").toUpperCase();
  const palette = new Map<string, [string, string]>([["#000000", [fg(light), fg(dark)]]]);
  if (lr.length !== dr.length || !palette.get("#000000")!.every(Boolean)) throw new Error("themes do not pair");
  const tokenColors = lr.map((r, i) => {
    const d = dr[i]!;
    if (JSON.stringify(r.scope) !== JSON.stringify(d.scope) || r.settings.fontStyle !== d.settings.fontStyle || !r.settings.foreground !== !d.settings.foreground) throw new Error("themes do not pair");
    const settings: { fontStyle?: string; foreground?: string } = r.settings.fontStyle !== undefined ? { fontStyle: r.settings.fontStyle } : {};
    if (r.settings.foreground) {
      settings.foreground = `#${(i + 1).toString(16).padStart(6, "0").toUpperCase()}`;
      palette.set(settings.foreground, [r.settings.foreground.toUpperCase(), d.settings.foreground!.toUpperCase()]);
    }
    return { scope: r.scope, settings };
  });
  return { theme: { name: PAIR, type: "light", fg: "#000000", bg: "#ffffff", colors: { "editor.foreground": "#000000", "editor.background": "#ffffff" }, tokenColors }, palette };
}

let core: Promise<HighlighterCore> | null = null;
let palette = new Map<string, [string, string]>();
const styles = new Map<string, string | undefined>();
const loading = new Map<Lang, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= Promise.all([import("shiki/themes/github-light-default.mjs"), import("shiki/themes/github-dark-default.mjs")])
    .then(([l, d]) => {
      const pair = pairThemes(l.default, d.default);
      palette = pair.palette;
      return createHighlighterCore({ themes: [pair.theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    })
    .catch((e) => {
      core = null;
      throw e;
    });
  return core;
}

/** The highlighter with these grammars loaded; null when anything fails. */
export async function ready(langs: Iterable<Lang>): Promise<HighlighterCore | null> {
  try {
    const hl = await highlighter();
    await Promise.all(
      [...new Set(langs)].map((l) => {
        let p = loading.get(l);
        if (!p) {
          p = hl
            .loadLanguage(GRAMMARS[l]())
            // Compile the grammar's top-level rules now: on a cold Worker that alone can outlast the
            // per-line time limit, which would leave the first line of a file unhighlighted.
            .then(() => void hl.codeToTokens("x", { lang: l, theme: PAIR }))
            .catch((e) => {
              loading.delete(l);
              throw e;
            });
          loading.set(l, p);
        }
        return p;
      }),
    );
    return hl;
  } catch (e) {
    console.warn("highlight: load failed", e);
    return null;
  }
}

/** Shiki's dual-theme custom properties for a placeholder color and font style; undefined for plain text. */
function styleOf(color: string | undefined, fontStyle: number | undefined): string | undefined {
  const key = `${color}/${fontStyle}`;
  if (styles.has(key)) return styles.get(key);
  const plain = palette.get("#000000")!;
  const [l, d] = (color && palette.get(color.toUpperCase())) || plain;
  const fs = fontStyle && fontStyle > 0 ? fontStyle : 0;
  let style: string | undefined;
  if (l !== plain[0] || d !== plain[1] || fs) {
    const deco = [fs & 4 ? "underline" : "", fs & 8 ? "line-through" : ""].filter(Boolean).join(" ");
    const font = (side: string) => `${fs & 1 ? `;--shiki-${side}-font-style:italic` : ""}${fs & 2 ? `;--shiki-${side}-font-weight:bold` : ""}${deco ? `;--shiki-${side}-text-decoration:${deco}` : ""}`;
    style = `--shiki-light:${l}${font("light")};--shiki-dark:${d}${font("dark")}`;
  }
  styles.set(key, style);
  return style;
}

function toks(line: ThemedToken[]): TokLine {
  const out: TokLine = [];
  for (const t of line) {
    const style = styleOf(t.color, t.fontStyle);
    const last = out[out.length - 1];
    if (last && last.style === style) last.text += t.content;
    else out.push(style ? { text: t.content, style } : { text: t.content });
  }
  return out;
}

/** Tokenize code with a highlighter that already has `lang` loaded; null when over the limits or on error. */
export function tokenize(hl: HighlighterCore, code: string, lang: Lang): TokLine[] | null {
  if (code.length > LIMITS.bytes) return null;
  try {
    const { tokens } = hl.codeToTokens(code, { lang, theme: PAIR, tokenizeMaxLineLength: LIMITS.lineLength, tokenizeTimeLimit: LIMITS.lineMs });
    return tokens.map(toks);
  } catch (e) {
    console.warn("highlight: tokenize failed", e);
    return null;
  }
}

/** Highlight whole-file lines (as shown in the file view); null means render plain text. */
export async function highlightLines(lines: string[], lang: Lang | null): Promise<TokLine[] | null> {
  if (!lang || !lines.length || lines.length > LIMITS.lines) return null;
  let bytes = 0;
  for (const l of lines) bytes += l.length + 1;
  if (bytes > LIMITS.bytes) return null;
  const hl = await ready([lang]);
  const out = hl && tokenize(hl, lines.join("\n"), lang);
  return out && out.length === lines.length ? out : null;
}

/**
 * Tokens for each line of a unified-diff hunk. The old side (context and deletions)
 * and the new side (context and additions) are tokenized as contiguous snippets so
 * grammar state carries from line to line, then mapped back to rows. Rows that are
 * not code ("\ No newline at end of file") get null, as does every row on failure.
 */
export function diffLineTokens(lines: string[], tokenizeSide: (code: string) => TokLine[] | null): Array<TokLine | null> {
  const olds: string[] = [];
  const news: string[] = [];
  for (const l of lines) {
    const k = l[0];
    if (k === "\\") continue;
    if (k !== "+") olds.push(l.slice(1));
    if (k !== "-") news.push(l.slice(1));
  }
  const o = olds.length ? tokenizeSide(olds.join("\n")) : [];
  const n = news.length ? tokenizeSide(news.join("\n")) : [];
  if (!o || !n || o.length !== olds.length || n.length !== news.length) return lines.map(() => null);
  let oi = 0;
  let ni = 0;
  return lines.map((l) => {
    const k = l[0];
    if (k === "\\") return null;
    if (k === "+") return n[ni++] ?? null;
    if (k === "-") return o[oi++] ?? null;
    oi++;
    return n[ni++] ?? null;
  });
}

/** Render tokens as HTML (for the Markdown renderer, which builds strings). */
export const tokensHtml = (lines: TokLine[]): string =>
  lines.map((l) => l.map((t) => (t.style ? `<span style="${escapeHtml(t.style)}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text))).join("")).join("\n");

/** A sync fence highlighter for renderMarkdown, with the grammars the document's fences name already loaded. */
export async function fenceHighlighter(langs: string[]): Promise<((code: string, info: string) => string | null) | undefined> {
  const wanted = [...new Set(langs.map(langForFence).filter((l): l is Lang => l !== null))].slice(0, 8);
  if (!wanted.length) return undefined;
  const hl = await ready(wanted);
  if (!hl) return undefined;
  let budget = LIMITS.lines;
  return (code, info) => {
    const lang = langForFence(info);
    if (!lang || !wanted.includes(lang)) return null;
    const n = code.split("\n").length;
    if (n > budget) return null;
    budget -= n;
    const t = tokenize(hl, code, lang);
    return t ? tokensHtml(t) : null;
  };
}
