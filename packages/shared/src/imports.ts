/**
 * Contract between the Diffinery control plane (Worker) and the runner agent's
 * import mode, which copies a repository's Git data (and Git LFS objects) from
 * GitHub into Diffinery inside a Cloudflare Container.
 *
 * The agent calls `${apiUrl}/api/v3/diffinery/imports/:id/agent/...` with
 * `Authorization: Bearer <push token>`: a short-lived Diffinery token scoped to
 * the target repository, which the Worker revokes when the transfer ends.
 */

export interface ImportSpec {
  importId: string;
  /** GitHub side. `cloneUrl` is checked by the Worker to be on the GitHub host being imported from. */
  source: { fullName: string; cloneUrl: string; defaultBranch: string };
  /** Read token for GitHub (private repositories, LFS); null for public repositories. */
  githubToken: string | null;
  /** Diffinery side: the repository's git URL, e.g. https://diffinery.com/acme/app.git */
  target: { fullName: string; pushUrl: string };
  /** The short-lived push token (same as the bearer token used for these calls). */
  pushToken: string;
  /** Git LFS objects are copied too. */
  lfs: boolean;
  /** Push protection findings in old history: push with an audited admin bypass, or stop. */
  secrets: "bypass" | "stop";
  /** Reason sent with `-o allow-secrets=` when `secrets` is "bypass". */
  bypassReason: string;
  /** Upper bound for one push request body; the agent splits history to stay under it. */
  chunkBytes: number;
}

export type ImportPhase = "clone" | "lfs-fetch" | "push" | "refs" | "lfs-push" | "cleanup" | "done";

export interface ImportProgress {
  phase: ImportPhase;
  message: string;
  /** Pushed history chunks so far, and the bytes they carried. */
  chunks?: number;
  bytes?: number;
}

export interface ImportSecretFinding {
  kind: string;
  /** Blob id, or its abbreviation as the server reported it. */
  blob: string;
  /** A path where the blob appears in history, when the agent could find one. */
  path?: string;
}

export interface ImportGitResult {
  ok: boolean;
  error?: string;
  branches: number;
  tags: number;
  pullRefs: number;
  chunks: number;
  bytes: number;
  lfsObjects: number;
  lfsBytes: number;
  /** The GitHub default branch exists in the import. */
  defaultBranch: string | null;
  secretFindings: ImportSecretFinding[];
  warnings: string[];
}
