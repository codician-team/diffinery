import { HttpError } from "../lib/util.js";
import type { Check } from "./collab.js";

/** The app name of checks reported by Diffinery Actions. */
export const ACTIONS_APP = "diffinery-actions";

const OK = new Set(["success", "skipped", "neutral"]);

/** Who reported a check: "diffinery-actions", or the login that created a check run or commit status. */
export function sourceOf(c: Pick<Check, "app"> & { creatorLogin?: string | null }): string {
  if (c.app === ACTIONS_APP) return ACTIONS_APP;
  return (c.creatorLogin ?? c.app).toLowerCase();
}

/**
 * The required checks typed into the branch protection form: one per line. On a single line, commas
 * separate names, except inside parentheses or brackets, so a matrix job such as
 * "End-to-end (git, PRs, Actions)" stays one name.
 */
export function parseCheckList(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (text.includes("\n")) {
      names.push(line);
      continue;
    }
    let depth = 0;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "(" || ch === "[") depth++;
      else if ((ch === ")" || ch === "]") && depth > 0) depth--;
      else if (ch === "," && depth === 0) {
        names.push(line.slice(start, i));
        start = i + 1;
      }
    }
    names.push(line.slice(start));
  }
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

export type RequiredState = { state: "success" | "failure" | "pending" | "missing"; conclusion: string | null; status: string | null };

/**
 * Whether a required check passes on a commit, given every check run and
 * commit status reported there. The rules stop a weaker reporter from
 * outvoting the real one:
 *
 * - With a bound source (`requiredCheckSources[name]`), only that reporter counts.
 * - Otherwise, when Diffinery Actions reported a check with that name, it is the authority.
 * - Reports from agents never satisfy a required check.
 * - Of what is left, any failure fails and anything unfinished is pending.
 */
export function requiredCheck(name: string, entries: Check[], source?: string): RequiredState {
  let named = entries.filter((e) => e.name === name);
  if (source) named = named.filter((e) => sourceOf(e) === source.toLowerCase());
  else if (named.some((e) => e.app === ACTIONS_APP)) named = named.filter((e) => e.app === ACTIONS_APP);
  named = named.filter((e) => e.creatorKind !== "agent");
  if (!named.length) return { state: "missing", conclusion: null, status: null };
  const failed = named.find((e) => e.status === "completed" && !OK.has(e.conclusion ?? ""));
  if (failed) return { state: "failure", conclusion: failed.conclusion ?? "failure", status: "completed" };
  const open = named.find((e) => e.status !== "completed");
  if (open) return { state: "pending", conclusion: null, status: open.status };
  return { state: "success", conclusion: named[0]!.conclusion ?? "success", status: "completed" };
}

/** Validate a branch protection's `requiredCheckSources`: check name → reporter (a login, or "diffinery-actions"). */
export function normalizeCheckSources(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(422, "requiredCheckSources must map check names to a reporter login or diffinery-actions");
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
    if (!k || k.length > 255 || typeof s !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,99}$/.test(s)) throw new HttpError(422, `invalid source for required check '${k}'`);
    out[k] = s.toLowerCase();
  }
  return out;
}
