import type { Env } from "../env.js";
import { Sha256 } from "../lib/sha256.js";
import { tailKey, type UploadRow } from "./store.js";

/**
 * Blob uploads stream into R2. Small blobs become one object; bigger ones become a
 * multipart upload with fixed-size parts (R2 wants every part but the last to be the
 * same size). Bytes that don't fill a part yet wait in a tail object until the next
 * chunk or the final PUT. The object key is the upload's, not the digest's: R2 can't
 * rename, so the blob index in D1 records where each digest's bytes are.
 */
export const PART_SIZE = 10 * 1024 * 1024;

export class UploadError extends Error {}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Appends a request body to an upload, hashing it on the way through. The hash's progress
 * is kept with the upload, so a chunked upload's last request doesn't read the whole blob
 * back to hash it (for a big layer that took longer than clients wait for a response).
 * Uploads started before the state was kept are hashed when they finish.
 */
export async function ingest(env: Env, u: UploadRow, body: ReadableStream<Uint8Array> | null, final: boolean, limit?: { bytes: number; error: () => Error }): Promise<UploadRow> {
  const bucket = env.BUCKET;
  const parts = JSON.parse(u.parts) as R2UploadedPart[];
  let mp = u.multipart_id ? bucket.resumeMultipartUpload(u.r2_key, u.multipart_id) : null;
  let buf = new Uint8Array(PART_SIZE);
  let fill = 0;

  // Bring back the bytes that are not in a finished part yet.
  const pending = mp ? u.tail : u.size;
  if (pending > 0) {
    const obj = await bucket.get(mp ? tailKey(u.id) : u.r2_key);
    if (!obj) throw new UploadError("the upload's data is missing; start the upload again");
    const bytes = new Uint8Array(await obj.arrayBuffer());
    buf.set(bytes);
    fill = bytes.length;
  }

  const hasher = u.size === 0 ? new Sha256() : u.hash_state ? Sha256.restore(u.hash_state) : null;
  let added = 0;
  const flush = async () => {
    mp ??= await bucket.createMultipartUpload(u.r2_key, { httpMetadata: { contentType: "application/octet-stream" } });
    parts.push(await mp.uploadPart(parts.length + 1, buf));
    buf = new Uint8Array(PART_SIZE);
    fill = 0;
  };

  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      added += value.length;
      // Counted as the bytes arrive: a chunked body declares no length to check up front.
      if (limit && u.size + added > limit.bytes) {
        // The upload can't finish, so none of it is kept: earlier chunks, parts this request
        // already sent and the multipart upload it may have started (the caller drops the row).
        await reader.cancel().catch(() => {});
        await discard(env, { ...u, multipart_id: mp?.uploadId ?? u.multipart_id });
        throw limit.error();
      }
      hasher?.update(value);
      for (let off = 0; off < value.length; ) {
        const n = Math.min(PART_SIZE - fill, value.length - off);
        buf.set(value.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === PART_SIZE) await flush();
      }
    }
  }
  const digest = final && hasher ? `sha256:${hasher.hex()}` : null;

  const hadTail = !!u.multipart_id && u.tail > 0;
  if (final) {
    if (mp) {
      if (fill > 0 || !parts.length) parts.push(await mp.uploadPart(parts.length + 1, buf.subarray(0, fill)));
      await mp.complete(parts);
      if (hadTail) await bucket.delete(tailKey(u.id));
    } else if (added > 0 || u.size === 0) {
      await bucket.put(u.r2_key, buf.subarray(0, fill), { httpMetadata: { contentType: "application/octet-stream" } });
    }
  } else if (mp) {
    if (fill > 0) await bucket.put(tailKey(u.id), buf.subarray(0, fill));
    else if (hadTail) await bucket.delete(tailKey(u.id));
  } else if (added > 0) {
    await bucket.put(u.r2_key, buf.subarray(0, fill));
  }
  // A small upload that grew into a multipart one: its first bytes went into part 1, so the
  // single object written by an earlier chunk is replaced when the multipart upload completes.
  return { ...u, multipart_id: mp?.uploadId ?? null, parts: JSON.stringify(parts), size: u.size + added, tail: mp && !final ? fill : 0, digest, hash_state: hasher && !final ? hasher.save() : null };
}

/** SHA-256 of a stored object, for uploads that arrived in several requests. */
export async function digestOf(env: Env, key: string): Promise<{ digest: string; size: number } | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const ds = new crypto.DigestStream("SHA-256");
  await obj.body.pipeTo(ds);
  return { digest: `sha256:${hex(await ds.digest)}`, size: obj.size };
}

/** Throws away an upload's bytes. */
export async function discard(env: Env, u: UploadRow): Promise<void> {
  if (u.multipart_id) await env.BUCKET.resumeMultipartUpload(u.r2_key, u.multipart_id).abort().catch(() => {});
  await env.BUCKET.delete([u.r2_key, tailKey(u.id)]);
}
