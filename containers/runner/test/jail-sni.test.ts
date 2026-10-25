import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientHelloServerName, startJailProxy } from "../src/jail.js";
import { tmp } from "./helpers.js";

// Several hosts a task may reach (registry.npmjs.org, chatgpt.com) are behind a CDN that serves every site it
// hosts on the same addresses. A tunnel the proxy opened by the CONNECT host alone could carry TLS for any of
// them, an attacker's included, so it opens only when the ClientHello asks for that same host.

const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
const ext = (type: number, data: Buffer) => Buffer.concat([u16(type), u16(data.length), data]);
const sni = (...names: string[]) => {
  const list = Buffer.concat(names.map((n) => Buffer.concat([Buffer.from([0]), u16(n.length), Buffer.from(n)])));
  return ext(0, Buffer.concat([u16(list.length), list]));
};
/** A TLS 1.3-style ClientHello handshake message with these extensions. */
const hello = (...exts: Buffer[]) => {
  const e = Buffer.concat(exts);
  const body = Buffer.concat([u16(0x0303), Buffer.alloc(32, 7), Buffer.from([0]), u16(2), u16(0x1301), Buffer.from([1, 0]), u16(e.length), e]);
  return Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 255, body.length & 255]), body]);
};
const record = (hs: Buffer) => Buffer.concat([Buffer.from([0x16, 3, 1]), u16(hs.length), hs]);

describe("the jail proxy's ClientHello check", () => {
  it("reads the server name a ClientHello asks for", () => {
    expect(clientHelloServerName(record(hello(ext(0x2b, Buffer.from([2, 3, 4])), sni("Registry.NPMjs.org."))))).toBe("registry.npmjs.org");
    // Split over two records, as a large post-quantum key share can make it.
    const hs = hello(ext(0x33, Buffer.alloc(3000, 1)), sni("registry.npmjs.org"));
    const split = Buffer.concat([record(hs.subarray(0, 100)), record(hs.subarray(100))]);
    expect(clientHelloServerName(split)).toBe("registry.npmjs.org");
    expect(clientHelloServerName(split.subarray(0, split.length - 1))).toBeUndefined();
    expect(clientHelloServerName(split.subarray(0, 3))).toBeUndefined();
  });

  it("finds no usable name in anything else", () => {
    expect(clientHelloServerName(record(hello()))).toBeNull(); // no SNI
    expect(clientHelloServerName(record(hello(sni("a.test", "b.test"))))).toBeNull();
    expect(clientHelloServerName(record(hello(sni("a.test"), sni("b.test"))))).toBeNull();
    expect(clientHelloServerName(record(hello(sni("registry.npmjs.org"), ext(0xfe0d, Buffer.alloc(40, 9)))))).toBeNull(); // Encrypted Client Hello
    expect(clientHelloServerName(record(hello(sni("bad name\u0000.test"))))).toBeNull();
    expect(clientHelloServerName(Buffer.from("GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n"))).toBeNull();
    const truncated = hello(sni("registry.npmjs.org"));
    truncated[3] = truncated[3]! + 50; // claims more than the record holds, which never arrives
    expect(clientHelloServerName(Buffer.concat([record(truncated), Buffer.alloc(70 * 1024)]))).toBeNull();
  });

  describe("in the proxy", () => {
    let close: () => void;
    let sock: string;
    const logs: string[] = [];
    const upstream: Array<{ host: string; bytes: Buffer }> = [];
    let tlsServer: net.Server;
    beforeAll(async () => {
      sock = path.join(tmp("jail-sni-"), "p.sock");
      // Stands in for the real host: records what the tunnel sends it.
      tlsServer = net.createServer((s) => s.on("data", (d) => upstream.at(-1)!.bytes = Buffer.concat([upstream.at(-1)!.bytes, d])));
      await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", () => r()));
      const port = (tlsServer.address() as net.AddressInfo).port;
      const server = await startJailProxy(sock, (l) => logs.push(l), (_p, host, onConnect) => {
        upstream.push({ host, bytes: Buffer.alloc(0) });
        return net.connect(port, "127.0.0.1", onConnect);
      });
      close = () => (server.close(), tlsServer.close());
    });
    afterAll(() => close());

    /** CONNECT to `target`, then start TLS asking for `servername`; resolves once the proxy has decided. */
    const tunnel = (target: string, servername: string) =>
      new Promise<"closed" | "open">((resolve) => {
        const c = net.connect(sock, () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let got = "";
        const onData = (d: Buffer) => {
          got += d;
          if (!got.includes("\r\n\r\n")) return;
          c.off("data", onData);
          const t = tls.connect({ socket: c, servername, rejectUnauthorized: false });
          t.on("error", () => {});
          c.on("close", () => resolve("closed"));
          setTimeout(() => (resolve("open"), c.destroy()), 500);
        };
        c.on("data", onData);
        c.on("error", () => resolve("closed"));
      });

    it("opens the tunnel when the ClientHello asks for the CONNECT host", async () => {
      expect(await tunnel("registry.npmjs.org:443", "registry.npmjs.org")).toBe("open");
      const sent = upstream.at(-1)!;
      expect(sent.host).toBe("registry.npmjs.org");
      expect(clientHelloServerName(sent.bytes)).toBe("registry.npmjs.org");
    });

    it("closes it, without connecting anywhere, when the ClientHello asks for another site", async () => {
      const before = upstream.length;
      expect(await tunnel("registry.npmjs.org:443", "attacker.workers.dev")).toBe("closed");
      expect(upstream.length).toBe(before);
      expect(logs.some((l) => l.includes("refused a connection to registry.npmjs.org:443") && l.includes("asks for attacker.workers.dev"))).toBe(true);
    });
  });
});
