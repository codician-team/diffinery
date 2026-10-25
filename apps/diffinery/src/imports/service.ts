import { devAuth } from "../auth/dev.js";
import { NonRetryableError } from "cloudflare:workflows";
import type { ImportGitResult, ImportProgress, ImportSecretFinding, ImportSpec } from "@diffinery/shared";
import type { Env } from "../env.js";
import { decryptSecret, encryptSecret, hmacSha256, matchesAnyKey, resealSecret, signingSecrets } from "../lib/crypto.js";
import { Directory, type Account, type Repo, type TokenScope } from "../lib/directory.js";
import { atLeast } from "../repo/types.js";
import { HttpError, newId, now } from "../lib/util.js";
import { checkStorageQuota } from "../lib/quotas.js";
import { GitHubClient, GitHubError, RateLimited, listPath } from "./github.js";
import {
  People,
  mapIssue,
  mapIssueComment,
  mapMilestone,
  mapProtection,
  mapPull,
  mapReview,
  mapReviewComment,
  type GhComment,
  type GhIssue,
  type GhLabel,
  type GhMilestone,
  type GhProtection,
  type GhPull,
  type GhReview,
  type GhReviewComment,
  type GhUser,
  type Link,
} from "./mapping.js";
import { MAX_BULK_REPOS, parseImportRequest, safeAssetName, visibilityFor, webHostOf, normalizeApiUrl, type ImportOptions, type ImportVisibility } from "./options.js";

/**
 * GitHub imports: the records in D1 (`imports`), the steps the import workflow
 * runs (see workflow.ts), and the endpoints of the Git transfer agent.
 *
 * An import creates the repository, has the import agent copy Git data in a
 * container, then copies issues, pull requests, comments, reviews, labels,
 * milestones, branch protection and variables through the GitHub REST API.
 * Every write is an upsert keyed by GitHub ids, so a retried step or a retried
 * import never duplicates anything, and nothing an import writes fires
 * workflows, webhooks or notifications.
 */

export type ImportStatus = "draft" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export const REPO_STEPS = [
  ["repository", "Create the repository"],
  ["git", "Copy branches, tags and history"],
  ["labels", "Labels and milestones"],
  ["issues", "Issues and pull requests"],
  ["comments", "Comments"],
  ["reviews", "Reviews"],
  ["review_comments", "Review comments"],
  ["protection", "Branch protection"],
  ["variables", "Variables and secret names"],
  ["releases", "Releases"],
  ["finalize", "Finish"],
] as const;

export const BULK_STEPS = [
  ["organization", "Organization variables and secret names"],
  ["repositories", "Repositories"],
  ["finalize", "Finish"],
] as const;

/** Steps that page through GitHub; the workflow calls them until they report done. */
export const PAGED_STEPS = ["labels", "issues", "comments", "reviews", "review_comments", "protection", "variables", "releases"] as const;
export type PagedStep = (typeof PAGED_STEPS)[number];
export type StepCursor = string | number | { phase: string; next: string } | null;

export interface StepState {
  status: "pending" | "running" | "done" | "skipped" | "failed";
  message?: string;
  count?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface ImportRow {
  id: string;
  parent_id: string | null;
  kind: "repo" | "bulk";
  status: ImportStatus;
  created_by: string;
  api_url: string;
  source: string;
  target_owner_id: string;
  target_name: string | null;
  repo_id: string | null;
  request: string;
  steps: string;
  git: string | null;
  summary: string;
  warnings: string;
  error: string | null;
  token_ciphertext: string | null;
  push_token_id: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Candidate {
  name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string;
}

export interface StoredRequest {
  visibility: ImportVisibility;
  options: ImportOptions;
  /** Bulk: GitHub account type of the source ("Organization" or "User"). */
  sourceType?: string;
  repositories: string[] | null;
  excludeForks: boolean;
  excludeArchived: boolean;
  concurrency: number;
  /** Token scopes of the person or agent who started the import; the push token gets the same. */
  scopes: TokenScope[];
  /** Drafts of bulk imports: the repositories to choose from. */
  candidates?: Candidate[];
}

export interface GitState {
  phase?: string;
  message?: string;
  chunks?: number;
  bytes?: number;
  at?: string;
  tries?: number;
  result?: ImportGitResult;
}

export interface ImportSummary {
  source?: {
    htmlUrl: string;
    cloneUrl: string;
    defaultBranch: string;
    visibility: string;
    archived: boolean;
    description: string;
    homepage: string;
    topics: string[];
  };
  git?: Omit<ImportGitResult, "ok" | "error" | "secretFindings" | "warnings">;
  counts?: { issues: number; pulls: number; comments: number; reviews: number; labels: number; milestones: number };
  pullRefs?: { created: number; missing: number[] };
  protections?: string[];
  variables?: string[];
  orgVariables?: string[];
  secretNames?: string[];
  orgSecretNames?: string[];
  releases?: { imported: number; assets: number; skippedAssets: number };
  environments?: { imported: number; variables: number; secretNames: string[] };
  findings?: ImportSecretFinding[];
  people?: { linked: string[]; imported: string[] };
  children?: { total: number; succeeded: number; failed: number; cancelled: number; open: number };
}

/** Default size bound for one push: well under the 100 MB request cap and the 128 MB of a repository's Durable Object. */
export const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
// Larger batches per workflow step keep the total number of workflow steps well under the platform cap.
const PAGES_PER_STEP = 10;
const PULLS_PER_STEP = 30;
/** M5 import volume limits (per account and per organization). */
const MAX_ACTIVE_BULK = 1;
const MAX_ACTIVE_REPO = 3;
/** Largest source repository an import will take, in KB (GitHub's `size`); overridable with IMPORT_MAX_REPO_KB. */
const DEFAULT_MAX_REPO_KB = 10 * 1024 * 1024;

const fatal = (message: string) => new NonRetryableError(message);
/** The first 16 bytes of a MAC in hex (gist nonces and OAuth state). */
const hex16 = (mac: Uint8Array): string => [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3}: /, "") : String(e));

/** A valid Actions variable name: GitHub's rules (letters, digits, underscore, not starting with a digit) and never the reserved GITHUB_ prefix. */
/** A GitHub answer meaning the data isn't available to this token (none, or one without admin access), not a failure. */
const notAvailable = (e: unknown): boolean => e instanceof GitHubError && (e.status === 401 || e.status === 403 || e.status === 404);
const validVarName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^GITHUB_/i.test(name) && name.length <= 256;

/**
 * Whether a Durable Object RPC failed because the method does not exist on this
 * build of RepoDO (releases and environments are delivered by a separate
 * branch). A stub proxy reports every property as callable, so a missing method
 * can only be told apart by the error from calling it.
 */
const methodMissing = (e: unknown): boolean => /not (a )?(implement|function)|does not implement|no such method|is not a function/i.test(e instanceof Error ? e.message : String(e));

/** A GitHub release and its assets, as returned by `GET /repos/{owner}/{repo}/releases`. */
interface GhRelease {
  tag_name: string;
  target_commitish?: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  created_at: string;
  published_at?: string | null;
  author?: GhUser | null;
  assets?: GhReleaseAsset[];
}
interface GhReleaseAsset {
  /** The API URL; downloading needs `Accept: application/octet-stream` and redirects to a GitHub asset host. */
  url: string;
  name: string;
  label?: string | null;
  content_type?: string;
  size?: number;
  download_count?: number;
  created_at?: string;
  updated_at?: string;
  uploader?: GhUser | null;
}

/** A GitHub deployment environment, from `GET /repos/{owner}/{repo}/environments`. */
interface GhEnvironment {
  name: string;
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
}

/** The import's own writer identity for RepoDO calls that require a caller. */
interface ImportCaller {
  id: string;
  login: string;
  kind: "user" | "agent" | "system";
  role: "admin";
  importId: string;
}

/**
 * The release-import surface of RepoDO (delivered by a separate branch). Named
 * structurally so this module compiles and runs whether or not that branch is
 * present; when it is absent the release step detects the missing methods and
 * records that releases were not imported.
 */
interface ReleaseImporter {
  importRelease(input: { tag_name: string; target_commitish?: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean; created_at: string; published_at?: string | null; author: { id?: string; login: string; kind?: string }; latest?: boolean }, caller: ImportCaller): Promise<{ id: number; created?: boolean }> | { id: number; created?: boolean };
  importReleaseAsset(
    releaseId: number,
    meta: { name: string; label?: string; content_type?: string; download_count?: number; created_at?: string; updated_at?: string; uploader?: { id?: string; login: string; kind?: string } },
    source: { r2Key: string } | { url: string; headers?: Record<string, string> },
    caller: ImportCaller,
  ): Promise<unknown>;
}

/**
 * The environment-import surface of RepoDO (also from the separate branch).
 * Secret *values* are never copied (only their names are listed), matching the
 * repository-level policy: an admin re-enters them by hand.
 */
interface EnvImporter {
  upsertEnvironment(name: string, input: { deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null }, caller: ImportCaller): unknown;
  addEnvironmentBranchPattern(name: string, pattern: { name?: string; type?: string }, caller: ImportCaller): unknown;
  setEnvironmentVariable(envName: string, name: string, value: string | null, caller: ImportCaller): unknown;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/**
 * Whether `importId`'s push token may push to `repoId` in import mode right now. The token must be
 * the import's *current* push token (M4): a token from an earlier attempt, though still a valid
 * import token, has a different id and is refused, so a stale container can never push.
 */
export async function importPushAllowed(env: Env, importId: string, repoId: string, tokenId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT status, repo_id, push_token_id FROM imports WHERE id = ?").bind(importId).first<{ status: string; repo_id: string | null; push_token_id: string | null }>();
  return r?.status === "running" && r.repo_id === repoId && r.push_token_id === tokenId;
}

interface Ctx {
  row: ImportRow;
  req: StoredRequest;
  gh: GitHubClient;
  /** The GitHub token (decrypted), needed to authenticate release-asset downloads. */
  token: string | null;
  people: People;
  summary: ImportSummary;
  steps: Record<string, StepState>;
  repo: Repo | null;
  stub: DurableObjectStub<import("../repo/RepoDO.js").RepoDO> | null;
}

interface StepOutcome {
  done: boolean;
  cursor?: StepCursor;
  /** Items written in this call (added to the step's count). */
  added?: number;
  message?: string;
  skipped?: boolean;
}

export class ImportService {
  readonly dir: Directory;

  constructor(private readonly env: Env) {
    this.dir = new Directory(env);
  }

  /** Local development: plain HTTP and loopback GitHub doubles are allowed. */
  get dev(): boolean {
    return devAuth(this.env);
  }

  private get db() {
    return this.env.DB;
  }

  // ---------------------------------------------------------------- records

  async row(id: string): Promise<ImportRow | null> {
    return this.db.prepare("SELECT * FROM imports WHERE id = ?").bind(id).first<ImportRow>();
  }

  private async mustRow(id: string): Promise<ImportRow> {
    const r = await this.row(id);
    if (!r) throw fatal(`import ${id} not found`);
    return r;
  }

  async list(accountId: string, limit = 100): Promise<ImportRow[]> {
    return (await this.db.prepare("SELECT * FROM imports WHERE created_by = ? AND parent_id IS NULL ORDER BY created_at DESC LIMIT ?").bind(accountId, limit).all<ImportRow>()).results;
  }

  async children(parentId: string): Promise<ImportRow[]> {
    return (await this.db.prepare("SELECT * FROM imports WHERE parent_id = ? ORDER BY created_at, source").bind(parentId).all<ImportRow>()).results;
  }

  /** People who may see an import: who started it, and admins of the account it imports into. */
  async visibleTo(row: ImportRow, actor: Account): Promise<boolean> {
    if (row.created_by === actor.id || actor.site_admin) return true;
    if (actor.kind !== "user") return false;
    const owner = await this.dir.account(row.target_owner_id);
    return !!owner && owner.kind !== "agent" && (await this.canImportInto(actor, owner));
  }

  /**
   * People import into their own account or organizations they own or administer.
   * Agents import only where their owner may: an organization's agent into that
   * organization, a person's agent wherever that person may (`create` also needs
   * the agent's own policy to allow write; an agent holds at most write by default).
   */
  async canImportInto(actor: Account, owner: Account): Promise<boolean> {
    if (actor.status !== "active" || owner.kind === "agent") return false;
    if (actor.kind === "agent") {
      if (!actor.owner_id) return false;
      if (owner.kind === "org" && actor.owner_id === owner.id) return true;
      const human = await this.dir.account(actor.owner_id);
      return !!human && human.kind === "user" && (await this.canImportInto(human, owner));
    }
    if (actor.kind !== "user") return false;
    if (actor.site_admin) return true;
    if (owner.kind === "user") return owner.id === actor.id;
    const role = await this.dir.orgRole(owner.id, actor.id);
    return role === "owner" || role === "admin";
  }

  private async setStep(id: string, name: string, patch: Partial<StepState>): Promise<void> {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await this.db
      .prepare("UPDATE imports SET steps = json_set(steps, '$.' || ?, json_patch(COALESCE(json_extract(steps, '$.' || ?), '{}'), json(?))), updated_at = ? WHERE id = ?")
      .bind(name, name, JSON.stringify(clean), now(), id)
      .run();
  }

  private async saveSummary(id: string, summary: ImportSummary): Promise<void> {
    await this.db.prepare("UPDATE imports SET summary = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(summary), now(), id).run();
  }

  async warn(id: string, message: string): Promise<void> {
    await this.db.prepare("UPDATE imports SET warnings = json_insert(warnings, '$[#]', ?), updated_at = ? WHERE id = ? AND json_array_length(warnings) < 500").bind(message.slice(0, 1000), now(), id).run();
  }

  private async audit(row: ImportRow, action: string, detail: Record<string, unknown>): Promise<void> {
    const actor = await this.dir.account(row.created_by);
    await this.dir.audit({ actorId: row.created_by, actorLogin: actor?.login, action, target: row.source, detail: { import: row.id, ...detail } });
  }

  // ---------------------------------------------------------------- starting imports

  /**
   * Validate and record an import, then start its workflow. With `draft`, a bulk
   * import without a selection is recorded with its candidate repositories and
   * waits for `select` (the web form's second page).
   */
  async create(actor: Account, scopes: TokenScope[], body: unknown, o: { draft?: boolean } = {}): Promise<ImportRow> {
    if (actor.kind === "org") throw new HttpError(403, "organizations cannot start imports");
    if (!scopes.includes("write") && !scopes.includes("admin")) throw new HttpError(403, "starting an import needs a token with write or admin scope");
    const req = parseImportRequest(body, { dev: this.dev, ownHost: this.env.PUBLIC_URL ? new URL(this.env.PUBLIC_URL).hostname : undefined });
    const owner = await this.dir.accountByLogin(req.owner);
    if (!owner || owner.kind === "agent") throw new HttpError(422, `no Diffinery user or organization named ${req.owner}`);
    if (!(await this.canImportInto(actor, owner))) {
      throw new HttpError(403, actor.kind === "agent" ? `agents can import only where their owner may: the owner's own account or an organization the owner administers, not ${owner.login}` : `you can import only into your own account or organizations you administer, not ${owner.login}`);
    }
    // An agent may import only if its own policy lets it write (H1): an import creates and fills a repository.
    // (Its owner may import here, so holds admin; the agent acts with at most its policy's role.)
    if (actor.kind === "agent" && !atLeast(this.dir.agentMaxRole(actor), "write")) throw new HttpError(403, "this agent's policy does not allow writing; an import needs at least write");
    // Agents can never bypass push protection: an import they start imports secret-bearing
    // history only if it is clean, never with an admin bypass.
    if (actor.kind === "agent") req.options.secrets = "stop";
    // M5: cap how many imports one account or organization can run at once.
    await this.assertImportQuota(actor.id, owner.id, req.mode);
    // An import stores what it copies for the owner: refused up front past the owner's storage quota
    // (lib/quotas.ts); one that reaches it on the way fails with the quota's message.
    await checkStorageQuota(this.env, owner.id, owner.login);
    const gh = new GitHubClient(req.apiUrl, req.token);
    const stored: StoredRequest = {
      visibility: req.visibility,
      options: req.options,
      repositories: req.repositories,
      excludeForks: req.excludeForks,
      excludeArchived: req.excludeArchived,
      concurrency: req.concurrency,
      scopes: scopes.includes("admin") ? ["admin"] : ["write"],
    };
    const id = newId();
    const t = now();
    const ciphertext = req.token ? await encryptSecret(this.env, `import:${id}`, req.token) : null;
    const insert = (r: Partial<ImportRow> & { id: string; kind: ImportRow["kind"]; status: ImportStatus; source: string }) =>
      this.db
        .prepare(
          "INSERT INTO imports (id, parent_id, kind, status, created_by, api_url, source, target_owner_id, target_name, request, steps, summary, warnings, error, token_ciphertext, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '[]', ?, ?, 1, ?, ?)",
        )
        .bind(r.id, r.parent_id ?? null, r.kind, r.status, actor.id, req.apiUrl, r.source, owner.id, r.target_name ?? null, r.request ?? JSON.stringify(stored), r.error ?? null, r.token_ciphertext ?? null, t, t);

    if (req.mode === "repo") {
      const gr = await this.sourceRepo(gh, req.source);
      this.assertRepoSize(gr.size);
      if (await this.dir.repo(owner.login, req.name!)) throw new HttpError(422, `${owner.login}/${req.name} already exists; choose another name`);
      await insert({ id, kind: "repo", status: "queued", source: gr.full_name, target_name: req.name, token_ciphertext: ciphertext ?? undefined }).run();
    } else {
      const { type, repos } = await this.sourceRepos(gh, req.source);
      stored.sourceType = type;
      let candidates = repos.filter((r) => !(req.excludeForks && r.fork) && !(req.excludeArchived && r.archived));
      if (req.repositories) {
        const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
        const unknown = req.repositories.filter((n) => !byName.has(n.toLowerCase()));
        if (unknown.length) throw new HttpError(422, `not found in ${req.source}: ${unknown.slice(0, 10).join(", ")}`);
        candidates = req.repositories.map((n) => byName.get(n.toLowerCase())!);
      }
      if (!candidates.length) throw new HttpError(422, `${req.source} has no repositories to import`);
      if (o.draft && !req.repositories) {
        await insert({ id, kind: "bulk", status: "draft", source: req.source, request: JSON.stringify({ ...stored, candidates }), token_ciphertext: ciphertext ?? undefined }).run();
        return (await this.row(id))!;
      }
      await insert({ id, kind: "bulk", status: "queued", source: req.source, request: JSON.stringify(stored), token_ciphertext: ciphertext ?? undefined }).run();
      await this.createChildren((await this.row(id))!, owner, candidates.map((c) => c.name), req.token);
    }
    const row = (await this.row(id))!;
    await this.audit(row, "import.create", { kind: row.kind, owner: owner.login, name: row.target_name, options: { ...req.options } });
    await this.launch(id, 1);
    return row;
  }

  /** Refuse a repository whose GitHub size (KB) is over the configured ceiling (default 10 GB). */
  private assertRepoSize(sizeKb: number | undefined): void {
    // A missing, non-numeric, zero or negative setting means the default, never "refuse everything".
    const configured = Number(this.env.IMPORT_MAX_REPO_KB);
    const maxKb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_REPO_KB;
    if (typeof sizeKb === "number" && sizeKb > maxKb) {
      throw new HttpError(422, `the repository is about ${Math.round(sizeKb / 1024 / 1024)} GB, over the ${Math.round(maxKb / 1024 / 1024)} GB import limit; ask an administrator to raise IMPORT_MAX_REPO_KB or split the repository`);
    }
  }

  /** M5: at most one active bulk import and three active repository imports per account and per organization. */
  private async assertImportQuota(accountId: string, ownerId: string, mode: "repo" | "bulk"): Promise<void> {
    const count = async (col: "created_by" | "target_owner_id", id: string): Promise<number> => {
      if (mode === "bulk") return (await this.db.prepare(`SELECT count(*) AS n FROM imports WHERE ${col} = ? AND kind = 'bulk' AND status IN ('draft','queued','running')`).bind(id).first<{ n: number }>())?.n ?? 0;
      return (await this.db.prepare(`SELECT count(*) AS n FROM imports WHERE ${col} = ? AND kind = 'repo' AND parent_id IS NULL AND status IN ('queued','running')`).bind(id).first<{ n: number }>())?.n ?? 0;
    };
    const limit = mode === "bulk" ? MAX_ACTIVE_BULK : MAX_ACTIVE_REPO;
    if ((await count("created_by", accountId)) >= limit || (await count("target_owner_id", ownerId)) >= limit) {
      throw new HttpError(429, mode === "bulk" ? `an organization import is already in progress (at most ${MAX_ACTIVE_BULK} at a time); wait for it to finish or cancel it` : `too many repository imports are already running (at most ${MAX_ACTIVE_REPO} at a time); wait for one to finish`);
    }
  }

  /** Bulk drafts: the repositories to import were chosen; start the import. */
  async select(id: string, actor: Account, names: string[]): Promise<ImportRow> {
    const row = await this.row(id);
    if (!row || row.created_by !== actor.id || row.kind !== "bulk") throw new HttpError(404, "import not found");
    if (row.status !== "draft") throw new HttpError(409, "this import has already started");
    const req = parse<StoredRequest>(row.request, {} as StoredRequest);
    const allowed = new Map((req.candidates ?? []).map((c) => [c.name.toLowerCase(), c.name]));
    const chosen = [...new Set(names.map((n) => allowed.get(n.toLowerCase())).filter((n): n is string => !!n))];
    if (!chosen.length) throw new HttpError(422, "choose at least one repository");
    if (chosen.length > MAX_BULK_REPOS) throw new HttpError(422, `at most ${MAX_BULK_REPOS} repositories per import`);
    const owner = (await this.dir.account(row.target_owner_id))!;
    if (!(await this.canImportInto(actor, owner))) throw new HttpError(403, `you can no longer import into ${owner.login}`);
    const token = row.token_ciphertext ? await decryptSecret(this.env, `import:${id}`, row.token_ciphertext) : null;
    const { candidates: _c, ...rest } = req;
    await this.db.prepare("UPDATE imports SET status = 'queued', request = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify({ ...rest, repositories: chosen }), now(), id).run();
    await this.createChildren((await this.row(id))!, owner, chosen, token);
    await this.audit(row, "import.create", { kind: "bulk", owner: owner.login, repositories: chosen.length });
    await this.launch(id, row.attempt);
    return (await this.row(id))!;
  }

  private async createChildren(parent: ImportRow, owner: Account, names: string[], token: string | null): Promise<void> {
    const existing = new Set((await this.db.prepare("SELECT name FROM repos WHERE owner_id = ?").bind(owner.id).all<{ name: string }>()).results.map((r) => r.name.toLowerCase()));
    const t = now();
    const stmts: D1PreparedStatement[] = [];
    for (const name of names) {
      const id = newId();
      const clash = existing.has(name.toLowerCase());
      stmts.push(
        this.db
          .prepare(
            "INSERT INTO imports (id, parent_id, kind, status, created_by, api_url, source, target_owner_id, target_name, request, steps, summary, warnings, error, token_ciphertext, attempt, created_at, updated_at, finished_at) VALUES (?, ?, 'repo', ?, ?, ?, ?, ?, ?, ?, '{}', '{}', '[]', ?, ?, 1, ?, ?, ?)",
          )
          .bind(
            id,
            parent.id,
            clash ? "failed" : "queued",
            parent.created_by,
            parent.api_url,
            `${parent.source}/${name}`,
            owner.id,
            name,
            parent.request,
            clash ? `${owner.login}/${name} already exists` : null,
            token && !clash ? await encryptSecret(this.env, `import:${id}`, token) : null,
            t,
            t,
            clash ? t : null,
          ),
      );
    }
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50));
  }

  private async launch(id: string, attempt: number): Promise<void> {
    await this.env.IMPORT_WORKFLOW.create({ id: `${id}-${attempt}`, params: { importId: id } });
  }

  /** The GitHub repository, with errors a person can act on. */
  private async sourceRepo(gh: GitHubClient, fullName: string): Promise<GhRepo> {
    try {
      return await gh.get<GhRepo>(`repos/${fullName}`);
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) throw new HttpError(422, `GitHub repository ${fullName} was not found or the token cannot read it`);
      if (e instanceof GitHubError && e.status === 401) throw new HttpError(422, "GitHub rejected the token (expired or revoked?)");
      if (e instanceof RateLimited) throw new HttpError(429, e.message);
      throw new HttpError(502, `could not reach GitHub: ${errMsg(e)}`);
    }
  }

  /** Every repository of a GitHub organization or user (private ones too when the token can see them). */
  private async sourceRepos(gh: GitHubClient, owner: string): Promise<{ type: string; repos: Candidate[] }> {
    try {
      const account = await gh.get<{ login: string; type: string }>(`users/${owner}`);
      let path: string;
      if (account.type === "Organization") path = listPath(`orgs/${account.login}/repos`, { type: "all" });
      else {
        const me = await gh.get<{ login: string }>("user").catch(() => null);
        path = me?.login.toLowerCase() === account.login.toLowerCase() ? listPath("user/repos", { affiliation: "owner", visibility: "all" }) : listPath(`users/${account.login}/repos`, { type: "owner" });
      }
      const repos = await gh.all<GhRepo>(path, MAX_BULK_REPOS);
      return {
        type: account.type,
        repos: repos
          .filter((r) => r.owner?.login?.toLowerCase() === account.login.toLowerCase())
          .map((r) => ({ name: r.name, private: !!r.private, fork: !!r.fork, archived: !!r.archived, description: r.description ?? "" }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) throw new HttpError(422, `no GitHub organization or user named ${owner}`);
      if (e instanceof GitHubError && e.status === 401) throw new HttpError(422, "GitHub rejected the token (expired or revoked?)");
      if (e instanceof RateLimited) throw new HttpError(429, e.message);
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `could not reach GitHub: ${errMsg(e)}`);
    }
  }

  // ---------------------------------------------------------------- cancel and retry

  async cancel(id: string, actor: Account): Promise<ImportRow> {
    const row = await this.row(id);
    if (!row || !(await this.visibleTo(row, actor))) throw new HttpError(404, "import not found");
    if (!["draft", "queued", "running"].includes(row.status)) throw new HttpError(409, `the import already ${row.status}`);
    const targets = row.kind === "bulk" ? [row, ...(await this.children(id)).filter((c) => ["queued", "running"].includes(c.status))] : [row];
    for (const r of targets) {
      await this.close(r, "cancelled", `cancelled by ${actor.login}`);
      await this.stopInstance(r);
    }
    // One repository of a bulk import: the next one starts in its place.
    if (row.parent_id) await this.afterChild(row.id);
    await this.audit(row, "import.cancel", { by: actor.login });
    return (await this.row(id))!;
  }

  /** Run a failed or cancelled import again. Everything is an upsert, so finished work is not duplicated. */
  async retry(id: string, actor: Account, token: string | null): Promise<ImportRow> {
    const row = await this.row(id);
    const owner = row ? await this.dir.account(row.target_owner_id) : null;
    // Retry is creator-only (Low 7): even an admin of the target cannot resume someone else's import.
    // The one exception is an agent's import, which a person who may import into the target takes over (H2 below).
    const takeover = async () => !!row && !!owner && actor.kind === "user" && (await this.dir.account(row.created_by))?.kind === "agent" && (await this.canImportInto(actor, owner));
    if (!row || (row.created_by !== actor.id && !(await takeover()))) throw new HttpError(404, "import not found");
    if (row.parent_id) throw new HttpError(422, "retry the organization import this repository belongs to");
    if (row.status !== "failed" && row.status !== "cancelled") throw new HttpError(409, "only failed or cancelled imports can be retried");
    if (token !== null && (token.length > 400 || /\s/.test(token))) throw new HttpError(422, "github_token is not a valid token");
    // H2: once the repository exists, retry replays writes into it. An agent must not do that on its
    // own; a person who administers the target has to take over the retry (and provide a token for a private source).
    if (actor.kind === "agent" && row.repo_id) throw new HttpError(403, `an agent cannot retry an import after the repository was created; a person who administers ${owner?.login ?? "the target"} must retry it`);
    if (!owner || !(await this.canImportInto(actor, owner))) throw new HttpError(403, "you cannot import into this account");
    const attempt = row.attempt + 1;
    const t = now();
    const reset = async (r: ImportRow, n: number) => {
      // A kept token sealed with MASTER_KEY_PREV (or as v1) is sealed again with MASTER_KEY, as the row is written anyway.
      const ciphertext = token ? await encryptSecret(this.env, `import:${r.id}`, token) : r.token_ciphertext ? await resealSecret(this.env, `import:${r.id}`, r.token_ciphertext) : r.token_ciphertext;
      await this.db
        .prepare("UPDATE imports SET status = 'queued', attempt = ?, error = NULL, steps = '{}', warnings = '[]', token_ciphertext = ?, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?")
        .bind(n, ciphertext, t, r.id)
        .run();
    };
    if (row.kind === "bulk") {
      for (const c of await this.children(id)) {
        if (c.status === "failed" || c.status === "cancelled") {
          if (c.error?.endsWith("already exists") && !c.repo_id) continue;
          await reset(c, c.attempt + 1);
        }
      }
    }
    await reset(row, attempt);
    await this.audit(row, "import.retry", { by: actor.login, attempt });
    await this.launch(id, attempt);
    return (await this.row(id))!;
  }

  private async stopInstance(row: ImportRow): Promise<void> {
    try {
      await (await this.env.IMPORT_WORKFLOW.get(`${row.id}-${row.attempt}`)).terminate();
    } catch {
      // not running
    }
    await this.stopContainer(row);
  }

  private async stopContainer(row: ImportRow): Promise<void> {
    const git = parse<GitState>(row.git, {});
    if (!this.env.IMPORTER || !git.tries) return;
    // Stop the container of every try of this attempt, not just the latest, so no leaked container keeps pushing.
    for (let t = 1; t <= git.tries; t++) {
      await this.env.IMPORTER.get(this.env.IMPORTER.idFromName(`${row.id}-${row.attempt}-${t}`)).stopImport().catch(() => {});
    }
  }

  /** Finish an import: final status, and its credentials are gone (every push token it minted revoked, the GitHub token deleted). */
  private async close(row: ImportRow, status: "succeeded" | "failed" | "cancelled", error: string | null): Promise<void> {
    // M4: revoke every token this import ever minted, not just the current one, so a stale token can never push.
    await this.dir.revokeTokensByImport(row.id);
    // A failed or cancelled import gives the repository back: release the lock and drop its in-flight refs.
    if ((status === "failed" || status === "cancelled") && row.repo_id) {
      try {
        const stub = this.env.REPO.get(this.env.REPO.idFromName(row.repo_id));
        await stub.importDropTempRefs(row.id);
        await stub.importEnd(row.id);
      } catch (e) {
        console.error("releasing import lock failed", row.id, e);
      }
    }
    const t = now();
    await this.db
      .prepare("UPDATE imports SET status = ?, error = ?, token_ciphertext = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'queued', 'running')")
      .bind(status, error ? error.slice(0, 2000) : null, t, t, row.id)
      .run();
    // An organization import that ended leaves no repository waiting with a copy of the GitHub token: one still
    // queued would never start, and would keep the token (and block deleting the account or organization) for good.
    if (row.kind === "bulk" && status !== "succeeded") {
      await this.db
        .prepare("UPDATE imports SET status = 'cancelled', error = ?, token_ciphertext = NULL, finished_at = ?, updated_at = ? WHERE parent_id = ? AND status IN ('draft', 'queued')")
        .bind(`the organization import ${status === "failed" ? "failed" : "was cancelled"} before this repository started`, t, t, row.id)
        .run();
    }
  }

  // ---------------------------------------------------------------- workflow: shared

  /** Mark an import running. Returns what to do; stops when it was cancelled meanwhile. */
  async begin(id: string): Promise<{ kind: "repo" | "bulk"; stop: boolean }> {
    const row = await this.mustRow(id);
    if (row.status !== "queued" && row.status !== "running") return { kind: row.kind, stop: true };
    const owner = await this.dir.account(row.target_owner_id);
    const actor = await this.dir.account(row.created_by);
    if (!owner || !actor || !(await this.canImportInto(actor, owner))) {
      await this.close(row, "failed", "the person or agent who started this import can no longer import into this account");
      return { kind: row.kind, stop: true };
    }
    await this.db.prepare("UPDATE imports SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?").bind(now(), now(), id).run();
    return { kind: row.kind, stop: false };
  }

  private async context(id: string): Promise<Ctx> {
    const row = await this.mustRow(id);
    if (row.status !== "running") throw fatal(`import is ${row.status}`);
    const token = row.token_ciphertext ? await decryptSecret(this.env, `import:${id}`, row.token_ciphertext) : null;
    // Links are keyed by the full normalised API base, so github.com and an Enterprise host never mix.
    const apiBase = normalizeApiUrl(row.api_url, this.dev);
    const links = await this.db
      .prepare("SELECT l.external_id, l.external_login, l.account_id, a.login FROM account_links l JOIN accounts a ON a.id = l.account_id WHERE l.provider = 'github' AND l.api_base = ? AND a.status = 'active'")
      .bind(apiBase)
      .all<{ external_id: string; external_login: string; account_id: string; login: string }>();
    const people = new People(links.results.map((l): Link => ({ externalId: l.external_id, externalLogin: l.external_login, accountId: l.account_id, login: l.login })));
    const repo = row.repo_id ? await this.dir.repoById(row.repo_id) : null;
    return {
      row,
      req: parse<StoredRequest>(row.request, {} as StoredRequest),
      gh: new GitHubClient(row.api_url, token),
      token,
      people,
      summary: parse<ImportSummary>(row.summary, {}),
      steps: parse<Record<string, StepState>>(row.steps, {}),
      repo,
      stub: repo ? this.env.REPO.get(this.env.REPO.idFromName(repo.id)) : null,
    };
  }

  /** The workflow gave up: record why. */
  async fail(id: string, message: string): Promise<void> {
    const row = await this.row(id);
    if (!row) return;
    const steps = parse<Record<string, StepState>>(row.steps, {});
    for (const [name, s] of Object.entries(steps)) if (s.status === "running") await this.setStep(id, name, { status: "failed", message: message.slice(0, 300), finishedAt: now() });
    await this.close(row, "failed", message);
    await this.stopContainer(row);
    if (!row.parent_id) await this.notifyDone(row, false);
    await this.audit(row, "import.fail", { error: message.slice(0, 500) });
  }

  private async notifyDone(row: ImportRow, ok: boolean): Promise<void> {
    const owner = await this.dir.account(row.target_owner_id);
    const target = row.kind === "repo" ? `${owner?.login}/${row.target_name}` : owner?.login;
    await this.dir.notify([row.created_by], { repoId: row.repo_id ?? undefined, kind: "import", title: ok ? `Imported ${row.source} into ${target}` : `Import of ${row.source} into ${target} failed`, url: `${this.env.PUBLIC_URL}/imports/${row.id}` });
  }

  // ---------------------------------------------------------------- workflow: one repository

  /**
   * Create the Diffinery repository (or reuse the one this import created on an earlier attempt).
   * A rate limit comes back as `wait` so the workflow sleeps it off and calls this again.
   */
  async stepRepository(id: string): Promise<{ wait?: number }> {
    const ctx = await this.context(id);
    await this.setStep(id, "repository", { status: "running", startedAt: now() });
    let gr: GhRepo;
    try {
      gr = await ctx.gh.get<GhRepo>(`repos/${ctx.row.source}`);
    } catch (e) {
      if (e instanceof RateLimited) {
        await this.setStep(id, "repository", { message: e.message });
        return { wait: e.waitSeconds };
      }
      if (e instanceof GitHubError && e.status < 500) throw fatal(e.status === 401 ? "GitHub rejected the token (expired or revoked?)" : `GitHub repository ${ctx.row.source} was not found or the token cannot read it`);
      throw e;
    }
    // Each repository of an organization import is held to the same size limit as a single import.
    if (!ctx.repo) {
      try {
        this.assertRepoSize(gr.size);
      } catch (e) {
        throw fatal((e as Error).message);
      }
    }
    const cloneUrl = gr.clone_url ?? `https://${webHostOf(ctx.row.api_url)}/${gr.full_name}.git`;
    if (new URL(cloneUrl).host !== webHostOf(ctx.row.api_url)) throw fatal("GitHub returned a clone URL on another host");
    ctx.summary.source = {
      htmlUrl: gr.html_url ?? `https://${webHostOf(ctx.row.api_url)}/${gr.full_name}`,
      cloneUrl,
      defaultBranch: gr.default_branch || "main",
      visibility: gr.visibility ?? (gr.private ? "private" : "public"),
      archived: !!gr.archived,
      description: gr.description ?? "",
      homepage: gr.homepage ?? "",
      topics: (gr.topics ?? []).slice(0, 20),
    };
    let repo = ctx.repo;
    if (!repo) {
      const owner = (await this.dir.account(ctx.row.target_owner_id))!;
      const creator = (await this.dir.account(ctx.row.created_by))!;
      if (await this.dir.repo(owner.login, ctx.row.target_name!)) throw fatal(`${owner.login}/${ctx.row.target_name} already exists`);
      repo = await this.dir.createRepo(owner, creator, { name: ctx.row.target_name!, description: (gr.description ?? "").slice(0, 1000), visibility: visibilityFor(ctx.req.visibility, gr), defaultBranch: ctx.summary.source.defaultBranch }, { authorized: true });
      await this.db.prepare("UPDATE imports SET repo_id = ?, updated_at = ? WHERE id = ?").bind(repo.id, now(), id).run();
    }
    // H2: claim the repository for this import. Refuses if another import holds it, or if the repo
    // already holds content this import did not write (so a retry never clobbers an adopted repo).
    const stub = this.env.REPO.get(this.env.REPO.idFromName(repo.id));
    try {
      await stub.importBegin(id);
    } catch (e) {
      if (e instanceof Error && /409:/.test(e.message)) throw fatal(errMsg(e));
      throw e;
    }
    await this.dir.updateRepo(repo, { homepage: ctx.summary.source.homepage.slice(0, 500) });
    await this.dir.setTopics(repo.id, ctx.summary.source.topics);
    await this.saveSummary(id, ctx.summary);
    await this.setStep(id, "repository", { status: "done", message: `${repo.owner_login}/${repo.name}`, finishedAt: now() });
    return {};
  }

  /** Start (or restart) the Git transfer. Returns whether an external agent has to claim it. */
  async startGit(id: string): Promise<{ external: boolean; tries: number }> {
    const ctx = await this.context(id);
    if (!ctx.repo) throw fatal("the repository was not created");
    const prev = parse<GitState>(ctx.row.git, {});
    const tries = (prev.tries ?? 0) + 1;
    const external = this.env.IMPORT_GIT_AGENT === "external";
    const git: GitState = { tries, phase: external ? "waiting" : "starting", message: external ? "Waiting for an import agent to claim the transfer" : "Starting the import container", at: now() };
    await this.db.prepare("UPDATE imports SET git = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(git), now(), id).run();
    await this.setStep(id, "git", { status: "running", startedAt: ctx.steps.git?.startedAt ?? now(), message: git.message });
    if (external) return { external, tries };
    if (!this.env.IMPORTER) throw fatal("no import container is configured (IMPORTER binding)");
    const token = await this.mintPushToken(ctx.row);
    await this.env.IMPORTER.get(this.env.IMPORTER.idFromName(`${id}-${ctx.row.attempt}-${tries}`)).startImport({ importId: id, token, apiUrl: this.env.PUBLIC_URL, stamp: `${ctx.row.attempt}-${tries}` });
    return { external, tries };
  }

  /**
   * A short-lived token for the transfer: the starter's account and scopes, this repository only, one day.
   * It keeps the starter's admin scope because importing history with secrets in it (`secrets: "bypass"`) is a
   * push protection bypass, which only a human admin may make. The token reaches only Git, Git LFS and this
   * import's agent endpoints, and is revoked when the import ends.
   */
  private async mintPushToken(row: ImportRow): Promise<string> {
    if (row.push_token_id) await this.dir.revokeTokenById(row.push_token_id);
    const creator = await this.dir.account(row.created_by);
    if (!creator) throw fatal("the account that started this import no longer exists");
    const req = parse<StoredRequest>(row.request, {} as StoredRequest);
    const t = await this.dir.createToken(creator, { name: `GitHub import of ${row.source}`, scopes: req.scopes?.length ? req.scopes : ["write"], repoIds: [row.repo_id!], expiresInDays: 1, importId: row.id });
    await this.db.prepare("UPDATE imports SET push_token_id = ?, updated_at = ? WHERE id = ?").bind(t.id, now(), row.id).run();
    return t.token;
  }

  /** Local development and tests: an agent started by hand claims the transfer and gets the push token. */
  async claim(id: string, actor: Account): Promise<{ token: string }> {
    if (this.env.IMPORT_GIT_AGENT !== "external") throw new HttpError(404, "not found");
    const row = await this.row(id);
    if (!row || row.created_by !== actor.id) throw new HttpError(404, "import not found");
    const git = parse<GitState>(row.git, {});
    if (row.status !== "running" || git.phase !== "waiting") throw new HttpError(409, "this import is not waiting for an agent");
    const token = await this.mintPushToken(row);
    await this.db.prepare("UPDATE imports SET git = json_set(git, '$.phase', 'starting', '$.message', 'Agent claimed the transfer'), updated_at = ? WHERE id = ?").bind(now(), id).run();
    return { token };
  }

  /** Where the transfer stands: done, running, or failed (with whether trying again can help). */
  async gitStatus(id: string): Promise<{ state: "running" | "done" | "failed"; error?: string; retryable?: boolean }> {
    const row = await this.mustRow(id);
    if (row.status !== "running") throw fatal(`import is ${row.status}`);
    const git = parse<GitState>(row.git, {});
    const r = git.result;
    if (!r) return { state: "running" };
    if (!r.ok) {
      if (!r.secretFindings.length) return { state: "failed", error: r.error ?? "the Git transfer failed", retryable: true };
      const kinds = [...new Set(r.secretFindings.map((f) => f.kind))].join(", ");
      const stop = parse<StoredRequest>(row.request, {} as StoredRequest).options?.secrets === "stop";
      // Retry cannot change an import's options, so the only way to bypass is a fresh import.
      const how = stop
        ? "The import was set to stop on secrets. Rotate them, then start a NEW import with the secrets option set to bypass (as a person who administers the target); a retry cannot change the options."
        : "Only a person who administers the target can import them with an audited bypass (agents and write-scoped tokens cannot); start a new import as such a person.";
      return { state: "failed", error: `Push protection found possible secrets in the history (${kinds}). ${how}`, retryable: false };
    }
    const summary = parse<ImportSummary>(row.summary, {});
    const { ok: _o, error: _e, secretFindings, warnings, ...counts } = r;
    summary.git = counts;
    summary.findings = mergeFindings(summary.findings ?? [], secretFindings);
    await this.saveSummary(id, summary);
    for (const w of warnings.slice(0, 50)) await this.warn(id, w);
    const lfs = r.lfsObjects ? `, ${r.lfsObjects} LFS objects` : "";
    await this.setStep(id, "git", { status: "done", count: r.branches + r.tags, message: `${r.branches} branches, ${r.tags} tags, ${r.pullRefs} pull request heads${lfs}`, finishedAt: now() });
    return { state: "done" };
  }

  /** Clear a failed transfer's result before trying again. */
  async resetGit(id: string, error: string): Promise<void> {
    await this.warn(id, `The Git transfer failed and is being retried: ${error.slice(0, 300)}`);
    await this.db.prepare("UPDATE imports SET git = json_remove(git, '$.result'), updated_at = ? WHERE id = ?").bind(now(), id).run();
  }

  /** One call of a paged step. Rate limits come back as `wait` so the workflow can sleep. */
  async runStep(id: string, name: PagedStep, cursor: StepCursor): Promise<{ done: boolean; cursor: StepCursor; wait?: number }> {
    const ctx = await this.context(id);
    if (!ctx.stub) throw fatal("the repository was not created");
    const state = ctx.steps[name];
    if (cursor === null || !state || state.status === "pending") await this.setStep(id, name, { status: "running", startedAt: now(), count: 0 });
    let out: StepOutcome;
    try {
      out = await this.step(ctx, name, cursor);
    } catch (e) {
      if (e instanceof RateLimited) {
        await this.setStep(id, name, { message: e.message });
        return { done: false, cursor, wait: e.waitSeconds };
      }
      if (e instanceof GitHubError && e.status < 500 && e.status !== 408) throw fatal(e.message);
      throw e;
    }
    const count = (cursor === null ? 0 : (state?.count ?? 0)) + (out.added ?? 0);
    ctx.summary.people = {
      linked: [...new Set([...(ctx.summary.people?.linked ?? []), ...ctx.people.mapped])].slice(0, 500),
      imported: [...new Set([...(ctx.summary.people?.imported ?? []), ...ctx.people.unmapped])].slice(0, 500),
    };
    await this.saveSummary(id, ctx.summary);
    if (out.done) await this.setStep(id, name, { status: out.skipped ? "skipped" : "done", count, message: out.message ?? `${count}`, finishedAt: now() });
    else await this.setStep(id, name, { status: "running", count, message: out.message ?? `${count} so far` });
    return { done: out.done, cursor: out.cursor ?? null };
  }

  private step(ctx: Ctx, name: PagedStep, cursor: StepCursor): Promise<StepOutcome> {
    switch (name) {
      case "labels":
        return this.labels(ctx);
      case "issues":
        return this.issues(ctx, cursor);
      case "comments":
        return this.listStep(ctx, cursor, listPath(`repos/${ctx.row.source}/issues/comments`, { sort: "created", direction: "asc" }), (items: GhComment[]) =>
          ctx.stub!.importComments(items.map((c) => mapIssueComment(c, ctx.people)).filter((c) => !!c), ctx.row.id),
        );
      case "reviews":
        return this.reviews(ctx, cursor);
      case "review_comments":
        return this.listStep(ctx, cursor, listPath(`repos/${ctx.row.source}/pulls/comments`, { sort: "created", direction: "asc" }), (items: GhReviewComment[]) =>
          ctx.stub!.importComments(items.map((c) => mapReviewComment(c, ctx.people)).filter((c) => !!c), ctx.row.id),
        );
      case "protection":
        return this.protection(ctx);
      case "variables":
        return this.variables(ctx);
      case "releases":
        return this.importReleases(ctx, cursor);
    }
  }

  private async labels(ctx: Ctx): Promise<StepOutcome> {
    if (!ctx.req.options.labels) return { done: true, skipped: true, message: "Not selected" };
    const src = ctx.row.source;
    const labels = await ctx.gh.all<GhLabel>(listPath(`repos/${src}/labels`));
    await ctx.stub!.importLabels(labels.map((l) => ({ name: l.name, color: l.color ?? "888888", description: l.description ?? "" })), ctx.row.id);
    let milestones: GhMilestone[] = [];
    try {
      milestones = await ctx.gh.all<GhMilestone>(listPath(`repos/${src}/milestones`, { state: "all" }));
    } catch (e) {
      if (!(e instanceof GitHubError && (e.status === 404 || e.status === 410))) throw e;
    }
    await ctx.stub!.importMilestones(milestones.map((m) => mapMilestone(m, ctx.people)), ctx.row.id);
    return { done: true, added: labels.length + milestones.length, message: `${labels.length} labels, ${milestones.length} milestones` };
  }

  /** Pull requests first (from /pulls, which has their branches), then issues (from /issues, skipping pull requests). */
  private async issues(ctx: Ctx, cursor: StepCursor): Promise<StepOutcome> {
    if (!ctx.req.options.issues) return { done: true, skipped: true, message: "Not selected" };
    const src = ctx.row.source;
    let c = (cursor as { phase: string; next: string } | null) ?? { phase: "pulls", next: listPath(`repos/${src}/pulls`, { state: "all", sort: "created", direction: "asc" }) };
    let added = 0;
    for (let i = 0; i < PAGES_PER_STEP; i++) {
      let page: { items: Array<GhIssue | GhPull>; next: string | null };
      try {
        page = await ctx.gh.page<GhIssue | GhPull>(c.next);
      } catch (e) {
        // Issues turned off on GitHub: /issues answers 410.
        if (c.phase === "issues" && e instanceof GitHubError && e.status === 410) return { done: true, added, message: undefined };
        throw e;
      }
      const rows = c.phase === "pulls" ? (page.items as GhPull[]).map((p) => mapPull(p, src, ctx.people)) : (page.items as GhIssue[]).filter((x) => !x.pull_request).map((x) => mapIssue(x, ctx.people));
      if (rows.length) added += await ctx.stub!.importIssues(rows, ctx.row.id);
      if (page.next) c = { phase: c.phase, next: page.next };
      else if (c.phase === "pulls") c = { phase: "issues", next: listPath(`repos/${src}/issues`, { state: "all", sort: "created", direction: "asc" }) };
      else return { done: true, added };
    }
    return { done: false, cursor: c, added };
  }

  /** A repository-wide list endpoint, a few pages per call. */
  private async listStep<T>(ctx: Ctx, cursor: StepCursor, first: string, store: (items: T[]) => Promise<number>): Promise<StepOutcome> {
    if (!ctx.req.options.issues) return { done: true, skipped: true, message: "Not selected" };
    let next = (cursor as string | null) ?? first;
    let added = 0;
    for (let i = 0; i < PAGES_PER_STEP; i++) {
      let page: { items: T[]; next: string | null };
      try {
        page = await ctx.gh.page<T>(next);
      } catch (e) {
        // Issues/comments can answer 410 (issues disabled) or 404; that is not a failure, just no data.
        if (e instanceof GitHubError && (e.status === 410 || e.status === 404)) return { done: true, added };
        throw e;
      }
      if (page.items.length) added += await store(page.items);
      if (!page.next) return { done: true, added };
      next = page.next;
    }
    return { done: false, cursor: next, added };
  }

  /** Reviews are listed per pull request; merged pull requests also need who merged them (only on the single pull). */
  private async reviews(ctx: Ctx, cursor: StepCursor): Promise<StepOutcome> {
    if (!ctx.req.options.issues) return { done: true, skipped: true, message: "Not selected" };
    const src = ctx.row.source;
    const pulls = await ctx.stub!.importPullNumbers(typeof cursor === "number" ? cursor : 0, PULLS_PER_STEP);
    let added = 0;
    for (const p of pulls) {
      let reviews: GhReview[] = [];
      try {
        reviews = await ctx.gh.all<GhReview>(listPath(`repos/${src}/pulls/${p.number}/reviews`));
      } catch (e) {
        // A single pull request's reviews may be unavailable (404/410); skip it, don't fail the import.
        if (!(e instanceof GitHubError && (e.status === 404 || e.status === 410))) throw e;
        await this.warn(ctx.row.id, `Reviews for #${p.number} could not be read and were skipped.`);
      }
      added += await ctx.stub!.importReviews(reviews.map((r) => mapReview(r, p.number, ctx.people)).filter((r) => !!r), ctx.row.id);
      if (p.merged) {
        const full = await ctx.gh.get<{ merged_by?: GhUser | null }>(`repos/${src}/pulls/${p.number}`);
        if (full.merged_by) await ctx.stub!.importSetMergedBy(p.number, ctx.people.login(full.merged_by));
      }
    }
    if (pulls.length < PULLS_PER_STEP) return { done: true, added };
    return { done: false, cursor: pulls[pulls.length - 1]!.number, added };
  }

  /** Classic branch protection, mapped to Diffinery's rules. Required checks are renamed to the checks Diffinery's workflows report. */
  private async protection(ctx: Ctx): Promise<StepOutcome> {
    if (!ctx.req.options.protection) return { done: true, skipped: true, message: "Not selected" };
    const src = ctx.row.source;
    const branches = await ctx.gh.all<{ name: string }>(listPath(`repos/${src}/branches`, { protected: "true" }), 500);
    const checkNames = branches.length ? await ctx.stub!.importCheckNames() : {};
    const done: string[] = [];
    for (const b of branches) {
      let p: GhProtection;
      try {
        p = await ctx.gh.get<GhProtection>(`repos/${src}/branches/${encodeURIComponent(b.name)}/protection`);
      } catch (e) {
        if (notAvailable(e)) {
          await this.warn(ctx.row.id, `Branch protection of ${b.name} could not be read (the GitHub token needs admin access to the repository); set it up under Settings → Branch protection.`);
          continue;
        }
        throw e;
      }
      const rules = mapProtection(p);
      rules.requiredChecks = [...new Set(rules.requiredChecks.flatMap((c) => checkNames[c] ?? [c]))];
      await ctx.stub!.importProtection(b.name, rules, ctx.row.id);
      done.push(b.name);
    }
    ctx.summary.protections = done;
    return { done: true, added: done.length, message: done.length ? done.join(", ") : "No protected branches" };
  }

  /**
   * Whether this import may write Actions variables now. Agents can never manage variables, and a
   * human's authority over the target is re-checked at the moment the step runs (not only at create
   * time), so a person who lost org admin in the meantime cannot push variables through an import.
   */
  private async mayManageVariables(ctx: Ctx): Promise<{ ok: true } | { ok: false; reason: string }> {
    const creator = await this.dir.account(ctx.row.created_by);
    if (!creator || creator.kind === "agent") return { ok: false, reason: "skipped (agents cannot manage variables)" };
    const owner = await this.dir.account(ctx.row.target_owner_id);
    if (!owner || !(await this.canImportInto(creator, owner))) return { ok: false, reason: "skipped (you no longer administer the target)" };
    return { ok: true };
  }

  /** Actions variables (values) and secrets (names only: GitHub never returns secret values). */
  private async variables(ctx: Ctx): Promise<StepOutcome> {
    if (!ctx.req.options.variables) return { done: true, skipped: true, message: "Not selected" };
    const may = await this.mayManageVariables(ctx);
    if (!may.ok) return { done: true, skipped: true, message: may.reason };
    // GitHub answers these admin endpoints only with a token (401 "Requires authentication" otherwise).
    if (!ctx.token) {
      await this.warn(ctx.row.id, "Actions variables, secret names and environments were not imported: reading them needs a GitHub token with admin access to the repository. Add them under Settings → Secrets and variables.");
      return { done: true, skipped: true, message: "skipped (needs a GitHub token)" };
    }
    const src = ctx.row.source;
    const read = async <T>(path: string, what: string): Promise<T[]> => {
      try {
        return await ctx.gh.all<T>(path, 1000);
      } catch (e) {
        if (notAvailable(e)) {
          await this.warn(ctx.row.id, `Actions ${what} could not be read (the GitHub token needs admin access, or "Variables"/"Secrets" read permission for fine-grained tokens).`);
          return [];
        }
        throw e;
      }
    };
    const vars = (await read<{ name: string; value: string }>(`repos/${src}/actions/variables?per_page=30`, "variables")).filter((v) => validVarName(v.name));
    for (const v of vars) await ctx.stub!.setVariable(v.name, v.value);
    const secrets = await read<{ name: string }>(`repos/${src}/actions/secrets?per_page=100`, "secrets");
    ctx.summary.variables = vars.map((v) => v.name);
    ctx.summary.secretNames = secrets.map((s) => s.name);
    const env = await this.importEnvironments(ctx, read);
    const envMsg = env ? `, ${env.imported} environments` : "";
    return { done: true, added: vars.length, message: `${vars.length} variables, ${secrets.length} secret names${envMsg}` };
  }

  /**
   * Deployment environments: names, their branch policy, and their variables.
   * Environment secret *names* are listed in the summary but their values are
   * never copied (an admin re-enters them), the same policy as repository
   * secrets. Skipped (with a note) where RepoDO has no environments feature yet.
   */
  private async importEnvironments(ctx: Ctx, read: <T>(path: string, what: string) => Promise<T[]>): Promise<{ imported: number; variables: number; secretNames: string[] } | null> {
    const stub = ctx.stub as unknown as EnvImporter | null;
    if (!stub) return null;
    const caller = this.importCaller(ctx);
    const src = ctx.row.source;
    const envs = await read<GhEnvironment>(`repos/${src}/environments?per_page=100`, "environments");
    if (!envs.length) return null;
    let variables = 0;
    const secretNames: string[] = [];
    try {
      for (const e of envs) {
        if (!e.name || typeof e.name !== "string" || e.name.includes("\0")) continue;
        const policy = e.deployment_branch_policy ?? null;
        await stub.upsertEnvironment(e.name, { deployment_branch_policy: policy }, caller);
        if (policy?.custom_branch_policies) {
          const patterns = await read<{ name?: string; type?: string }>(`repos/${src}/environments/${encodeURIComponent(e.name)}/deployment-branch-policies`, "branch policies");
          for (const p of patterns) if (p.name) await stub.addEnvironmentBranchPattern(e.name, { name: p.name, type: p.type }, caller);
        }
        const envVars = (await read<{ name: string; value: string }>(`repos/${src}/environments/${encodeURIComponent(e.name)}/variables?per_page=100`, "environment variables")).filter((v) => validVarName(v.name));
        for (const v of envVars) {
          await stub.setEnvironmentVariable(e.name, v.name, v.value, caller);
          variables++;
        }
        const envSecrets = await read<{ name: string }>(`repos/${src}/environments/${encodeURIComponent(e.name)}/secrets?per_page=100`, "environment secrets");
        for (const s of envSecrets) secretNames.push(`${e.name}/${s.name}`);
      }
    } catch (e) {
      // RepoDO without an environments feature (the separate branch has not landed): skip quietly.
      if (methodMissing(e)) return null;
      throw e;
    }
    const summary = { imported: envs.length, variables, secretNames };
    ctx.summary.environments = summary;
    return summary;
  }

  /**
   * Releases and their assets. Release rows and asset bytes live in RepoDO's
   * Releases module (`importRelease`/`importReleaseAsset`), which is delivered
   * by a separate branch. Until that lands this step detects the methods are
   * absent and records that the tags were imported with the Git data instead.
   *
   * Each asset is handed to RepoDO as a `{ url }` source on a GitHub host, with
   * the import token in an Authorization header; RepoDO streams the body with a
   * byte cap and drops the credential on any redirect to another host, so the
   * asset bytes are never buffered in this Worker.
   */
  private async importReleases(ctx: Ctx, cursor: StepCursor): Promise<StepOutcome> {
    if (!ctx.req.options.releases) return { done: true, skipped: true, message: "Not selected" };
    const stub = ctx.stub as unknown as ReleaseImporter | null;
    if (!stub) throw fatal("the repository was not created");
    const caller = this.importCaller(ctx);
    // The release asset host must share the API base's origin before the token is attached.
    const apiOrigin = new URL(ctx.row.api_url).origin;
    let next = (cursor as string | null) ?? listPath(`repos/${ctx.row.source}/releases`);
    const totals = ctx.summary.releases ?? { imported: 0, assets: 0, skippedAssets: 0 };
    try {
      for (let i = 0; i < PAGES_PER_STEP; i++) {
        const page = await ctx.gh.page<GhRelease>(next);
        for (const r of page.items) {
          if (!r.tag_name) continue;
          const { id: releaseId, created } = await stub.importRelease(
            { tag_name: r.tag_name, target_commitish: r.target_commitish, name: r.name ?? r.tag_name, body: r.body ?? "", draft: !!r.draft, prerelease: !!r.prerelease, created_at: r.created_at, published_at: r.published_at, author: this.importedActor(ctx, r.author), latest: false },
            caller,
          );
          // A release an earlier try of this import already wrote is updated, not counted again.
          if (created !== false) totals.imported++;
          for (const a of r.assets ?? []) {
            const name = safeAssetName(a.name);
            if (!name) {
              totals.skippedAssets++;
              await this.warn(ctx.row.id, `Release ${r.tag_name}: skipped an asset with an unsafe name "${a.name}".`);
              continue;
            }
            const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "Diffinery-Importer" };
            // Low 3: only attach the token when the asset URL is on the same origin as the API base.
            // On a redirect to another host, RepoDO drops the credential; we never add it cross-origin here.
            let sameOrigin = false;
            try {
              sameOrigin = new URL(a.url).origin === apiOrigin;
            } catch {
              sameOrigin = false;
            }
            if (ctx.token && sameOrigin) headers.authorization = `Bearer ${ctx.token}`;
            try {
              await stub.importReleaseAsset(releaseId, { name, label: a.label ?? undefined, content_type: a.content_type, download_count: a.download_count, created_at: a.created_at, updated_at: a.updated_at, uploader: this.importedActor(ctx, a.uploader) }, { url: a.url, headers }, caller);
              totals.assets++;
            } catch (e) {
              if (methodMissing(e)) throw e;
              totals.skippedAssets++;
              await this.warn(ctx.row.id, `Release ${r.tag_name}: could not import asset "${name}": ${errMsg(e)}`);
            }
          }
        }
        ctx.summary.releases = totals;
        if (!page.next) {
          if (totals.imported === 0) return { done: true, skipped: true, message: "No releases" };
          return { done: true, added: totals.imported, message: `${totals.imported} releases, ${totals.assets} assets${totals.skippedAssets ? `, ${totals.skippedAssets} skipped` : ""}` };
        }
        next = page.next;
      }
    } catch (e) {
      // RepoDO without a releases feature (the separate branch has not landed): the tags came
      // with the Git data, so record that and move on rather than failing the import.
      if (methodMissing(e) && totals.imported === 0) {
        await this.warn(ctx.row.id, "Releases were not imported: this deployment has no releases feature yet. Their tags were imported with the Git data.");
        return { done: true, skipped: true, message: "Not supported here (tags were imported)" };
      }
      throw e;
    }
    return { done: false, cursor: next, added: 0, message: `${totals.imported} releases so far` };
  }

  /** A writer caller for the import's own writes to the new repository (the person or agent who started it). */
  private importCaller(ctx: Ctx): ImportCaller {
    return { id: ctx.row.created_by, login: ctx.repo?.owner_login ?? "importer", kind: "user", role: "admin", importId: ctx.row.id };
  }

  /** Attribute an imported release/asset to a linked account, or to the GitHub user if unlinked. */
  private importedActor(ctx: Ctx, u: GhUser | null | undefined): { id?: string; login: string; kind?: string } {
    const p = ctx.people.person(u);
    return { id: p.id, login: p.login, kind: p.kind };
  }

  /**
   * Last step: pull request refs, cleanup, default branch, archived state, and the summary.
   * The GitHub token is deleted and the push token revoked.
   */
  async finalize(id: string): Promise<void> {
    const ctx = await this.context(id);
    if (!ctx.repo || !ctx.stub) throw fatal("the repository was not created");
    await this.setStep(id, "finalize", { status: "running", startedAt: now() });
    // The server creates refs/pull/N/head from the imported pull requests; then the import's own refs can go.
    const pullRefs = await ctx.stub.importPullRefs(id);
    ctx.summary.pullRefs = { created: pullRefs.created, missing: pullRefs.missing.slice(0, 200) };
    if (pullRefs.missing.length) await this.warn(id, `${pullRefs.missing.length} pull requests have no head commit (their fork was deleted on GitHub): ${pullRefs.missing.slice(0, 20).map((n) => `#${n}`).join(", ")}`);
    await ctx.stub.importDropTempRefs(id);
    const git = parse<GitState>(ctx.row.git, {});
    const patch: { defaultBranch?: string; archived?: boolean } = {};
    if (git.result?.defaultBranch && git.result.defaultBranch !== ctx.repo.default_branch) patch.defaultBranch = git.result.defaultBranch;
    if (ctx.summary.source?.archived) patch.archived = true;
    if (Object.keys(patch).length) await this.dir.updateRepo(ctx.repo, patch);
    const counts = await ctx.stub.importCounts();
    ctx.summary.counts = { issues: counts.issues, pulls: counts.pulls, comments: counts.comments, reviews: counts.reviews, labels: counts.labels, milestones: counts.milestones };
    ctx.summary.findings = mergeFindings(ctx.summary.findings ?? [], (await ctx.stub.importFindings()).map((f) => ({ kind: f.kind, blob: f.blob })));
    await this.saveSummary(id, ctx.summary);
    // Release the import lock: the repository is now open for normal writes.
    await ctx.stub.importEnd(id);
    await this.setStep(id, "finalize", { status: "done", finishedAt: now(), message: `${counts.issues} issues, ${counts.pulls} pull requests` });
    await this.close(ctx.row, "succeeded", null);
    await this.audit(ctx.row, "import.finish", { repo: `${ctx.repo.owner_login}/${ctx.repo.name}`, counts: ctx.summary.counts, findings: ctx.summary.findings.length });
    if (!ctx.row.parent_id) await this.notifyDone(ctx.row, true);
  }

  // ---------------------------------------------------------------- workflow: bulk imports

  /** Organization variables and secret names, when importing an organization into an organization. */
  async bulkOrganization(id: string): Promise<{ wait?: number }> {
    const ctx = await this.context(id);
    await this.setStep(id, "organization", { status: "running", startedAt: now() });
    const owner = await this.dir.account(ctx.row.target_owner_id);
    if (!ctx.req.options.variables || ctx.req.sourceType !== "Organization" || owner?.kind !== "org") {
      await this.setStep(id, "organization", { status: "skipped", message: owner?.kind !== "org" ? "Importing into a personal account" : "Not selected", finishedAt: now() });
      return {};
    }
    // H1: agents can never manage variables; a human's org admin is re-checked at run time.
    const may = await this.mayManageVariables(ctx);
    if (!may.ok) {
      await this.setStep(id, "organization", { status: "skipped", message: may.reason, finishedAt: now() });
      return {};
    }
    const read = async <T>(path: string, what: string): Promise<T[]> => {
      try {
        return await ctx.gh.all<T>(path, 1000);
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        if (notAvailable(e)) {
          await this.warn(id, `Organization ${what} could not be read (the GitHub token needs organization admin access).`);
          return [];
        }
        throw e;
      }
    };
    try {
      const listed = (await read<{ name: string; value: string; visibility?: string }>(`orgs/${ctx.row.source}/actions/variables?per_page=30`, "variables")).filter((v) => validVarName(v.name));
      // Diffinery's organization variables reach every repository, so only GitHub's "all" ones are copied.
      const vars = listed.filter((v) => !v.visibility || v.visibility === "all");
      for (const v of listed.filter((x) => !vars.includes(x))) await this.warn(id, `Organization variable ${v.name} is limited to ${v.visibility === "private" ? "private" : "selected"} repositories on GitHub and was not copied; organization variables on Diffinery reach every repository, so add it to the repositories that need it.`);
      const secrets = await read<{ name: string }>(`orgs/${ctx.row.source}/actions/secrets?per_page=100`, "secrets");
      // Add only variables the organization does not already have; never overwrite an admin's value.
      const { added, skipped } = vars.length ? await this.dir.addOrgVariablesIfAbsent(owner.id, Object.fromEntries(vars.map((v) => [v.name, v.value]))) : { added: [], skipped: [] };
      for (const name of added) await this.audit(ctx.row, "org.variable_set", { org: owner.login, name });
      for (const name of skipped) await this.warn(id, `Organization variable ${name} already exists and was left unchanged.`);
      ctx.summary.orgVariables = added;
      ctx.summary.orgSecretNames = secrets.map((s) => s.name);
      await this.saveSummary(id, ctx.summary);
      const skip = skipped.length ? `, ${skipped.length} kept` : "";
      await this.setStep(id, "organization", { status: "done", count: added.length, message: `${added.length} variables added${skip}, ${secrets.length} secret names`, finishedAt: now() });
      return {};
    } catch (e) {
      if (e instanceof RateLimited) return { wait: e.waitSeconds };
      throw e;
    }
  }

  /** Start queued repository imports of a bulk import, up to its concurrency. */
  async startChildren(parentId: string): Promise<number> {
    const parent = await this.mustRow(parentId);
    if (parent.status !== "running") return 0;
    const req = parse<StoredRequest>(parent.request, {} as StoredRequest);
    const running = (await this.db.prepare("SELECT count(*) AS n FROM imports WHERE parent_id = ? AND status = 'running'").bind(parentId).first<{ n: number }>())?.n ?? 0;
    let started = 0;
    for (let i = running; i < (req.concurrency || 3); i++) {
      // Claim one queued child atomically, so parallel finishers never start the same one twice.
      const next = await this.db
        .prepare("UPDATE imports SET status = 'running', started_at = ?, updated_at = ? WHERE id = (SELECT id FROM imports WHERE parent_id = ? AND status = 'queued' ORDER BY created_at, source LIMIT 1) AND status = 'queued' RETURNING id, attempt")
        .bind(now(), now(), parentId)
        .first<{ id: string; attempt: number }>();
      if (!next) break;
      try {
        await this.launch(next.id, next.attempt);
        started++;
      } catch (e) {
        await this.fail(next.id, `could not start: ${errMsg(e)}`);
      }
    }
    await this.bulkProgress(parentId);
    return started;
  }

  /** Counts of a bulk import's repositories, written to its "repositories" step. */
  async bulkProgress(parentId: string): Promise<{ open: number }> {
    const rows = (await this.db.prepare("SELECT status, count(*) AS n FROM imports WHERE parent_id = ? GROUP BY status").bind(parentId).all<{ status: ImportStatus; n: number }>()).results;
    const n = (s: ImportStatus) => rows.find((r) => r.status === s)?.n ?? 0;
    const total = rows.reduce((a, r) => a + r.n, 0);
    const open = n("queued") + n("running");
    const finished = total - open;
    await this.setStep(parentId, "repositories", { status: open ? "running" : "done", count: finished, message: `${finished} of ${total} finished (${n("succeeded")} imported, ${n("failed")} failed)` });
    return { open };
  }

  /** After a repository import of a bulk import ends: start the next one, or wake the parent when none are left. */
  async afterChild(id: string): Promise<void> {
    const row = await this.row(id);
    if (!row?.parent_id) return;
    const parent = await this.row(row.parent_id);
    if (!parent || parent.status !== "running") return;
    await this.startChildren(parent.id);
    const { open } = await this.bulkProgress(parent.id);
    if (!open) {
      try {
        await (await this.env.IMPORT_WORKFLOW.get(`${parent.id}-${parent.attempt}`)).sendEvent({ type: "children-done", payload: {} });
      } catch (e) {
        console.error("waking bulk import failed", parent.id, e);
      }
    }
  }

  async bulkFinish(id: string): Promise<void> {
    const row = await this.mustRow(id);
    const children = await this.children(id);
    const count = (s: ImportStatus) => children.filter((c) => c.status === s).length;
    const summary = parse<ImportSummary>(row.summary, {});
    summary.children = { total: children.length, succeeded: count("succeeded"), failed: count("failed"), cancelled: count("cancelled"), open: count("queued") + count("running") };
    await this.saveSummary(id, summary);
    await this.setStep(id, "finalize", { status: "done", finishedAt: now(), message: `${summary.children.succeeded} of ${summary.children.total} repositories imported` });
    // Children still open at finalize (a transfer that never finished within the cap) count as not imported,
    // so a bulk import never reports success while a repository import is still running.
    const notImported = summary.children.failed + summary.children.cancelled + summary.children.open;
    await this.close(row, notImported ? "failed" : "succeeded", notImported ? `${notImported} of ${children.length} repositories were not imported` : null);
    await this.audit(row, "import.finish", { children: summary.children });
    await this.notifyDone(row, !notImported);
  }

  // ---------------------------------------------------------------- the Git transfer agent

  /** The agent's credentials: this import's own *current* push token, while the import runs. */
  private async agentRow(id: string, importId: string | undefined, tokenId: string | undefined): Promise<ImportRow> {
    if (importId !== id) throw new HttpError(403, "this token does not belong to this import");
    const row = await this.row(id);
    if (!row || row.status !== "running" || !row.repo_id) throw new HttpError(409, "this import is not running");
    // M4: only the import's current push token (this attempt's) is accepted; a stale token is refused.
    if (!tokenId || row.push_token_id !== tokenId) throw new HttpError(403, "this push token is no longer current for the import");
    return row;
  }

  async agentSpec(id: string, importId: string | undefined, tokenId: string | undefined, pushToken: string): Promise<ImportSpec> {
    const row = await this.agentRow(id, importId, tokenId);
    const summary = parse<ImportSummary>(row.summary, {});
    const req = parse<StoredRequest>(row.request, {} as StoredRequest);
    const repo = await this.dir.repoById(row.repo_id!);
    if (!repo || !summary.source) throw new HttpError(409, "the repository was not created");
    const cloneUrl = new URL(summary.source.cloneUrl);
    if (cloneUrl.host !== webHostOf(row.api_url)) throw new HttpError(409, "the clone URL is not on the GitHub host being imported from");
    await this.db.prepare("UPDATE imports SET git = json_set(COALESCE(git, '{}'), '$.phase', 'clone', '$.message', ?, '$.at', ?), updated_at = ? WHERE id = ?").bind(`Cloning ${row.source}`, now(), now(), id).run();
    return {
      importId: id,
      source: { fullName: row.source, cloneUrl: cloneUrl.toString(), defaultBranch: summary.source.defaultBranch },
      githubToken: row.token_ciphertext ? await decryptSecret(this.env, `import:${id}`, row.token_ciphertext) : null,
      target: { fullName: `${repo.owner_login}/${repo.name}`, pushUrl: `${this.env.PUBLIC_URL}/${repo.owner_login}/${repo.name}.git` },
      pushToken,
      lfs: req.options.lfs,
      secrets: req.options.secrets,
      bypassReason: `Imported from GitHub ${row.source}`,
      chunkBytes: DEFAULT_CHUNK_BYTES,
    };
  }

  async agentProgress(id: string, importId: string | undefined, tokenId: string | undefined, p: ImportProgress): Promise<void> {
    await this.agentRow(id, importId, tokenId);
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    await this.db
      .prepare("UPDATE imports SET git = json_set(COALESCE(git, '{}'), '$.phase', ?, '$.message', ?, '$.chunks', ?, '$.bytes', ?, '$.at', ?), updated_at = ? WHERE id = ?")
      .bind(String(p.phase ?? "").slice(0, 20), String(p.message ?? "").slice(0, 300), n(p.chunks), n(p.bytes), now(), now(), id)
      .run();
  }

  /** The agent's result. The push token is revoked now, and the workflow is woken. */
  async agentComplete(id: string, importId: string | undefined, tokenId: string | undefined, raw: ImportGitResult): Promise<void> {
    const row = await this.agentRow(id, importId, tokenId);
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
    const result: ImportGitResult = {
      ok: raw?.ok === true,
      error: s(raw?.error, 2000),
      branches: n(raw?.branches),
      tags: n(raw?.tags),
      pullRefs: n(raw?.pullRefs),
      chunks: n(raw?.chunks),
      bytes: n(raw?.bytes),
      lfsObjects: n(raw?.lfsObjects),
      lfsBytes: n(raw?.lfsBytes),
      defaultBranch: s(raw?.defaultBranch, 255) ?? null,
      secretFindings: (Array.isArray(raw?.secretFindings) ? raw.secretFindings : []).slice(0, 100).map((f) => ({ kind: s(f?.kind, 100) ?? "secret", blob: s(f?.blob, 64) ?? "", path: s(f?.path, 500) })),
      warnings: (Array.isArray(raw?.warnings) ? raw.warnings : []).slice(0, 50).map((w) => s(w, 500) ?? ""),
    };
    await this.db
      .prepare("UPDATE imports SET git = json_set(COALESCE(git, '{}'), '$.result', json(?), '$.phase', ?, '$.message', ?, '$.at', ?), updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(result), result.ok ? "done" : "failed", result.ok ? "Git data copied" : (result.error ?? "failed").slice(0, 300), now(), now(), id)
      .run();
    if (row.push_token_id) await this.dir.revokeTokenById(row.push_token_id);
    await this.wake(row);
  }

  /** The import container stopped. If its agent never reported, the transfer failed (and may be retried). */
  async gitStopped(id: string, exitCode: number | null, stamp?: string): Promise<void> {
    const row = await this.row(id);
    if (!row || row.status !== "running") return;
    const git = parse<GitState>(row.git, {});
    // Ignore a late stop from an earlier attempt or try (M4 / Correctness 7): only the current one may fail the transfer.
    if (stamp && stamp !== `${row.attempt}-${git.tries ?? 0}`) return;
    if (git.result) return;
    const result = { ok: false, error: `the import container stopped before finishing (exit code ${exitCode ?? "unknown"})`, branches: 0, tags: 0, pullRefs: 0, chunks: 0, bytes: 0, lfsObjects: 0, lfsBytes: 0, defaultBranch: null, secretFindings: [], warnings: [] } satisfies ImportGitResult;
    await this.db.prepare("UPDATE imports SET git = json_set(COALESCE(git, '{}'), '$.result', json(?)), updated_at = ? WHERE id = ?").bind(JSON.stringify(result), now(), id).run();
    if (row.push_token_id) await this.dir.revokeTokenById(row.push_token_id);
    await this.wake(row);
  }

  private async wake(row: ImportRow): Promise<void> {
    try {
      await (await this.env.IMPORT_WORKFLOW.get(`${row.id}-${row.attempt}`)).sendEvent({ type: "git-done", payload: {} });
    } catch (e) {
      // The workflow also checks on its own every few minutes.
      console.error("waking import failed", row.id, e);
    }
  }

  // ---------------------------------------------------------------- linked GitHub accounts

  async links(accountId: string): Promise<Array<{ id: string; host: string; apiBase: string; login: string; externalId: string; createdAt: string }>> {
    const r = await this.db.prepare("SELECT * FROM account_links WHERE account_id = ? ORDER BY created_at").bind(accountId).all<Record<string, string>>();
    return r.results.map((l) => ({ id: l.id!, host: webHostOf(l.api_base!), apiBase: l.api_base!, login: l.external_login!, externalId: l.external_id!, createdAt: l.created_at! }));
  }

  /**
   * A per-account, per-host nonce the person puts in a PUBLIC gist to prove they control the GitHub
   * account. Derived (HMAC of the master key) so it needs no storage and is stable until linked.
   */
  async linkChallenge(account: Account, apiUrlRaw: string | null): Promise<{ nonce: string; apiBase: string; host: string; gistsUrl: string }> {
    if (account.kind !== "user") throw new HttpError(403, "only people can link GitHub accounts");
    const apiBase = normalizeApiUrl(apiUrlRaw, this.dev);
    const [nonce] = await this.linkNonces(account.id, apiBase);
    return { nonce: nonce!, apiBase, host: webHostOf(apiBase), gistsUrl: `${apiBase}/gists` };
  }

  /**
   * The nonce under MASTER_KEY first, the one to show; then, while MASTER_KEY is being rotated, the one
   * under MASTER_KEY_PREV, which a gist made before the rotation carries and which still proves the link.
   */
  private async linkNonces(accountId: string, apiBase: string): Promise<string[]> {
    return Promise.all(this.linkSecrets().map(async (k) => `diffinery-link-${hex16(await hmacSha256(k, `github-link:${accountId}:${apiBase}`))}`));
  }

  /** The keys of gist nonces and OAuth state: the master keys, or "dev" when none is set. */
  private linkSecrets(): string[] {
    return signingSecrets(this.env, "dev", "");
  }

  /**
   * Link a GitHub account by gist proof (no token): the person's nonce must appear in one of their
   * PUBLIC gists, read unauthenticated. The numeric id comes from the public user profile, so a
   * later login rename cannot silently re-point the link.
   */
  async linkByGist(account: Account, login: string, apiUrlRaw: string | null): Promise<{ id: string; host: string; login: string }> {
    if (account.kind !== "user") throw new HttpError(403, "only people can link GitHub accounts");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new HttpError(422, "that is not a valid GitHub login");
    const apiBase = normalizeApiUrl(apiUrlRaw, this.dev);
    const nonces = await this.linkNonces(account.id, apiBase);
    const gh = new GitHubClient(apiBase, null); // unauthenticated: public data only
    let gists: Array<{ id: string; description?: string | null; public?: boolean }>;
    let user: { login: string; id: number };
    try {
      gists = await gh.get<typeof gists>(`users/${login}/gists?per_page=100`);
      user = await gh.get<{ login: string; id: number }>(`users/${login}`);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) throw new HttpError(422, `GitHub user ${login} was not found`);
      if (e instanceof RateLimited) throw new HttpError(429, e.message);
      throw new HttpError(502, `could not reach GitHub: ${errMsg(e)}`);
    }
    if (!user?.login || user.id === undefined) throw new HttpError(502, "GitHub did not return a user");
    const proven = await this.gistHasNonce(gh, gists, nonces);
    if (!proven) throw new HttpError(422, `create a PUBLIC gist whose description or a file contains ${nonces[0]}, then try again`);
    return this.saveLink(account, apiBase, String(user.id), user.login);
  }

  /**
   * Whether one of the user's public gists contains one of the nonces. The gist bodies are read through the
   * same API host (GET /gists/{id}), never a cross-host raw URL, so no credential or request leaves
   * the allowlisted host.
   */
  private async gistHasNonce(gh: GitHubClient, gists: Array<{ id: string; description?: string | null; public?: boolean }>, nonces: string[]): Promise<boolean> {
    const has = (text: string) => nonces.some((n) => text.includes(n));
    let fetched = 0;
    for (const g of gists.slice(0, 100)) {
      if (g.public === false || !g.id) continue;
      if (has(g.description ?? "")) return true;
      if (fetched >= 20) continue; // bound how many gist bodies we read
      fetched++;
      try {
        const full = await gh.get<{ files?: Record<string, { content?: string | null }> }>(`gists/${encodeURIComponent(g.id)}`);
        for (const f of Object.values(full.files ?? {})) if (has(f.content ?? "")) return true;
      } catch {
        // skip an unreadable gist
      }
    }
    return false;
  }

  private async saveLink(account: Account, apiBase: string, externalId: string, login: string): Promise<{ id: string; host: string; login: string }> {
    const existing = await this.db.prepare("SELECT * FROM account_links WHERE provider = 'github' AND api_base = ? AND external_id = ?").bind(apiBase, externalId).first<Record<string, string>>();
    if (existing && existing.account_id !== account.id) throw new HttpError(409, `GitHub user ${login} is linked to another Diffinery account`);
    const id = existing?.id ?? newId();
    await this.db
      .prepare("INSERT INTO account_links (id, account_id, provider, api_base, external_id, external_login, created_at) VALUES (?, ?, 'github', ?, ?, ?, ?) ON CONFLICT(provider, api_base, external_id) DO UPDATE SET external_login = excluded.external_login")
      .bind(id, account.id, apiBase, externalId, login, now())
      .run();
    await this.dir.audit({ actorId: account.id, actorLogin: account.login, action: "account.link_github", target: `${webHostOf(apiBase)}/${login}` });
    return { id, host: webHostOf(apiBase), login };
  }

  // ---------------------------------------------------------------- optional OAuth web flow

  /** Whether a GitHub OAuth app is configured for the web link flow. */
  get oauthEnabled(): boolean {
    return !!(this.env.GITHUB_OAUTH_CLIENT_ID && this.env.GITHUB_OAUTH_CLIENT_SECRET);
  }

  /** The GitHub authorize URL with a state bound (HMAC) to this account, so a callback cannot be replayed for another. */
  async oauthStart(account: Account): Promise<string> {
    if (!this.oauthEnabled) throw new HttpError(404, "GitHub OAuth is not configured");
    const state = await this.oauthState(this.linkSecrets()[0]!, account.id);
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", this.env.GITHUB_OAUTH_CLIENT_ID!);
    u.searchParams.set("redirect_uri", `${this.env.PUBLIC_URL}/settings/linked/github/callback`);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("state", state);
    u.searchParams.set("allow_signup", "false");
    return u.toString();
  }

  private async oauthState(secret: string, accountId: string): Promise<string> {
    return `${accountId}.${hex16(await hmacSha256(secret, `github-oauth:${accountId}`))}`;
  }

  async oauthCallback(account: Account, code: string, state: string): Promise<{ id: string; host: string; login: string }> {
    if (!this.oauthEnabled) throw new HttpError(404, "GitHub OAuth is not configured");
    // A flow started just before MASTER_KEY was rotated carries a state made with MASTER_KEY_PREV.
    if (!code || !state || !(await matchesAnyKey(this.linkSecrets(), state, (k) => this.oauthState(k, account.id)))) throw new HttpError(422, "invalid or expired OAuth state");
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.env.GITHUB_OAUTH_CLIENT_ID, client_secret: this.env.GITHUB_OAUTH_CLIENT_SECRET, code, redirect_uri: `${this.env.PUBLIC_URL}/settings/linked/github/callback` }),
    });
    const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!tok.access_token) throw new HttpError(422, "GitHub did not return an access token");
    let user: { login: string; id: number };
    try {
      user = await new GitHubClient("https://api.github.com", tok.access_token).get<{ login: string; id: number }>("user");
    } catch (e) {
      throw new HttpError(502, `could not read the GitHub user: ${errMsg(e)}`);
    }
    if (!user?.login || user.id === undefined) throw new HttpError(502, "GitHub did not return a user");
    return this.saveLink(account, "https://api.github.com", String(user.id), user.login);
  }

  async unlink(account: Account, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM account_links WHERE id = ? AND account_id = ?").bind(id, account.id).run();
    await this.dir.audit({ actorId: account.id, actorLogin: account.login, action: "account.unlink_github", target: id });
  }

  /** Site-admin action: clear any account's GitHub link (e.g. after an account change of hands). Audited. */
  async clearLink(admin: Account, id: string): Promise<void> {
    if (!admin.site_admin) throw new HttpError(403, "site admin only");
    const link = await this.db.prepare("SELECT * FROM account_links WHERE id = ?").bind(id).first<Record<string, string>>();
    if (!link) throw new HttpError(404, "link not found");
    await this.db.prepare("DELETE FROM account_links WHERE id = ?").bind(id).run();
    await this.dir.audit({ actorId: admin.id, actorLogin: admin.login, action: "account.link_cleared", target: `${webHostOf(link.api_base!)}/${link.external_login}`, detail: { account: link.account_id } });
  }
}

/** Findings from the agent (with paths) and from the server's push protection (full blob ids), one per blob. */
function mergeFindings(a: ImportSecretFinding[], b: ImportSecretFinding[]): ImportSecretFinding[] {
  const out = [...a];
  for (const f of b) {
    const same = out.find((x) => x.kind === f.kind && (x.blob.startsWith(f.blob) || f.blob.startsWith(x.blob)));
    if (!same) out.push(f);
    else {
      if (f.blob.length > same.blob.length) same.blob = f.blob;
      same.path ??= f.path;
    }
  }
  return out.slice(0, 200);
}

interface GhRepo {
  name: string;
  full_name: string;
  owner?: { login: string };
  private?: boolean;
  visibility?: string;
  fork?: boolean;
  archived?: boolean;
  description?: string | null;
  homepage?: string | null;
  topics?: string[];
  default_branch?: string;
  clone_url?: string;
  html_url?: string;
  /** Approximate size of the repository on GitHub, in KB. */
  size?: number;
}
