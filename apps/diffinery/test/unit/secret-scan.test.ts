import { describe, expect, it, vi } from "vitest";
import { deflate } from "@diffinery/git-core";
import { scanForSecrets, secretBypassReason } from "../../src/git/secret-scan.js";

const blob = (text: string) => ({ oid: "a".repeat(40), content: new TextEncoder().encode(text) });

describe("push protection", () => {
  it("flags credentials, except in files that opt out", () => {
    // diffinery:allow-secret (this test file holds fake keys on purpose)
    expect(scanForSecrets([blob("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPL3")]).map((h) => h.kind)).toEqual(["AWS access key"]);
    expect(scanForSecrets([blob("key = AKIAIOSFODNN7EXAMPL3 # diffinery:allow-secret")])).toEqual([]);
  });

  it("records what an opted-out file holds", () => {
    const marked: { oid: string; kind: string }[] = [];
    expect(scanForSecrets([blob("key = AKIAIOSFODNN7EXAMPL3 # diffinery:allow-secret")], marked)).toEqual([]);
    expect(marked.map((h) => h.kind)).toEqual(["AWS access key"]);
  });

  it("flags Diffinery's job, sandbox and model tokens", () => {
    const repo = "0b1e5c4e-58a0-4f7c-9d39-0e2c6a1c3f00";
    const secret = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA";
    for (const t of [`djt_${repo}_17_${secret}`, `dst_${repo}_sb1_${secret}`, `dmt_${repo}_${secret}`]) {
      expect(scanForSecrets([blob(`TOKEN=${t}`)]).map((h) => h.kind), t).toEqual(["Diffinery job, sandbox or model token"]);
    }
    expect(scanForSecrets([blob("see dst_ and dmt_ prefixes in the docs")])).toEqual([]);
  });

  it("reads UTF-16 files, which have NUL bytes but are text", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPL3\n";
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) le[2 + i * 2] = text.charCodeAt(i);
    const be = new Uint8Array(le.length);
    be.set([0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) be[3 + i * 2] = text.charCodeAt(i);
    for (const content of [le, be]) expect(scanForSecrets([{ oid: "a".repeat(40), content }]).map((h) => h.kind)).toEqual(["AWS access key"]);
    // Other files with NUL bytes are binary and skipped.
    expect(scanForSecrets([{ oid: "b".repeat(40), content: new Uint8Array([0x41, 0, 0x41]) }])).toEqual([]);
  });

  it("scans large blobs from their compressed bytes, slice by slice, with the same rules", () => {
    // diffinery:allow-secret (fake keys)
    const filler = "x".repeat(256 * 1024 - 10);
    const big = (text: string) => {
      const content = new TextEncoder().encode(text);
      return { oid: "c".repeat(40), content: new Uint8Array(0), deflated: deflate(content) };
    };
    // A key that straddles two inflated slices is still found.
    expect(scanForSecrets([big(`${filler}\nAKIAIOSFODNN7EXAMPL3\n${filler}`)]).map((h) => h.kind)).toEqual(["AWS access key"]);
    expect(scanForSecrets([big(`${filler}${filler}${filler}`)])).toEqual([]);
    // The opt-out anywhere in the file moves its findings to the record.
    const marked: { oid: string; kind: string }[] = [];
    expect(scanForSecrets([big(`AKIAIOSFODNN7EXAMPL3 ${filler}${filler} diffinery:allow-secret`)], marked)).toEqual([]);
    expect(marked.map((h) => h.kind)).toEqual(["AWS access key"]);
    // A NUL byte anywhere makes it binary, as for a small blob.
    expect(scanForSecrets([big(`AKIAIOSFODNN7EXAMPL3 ${filler}${filler}\0`)])).toEqual([]);
    // UTF-16 with a byte order mark is text.
    const text = `${"y".repeat(300_000)}AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPL3\n`;
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) le[2 + i * 2] = text.charCodeAt(i);
    expect(scanForSecrets([{ oid: "d".repeat(40), content: new Uint8Array(0), deflated: deflate(le) }]).map((h) => h.kind)).toEqual(["AWS access key"]);
  });

  it("reads the bypass reason from push options", () => {
    expect(secretBypassReason([])).toBeNull();
    expect(secretBypassReason(["allow-secrets="])).toBeNull();
    expect(secretBypassReason(["allow-secrets=   "])).toBeNull();
    expect(secretBypassReason(["ci.skip", "allow-secrets= test fixture "])).toBe("test fixture");
    expect(secretBypassReason([`allow-secrets=${"x".repeat(300)}`])).toHaveLength(200);
  });

  it("scans a large file in slices, never as one string, with the same results", () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    // 3 MiB of text with a key across the 256 KiB slice boundary, and a "€" so it isn't ASCII.
    const filler = "€ line of a large generated file\n".repeat(100_000);
    const key = " AKIAIOSFODNN7EXAMPL3 "; // diffinery:allow-secret (a fake key; the scanned text doesn't carry the marker)
    const at = 256 * 1024 - 8;
    const text = new TextEncoder().encode(filler);
    const big = new Uint8Array(text.length + key.length);
    big.set(text.subarray(0, at));
    big.set(new TextEncoder().encode(key), at);
    big.set(text.subarray(at), at + key.length);
    expect(big.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(scanForSecrets([{ oid: "b".repeat(40), content: big }]).map((h) => h.kind)).toEqual(["AWS access key"]);
    for (const [input] of decode.mock.calls) if (input) expect((input as Uint8Array).byteLength).toBeLessThanOrEqual(256 * 1024);
    decode.mockRestore();
    // Opting out anywhere in it still counts, and a NUL byte still makes it binary.
    const marked: { oid: string; kind: string }[] = [];
    const optOut = new Uint8Array([...big, ...new TextEncoder().encode("\ndiffinery:allow-secret\n")]);
    expect(scanForSecrets([{ oid: "b".repeat(40), content: optOut }], marked)).toEqual([]);
    expect(marked.map((h) => h.kind)).toEqual(["AWS access key"]);
    const binary = big.slice();
    binary[2 * 1024 * 1024] = 0;
    expect(scanForSecrets([{ oid: "b".repeat(40), content: binary }])).toEqual([]);
  });
});
