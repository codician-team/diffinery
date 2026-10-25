/**
 * A small, safe Markdown renderer for READMEs, issues, pull requests and job
 * summaries. All raw HTML in the source is escaped, except HTML comments, which
 * are dropped as GitHub drops them; only http(s), mailto-free relative and
 * fragment URLs survive in links and images.
 *
 * Supported: ATX headings, paragraphs, hard breaks, fenced code, thematic
 * breaks, blockquotes, ordered/unordered/task lists (nested), tables, inline
 * code, bold, italic, strikethrough, links, images and bare/auto links.
 */

export interface MarkdownBase {
  /** Repository owner and name, for resolving relative links. */
  owner: string;
  repo: string;
  /** Ref (branch, tag or sha) that relative links point at. */
  ref: string;
  /** Directory of the document inside the repository ("" for the root). */
  dir: string;
}

export interface MarkdownOptions {
  base?: MarkdownBase;
  /** Syntax highlighter for fenced code: HTML for the code, or null for plain text. */
  highlight?: (code: string, lang: string) => string | null;
  /** Prefix for heading ids and fragment links (default "h-", which keeps user content clear of the page's own ids). */
  idPrefix?: string;
  /**
   * Where an image's src (absolute, or relative to this site) should point; null shows its alt
   * text instead. The web pages send images from other sites through Diffinery's image proxy
   * this way (lib/camo.ts). Links keep their original targets.
   */
  image?: (src: string) => string | null;
}

const MAX_SOURCE = 512 * 1024;
const MAX_DEPTH = 12;
const MAX_INLINE = 60_000;
const MAX_SCAN = 2000;
/**
 * Characters that link, code and emphasis lookahead may scan in one render: 4 per source
 * character, where real documents scan well under 1. Each unmatched `[`, `*` or `_` scans up
 * to MAX_SCAN ahead, so a crafted paragraph would cost MAX_SCAN times its length; past the
 * budget the rest of the inline text is shown escaped, without formatting.
 */
const scanBudget = (sourceLength: number): number => 250_000 + 4 * sourceLength;
// Rendering is synchronous, so one counter per isolate is safe.
let scanned = 0;
let budget = 0;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const encPath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^<>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/** Normalise "a/./b/../c" style paths; returns null when the path escapes the root. */
function normalise(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/**
 * Validate and resolve a URL from Markdown source. Returns null for anything
 * that is not http(s), a fragment, or a relative path.
 */
export function safeUrl(url: string, kind: "link" | "image", opts: MarkdownOptions): string | null {
  const u = url.trim();
  if (!u) return null;
  // Browsers ignore control characters and whitespace when parsing schemes.
  const probe = u.replace(/[\x00-\x20\x7f]/g, "");
  if (/^https?:\/\//i.test(probe)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe) || /^[/\\]{2}/.test(probe)) return null;
  if (u.startsWith("#")) return kind === "link" ? `#${opts.idPrefix ?? "h-"}${slugify(decodeSafe(u.slice(1)))}` : null;
  const base = opts.base;
  if (!base) return u.startsWith("/") ? u : null;
  const hashAt = u.search(/[?#]/);
  const pathPart = hashAt >= 0 ? u.slice(0, hashAt) : u;
  const suffix = hashAt >= 0 ? u.slice(hashAt) : "";
  const joined = pathPart.startsWith("/") ? pathPart : `${base.dir ? `${base.dir}/` : ""}${pathPart}`;
  const norm = normalise(decodeSafe(joined));
  if (norm === null) return null;
  const root = `/${base.owner}/${base.repo}`;
  if (kind === "image") return `${root}/raw/${encPath(base.ref)}/${encPath(norm)}`;
  const isDir = pathPart.endsWith("/") || norm === "";
  return `${root}/${isDir ? "tree" : "blob"}/${encPath(base.ref)}${norm ? `/${encPath(norm)}` : ""}${suffix.replace(/[<>"']/g, "")}`;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------- inline

/**
 * Text with its HTML comments (`<!-- … -->`, also `<!-->` and `<!--->`) removed. Code spans and
 * backslash-escaped `<` are kept as written, and an unclosed `<!--` stays as text.
 */
function stripComments(src: string): string {
  if (!src.includes("<!--")) return src;
  let out = "";
  let i = 0;
  const n = src.length;
  // Every comment closes at or before the last "-->", so an opener past it is text: no rescans.
  const lastClose = src.lastIndexOf("-->");
  while (i < n) {
    if (scanned > budget) return out + src.slice(i);
    const ch = src[i]!;
    if (ch === "\\") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (src[i + run] === "`") run++;
      const fence = "`".repeat(run);
      let close = src.indexOf(fence, i + run);
      while (close >= 0 && src[close + run] === "`") {
        let skip = close;
        while (src[skip] === "`") skip++;
        close = src.indexOf(fence, skip);
      }
      scanned += (close < 0 ? n : close) - i;
      const end = close < 0 ? i + run : close + run;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "<" && src.startsWith("<!--", i) && lastClose >= i + 2) {
      const close = src.indexOf("-->", i + 2);
      scanned += close - i;
      i = close + 3;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findClosing(src: string, delim: string, from: number, wordy: boolean): number {
  let at = from;
  const limit = Math.min(src.length, from + MAX_SCAN * 2);
  const window = src.slice(0, limit);
  for (;;) {
    const idx = window.indexOf(delim, at);
    scanned += (idx < 0 ? limit : idx) - at + 1;
    if (idx < 0) return -1;
    const before = src[idx - 1];
    const after = src[idx + delim.length];
    if (idx > from && before !== undefined && !/\s/.test(before) && (!wordy || after === undefined || !/[\p{L}\p{N}]/u.test(after))) {
      // When closing a single delimiter, skip over a double run ("**") that belongs to nested strong text.
      if (delim.length === 1 && after === delim && src[idx + 2] !== delim) {
        at = idx + 2;
        continue;
      }
      return idx;
    }
    at = idx + 1;
  }
}

interface LinkMatch {
  text: string;
  url: string;
  title: string | null;
  end: number;
}

/** Parse `[text](url "title")` starting at the "[" at `i`. */
function parseLink(src: string, i: number): LinkMatch | null {
  let depth = 0;
  let j = i;
  const limit = Math.min(src.length, i + MAX_SCAN);
  for (; j < limit; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "`") {
      const close = src.indexOf("`", j + 1);
      if (close > 0 && close < limit) j = close;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  scanned += j - i;
  if (depth !== 0 || src[j] !== "]" || src[j + 1] !== "(") return null;
  const text = src.slice(i + 1, j);
  let k = j + 2;
  while (src[k] === " ") k++;
  let url = "";
  if (src[k] === "<") {
    const close = src.indexOf(">", k);
    scanned += (close < 0 ? src.length : close) - k;
    if (close < 0 || close - k > MAX_SCAN) return null;
    url = src.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    const start = k;
    for (; k < src.length && k - start < MAX_SCAN; k++) {
      const ch = src[k]!;
      if (ch === "\\") {
        k++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "(") parens++;
      else if (ch === ")") {
        if (parens === 0) break;
        parens--;
      }
    }
    scanned += k - start;
    url = src.slice(start, k).replace(/\\([()])/g, "$1");
  }
  while (src[k] === " ") k++;
  let title: string | null = null;
  const q = src[k];
  if (q === '"' || q === "'" || q === "(") {
    const closeCh = q === "(" ? ")" : q;
    const close = src.indexOf(closeCh, k + 1);
    scanned += (close < 0 ? src.length : close) - k;
    if (close < 0) return null;
    title = src.slice(k + 1, close);
    k = close + 1;
    while (src[k] === " ") k++;
  }
  if (src[k] !== ")") return null;
  return { text, url, title, end: k + 1 };
}

const BARE_URL = /^https?:\/\/[^\s<>"'`]*[^\s<>"'`.,:;!?)\]}*_~]/i;

function inline(text: string, opts: MarkdownOptions, depth = 0): string {
  if (text.length > MAX_INLINE || depth > MAX_DEPTH) return escapeHtml(text);
  const src = stripComments(text);
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (scanned > budget) return out + escapeHtml(src.slice(i));
    const ch = src[i]!;
    // Backslash escapes and hard line breaks.
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        out += "<br>\n";
        i += 2;
        continue;
      }
      if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
        out += escapeHtml(next);
        i += 2;
        continue;
      }
    }
    // Two or more spaces before a newline are a hard line break. Decided from the source:
    // looking at the end of `out` would flatten the whole string on every line.
    if (ch === " ") {
      let run = 1;
      while (src[i + run] === " ") run++;
      if (run >= 2 && src[i + run] === "\n") {
        out += "<br>\n";
        i += run + 1;
        continue;
      }
      out += " ".repeat(run);
      i += run;
      continue;
    }
    // Code spans.
    if (ch === "`") {
      let run = 1;
      while (src[i + run] === "`") run++;
      const fence = "`".repeat(run);
      let close = src.indexOf(fence, i + run);
      while (close >= 0 && src[close + run] === "`") {
        let skip = close;
        while (src[skip] === "`") skip++;
        close = src.indexOf(fence, skip);
      }
      scanned += (close < 0 ? n : close) - i;
      if (close >= 0) {
        let code = src.slice(i + run, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out += `<code>${escapeHtml(code)}</code>`;
        i = close + run;
        continue;
      }
      out += fence;
      i += run;
      continue;
    }
    // Images.
    if (ch === "!" && src[i + 1] === "[") {
      const m = parseLink(src, i + 1);
      if (m) {
        const safe = safeUrl(m.url, "image", opts);
        const url = safe && opts.image ? opts.image(safe) : safe;
        const alt = escapeHtml(m.text.replace(/[\\*_`[\]]/g, ""));
        if (url) out += `<img src="${escapeHtml(url)}" alt="${alt}"${m.title ? ` title="${escapeHtml(m.title)}"` : ""} loading="lazy" referrerpolicy="no-referrer">`;
        else out += alt;
        i = m.end;
        continue;
      }
    }
    // Links.
    if (ch === "[") {
      const m = parseLink(src, i);
      if (m) {
        const url = safeUrl(m.url, "link", opts);
        const label = inline(m.text, opts, depth + 1);
        if (url) {
          const external = /^https?:/i.test(url);
          out += `<a href="${escapeHtml(url)}"${m.title ? ` title="${escapeHtml(m.title)}"` : ""}${external ? ' rel="nofollow noopener noreferrer"' : ""}>${label}</a>`;
        } else out += label;
        i = m.end;
        continue;
      }
    }
    // Autolinks <https://…>.
    if (ch === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i, i + MAX_SCAN));
      if (m) {
        const url = escapeHtml(m[1]!);
        out += `<a href="${url}" rel="nofollow noopener noreferrer">${url}</a>`;
        i += m[0].length;
        continue;
      }
    }
    // Bare URLs.
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const m = BARE_URL.exec(src.slice(i, i + MAX_SCAN));
      if (m) {
        const url = escapeHtml(m[0]);
        out += `<a href="${url}" rel="nofollow noopener noreferrer">${url}</a>`;
        i += m[0].length;
        continue;
      }
    }
    // Strikethrough.
    if (ch === "~" && src[i + 1] === "~" && src[i + 2] && !/\s/.test(src[i + 2]!)) {
      const close = findClosing(src, "~~", i + 2, false);
      if (close > i + 2) {
        out += `<del>${inline(src.slice(i + 2, close), opts, depth + 1)}</del>`;
        i = close + 2;
        continue;
      }
    }
    // Emphasis.
    if (ch === "*" || ch === "_") {
      let run = 1;
      while (src[i + run] === ch) run++;
      const wordy = ch === "_";
      const prev = src[i - 1];
      const nextCh = src[i + run];
      const canOpen = nextCh !== undefined && !/\s/.test(nextCh) && !(wordy && prev !== undefined && /[\p{L}\p{N}]/u.test(prev));
      let matched = false;
      if (canOpen && run <= 3) {
        for (const size of run === 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1]) {
          const delim = ch.repeat(size);
          const start = i + run;
          const close = findClosing(src, delim, start, wordy);
          if (close > start) {
            const inner = inline(src.slice(start, close), opts, depth + 1);
            out += escapeHtml(ch.repeat(run - size));
            out += size === 3 ? `<strong><em>${inner}</em></strong>` : size === 2 ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
            i = close + size;
            matched = true;
            break;
          }
        }
      }
      if (matched) continue;
      out += escapeHtml(ch.repeat(run));
      i += run;
      continue;
    }
    out += ESC[ch] ?? ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- blocks

// Block patterns run on every line, so none may backtrack: no two adjacent quantifiers that
// can match the same characters, and `[^]` rather than `.`, which stops at U+2028 and fails
// the `$` after it. Trailing spaces and closing `#`s are trimmed by hand (see headingText).
const FENCE = /^ {0,3}(`{3,}(?!`)|~{3,}(?!~))(?![^`]*`)\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]([^]*))?$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?([^]*)$/;
const ALERT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const COMMENT = /^ {0,3}<!--/;
const LIST_ITEM = /^( {0,12})([*+-]|\d{1,9}[.)])([ \t]+([^]*))?$/;
const SEP_CELL = /^:?-+:?$/;

function trimBlank(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === " " || s[a] === "\t")) a++;
  while (b > a && (s[b - 1] === " " || s[b - 1] === "\t")) b--;
  return s.slice(a, b);
}

/** A heading's text without its surrounding spaces and optional closing `#`s. */
function headingText(raw: string): string {
  const t = trimBlank(raw);
  let j = t.length;
  while (j > 0 && t[j - 1] === "#") j--;
  if (j === t.length) return t;
  if (j === 0) return "";
  return t[j - 1] === " " || t[j - 1] === "\t" ? trimBlank(t.slice(0, j)) : t;
}

/** A table's delimiter row, like `| :-- | --: |`, checked cell by cell. */
function tableSep(line: string): boolean {
  let s = trimBlank(line);
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").every((cell) => SEP_CELL.test(trimBlank(cell)));
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    COMMENT.test(line) ||
    /^ {0,3}([*+-]|1[.)])[ \t]+\S/.test(line) ||
    (line.includes("|") && next !== undefined && tableSep(next))
  );
}

function blocks(lines: string[], opts: MarkdownOptions, depth: number, tight = false): string {
  if (depth > MAX_DEPTH) return `<p>${escapeHtml(lines.join("\n"))}</p>`;
  let i = 0;
  const parts: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? "";
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!.replace(new RegExp(`^ {0,${indent}}`), ""));
        i++;
      }
      i++;
      const named = /^[\w+#.-]{1,30}$/.test(lang) ? lang : "";
      const hl = named && opts.highlight ? opts.highlight(body.join("\n"), named) : null;
      const cls = named ? ` class="language-${escapeHtml(named)}${hl !== null ? " sh" : ""}"` : "";
      parts.push(`<pre><code${cls}>${hl ?? escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    // Indented code (4 spaces), only outside lists.
    if (/^( {4}|\t)/.test(line) && !tight) {
      const body: string[] = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]!) || !lines[i]!.trim())) {
        body.push(lines[i]!.replace(/^( {4}|\t)/, ""));
        i++;
      }
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      parts.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    // HTML comments, hidden as GitHub hides them. A line that starts with "<!--" opens one that
    // runs to the line holding "-->"; anything after the close on that line is rendered as usual.
    // Left open, it hides the rest of the document (or of the list item or quote it is in).
    const comment = COMMENT.exec(line);
    if (comment) {
      let j = i;
      let close = line.indexOf("-->", comment[0].length - 2);
      while (close < 0 && ++j < lines.length) close = lines[j]!.indexOf("-->");
      if (close < 0) break;
      const rest = lines[j]!.slice(close + 3).trimStart();
      if (rest) lines[j] = rest;
      i = rest ? j : j + 1;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = stripComments(headingText(h[2] ?? ""));
      const html = inline(text, opts, depth);
      const id = escapeHtml(`${opts.idPrefix ?? "h-"}${slugify(text)}`);
      parts.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      parts.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const m = QUOTE.exec(lines[i]!);
        if (m) body.push(m[1]!);
        else if (body.length && !startsBlock(lines[i]!, lines[i + 1])) body.push(lines[i]!);
        else break;
        i++;
      }
      // GitHub's alerts: a quote whose first line is only [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION].
      const alert = ALERT.exec(body[0] ?? "");
      if (alert && body.length > 1) {
        const kind = alert[1]!.toLowerCase();
        parts.push(`<div class="markdown-alert markdown-alert-${kind}"><p class="markdown-alert-title">${kind[0]!.toUpperCase()}${kind.slice(1)}</p>${blocks(body.slice(1), opts, depth + 1)}</div>`);
        continue;
      }
      parts.push(`<blockquote>${blocks(body, opts, depth + 1)}</blockquote>`);
      continue;
    }
    // Tables.
    if (line.includes("|") && i + 1 < lines.length && tableSep(lines[i + 1]!)) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const cell = (tag: string, text: string, idx: number) => `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${inline(text, opts, depth)}</${tag}>`;
      let t = `<div class="table-wrap"><table><thead><tr>${head.map((c, idx) => cell("th", c, idx)).join("")}</tr></thead>`;
      if (rows.length) t += `<tbody>${rows.map((r) => `<tr>${head.map((_, idx) => cell("td", r[idx] ?? "", idx)).join("")}</tr>`).join("")}</tbody>`;
      parts.push(`${t}</table></div>`);
      continue;
    }
    // Lists.
    const li = LIST_ITEM.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const baseIndent = li[1]!.length;
      const start = ordered ? parseInt(li[2]!, 10) : 1;
      const items: string[][] = [];
      let loose = false;
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (!m || m[1]!.length > baseIndent + 1 || m[1]!.length < baseIndent || /\d/.test(m[2]!) !== ordered) break;
        const contentIndent = m[1]!.length + m[2]!.length + Math.max(1, Math.min(4, (m[3] ?? " ").length - (m[4] ?? "").length));
        const item: string[] = [m[4] ?? ""];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const l = lines[i]!;
          if (!l.trim()) {
            sawBlank = true;
            item.push("");
            i++;
            continue;
          }
          const ind = l.length - l.trimStart().length;
          if (ind >= contentIndent || (ind > baseIndent && LIST_ITEM.test(l))) {
            item.push(l.slice(Math.min(ind, contentIndent)));
            sawBlank = false;
            i++;
            continue;
          }
          if (!sawBlank && !startsBlock(l, lines[i + 1]) && !LIST_ITEM.test(l)) {
            // Lazy continuation of the item's paragraph.
            item.push(l.trim());
            i++;
            continue;
          }
          break;
        }
        while (item.length && !item[item.length - 1]!.trim()) {
          item.pop();
          if (i < lines.length && LIST_ITEM.test(lines[i]!)) loose = true;
        }
        if (item.slice(1).some((l, idx) => !l.trim() && item[idx + 2] !== undefined && !/^\s*([*+-]|\d+[.)])\s/.test(item[idx + 2]!))) loose = true;
        items.push(item);
      }
      const rendered = items.map((item) => {
        let first = item[0] ?? "";
        let task = "";
        const tm = /^\[([ xX])\][ \t]+/.exec(first);
        if (tm) {
          task = tm[1] !== " " ? `<span class="task-box on" role="img" aria-label="Done"></span> ` : `<span class="task-box" role="img" aria-label="To do"></span> `;
          first = first.slice(tm[0].length);
        }
        const body = blocks([first, ...item.slice(1)], opts, depth + 1, !loose);
        return `<li${task ? ' class="task"' : ""}>${task}${body}</li>`;
      });
      parts.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${rendered.join("")}</ol>` : `<ul>${rendered.join("")}</ul>`);
      continue;
    }
    // Paragraph.
    const para: string[] = [line.trimStart()];
    i++;
    while (i < lines.length && lines[i]!.trim()) {
      // Setext headings (checked before "---" is taken as a thematic break).
      if (/^ {0,3}=+\s*$/.test(lines[i]!) || /^ {0,3}-+\s*$/.test(lines[i]!)) {
        const level = lines[i]!.includes("=") ? 1 : 2;
        const text = stripComments(para.join(" "));
        const id = escapeHtml(`${opts.idPrefix ?? "h-"}${slugify(text)}`);
        para.length = 0;
        parts.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inline(text, opts, depth)}</h${level}>`);
        i++;
        break;
      }
      if (startsBlock(lines[i]!, lines[i + 1])) break;
      para.push(lines[i]!.trimStart());
      i++;
    }
    if (para.length) {
      const html = inline(trimBlank(para.join("\n")), opts, depth);
      parts.push(tight ? html : `<p>${html}</p>`);
    }
  }
  return parts.join("\n");
}

/** Languages named by the document's code fences, to load grammars before rendering. */
export function fenceLangs(source: string): string[] {
  if (source.length > MAX_SOURCE) return [];
  const out = new Set<string>();
  for (const line of source.split("\n")) {
    const lang = FENCE.exec(line)?.[2];
    if (lang && /^[\w+#.-]{1,30}$/.test(lang)) out.add(lang);
  }
  return [...out];
}

/**
 * Markdown without its HTML comments, for plain-text views such as email. Comments inside
 * fenced code and code spans stay.
 */
export function stripHtmlComments(source: string): string {
  if (!source.includes("<!--") || source.length > MAX_SOURCE) return source;
  scanned = 0;
  budget = scanBudget(source.length);
  const out: string[] = [];
  let prose: string[] = [];
  let fence: RegExp | null = null;
  const flush = () => {
    if (prose.length) out.push(stripComments(prose.join("\n")));
    prose = [];
  };
  for (const line of source.split("\n")) {
    if (fence) {
      out.push(line);
      if (fence.test(line)) fence = null;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      flush();
      out.push(line);
      fence = new RegExp(`^ {0,3}${open[1]![0] === "`" ? "`" : "~"}{${open[1]!.length},}\\s*$`);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join("\n").replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, "\n\n").trim();
}

/** Render Markdown to sanitized HTML. */
export function renderMarkdown(source: string, opts: MarkdownOptions = {}): string {
  if (source.length > MAX_SOURCE) return `<pre>${escapeHtml(source)}</pre>`;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  scanned = 0;
  budget = scanBudget(source.length);
  return blocks(lines, opts, 0);
}
