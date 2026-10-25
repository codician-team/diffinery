/** Splitting of strings containing `${{ expr }}` placeholders. */

export type TemplatePart =
  | { kind: "text"; text: string }
  | { kind: "expr"; expr: string; start: number; end: number };

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

export function containsExpression(s: string): boolean {
  return typeof s === "string" && s.includes("${{");
}

/**
 * Splits a template into literal text and expressions. `}}` inside a
 * single-quoted string literal does not close the expression.
 * Throws TemplateError when a `${{` is not closed.
 */
export function splitTemplate(s: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let pos = 0;
  for (;;) {
    const open = s.indexOf("${{", pos);
    if (open < 0) {
      if (pos < s.length) parts.push({ kind: "text", text: s.slice(pos) });
      return parts;
    }
    if (open > pos) parts.push({ kind: "text", text: s.slice(pos, open) });
    let i = open + 3;
    let inString = false;
    let close = -1;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") inString = !inString; // '' escapes toggle twice, which is a no-op
      else if (!inString && c === "}" && s[i + 1] === "}") {
        close = i;
        break;
      }
      i++;
    }
    if (close < 0) {
      throw new TemplateError(`Unclosed expression: '\${{' at offset ${open} has no matching '}}'`, open);
    }
    parts.push({ kind: "expr", expr: s.slice(open + 3, close).trim(), start: open, end: close + 2 });
    pos = close + 2;
  }
}

/** If the whole (trimmed) string is a single `${{ expr }}`, returns the inner expression. */
export function soleExpression(s: string): string | undefined {
  const t = s.trim();
  if (!t.startsWith("${{")) return undefined;
  let parts: TemplatePart[];
  try {
    parts = splitTemplate(t);
  } catch {
    return undefined;
  }
  const only = parts[0];
  return parts.length === 1 && only?.kind === "expr" ? only.expr : undefined;
}
