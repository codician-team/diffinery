/**
 * The bulky generated content stays out of the Worker's main module, in text modules that upload as parts of their
 * own (scripts/build-docs.mjs, scripts/build-grammars.mjs). With it inlined the main module was 14 MB, which hosts
 * that cap each uploaded part refuse (open-compute: 8 MiB). Needs `pnpm build`.
 */
import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES } from "../../src/docs/content.generated.js";
import { GRAMMAR_LANGS, GRAMMAR_ORDER, GRAMMAR_TEXT } from "../../src/web/grammars.generated.js";

const size = (rel: string) => statSync(new URL(rel, import.meta.url)).size;

describe("main module size", () => {
  it("keeps the docs' pages, images and downloads in a text module", () => {
    expect(size("../../src/docs/content.generated.ts")).toBeLessThan(64 * 1024);
    expect(size("../../build/docs/content.txt")).toBeGreaterThan(1024 * 1024);
    expect(DOCS_PAGES.quickstart?.title).toBeTruthy();
  });

  it("keeps the highlighting grammars in text modules, each grammar once", () => {
    expect(size("../../src/web/grammars.generated.ts")).toBeLessThan(32 * 1024);
    for (const lang of GRAMMAR_LANGS) {
      expect(GRAMMAR_ORDER[lang].length).toBeGreaterThan(0);
      for (const name of GRAMMAR_ORDER[lang]) expect(JSON.parse(GRAMMAR_TEXT[name]!).name).toBe(name);
    }
  });
});
