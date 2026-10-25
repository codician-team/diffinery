import { describe, expect, it } from "vitest";
import { cacheTtl, camoHeaders, camoKey, camoKeys, camoPath, checkImageUrl, fetchCamoImage, hmacSha256, imageProxy, MAX_CAMO_URL, verifyCamo } from "../../src/lib/camo.js";
import { renderMarkdown } from "../../src/web/markdown.js";
import { b64url } from "../../src/lib/util.js";

const env = { PUBLIC_URL: "https://diffinery.com", MASTER_KEY: "bWFzdGVyLWtleS1mb3ItdGVzdHMtb25seS0zMi1ieXRlcw==", ACCESS_AUD: "" };
const devEnv = { PUBLIC_URL: "http://127.0.0.1:8787", MASTER_KEY: undefined, ACCESS_AUD: "" };
const key = camoKey(env)!;

const imgSrcs = (html: string) => [...html.matchAll(/<img src="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
const render = (md: string, e: typeof env | undefined = env, base?: { owner: string; repo: string; ref: string; dir: string }) => renderMarkdown(md, { base, image: imageProxy(e) });

describe("camo signing", () => {
  it("matches WebCrypto's HMAC-SHA256, for short and long keys", async () => {
    for (const k of [new TextEncoder().encode("k"), key, new Uint8Array(200).fill(7)]) {
      const msg = new TextEncoder().encode("https://example.com/a.png?x=1");
      const ck = await crypto.subtle.importKey("raw", k as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const expected = new Uint8Array(await crypto.subtle.sign("HMAC", ck, msg as BufferSource));
      expect(hmacSha256(k, msg)).toEqual(expected);
    }
  });

  it("verifies its own paths and gives back the URL", () => {
    const url = "https://img.example.com/badge.svg?label=build&x=ü";
    const [, , , sig, enc] = camoPath(key, url).split("/");
    expect(camoPath(key, url).startsWith("/-/camo/")).toBe(true);
    expect(verifyCamo(key, sig!, enc!)).toBe(url);
  });

  it("keeps verifying paths signed with the previous key while MASTER_KEY rotates", () => {
    const url = "https://img.example.com/a.png";
    const [, , , oldSig, enc] = camoPath(key, url).split("/");
    const rotated = { ...env, MASTER_KEY: "bmV3LW1hc3Rlci1rZXktZm9yLXRlc3RzLW9ubHktMzI=", MASTER_KEY_PREV: env.MASTER_KEY };
    const keys = camoKeys(rotated);
    expect(keys).toHaveLength(2);
    // New paths are signed with the new key; old ones still verify.
    expect(camoKey(rotated)).toEqual(keys[0]);
    expect(camoPath(keys[0]!, url)).not.toBe(camoPath(key, url));
    expect(verifyCamo(keys, oldSig!, enc!)).toBe(url);
    const [, , , newSig] = camoPath(keys[0]!, url).split("/");
    expect(verifyCamo(keys, newSig!, enc!)).toBe(url);
    // Once MASTER_KEY_PREV is removed, the old signature is refused.
    expect(verifyCamo(camoKeys({ ...rotated, MASTER_KEY_PREV: undefined }), oldSig!, enc!)).toBeNull();
    // MASTER_KEY_PREV alone signs nothing.
    expect(camoKeys({ ...env, MASTER_KEY: undefined, MASTER_KEY_PREV: env.MASTER_KEY })).toHaveLength(0);
  });

  it("refuses unsigned, tampered, re-signed and malformed paths", () => {
    const [, , , sig, enc] = camoPath(key, "https://img.example.com/a.png").split("/");
    const other = b64url(new TextEncoder().encode("https://evil.example/a.png"));
    expect(verifyCamo(key, sig!, other)).toBeNull();
    expect(verifyCamo(key, `${sig!.slice(0, -1)}${sig!.endsWith("A") ? "B" : "A"}`, enc!)).toBeNull();
    expect(verifyCamo(key, "", enc!)).toBeNull();
    expect(verifyCamo(key, "x".repeat(43), enc!)).toBeNull();
    expect(verifyCamo(key, `${sig}=`, enc!)).toBeNull();
    expect(verifyCamo(key, sig!, `${enc}%2F`)).toBeNull();
    // A key from another MASTER_KEY, or the same secret under another label, doesn't verify.
    const otherKey = camoKey({ ...env, MASTER_KEY: "b3RoZXI=" })!;
    expect(verifyCamo(otherKey, sig!, enc!)).toBeNull();
    expect(verifyCamo(new TextEncoder().encode(`diffinery-unsubscribe-v1:${env.MASTER_KEY}`), sig!, enc!)).toBeNull();
  });

  it("has no key without MASTER_KEY, except in local development", () => {
    expect(camoKey({ ...env, MASTER_KEY: undefined })).toBeNull();
    expect(camoKey(devEnv)).not.toBeNull();
    expect(camoKey({ ...devEnv, ACCESS_AUD: "aud" })).toBeNull();
  });
});

describe("Markdown images", () => {
  it("sends images from other sites through the proxy and keeps the link target", () => {
    const html = render("[![build](https://ci.example.com/badge.svg?branch=main)](https://ci.example.com/run/1)");
    const [src] = imgSrcs(html);
    expect(src).toMatch(/^\/-\/camo\/[\w-]{43}\/[\w-]+$/);
    const [, , , sig, enc] = src!.split("/");
    expect(verifyCamo(key, sig!, enc!)).toBe("https://ci.example.com/badge.svg?branch=main");
    expect(html).toContain('href="https://ci.example.com/run/1"');
    expect(html).not.toContain('src="https://ci.example.com');
  });

  it("keeps same-origin and repository images as they are", () => {
    const html = render("![a](https://diffinery.com/acme/site/raw/main/logo.png) ![b](docs/shot.png) ![c](/static/x.png)", env, { owner: "acme", repo: "site", ref: "main", dir: "" });
    expect(imgSrcs(html)).toEqual(["https://diffinery.com/acme/site/raw/main/logo.png", "/acme/site/raw/main/docs/shot.png", "/acme/site/raw/main/static/x.png"]);
    expect(imgSrcs(render("![d](/static/x.png)"))).toEqual(["/static/x.png"]);
  });

  it("upgrades http images to https, as browsers do on an https page", () => {
    const [src] = imgSrcs(render("![x](http://img.example.com/a.png)"));
    const [, , , sig, enc] = src!.split("/");
    expect(verifyCamo(key, sig!, enc!)).toBe("https://img.example.com/a.png");
  });

  it("can't be talked past the proxy with whitespace, case or backslashes", () => {
    for (const u of ["HTTPS://img.example.com/a.png", " https://img.example.com/a.png", "https://img.example.com\t/a.png", "ht\ttps://img.example.com/a.png", "https://IMG.example.com./a.png"]) {
      const srcs = imgSrcs(render(`![x](<${u}>)`));
      expect(srcs, u).toHaveLength(1);
      expect(srcs[0]!.startsWith("/-/camo/"), u).toBe(true);
    }
    // Scheme-relative and backslash forms are dropped by the renderer before they get here.
    for (const u of ["//img.example.com/a.png", "https:\\\\img.example.com/a.png", "/\\img.example.com/a.png"]) expect(render(`![x](<${u}>)`), u).not.toContain("<img");
  });

  it("shows the alt text for images it won't proxy", () => {
    expect(render("![inside](https://10.0.0.1/a.png)")).not.toContain("<img");
    expect(render("![self](https://api.diffinery.com/a.png)")).not.toContain("<img");
    expect(render(`![long](https://img.example.com/${"a".repeat(MAX_CAMO_URL)}.png)`)).not.toContain("<img");
    // No settings to sign with (rendered outside a request): no third-party image at all.
    const html = renderMarkdown("![x](https://img.example.com/a.png) ![y](/acme/site/raw/main/a.png)", { image: imageProxy(undefined) });
    expect(imgSrcs(html)).toEqual(["/acme/site/raw/main/a.png"]);
    expect(html).toContain("x");
  });

  it("leaves renderMarkdown unchanged without the option (email and other callers)", () => {
    expect(imgSrcs(renderMarkdown("![x](https://img.example.com/a.png)"))).toEqual(["https://img.example.com/a.png"]);
  });
});

describe("camo fetch rules", () => {
  type Call = { url: string; init: RequestInit };
  function fake(responses: Array<Response | (() => Response)>) {
    const calls: Call[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error("no more responses");
      return typeof r === "function" ? r() : r;
    }) as typeof fetch;
    return { f, calls };
  }
  const png = (body: Uint8Array | string = "PNGDATA", headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "image/png", ...headers } });

  it("fetches an image with no cookies or credentials, only its own headers", async () => {
    const { f, calls } = fake([png("abc", { "cache-control": "max-age=600", etag: '"e1"' })]);
    const img = await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f });
    expect(img).not.toBeNull();
    expect(new TextDecoder().decode(img!.body)).toBe("abc");
    expect(img!.type).toBe("image/png");
    expect(img!.ttl).toBe(600);
    const h = new Headers(calls[0]!.init.headers);
    expect([...h.keys()].sort()).toEqual(["accept", "user-agent"]);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBeDefined();
  });

  it("refuses private, internal and Diffinery's own hosts, and plain http", async () => {
    for (const u of ["https://127.0.0.1/a.png", "https://10.1.2.3/a.png", "https://[::1]/a.png", "https://169.254.169.254/latest", "https://localhost/a.png", "https://db.internal/a.png", "https://diffinery.com/a.png", "https://x.diffinery.com/a.png", "http://img.example.com/a.png", "https://user:pw@img.example.com/a.png"]) {
      const { f, calls } = fake([png()]);
      expect(await fetchCamoImage(u, { env, fetch: f }), u).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("follows a few redirects, checking every hop", async () => {
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    let { f, calls } = fake([redirect("https://cdn.example.com/b.png"), redirect("/c.png"), png()]);
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f })).not.toBeNull();
    expect(calls.map((c) => c.url)).toEqual(["https://img.example.com/a.png", "https://cdn.example.com/b.png", "https://cdn.example.com/c.png"]);

    ({ f, calls } = fake([redirect("https://192.168.1.1/a.png"), png()]));
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f })).toBeNull();
    expect(calls).toHaveLength(1);

    ({ f, calls } = fake([redirect("http://img.example.com/a.png"), png()]));
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f })).toBeNull();

    ({ f, calls } = fake(Array.from({ length: 10 }, () => () => redirect("https://img.example.com/loop.png"))));
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f })).toBeNull();
    expect(calls).toHaveLength(5);
  });

  it("serves only image types it knows", async () => {
    for (const t of ["text/html", "application/javascript", "image/x-icon", "", "text/xml", "application/octet-stream"]) {
      const { f } = fake([new Response("<script>alert(1)</script>", { headers: t ? { "content-type": t } : {} })]);
      expect(await fetchCamoImage("https://img.example.com/a", { env, fetch: f }), t).toBeNull();
    }
    for (const [t, want] of [["image/svg+xml; charset=utf-8", "image/svg+xml"], ["IMAGE/JPEG", "image/jpeg"], ["image/jpg", "image/jpeg"], ["image/webp", "image/webp"], ["image/avif", "image/avif"], ["image/gif", "image/gif"]]) {
      const { f } = fake([new Response("x", { headers: { "content-type": t! } })]);
      expect((await fetchCamoImage("https://img.example.com/a", { env, fetch: f }))?.type).toBe(want);
    }
  });

  it("refuses error statuses and network failures", async () => {
    for (const r of [new Response("no", { status: 404, headers: { "content-type": "image/png" } }), new Response("x", { status: 206, headers: { "content-type": "image/png" } })]) {
      const { f } = fake([r]);
      expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f })).toBeNull();
    }
    const { f } = fake([]);
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f })).toBeNull();
  });

  it("caps the size while reading, whatever Content-Length says", async () => {
    const big = new Uint8Array(2048);
    let { f } = fake([png(big)]);
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f, maxBytes: 1024 })).toBeNull();
    // A stream with no length, or a lying one, is cut off once it passes the cap.
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(ctl) {
            pulled++;
            ctl.enqueue(new Uint8Array(512));
          },
        }),
        { headers: { "content-type": "image/png", "content-length": "10" } },
      );
    ({ f } = fake([endless]));
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f, maxBytes: 1024 })).toBeNull();
    expect(pulled).toBeLessThan(10);
    ({ f } = fake([png(new Uint8Array(1024))]));
    expect((await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f, maxBytes: 1024 }))?.body.byteLength).toBe(1024);
  });

  it("gives up after the timeout", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const t = Date.now();
    expect(await fetchCamoImage("https://img.example.com/a.png", { env, fetch: f, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("allows loopback and http only in local development, never the Worker itself", () => {
    expect(checkImageUrl("http://127.0.0.1:9999/a.png", devEnv)?.href).toBe("http://127.0.0.1:9999/a.png");
    expect(checkImageUrl("http://127.0.0.1:8787/a.png", devEnv)).toBeNull();
    expect(checkImageUrl("http://127.0.0.1:9999/a.png", env)).toBeNull();
  });

  it("caches within bounds and serves SVG so it can't run scripts", () => {
    expect(cacheTtl(null)).toBe(86400);
    expect(cacheTtl("max-age=10")).toBe(300);
    expect(cacheTtl("public, max-age=3600")).toBe(3600);
    expect(cacheTtl("max-age=99999999")).toBe(7 * 86400);
    expect(cacheTtl("no-cache")).toBe(300);
    const h = camoHeaders({ type: "image/svg+xml", ttl: 600, etag: null, lastModified: null, body: new Uint8Array(3) });
    expect(h.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("cache-control")).toBe("public, max-age=600");
    expect(h.get("content-length")).toBe("3");
    expect(h.has("set-cookie")).toBe(false);
  });
});
