import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { finalKey, runComposeStep, stagingPrefix, stepKeys, type BlobBucket, type ComposeStep } from "./lib/blob-store.js";
import type { BlobRef } from "./lib/runtime-auth.js";

/**
 * Runs one step of joining an upload's blocks (lib/blob-store.ts `compose`): each step in an object
 * of its own (a fresh id), so the steps of a large artifact or cache really run at once and the
 * copying doesn't load the repository's object, which serves the rest of its traffic. Ran in RepoDO
 * before: eight steps at once made its other calls up to ten times slower while a 200 MiB upload
 * was joined. Only the Worker calls it, after checking the upload may still be written.
 */
export class ComposeDO extends DurableObject<Env> {
  async step(b: BlobRef, step: ComposeStep, contentType?: string): Promise<Array<{ partNumber: number; etag: string }>> {
    if (!stepKeys(step).every((k) => k === finalKey(b) || k.startsWith(stagingPrefix(b)))) throw new Error("the step names objects outside this upload");
    return runComposeStep(this.env.BUCKET as unknown as BlobBucket, step, contentType);
  }
}
