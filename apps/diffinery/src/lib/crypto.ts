import { b64, fromB64, safeEqual } from "./util.js";

/**
 * Everything Diffinery encrypts or signs with its own key starts from MASTER_KEY. To rotate it, an
 * operator moves the old value to MASTER_KEY_PREV and sets a new MASTER_KEY: from then on, new
 * ciphertexts and signatures use MASTER_KEY, and what was made with the old key still decrypts or
 * verifies until MASTER_KEY_PREV is removed (docs/self-hosting/configuration.md, "Rotating MASTER_KEY").
 */
export interface MasterKeyEnv {
  /** Secret: base64 32 bytes; the current root key. */
  MASTER_KEY?: string;
  /** Secret: the root key MASTER_KEY replaced, still accepted while a rotation is under way. */
  MASTER_KEY_PREV?: string;
}

/**
 * The configured master keys, the current one first and then the previous one while a rotation is
 * under way. Empty without MASTER_KEY: MASTER_KEY_PREV alone never makes a key current.
 */
export function masterKeys(env: MasterKeyEnv): string[] {
  const current = env.MASTER_KEY;
  if (!current) return [];
  const prev = env.MASTER_KEY_PREV;
  return prev && prev !== current ? [current, prev] : [current];
}

/**
 * The secrets a signer derives its key from: the master keys, or `devFallback` when no MASTER_KEY is
 * set (local development only; callers pass null outside it, and then this throws `missing`).
 */
export function signingSecrets(env: MasterKeyEnv, devFallback: string | null, missing: string): string[] {
  const keys = masterKeys(env);
  if (keys.length) return keys;
  if (devFallback !== null) return [devFallback];
  throw new Error(missing);
}

/**
 * Whether `tag` is what `mac` computes under any of `secrets`. New tags are always made with the
 * first (current) secret; this is the matching check that also takes a tag made with the previous
 * one. An error computing the current tag propagates as before rotation existed; one under the
 * previous secret (say a MASTER_KEY_PREV that isn't valid base64) only means "no match".
 */
export async function matchesAnyKey(secrets: readonly string[], tag: string, mac: (secret: string) => Promise<string>): Promise<boolean> {
  for (const [i, s] of secrets.entries()) {
    let expected: string;
    try {
      expected = await mac(s);
    } catch (e) {
      if (i === 0) throw e;
      continue;
    }
    if (safeEqual(expected, tag)) return true;
  }
  return false;
}

/** HMAC-SHA256 of `data` under the UTF-8 bytes of `secret`. */
export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

// ---------------------------------------------------------------- envelope encryption

/**
 * Envelope encryption for secrets. Each scope (repo or org) gets its own AES-GCM
 * key derived from MASTER_KEY with HKDF, so a leaked ciphertext from one repo
 * cannot be replayed into another.
 *
 * Envelopes:
 * - `v2.<kid>.<iv>.<ct>`, written now. `kid` names the master key that sealed it: the first 8 hex
 *   characters of SHA-256 over the key's raw (base64-decoded) bytes, which an operator can compute with
 *   `printf %s "$KEY" | base64 -d | sha256sum | cut -c1-8`. It identifies the key, it isn't secret,
 *   and it says nothing useful about a 256-bit random key.
 * - `v1.<iv>.<ct>`, written before keys could be rotated; it says nothing about its key, so both
 *   configured keys are tried.
 * The AES-GCM key, IV size and additional data (the scope) are the same in both, so a v1 envelope's
 * ciphertext is exactly what v2 would carry.
 */
async function scopeKey(masterKeyB64: string, scope: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", fromB64(masterKeyB64) as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("diffinery-secrets-v1"), info: new TextEncoder().encode(scope) },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const kids = new Map<string, Promise<string>>();

/** The key id that v2 envelopes sealed with this master key carry. */
export function keyId(masterKeyB64: string): Promise<string> {
  let id = kids.get(masterKeyB64);
  if (!id) {
    id = (async () => {
      const d = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(masterKeyB64) as BufferSource));
      return [...d.slice(0, 4)].map((x) => x.toString(16).padStart(2, "0")).join("");
    })();
    // A key that isn't base64 rejects; don't keep that around.
    id.catch(() => kids.delete(masterKeyB64));
    kids.set(masterKeyB64, id);
  }
  return id;
}

export async function encryptSecret(env: MasterKeyEnv, scope: string, plaintext: string): Promise<string> {
  const [masterKey] = masterKeys(env);
  if (!masterKey) throw new Error("MASTER_KEY is not configured");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await scopeKey(masterKey, scope);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(scope) }, key, new TextEncoder().encode(plaintext)));
  return `v2.${await keyId(masterKey)}.${b64(iv)}.${b64(ct)}`;
}

export interface OpenedSecret {
  plaintext: string;
  /** Sealed with the current MASTER_KEY in the current format; false means it is worth sealing again. */
  current: boolean;
}

/** Decrypts an envelope with whichever configured master key sealed it, and says whether it is current. */
export async function openSecret(env: MasterKeyEnv, scope: string, envelope: string): Promise<OpenedSecret> {
  const keys = masterKeys(env);
  if (!keys.length) throw new Error("MASTER_KEY is not configured");
  const parts = envelope.split(".");
  const v1 = parts[0] === "v1" && parts.length === 3;
  const v2 = parts[0] === "v2" && parts.length === 4 && /^[0-9a-f]{8}$/.test(parts[1]!);
  const kid = v2 ? parts[1]! : null;
  const [ivB, ctB] = v2 ? parts.slice(2) : parts.slice(1);
  if ((!v1 && !v2) || !ivB || !ctB) throw new Error("bad secret envelope");
  // The key the kid names first; the others after it, in case two keys ever share a kid.
  const ids = await Promise.all(keys.map((k) => keyId(k).catch(() => null)));
  const order = kid === null ? keys.map((_, i) => i) : [...keys.keys()].sort((a, b) => Number(ids[b] === kid) - Number(ids[a] === kid));
  const iv = fromB64(ivB);
  const ct = fromB64(ctB);
  let failure: unknown = null;
  for (const i of order) {
    try {
      const key = await scopeKey(keys[i]!, scope);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: new TextEncoder().encode(scope) }, key, ct as BufferSource);
      return { plaintext: new TextDecoder().decode(pt), current: i === 0 && kid !== null && kid === ids[0] };
    } catch (e) {
      failure ??= e;
    }
  }
  throw new Error(`the secret doesn't decrypt with ${keys.length > 1 ? "MASTER_KEY or MASTER_KEY_PREV" : "MASTER_KEY"}`, { cause: failure });
}

export async function decryptSecret(env: MasterKeyEnv, scope: string, envelope: string): Promise<string> {
  return (await openSecret(env, scope, envelope)).plaintext;
}

/**
 * Decrypts a stored secret for use and, when it was sealed with the previous key or as v1, stores it
 * again sealed with the current MASTER_KEY through `store`, so secrets in use move to the current key
 * by themselves during a rotation. `store` must only replace the row while it still holds `envelope`
 * (compare and set), so a value saved meanwhile is never overwritten. A failed store is logged and
 * otherwise ignored: using the secret never depends on it.
 */
export async function decryptAndReseal(env: MasterKeyEnv, scope: string, envelope: string, store: (sealed: string) => unknown): Promise<string> {
  const s = await openSecret(env, scope, envelope);
  if (!s.current) {
    try {
      await store(await encryptSecret(env, scope, s.plaintext));
    } catch (e) {
      console.error("re-encrypting a secret with the current MASTER_KEY failed", scope, (e as Error).message);
    }
  }
  return s.plaintext;
}

/**
 * The envelope to store in place of `envelope` when a row is written anyway: the same secret sealed
 * with the current MASTER_KEY when it was sealed with the previous key or as v1, otherwise `envelope`
 * itself. One that doesn't decrypt is kept as it is, so writing a row never loses what it held.
 */
export async function resealSecret(env: MasterKeyEnv, scope: string, envelope: string): Promise<string> {
  try {
    const s = await openSecret(env, scope, envelope);
    return s.current ? envelope : await encryptSecret(env, scope, s.plaintext);
  } catch {
    return envelope;
  }
}
