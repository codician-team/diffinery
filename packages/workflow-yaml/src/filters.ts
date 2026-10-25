/**
 * Event filters: GitHub filter-pattern globbing and `on:` trigger matching.
 * https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#filter-pattern-cheat-sheet
 */
import type { MergeGroupTrigger, PullRequestTrigger, PushTrigger, Workflow, WorkflowRunTrigger } from "./model.js";

export type TriggerEvent =
  | { name: "push"; ref: string; changedFiles?: string[] }
  | { name: "pull_request" | "pull_request_target"; action: string; baseRef: string; changedFiles?: string[] }
  | { name: "merge_group"; action: string; baseRef: string }
  | { name: "schedule"; cron: string }
  | { name: "workflow_dispatch" }
  | {
      name: string;
      action?: string;
      /** workflow_run: name of the workflow that completed. */
      workflow?: string;
      /** workflow_run: head branch of the triggering run. */
      branch?: string;
    };

const regexCache = new Map<string, RegExp>();

/**
 * Converts a GitHub filter pattern to a RegExp:
 * `*` any chars except `/`; `**` any chars; `?` zero or one of the preceding
 * character; `+` one or more of the preceding character; `[...]` a character
 * class/range; `\` escapes the next character. A leading double-star-slash
 * segment may also match nothing, so `docs/a.md` matches the pattern
 * double-star-slash-docs-slash-double-star.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  let re = "";
  let canQuantify = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      re += escapeRe(pattern[++i]!);
      canQuantify = true;
    } else if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
      canQuantify = false;
    } else if ((c === "?" || c === "+") && canQuantify) {
      re += c;
      canQuantify = false;
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close > i + 1) {
        const body = pattern.slice(i + 1, close).replace(/[\\\]^]/g, (m) => `\\${m}`);
        re += `[${body}]`;
        i = close;
        canQuantify = true;
      } else {
        re += "\\[";
        canQuantify = true;
      }
    } else {
      re += escapeRe(c);
      canQuantify = true;
    }
  }
  const out = new RegExp(`^${re}$`);
  if (regexCache.size > 5000) regexCache.clear();
  regexCache.set(pattern, out);
  return out;
}

function escapeRe(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

/** Matches a single filter pattern (without a leading `!`) against a value. */
export function globMatch(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

/**
 * Applies an ordered pattern list where `!pattern` negates: the value matches
 * when the last pattern that matches it is a positive one.
 */
export function matchesPatternList(patterns: readonly string[], value: string): boolean {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (matched && globMatch(p.slice(1), value)) matched = false;
    } else if (!matched && globMatch(p, value)) {
      matched = true;
    }
  }
  return matched;
}

/** Include/ignore filter pair. Undefined filters accept everything. */
function passesFilter(value: string, include?: string[], ignore?: string[]): boolean {
  if (include) return matchesPatternList(include, value);
  if (ignore) return !matchesPatternList(ignore, value);
  return true;
}

/**
 * Path filters: with `paths`, at least one changed file must match; with
 * `paths-ignore`, the workflow runs unless every changed file is ignored.
 * When the changed files are unknown the filter passes (GitHub runs the
 * workflow when it cannot compute the diff).
 */
function passesPaths(changed: string[] | undefined, paths?: string[], pathsIgnore?: string[]): boolean {
  if (changed === undefined || (!paths && !pathsIgnore)) return true;
  if (paths) return changed.some((f) => matchesPatternList(paths, f));
  return changed.some((f) => !matchesPatternList(pathsIgnore!, f));
}

function stripPrefix(ref: string, prefix: string): string {
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function matchesPush(cfg: PushTrigger, ref: string, changedFiles?: string[]): boolean {
  const hasBranchFilter = cfg.branches !== undefined || cfg.branchesIgnore !== undefined;
  const hasTagFilter = cfg.tags !== undefined || cfg.tagsIgnore !== undefined;
  if (ref.startsWith("refs/tags/")) {
    const tag = ref.slice("refs/tags/".length);
    if (hasTagFilter) return passesFilter(tag, cfg.tags, cfg.tagsIgnore);
    // Only branch filters: tag pushes do not trigger. Path filters are not evaluated for tags.
    return !hasBranchFilter;
  }
  const branch = stripPrefix(ref, "refs/heads/");
  if (hasBranchFilter) {
    if (!passesFilter(branch, cfg.branches, cfg.branchesIgnore)) return false;
  } else if (hasTagFilter) {
    return false;
  }
  return passesPaths(changedFiles, cfg.paths, cfg.pathsIgnore);
}

export const DEFAULT_PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened"];

function matchesPullRequest(cfg: PullRequestTrigger, action: string, baseRef: string, changedFiles?: string[]): boolean {
  const types = cfg.types ?? DEFAULT_PULL_REQUEST_TYPES;
  if (!types.includes(action)) return false;
  const base = stripPrefix(baseRef, "refs/heads/");
  if (!passesFilter(base, cfg.branches, cfg.branchesIgnore)) return false;
  return passesPaths(changedFiles, cfg.paths, cfg.pathsIgnore);
}

const normalizeCron = (c: string) => c.trim().split(/\s+/).join(" ");

/** Decides whether a workflow is triggered by an event, following GitHub semantics. */
export function matchesTrigger(wf: Workflow, ev: TriggerEvent): boolean {
  const on = wf.on;
  if (!Object.prototype.hasOwnProperty.call(on, ev.name)) return false;
  switch (ev.name) {
    case "push": {
      const e = ev as Extract<TriggerEvent, { name: "push" }>;
      return matchesPush(on.push ?? {}, e.ref, e.changedFiles);
    }
    case "pull_request":
    case "pull_request_target": {
      const e = ev as Extract<TriggerEvent, { name: "pull_request" | "pull_request_target" }>;
      return matchesPullRequest(on[ev.name] ?? {}, e.action, e.baseRef, e.changedFiles);
    }
    case "merge_group": {
      const e = ev as Extract<TriggerEvent, { name: "merge_group" }>;
      const cfg: MergeGroupTrigger = on.merge_group ?? {};
      if (!(cfg.types ?? ["checks_requested"]).includes(e.action)) return false;
      return passesFilter(stripPrefix(e.baseRef, "refs/heads/"), cfg.branches, cfg.branchesIgnore);
    }
    case "schedule": {
      const e = ev as Extract<TriggerEvent, { name: "schedule" }>;
      return (on.schedule ?? []).some((s) => normalizeCron(s.cron) === normalizeCron(e.cron));
    }
    case "workflow_dispatch":
    case "workflow_call":
      return true;
    case "workflow_run": {
      const e = ev as { action?: string; workflow?: string; branch?: string };
      const cfg: WorkflowRunTrigger = on.workflow_run ?? {};
      if (e.action !== undefined && cfg.types && !cfg.types.includes(e.action)) return false;
      if (e.workflow !== undefined && cfg.workflows && !cfg.workflows.includes(e.workflow)) return false;
      if (e.branch !== undefined && !passesFilter(e.branch, cfg.branches, cfg.branchesIgnore)) return false;
      return true;
    }
    default: {
      const e = ev as { action?: string };
      const cfg = on[ev.name] as { types?: unknown } | undefined;
      const types = cfg && Array.isArray(cfg.types) ? (cfg.types as string[]) : undefined;
      if (e.action !== undefined && types && !types.includes(e.action)) return false;
      return true;
    }
  }
}
