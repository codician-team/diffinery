/**
 * Tokenizer for the GitHub Actions expression language
 * (https://docs.github.com/en/actions/learn-github-actions/expressions).
 */

export type TokenKind =
  | "number"
  | "string"
  | "ident"
  | "true"
  | "false"
  | "null"
  | "("
  | ")"
  | "["
  | "]"
  | "."
  | ","
  | "*"
  | "!"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  /** Parsed value for number/string literals. */
  value?: number | string;
  /** Offset in the expression source. */
  pos: number;
}

export class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly expression: string,
    readonly pos: number,
  ) {
    super(`${message} (at position ${pos + 1} in expression: ${expression})`);
    this.name = "ExpressionSyntaxError";
  }
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_");
const isIdentPart = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c) || c === "-";

const NUMBER_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/** Parses the numeric literal syntax used by GitHub (JSON numbers, hex, octal, exponent). */
export function parseNumberLiteral(text: string): number {
  const t = text.trim();
  const sign = t.startsWith("-") ? -1 : 1;
  const body = t.replace(/^[+-]/, "");
  if (/^0[xX][0-9a-fA-F]+$/.test(body)) return sign * parseInt(body.slice(2), 16);
  if (/^0[oO][0-7]+$/.test(body)) return sign * parseInt(body.slice(2), 8);
  return Number(t);
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, text: string, pos: number, value?: number | string) =>
    tokens.push(value === undefined ? { kind, text, pos } : { kind, text, pos, value });

  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const start = i;
    // String literal: single quotes, '' escapes a quote.
    if (c === "'") {
      let out = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ExpressionSyntaxError("Unterminated string literal", src, start);
        const ch = src[i]!;
        if (ch === "'") {
          if (src[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += ch;
        i++;
      }
      push("string", src.slice(start, i), start, out);
      continue;
    }
    if (c === '"') {
      throw new ExpressionSyntaxError("Unexpected double quote; string literals use single quotes", src, start);
    }
    // Numbers (a leading '-' or '+' is part of the literal, there is no unary minus).
    if (isDigit(c) || ((c === "-" || c === "+" || c === ".") && (isDigit(src[i + 1]) || (src[i + 1] === "." && isDigit(src[i + 2]))))) {
      const m = NUMBER_RE.exec(src.slice(i));
      if (!m) throw new ExpressionSyntaxError("Invalid number", src, start);
      const text = m[0];
      if (isIdentPart(src[i + text.length]) && src[i + text.length] !== "-") {
        throw new ExpressionSyntaxError(`Invalid number '${text}${src[i + text.length]}'`, src, start);
      }
      i += text.length;
      push("number", text, start, parseNumberLiteral(text));
      continue;
    }
    if (isIdentStart(c)) {
      while (isIdentPart(src[i])) i++;
      const text = src.slice(start, i);
      if (text === "true" || text === "false" || text === "null") push(text, text, start);
      else if (text === "NaN") push("number", text, start, NaN);
      else if (text === "Infinity") push("number", text, start, Infinity);
      else push("ident", text, start);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "==" || two === "!=" || two === "&&" || two === "||") {
      push(two, two, start);
      i += 2;
      continue;
    }
    if ("()[].,*!<>".includes(c)) {
      push(c as TokenKind, c, start);
      i++;
      continue;
    }
    throw new ExpressionSyntaxError(`Unexpected character '${c}'`, src, start);
  }
  push("eof", "", src.length);
  return tokens;
}
