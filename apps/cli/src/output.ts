import type { Io } from "./io.js";

export interface Colors {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

export function colors(io: Io): Colors {
  const on = !!io.stdout.isTTY && io.env.NO_COLOR === undefined && io.env.TERM !== "dumb";
  const wrap = (open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { enabled: on, bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), magenta: wrap(35, 39) };
}

const ANSI = /\x1b\[[0-9;]*m/g;
const width = (s: string) => [...s.replace(ANSI, "")].length;

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(rows: string[][]): string {
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ""))));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(widths[i]! - width(cell)))).join("  ").trimEnd()).join("\n") + "\n";
}

export function json(io: Io, v: unknown): void {
  io.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

export function truncate(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}

/** Colors a status/conclusion word. */
export function statusText(c: Colors, status: string | null | undefined, conclusion?: string | null): string {
  if (status && status !== "completed") return c.yellow(status.replace(/_/g, " "));
  const v = conclusion ?? status ?? "unknown";
  if (v === "success" || v === "merged" || v === "open" || v === "clean") return c.green(v);
  if (v === "failure" || v === "timed_out" || v === "cancelled" || v === "action_required") return c.red(v.replace(/_/g, " "));
  if (v === "closed" || v === "skipped" || v === "neutral") return c.dim(v);
  return c.yellow(v.replace(/_/g, " "));
}

export function symbol(c: Colors, status: string | null | undefined, conclusion?: string | null): string {
  if (status && status !== "completed") return c.yellow("*");
  if (conclusion === "success") return c.green("✓");
  if (conclusion === "skipped" || conclusion === "neutral") return c.dim("-");
  return c.red("X");
}
