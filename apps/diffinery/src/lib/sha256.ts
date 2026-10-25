/**
 * SHA-256 whose progress can be saved between requests. WebCrypto's digest can't be resumed,
 * so a blob uploaded in several requests (the registry's chunked uploads) would otherwise be
 * read back whole to hash it when the last request arrives.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export class Sha256 {
  private h = new Uint32Array(INIT);
  private w = new Uint32Array(64);
  /** Bytes of an unfinished 64-byte block. */
  private block = new Uint8Array(64);
  private fill = 0;
  private length = 0;

  /** Continues from `save()`'s output. */
  static restore(saved: string): Sha256 {
    const s = JSON.parse(saved) as { h: number[]; n: number; b: string };
    if (!Array.isArray(s.h) || s.h.length !== 8 || !Number.isSafeInteger(s.n) || s.n < 0) throw new Error("invalid SHA-256 state");
    const x = new Sha256();
    x.h.set(s.h);
    x.length = s.n;
    const b = Uint8Array.from(atob(s.b), (ch) => ch.charCodeAt(0));
    if (b.length !== s.n % 64) throw new Error("invalid SHA-256 state");
    x.block.set(b);
    x.fill = b.length;
    return x;
  }

  save(): string {
    return JSON.stringify({ h: [...this.h], n: this.length, b: btoa(String.fromCharCode(...this.block.subarray(0, this.fill))) });
  }

  update(data: Uint8Array): this {
    this.length += data.length;
    let off = 0;
    if (this.fill) {
      const n = Math.min(64 - this.fill, data.length);
      this.block.set(data.subarray(0, n), this.fill);
      this.fill += n;
      off = n;
      if (this.fill < 64) return this;
      this.compress(this.block, 0);
      this.fill = 0;
    }
    for (; off + 64 <= data.length; off += 64) this.compress(data, off);
    if (off < data.length) {
      this.block.set(data.subarray(off), 0);
      this.fill = data.length - off;
    }
    return this;
  }

  /** The digest as lowercase hex. The object can't be updated afterwards. */
  hex(): string {
    const bits = this.length * 8;
    const pad = new Uint8Array((this.fill < 56 ? 56 : 120) - this.fill + 8);
    pad[0] = 0x80;
    const v = new DataView(pad.buffer);
    v.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    v.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    return [...this.h].map((x) => x.toString(16).padStart(8, "0")).join("");
  }

  private compress(p: Uint8Array, o: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++, o += 4) w[i] = (p[o]! << 24) | (p[o + 1]! << 16) | (p[o + 2]! << 8) | p[o + 3]!;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    const h = this.h;
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
}
