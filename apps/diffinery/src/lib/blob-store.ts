import type { BlobRef } from "./runtime-auth.js";
import { STAGING_ROOT, runtimeObjectKey } from "./storage-keys.js";
import { b64url } from "./util.js";

/**
 * R2 layout for Actions cache entries and artifacts, and the upload protocol the
 * toolkit uses: Azure Blob "Put Block" + "Put Block List" (or one "Put Blob"),
 * and the legacy cache API's ranged PATCH chunks. Blocks and chunks are staged
 * as separate objects and, on commit, composed into one object, so downloads are
 * a single (rangeable) R2 read.
 *
 * Staged objects live under `actions-staging/`; an R2 lifecycle rule on that
 * prefix removes uploads that were never committed (lib/storage-keys.ts).
 */

export { STAGING_ROOT };

/** Smallest multipart part R2 accepts (except the last); R2 also wants every other part the same size. */
const MIN_PART = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MiB = 1024 * 1024;

/**
 * R2 reads (and writes) one composition step makes. A Worker invocation may make
 * 1000 subrequests and binding calls count, so a step stays well under that and
 * each step runs in an invocation of its own (a Durable Object call).
 */
export const STEP_OPS = 400;
/** Largest object a merge step writes (an intermediate). */
const MAX_MERGE_BYTES = 1024 * MiB;
/**
 * Largest final object written in one put. One step copies about 6-7 MB/s (a 192 MB artifact's
 * block list took 25-38 s on hosted runners), so anything larger goes up as multipart parts,
 * copied by several steps at once.
 */
const SINGLE_PUT_BYTES = 16 * MiB;
/** Bytes of parts one step copies, so a large object's parts spread over many steps. */
const STEP_BYTES = 16 * MiB;
/** Steps that run at once. */
const COMPOSE_CONCURRENCY = 8;

/** The limits a plan keeps to (smaller ones let tests exercise every path with little data). */
export type ComposeLimits = { stepOps: number; maxMergeBytes: number; singlePutBytes?: number; stepBytes?: number };
export const COMPOSE_LIMITS: ComposeLimits = { stepOps: STEP_OPS, maxMergeBytes: MAX_MERGE_BYTES, singlePutBytes: SINGLE_PUT_BYTES, stepBytes: STEP_BYTES };

export function finalKey(b: BlobRef): string {
  return runtimeObjectKey(b);
}

export function stagingPrefix(b: BlobRef): string {
  return `${STAGING_ROOT}${b.repo}/${b.kind}-${b.id}/`;
}

/** Staged object for an Azure block id (any string the client chose). */
export function blockKey(b: BlobRef, blockId: string): string {
  return `${stagingPrefix(b)}b-${b64url(new TextEncoder().encode(blockId))}`;
}

/** Staged object for a legacy cache chunk starting at `offset`. */
export function chunkKey(b: BlobRef, offset: number): string {
  return `${stagingPrefix(b)}o-${String(offset).padStart(16, "0")}`;
}

/** Block ids of a Put Block List body, in order. */
export function parseBlockList(xml: string): string[] {
  const ids: string[] = [];
  const re = /<(Latest|Committed|Uncommitted)>([^<]*)<\/\1>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) ids.push(decodeXml(m[2]!.trim()));
  return ids;
}

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e]!);
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n`, clamped to `size`. */
export function parseRange(header: string | null | undefined, size: number): { offset: number; length: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

type Body = ReadableStream | ArrayBuffer | ArrayBufferView;
type Meta = { httpMetadata?: { contentType?: string } };
export interface MultipartHandle {
  uploadId: string;
  uploadPart(partNumber: number, value: Body): Promise<{ partNumber: number; etag: string }>;
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
  abort(): Promise<void>;
}

/** The subset of R2Bucket used here (lets tests use an in-memory bucket). */
export interface BlobBucket {
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{ body: ReadableStream; size: number } | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  put(key: string, value: Body, options?: Meta): Promise<{ size: number; etag: string } | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string; size: number }>; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
  createMultipartUpload(key: string, options?: Meta): Promise<MultipartHandle>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartHandle;
}

export async function listStaged(bucket: BlobBucket, b: BlobRef): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: stagingPrefix(b), cursor });
    for (const o of page.objects) out.set(o.key, o.size);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export async function deleteKeys(bucket: BlobBucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/** Removes what an upload staged (the first `pages` listing pages; the lifecycle rule gets the rest). */
export async function dropStaged(bucket: BlobBucket, b: BlobRef, pages = 1): Promise<void> {
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await bucket.list({ prefix: stagingPrefix(b), cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
    cursor = page.cursor;
  }
}

/** A stream R2 accepts as a body: one with a known length (FixedLengthStream also enforces it). */
export function sized(body: ReadableStream, size: number): ReadableStream {
  const F = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  if (!F) return body;
  const t = new F(size);
  void body.pipeTo(t.writable).catch(() => {});
  return t.readable;
}

export class BodyTooLarge extends Error {}

/**
 * Stores a request body of unknown length without buffering all of it: up to
 * one part in memory, then an R2 multipart upload. Fails with BodyTooLarge (and
 * stores nothing) once more than `max` bytes arrive.
 */
export async function putStream(bucket: BlobBucket, key: string, body: ReadableStream, max: number, options?: Meta, partSize = 8 * MiB): Promise<number> {
  const reader = body.getReader();
  let buf = new Uint8Array(Math.min(partSize, Math.max(max, 0) + 1));
  let fill = 0;
  let total = 0;
  let upload: MultipartHandle | null = null;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value as Uint8Array;
      total += chunk.length;
      if (total > max) throw new BodyTooLarge(`the body is larger than ${max} bytes`);
      while (chunk.length) {
        if (fill === buf.length) {
          upload ??= await bucket.createMultipartUpload(key, options);
          parts.push(await upload.uploadPart(parts.length + 1, buf));
          buf = new Uint8Array(partSize);
          fill = 0;
        }
        const n = Math.min(chunk.length, buf.length - fill);
        buf.set(chunk.subarray(0, n), fill);
        fill += n;
        chunk = chunk.subarray(n);
      }
    }
    if (!upload) {
      await bucket.put(key, buf.slice(0, fill), options);
      return total;
    }
    if (fill) parts.push(await upload.uploadPart(parts.length + 1, buf.slice(0, fill)));
    await upload.complete(parts);
    return total;
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (upload) await upload.abort().catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------- composing staged blocks

/** A byte range of a staged object. */
export type Slice = { key: string; offset: number; length: number; whole: boolean };

/**
 * One unit of work, small enough for one invocation:
 * - `merge`: concatenate slices into one object (an intermediate, or the final object);
 * - `parts`: upload multipart parts of the final object, each the concatenation of its slices.
 */
export type ComposeStep = { kind: "merge"; target: string; slices: Slice[]; length: number } | { kind: "parts"; key: string; uploadId: string; parts: Array<{ partNumber: number; slices: Slice[]; length: number }> };

type Seg = { key: string; size: number };

/** Cuts `segs` (concatenated) into consecutive ranges of `size` bytes (the last may be shorter). */
function cut(segs: Seg[], size: number): Slice[][] {
  const out: Slice[][] = [];
  let cur: Slice[] = [];
  let room = size;
  for (const s of segs) {
    let off = 0;
    while (off < s.size) {
      const n = Math.min(room, s.size - off);
      cur.push({ key: s.key, offset: off, length: n, whole: off === 0 && n === s.size });
      off += n;
      room -= n;
      if (room === 0) {
        out.push(cur);
        cur = [];
        room = size;
      }
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const sliceBytes = (sl: Slice[]) => sl.reduce((n, s) => n + s.length, 0);

/**
 * Plans writing the concatenation of `segments` to `key` as steps that each make
 * at most {@link STEP_OPS} R2 calls. Many small blocks (Go SDK uploads, up to
 * Azure's 50,000) are first merged into larger intermediates under `scratch`,
 * in as many rounds as needed; then the final object is written in one step, or
 * as multipart parts of equal size in batches.
 */
export function planCompose(segments: Seg[], scratch: string, limits: ComposeLimits = COMPOSE_LIMITS): { rounds: Array<Extract<ComposeStep, { kind: "merge" }>[]>; total: number; partSize: number; segs: Seg[]; parts: Slice[][]; single: boolean; intermediates: string[] } {
  const total = segments.reduce((n, s) => n + s.size, 0);
  const partSize = Math.max(8 * MiB, Math.ceil(total / (MAX_PARTS - 1) / MiB) * MiB);
  const rounds: Array<Extract<ComposeStep, { kind: "merge" }>[]> = [];
  const intermediates: string[] = [];
  let segs = segments.filter((s) => s.size > 0);
  const { stepOps, maxMergeBytes } = limits;
  const fitsOneStep = () => segs.length <= stepOps - 1 && total <= Math.min(maxMergeBytes, limits.singlePutBytes ?? maxMergeBytes);
  const partsFit = () => cut(segs, partSize).every((p) => p.length <= stepOps - 1);
  // Merged segments may reach a part's size, so that a part never needs more slices than a step allows.
  const mergeCap = Math.max(maxMergeBytes, partSize);
  while (!fitsOneStep() && !partsFit()) {
    // Merge runs of consecutive small segments; segments already big enough stay as they are.
    const round: Extract<ComposeStep, { kind: "merge" }>[] = [];
    const next: Seg[] = [];
    let group: Seg[] = [];
    let bytes = 0;
    const flush = () => {
      if (group.length === 1) next.push(group[0]!);
      else if (group.length > 1) {
        const target = `${scratch}m${rounds.length}-${round.length}`;
        round.push({ kind: "merge", target, slices: group.map((s) => ({ key: s.key, offset: 0, length: s.size, whole: true })), length: bytes });
        intermediates.push(target);
        next.push({ key: target, size: bytes });
      }
      group = [];
      bytes = 0;
    };
    for (const s of segs) {
      if (group.length && (group.length >= stepOps - 1 || bytes + s.size > mergeCap)) flush();
      group.push(s);
      bytes += s.size;
    }
    flush();
    if (!round.length) break;
    rounds.push(round);
    segs = next;
  }
  if (fitsOneStep()) return { rounds, total, partSize, segs, parts: [], single: true, intermediates };
  return { rounds, total, partSize, segs, parts: cut(segs, partSize), single: false, intermediates };
}

/** Groups consecutive parts into steps of at most {@link STEP_OPS} calls and about `stepBytes` bytes. */
export function batchParts(parts: Slice[][], stepOps = STEP_OPS, stepBytes = Infinity): Array<Array<{ partNumber: number; slices: Slice[]; length: number }>> {
  const out: Array<Array<{ partNumber: number; slices: Slice[]; length: number }>> = [];
  let cur: Array<{ partNumber: number; slices: Slice[]; length: number }> = [];
  let ops = 0;
  let bytes = 0;
  parts.forEach((slices, i) => {
    const cost = slices.length + 1;
    const length = sliceBytes(slices);
    if (cur.length && (ops + cost > stepOps || bytes + length > stepBytes)) {
      out.push(cur);
      cur = [];
      ops = 0;
      bytes = 0;
    }
    cur.push({ partNumber: i + 1, slices, length });
    ops += cost;
    bytes += length;
  });
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The concatenation of `slices` (`length` bytes), read one after another. Each slice's R2 body is
 * piped into one fixed-length stream, which the runtime does natively: a JavaScript loop over the
 * chunks kept a Durable Object's CPU busy, so eight steps at once ran little faster than one, and
 * the Durable Object answered some of them with errors when it was overloaded.
 */
function concat(bucket: BlobBucket, slices: Slice[], length: number): ReadableStream {
  const F = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  const t: TransformStream = F ? new F(length) : new TransformStream();
  void (async () => {
    try {
      for (const s of slices) {
        const o = await bucket.get(s.key, s.whole ? undefined : { range: { offset: s.offset, length: s.length } });
        if (!o) throw new Error(`staged block ${s.key} is missing`);
        await o.body.pipeTo(t.writable, { preventClose: true });
      }
      await t.writable.close();
    } catch (e) {
      await t.writable.abort(e).catch(() => {});
    }
  })();
  return t.readable;
}

/** Runs one step against the bucket. Returns the parts it uploaded. */
export async function runComposeStep(bucket: BlobBucket, step: ComposeStep, contentType?: string): Promise<Array<{ partNumber: number; etag: string }>> {
  if (step.kind === "merge") {
    await bucket.put(step.target, concat(bucket, step.slices, step.length), contentType ? { httpMetadata: { contentType } } : undefined);
    return [];
  }
  const upload = bucket.resumeMultipartUpload(step.key, step.uploadId);
  const out: Array<{ partNumber: number; etag: string }> = [];
  for (const p of step.parts) out.push(await upload.uploadPart(p.partNumber, concat(bucket, p.slices, p.length)));
  return out;
}

/** Every key a step reads or writes. */
export function stepKeys(step: ComposeStep): string[] {
  return step.kind === "merge" ? [step.target, ...step.slices.map((s) => s.key)] : [step.key, ...step.parts.flatMap((p) => p.slices.map((s) => s.key))];
}

/**
 * Writes the concatenation of `segments` (staged objects, in order) to `key`,
 * running each step through `run` (a Durable Object call in production, so every
 * step gets an invocation, and its subrequests, of its own). Intermediates are
 * written under `scratch` and removed afterwards.
 */
export async function compose(
  bucket: BlobBucket,
  key: string,
  segments: Seg[],
  contentType: string,
  o: { scratch: string; run?: (step: ComposeStep) => Promise<Array<{ partNumber: number; etag: string }>>; concurrency?: number; limits?: ComposeLimits },
): Promise<number> {
  const run = o.run ?? ((step: ComposeStep) => runComposeStep(bucket, step, contentType));
  const httpMetadata = { contentType };
  const limits = o.limits ?? COMPOSE_LIMITS;
  const plan = planCompose(segments, o.scratch, limits);
  const pool = async <T>(items: T[], f: (t: T) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(o.concurrency ?? COMPOSE_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await f(items[next++]!);
    }));
  };
  try {
    for (const round of plan.rounds) await pool(round, async (s) => void (await run(s)));
    if (plan.total === 0) {
      await bucket.put(key, new Uint8Array(0), { httpMetadata });
      return 0;
    }
    if (plan.single) {
      await run({ kind: "merge", target: key, slices: plan.segs.map((s) => ({ key: s.key, offset: 0, length: s.size, whole: true })), length: plan.total });
      return plan.total;
    }
    const upload = await bucket.createMultipartUpload(key, { httpMetadata });
    try {
      const etags: Array<{ partNumber: number; etag: string }> = [];
      await pool(batchParts(plan.parts, limits.stepOps, limits.stepBytes), async (parts) => void etags.push(...(await run({ kind: "parts", key, uploadId: upload.uploadId, parts }))));
      etags.sort((a, b) => a.partNumber - b.partNumber);
      await upload.complete(etags);
    } catch (e) {
      await upload.abort().catch(() => {});
      throw e;
    }
    return plan.total;
  } finally {
    if (plan.intermediates.length) await deleteKeys(bucket, plan.intermediates).catch(() => {});
  }
}

/** Minimum multipart part size, exported for tests. */
export const MIN_PART_SIZE = MIN_PART;
