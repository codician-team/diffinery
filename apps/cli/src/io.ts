import type { Readable } from "node:stream";

/** Everything a command touches in the outside world, so tests can run the CLI in-process. */
export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: Readable & { isTTY?: boolean };
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown; isTTY?: boolean };
  /** Overridable for tests (polling loops). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Opens a URL in the browser (tests stand in for the browser); the default runs the system's opener. */
  openUrl?(url: string): Promise<boolean>;
  /** The file this CLI runs from, which `diffinery upgrade` replaces. */
  selfPath?: string;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function processIo(): Io {
  return { env: process.env, cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, sleep, selfPath: process.argv[1] };
}

/** A user-facing failure: printed as `error: message`, exits with `code`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/** Exit silently with a code (the command already printed what it wanted). */
export class ExitCode extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads one line from a TTY without echoing it (for tokens and secret values). */
export async function promptHidden(io: Io, question: string): Promise<string> {
  const stdin = io.stdin as NodeJS.ReadStream;
  io.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const raw = typeof stdin.setRawMode === "function";
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      io.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new CliError("cancelled", 130));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Asks a yes-or-no question on a terminal; anything but y or yes is no. */
export async function promptYesNo(io: Io, question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal: false });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

/** Value from a flag, else stdin when piped, else a hidden prompt. */
export async function valueFromFlagOrStdin(io: Io, flag: string | undefined, prompt: string): Promise<string> {
  if (flag !== undefined) return flag;
  if (!io.stdin.isTTY) return (await readAll(io.stdin)).replace(/\r?\n$/, "");
  return promptHidden(io, prompt);
}
