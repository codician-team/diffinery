/**
 * Which secrets a job uses. As on GitHub, a runner gets only the secrets the
 * job's expressions name, so a compromised action or tool in one job can't read
 * every secret out of the runner's memory or environment.
 */

/** Secrets the runner reads itself: they turn on debug logging. */
export const RUNNER_SECRETS = ["ACTIONS_STEP_DEBUG", "ACTIONS_RUNNER_DEBUG"];

const EXPRESSION = /\$\{\{([^]*?)\}\}/g;
const SECRETS = /\bsecrets\b/gi;
const NAMED = /^\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/;

/** Secret names (upper case) referenced in `expr`, or "all" when it reads `secrets` as a whole (toJSON, a computed index). */
function scan(expr: string, into: Set<string>): boolean {
  for (const m of expr.matchAll(SECRETS)) {
    // `steps.secrets.outputs.x` is a property named secrets, not the context.
    if (/\.\s*$/.test(expr.slice(0, m.index))) continue;
    const named = NAMED.exec(expr.slice(m.index + m[0].length));
    if (!named) return false;
    into.add((named[1] ?? named[3])!.toUpperCase());
  }
  return true;
}

/**
 * The secret names `parts` (a job definition, the workflow's `env` and `defaults`) reference,
 * upper case; or "all" when an expression uses `secrets` in a way that can't be narrowed.
 * `if:` values are expressions without `${{ }}`.
 */
export function referencedSecrets(...parts: unknown[]): Set<string> | "all" {
  const names = new Set<string>();
  let all = false;
  const walk = (v: unknown, key: string | null): void => {
    if (all) return;
    if (typeof v === "string") {
      if (key === "if" && !v.includes("${{")) {
        if (!scan(v, names)) all = true;
        return;
      }
      for (const m of v.matchAll(EXPRESSION)) if (!scan(m[1]!, names)) all = true;
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x, null);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const p of parts) walk(p, null);
  return all ? "all" : names;
}

/** `secrets` narrowed to what the job references. */
export function secretsFor(secrets: Record<string, string>, used: Set<string> | "all"): Record<string, string> {
  if (used === "all") return secrets;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) if (used.has(name.toUpperCase())) out[name] = value;
  return out;
}
