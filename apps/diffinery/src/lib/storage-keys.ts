/**
 * Where things live in the R2 bucket. Durable and transient data have their own
 * top-level prefixes, because R2 lifecycle rules (scripts/bootstrap.sh) can only
 * select objects by prefix:
 *
 * | prefix               | what                                        | lifecycle rule            |
 * |----------------------|---------------------------------------------|---------------------------|
 * | `repos/`             | git objects, LFS, release assets            | none: kept until deleted  |
 * | `registry/`          | container registry blobs and manifests      | none (store.ts sweeps)    |
 * | `artifacts/`         | workflow artifacts                          | deleted after 90 days     |
 * | `actions-cache/`     | Actions caches                              | none: evicted by the code |
 * | `logs/`              | archived job logs                           | deleted after 90 days     |
 * | `actions-staging/`   | uploads in progress (blocks, chunks, pushes) | deleted after 1 day       |
 * | `archives/`          | zipball/tarball cache (rebuilt on a miss)   | deleted after 30 days     |
 * | `exports/`           | account exports (accounts/export.ts)        | deleted after 8 days      |
 * | `events/`            | the event archive                           | deleted after 400 days    |
 * | `action-mirror/`     | copies of the GitHub actions jobs use       | deleted after 30 days     |
 *
 * Every prefix also aborts multipart uploads left unfinished for a day.
 *
 * Artifacts, caches and logs were first stored under `repos/<id>/...` (and an
 * age rule on `repos/` would have deleted git objects with them); reads fall back
 * to those keys, listed after the current one.
 *
 * Deleting a repository removes all of its objects ({@link repoPrefixes}), git
 * objects, LFS and release assets included.
 */

export const STAGING_ROOT = "actions-staging/";

/** Diffinery's copies of the GitHub actions jobs use, shared by every repository (lib/action-mirror.ts). */
export const ACTION_MIRROR_ROOT = "action-mirror/";

/** A push body staged in R2 (see {@link pushBodyKey}). */
export type SpilledBody = { spilled: string; size: number };

/** A large push body on its way from the Worker to the repository's Durable Object (deleted once read). */
export function pushBodyKey(repoId: string): string {
  return `${STAGING_ROOT}pushes/${repoId}/${crypto.randomUUID()}`;
}

/** The object of an Actions runtime cache entry or artifact, by its numeric id. */
export function runtimeObjectKey(b: { repo: string; kind: "cache" | "artifact"; id: number }): string {
  return b.kind === "cache" ? `actions-cache/${b.repo}/${b.id}` : `artifacts/${b.repo}/${b.id}`;
}

/** A cached source archive of a commit (zipball or tarball). */
export function archiveKey(repo: string, sha: string, format: string): string {
  return `${archivePrefix(repo)}${sha}.${format}`;
}

/** A repository's cached source archives, which carry `<owner>-<repo>-<sha7>/` and so go stale when it moves. */
export const archivePrefix = (repo: string): string => `archives/${repo}/`;

/** A repository's prefixes outside repos/: Actions data and caches. */
export function transientPrefixes(repo: string): string[] {
  return [`actions-cache/${repo}/`, `artifacts/${repo}/`, `logs/${repo}/`, `${STAGING_ROOT}${repo}/`, archivePrefix(repo)];
}

/** Every prefix a repository's objects live under, for deleting the repository. */
export const repoPrefixes = (repo: string): string[] => [`repos/${repo}/`, ...transientPrefixes(repo)];

type ListDelete = {
  list(o: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<unknown>;
};

/**
 * Deletes every object under `prefixes`, a page of 1000 at a time, making at most
 * `maxCalls` bucket calls (a Durable Object invocation has 1000 subrequests).
 * Returns whether everything went.
 */
export async function deletePrefixes(bucket: ListDelete, prefixes: string[], maxCalls = 900): Promise<boolean> {
  let calls = 0;
  for (const prefix of prefixes) {
    for (;;) {
      if (calls + 2 > maxCalls) return false;
      // Deleted objects leave the listing, so each page starts from the beginning.
      const page = await bucket.list({ prefix, limit: 1000 });
      calls++;
      if (!page.objects.length) break;
      await bucket.delete(page.objects.map((o) => o.key));
      calls++;
      if (!page.truncated) break;
    }
  }
  return true;
}

/** An archived job log: the current key, then the old layout's. */
export function logKeys(repo: string, jobId: string): [string, string] {
  return [`logs/${repo}/${jobId}.json`, `repos/${repo}/logs/${jobId}.json`];
}

/** A cache saved by an older runner (the pre-toolkit cache API): current key, then old. */
export function legacyCacheKeys(repo: string, key: string): [string, string] {
  const k = encodeURIComponent(key);
  return [`actions-cache/${repo}/legacy/${k}`, `repos/${repo}/cache/${k}`];
}

/** An artifact uploaded by an older runner (a tarball per name): current key, then old. */
export function legacyArtifactKeys(repo: string, runId: string, name: string): [string, string] {
  const n = encodeURIComponent(name);
  return [`artifacts/${repo}/legacy/${runId}/${n}`, `repos/${repo}/artifacts/${runId}/${n}`];
}

/** The first of `keys` that exists. */
export async function getFirst(bucket: R2Bucket, keys: readonly string[]): Promise<R2ObjectBody | null> {
  for (const k of keys) {
    const o = await bucket.get(k);
    if (o) return o;
  }
  return null;
}

/** The first of `keys` that exists, without its body. */
export async function headFirst(bucket: R2Bucket, keys: readonly string[]): Promise<R2Object | null> {
  for (const k of keys) {
    const o = await bucket.head(k);
    if (o) return o;
  }
  return null;
}
