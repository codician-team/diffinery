/**
 * Minimal YAML parser covering what `action.yml` files use in practice:
 * block mappings/sequences, block scalars (| > with chomping), quoted and
 * plain scalars (incl. multi-line plain), flow collections and comments.
 * Anchors/aliases/tags are not supported (tags and anchors are ignored).
 */

interface Line {
  indent: number;
  text: string; // without leading indentation
  raw: string;
}

const KEY_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:,\[\]{}][^#]*?|-[^\s][^#]*?|\?[^\s][^#]*?)\s*:(?=\s|$)/;

export class YamlError extends Error {}

export function parseYaml(src: string): unknown {
  const lines: Line[] = src
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((raw) => {
      const m = /^( *)/.exec(raw)!;
      return { indent: m[1]!.length, text: raw.slice(m[1]!.length), raw };
    });
  const p = new Parser(lines);
  return p.document();
}

function isBlank(l: Line): boolean {
  const t = l.text.trim();
  return t === "" || t.startsWith("#");
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ") || text.startsWith("-\t");
}

class Parser {
  pos = 0;
  constructor(private lines: Line[]) {}

  document(): unknown {
    // skip directives / document start
    this.skipBlank();
    while (this.pos < this.lines.length && (this.lines[this.pos]!.text.startsWith("%") || this.lines[this.pos]!.text.trim() === "---")) {
      this.pos++;
      this.skipBlank();
    }
    if (this.pos >= this.lines.length) return null;
    const first = this.lines[this.pos]!;
    const v = this.node(first.indent);
    return v;
  }

  skipBlank(): void {
    while (this.pos < this.lines.length && isBlank(this.lines[this.pos]!)) this.pos++;
  }

  peek(): Line | undefined {
    this.skipBlank();
    const l = this.lines[this.pos];
    if (l && (l.text.trim() === "---" || l.text.trim() === "...") && l.indent === 0) return undefined;
    return l;
  }

  node(indent: number): unknown {
    const l = this.peek();
    if (!l || l.indent < indent) return null;
    if (isSeqItem(l.text)) return this.sequence(l.indent);
    if (KEY_RE.test(l.text)) return this.mapping(l.indent);
    // a bare scalar (possibly multi-line)
    this.pos++;
    return this.inlineValue(l.text, l.indent - 1);
  }

  mapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent) break;
      const m = KEY_RE.exec(l.text);
      if (!m) break;
      const keyRaw = m[0].replace(/\s*:$/, "");
      const key = String(scalarFromToken(keyRaw.replace(/^\?\s*/, "")));
      const rest = l.text.slice(m[0].length);
      this.pos++;
      out[key] = this.valueAfterIndicator(rest, indent, true);
    }
    return out;
  }

  sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || !isSeqItem(l.text)) break;
      const afterDash = l.text.slice(1);
      const spaces = /^[ \t]*/.exec(afterDash)![0].length;
      const rest = afterDash.slice(spaces);
      if (rest === "" || rest.startsWith("#")) {
        this.pos++;
        const n = this.peek();
        out.push(n && n.indent > indent ? this.node(n.indent) : null);
        continue;
      }
      if (KEY_RE.test(rest) || isSeqItem(rest)) {
        // rewrite this line as a nested node at a deeper indent
        const newIndent = indent + 1 + spaces;
        this.lines[this.pos] = { indent: newIndent, text: rest, raw: l.raw };
        out.push(this.node(newIndent));
        continue;
      }
      this.pos++;
      out.push(this.valueAfterIndicator(rest, indent, false));
    }
    return out;
  }

  /** Parses what follows `key:` or `- `. */
  valueAfterIndicator(rest: string, indent: number, inMapping: boolean): unknown {
    let r = rest.replace(/^[ \t]+/, "");
    // strip tags / anchors
    r = r.replace(/^(?:![^\s]*|&[^\s]+)\s*/, "");
    if (r === "" || r.startsWith("#")) {
      const n = this.peek();
      if (!n) return null;
      if (n.indent > indent) return this.node(n.indent);
      if (inMapping && n.indent === indent && isSeqItem(n.text)) return this.sequence(indent);
      return null;
    }
    if (r[0] === "|" || r[0] === ">") return this.blockScalar(r, indent);
    return this.inlineValue(r, indent);
  }

  blockScalar(header: string, parentIndent: number): string {
    const h = /^([|>])([+-]?)(\d?)([+-]?)/.exec(header)!;
    const folded = h[1] === ">";
    const chomp = h[2] || h[4] || "";
    const explicit = h[3] ? Number(h[3]) : 0;
    const body: string[] = [];
    let contentIndent = explicit ? parentIndent + explicit : -1;
    while (this.pos < this.lines.length) {
      const l = this.lines[this.pos]!;
      if (l.raw.trim() === "") {
        body.push("");
        this.pos++;
        continue;
      }
      if (contentIndent < 0) {
        if (l.indent <= parentIndent) break;
        contentIndent = l.indent;
      }
      if (l.indent < contentIndent) break;
      body.push(l.raw.slice(contentIndent));
      this.pos++;
    }
    // trailing blank lines
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    let text: string;
    if (folded) {
      text = "";
      for (let i = 0; i < body.length; i++) {
        const cur = body[i]!;
        if (i === 0) {
          text = cur;
          continue;
        }
        const prev = body[i - 1]!;
        const moreIndented = /^\s/.test(cur) || /^\s/.test(prev);
        if (cur === "") text += "\n";
        else if (prev === "" || moreIndented) text += (prev === "" ? "" : "\n") + cur;
        else text += " " + cur;
      }
    } else {
      text = body.join("\n");
    }
    if (body.length === 0) return chomp === "+" ? "\n".repeat(trailing) : "";
    if (chomp === "-") return text;
    if (chomp === "+") return text + "\n" + "\n".repeat(trailing);
    return text + "\n";
  }

  inlineValue(first: string, indent: number): unknown {
    let text = first;
    const c = text[0];
    if (c === "[" || c === "{") {
      // gather until balanced
      while (!flowBalanced(text) && this.pos < this.lines.length) {
        text += " " + this.lines[this.pos]!.text.trim();
        this.pos++;
      }
      const fp = new FlowParser(text);
      return fp.value();
    }
    if (c === '"' || c === "'") {
      // quoted scalar, may span lines
      while (!quoteClosed(text) && this.pos < this.lines.length) {
        const nxt = this.lines[this.pos]!.text.trim();
        text += nxt === "" ? "\n" : " " + nxt;
        this.pos++;
      }
      return parseQuoted(text).value;
    }
    // plain scalar, may continue on more-indented lines
    let value = stripComment(text).trim();
    for (;;) {
      const l = this.lines[this.pos];
      if (!l) break;
      if (l.text.trim() === "") {
        // a blank line in a multi-line plain scalar becomes a newline, only if followed by continuation
        let j = this.pos;
        while (j < this.lines.length && this.lines[j]!.text.trim() === "") j++;
        const nx = this.lines[j];
        if (nx && nx.indent > indent && !nx.text.startsWith("#") && !KEY_RE.test(nx.text)) {
          value += "\n".repeat(j - this.pos);
          this.pos = j;
          continue;
        }
        break;
      }
      if (l.indent <= indent || l.text.startsWith("#")) break;
      if (KEY_RE.test(l.text) || isSeqItem(l.text)) break;
      const add = stripComment(l.text).trim();
      value += value.endsWith("\n") ? add : " " + add;
      this.pos++;
    }
    return scalarFromToken(value);
  }
}

function stripComment(s: string): string {
  const i = s.search(/(^|\s)#/);
  return i < 0 ? s : s.slice(0, i);
}

function quoteClosed(text: string): boolean {
  try {
    parseQuoted(text);
    return true;
  } catch {
    return false;
  }
}

function parseQuoted(text: string): { value: string; end: number } {
  const q = text[0]!;
  let out = "";
  let i = 1;
  if (q === "'") {
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += ch;
    }
    throw new YamlError("unterminated single-quoted string");
  }
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      const n = text[++i];
      switch (n) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "0": out += "\0"; break;
        case "\\": out += "\\"; break;
        case '"': out += '"'; break;
        case "/": out += "/"; break;
        case " ": out += " "; break;
        case "e": out += "\x1b"; break;
        case "x": out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; break;
        case "u": out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4; break;
        default: out += n ?? "";
      }
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    out += ch;
  }
  throw new YamlError("unterminated double-quoted string");
}

function flowBalanced(text: string): boolean {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === "\\" && q === '"') i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "#" && /\s/.test(text[i - 1] ?? " ") && depth > 0) {
      // comment inside a flow on this line: ignore rest of the line
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    }
  }
  return depth <= 0;
}

class FlowParser {
  i = 0;
  constructor(private s: string) {}
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === "[") {
      this.i++;
      const arr: unknown[] = [];
      for (;;) {
        this.ws();
        if (this.s[this.i] === "]") { this.i++; break; }
        arr.push(this.value());
        this.ws();
        if (this.s[this.i] === ",") this.i++;
        else if (this.s[this.i] === "]") { this.i++; break; }
        else if (this.i >= this.s.length) break;
      }
      return arr;
    }
    if (c === "{") {
      this.i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.ws();
        if (this.s[this.i] === "}") { this.i++; break; }
        const k = this.scalar(true);
        this.ws();
        let v: unknown = null;
        if (this.s[this.i] === ":") {
          this.i++;
          v = this.value();
        }
        obj[String(k)] = v;
        this.ws();
        if (this.s[this.i] === ",") this.i++;
        else if (this.s[this.i] === "}") { this.i++; break; }
        else if (this.i >= this.s.length) break;
      }
      return obj;
    }
    return this.scalar(false);
  }
  scalar(isKey: boolean): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") {
      const r = parseQuoted(this.s.slice(this.i));
      this.i += r.end;
      return r.value;
    }
    let j = this.i;
    while (j < this.s.length) {
      const ch = this.s[j]!;
      if (ch === "," || ch === "]" || ch === "}") break;
      if (ch === ":" && (isKey || /[\s,\]}]/.test(this.s[j + 1] ?? " "))) break;
      j++;
    }
    const tok = this.s.slice(this.i, j).trim();
    this.i = j;
    return scalarFromToken(tok);
  }
}

function scalarFromToken(tok: string): unknown {
  const t = tok.trim();
  if (t.startsWith('"') || t.startsWith("'")) return parseQuoted(t).value;
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}
