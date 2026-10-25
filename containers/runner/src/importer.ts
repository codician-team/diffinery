/**
 * Import mode: copy a repository's Git data from GitHub into Diffinery.
 *
 * Workers can't run git and a push request is capped (Diffinery refuses pushes
 * over 100 MB, and a repository's Durable Object has 128 MB of memory), so this
 * runs in a container: `git clone --mirror` from GitHub, then push history in
 * chunks that stay well under the cap (first-parent walks to temporary refs,
 * merged side branches first, and object batches for single huge commits), then
 * every branch and tag, pull request heads to `refs/diffinery-import/pull/N`
 * (the server creates `refs/pull/N/head` from the imported pull request and
 * then drops these), then Git LFS objects.
 *
 * Tokens never appear in argv or logs: git reads them from GIT_CONFIG_* environment
 * entries scoped to one host each. Pushes carry `-o diffinery-import`, which the
 * server honours only for this import's own token, so they trigger no workflows,
 * webhooks or notifications.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ImportGitResult, ImportProgress, ImportSecretFinding, ImportSpec } from "@diffinery/shared";
import { RunnerApi } from "./api.js";
import { IMPORT_REF_PREFIX, batchBySize, furthestWithin, importDestination, importRefKind, isSecretRejection, isSizeRejection, parsePorcelain, parseSecretFindings, sortRefsForImport, storageRejection } from "./import-plan.js";
import { exec } from "./util.js";

export interface ImportAgentOptions {
  apiUrl: string;
  importId: string;
  token: string;
  workRoot: string;
  /** Overrides the spec's push size budget (tests use a small one to exercise chunking). */
  chunkBytes?: number;
  /** Overrides LARGE_BLOB_BYTES (tests use a small one). */
  largeBlobBytes?: number;
  log?: (line: string) => void;
}

/** Chunk refs; only these are deleted at the end (pull request heads stay until the server has created refs/pull/N/head). */
const TEMP_PREFIX = `${IMPORT_REF_PREFIX}tmp/`;
const MIN_BUDGET = 64 * 1024;
/**
 * Files this large are pushed first, each version whole: sent as a delta, the server would hold the
 * version it is based on and the one it rebuilds at once, which it can't for files past about 30 MB
 * (a 32 MB file with a few versions once stopped an import). Whole, a large file is hashed and
 * stored as it streams in, up to the 100 MB a push may carry.
 */
const LARGE_BLOB_BYTES = 16 * 1024 * 1024;
const REF_BATCH = 200;

export class ImportError extends Error {}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `http.<origin>/.extraHeader` entry: the credential goes to that host only. */
function authEntry(url: string, user: string, password: string): [string, string] {
  return [`http.${new URL(url).origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`];
}

function withConfig(env: NodeJS.ProcessEnv, entries: Array<[string, string]>): NodeJS.ProcessEnv {
  const out = { ...env };
  let n = Number(out.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isInteger(n) || n < 0) n = 0;
  for (const [k, v] of entries) {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** Removes anything that looks like a credential from text we report. */
function redact(s: string, secrets: string[]): string {
  let out = s;
  for (const x of secrets) if (x) out = out.split(x).join("***");
  return out.replace(/(Authorization:\s*\w+\s+)\S+/gi, "$1***");
}

class GitRunner {
  constructor(
    readonly dir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly secrets: string[],
  ) {}

  async run(args: string[], o: { input?: string; allowFail?: boolean; cwd?: string; maxCapture?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const r = await exec("git", args, { cwd: o.cwd ?? this.dir, env: this.env, input: o.input, capture: true, maxCapture: o.maxCapture ?? 256 * 1024 * 1024 });
    const res = { code: r.exitCode, stdout: r.stdout, stderr: redact(r.stderr, this.secrets) };
    if (r.exitCode !== 0 && !o.allowFail) throw new ImportError(`git ${args[0]} failed: ${res.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500)}`);
    return res;
  }

  async lines(args: string[], input?: string): Promise<string[]> {
    return (await this.run(args, { input })).stdout.split("\n").filter(Boolean);
  }
}

/** Fetch the spec, transfer everything, and report the result. Returns the result it reported. */
export async function runImportAgent(o: ImportAgentOptions): Promise<ImportGitResult> {
  const log = o.log ?? ((l: string) => process.stdout.write(`[diffinery-import] ${l}\n`));
  const api = new RunnerApi(`${o.apiUrl.replace(/\/$/, "")}/api/v3/diffinery/imports/${encodeURIComponent(o.importId)}/agent`, o.token);
  const spec = (await (await api.request("/spec", { retries: 8 })).json()) as ImportSpec;
  let lastProgress = 0;
  const progress = async (p: ImportProgress, force = false) => {
    log(p.message);
    if (!force && Date.now() - lastProgress < 2000) return;
    lastProgress = Date.now();
    await api.request("/progress", { method: "POST", json: p, retries: 2 }).catch((e) => log(`progress report failed: ${errMsg(e)}`));
  };
  let result: ImportGitResult;
  try {
    result = await transfer(spec, { workRoot: o.workRoot, chunkBytes: o.chunkBytes, largeBlobBytes: o.largeBlobBytes, progress, log });
  } catch (e) {
    result = emptyResult();
    result.ok = false;
    result.error = redact(errMsg(e), [spec.githubToken ?? "", spec.pushToken]);
    if (e instanceof SecretsFound) result.secretFindings = e.findings;
  }
  await api.request("/complete", { method: "POST", json: result, retries: 10 });
  return result;
}

class SecretsFound extends ImportError {
  constructor(
    message: string,
    readonly findings: ImportSecretFinding[],
  ) {
    super(message);
  }
}

function emptyResult(): ImportGitResult {
  return { ok: true, branches: 0, tags: 0, pullRefs: 0, chunks: 0, bytes: 0, lfsObjects: 0, lfsBytes: 0, defaultBranch: null, secretFindings: [], warnings: [] };
}

export interface TransferOptions {
  workRoot: string;
  chunkBytes?: number;
  /** Overrides LARGE_BLOB_BYTES (tests use a small one). */
  largeBlobBytes?: number;
  progress: (p: ImportProgress, force?: boolean) => Promise<void>;
  log: (line: string) => void;
}

/** The whole Git transfer for one spec. Exported for tests. */
export async function transfer(spec: ImportSpec, o: TransferOptions): Promise<ImportGitResult> {
  const result = emptyResult();
  const secrets = [spec.githubToken ?? "", spec.pushToken];
  const root = path.join(o.workRoot, `import-${spec.importId.replace(/[^\w-]/g, "")}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const mirror = path.join(root, "mirror.git");
  // The clone URL must be https (a loopback host or a file:// path is allowed for local test
  // doubles), so the token never travels in the clear and never reaches a non-GitHub host. In
  // production the orchestrator always supplies GitHub's https clone URL.
  const localDouble = spec.source.cloneUrl.startsWith("file://");
  const cloneHost = localDouble ? "" : new URL(spec.source.cloneUrl).hostname.toLowerCase();
  const loopback = cloneHost === "localhost" || cloneHost === "127.0.0.1" || cloneHost === "::1";
  if (!spec.source.cloneUrl.startsWith("https://") && !loopback && !localDouble) throw new Error("the clone URL must use https");
  // Pin the LFS endpoint to each operation's own host so a repository's .lfsconfig cannot redirect
  // LFS traffic (and a token) to another host: the source host for the fetch, the target host for
  // the push. A command-line `-c lfs.url=` overrides .lfsconfig, so we set it per command rather
  // than globally (a global lfs.url would also misdirect the push to Diffinery back at the source).
  const sourceLfsUrl = `${spec.source.cloneUrl.replace(/\.git$/, "")}.git/info/lfs`;
  const targetLfsUrl = `${spec.target.pushUrl.replace(/\.git$/, "")}.git/info/lfs`;
  const entries: Array<[string, string]> = [
    ["credential.helper", ""],
    ["protocol.version", "2"],
    // Never follow an HTTP redirect: a redirect could carry the credential to another host.
    ["http.followRedirects", "false"],
    ["lfs.locksverify", "false"],
    ["lfs.concurrenttransfers", "4"],
    ["core.askPass", "true"],
  ];
  if (spec.githubToken) entries.push(authEntry(spec.source.cloneUrl, "x-access-token", spec.githubToken));
  entries.push(authEntry(spec.target.pushUrl, "x-token", spec.pushToken));
  const env = withConfig(
    {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_AUTHOR_NAME: "Diffinery import",
      GIT_AUTHOR_EMAIL: "import@diffinery.invalid",
      GIT_COMMITTER_NAME: "Diffinery import",
      GIT_COMMITTER_EMAIL: "import@diffinery.invalid",
    },
    entries,
  );
  const git = new GitRunner(mirror, env, secrets);
  try {
    // ------------------------------------------------------------ clone
    await o.progress({ phase: "clone", message: `Cloning ${spec.source.fullName}` }, true);
    await git.run(["clone", "--mirror", "--quiet", spec.source.cloneUrl, mirror], { cwd: root });
    const refLines = await git.lines(["for-each-ref", "--format=%(objectname) %(objecttype) %(*objectname) %(*objecttype) %(refname)"]);
    const refs = new Map<string, { oid: string; commit: string | null }>();
    for (const line of refLines) {
      const [oid, type, peeled, peeledType, ...rest] = line.split(" ");
      const name = rest.join(" ");
      if (!importRefKind(name)) continue;
      const commit = type === "commit" ? oid! : peeledType === "commit" ? peeled! : null;
      refs.set(name, { oid: oid!, commit });
    }
    const ordered = sortRefsForImport([...refs.keys()], spec.source.defaultBranch);
    if (!ordered.length) {
      await o.progress({ phase: "done", message: "The GitHub repository is empty" }, true);
      return result;
    }

    // ------------------------------------------------------------ LFS objects from GitHub
    if (spec.lfs) {
      await o.progress({ phase: "lfs-fetch", message: "Fetching Git LFS objects" }, true);
      const f = await git.run(["-c", `lfs.url=${sourceLfsUrl}`, "lfs", "fetch", "--all", "origin"], { allowFail: true });
      if (f.code !== 0) result.warnings.push(`Some Git LFS objects could not be fetched from GitHub: ${lastLine(f.stderr)}`);
    }

    // ------------------------------------------------------------ history, in chunks
    const pushOpts = ["-o", "diffinery-import", ...(spec.secrets === "bypass" ? ["-o", `allow-secrets=${spec.bypassReason}`] : [])];
    const pusher = new ChunkPusher(git, spec, pushOpts, o, result);
    await pusher.loadRemoteState();
    await pusher.pushLargeBlobs(ordered.map((n) => refs.get(n)!.commit).filter((c): c is string => !!c), o.largeBlobBytes ?? LARGE_BLOB_BYTES);
    for (const name of ordered) {
      const ref = refs.get(name)!;
      if (ref.commit) await pusher.ensurePushed(ref.commit, name);
    }

    // ------------------------------------------------------------ the refs themselves
    await o.progress({ phase: "refs", message: `Creating ${ordered.length} branches, tags and pull request refs`, chunks: result.chunks, bytes: result.bytes }, true);
    for (let i = 0; i < ordered.length; i += REF_BATCH) {
      const batch = ordered.slice(i, i + REF_BATCH);
      const out = await pusher.push(batch.map((r) => `+${r}:${importDestination(r)}`));
      const status = new Map(parsePorcelain(out.stdout).map((s) => [s.ref, s]));
      for (const r of batch) {
        const s = status.get(importDestination(r));
        if (out.code !== 0 && !s) throw new ImportError(`pushing refs failed: ${pushFailure(out)}`);
        if (s && !s.ok) {
          result.warnings.push(`${r} was not imported: ${s.reason}`);
          continue;
        }
        const kind = importRefKind(r);
        if (kind === "branch") result.branches++;
        else if (kind === "tag") result.tags++;
        else if (kind === "pull") result.pullRefs++;
      }
    }
    if (refs.has(`refs/heads/${spec.source.defaultBranch}`)) result.defaultBranch = spec.source.defaultBranch;

    // ------------------------------------------------------------ LFS objects to Diffinery
    if (spec.lfs) {
      const { count, bytes } = await lfsStore(mirror);
      if (count > 0) {
        await o.progress({ phase: "lfs-push", message: `Uploading ${count} Git LFS objects` }, true);
        const p = await git.run(["-c", `lfs.url=${targetLfsUrl}`, "lfs", "push", "--all", spec.target.pushUrl], { allowFail: true });
        if (p.code !== 0) result.warnings.push(`Some Git LFS objects could not be uploaded: ${lastLine(p.stderr)}`);
        result.lfsObjects = count;
        result.lfsBytes = bytes;
      }
    }

    // ------------------------------------------------------------ cleanup
    await o.progress({ phase: "cleanup", message: "Removing temporary refs" }, true);
    await pusher.deleteTempRefs();
    result.secretFindings = await pusher.findingsWithPaths();
    await o.progress({ phase: "done", message: `Imported ${result.branches} branches, ${result.tags} tags and ${result.pullRefs} pull request refs`, chunks: result.chunks, bytes: result.bytes }, true);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const lastLine = (s: string) =>
  s
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .slice(-1)[0]
    ?.slice(0, 300) ?? "";

/**
 * Why a push failed, in the server's words: why it couldn't unpack the push, else the reason on a
 * rejected ref (`--porcelain` puts it on stdout), else the last line of stderr other than git's
 * generic "failed to push some refs".
 */
export const pushFailure = (out: { stdout: string; stderr: string }) =>
  /remote unpack failed: (.+)/.exec(out.stderr)?.[1]?.trim().slice(0, 300) ||
  parsePorcelain(out.stdout).find((s) => !s.ok)?.reason.slice(0, 300) ||
  lastLine(out.stderr.split("\n").filter((l) => !/^error: failed to push some refs/.test(l)).join("\n")) ||
  lastLine(out.stderr) ||
  lastLine(out.stdout);

/** Count and size of the LFS objects in a bare repository's local store. */
async function lfsStore(gitDir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/^[0-9a-f]{64}$/.test(e.name)) {
        count++;
        bytes += (await stat(p)).size;
      }
    }
  };
  await walk(path.join(gitDir, "lfs", "objects"));
  return { count, bytes };
}

/**
 * Pushes history so that every request stays under the budget. The server keeps
 * what it has under temporary refs, so later pushes (and a restarted import) only
 * send what is missing.
 */
class ChunkPusher {
  private haves: string[] = [];
  private haveSet = new Set<string>();
  private budget: number;
  private temp = 0;
  private tempRefs: string[] = [];
  private findings = new Map<string, ImportSecretFinding>();

  constructor(
    private readonly git: GitRunner,
    private readonly spec: ImportSpec,
    private readonly pushOpts: string[],
    private readonly o: TransferOptions,
    private readonly result: ImportGitResult,
  ) {
    this.budget = Math.max(MIN_BUDGET, o.chunkBytes ?? spec.chunkBytes);
  }

  /** Objects the server already has (a resumed import) count as pushed. */
  async loadRemoteState(): Promise<void> {
    const r = await this.git.run(["ls-remote", this.spec.target.pushUrl], { allowFail: true });
    if (r.code !== 0) throw new ImportError(`cannot reach the Diffinery repository: ${lastLine(r.stderr)}`);
    const oids = [...new Set(r.stdout.split("\n").map((l) => l.split("\t")[0]!).filter((x) => /^[0-9a-f]{40}$/.test(x)))];
    if (!oids.length) return;
    const present = await this.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${oids.join("\n")}\n` });
    for (const line of present.stdout.split("\n")) {
      const [oid, type] = line.split(" ");
      // Chunks of history are commits; batches of files are trees (see pushBlobs).
      if (type === "commit" || type === "tree") this.addHave(oid!);
    }
    for (const line of r.stdout.split("\n")) {
      const ref = line.split("\t")[1];
      if (ref?.startsWith(TEMP_PREFIX)) this.tempRefs.push(ref);
    }
    this.temp = this.tempRefs.length;
  }

  private addHave(oid: string): void {
    if (this.haveSet.has(oid)) return;
    this.haveSet.add(oid);
    this.haves.push(oid);
  }

  private notHaves(): string {
    return this.haves.map((h) => `^${h}\n`).join("");
  }

  /** Bytes on disk of everything reachable from `tip` that the server doesn't have. */
  async sizeOf(tip: string): Promise<number> {
    const r = await this.git.run(["rev-list", "--objects", "--disk-usage", "--stdin"], { input: `${tip}\n${this.notHaves()}` });
    return Number(r.stdout.trim()) || 0;
  }

  /** Make sure the server has `tip` and everything it needs. */
  async ensurePushed(tip: string, label: string): Promise<void> {
    if (this.haveSet.has(tip)) return;
    let chain = await this.git.lines(["rev-list", "--first-parent", "--reverse", "--stdin"], `${tip}\n${this.notHaves()}`);
    while (chain.length) {
      const sizes = new Map<number, number>();
      const best = await furthestWithin(
        chain.length,
        async (i) => {
          const s = await this.sizeOf(chain[i]!);
          sizes.set(i, s);
          return s;
        },
        this.budget,
      );
      if (best) {
        if (!(await this.pushTemp(chain[best.index]!, best.size, label))) continue;
        chain = chain.slice(best.index + 1);
        continue;
      }
      // One first-parent step is over budget: push the side branches it merges first,
      // then, if it still is, its new objects in batches.
      const commit = chain[0]!;
      const parents = (await this.git.lines(["rev-list", "--parents", "-n", "1", commit]))[0]!.split(" ").slice(2);
      for (const p of parents) await this.ensurePushed(p, label);
      if ((await this.sizeOf(commit)) > this.budget) await this.pushObjectBatches(commit, label);
      if (!(await this.pushTemp(commit, await this.sizeOf(commit), label))) continue;
      chain = chain.slice(1);
    }
  }

  /**
   * Every blob of `minBytes` or more in the history of `tips` that the server doesn't have yet, pushed
   * before the history and with no deltas (see LARGE_BLOB_BYTES). The history's pushes then leave
   * them out, as the server has them under a temporary ref.
   */
  async pushLargeBlobs(tips: string[], minBytes: number): Promise<void> {
    if (!tips.length) return;
    // Blobs of minBytes or more are the ones the filter leaves out, printed with a leading "~".
    const listed = await this.git.lines(["rev-list", "--objects", `--filter=blob:limit=${minBytes}`, "--filter-print-omitted", "--stdin"], `${[...new Set(tips)].join("\n")}\n${this.notHaves()}`);
    const omitted = listed.filter((l) => l.startsWith("~")).map((l) => l.slice(1).split(" ")[0]!);
    if (!omitted.length) return;
    const check = await this.git.lines(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], `${omitted.join("\n")}\n`);
    const large = check
      .map((l) => l.split(" "))
      .filter((p) => p[1] === "blob")
      .map((p) => ({ oid: p[0]!, size: Number(p[2]) }));
    if (!large.length) return;
    this.o.log(`${large.length} version(s) of large files (${fmtBytes(minBytes)} or more) go first, whole`);
    await this.pushBlobs(large, "large files", true);
  }

  /** Upload the blobs `commit` adds in batches (see pushBlobs), so the commit itself stays small. */
  private async pushObjectBatches(commit: string, label: string): Promise<void> {
    const listed = await this.git.lines(["rev-list", "--objects", "--stdin"], `${commit}\n${this.notHaves()}`);
    const oids = listed.map((l) => l.split(" ")[0]!);
    const check = await this.git.lines(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize:disk)"], `${oids.join("\n")}\n`);
    const blobs = check
      .map((l) => l.split(" "))
      .filter((p) => p[1] === "blob")
      .map((p) => ({ oid: p[0]!, size: Number(p[2]) }));
    await this.pushBlobs(blobs, label, false);
  }

  /**
   * Blobs pushed in batches, each a flat tree under a temporary ref. A tree, not a commit holding
   * it: git leaves out of a later push what a ref on the server reaches, but the files of an
   * unrelated commit it would send again. Batched at the budget as it stands: when the server
   * refuses a batch the budget shrinks, and what is left is batched again at the new one. A lone
   * object is retried as is (it can't be split further), until the budget can't shrink any more.
   * `whole`: without deltas.
   */
  private async pushBlobs(blobs: Array<{ oid: string; size: number }>, label: string, whole: boolean): Promise<void> {
    for (let left = blobs; left.length; ) {
      const batch = batchBySize(left, this.budget)[0]!;
      const tree = (await this.git.run(["mktree"], { input: batch.map((b, j) => `100644 blob ${b.oid}\tobject-${j}\n`).join("") })).stdout.trim();
      const size = batch.reduce((s, b) => s + b.size, 0);
      if (await this.pushTemp(tree, size, label, whole)) left = left.slice(batch.length);
    }
  }

  /** Push one chunk to a temporary ref. Returns false when the budget was lowered and the caller should re-plan. */
  private async pushTemp(oid: string, size: number, label: string, whole = false): Promise<boolean> {
    if (this.haveSet.has(oid)) return true;
    const ref = `${TEMP_PREFIX}c${++this.temp}`;
    const n = this.result.chunks + 1;
    await this.o.progress({ phase: "push", message: `Pushing history of ${label.replace(/^refs\/(heads|tags)\//, "")}: chunk ${n} (${fmtBytes(size)})`, chunks: this.result.chunks, bytes: this.result.bytes });
    const out = await this.push([`${oid}:${ref}`], whole);
    if (out.code === 0 && !parsePorcelain(out.stdout).some((s) => !s.ok)) {
      this.tempRefs.push(ref);
      this.addHave(oid);
      this.result.chunks++;
      this.result.bytes += size;
      return true;
    }
    const text = `${out.stdout}\n${out.stderr}`;
    if (isSecretRejection(text)) {
      for (const f of parseSecretFindings(out.stderr)) this.findings.set(`${f.kind}:${f.blob}`, f);
      const found = await this.findingsWithPaths();
      const what = found.map((f) => `${f.kind} in ${f.path ?? `blob ${f.blob}`}`).join("; ");
      throw new SecretsFound(
        this.spec.secrets === "bypass"
          ? `Push protection found possible secrets in the repository's history (${what}), and only a human admin of the target repository can import them with a bypass.`
          : `Push protection found possible secrets in the repository's history (${what}). The import was stopped as requested; rotate the secrets, or import again with the bypass option.`,
        found,
      );
    }
    // Past the owner's storage quota nothing more can be stored: say so rather than "push failed".
    const full = storageRejection(text);
    if (full) throw new ImportError(full);
    if (isSizeRejection(text)) {
      if (this.budget / 2 >= MIN_BUDGET) {
        this.budget = Math.floor(this.budget / 2);
        this.o.log(`push of ${fmtBytes(size)} was rejected (${lastLine(out.stderr)}); retrying with chunks of ${fmtBytes(this.budget)}`);
        this.temp--;
        return false;
      }
      // Chunking can no longer help. Say what the server answered: the object may be under the
      // 100 MB push limit and still be refused (or the server may be failing for another reason).
      const said = pushFailure(out);
      if (size > this.budget) {
        throw new ImportError(`a single Git object of ${fmtBytes(size)} could not be pushed even on its own (${said}). Remove the large file from the repository's history (e.g. with git filter-repo) and import again.`);
      }
      throw new ImportError(`pushes kept failing even in chunks of ${fmtBytes(this.budget)} (${said})`);
    }
    throw new ImportError(`push failed: ${pushFailure(out)}`);
  }

  /** `git push` to Diffinery in import mode; collects push protection findings from the output. */
  async push(refspecs: string[], whole = false): Promise<{ code: number; stdout: string; stderr: string }> {
    // `whole`: no deltas at all, neither new ones (pack.window=0) nor those the mirror already
    // stores (pack.depth=0), so none against what the server has either.
    const out = await this.git.run([...(whole ? ["-c", "pack.window=0", "-c", "pack.depth=0"] : []), "push", "--porcelain", "--no-verify", ...this.pushOpts, this.spec.target.pushUrl, ...refspecs], { allowFail: true });
    if (/Push protection bypassed/i.test(out.stderr)) for (const f of parseSecretFindings(out.stderr)) this.findings.set(`${f.kind}:${f.blob}`, f);
    return out;
  }

  async deleteTempRefs(): Promise<void> {
    for (let i = 0; i < this.tempRefs.length; i += REF_BATCH) {
      const batch = this.tempRefs.slice(i, i + REF_BATCH);
      const out = await this.push(batch.map((r) => `:${r}`));
      if (out.code !== 0) this.result.warnings.push(`Some temporary import refs could not be removed: ${lastLine(out.stderr)}`);
    }
    this.tempRefs = [];
  }

  /** Findings with a path where each blob appears, so people know what to rotate. */
  async findingsWithPaths(): Promise<ImportSecretFinding[]> {
    const out: ImportSecretFinding[] = [];
    for (const f of [...this.findings.values()].slice(0, 100)) {
      const full = (await this.git.run(["rev-parse", "--verify", "--quiet", `${f.blob}^{blob}`], { allowFail: true })).stdout.trim() || f.blob;
      let where: string | undefined = f.path;
      if (!where && /^[0-9a-f]{40}$/.test(full)) {
        const raw = await this.git.run(["log", "--all", "-n", "1", `--find-object=${full}`, "--raw", "--no-abbrev", "--format="], { allowFail: true });
        const line = raw.stdout.split("\n").find((l) => l.includes(full));
        where = line?.split("\t").slice(-1)[0];
      }
      out.push({ kind: f.kind, blob: full, path: where });
    }
    return out;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
