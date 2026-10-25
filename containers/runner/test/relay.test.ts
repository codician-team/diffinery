import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRelay, type Relay } from "../src/relay.js";
import { tmp } from "./helpers.js";

/**
 * The registry relay against a fake registry: blob uploads arrive in chunks no bigger
 * than the limit, everything else passes through, and other hosts are tunnelled.
 */

const HOST = "registry.test";
const sha = (b: Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

interface Upload {
  data: Buffer[];
  size: number;
}

/** Just enough of the OCI upload API to see what the relay sends. */
function fakeRegistry() {
  const uploads = new Map<string, Upload>();
  const blobs = new Map<string, Buffer>();
  const requests: Array<{ method: string; url: string; length: number; range?: string }> = [];
  let next = 0;
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p as Buffer);
    const body = Buffer.concat(parts);
    const url = new URL(req.url!, "http://x");
    requests.push({ method: req.method!, url: req.url!, length: body.length, range: req.headers["content-range"] as string | undefined });
    if (req.headers.authorization !== "Basic dTpw") return res.writeHead(401).end();
    const head = (u: Upload, id: string) => ({ location: `/v2/o/img/blobs/uploads/${id}`, range: `0-${Math.max(0, u.size - 1)}`, "diffinery-upload-size": String(u.size) });
    let m: RegExpExecArray | null;
    if (req.method === "POST" && url.pathname === "/v2/o/img/blobs/uploads/") {
      const id = `u${++next}`;
      uploads.set(id, { data: [], size: 0 });
      return res.writeHead(202, head(uploads.get(id)!, id)).end();
    }
    if ((m = /^\/v2\/o\/img\/blobs\/uploads\/(\w+)$/.exec(url.pathname))) {
      const u = uploads.get(m[1]!);
      if (!u) return res.writeHead(404).end();
      if (req.method === "GET") return res.writeHead(204, head(u, m[1]!)).end();
      const cr = req.headers["content-range"] as string | undefined;
      if (cr && Number(cr.split("-")[0]) !== u.size) return res.writeHead(416, head(u, m[1]!)).end();
      if (body.length > 1024 * 1024) return res.writeHead(413).end("too large");
      u.data.push(body);
      u.size += body.length;
      if (req.method === "PATCH") return res.writeHead(202, head(u, m[1]!)).end();
      const all = Buffer.concat(u.data);
      if (sha(all) !== url.searchParams.get("digest")) return res.writeHead(400).end("digest");
      blobs.set(sha(all), all);
      return res.writeHead(201, { location: `/v2/o/img/blobs/${sha(all)}`, "docker-content-digest": sha(all) }).end();
    }
    if ((m = /^\/v2\/o\/img\/blobs\/(sha256:\w+)$/.exec(url.pathname))) {
      const b = blobs.get(m[1]!);
      return b ? res.writeHead(200, { "content-length": String(b.length) }).end(b) : res.writeHead(404).end();
    }
    res.writeHead(404).end();
  });
  return { server, uploads, blobs, requests };
}

let reg: ReturnType<typeof fakeRegistry>;
let relay: Relay;
let cert: string;
let logged: string[];

beforeEach(async () => {
  const dir = tmp();
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`, "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
  cert = readFileSync(path.join(dir, "c.pem"), "utf8");
  reg = fakeRegistry();
  await new Promise<void>((r) => reg.server.listen(0, "127.0.0.1", () => r()));
  const upstream = `http://127.0.0.1:${(reg.server.address() as net.AddressInfo).port}`;
  logged = [];
  relay = await startRelay({ port: 0, host: HOST, upstream, cert, key: readFileSync(path.join(dir, "k.pem"), "utf8"), chunkSize: 1024 * 1024, log: (l) => void logged.push(l) });
});

afterEach(async () => {
  await relay.close();
  reg.server.closeAllConnections();
  await new Promise((r) => reg.server.close(r));
});

/** An HTTPS request to the registry host through the relay, as the Docker daemon makes it. */
function viaRelay(method: string, url: string, body?: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const connect = http.request({ host: "127.0.0.1", port: relay.port, method: "CONNECT", path: `${HOST}:443` });
    connect.on("error", reject);
    connect.on("connect", (_res, socket) => {
      const secure = tls.connect({ socket, servername: HOST, ca: cert });
      const req = http.request({ method, path: url, headers: { host: HOST, authorization: "Basic dTpw", ...headers }, createConnection: () => secure }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (d: Buffer) => parts.push(d));
        res.on("end", () => {
          secure.destroy();
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) });
        });
      });
      req.on("error", reject);
      // Stream the body in pieces, with no Content-Length, like docker does.
      if (body) for (let i = 0; i < body.length; i += 300_000) req.write(body.subarray(i, i + 300_000));
      req.end();
    });
    connect.end();
  });
}

describe("registry relay", () => {
  it("splits a single-PUT upload (containerd) into PATCH chunks under the limit", async () => {
    const blob = Buffer.alloc(2_600_000, 7);
    const start = await viaRelay("POST", "/v2/o/img/blobs/uploads/");
    expect(start.status).toBe(202);
    const done = await viaRelay("PUT", `${start.headers.location}?digest=${sha(blob)}`, blob);
    expect(done.status).toBe(201);
    expect(done.headers["docker-content-digest"]).toBe(sha(blob));
    expect(reg.blobs.get(sha(blob))?.equals(blob)).toBe(true);
    const sent = reg.requests.filter((r) => r.method === "PATCH" || r.method === "PUT");
    expect(sent.map((r) => [r.method, r.length])).toEqual([
      ["PATCH", 1048576],
      ["PATCH", 1048576],
      ["PUT", 502848],
    ]);
    expect(sent[1]!.range).toBe("1048576-2097151");
    // Its log (shown when a docker push fails) says how long the registry took to answer.
    expect(logged.at(-1)).toMatch(/^relay: upload \/v2\/o\/img\/blobs\/uploads\/\S+: 2600000 bytes in 3 requests over [\d.]+s; the final PUT answered 201 after [\d.]+s$/);
  });

  it("answers a streamed PATCH (docker) like the registry would, then completes with an empty PUT", async () => {
    const blob = Buffer.from(Array.from({ length: 2_300_000 }, (_, i) => i % 251));
    const start = await viaRelay("POST", "/v2/o/img/blobs/uploads/");
    const patch = await viaRelay("PATCH", String(start.headers.location), blob);
    expect(patch.status).toBe(202);
    expect(patch.headers.range).toBe(`0-${blob.length - 1}`);
    expect(reg.requests.filter((r) => r.method === "PATCH").length).toBe(3);
    const put = await viaRelay("PUT", `${patch.headers.location}?digest=${sha(blob)}`);
    expect(put.status).toBe(201);
    const back = await viaRelay("GET", `/v2/o/img/blobs/${sha(blob)}`);
    expect(back.status).toBe(200);
    expect(back.body.equals(blob)).toBe(true);
  });

  it("passes the registry's errors back", async () => {
    const start = await viaRelay("POST", "/v2/o/img/blobs/uploads/");
    const bad = await viaRelay("PUT", `${start.headers.location}?digest=${sha(Buffer.from("other"))}`, Buffer.from("content"));
    expect(bad.status).toBe(400);
    expect((await viaRelay("GET", "/v2/o/img/blobs/uploads/nope")).status).toBe(404);
    expect((await viaRelay("GET", "/v2/o/img/blobs/uploads/u1", undefined, { authorization: "Basic bm86bm8=" })).status).toBe(401);
  });

  it("tunnels other hosts untouched", async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    const port = (echo.address() as net.AddressInfo).port;
    const reply = await new Promise<string>((resolve, reject) => {
      const connect = http.request({ host: "127.0.0.1", port: relay.port, method: "CONNECT", path: `127.0.0.1:${port}` });
      connect.on("error", reject);
      connect.on("connect", (res, socket) => {
        expect(res.statusCode).toBe(200);
        socket.once("data", (d) => {
          resolve(d.toString());
          socket.destroy();
        });
        socket.write("ping");
      });
      connect.end();
    });
    expect(reply).toBe("ping");
    echo.close();
  });
});
