import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { failure } from "../job.js";
import { truthyInput } from "../util.js";
import type { Builtin, BuiltinContext } from "./index.js";

export function basicAuthHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/** Derives the clone URL of `owner/repo` from the job's own clone URL. */
export function cloneUrlFor(spec: { repo: { owner: string; name: string; cloneUrl: string } }, repository: string): string {
  const own = `${spec.repo.owner}/${spec.repo.name}`;
  if (repository.toLowerCase() === own.toLowerCase()) return spec.repo.cloneUrl;
  const u = spec.repo.cloneUrl;
  const idx = u.toLowerCase().lastIndexOf(own.toLowerCase());
  if (idx >= 0) return u.slice(0, idx) + repository + u.slice(idx + own.length);
  try {
    const parsed = new URL(u);
    return `${parsed.origin}/${repository}.git`;
  } catch {
    return u;
  }
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export const checkout: Builtin = async (c) => {
  const spec = c.job.spec;
  const ownRepo = `${spec.repo.owner}/${spec.repo.name}`;
  const repository = c.input("repository", ownRepo);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw failure(`Invalid repository '${repository}'. Expected format {owner}/{repo}.`);
  const isOwn = repository.toLowerCase() === ownRepo.toLowerCase();
  const refInput = c.input("ref");
  const depthRaw = Number(c.input("fetch-depth", "1"));
  const fetchDepth = Number.isFinite(depthRaw) && depthRaw >= 0 ? Math.floor(depthRaw) : 1;
  const dest = path.resolve(c.job.workspace, c.input("path", "."));
  if (dest !== c.job.workspace && !dest.startsWith(c.job.workspace + path.sep)) throw failure(`Repository path '${dest}' is not under '${c.job.workspace}'`);
  const clean = truthyInput(c.input("clean"), true);
  const submodules = c.input("submodules", "false").toLowerCase();
  const persist = truthyInput(c.input("persist-credentials"), true);
  const fetchTags = truthyInput(c.input("fetch-tags"), false);
  const showProgress = truthyInput(c.input("show-progress"), true);
  const lfs = truthyInput(c.input("lfs"), false);
  const sparse = c.input("sparse-checkout").split("\n").map((l) => l.trim()).filter(Boolean);
  const coneMode = truthyInput(c.input("sparse-checkout-cone-mode"), true);
  // Like actions/checkout, sparse checkouts fetch without blobs unless a filter is given.
  const filter = c.input("filter") || (sparse.length ? "blob:none" : "");

  const server = c.input("github-server-url").replace(/\/+$/, "");
  const ownOrigin = isHttp(spec.repo.cloneUrl) ? new URL(spec.repo.cloneUrl).origin : "";
  const url = server && server !== ownOrigin ? `${server}/${repository}.git` : cloneUrlFor(spec, repository);
  const origin = isHttp(url) ? new URL(url).origin : "";
  // The job's own token only ever goes to this server; any other host needs an explicit `token:`.
  const token = c.input("token") || (origin && origin === ownOrigin ? spec.token : "");
  const header = token ? basicAuthHeader(token) : "";
  if (token) {
    c.job.masker.add(token);
    c.job.masker.add(header.slice("AUTHORIZATION: basic ".length));
  }
  const authKey = `http.${origin}/.extraheader`;
  const env = c.toolEnv({ GIT_TERMINAL_PROMPT: "0", ...(lfs ? {} : { GIT_LFS_SKIP_SMUDGE: "1" }) });
  /** Configuration for the git commands run here (and the git, git-lfs and submodule processes they start). */
  const withConfig = (key: string, value: string) => {
    const n = Number(env.GIT_CONFIG_COUNT) || 0;
    Object.assign(env, { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: key, [`GIT_CONFIG_VALUE_${n}`]: value });
  };
  // Like actions/checkout's temporary global config: trust the checkout for these git commands only.
  if (truthyInput(c.input("set-safe-directory"), true)) withConfig("safe.directory", dest);
  // The token reaches git through the environment while fetching, so a checkout that fails half
  // way leaves nothing in .git/config; it is written there at the end, only to persist it.
  if (origin && header) {
    withConfig(authKey, header);
    withConfig(`url.${origin}/.insteadOf`, `git@${new URL(origin).host}:`);
  }
  const git = (args: string[], o: { silent?: boolean; allowFail?: boolean } = {}) =>
    o.allowFail ? c.exec("git", args, { cwd: dest, env, capture: true, silent: o.silent }) : c.run("git", args, { cwd: dest, env, silent: o.silent });

  c.log(`Syncing repository: ${repository}`);
  await mkdir(dest, { recursive: true });
  const hasGit = existsSync(path.join(dest, ".git"));
  if (hasGit && clean) {
    await git(["clean", "-ffdx"], { allowFail: true });
    await git(["reset", "--hard", "HEAD"], { allowFail: true, silent: true });
  } else if (!hasGit) {
    const entries = await readdir(dest);
    if (entries.length && clean) {
      c.log(`Deleting the contents of '${dest}'`);
      await Promise.all(entries.map((e) => rm(path.join(dest, e), { recursive: true, force: true })));
    }
  }
  if (!hasGit) await git(["init", "-q", dest]);
  const setUrl = await git(["remote", "set-url", "origin", url], { allowFail: true, silent: true });
  if (setUrl.exitCode !== 0) await git(["remote", "add", "origin", url]);
  await git(["config", "--local", "gc.auto", "0"]);
  // A reused workspace may still hold another job's credentials; they would be sent alongside ours.
  if (origin) await git(["config", "--local", "--unset-all", authKey], { allowFail: true, silent: true });
  if (lfs) await git(["lfs", "install", "--local"]);

  // Decide what to fetch
  let sha: string | undefined;
  let ref: string | undefined;
  if (refInput) {
    if (/^[0-9a-f]{40}$/i.test(refInput)) sha = refInput;
    else ref = refInput;
  } else if (isOwn) {
    sha = spec.sha;
    ref = spec.ref;
  } else {
    ref = "HEAD";
  }

  const depthArgs = fetchDepth > 0 ? [`--depth=${fetchDepth}`] : [];
  const tagArgs = fetchDepth === 0 || fetchTags ? [] : ["--no-tags"];
  const extraArgs = [...(filter ? [`--filter=${filter}`] : []), ...(showProgress ? ["--progress"] : [])];
  const fetch = (refspecs: string[], allowFail = false) => git(["fetch", ...tagArgs, "--prune", "--no-recurse-submodules", ...extraArgs, ...depthArgs, "origin", ...refspecs], { allowFail });

  let checkoutTarget: string | undefined;
  let branch: string | undefined;
  if (ref?.startsWith("refs/heads/")) branch = ref.slice("refs/heads/".length);

  if (fetchDepth === 0) {
    c.log("Fetching the repository (full history)");
    await fetch(["+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"]);
    if (ref && !ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/") && ref !== "HEAD") {
      if (ref.startsWith("refs/")) await fetch([`+${ref}:${ref.replace(/^refs\//, "refs/remotes/")}`], true);
    }
    checkoutTarget = sha ?? (await resolveRef(git, ref!, (b) => (branch = b)));
  } else {
    c.log(`Fetching the repository (depth ${fetchDepth})`);
    let fetched = false;
    if (sha) {
      const r = await fetch([`+${sha}:refs/remotes/origin/${branch ?? "diffinery-checkout"}`], true);
      fetched = r.exitCode === 0;
      if (!fetched) c.log("Fetching by commit SHA failed; falling back to fetching the ref.");
    }
    if (!fetched && ref) {
      const specs = refspecsFor(ref);
      let ok = false;
      for (const rs of specs) {
        const r = await fetch([rs.refspec], true);
        if (r.exitCode === 0) {
          ok = true;
          if (rs.branch) branch = rs.branch;
          break;
        }
      }
      if (!ok) throw failure(`Failed to fetch ref '${ref}' from ${repository}. Check that the ref exists and the token has read access.`);
      if (!sha) {
        const target = specs.find((s) => s.branch === branch)?.local ?? "FETCH_HEAD";
        checkoutTarget = target;
      }
    } else if (!fetched) {
      throw failure(`Failed to fetch commit ${sha} from ${repository}.`);
    }
    checkoutTarget ??= sha ?? "FETCH_HEAD";
  }

  if (lfs) {
    c.log("Fetching LFS objects");
    await git(["lfs", "fetch", "origin", checkoutTarget!]);
  }
  if (sparse.length) {
    c.log(`Setting up sparse checkout${coneMode ? "" : " (non-cone mode)"}`);
    await git(["sparse-checkout", "set", ...(coneMode ? [] : ["--no-cone"]), "--", ...sparse]);
  } else if (hasGit) {
    await git(["sparse-checkout", "disable"], { allowFail: true, silent: true });
  }

  const progress = showProgress ? ["--progress"] : [];
  if (branch) await git(["checkout", ...progress, "--force", "-B", branch, checkoutTarget!]);
  else await git(["checkout", ...progress, "--force", checkoutTarget!]);
  const head = (await git(["rev-parse", "HEAD"], { silent: true })).stdout.trim();
  if (sha && /^[0-9a-f]{40}$/i.test(sha) && head.toLowerCase() !== sha.toLowerCase()) {
    throw failure(`Checked out ${head} but expected ${sha}.`);
  }
  c.log(`HEAD is now at ${head}`);
  c.setOutput("commit", head);
  c.setOutput("ref", ref && ref !== "HEAD" ? ref : branch ? `refs/heads/${branch}` : "");

  if (submodules === "true" || submodules === "recursive") {
    const recursive = submodules === "recursive" ? ["--recursive"] : [];
    c.log("Fetching submodules");
    await git(["submodule", "sync", ...recursive]);
    await git(["submodule", "update", "--init", "--force", ...(fetchDepth > 0 ? [`--depth=${fetchDepth}`] : []), ...recursive]);
    if (lfs) await git(["submodule", "foreach", ...recursive, "git lfs pull"]);
  }

  if (!origin || !header || !persist) return;
  // persist-credentials: later steps' git commands authenticate; the post step removes it again.
  await git(["config", "--local", authKey, header], { silent: true });
  if (submodules === "true" || submodules === "recursive") {
    await git(["submodule", "foreach", ...(submodules === "recursive" ? ["--recursive"] : []), `git config --local '${authKey}' '${header}'`], { silent: true });
  }
  c.registerPost(`Post ${c.name}`, "always()", async (pc: BuiltinContext) => {
    if (!existsSync(path.join(dest, ".git"))) return;
    pc.log("Removing persisted credentials");
    await pc.exec("git", ["config", "--local", "--unset-all", authKey], { cwd: dest, capture: true, silent: true });
    if (submodules === "true" || submodules === "recursive") {
      await pc.exec("git", ["submodule", "foreach", "--recursive", `git config --local --unset-all '${authKey}' || :`], { cwd: dest, capture: true, silent: true });
    }
  });
};

function refspecsFor(ref: string): Array<{ refspec: string; local: string; branch?: string }> {
  if (ref === "HEAD") return [{ refspec: "HEAD", local: "FETCH_HEAD" }];
  if (ref.startsWith("refs/heads/")) {
    const b = ref.slice(11);
    return [{ refspec: `+${ref}:refs/remotes/origin/${b}`, local: `refs/remotes/origin/${b}`, branch: b }];
  }
  if (ref.startsWith("refs/tags/")) return [{ refspec: `+${ref}:${ref}`, local: ref }];
  if (ref.startsWith("refs/")) {
    const local = ref.replace(/^refs\//, "refs/remotes/");
    return [{ refspec: `+${ref}:${local}`, local }];
  }
  return [
    { refspec: `+refs/heads/${ref}:refs/remotes/origin/${ref}`, local: `refs/remotes/origin/${ref}`, branch: ref },
    { refspec: `+refs/tags/${ref}:refs/tags/${ref}`, local: `refs/tags/${ref}` },
  ];
}

async function resolveRef(
  git: (args: string[], o?: { silent?: boolean; allowFail?: boolean }) => Promise<{ exitCode: number; stdout: string }>,
  ref: string,
  setBranch: (b: string) => void,
): Promise<string> {
  if (ref === "HEAD") {
    const r = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], { allowFail: true, silent: true });
    if (r.exitCode === 0) return r.stdout.trim();
  }
  const short = ref.replace(/^refs\/heads\//, "");
  const candidates = ref.startsWith("refs/tags/")
    ? [ref]
    : ref.startsWith("refs/heads/")
      ? [`refs/remotes/origin/${short}`]
      : ref.startsWith("refs/")
        ? [ref.replace(/^refs\//, "refs/remotes/")]
        : [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`];
  for (const cand of candidates) {
    const r = await git(["rev-parse", "--verify", "--quiet", cand], { allowFail: true, silent: true });
    if (r.exitCode === 0) {
      if (cand.startsWith("refs/remotes/origin/")) setBranch(cand.slice("refs/remotes/origin/".length));
      return cand;
    }
  }
  throw failure(`A branch or tag with the name '${ref}' could not be found`);
}
