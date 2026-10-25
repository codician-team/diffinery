import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

/**
 * Registry relay for hosted runners: an HTTP(S) proxy for the Docker daemon.
 *
 * Cloudflare refuses request bodies over 100 MB, and Docker sends each image layer in a
 * single request, so a big layer could never reach the Diffinery registry directly. The
 * Docker daemon on a hosted runner uses this relay as its HTTPS proxy. Connections to the
 * Diffinery host are terminated here (the daemon trusts this relay's certificate for that
 * host only, through /etc/docker/certs.d), and blob uploads are re-sent as a series of
 * chunked PATCH requests with Content-Range, which the registry API supports. Everything
 * else is passed through unchanged, and other hosts are tunnelled untouched.
 */
export interface RelayOptions {
  /** Port to listen on (127.0.0.1). */
  port: number;
  /** Host name the relay intercepts, e.g. diffinery.com. */
  host: string;
  /** Where intercepted requests really go, e.g. https://diffinery.com. */
  upstream: string;
  cert: string;
  key: string;
  /** Upload chunk size; must stay under Cloudflare's 100 MB limit. */
  chunkSize?: number;
  log?: (line: string) => void;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const UPLOAD_PATH = /^\/v2\/.+\/blobs\/uploads\/[^/?]+(\?.*)?$/;

export interface Relay {
  port: number;
  close(): Promise<void>;
}

export async function startRelay(o: RelayOptions): Promise<Relay> {
  const log = o.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const upstream = new URL(o.upstream);
  const client = upstream.protocol === "https:" ? https : http;
  const agent = new client.Agent({ keepAlive: true, maxSockets: 32 });
  const chunkSize = o.chunkSize ?? 64 * 1024 * 1024;

  /** One upstream request with a fully buffered (or empty) body. */
  function send(method: string, path: string, headers: http.OutgoingHttpHeaders, body?: Buffer): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = client.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method, path, headers: { ...headers, host: upstream.host, "content-length": String(body?.length ?? 0) }, agent }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (d: Buffer) => parts.push(d));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(parts) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  function forwardHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
    const h: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) h[k] = v;
    return h;
  }

  /** Streams a request and its response straight through. */
  function passThrough(req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers = forwardHeaders(req);
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    const up = client.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: req.method, path: req.url, headers: { ...headers, host: upstream.host }, agent }, (r) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP_BY_HOP.has(k) || k === "content-length") out[k] = v;
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    });
    up.on("error", (e) => {
      log(`relay: ${req.method} ${req.url} failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ code: "UNKNOWN", message: `registry relay: ${e.message}` }] }));
    });
    req.pipe(up);
  }

  /**
   * A blob upload (PATCH or PUT to an upload URL): sent on in chunks. Each full chunk
   * goes as a PATCH with Content-Range; a PUT's remainder goes with the final PUT.
   */
  async function chunkedUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, "http://relay");
    const started = Date.now();
    let requests = 0;
    const secs = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
    const headers = forwardHeaders(req);
    delete headers["content-range"];
    delete headers["content-type"];
    let location = url.pathname;
    // Where the upload stands: earlier chunks may have come through another connection.
    const status = await send("GET", location, { authorization: req.headers.authorization ?? "" });
    if (status.status !== 204) return reply(res, status);
    let offset = uploadSize(status.headers);
    const declaredStart = /^(?:bytes[ =])?(\d+)-/.exec(String(req.headers["content-range"] ?? ""));
    if (declaredStart && Number(declaredStart[1]) !== offset) return reply(res, status, 416);

    // Pieces received since the last chunk went out. Joining them only when a chunk is full
    // copies each byte once; growing one buffer per piece copied whole chunks thousands of times.
    let pieces: Buffer[] = [];
    let held = 0;
    const take = (n: number): Buffer => {
      const all = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, held);
      const rest = all.subarray(n);
      pieces = rest.length ? [rest] : [];
      held = rest.length;
      return all.subarray(0, n);
    };
    let last: Awaited<ReturnType<typeof send>> | null = null;
    const flush = async (data: Buffer) => {
      for (let attempt = 1; ; attempt++) {
        try {
          requests++;
          const r = await send("PATCH", location, { ...headers, "content-type": "application/octet-stream", "content-range": `${offset}-${offset + data.length - 1}` }, data);
          if (r.status !== 202) log(`relay: PATCH ${url.pathname} (${data.length} bytes at ${offset}) answered ${r.status} (attempt ${attempt})`);
          if (r.status === 202) {
            location = new URL(String(r.headers.location ?? location), "http://relay").pathname;
            offset += data.length;
            last = r;
            return true;
          }
          if (r.status < 500 || attempt >= 3) {
            last = r;
            return false;
          }
        } catch (e) {
          if (attempt >= 3) throw e;
        }
        // Retry from wherever the registry got to.
        const s = await send("GET", location, { authorization: req.headers.authorization ?? "" });
        if (s.status === 204 && uploadSize(s.headers) === offset + data.length) {
          offset += data.length;
          last = s;
          return true;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    };
    for await (const piece of req as AsyncIterable<Buffer>) {
      pieces.push(piece);
      held += piece.length;
      while (held >= chunkSize) if (!(await flush(take(chunkSize)))) return reply(res, last!);
    }
    const buf = take(held);
    if (req.method === "PUT") {
      const put = Date.now();
      const r = await send("PUT", `${location}${url.search}`, { ...headers, ...(buf.length ? { "content-type": "application/octet-stream", "content-range": `${offset}-${offset + buf.length - 1}` } : {}) }, buf);
      log(`relay: upload ${url.pathname}: ${offset + buf.length} bytes in ${requests + 1} requests over ${secs(started)}; the final PUT answered ${r.status} after ${secs(put)}`);
      return reply(res, r);
    }
    if (buf.length && !(await flush(buf))) return reply(res, last!);
    if (!last) last = await send("GET", location, { authorization: req.headers.authorization ?? "" });
    // The client sent one PATCH; answer it like the registry would, covering everything so far.
    return reply(res, { ...last, status: 202, headers: { ...last.headers, location, range: `0-${Math.max(0, offset - 1)}` } }, 202);
  }

  function reply(res: http.ServerResponse, r: { status: number; headers: http.IncomingHttpHeaders; body: Buffer }, status = r.status): void {
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
    out["content-length"] = String(r.body.length);
    res.writeHead(status, out);
    res.end(r.body);
  }

  // Intercepted HTTPS traffic for the Diffinery host.
  const inner = http.createServer((req, res) => {
    const big = (req.method === "PATCH" || req.method === "PUT") && UPLOAD_PATH.test(req.url ?? "");
    if (!big) return passThrough(req, res);
    chunkedUpload(req, res).catch((e: Error) => {
      log(`relay: upload ${req.url} failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ code: "BLOB_UPLOAD_INVALID", message: `registry relay: ${e.message}` }] }));
    });
  });
  inner.requestTimeout = 0;
  inner.headersTimeout = 120_000;
  const secure = { cert: o.cert, key: o.key };

  // The proxy itself: CONNECT tunnels, plus plain-HTTP proxying for completeness.
  const proxy = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute URL required");
      return;
    }
    const up = http.request(target, { method: req.method, headers: { ...forwardHeaders(req), host: target.host, ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}) } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  proxy.requestTimeout = 0;
  proxy.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr || 443);
    socket.on("error", () => socket.destroy());
    if (host?.toLowerCase() === o.host.toLowerCase() && port === 443) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      const t = new tls.TLSSocket(socket, { isServer: true, ...secure, ALPNProtocols: ["http/1.1"] });
      t.on("error", () => t.destroy());
      inner.emit("connection", t);
      return;
    }
    const out = net.connect(port, host!, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) out.write(head);
      out.pipe(socket);
      socket.pipe(out);
    });
    out.on("error", () => {
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(o.port, "127.0.0.1", () => resolve());
  });
  const port = (proxy.address() as net.AddressInfo).port;
  log(`registry relay for ${o.host} -> ${o.upstream} listening on 127.0.0.1:${port}`);
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        agent.destroy();
        inner.close();
        proxy.closeAllConnections();
        proxy.close(() => resolve());
      }),
  };
}

/** Bytes the registry holds for an upload. */
function uploadSize(h: http.IncomingHttpHeaders): number {
  const exact = Number(h["diffinery-upload-size"]);
  if (Number.isInteger(exact) && exact >= 0) return exact;
  const m = /^(?:bytes=)?(\d+)-(\d+)$/.exec(String(h.range ?? ""));
  return m && Number(m[2]) > 0 ? Number(m[2]) + 1 : 0;
}
