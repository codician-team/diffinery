import { BodyTooLarge, putStream, type BlobBucket } from "./blob-store.js";
import { ACTION_MIRROR_ROOT } from "./storage-keys.js";

/**
 * Diffinery's own copies of the GitHub actions jobs use (`uses: owner/repo@ref`), so a job keeps
 * working while GitHub is down. Runners still download actions from GitHub first, exactly as
 * before; after a download they tell Diffinery which action they used, and Diffinery fetches the
 * same archive from codeload.github.com itself and stores it in R2. Only when GitHub fails does a
 * runner ask for the stored copy.
 *
 * Runners never upload a copy: what is stored always came straight from GitHub, so a job cannot
 * plant an action that other repositories would then run. Copies are shared by every repository,
 * like the public actions they hold. Only public actions are stored (the fetch has no GitHub
 * credentials).
 *
 * A tag or branch can move, so its copy is fetched again once it is a day old; a commit SHA can't,
 * so its copy only needs a fetch every week, which also keeps it clear of the 30-day lifecycle rule
 * on the prefix (scripts/bootstrap.sh) while jobs use it.
 */

/** Largest archive stored (bigger actions keep depending on GitHub alone). */
export const MIRROR_MAX_BYTES = 256 * 1024 * 1024;
const DAY_MS = 86_400_000;
/** How old a copy may get before the next use fetches it again: a moving ref, and a commit SHA. */
export const REFRESH_MS = { ref: DAY_MS, sha: 7 * DAY_MS };

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export interface ActionRef {
  owner: string;
  repo: string;
  ref: string;
}

/** The action named by untrusted input, or null when it is not a valid GitHub owner, repository and ref. */
export function parseActionRef(v: { owner?: unknown; repo?: unknown; ref?: unknown }): ActionRef | null {
  const { owner, repo, ref } = v;
  if (typeof owner !== "string" || typeof repo !== "string" || typeof ref !== "string") return null;
  if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith(".") || repo === "." || repo === "..") return null;
  // git's ref name rules, roughly (git check-ref-format), and no control characters.
  if (!ref || ref.length > 255 || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".lock") || /\.\.|\/\/|@\{|[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref)) return null;
  return { owner, repo, ref };
}

const isSha = (ref: string) => /^[0-9a-f]{40}$/i.test(ref);

/** Where the copy of `a` lives. GitHub names are case-insensitive; refs are not. */
export function mirrorKey(a: ActionRef): string {
  return `${ACTION_MIRROR_ROOT}${a.owner.toLowerCase()}/${a.repo.toLowerCase()}/${encodeURIComponent(isSha(a.ref) ? a.ref.toLowerCase() : a.ref)}.tar.gz`;
}

/** Whether a copy uploaded at `uploaded` should be fetched again now. */
export function isStale(a: ActionRef, uploaded: Date | undefined, now = Date.now()): boolean {
  if (!uploaded) return true;
  return now - uploaded.getTime() >= (isSha(a.ref) ? REFRESH_MS.sha : REFRESH_MS.ref);
}

/** The bucket, whose `head` also says when an object was stored (R2 does). */
export type MirrorBucket = Omit<BlobBucket, "head"> & { head(key: string): Promise<{ size: number; etag: string; uploaded?: Date } | null> };

export type RefreshResult = "fresh" | "stored" | "not-found" | "too-large" | "failed";

/**
 * Makes sure Diffinery has a recent copy of `a`, fetching it from GitHub when it has none or the
 * one it has is stale. Never throws: a failure leaves any older copy in place.
 */
export async function refreshMirror(bucket: MirrorBucket, a: ActionRef, o: { fetch?: typeof fetch; now?: number; codeload?: string } = {}): Promise<RefreshResult> {
  // Jobs that report the same action at once may each fetch it (no promise is shared between
  // requests in a Worker); the copies are the same, and the last one stored stays.
  const key = mirrorKey(a);
  try {
    const head = await bucket.head(key);
    if (head && !isStale(a, head.uploaded, o.now)) return "fresh";
    const base = o.codeload ?? "https://codeload.github.com";
    const res = await (o.fetch ?? fetch)(`${base}/${a.owner}/${a.repo}/tar.gz/${encodeURIComponent(a.ref)}`, { headers: { "user-agent": "diffinery-action-mirror" }, redirect: "follow" });
    if (res.status === 404) {
      await res.body?.cancel();
      return "not-found";
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return "failed";
    }
    const len = Number(res.headers.get("content-length") ?? NaN);
    if (len > MIRROR_MAX_BYTES) {
      await res.body.cancel();
      return "too-large";
    }
    await putStream(bucket as BlobBucket, key, res.body, MIRROR_MAX_BYTES, { httpMetadata: { contentType: "application/gzip" } });
    return "stored";
  } catch (e) {
    if (e instanceof BodyTooLarge) return "too-large";
    console.error("action mirror refresh failed", `${a.owner}/${a.repo}@${a.ref}`, e);
    return "failed";
  }
}
