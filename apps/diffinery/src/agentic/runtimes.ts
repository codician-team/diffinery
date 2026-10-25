import type { Provider } from "./keys.js";

/**
 * The coding agents a task can run, installed from their vendors' official
 * npm packages and run unmodified, headless, with the person's own model
 * access through Diffinery's model proxy.
 */

export type RuntimeId = "claude-code" | "codex" | "custom";

/**
 * Pinned runtime versions: the install runs while the sandbox holds the agent's
 * git credential, so a new release is taken on deliberately, not automatically.
 */
export const RUNTIME_VERSIONS = { "claude-code": "2.1.296", codex: "0.162.1" } as const;

export interface Runtime {
  id: RuntimeId;
  name: string;
  /** What it says on the new-task page. */
  description: string;
  /** Providers it needs a key for by default (custom: none required; it gets whichever the person has). */
  needs: Provider[];
  /** Where its model calls can go instead: OpenRouter, with a model chosen there. */
  alternatives: Provider[];
  /** Run before any credential exists in the sandbox. */
  install: string | null;
  /**
   * The run itself; the prompt is in $DIFFINERY_TASK_PROMPT and an OpenRouter
   * model in $DIFFINERY_MODEL, never on the command line we build.
   */
  command: (custom?: string, via?: Provider, review?: boolean, untrustedCheckout?: boolean) => string;
}

export const RUNTIMES: Record<RuntimeId, Runtime> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's coding agent, with your Anthropic API key.",
    needs: ["anthropic"],
    // OpenRouter speaks the Messages API at /api/v1/messages, so Claude Code only needs another base URL (agentEnv).
    alternatives: ["openrouter"],
    install: `npm install --global --no-fund --no-audit --loglevel=error @anthropic-ai/claude-code@${RUNTIME_VERSIONS["claude-code"]} && claude --version`,
    // The sandbox runs as root in its own container; IS_SANDBOX lets Claude Code skip permission prompts there.
    // A review has no web tools: they run on the provider and cost extra (the model proxy strips them too).
    // A review runs in the pull request's own checkout, which may add CLAUDE.md, .claude/settings.json, hooks or
    // MCP servers telling it to find nothing: --safe-mode loads none of the repository's customizations.
    command: (_custom, _via, review, untrusted) => `claude -p "$DIFFINERY_TASK_PROMPT" --output-format stream-json --verbose --permission-mode bypassPermissions${review ? ' --disallowedTools "WebSearch,WebFetch"' : ""}${untrusted ? " --safe-mode" : ""}`,
  },
  codex: {
    id: "codex",
    name: "Codex",
    description: "OpenAI's coding agent, with your OpenAI API key.",
    needs: ["openai"],
    alternatives: ["openrouter"],
    install: `npm install --global --no-fund --no-audit --loglevel=error @openai/codex@${RUNTIME_VERSIONS.codex} && codex --version`,
    // Through OpenRouter: a model provider for its OpenAI-compatible Responses API, defined on the command line.
    // In a pull request's own checkout, its AGENTS.md isn't read (project_doc_max_bytes=0): see claude-code above.
    command: (_custom, via, review, untrusted) =>
      `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${review ? " -c web_search=disabled" : ""}${untrusted ? " -c project_doc_max_bytes=0" : ""}${
        via === "openrouter"
          ? ' -c model_provider=openrouter -c model_providers.openrouter.name=OpenRouter -c "model_providers.openrouter.base_url=$OPENROUTER_BASE_URL" -c model_providers.openrouter.env_key=OPENROUTER_API_KEY -c model_providers.openrouter.wire_api=responses -m "$DIFFINERY_MODEL"'
          : ""
      } "$DIFFINERY_TASK_PROMPT"`,
  },
  custom: {
    id: "custom",
    name: "Custom command",
    description: "Any shell command, such as another agent's CLI. It gets the model proxy for each provider you have a key for.",
    needs: [],
    alternatives: [],
    install: null,
    command: (custom) => custom ?? "true",
  },
};

/**
 * Where a terminal keeps what a task there must not read: the providers' sign-ins and the sandbox's git
 * credential (an http extraheader in the checkout's config). Deny rules bind Claude Code's own file tools,
 * not its Bash; terminal.md says so.
 */
const TERMINAL_SECRETS = ["~/.claude/**", "~/.claude.json", "~/.codex/**", "~/.config/**", "//workspace/repo/.git/config"];

/** Claude Code's settings for a task in a terminal (passed as `--settings`): no reading or editing those files. */
export const TERMINAL_CLAUDE_SETTINGS = JSON.stringify({ permissions: { deny: TERMINAL_SECRETS.flatMap((p) => [`Read(${p})`, `Edit(${p})`]) } });

/**
 * A task in a person's web terminal (phase 4b), on the CLI signed in there: no web tools, since they run on
 * the provider, outside the task's jail and its host allowlist (containers/runner/src/jail.ts), and for Claude Code the deny rules above (in
 * $DIFFINERY_AGENT_SETTINGS, so nothing is quoted into the command).
 */
export function terminalCommand(runtime: RuntimeId): string {
  if (runtime === "claude-code") return `${RUNTIMES["claude-code"].command(undefined, undefined, true)} --settings "$DIFFINERY_AGENT_SETTINGS"`;
  return RUNTIMES[runtime].command(undefined, undefined, true);
}

export const isRuntime = (r: string): r is RuntimeId => r === "claude-code" || r === "codex" || r === "custom";

/** The model a runtime asks OpenRouter for unless the person names another. */
export const OPENROUTER_DEFAULT_MODEL: Partial<Record<RuntimeId, string>> = { "claude-code": "~anthropic/claude-sonnet-latest", codex: "~openai/gpt-sol-latest" };
/** An OpenRouter model slug, such as `anthropic/claude-sonnet-4.5`, `~openai/gpt-sol-latest` or `qwen/qwen3-coder:free`. */
export const OPENROUTER_MODEL = /^~?[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/;

/** Where a runtime's model calls go: its own provider (null `via`) or OpenRouter with a model. */
export interface ModelRoute {
  via: Provider | null;
  model: string | null;
}

/** "Claude Code", or "Claude Code via OpenRouter (model)". */
export const runtimeLabel = (runtime: RuntimeId, route?: Partial<ModelRoute> | null): string =>
  route?.via && route.via !== RUNTIMES[runtime].needs[0] ? `${RUNTIMES[runtime].name} via ${route.via === "openrouter" ? "OpenRouter" : route.via}${route.model ? ` (${route.model})` : ""}` : RUNTIMES[runtime].name;

/** A runtime as one choice on a form: "claude-code", or "claude-code+openrouter" to go through OpenRouter. */
export interface RuntimeChoice {
  value: string;
  label: string;
  description: string;
  disabled: boolean;
}

export function runtimeChoices(keys: Set<Provider>, names: Record<Provider, string>): RuntimeChoice[] {
  const out: RuntimeChoice[] = [];
  for (const id of Object.keys(RUNTIMES) as RuntimeId[]) {
    const r = RUNTIMES[id];
    for (const via of [null, ...r.alternatives]) {
      const needs = runtimeNeeds(id, via);
      const missing = needs.filter((p) => !keys.has(p));
      const description = via ? `${r.name} with your ${names[via]} key, on a model you choose there.` : r.description;
      out.push({
        value: via ? `${id}+${via}` : id,
        label: runtimeLabel(id, { via }),
        description: missing.length ? `${description} Add your ${missing.map((p) => names[p]).join(" and ")} key in Settings → Model access first.` : description,
        disabled: missing.length > 0,
      });
    }
  }
  return out;
}

/** A form's runtime choice, split into the runtime and the provider it goes through. */
export function parseRuntimeChoice(v: string): { runtime: string; provider: string | undefined } {
  const [runtime, provider] = v.split("+", 2);
  return { runtime: runtime ?? "", provider: provider || undefined };
}

/** The provider keys a run of `runtime` needs, going `via` a provider other than its own. */
export const runtimeNeeds = (runtime: RuntimeId, via: Provider | null): Provider[] => (via && RUNTIMES[runtime].alternatives.includes(via) ? [via] : RUNTIMES[runtime].needs);

/** The longest a run may take. A sandbox's git credential lasts 24 hours. */
export const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_GOAL = 20_000;
export const MAX_COMMAND = 2_000;

/**
 * Environment for the agent process: where the model proxy is, and (in
 * `secret`) the task's proxy token under each provider's usual variable. The
 * real keys stay in Diffinery.
 */
export function agentEnv(publicUrl: string, providers: Provider[], proxyToken: string, o: { runtime?: RuntimeId; route?: ModelRoute | null } = {}): { env: Record<string, string>; secret: Record<string, string> } {
  const env: Record<string, string> = { IS_SANDBOX: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
  const secret: Record<string, string> = {};
  for (const p of providers) {
    if (p === "anthropic") {
      env.ANTHROPIC_BASE_URL = `${publicUrl}/-/model/anthropic`;
      secret.ANTHROPIC_API_KEY = proxyToken;
    } else if (p === "openai") {
      env.OPENAI_BASE_URL = `${publicUrl}/-/model/openai/v1`;
      secret.OPENAI_API_KEY = proxyToken;
      secret.CODEX_API_KEY = proxyToken;
    } else {
      env.OPENROUTER_BASE_URL = `${publicUrl}/-/model/openrouter/v1`;
      secret.OPENROUTER_API_KEY = proxyToken;
    }
  }
  const route = o.route;
  if (route?.via === "openrouter" && route.model) env.DIFFINERY_MODEL = route.model;
  if (o.runtime === "claude-code" && route?.via === "openrouter") {
    // OpenRouter's Anthropic-compatible endpoint, with the token as a bearer token, and every model role on the chosen model.
    env.ANTHROPIC_BASE_URL = `${publicUrl}/-/model/openrouter`;
    secret.ANTHROPIC_AUTH_TOKEN = proxyToken;
    env.ANTHROPIC_API_KEY = "";
    if (route.model) for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) env[k] = route.model;
  }
  return { env, secret };
}

/** The prompt for a run: the goal, plus what came before for a follow-up or a retry, and the plan a person approved. */
export function runPrompt(o: { goal: string; number: number; branch: string; message?: string; previous?: string | null; by: string; context?: string | null; plan?: string | null; from?: string }): string {
  const rules = [
    `You are working on task #${o.number} in this Git repository, on behalf of ${o.by}.`,
    "Work in the current directory. When you are done, leave your changes in the working tree or commit them; Diffinery pushes them to the branch " + o.branch + " and opens a pull request for review.",
    "Don't push, change Git remotes or credentials, or open pull requests yourself.",
  ].join(" ");
  const head = o.context ? `${rules}\n\n${o.context}` : rules;
  const plan = o.plan ? `\n\nThe plan for this goal, which ${o.by} approved. Follow it:\n--- plan ---\n${o.plan}\n--- end of plan ---` : "";
  if (!o.message) return `${head}\n\nGoal:\n${o.goal}${plan}`;
  return [head, "", "The original goal:", o.goal + plan, ...(o.previous ? ["", "Where the previous run ended:", o.previous] : []), "", "The branch already has the previous runs' work checked out.", "", `New instructions from ${o.from ?? o.by}:`, o.message].join("\n");
}

/**
 * The prompt for a plan run: the agent reads the code in a read-only sandbox and writes a plan, which waits for
 * the person to approve, change or split. A run asked to change the plan gets the plan it replaces.
 */
export function planPrompt(o: { goal: string; number: number; by: string; context?: string | null; message?: string | null; plan?: string | null }): string {
  const rules = [
    `You are planning task #${o.number} in this Git repository, on behalf of ${o.by}. Plan only: the checkout is read-only, so don't change files, commit or push; nothing you change is kept.`,
    "Read the code and run read-only commands to understand it. Then write a plan another agent can build from: what to change and where, in what order, how to test it, and the risks and open questions.",
    `End your final message with the whole plan, in Markdown. ${o.by} approves it, asks for changes or splits it into tasks.`,
  ].join(" ");
  const head = o.context ? `${rules}\n\n${o.context}` : rules;
  const parts = [head, "", "Goal:", o.goal];
  if (o.plan && o.message) parts.push("", "Your previous plan:", "--- plan ---", o.plan, "--- end of plan ---", "", `Changes ${o.by} asked for:`, o.message);
  else if (o.message) parts.push("", `Also from ${o.by}:`, o.message);
  return parts.join("\n");
}

/** A transcript line, as stored. */
export type TranscriptLine = {
  seq: number;
  run: number;
  at: string;
  /** `out` and `err` are the agent's output; `setup` is installing and pushing; `note` is Diffinery's own. */
  stream: "out" | "err" | "setup" | "note";
  text: string;
};

/** What the task page shows for a line. */
export interface TranscriptItem {
  kind: "text" | "tool" | "result" | "output" | "note" | "error";
  title?: string;
  body: string;
}

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  return JSON.stringify(v, null, 2);
}

/**
 * Read one line of Claude Code's `stream-json` or Codex's `--json` output into
 * something to show; other output is shown as is.
 */
export function transcriptItem(line: TranscriptLine): TranscriptItem[] {
  if (line.stream === "note") return [{ kind: "note", body: line.text }];
  if (line.stream === "setup") return [{ kind: "output", title: "setup", body: line.text }];
  if (line.stream === "err") return [{ kind: "error", body: line.text }];
  let j: Record<string, unknown>;
  try {
    const v = JSON.parse(line.text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return [{ kind: "output", body: line.text }];
    j = v as Record<string, unknown>;
  } catch {
    return [{ kind: "output", body: line.text }];
  }
  const type = j.type;
  // Claude Code
  if (type === "system" && j.subtype === "init") return [{ kind: "note", body: `Claude Code started${j.model ? ` (${String(j.model)})` : ""}.` }];
  if (type === "assistant" || type === "user") {
    const content = ((j.message as { content?: unknown } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(content)) return [];
    const out: TranscriptItem[] = [];
    for (const b of content) {
      if (b.type === "text" && str(b.text).trim()) out.push({ kind: "text", body: str(b.text) });
      else if (b.type === "tool_use") out.push({ kind: "tool", title: str(b.name), body: clip(toolInput(b.input)) });
      else if (b.type === "tool_result") {
        const c = Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>).map((x) => str(x.text)).join("\n") : str(b.content);
        if (c.trim()) out.push({ kind: b.is_error ? "error" : "output", body: clip(c) });
      }
    }
    return out;
  }
  if (type === "result") {
    const cost = typeof j.total_cost_usd === "number" ? ` · $${j.total_cost_usd.toFixed(2)}` : "";
    const turns = typeof j.num_turns === "number" ? ` · ${j.num_turns} turns` : "";
    return [{ kind: "result", title: `${j.is_error ? "Ended with an error" : "Done"}${turns}${cost}`, body: str(j.result) }];
  }
  // Codex
  if (type === "thread.started") return [{ kind: "note", body: "Codex started." }];
  if (type === "item.completed" || type === "item.started") {
    const item = (j.item ?? {}) as Record<string, unknown>;
    if (type === "item.started") return [];
    if (item.type === "agent_message") return [{ kind: "text", body: str(item.text) }];
    if (item.type === "reasoning") return [{ kind: "note", body: str(item.text) }];
    if (item.type === "command_execution") return [{ kind: "tool", title: `$ ${str(item.command)}`, body: clip(str(item.aggregated_output)) + (typeof item.exit_code === "number" && item.exit_code !== 0 ? `\n(exit ${item.exit_code})` : "") }];
    if (item.type === "file_change") return [{ kind: "tool", title: "Edit files", body: ((item.changes ?? []) as Array<{ path?: string; kind?: string }>).map((c) => `${c.kind ?? "update"} ${c.path ?? ""}`).join("\n") }];
    if (item.type === "error") return [{ kind: "error", body: str(item.message) }];
    return [];
  }
  if (type === "turn.completed") return [];
  if (type === "turn.failed" || type === "error") return [{ kind: "error", body: str((j.error as { message?: string } | undefined)?.message ?? j.message) }];
  return [{ kind: "output", body: clip(line.text) }];
}

function toolInput(input: unknown): string {
  if (!input || typeof input !== "object") return str(input);
  const i = input as Record<string, unknown>;
  if (typeof i.command === "string") return `$ ${i.command}`;
  if (typeof i.file_path === "string") return String(i.file_path);
  return str(input);
}

/** What the runtime said last, to carry into a follow-up run (cut at `max` characters). */
export function finalMessage(lines: TranscriptLine[], max = 6000): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const item of transcriptItem(lines[i]!).reverse()) {
      if ((item.kind === "result" || item.kind === "text") && item.body.trim()) return clip(item.body, max);
    }
  }
  return null;
}

/** A branch name for a task: `agent/<number>-<slug of the goal>`. */
export function taskBranch(number: number, goal: string): string {
  let slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // At most 40 characters, cut between words.
  if (slug.length > 40) slug = slug[40] === "-" ? slug.slice(0, 40) : slug.slice(0, Math.max(slug.lastIndexOf("-", 40), 10));
  slug = slug.replace(/-+$/, "");
  return `agent/${number}${slug ? `-${slug}` : ""}`;
}

/** A pull request title from the goal: its first line, shortened. */
export function taskTitle(goal: string): string {
  const first = goal.trim().split("\n")[0]!.trim();
  return first.length > 100 ? `${first.slice(0, 97)}…` : first || "Agent task";
}
