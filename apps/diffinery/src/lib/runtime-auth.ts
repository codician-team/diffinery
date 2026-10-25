import { masterKeys, matchesAnyKey, type MasterKeyEnv } from "./crypto.js";
import { b64url, fromB64, fromB64url } from "./util.js";

/**
 * Credentials for GitHub's Actions runtime services (cache, artifacts) as the
 * official toolkit expects them:
 *
 * - `ACTIONS_RUNTIME_TOKEN` is a JWT. `@actions/artifact` reads the run and job
 *   backend ids from its `scp` claim, and buildkit's gha cache reads `ac`, `exp`
 *   and `nbf`. We sign it with HMAC-SHA256 under a key derived from MASTER_KEY,
 *   scoped to one job of one repository, and it expires with the job.
 *   While MASTER_KEY is being rotated, tokens and URLs signed under
 *   MASTER_KEY_PREV still verify; new ones are signed under MASTER_KEY.
 * - Blob URLs (where the toolkit PUTs and GETs archives with the Azure SDK or
 *   plain HTTP) are signed the same way, Azure SAS style: `se` (expiry) and
 *   `sp` (r or w) plus `sig`.
 */

export interface RuntimeClaims {
  /** Repository id (routes the request to its Durable Object). */
  repo: string;
  run: string;
  job: string;
  /** Unix seconds. */
  exp: number;
}

const keys = new Map<string, Promise<CryptoKey>>();

function runtimeKey(masterKey: string): Promise<CryptoKey> {
  let k = keys.get(masterKey);
  if (!k) {
    k = (async () => {
      const raw = await crypto.subtle.importKey("raw", fromB64(masterKey) as BufferSource, "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("diffinery-actions-runtime-v1"), info: new TextEncoder().encode("hmac") },
        raw,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
    keys.set(masterKey, k);
  }
  return k;
}

/** The configured master keys, current first; throws without MASTER_KEY. */
function keysOf(env: MasterKeyEnv): string[] {
  const all = masterKeys(env);
  if (!all.length) throw new Error("MASTER_KEY is not configured");
  return all;
}

async function hmac(masterKey: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await runtimeKey(masterKey), new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/**
 * Mints the job's ACTIONS_RUNTIME_TOKEN. `cacheScopes` are the refs whose caches
 * the job may read (the first one is also writable), in GitHub's `ac` format.
 */
export async function signRuntimeToken(env: MasterKeyEnv, issuer: string, c: RuntimeClaims, cacheScopes: string[]): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  const ac = cacheScopes.map((s, i) => ({ Scope: s, Permission: i === 0 ? 3 : 1 }));
  const payload = {
    iss: issuer,
    aud: "diffinery-actions-runtime",
    nbf: nowS - 60,
    iat: nowS,
    exp: c.exp,
    scp: `Actions.GenericRead:${c.run} Actions.Results:${c.run}:${c.job} Actions.UploadArtifacts:${c.run}:${c.job}`,
    ac: JSON.stringify(ac),
    repo: c.repo,
    run: c.run,
    job: c.job,
  };
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(payload);
  return `${head}.${body}.${await hmac(keysOf(env)[0]!, `${head}.${body}`)}`;
}

/** Verifies a runtime token; returns its claims, or null when it is invalid or expired. */
export async function verifyRuntimeToken(env: MasterKeyEnv, token: string): Promise<RuntimeClaims | null> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  try {
    if (!(await matchesAnyKey(keysOf(env), s, (k) => hmac(k, `${h}.${p}`)))) return null;
  } catch {
    return null;
  }
  try {
    const head = JSON.parse(new TextDecoder().decode(fromB64url(h))) as { alg?: string };
    if (head.alg !== "HS256") return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(p))) as Partial<RuntimeClaims>;
    if (typeof c.repo !== "string" || typeof c.run !== "string" || typeof c.job !== "string" || typeof c.exp !== "number") return null;
    if (c.exp < Math.floor(Date.now() / 1000)) return null;
    return { repo: c.repo, run: c.run, job: c.job, exp: c.exp };
  } catch {
    return null;
  }
}

export type BlobKind = "cache" | "artifact";

export interface BlobRef {
  repo: string;
  kind: BlobKind;
  id: number;
}

const blobPayload = (b: BlobRef, perm: "r" | "w", exp: number) => `blob|${b.repo}|${b.kind}|${b.id}|${perm}|${exp}`;

/** A signed URL for reading (`r`) or writing (`w`) a cache entry's or artifact's content. */
export async function signBlobUrl(env: MasterKeyEnv, origin: string, b: BlobRef, perm: "r" | "w", exp: number, fileName?: string): Promise<string> {
  const sig = await hmac(keysOf(env)[0]!, blobPayload(b, perm, exp));
  // A trailing file name lets clients that look at the URL path (e.g. `.zip`) see the type.
  const tail = fileName ? `/${encodeURIComponent(fileName)}` : "";
  return `${origin}/_runtime/blob/${b.repo}/${b.kind}/${b.id}${tail}?sv=2025-01-05&se=${exp}&sp=${perm}&sig=${sig}`;
}

/** Checks a blob URL's signature and expiry for the wanted permission. */
export async function verifyBlobUrl(env: MasterKeyEnv, b: BlobRef, perm: "r" | "w", q: URLSearchParams): Promise<boolean> {
  const exp = Number(q.get("se"));
  const sig = q.get("sig") ?? "";
  if (q.get("sp") !== perm || !Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  try {
    return await matchesAnyKey(keysOf(env), sig, (k) => hmac(k, blobPayload(b, perm, exp)));
  } catch {
    return false;
  }
}
