import { timingSafeEqual } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import path from "node:path";
import { startSandbox, type SandboxHandle } from "./sandbox.js";

/**
 * Local development and end-to-end tests only: many sandboxes in one process,
 * standing in for one Cloudflare Container per sandbox (containers don't run
 * under `wrangler dev`). The Worker boots a sandbox with the same environment a
 * container would get (`POST /boot`), then reaches it under `/s/<id>/...`.
 */

export interface PoolOptions {
  port: number;
  host?: string;
  /** Guards /boot; each sandbox still checks its own secret. */
  secret: string;
  workRoot: string;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

export async function startSandboxPool(o: PoolOptions): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const sandboxes = new Map<string, SandboxHandle>();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://pool");
      try {
        const poolAuth = () => same(/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "", o.secret);
        if (req.method === "POST" && url.pathname === "/boot") {
          if (!poolAuth()) return json(res, 401, { error: "unauthorized" });
          const b = await readJson(req);
          const id = String(b.id ?? "");
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof b.secret !== "string") return json(res, 400, { error: "`id` and `secret` are required" });
          const env = (b.env ?? {}) as Record<string, string>;
          await sandboxes.get(id)?.close();
          const sb = await startSandbox({
            port: 0,
            host: "127.0.0.1",
            secret: b.secret,
            workRoot: path.join(o.workRoot, id),
            cloneUrl: env.DIFFINERY_CLONE_URL,
            ref: env.DIFFINERY_REF,
            token: env.DIFFINERY_JOB_TOKEN,
            baseEnv: { ...process.env, ...env },
          });
          sandboxes.set(id, sb);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname.startsWith("/shutdown/")) {
          if (!poolAuth()) return json(res, 401, { error: "unauthorized" });
          const id = url.pathname.slice("/shutdown/".length);
          await sandboxes.get(id)?.close();
          sandboxes.delete(id);
          return json(res, 200, { ok: true });
        }
        const m = /^\/s\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
        const sb = m ? sandboxes.get(m[1]!) : undefined;
        if (!m || !sb) return json(res, 404, { error: "sandbox not found" });
        // Forward as is; the sandbox checks its own secret.
        const up = request({ host: "127.0.0.1", port: sb.port, method: req.method, path: m[2]! + url.search, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on("error", (e) => json(res, 502, { error: e.message }));
        req.pipe(up);
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
  // WebSocket upgrades (the terminal) go through as raw TCP; the sandbox checks its own secret.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://pool");
    const m = /^\/s\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
    const sb = m ? sandboxes.get(m[1]!) : undefined;
    if (!m || !sb) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const up = connect(sb.port, "127.0.0.1", () => {
      const lines = [`${req.method} ${m[2]!}${url.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", end);
    socket.on("error", end);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => resolve());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: async () => {
      await Promise.all([...sandboxes.values()].map((s) => s.close()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
