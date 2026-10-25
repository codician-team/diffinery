/**
 * GitHub Actions expression type coercion rules
 * (https://docs.github.com/en/actions/learn-github-actions/expressions#operators).
 */
import { parseNumberLiteral } from "./lexer.js";

export type Kind = "null" | "boolean" | "number" | "string" | "array" | "object";

export function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return "null";
  switch (typeof v) {
    case "boolean":
      return "boolean";
    case "number":
    case "bigint":
      return "number";
    case "string":
      return "string";
    default:
      return Array.isArray(v) ? "array" : "object";
  }
}

export function isTruthy(v: unknown): boolean {
  switch (kindOf(v)) {
    case "null":
      return false;
    case "boolean":
      return v as boolean;
    case "number": {
      const n = Number(v);
      return n !== 0 && !Number.isNaN(n);
    }
    case "string":
      return (v as string).length > 0;
    default:
      return true;
  }
}

const NUMERIC_STRING = /^[+-]?(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)$/;

/** null -> 0, true -> 1, false -> 0, '' -> 0, numeric strings parsed, everything else NaN. */
export function toNumber(v: unknown): number {
  switch (kindOf(v)) {
    case "null":
      return 0;
    case "boolean":
      return v ? 1 : 0;
    case "number":
      return Number(v);
    case "string": {
      const s = (v as string).trim();
      if (s === "") return 0;
      if (!NUMERIC_STRING.test(s)) return NaN;
      return parseNumberLiteral(s);
    }
    default:
      return NaN;
  }
}

/** Formats a number the way GitHub prints it (integers without decimals, up to 15 significant digits). */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (Object.is(n, -0)) return "0";
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  return String(parseFloat(n.toPrecision(15)));
}

/** String coercion used by functions (contains, format, join...). Arrays/objects become 'Array'/'Object'. */
export function toStr(v: unknown): string {
  switch (kindOf(v)) {
    case "null":
      return "";
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return formatNumber(Number(v));
    case "string":
      return v as string;
    case "array":
      return "Array";
    default:
      return "Object";
  }
}

/** String coercion used when interpolating `${{ }}` into a template: objects/arrays become JSON. */
export function toTemplateString(v: unknown): string {
  const k = kindOf(v);
  if (k === "array" || k === "object") return toJSONString(v);
  return toStr(v);
}

export function toJSONString(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v, (_k, val: unknown) => (typeof val === "bigint" ? Number(val) : val), 2) ?? "null";
}

const fold = (s: string) => s.toUpperCase();

/** GitHub loose equality (`==`). */
export function looseEquals(a: unknown, b: unknown): boolean {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    const na = toNumber(a);
    const nb = toNumber(b);
    return na === nb;
  }
  switch (ka) {
    case "null":
      return true;
    case "number":
      return Number(a) === Number(b);
    case "string":
      return fold(a as string) === fold(b as string);
    case "boolean":
      return a === b;
    default:
      return a === b;
  }
}

/** Returns <0, 0, >0, or NaN when the values are not comparable. */
export function looseCompare(a: unknown, b: unknown): number {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb || ka === "null" || ka === "boolean" || ka === "number") {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) return NaN;
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (ka === "string") {
    const sa = fold(a as string);
    const sb = fold(b as string);
    return sa === sb ? 0 : sa < sb ? -1 : 1;
  }
  return NaN;
}
