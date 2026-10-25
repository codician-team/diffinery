import type { LogLine } from "@diffinery/shared";
import type { LogBatcher } from "./api.js";
import { parseCommand } from "./commands.js";
import type { Masker } from "./mask.js";
import { nowIso } from "./util.js";

/** Masks and ships log lines; keeps a short tail per step for failure summaries. */
export class JobLogger {
  private tails = new Map<number, string[]>();

  constructor(
    private readonly masker: Masker,
    private readonly batcher: LogBatcher | null,
    private readonly echo: boolean,
  ) {}

  line(step: number, text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      const masked = this.masker.mask(raw);
      const l: LogLine = { t: nowIso(), step, text: masked };
      this.batcher?.push(l);
      if (this.echo) process.stdout.write(`[${step}] ${masked}\n`);
      let tail = this.tails.get(step);
      if (!tail) this.tails.set(step, (tail = []));
      tail.push(masked);
      if (tail.length > 40) tail.splice(0, tail.length - 40);
    }
  }

  tail(step: number, n = 20): string[] {
    // skip runner chrome (##[group] etc.) in summaries
    return (this.tails.get(step) ?? []).filter((l) => !/^##\[(group|endgroup)\]/.test(l)).slice(-n);
  }
}

export interface Annotation {
  level: "error" | "warning" | "notice";
  message: string;
  file?: string;
  line?: string;
  title?: string;
}

export interface OutputSink {
  logIndex: number;
  outputs: Record<string, string>;
  state: Record<string, string>;
}

/**
 * Interprets workflow commands on a step's stdout/stderr and forwards the
 * remaining text to the logger.
 */
export class OutputProcessor {
  private stopToken: string | null = null;
  private echoCommands = false;

  constructor(
    private readonly logger: JobLogger,
    private readonly masker: Masker,
    private readonly sink: OutputSink,
    private readonly hooks: {
      debug: boolean;
      onAnnotation: (a: Annotation) => void;
    },
  ) {}

  private log(text: string): void {
    this.logger.line(this.sink.logIndex, text);
  }

  handle(line: string): void {
    if (this.stopToken !== null) {
      if (line.trim() === `::${this.stopToken}::`) {
        this.stopToken = null;
        return;
      }
      this.log(line);
      return;
    }
    const cmd = parseCommand(line);
    if (!cmd) {
      this.log(line);
      return;
    }
    if (this.echoCommands && cmd.command !== "add-mask") this.log(line);
    const p = cmd.properties;
    switch (cmd.command) {
      case "add-mask":
        this.masker.add(cmd.message);
        return;
      case "set-output":
        if (p.name) this.sink.outputs[p.name] = cmd.message;
        return;
      case "save-state":
        if (p.name) this.sink.state[p.name] = cmd.message;
        return;
      case "group":
        this.log(`##[group]${cmd.message}`);
        return;
      case "endgroup":
        this.log("##[endgroup]");
        return;
      case "debug":
        if (this.hooks.debug) this.log(`##[debug]${cmd.message}`);
        return;
      case "error":
      case "warning":
      case "notice": {
        const a: Annotation = { level: cmd.command, message: cmd.message };
        if (p.file) a.file = p.file;
        if (p.line) a.line = p.line;
        if (p.title) a.title = p.title;
        const loc = a.file ? `${a.file}${a.line ? `:${a.line}` : ""}: ` : "";
        const title = a.title ? `${a.title}: ` : "";
        this.log(`##[${cmd.command}]${loc}${title}${cmd.message}`);
        this.hooks.onAnnotation(a);
        return;
      }
      case "stop-commands":
        if (cmd.message) this.stopToken = cmd.message;
        return;
      case "echo":
        this.echoCommands = cmd.message.trim() === "on";
        return;
      case "set-env":
      case "add-path":
        this.log(`##[error]The \`${cmd.command}\` command is disabled. Please upgrade to using Environment Files.`);
        this.hooks.onAnnotation({ level: "error", message: `The \`${cmd.command}\` command is disabled.` });
        return;
      default:
        this.log(line);
    }
  }
}
