import { parseArgs } from "node:util";
import { Api } from "./api.js";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import { gitCapture, parseRemote } from "./git.js";
import { CliError, ExitCode, type Io } from "./io.js";
import { colors, type Colors } from "./output.js";
import { VERSION } from "./version.js";

export interface OptSpec {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  desc: string;
  /** Placeholder shown in help, e.g. "NAME". */
  arg?: string;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Command {
  /** Full command path, e.g. "pr create". */
  name: string;
  summary: string;
  /** Positional part of the usage line, e.g. "<number>". */
  args?: string;
  description?: string;
  options?: Record<string, OptSpec>;
  /** Accepts -R/--repo OWNER/NAME (defaults to the git origin). */
  repo?: boolean;
  /** Accepts --json. */
  json?: boolean;
  minArgs?: number;
  maxArgs?: number;
  run(ctx: Ctx, o: Values, args: string[]): Promise<number | void>;
}

export interface RepoRef {
  owner: string;
  name: string;
}

export class Ctx {
  readonly c: Colors;
  private cfg?: Promise<ResolvedConfig>;
  constructor(
    readonly io: Io,
    readonly opts: Values,
  ) {
    this.c = colors(io);
  }

  get json(): boolean {
    return this.opts.json === true;
  }

  config(): Promise<ResolvedConfig> {
    return (this.cfg ??= resolveConfig(this.io));
  }

  async api(): Promise<Api> {
    const cfg = await this.config();
    return new Api(cfg.url, cfg.token);
  }

  /** Requires a token (for commands that make no sense anonymously). */
  async authedApi(): Promise<Api> {
    const cfg = await this.config();
    if (!cfg.token) throw new CliError("not logged in: run `diffinery login` or set DIFFINERY_TOKEN");
    return new Api(cfg.url, cfg.token);
  }

  out(s: string): void {
    this.io.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  }

  err(s: string): void {
    this.io.stderr.write(s.endsWith("\n") ? s : `${s}\n`);
  }

  /** -R owner/name, else the current git repository's origin when it points at the configured host. */
  async repo(flag?: string): Promise<RepoRef> {
    const v = flag ?? (typeof this.opts.repo === "string" ? this.opts.repo : undefined);
    if (v) return parseRepoArg(v);
    const cfg = await this.config();
    const host = new URL(cfg.url).host;
    const r = await gitCapture(this.io, ["remote", "get-url", "origin"]);
    if (r.code === 0) {
      const parsed = parseRemote(r.stdout, host);
      if (parsed) return parsed;
      // A remote on another host is often another Diffinery instance (a self-hosted one): say how to switch.
      throw new CliError(`the origin remote (${r.stdout.trim()}) does not point at ${host}, the Diffinery this CLI uses; pass -R OWNER/NAME, or if it's another Diffinery, sign in there with diffinery login --url https://HOST (or set DIFFINERY_URL)`);
    }
    throw new CliError("no repository given: pass -R OWNER/NAME or run inside a clone of a Diffinery repository");
  }
}

export function parseRepoArg(v: string): RepoRef {
  const s = v.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const [owner, name, extra] = s.split("/");
  if (!owner || !name || extra !== undefined) throw new CliError(`expected OWNER/NAME, got "${v}"`, 2);
  return { owner, name };
}

export const repoPath = (r: RepoRef) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;

// ---------------------------------------------------------------- help

const COMMON: Record<string, OptSpec> = {
  repo: { type: "string", short: "R", desc: "Repository (default: inferred from the git origin remote)", arg: "OWNER/NAME" },
  json: { type: "boolean", desc: "Print raw JSON" },
  help: { type: "boolean", short: "h", desc: "Show help" },
};

export function optionsFor(cmd: Command): Record<string, OptSpec> {
  return { ...(cmd.repo ? { repo: COMMON.repo! } : {}), ...cmd.options, ...(cmd.json ? { json: COMMON.json! } : {}), help: COMMON.help! };
}

export function commandHelp(cmd: Command): string {
  const opts = optionsFor(cmd);
  const lines = [`${cmd.summary}`, "", `Usage: diffinery ${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}${Object.keys(opts).length > 1 ? " [options]" : ""}`];
  if (cmd.description) lines.push("", cmd.description.trim());
  const rows = Object.entries(opts).map(([k, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : "    "}--${k}${o.type === "string" ? ` ${o.arg ?? "VALUE"}` : ""}`;
    return [flag, o.desc + (o.multiple ? " (repeatable)" : "")];
  });
  const w = Math.max(...rows.map((r) => r[0]!.length));
  lines.push("", "Options:", ...rows.map(([f, d]) => `  ${f!.padEnd(w)}  ${d}`));
  return lines.join("\n") + "\n";
}

export function groupHelp(group: string, summary: string, cmds: Command[]): string {
  const w = Math.max(...cmds.map((c) => c.name.length));
  return [summary, "", `Usage: diffinery ${group} <command> [options]`, "", "Commands:", ...cmds.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`), "", `Run 'diffinery ${group} <command> --help' for details.`].join("\n") + "\n";
}

// ---------------------------------------------------------------- dispatch

export interface Group {
  name: string;
  summary: string;
  commands: Command[];
}

export interface Registry {
  groups: Group[];
  commands: Command[];
}

export function topHelp(reg: Registry): string {
  const rows: Array<[string, string]> = [...reg.groups.map((g) => [g.name, g.summary] as [string, string]), ...reg.commands.map((c) => [c.name, c.summary] as [string, string])];
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const w = Math.max(...rows.map((r) => r[0].length));
  return [
    `diffinery ${VERSION}: command-line client for Diffinery`,
    "",
    "Usage: diffinery <command> [subcommand] [options]",
    "",
    "Commands:",
    ...rows.map(([n, s]) => `  ${n.padEnd(w)}  ${s}`),
    "",
    "Global:",
    "  --help, -h     Show help for any command",
    "  --version      Print the version",
    "",
    "Configuration: ~/.config/diffinery/config.json (respects XDG_CONFIG_HOME);",
    "DIFFINERY_URL and DIFFINERY_TOKEN override it.",
  ].join("\n") + "\n";
}

export async function dispatch(reg: Registry, argv: string[], io: Io): Promise<number> {
  const [first, ...rest] = argv;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    if (first === "help" && rest.length) return dispatch(reg, [...rest, "--help"], io);
    io.stdout.write(topHelp(reg));
    return first ? 0 : argv.length ? 0 : 2;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    io.stdout.write(`diffinery ${VERSION}\n`);
    return 0;
  }
  const group = reg.groups.find((g) => g.name === first);
  if (group) {
    const [sub, ...args] = rest;
    if (!sub || sub === "--help" || sub === "-h") {
      io.stdout.write(groupHelp(group.name, group.summary, group.commands));
      return sub ? 0 : 2;
    }
    const cmd = group.commands.find((c) => c.name === `${group.name} ${sub}`);
    if (!cmd) {
      io.stderr.write(`unknown command "${group.name} ${sub}"\n\n${groupHelp(group.name, group.summary, group.commands)}`);
      return 2;
    }
    return runCommand(cmd, args, io);
  }
  const cmd = reg.commands.find((c) => c.name === first);
  if (!cmd) {
    io.stderr.write(`unknown command "${first}"; run 'diffinery --help'\n`);
    return 2;
  }
  return runCommand(cmd, rest, io);
}

export async function runCommand(cmd: Command, argv: string[], io: Io): Promise<number> {
  const specs = optionsFor(cmd);
  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: Object.fromEntries(Object.entries(specs).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }])),
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Values;
    positionals = parsed.positionals;
  } catch (e) {
    io.stderr.write(`error: ${(e as Error).message.replace(/^TypeError \[[A-Z_]+\]: /, "")}\n\n${commandHelp(cmd)}`);
    return 2;
  }
  if (values.help) {
    io.stdout.write(commandHelp(cmd));
    return 0;
  }
  if ((cmd.minArgs !== undefined && positionals.length < cmd.minArgs) || (cmd.maxArgs !== undefined && positionals.length > cmd.maxArgs)) {
    io.stderr.write(`error: ${positionals.length < (cmd.minArgs ?? 0) ? "missing arguments" : `unexpected argument "${positionals[cmd.maxArgs ?? 0]}"`}\n\n${commandHelp(cmd)}`);
    return 2;
  }
  const ctx = new Ctx(io, values);
  try {
    const code = await cmd.run(ctx, values, positionals);
    return typeof code === "number" ? code : 0;
  } catch (e) {
    if (e instanceof ExitCode) return e.code;
    if (e instanceof CliError) {
      io.stderr.write(`${ctx.c.red("error:")} ${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- small helpers for commands

export const str = (o: Values, k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
export const list = (o: Values, k: string): string[] => (Array.isArray(o[k]) ? (o[k] as string[]) : typeof o[k] === "string" ? [o[k] as string] : []);

export function positiveInt(v: string | undefined, what: string): number {
  const n = Number(String(v ?? "").replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) throw new CliError(`${what} must be a positive number, got "${v ?? ""}"`, 2);
  return n;
}

export function exactlyOne(o: Values, keys: string[], fallback?: string): string {
  const set = keys.filter((k) => o[k] === true);
  if (set.length > 1) throw new CliError(`use only one of ${keys.map((k) => `--${k}`).join(", ")}`, 2);
  if (set.length === 0) {
    if (fallback) return fallback;
    throw new CliError(`one of ${keys.map((k) => `--${k}`).join(", ")} is required`, 2);
  }
  return set[0]!;
}
