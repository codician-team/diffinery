import { createHash } from "node:crypto";
import { toHex } from "./bytes.js";

/** SHA-1 using WebCrypto (available in Workers and Node 20+). */
export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-1", data as BufferSource);
  return new Uint8Array(digest);
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha1(data));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));
}

/**
 * Incremental SHA-1, for checksums over data that is never held whole (a pack streamed to a client).
 * WebCrypto only hashes a complete buffer, so this is node:crypto's (native in Workers with
 * nodejs_compat): a clone hashes its whole pack, and a hash in JavaScript was over a third of the time.
 */
export class Sha1 {
  private h = createHash("sha1");

  update(data: Uint8Array): this {
    this.h.update(data);
    return this;
  }

  digest(): Uint8Array {
    const d = this.h.digest();
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  }
}
