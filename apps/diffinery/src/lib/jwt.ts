import { b64url, fromB64url } from "./util.js";

interface Jwk extends JsonWebKey {
  kid?: string;
}

const certCache = new Map<string, { keys: Jwk[]; at: number }>();

/** Verify a Cloudflare Access JWT (RS256) and return its claims. */
export async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed JWT");
  const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as { kid?: string; alg?: string };
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  let cached = certCache.get(certsUrl);
  if (!cached || Date.now() - cached.at > 10 * 60_000 || !cached.keys.some((k) => k.kid === header.kid)) {
    const res = await fetch(certsUrl);
    if (!res.ok) throw new Error(`failed to fetch Access certs: ${res.status}`);
    cached = { keys: ((await res.json()) as { keys: Jwk[] }).keys, at: Date.now() };
    certCache.set(certsUrl, cached);
  }
  const jwk = cached.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("bad signature");
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(p))) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) throw new Error("token expired");
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error("audience mismatch");
  if (claims.iss !== `https://${teamDomain}`) throw new Error("issuer mismatch");
  return claims;
}

/** Sign an ES256 JWT with a private JWK (used for job OIDC tokens). */
export async function signEs256(privateJwk: Jwk, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "ES256", typ: "JWT", kid: privateJwk.kid ?? "diffinery-1" });
  const body = enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export function publicJwk(privateJwk: Jwk): Jwk {
  const { d: _d, key_ops: _ops, ...pub } = privateJwk;
  return { ...pub, use: "sig", alg: "ES256", kid: privateJwk.kid ?? "diffinery-1" };
}
