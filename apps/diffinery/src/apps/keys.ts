import { b64, fromB64, fromB64url } from "../lib/util.js";

/**
 * An app's keys and the JSON Web Tokens it signs with them, as with GitHub Apps: RS256 JWTs whose
 * `iss` is the app's id (or client id), valid for at most 10 minutes. Diffinery generates a key and
 * hands out the private half once, as a PKCS#1 PEM file like GitHub's, or takes a public key the app's
 * developers made themselves. Only public keys are kept (SPKI, base64).
 */

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
/** How long an app's JWT may live, and how far its clock may be off, in seconds (GitHub's limits). */
export const JWT_MAX_LIFETIME = 600;
export const JWT_CLOCK_SKEW = 60;
export const MIN_MODULUS_BITS = 2048;

// ---------------------------------------------------------------- DER, just enough for RSA keys

/** One DER element at `at`: its tag, where its contents start and end. */
function der(bytes: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = bytes[at];
  let len = bytes[at + 1];
  if (tag === undefined || len === undefined) throw new Error("truncated key");
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error("bad key length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[start + i]!;
    start += n;
  }
  const end = start + len;
  if (end > bytes.length) throw new Error("truncated key");
  return { tag, start, end };
}

function encodeLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([new Uint8Array([tag, ...encodeLength(body.length)]), body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** AlgorithmIdentifier for rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters. */
const RSA_ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** PKCS#8 PrivateKeyInfo → the PKCS#1 RSAPrivateKey inside it. */
function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  const outer = der(pkcs8, 0);
  const version = der(pkcs8, outer.start);
  const algorithm = der(pkcs8, version.end);
  const key = der(pkcs8, algorithm.end);
  if (outer.tag !== 0x30 || version.tag !== 0x02 || algorithm.tag !== 0x30 || key.tag !== 0x04) throw new Error("not a PKCS#8 key");
  return pkcs8.slice(key.start, key.end);
}

/** PKCS#1 RSAPublicKey → SubjectPublicKeyInfo. */
function pkcs1PublicToSpki(pkcs1: Uint8Array): Uint8Array {
  return tlv(0x30, RSA_ALGORITHM, tlv(0x03, new Uint8Array([0]), pkcs1));
}

function pem(label: string, bytes: Uint8Array): string {
  const lines = b64(bytes).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** The DER inside a PEM block with `label`, or null when there is none. */
function unpem(text: string, label: string): Uint8Array | null {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(text);
  if (!m) return null;
  try {
    return fromB64(m[1]!.replace(/\s+/g, ""));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- keys

export interface AppKeyPair {
  /** The private key as a PKCS#1 PEM file ("BEGIN RSA PRIVATE KEY"), as GitHub hands it out. Shown once, never stored. */
  privateKeyPem: string;
  /** SubjectPublicKeyInfo, base64: what Diffinery keeps. */
  publicKey: string;
  fingerprint: string;
}

/** "SHA256:<base64>" of the SPKI DER, which `openssl rsa -pubout -outform DER | openssl sha256 -binary | base64` prints. */
export async function fingerprintOf(spki: Uint8Array): Promise<string> {
  return `SHA256:${b64(new Uint8Array(await crypto.subtle.digest("SHA-256", spki as BufferSource)))}`;
}

export async function generateAppKey(): Promise<AppKeyPair> {
  const pair = (await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
  const [pkcs8, spki] = await Promise.all([crypto.subtle.exportKey("pkcs8", pair.privateKey), crypto.subtle.exportKey("spki", pair.publicKey)]);
  const spkiBytes = new Uint8Array(spki as ArrayBuffer);
  return { privateKeyPem: pem("RSA PRIVATE KEY", pkcs8ToPkcs1(new Uint8Array(pkcs8 as ArrayBuffer))), publicKey: b64(spkiBytes), fingerprint: await fingerprintOf(spkiBytes) };
}

/**
 * A public key the app's developers made themselves: a "PUBLIC KEY" (SPKI) or "RSA PUBLIC KEY"
 * (PKCS#1) PEM block, RSA with a modulus of at least 2048 bits. Private keys are refused, so one is
 * never sent here by mistake and kept in a log.
 */
export async function parsePublicKey(text: string): Promise<{ publicKey: string; fingerprint: string }> {
  if (typeof text !== "string" || text.length > 8192) throw new KeyError("public_key must be a PEM-encoded RSA public key");
  if (/PRIVATE KEY-----/.test(text)) throw new KeyError("that's a private key: send only the public key (openssl rsa -in key.pem -pubout)");
  const spki = unpem(text, "PUBLIC KEY") ?? ((p) => (p ? pkcs1PublicToSpki(p) : null))(unpem(text, "RSA PUBLIC KEY"));
  if (!spki) throw new KeyError("public_key must be a PEM-encoded RSA public key (BEGIN PUBLIC KEY or BEGIN RSA PUBLIC KEY)");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", spki as BufferSource, RSA, true, ["verify"]);
  } catch {
    throw new KeyError("public_key is not a valid RSA public key");
  }
  const bits = (key.algorithm as { modulusLength?: number }).modulusLength;
  if (!bits || bits < MIN_MODULUS_BITS) throw new KeyError(`public_key must be at least ${MIN_MODULUS_BITS} bits`);
  return { publicKey: b64(spki), fingerprint: await fingerprintOf(spki) };
}

export class KeyError extends Error {}

// ---------------------------------------------------------------- JWTs

/** A credential that looks like a JWT (three base64url parts, a JSON header first). */
export const looksLikeJwt = (s: string): boolean => /^eyJ[\w-]*\.[\w-]*\.[\w-]+$/.test(s);

export interface JwtClaims {
  iss: string;
  iat: number;
  exp: number;
}

/** The header and claims, unverified, so the app (from `iss`) and its keys can be looked up. */
export function readJwt(token: string): { alg: string; claims: Record<string, unknown> } | null {
  const [h, p] = token.split(".");
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(h!))) as { alg?: unknown };
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(p!))) as unknown;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    return { alg: String(header.alg), claims: claims as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Checks an app's JWT against its public keys and GitHub's rules: RS256, `iat` no more than a minute
 * in the future, `exp` in the future and at most 10 minutes after `iat`. Returns the key that signed
 * it, or why it was refused (in GitHub's words where it has them).
 */
export async function verifyAppJwt(token: string, keys: Array<{ id: string; publicKey: string }>, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ keyId: string } | { error: string }> {
  const read = readJwt(token);
  if (!read) return { error: "A JSON web token could not be decoded" };
  if (read.alg !== "RS256") return { error: "'alg' must be RS256" };
  const { iat, exp } = read.claims;
  if (typeof iat !== "number" || typeof exp !== "number") return { error: "'iat' and 'exp' are required numeric claims" };
  if (iat > nowSeconds + JWT_CLOCK_SKEW) return { error: "'Issued at' claim ('iat') must be an Integer representing a time in the past." };
  if (exp <= nowSeconds) return { error: "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires." };
  if (exp - iat > JWT_MAX_LIFETIME + JWT_CLOCK_SKEW || exp > nowSeconds + JWT_MAX_LIFETIME + JWT_CLOCK_SKEW) return { error: "'Expiration time' claim ('exp') is too far in the future." };
  const [h, p, s] = token.split(".");
  const data = new TextEncoder().encode(`${h}.${p}`);
  let sig: Uint8Array;
  try {
    sig = fromB64url(s!);
  } catch {
    return { error: "A JSON web token could not be decoded" };
  }
  for (const k of keys) {
    try {
      const key = await crypto.subtle.importKey("spki", fromB64(k.publicKey) as BufferSource, RSA, false, ["verify"]);
      if (await crypto.subtle.verify(RSA.name, key, sig as BufferSource, data)) return { keyId: k.id };
    } catch {
      // A key that no longer imports can't have signed it.
    }
  }
  return { error: keys.length ? "A JSON web token could not be decoded" : "Integration must generate a public key" };
}
