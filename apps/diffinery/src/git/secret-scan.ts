import { fromUtf8, inflateEach } from "@diffinery/git-core";

/** High-confidence credential patterns. Push protection blocks pushes that add these. */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { kind: "Diffinery token", re: /\bdfy_[A-Za-z0-9_-]{32,}\b/ },
  // A workflow job's, an agent sandbox's or an agent task's model token: dxt_<repository>_..._<secret>.
  { kind: "Diffinery job, sandbox or model token", re: /\bd(?:jt|st|mt)_[A-Za-z0-9-]{8,64}_[A-Za-z0-9_-]{32,}/ },
  { kind: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Stripe live key", re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "OpenAI API key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}\b/ },
  { kind: "Private key", re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/ },
];

export interface SecretHit {
  oid: string;
  kind: string;
}

/** The text of a blob, or null for a binary one. UTF-16 text (with its byte order mark) is text too. */
function textOf(content: Uint8Array): string | null {
  if (content[0] === 0xff && content[1] === 0xfe) return new TextDecoder("utf-16le").decode(content);
  if (content[0] === 0xfe && content[1] === 0xff) return new TextDecoder("utf-16be").decode(content);
  if (content.includes(0)) return null;
  return fromUtf8(content);
}

/**
 * Credentials in `blobs` (file contents, and commit and tag objects, whose messages are scanned
 * too). A file marked `diffinery:allow-secret` is let through, but what it holds goes to `marked`
 * so the caller can put the opt-out on the audit record.
 */
export function scanForSecrets(blobs: Array<{ oid: string; content: Uint8Array; deflated?: Uint8Array }>, marked: SecretHit[] = []): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const b of blobs) {
    if (b.deflated) {
      scanDeflated(b.oid, b.deflated, hits, marked);
      continue;
    }
    // Decoded whole, a large file would be a string of up to twice its size: scanned in slices instead.
    if (b.content.length > SCAN_WHOLE_MAX) {
      const s = chunkScanner(b.oid);
      for (let at = 0; at < b.content.length; at += SCAN_SLICE) s.push(b.content.subarray(at, at + SCAN_SLICE));
      s.end(hits, marked);
      continue;
    }
    const text = textOf(b.content);
    if (text === null) continue;
    const out = /diffinery:allow-secret/.test(text) ? marked : hits;
    for (const p of PATTERNS) if (p.re.test(text)) out.push({ oid: b.oid, kind: p.kind });
  }
  return hits;
}

/** Carried from one slice of a large blob to the next, longer than any pattern can match. */
const OVERLAP = 1024;

/** Content larger than this is decoded and scanned a slice at a time. */
const SCAN_WHOLE_MAX = 1024 * 1024;
const SCAN_SLICE = 256 * 1024;

/**
 * `scanForSecrets` for a large blob kept compressed: it is inflated and decoded slice by slice, never
 * whole, with the same rules (binary when it has a NUL byte, unless it starts with a UTF-16 byte
 * order mark; `diffinery:allow-secret` anywhere moves its findings to `marked`).
 */
function scanDeflated(oid: string, deflated: Uint8Array, hits: SecretHit[], marked: SecretHit[]): void {
  const s = chunkScanner(oid);
  inflateEach(deflated, 0, s.push);
  s.end(hits, marked);
}

/** A large blob's content handed over in slices (a pushed pack read in ranges). */
export async function scanFeed(oid: string, feed: (onChunk: (chunk: Uint8Array) => void) => Promise<void>, hits: SecretHit[], marked: SecretHit[]): Promise<void> {
  const s = chunkScanner(oid);
  await feed(s.push);
  s.end(hits, marked);
}

/** The rules of `scanForSecrets`, for content that arrives in slices. */
function chunkScanner(oid: string): { push: (chunk: Uint8Array) => void; end: (hits: SecretHit[], marked: SecretHit[]) => void } {
  const found = new Set<string>();
  let decoder: TextDecoder | null = null;
  let utf8 = true;
  let binary = false;
  let allowed = false;
  let tail = "";
  const scan = (text: string) => {
    const window = tail + text;
    if (/diffinery:allow-secret/.test(window)) allowed = true;
    for (const p of PATTERNS) if (p.re.test(window)) found.add(p.kind);
    tail = window.slice(-OVERLAP);
  };
  return {
    push: (chunk) => {
      if (binary) return;
      if (!decoder) {
        const bom = chunk[0] === 0xff && chunk[1] === 0xfe ? "utf-16le" : chunk[0] === 0xfe && chunk[1] === 0xff ? "utf-16be" : null;
        utf8 = !bom;
        decoder = new TextDecoder(bom ?? "utf-8");
      }
      if (utf8 && chunk.includes(0)) binary = true;
      else scan(decoder.decode(chunk, { stream: true }));
    },
    end: (hits, marked) => {
      if (binary) return;
      if (decoder) scan(decoder.decode());
      const out = allowed ? marked : hits;
      for (const p of PATTERNS) if (found.has(p.kind)) out.push({ oid, kind: p.kind });
    },
  };
}

/** The reason given with `git push -o allow-secrets=<reason>`, if any. */
export function secretBypassReason(pushOptions: string[]): string | null {
  for (const o of pushOptions) {
    const m = /^allow-secrets=(.+)$/.exec(o.trim());
    if (m && m[1]!.trim()) return m[1]!.trim().slice(0, 200);
  }
  return null;
}
