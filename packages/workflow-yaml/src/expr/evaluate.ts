import {
  isTruthy,
  kindOf,
  looseCompare,
  looseEquals,
  toJSONString,
  toNumber,
  toStr,
  toTemplateString,
} from "./coerce.js";
import { parseExpression, usesStatusFunction, type Node } from "./parser.js";
import { soleExpression, splitTemplate } from "./template.js";

/** Contexts: github, env, vars, secrets, matrix, needs, steps, runner, inputs, job, jobs, strategy. */
export type ExprContext = Record<string, unknown>;

export interface StatusFns {
  success(): boolean;
  failure(): boolean;
  cancelled(): boolean;
  always?(): boolean;
}

export interface EvalExtra {
  /** Implementation of hashFiles(); when absent hashFiles() returns ''. */
  hashFiles?: (...patterns: string[]) => string;
}

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionEvaluationError";
  }
}

const DEFAULT_STATUS: StatusFns = { success: () => true, failure: () => false, cancelled: () => false };

/** Result of an object filter (`.*`); later dereferences map over its items. */
class Filtered {
  constructor(readonly items: unknown[]) {}
}

const unwrap = (v: unknown): unknown => (v instanceof Filtered ? v.items : v);

function getProperty(obj: unknown, key: unknown): unknown {
  const k = kindOf(obj);
  if (k === "array") {
    const arr = obj as unknown[];
    const n = toNumber(key);
    if (!Number.isInteger(n) || n < 0 || n >= arr.length) return null;
    return arr[n] ?? null;
  }
  if (k !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const name = toStr(key);
  if (Object.prototype.hasOwnProperty.call(rec, name)) return rec[name] ?? null;
  const lower = name.toLowerCase();
  for (const own of Object.keys(rec)) {
    if (own.toLowerCase() === lower) return rec[own] ?? null;
  }
  return null;
}

function wildcard(v: unknown, into: unknown[]): void {
  const k = kindOf(v);
  if (k === "array") into.push(...(v as unknown[]));
  else if (k === "object") into.push(...Object.values(v as Record<string, unknown>));
}

class Evaluator {
  constructor(
    private readonly ctx: ExprContext,
    private readonly status: StatusFns,
    private readonly extra: EvalExtra,
  ) {}

  value(node: Node): unknown {
    return unwrap(this.eval(node));
  }

  private eval(node: Node): unknown {
    switch (node.type) {
      case "literal":
        return node.value;
      case "context":
        return getProperty(this.ctx, node.name);
      case "index":
        return this.index(node.object, node.index);
      case "not":
        return !isTruthy(this.value(node.operand));
      case "logical": {
        const left = this.value(node.left);
        if (node.op === "&&") return isTruthy(left) ? this.value(node.right) : left;
        return isTruthy(left) ? left : this.value(node.right);
      }
      case "binary": {
        const l = this.value(node.left);
        const r = this.value(node.right);
        switch (node.op) {
          case "==":
            return looseEquals(l, r);
          case "!=":
            return !looseEquals(l, r);
          case "<":
            return looseCompare(l, r) < 0;
          case "<=":
            return looseCompare(l, r) <= 0;
          case ">":
            return looseCompare(l, r) > 0;
          case ">=":
            return looseCompare(l, r) >= 0;
        }
        break;
      }
      case "call":
        return this.call(node.name, node.args);
    }
    return null;
  }

  private index(objectNode: Node, indexNode: Node | "*"): unknown {
    const obj = this.eval(objectNode);
    if (obj instanceof Filtered) {
      const out: unknown[] = [];
      if (indexNode === "*") {
        for (const item of obj.items) wildcard(item, out);
      } else {
        const key = this.value(indexNode);
        for (const item of obj.items) {
          const v = getProperty(item, key);
          if (v !== null && v !== undefined) out.push(v);
        }
      }
      return new Filtered(out);
    }
    if (indexNode === "*") {
      const out: unknown[] = [];
      wildcard(obj, out);
      return new Filtered(out);
    }
    return getProperty(obj, this.value(indexNode));
  }

  private call(name: string, argNodes: Node[]): unknown {
    switch (name) {
      case "success":
        return this.status.success();
      case "failure":
        return this.status.failure();
      case "cancelled":
        return this.status.cancelled();
      case "always":
        return this.status.always ? this.status.always() : true;
    }
    const args = argNodes.map((a) => this.value(a));
    switch (name) {
      case "contains": {
        const [search, item] = args;
        if (kindOf(search) === "array") return (search as unknown[]).some((el) => looseEquals(el, item));
        return toStr(search).toUpperCase().includes(toStr(item).toUpperCase());
      }
      case "startswith":
        return toStr(args[0]).toUpperCase().startsWith(toStr(args[1]).toUpperCase());
      case "endswith":
        return toStr(args[0]).toUpperCase().endsWith(toStr(args[1]).toUpperCase());
      case "format":
        return format(toStr(args[0]), args.slice(1));
      case "join": {
        const sep = args.length > 1 ? toStr(args[1]) : ",";
        const v = args[0];
        if (kindOf(v) === "array") return (v as unknown[]).map(toStr).join(sep);
        return toStr(v);
      }
      case "tojson":
        return toJSONString(args[0]);
      case "fromjson": {
        const text = toStr(args[0]);
        try {
          return JSON.parse(text) as unknown;
        } catch (e) {
          throw new ExpressionEvaluationError(`fromJSON: invalid JSON ${JSON.stringify(text)}: ${(e as Error).message}`);
        }
      }
      case "hashfiles":
        return this.extra.hashFiles ? this.extra.hashFiles(...args.map(toStr)) : "";
    }
    throw new ExpressionEvaluationError(`Unrecognized function '${name}'`);
  }
}

/** GitHub's format(): `{N}` placeholders, `{{` and `}}` escapes. */
export function format(fmt: string, args: unknown[]): string {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "{") {
      if (fmt[i + 1] === "{") {
        out += "{";
        i++;
        continue;
      }
      const close = fmt.indexOf("}", i);
      const idx = close < 0 ? "" : fmt.slice(i + 1, close);
      if (!/^\d+$/.test(idx)) throw new ExpressionEvaluationError(`format: invalid format string '${fmt}'`);
      const n = Number(idx);
      if (n >= args.length) {
        throw new ExpressionEvaluationError(`format: placeholder {${n}} has no matching argument in '${fmt}'`);
      }
      out += toStr(args[n]);
      i = close;
    } else if (c === "}") {
      if (fmt[i + 1] === "}") {
        out += "}";
        i++;
        continue;
      }
      throw new ExpressionEvaluationError(`format: invalid format string '${fmt}' (unescaped '}')`);
    } else {
      out += c;
    }
  }
  return out;
}

/** Evaluates an expression (without `${{ }}`). Throws on syntax errors. */
export function evaluate(expr: string, ctx: ExprContext, status?: StatusFns, extra?: EvalExtra): unknown {
  const node = parseExpression(expr);
  return new Evaluator(ctx, status ?? DEFAULT_STATUS, extra ?? {}).value(node);
}

/** Replaces every `${{ expr }}` in `template` with its string-coerced value. */
export function interpolate(template: string, ctx: ExprContext, status?: StatusFns, extra?: EvalExtra): string {
  if (!template.includes("${{")) return template;
  let out = "";
  for (const part of splitTemplate(template)) {
    out += part.kind === "text" ? part.text : toTemplateString(evaluate(part.expr, ctx, status, extra));
  }
  return out;
}

/**
 * Evaluates a YAML value that may be an expression: a string that is exactly
 * `${{ expr }}` yields the raw (typed) result, other strings are interpolated,
 * and non-strings are returned unchanged.
 */
export function evaluateValue(value: unknown, ctx: ExprContext, status?: StatusFns, extra?: EvalExtra): unknown {
  if (typeof value !== "string") return value;
  const sole = soleExpression(value);
  if (sole !== undefined) return evaluate(sole, ctx, status, extra);
  return interpolate(value, ctx, status, extra);
}

/**
 * Evaluates a job/step `if:` condition with GitHub rules: an absent condition
 * means `success()`, and a condition without a status function is implicitly
 * `success() && (cond)`. The condition may or may not be wrapped in `${{ }}`.
 */
export function evaluateIf(
  cond: string | boolean | undefined | null,
  ctx: ExprContext,
  status: StatusFns,
  extra?: EvalExtra,
): boolean {
  if (cond === undefined || cond === null) return status.success();
  if (typeof cond === "boolean") return cond && status.success();
  const trimmed = cond.trim();
  if (trimmed === "") return status.success();
  let expr = soleExpression(trimmed);
  if (expr === undefined) {
    if (trimmed.includes("${{")) {
      // Mixed text and expressions: the result is a string, truthy unless empty.
      const parts = splitTemplate(trimmed);
      const hasStatus = parts.some((p) => p.kind === "expr" && usesStatusFunction(parseExpression(p.expr)));
      const text = interpolate(trimmed, ctx, status, extra);
      return (hasStatus || status.success()) && isTruthy(text);
    }
    expr = trimmed;
  }
  const node = parseExpression(expr);
  if (!usesStatusFunction(node) && !status.success()) return false;
  return isTruthy(new Evaluator(ctx, status, extra ?? {}).value(node));
}

/** Validates an expression's syntax; returns an error message or undefined. */
export function checkExpressionSyntax(expr: string): string | undefined {
  try {
    parseExpression(expr);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
