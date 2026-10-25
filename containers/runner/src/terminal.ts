import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { PTY_HELPER } from "./pty-helper.js";

/** What the screen is redrawn from when someone attaches again. */
export const SCROLLBACK_BYTES = 256 * 1024;

/**
 * The sandbox's one interactive shell (a web terminal, phase 4). The shell keeps running while
 * nobody is attached; attaching sends the recent output so the screen can be redrawn. A new
 * connection replaces the previous one (the newest tab wins). Output is not masked: a terminal's
 * sandbox holds no secret of anyone else's, and its git credential is the agent's own.
 */
export class Terminal {
  private shell: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private scrollback: Buffer[] = [];
  private scrollbackBytes = 0;
  private detachedAt: number = Date.now();
  private helperPath: string;

  constructor(
    private workRoot: string,
    private cwd: () => string,
    private env: () => NodeJS.ProcessEnv,
  ) {
    this.helperPath = path.join(workRoot, ".pty.py");
  }

  /** For the Worker's idle rule: whether someone is attached, and since when nobody has been. */
  status(): { attached: boolean; running: boolean; idleSince: string | null } {
    return { attached: !!this.socket, running: !!this.shell, idleSince: this.socket ? null : new Date(this.detachedAt).toISOString() };
  }

  attach(ws: WebSocket, size: { cols: number; rows: number }): void {
    const previous = this.socket;
    this.socket = ws;
    if (previous) previous.close(4000, "opened in another tab");
    if (!this.shell) this.start(size);
    else this.resize(size);
    if (this.scrollbackBytes) ws.send(Buffer.concat(this.scrollback));
    ws.on("message", (data, isBinary) => {
      if (this.socket !== ws) return;
      if (isBinary) {
        this.shell?.stdin?.write(data as Buffer);
        return;
      }
      let m: { type?: unknown; cols?: unknown; rows?: unknown };
      try {
        m = JSON.parse(String(data)) as typeof m;
      } catch {
        return;
      }
      if (m.type === "resize") this.resize({ cols: Number(m.cols), rows: Number(m.rows) });
      else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    const detach = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.detachedAt = Date.now();
    };
    ws.on("close", detach);
    ws.on("error", detach);
  }

  kill(): void {
    this.shell?.kill("SIGHUP");
    this.socket?.close(1000, "terminal ended");
  }

  private start(size: { cols: number; rows: number }): void {
    writeFileSync(this.helperPath, PTY_HELPER, { mode: 0o600 });
    this.scrollback = [];
    this.scrollbackBytes = 0;
    const { cols, rows } = clampSize(size);
    const shell = spawn("python3", [this.helperPath], {
      cwd: this.cwd(),
      env: { ...this.env(), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG ?? "C.UTF-8", DIFFINERY_PTY_COLS: String(cols), DIFFINERY_PTY_ROWS: String(rows) },
      stdio: ["pipe", "pipe", "inherit", "pipe"],
    });
    this.shell = shell;
    shell.stdout!.on("data", (chunk: Buffer) => {
      this.remember(chunk);
      this.socket?.send(chunk);
    });
    shell.on("exit", () => {
      if (this.shell !== shell) return;
      this.shell = null;
      this.socket?.close(1000, "the shell exited");
    });
    shell.on("error", (e) => {
      process.stderr.write(`[sandbox] terminal: ${e.message}\n`);
    });
  }

  private resize(size: { cols: number; rows: number }): void {
    const ctl = this.shell?.stdio[3];
    if (!ctl || !("write" in ctl)) return;
    (ctl as NodeJS.WritableStream).write(`${JSON.stringify(clampSize(size))}\n`);
  }

  private remember(chunk: Buffer): void {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.length;
    while (this.scrollbackBytes > SCROLLBACK_BYTES && this.scrollback.length > 1) this.scrollbackBytes -= this.scrollback.shift()!.length;
  }
}

export function clampSize(size: { cols: number; rows: number }): { cols: number; rows: number } {
  const n = (v: number, d: number) => (Number.isFinite(v) ? Math.min(1000, Math.max(1, Math.round(v))) : d);
  return { cols: n(size.cols, 80), rows: n(size.rows, 24) };
}
