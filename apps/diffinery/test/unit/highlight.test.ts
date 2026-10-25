import { describe, expect, it } from "vitest";
import { diffLineTokens, fenceHighlighter, highlightLines, langForFence, langForPath, LANGS, LIMITS, ready, tokenize, type Lang, type TokLine } from "../../src/web/highlight.js";
import { fenceLangs, renderMarkdown } from "../../src/web/markdown.js";

const text = (line: TokLine | null | undefined) => line?.map((t) => t.text).join("") ?? null;

describe("language detection", () => {
  it("maps file names and extensions", () => {
    const cases: Record<string, string | null> = {
      "src/app.ts": "typescript",
      "src/App.tsx": "tsx",
      "lib/x.mjs": "javascript",
      "lib/x.cjs": "javascript",
      "a/b.jsx": "jsx",
      "Dockerfile": "docker",
      "deploy/Dockerfile.prod": "docker",
      "web.dockerfile": "docker",
      "Makefile": "make",
      "GNUmakefile": "make",
      ".github/workflows/ci.yml": "yaml",
      "config.yaml": "yaml",
      "inc/x.h": "c",
      "inc/x.hpp": "cpp",
      "src/x.cc": "cpp",
      "run.sh": "shellscript",
      "x.bash": "shellscript",
      ".zshrc": "shellscript",
      ".env": "dotenv",
      ".env.local": "dotenv",
      ".gitignore": null,
      "tsconfig.json": "jsonc",
      "tsconfig.build.json": "jsonc",
      "package.json": "json",
      "Cargo.toml": "toml",
      "main.go": "go",
      "lib.rs": "rust",
      "App.vue": "vue",
      "Page.svelte": "svelte",
      "main.tf": "terraform",
      "nginx.conf": "nginx",
      "Gemfile": "ruby",
      "build.gradle": "groovy",
      "api.proto": "proto",
      "fix.patch": "diff",
      "x.m": "objective-c",
      "core.clj": "clojure",
      "README": null,
      "LICENSE": null,
      "notes.txt": null,
      "image.png": null,
    };
    for (const [path, lang] of Object.entries(cases)) expect([path, langForPath(path)]).toEqual([path, lang]);
  });

  it("maps fence names and aliases", () => {
    expect(langForFence("ts")).toBe("typescript");
    expect(langForFence("TypeScript")).toBe("typescript");
    expect(langForFence("yml")).toBe("yaml");
    expect(langForFence("bash")).toBe("shellscript");
    expect(langForFence("sh")).toBe("shellscript");
    expect(langForFence("console")).toBe("shellscript");
    expect(langForFence("c++")).toBe("cpp");
    expect(langForFence("c#")).toBe("csharp");
    expect(langForFence("golang")).toBe("go");
    expect(langForFence("dockerfile")).toBe("docker");
    expect(langForFence("hcl")).toBe("hcl");
    expect(langForFence("{.python}")).toBe("python");
    expect(langForFence("text")).toBeNull();
    expect(langForFence("mermaid")).toBeNull();
  });
});

describe("tokens", () => {
  it("tokenizes with both themes as CSS variables and leaves default text bare", async () => {
    // The first tokenization compiles the grammar's regexes, which can use up the
    // per-line tokenize time limit on a slow runner (the rest of the line is then left
    // plain, by design). Warm the grammar so the assertions below don't race it.
    await highlightLines(["const warm = 0;"], "typescript");
    const out = await highlightLines(["const a = 1; // one", "", "export {};"], "typescript");
    expect(out).toHaveLength(3);
    expect(out!.map(text)).toEqual(["const a = 1; // one", "", "export {};"]);
    const kw = out![0]!.find((t) => t.text === "const")!;
    expect(kw.style).toMatch(/^--shiki-light:#[0-9A-F]{6};--shiki-dark:#[0-9A-F]{6}$/i);
    expect(out![0]!.some((t) => !t.style)).toBe(true);
    expect(out![0]!.every((t) => !t.style || /^(--shiki-[a-z-]+:[^;"<>]+;?)+$/.test(t.style))).toBe(true);
  });

  it("loads every grammar on the JavaScript regex engine", async () => {
    for (const lang of LANGS) {
      const hl = await ready([lang]);
      expect([lang, hl !== null]).toEqual([lang, true]);
      const out = tokenize(hl!, "x = 1 # a\n// b\n<a href='c'>d</a>", lang);
      expect([lang, out?.length]).toEqual([lang, 3]);
    }
  }, 60_000);

  it("falls back to plain text for unknown languages and oversized input", async () => {
    expect(await highlightLines(["x"], null)).toBeNull();
    expect(await highlightLines(Array.from({ length: LIMITS.lines + 1 }, () => "x"), "typescript")).toBeNull();
    expect(await highlightLines(["x".repeat(LIMITS.bytes + 1)], "typescript")).toBeNull();
  });

  it("does not tokenize very long lines", async () => {
    const long = `const s = "${"a".repeat(LIMITS.lineLength + 10)}";`;
    const out = await highlightLines([long, "let b = 2;"], "typescript");
    expect(out!.map(text)).toEqual([long, "let b = 2;"]);
    expect(out![0]).toEqual([{ text: long }]);
    expect(out![1]!.find((t) => t.text === "let")?.style).toBeTruthy();
  });

  it("highlights a 1,500-line TypeScript file quickly", async () => {
    const chunk = [
      "import { readFile } from \"node:fs/promises\";",
      "/** A documented interface. */",
      "export interface Item<T extends object = {}> { id: number; name: string; meta?: T }",
      "export async function load(path: string): Promise<Item[]> {",
      "  const raw = await readFile(path, \"utf8\"); // read",
      "  return JSON.parse(raw).map((x: any, i: number) => ({ id: i, name: `item ${x.name}` }));",
      "}",
      "class Store { #items = new Map<number, Item>(); get size() { return this.#items.size; } }",
      "const re = /^(?:[a-z]+)\\d*$/gi;",
      "",
    ];
    const lines = Array.from({ length: 1500 }, (_, i) => chunk[i % chunk.length]!);
    await ready(["typescript"]);
    const t0 = performance.now();
    const out = await highlightLines(lines, "typescript");
    const ms = performance.now() - t0;
    console.log(`highlight: 1,500-line TypeScript file in ${ms.toFixed(0)} ms`);
    expect(out).toHaveLength(1500);
    expect(ms).toBeLessThan(5000);
  });
});

describe("paired GitHub themes", () => {
  it("match Shiki's own dual-theme output", async () => {
    const { createHighlighterCore } = await import("shiki/core");
    const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
    const samples: Array<[Lang, string]> = [
      ["typescript", 'import { a } from "b";\n/** doc @param x */\nexport class C<T> extends D { #x = 1; get y(): T { return `v${this.#x}` as T } }\nconst re = /a+/g;'],
      ["markdown", "# Title\n\n*em* **bold** ~~gone~~ [link](https://x.y)\n\n> quote\n\n- item"],
      ["python", "@dataclass\nclass A:\n    def f(self, x: int = 2) -> str:\n        return f\"{x!r}\"  # c"],
      ["diff", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new"],
      ["yaml", "on:\n  push:\n    branches: [main] # c\njobs: { a: 1 }"],
    ];
    const ref = await createHighlighterCore({ themes: [import("shiki/themes/github-light-default.mjs"), import("shiki/themes/github-dark-default.mjs")], langs: samples.map(([l]) => import(`shiki/langs/${l}.mjs`)), engine: createJavaScriptRegexEngine({ forgiving: true }) });
    const hl = await ready(samples.map(([l]) => l));
    for (const [lang, code] of samples) {
      const { tokens: theirs, fg } = ref.codeToTokens(code, { lang, themes: { light: "github-light-default", dark: "github-dark-default" }, defaultColor: false });
      const ours = tokenize(hl!, code, lang)!;
      const flat = (lines: Array<Array<{ text: string; style?: string }>>) => lines.map((l) => l.flatMap((t) => [...t.text].map((ch) => `${ch}\t${t.style ?? ""}`)));
      // Shiki spells out the default foreground and token backgrounds; ours leaves both to the site.
      const style = (s: Record<string, string> = {}) => Object.entries(s).filter(([k]) => !k.endsWith("-bg")).map(([k, v]) => `${k}:${v}`).join(";");
      const expected = theirs.map((l) => l.map((t) => ({ text: t.content, style: style(t.htmlStyle).toLowerCase() === fg!.toLowerCase() ? undefined : style(t.htmlStyle) })));
      expect([lang, flat(ours)]).toEqual([lang, flat(expected)]);
    }
  });
});

describe("diff mapping", () => {
  // Each token records the snippet it was tokenized from.
  const fake = (code: string): TokLine[] => code.split("\n").map((l) => [{ text: l, style: code.replace(/\n/g, "|") }]);

  it("maps old and new side tokens back to rows", () => {
    const hunk = [" a", "-b", "-c", "+B", " d", "\\ No newline at end of file", "+e"];
    const rows = diffLineTokens(hunk, fake);
    expect(rows.map(text)).toEqual(["a", "b", "c", "B", "d", null, "e"]);
    expect(rows.map((r) => r?.[0]?.style ?? null)).toEqual(["a|B|d|e", "a|b|c|d", "a|b|c|d", "a|B|d|e", "a|B|d|e", null, "a|B|d|e"]);
  });

  it("treats empty lines as context and fails soft", () => {
    expect(diffLineTokens(["", "+x"], fake).map(text)).toEqual(["", "x"]);
    expect(diffLineTokens([" a", "+b"], () => null)).toEqual([null, null]);
    expect(diffLineTokens([" a", "+b"], () => [])).toEqual([null, null]);
  });

  it("carries grammar state across rows of a hunk", async () => {
    const hl = await ready(["typescript"]);
    const hunk = [" /* start of a", "-old comment", "+new comment", " end */ const x = 1;"];
    const rows = diffLineTokens(hunk, (code) => tokenize(hl!, code, "typescript"));
    expect(rows.map(text)).toEqual(["/* start of a", "old comment", "new comment", "end */ const x = 1;"]);
    const comment = rows[0]![0]!.style;
    expect(rows[1]![0]!.style).toBe(comment);
    expect(rows[2]![0]!.style).toBe(comment);
    expect(rows[3]!.find((t) => t.text.includes("const"))?.style).not.toBe(comment);
  });
});

describe("markdown fences", () => {
  it("highlights named fences and escapes code", async () => {
    const md = "# T\n\n```ts\nconst a = \"<b>\" && 1;\n```\n\n```\nplain <i>\n```\n\n```mermaid\ngraph\n```\n";
    expect(fenceLangs(md)).toEqual(["ts", "mermaid"]);
    const html = renderMarkdown(md, { highlight: await fenceHighlighter(fenceLangs(md)) });
    expect(html).toContain('<code class="language-ts sh">');
    expect(html).toMatch(/<span style="--shiki-light:#[0-9A-F]{6};--shiki-dark:#[0-9A-F]{6}">const<\/span>/i);
    expect(html).toContain("&quot;&lt;b&gt;&quot;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("<pre><code>plain &lt;i&gt;</code></pre>");
    expect(html).toContain('<code class="language-mermaid">graph</code>');
  });

  it("renders plain code without a highlighter", async () => {
    expect(await fenceHighlighter(["text", "mermaid"])).toBeUndefined();
    expect(renderMarkdown("```ts\nlet x\n```")).toBe('<pre><code class="language-ts">let x</code></pre>');
  });
});
