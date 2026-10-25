import { describe, expect, it } from "vitest";
import { renderMarkdown, safeUrl, stripHtmlComments } from "../../src/web/markdown.js";
import { localPath, safeNext } from "../../src/web/auth.js";

const spaces = " ".repeat(50_000);

function timed(source: string): { html: string; ms: number } {
  const t = performance.now();
  const html = renderMarkdown(source);
  return { html, ms: performance.now() - t };
}

/** Ordinary Markdown of `length` characters: paragraphs with emphasis, a link and code. */
function prose(length: number): string {
  const p = "Some *plain* prose with a [link](/x) and `code`.\n\n";
  return p.repeat(Math.ceil(length / p.length)).slice(0, length);
}

/**
 * Renders `source` about as fast as ordinary Markdown of the same length, timed on the same machine,
 * so a slower or busy CI host doesn't change the verdict (the hosts differ about 2x per core and can
 * stall for a moment, vitest.shared.ts). Each takes the best of three. These inputs took 0.1 to 5
 * times as long as the prose on 2026-10-24; a backtracking pattern took seconds, hundreds of times as long.
 */
function expectLinear(source: string): void {
  const best = (s: string) => Math.min(...[0, 1, 2].map(() => timed(s).ms));
  const baseline = best(prose(source.length));
  const ms = best(source);
  expect(ms, `${ms.toFixed(1)} ms, against ${baseline.toFixed(1)} ms for ordinary Markdown as long`).toBeLessThan(25 * baseline + 20);
}

describe("markdown block patterns", () => {
  // Each of these took seconds with a single backtracking regex per line.
  it.each([
    ["a fence followed by spaces and a backtick", "```" + spaces + "`"],
    ["a heading with trailing spaces before a line separator", "# a" + spaces + " "],
    ["a heading with spaces before text", "# a" + spaces + "b"],
    ["a list item with spaces before a line separator", "-" + spaces + " "],
    ["a table delimiter row with spaces before text", "a|b\n|-" + spaces + "x"],
    ["a dash run with spaces before text", "a|b\n---" + spaces + "x"],
  ])("renders %s in linear time", (_name, source) => {
    expectLinear(source);
  });

  // Unmatched link and emphasis openers each scan ahead; a budget per render bounds the total.
  it.each([
    ["unclosed links", "[a](".repeat(14_000)],
    ["unclosed images", "![a](".repeat(11_000)],
    ["emphasis openers that never close", "_1.".repeat(19_000)],
    ["list items of emphasis openers", "- " + "*> ".repeat(19_000)],
    ["many such paragraphs", ("_1.".repeat(19_000) + "\n\n").repeat(8)],
  ])("bounds the lookahead for %s", (_name, source) => {
    expectLinear(source);
  });

  it("formats ordinary text in full", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `Item ${i} has *emphasis*, \`code\` and a [link](/p/${i}).`).join("\n\n");
    const html = renderMarkdown(text);
    expect(html.match(/<em>/g)?.length).toBe(2000);
    expect(html.match(/<a href=/g)?.length).toBe(2000);
  });

  it("still parses headings, fences, lists and tables", () => {
    expect(renderMarkdown("## Title ##")).toContain(">Title</h2>");
    expect(renderMarkdown("# foo#")).toContain(">foo#</h1>");
    expect(renderMarkdown("#\tTabbed  ")).toContain(">Tabbed</h1>");
    expect(renderMarkdown("# ###")).toMatch(/<h1 [^>]*><a [^>]*>#<\/a><\/h1>/);
    expect(renderMarkdown("#nope")).toContain("<p>#nope</p>");
    expect(renderMarkdown("```js extra\nx\n```")).toContain('class="language-js');
    expect(renderMarkdown("``` a`b\nx")).not.toContain("<pre>");
    expect(renderMarkdown("~~~ a`b\nx")).not.toContain("<pre>");
    expect(renderMarkdown("- one\n- two")).toContain("<li>one</li>");
    const table = renderMarkdown("| a | b |\n| :-- | --: |\n| 1 | 2 |");
    expect(table).toContain('<th style="text-align:left">a</th>');
    expect(table).toContain('<td style="text-align:right">2</td>');
    expect(renderMarkdown("a | b\n-|-")).toContain("<table>");
    expect(renderMarkdown("a | b\n-||-")).not.toContain("<table>");
    expect(renderMarkdown("a | b\n|")).not.toContain("<table>");
  });
});

describe("same-site paths", () => {
  it("refuses paths that browsers resolve to another site", () => {
    for (const p of ["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/\r\n/evil.com", "https://evil.com", "evil.com", "", 7, null]) {
      expect(localPath(p)).toBeNull();
      expect(safeNext(p)).toBe("/");
    }
    expect(safeNext("/owner/repo/pulls?q=is:open")).toBe("/owner/repo/pulls?q=is:open");
    expect(safeNext("/a b")).toBe("/a b");
  });

  it("refuses Markdown links that start with a slash and a backslash in either order", () => {
    for (const u of ["\\/evil.com", "/\\evil.com", "\\\\evil.com", "//evil.com", "/\t/evil.com"]) expect(safeUrl(u, "link", {})).toBeNull();
    expect(safeUrl("/docs", "link", {})).toBe("/docs");
  });
});

describe("markdown over many lines", () => {
  it.each([
    ["short lines", "&\n".repeat(29_000)],
    ["hard line breaks", "a  \n".repeat(14_000)],
    ["a long tilde run", "~".repeat(59_000) + "`"],
    ["a long backtick run", "`".repeat(59_000) + "x`"],
  ])("renders %s in linear time", (_name, source) => {
    expectLinear(source);
  });

  it("keeps hard line breaks", () => {
    expect(renderMarkdown("one  \ntwo\nthree   \nfour")).toBe("<p>one<br>\ntwo\nthree<br>\nfour</p>");
  });
});

describe("HTML comments", () => {
  const attribution = '<!-- claude-projects-attribution: {"github_login":"someone"} -->\n_Requested by **Someone**_\n\nBody.';

  it("hides a comment on its own lines, as GitHub does", () => {
    expect(renderMarkdown(attribution)).toBe("<p><em>Requested by <strong>Someone</strong></em></p>\n<p>Body.</p>");
    expect(renderMarkdown("Before.\n\n<!--\nhidden\n\nstill hidden\n-->\n\nAfter.")).toBe("<p>Before.</p>\n<p>After.</p>");
    expect(renderMarkdown("<!---->\n<!-->\n<!--->\nShown.")).toBe("<p>Shown.</p>");
  });

  it("ends a paragraph at a comment line and renders what follows the close", () => {
    expect(renderMarkdown("One\n<!-- x -->\nTwo")).toBe("<p>One</p>\n<p>Two</p>");
    expect(renderMarkdown("<!-- a\nb --> **after**")).toBe("<p><strong>after</strong></p>");
  });

  it("hides comments inside text, headings, lists, quotes and tables", () => {
    expect(renderMarkdown("a <!-- b --> c")).toBe("<p>a  c</p>");
    expect(renderMarkdown("a <!-- b\nc --> d")).toBe("<p>a  d</p>");
    expect(renderMarkdown("# Title <!-- note -->")).toBe('<h1 id="h-title"><a class="anchor" href="#h-title" aria-hidden="true">#</a>Title </h1>');
    expect(renderMarkdown("- one <!-- x -->\n- two")).toBe("<ul><li>one </li><li>two</li></ul>");
    expect(renderMarkdown("> <!-- x -->\n> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
    expect(renderMarkdown("| a <!-- x --> |\n| - |\n| b |")).toContain("<th>a </th>");
    expect(renderMarkdown("*a <!-- * --> b*")).toBe("<p><em>a  b</em></p>");
  });

  it("keeps comments in code, escaped and unclosed ones as text", () => {
    expect(renderMarkdown("```html\n<!-- kept -->\n```")).toContain("&lt;!-- kept --&gt;");
    expect(renderMarkdown("    <!-- kept -->")).toBe("<pre><code>&lt;!-- kept --&gt;</code></pre>");
    expect(renderMarkdown("`<!-- kept -->`")).toBe("<p><code>&lt;!-- kept --&gt;</code></p>");
    expect(renderMarkdown("\\<!-- kept -->")).toBe("<p>&lt;!-- kept --&gt;</p>");
    expect(renderMarkdown("a <!-- open")).toBe("<p>a &lt;!-- open</p>");
  });

  it("hides the rest of the document after a comment line that never closes, as GitHub does", () => {
    expect(renderMarkdown("Shown.\n\n<!-- open\n\nhidden")).toBe("<p>Shown.</p>");
  });

  it("never lets markup through around a comment", () => {
    const html = renderMarkdown('<!-- x --><script>alert(1)</script>\n\na <!-- y --><img src=x onerror=alert(1)> b');
    expect(html).not.toMatch(/<(script|img)\b/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders many comment openers in linear time", () => {
    expectLinear("a <!-- ".repeat(40_000));
    expectLinear("a <!-- b --> ".repeat(30_000));
    expectLinear("<!-- x -->\n".repeat(40_000));
    expectLinear("`` <!-- ` ".repeat(30_000) + "-->");
  });

  it("strips comments from plain text, outside code", () => {
    expect(stripHtmlComments(attribution)).toBe("_Requested by **Someone**_\n\nBody.");
    expect(stripHtmlComments("a\n\n<!-- x -->\n\nb `<!-- y -->`\n```\n<!-- z -->\n```")).toBe("a\n\nb `<!-- y -->`\n```\n<!-- z -->\n```");
    expect(stripHtmlComments("no comments\n\n\n\nhere")).toBe("no comments\n\n\n\nhere");
  });
});

describe("GitHub alerts", () => {
  it("renders > [!NOTE] and the other four kinds as alerts, as GitHub does", () => {
    expect(renderMarkdown("> [!TIP]\n> Use **passkeys**.")).toBe('<div class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title">Tip</p><p>Use <strong>passkeys</strong>.</p></div>');
    for (const k of ["NOTE", "important", "Warning", "CAUTION"]) expect(renderMarkdown(`> [!${k}]\n> x`)).toContain(`markdown-alert-${k.toLowerCase()}"><p class="markdown-alert-title">${k[0]!.toUpperCase()}${k.slice(1).toLowerCase()}</p>`);
  });

  it("keeps a plain quote when the marker is unknown, not alone on its line, or has nothing after it", () => {
    expect(renderMarkdown("> [!DANGER]\n> x")).toBe("<blockquote><p>[!DANGER]\nx</p></blockquote>");
    expect(renderMarkdown("> [!NOTE] inline\n> x")).toContain("<blockquote>");
    expect(renderMarkdown("> [!NOTE]")).toContain("<blockquote>");
  });

  it("escapes what is inside an alert like any other Markdown", () => {
    expect(renderMarkdown('> [!WARNING]\n> <img src=x onerror="alert(1)">')).not.toContain("<img");
  });
});
