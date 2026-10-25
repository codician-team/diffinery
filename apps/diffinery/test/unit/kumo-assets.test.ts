/** The islands bundle goes out as built: compressed once at build time, answered before any session lookup. Needs `pnpm build`. */
import { describe, expect, it } from "vitest";
import { brotliDecompressSync } from "node:zlib";
import { app } from "../../src/app.js";
import { kumoAssets } from "../../src/web/kumo.js";
import type { Env } from "../../src/env.js";

// No DB: a session lookup or rate limit would throw, so answering at all shows the asset skips them.
const env = { PUBLIC_URL: "https://diffinery.example" } as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`https://diffinery.example${path}`, { headers: { cookie: "session=whatever", ...headers } }), env, ctx);

describe("Kumo assets", () => {
  it("send the brotli copy made at build time, or the text to a client that takes no br", async () => {
    for (const path of [kumoAssets().js, kumoAssets().css]) {
      const plain = await get(path);
      expect(plain.status).toBe(200);
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(plain.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(plain.headers.get("vary")).toBe("accept-encoding");
      expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
      expect(plain.headers.get("content-type")).toMatch(path.endsWith(".js") ? /^text\/javascript/ : /^text\/css/);
      const text = await plain.text();
      expect(text.length).toBeGreaterThan(1000);

      const br = await get(path, { "accept-encoding": "gzip, deflate, br, zstd" });
      expect(br.headers.get("content-encoding")).toBe("br");
      const brBytes = Buffer.from(await br.arrayBuffer());
      expect(brBytes.length).toBeLessThan(text.length / 2);
      expect(brotliDecompressSync(brBytes).toString()).toBe(text);

      for (const ae of ["gzip, br;q=0", "identity"]) {
        const res = await get(path, { "accept-encoding": ae });
        expect(res.headers.get("content-encoding"), ae).toBeNull();
        expect(await res.text(), ae).toBe(text);
      }
    }
  });

  it("answers an unknown or old bundle with a 404", async () => {
    const res = await get("/-/kumo/0000000.js", { "accept-encoding": "br" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
