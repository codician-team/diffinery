/**
 * `strategy.matrix` expansion with GitHub's include/exclude semantics
 * (https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow).
 */
import { evaluateValue, type ExprContext } from "./expr/evaluate.js";

export type MatrixCombination = Record<string, unknown>;

export class MatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixError";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function scalarEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return false;
  return String(a) === String(b);
}

/** Deep equality (scalars compared by string form so `18` equals `'18'`). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return scalarEqual(a, b);
}

/** `pattern` partially matches `value`: every key of a pattern object matches (recursively). */
function partialMatch(pattern: unknown, value: unknown): boolean {
  if (isPlainObject(pattern) && isPlainObject(value)) {
    return Object.keys(pattern).every((k) => Object.prototype.hasOwnProperty.call(value, k) && partialMatch(pattern[k], value[k]));
  }
  return deepEqual(pattern, value);
}

function resolve(value: unknown, ctx: ExprContext | undefined): unknown {
  return typeof value === "string" && value.includes("${{") ? evaluateValue(value, ctx ?? {}) : value;
}

function asObjectList(value: unknown, what: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (isPlainObject(value)) return [value];
  if (!Array.isArray(value)) throw new MatrixError(`matrix.${what} must be a list of mappings`);
  return value.map((entry, i) => {
    if (!isPlainObject(entry)) throw new MatrixError(`matrix.${what}[${i}] must be a mapping`);
    return entry;
  });
}

/**
 * Expands a matrix into its job combinations.
 *
 * - `undefined`/`null` (no matrix) yields a single empty combination `[{}]`.
 * - The matrix (or any of its vectors, `include` or `exclude`) may be a
 *   `${{ }}` expression string, evaluated with `ctx` (e.g. `fromJSON(needs.x.outputs.m)`).
 * - Exclusions are applied first (partial matches exclude).
 * - Each `include` entry is merged into every original combination whose
 *   original matrix values it does not overwrite (values added by earlier
 *   includes may be overwritten); if it fits none, it becomes a new combination.
 */
/** Combinations before `exclude`, and entries in `include` or `exclude`: these bound the work of expanding a matrix. */
export const MAX_MATRIX_COMBINATIONS = 4096;
export const MAX_MATRIX_ENTRIES = 256;

export function expandMatrix(matrix: unknown, ctx?: ExprContext): MatrixCombination[] {
  if (matrix === undefined || matrix === null) return [{}];
  const resolved = resolve(matrix, ctx);
  if (resolved === undefined || resolved === null || resolved === "") return [{}];
  if (!isPlainObject(resolved)) throw new MatrixError("matrix must be a mapping");

  const dims: Array<[string, unknown[]]> = [];
  let include: Array<Record<string, unknown>> = [];
  let exclude: Array<Record<string, unknown>> = [];
  for (const [key, raw] of Object.entries(resolved)) {
    const value = resolve(raw, ctx);
    if (key === "include") include = asObjectList(value, "include");
    else if (key === "exclude") exclude = asObjectList(value, "exclude");
    else {
      if (!Array.isArray(value)) throw new MatrixError(`matrix.${key} must be a list (got ${value === null ? "null" : typeof value})`);
      dims.push([key, value]);
    }
  }

  for (const [what, list] of [["include", include], ["exclude", exclude]] as const) {
    if (list.length > MAX_MATRIX_ENTRIES) throw new MatrixError(`matrix.${what} has ${list.length} entries; at most ${MAX_MATRIX_ENTRIES} are allowed`);
  }
  // Count the combinations before building any, so a matrix like 20 values in each of 6 vectors
  // (64 million) is refused at once instead of filling memory.
  const product = dims.reduce((n, [, values]) => n * values.length, dims.length ? 1 : 0);
  if (product > MAX_MATRIX_COMBINATIONS) throw new MatrixError(`the matrix has ${product} combinations before exclusions; at most ${MAX_MATRIX_COMBINATIONS} are allowed (and a matrix may produce at most 256 jobs)`);

  let combos: MatrixCombination[] = [];
  if (dims.length > 0) {
    combos = [{}];
    for (const [key, values] of dims) {
      const next: MatrixCombination[] = [];
      for (const combo of combos) for (const v of values) next.push({ ...combo, [key]: v });
      combos = next;
    }
  }

  combos = combos.filter((combo) => !exclude.some((ex) => Object.keys(ex).every((k) => k in combo && partialMatch(ex[k], combo[k]))));

  const originalKeys = new Set(dims.map(([k]) => k));
  const extra: MatrixCombination[] = [];
  for (const entry of include) {
    let added = false;
    for (const combo of combos) {
      const fits = Object.keys(entry).every((k) => !originalKeys.has(k) || deepEqual(combo[k], entry[k]));
      if (fits) {
        // Original vector values are never overwritten; values added by earlier includes may be.
        for (const [k, v] of Object.entries(entry)) if (!originalKeys.has(k)) combo[k] = v;
        added = true;
      }
    }
    if (!added) extra.push({ ...entry });
  }
  return [...combos, ...extra];
}
