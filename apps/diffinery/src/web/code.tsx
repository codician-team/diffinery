/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import type { AppContext } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { topicsOf } from "../http/gh.js";
import type { Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { parseAutoMergeDefault } from "../repo/auto-merge.js";
import { atLeast, globToRegExp } from "../repo/types.js";
import { ICONS } from "./assets.js";
import { KCheckbox, KRadio, KSelect } from "./kumo.js";
import { csrfToken, type FormData } from "./csrf.js";
import { CheckName } from "./checks.js";
import { ReleasesSection } from "./releases.js";
import { highlightLines, langForPath } from "./highlight.js";
import {
  CommitRow,
  CopyButton,
  DiffStats,
  DiffView,
  FileSummary,
  Form,
  Markdown,
  Pager,
  RefSwitcher,
  Time,
  act,
  cloneUrl,
  encPath,
  firstLine,
  fmtBytes,
  pageNum,
  post,
  qs,
  refNames,
  render,
  repoUrl,
  restOfPath,
  shortSha,
  splitRefPath,
  statusOf,
  Status,
  tokens,
  type DiffFile,
  type WebApp,
  prm,
} from "./ui.js";

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp", svg: "image/svg+xml" };
const MAX_RENDER = 1024 * 1024;

const extOf = (path: string): string => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
const isMarkdown = (path: string): boolean => /\.(md|markdown|mdown|mkd)$/i.test(path);
const decoder = () => new TextDecoder();

/** Normalise a user-supplied repository path; null when invalid. */
function cleanPath(p: string): string | null {
  const segs = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (!segs.length || segs.some((s) => s === ".." || s === ".git")) return null;
  return segs.join("/");
}

const Crumbs: FC<{ base: string; ref: string; path: string; last?: boolean }> = ({ base, ref, path, last }) => {
  const segs = path ? path.split("/") : [];
  return (
    <div class="crumbs">
      <a href={`${base}/tree/${encPath(ref)}`}>{base.split("/")[2]}</a>
      {segs.map((s, i) => (
        <>
          <span class="faint">/</span>
          {i === segs.length - 1 && last !== false ? <b>{s}</b> : <a href={`${base}/tree/${encPath(ref)}/${encPath(segs.slice(0, i + 1).join("/"))}`}>{s}</a>}
        </>
      ))}
    </div>
  );
};

const CloneBox: FC<{ url: string }> = ({ url }) => (
  <div class="clone">
    <input type="text" readonly value={url} aria-label="Clone URL" />
    <CopyButton text={url} size="base" />
  </div>
);

/**
 * Clone straight into an editor: the editors' own clone links (VS Code's Git extension handles /clone in VS Code and
 * the editors built on it; JetBrains Toolbox handles jetbrains://). They work without Diffinery's extension, which
 * adds sign-in for private repositories (docs/repositories/clone-in-your-editor.md).
 */
export const EDITORS: Array<{ label: string; link: (url: string) => string }> = [
  { label: "VS Code", link: (u) => `vscode://vscode.git/clone?url=${encodeURIComponent(u)}` },
  { label: "Cursor", link: (u) => `cursor://vscode.git/clone?url=${encodeURIComponent(u)}` },
  { label: "Windsurf", link: (u) => `windsurf://vscode.git/clone?url=${encodeURIComponent(u)}` },
  { label: "IntelliJ IDEA", link: (u) => `jetbrains://idea/checkout/git?idea.required.plugins.id=Git4Idea&checkout.repo=${encodeURIComponent(u)}` },
];

const OpenInEditor: FC<{ url: string }> = ({ url }) => (
  <div class="openin">
    <span class="small muted">Open in</span>
    {EDITORS.map((e) => (
      <a class="btn sm" href={e.link(url)} rel="nofollow">
        {e.label}
      </a>
    ))}
  </div>
);

const QuickSetup: FC<{ c: AppContext; l: Loaded }> = ({ c, l }) => {
  const url = cloneUrl(c, l.repo);
  const b = l.repo.default_branch;
  const base = repoUrl(l.repo);
  const canWrite = atLeast(l.caller.role, "write");
  return (
    <div style="max-width:900px">
      <div class="box">
        <div class="head">
          <h2>Quick setup</h2>
          <span class="muted small">This repository is empty.</span>
        </div>
        <div class="body">
          <CloneBox url={url} />
          <OpenInEditor url={url} />
          {canWrite ? (
            <p class="mt muted">
              Get started by <a href={`${base}/new/${encPath(b)}?filename=README.md`}>creating a README on the web</a>, or push an existing repository from the command line.
            </p>
          ) : null}
          <h3 class="mt">…create a new repository on the command line</h3>
          <pre class="cmd">{`echo "# ${l.repo.name}" >> README.md\ngit init -b ${b}\ngit add README.md\ngit commit -m "first commit"\ngit remote add origin ${url}\ngit push -u origin ${b}`}</pre>
          <h3>…or push an existing repository</h3>
          <pre class="cmd">{`git remote add origin ${url}\ngit push -u origin ${b}`}</pre>
          <h3>Authentication</h3>
          <p class="muted">
            When Git asks for credentials, use your username and a <a href="/settings/tokens">personal access token</a> as the password. To avoid typing it every time, run <code>git config --global credential.helper store</code> (or use
            your OS keychain helper). Git 2.26 or newer is required. In VS Code, Cursor or Windsurf, the <a href="/docs/repositories/clone-in-your-editor">Diffinery extension</a> signs Git in for you.
          </p>
          <p class="muted m0">
            Workflows in <code>.github/workflows/*.yml</code> run automatically on push. AI agents should use their own <a href="/settings/agents">agent account and token</a>.
          </p>
        </div>
      </div>
    </div>
  );
};

const NoDefaultBranch: FC<{ base: string; branch: string; names: { branches: string[]; tags: string[] } }> = ({ base, branch, names }) => (
  <div class="box" style="max-width:900px">
    <div class="head">
      <h2>No {branch} branch yet</h2>
      <span class="muted small">
        The default branch, <code>{branch}</code>, hasn't been pushed. Other branches have:
      </span>
    </div>
    <div class="body">
      <ul class="m0">
        {names.branches.slice(0, 100).map((b) => (
          <li>
            <a href={`${base}/tree/${encPath(b)}`}>{b}</a>
          </li>
        ))}
      </ul>
    </div>
  </div>
);

async function treePage(c: AppContext, l: Loaded, ref: string, path: string, root: boolean): Promise<Response> {
  const { repo, caller, stub } = l;
  const base = repoUrl(repo);
  const [tree, names, stats, last, releases] = await Promise.all([
    stub.tree(ref, path),
    refNames(stub),
    root && !path ? stub.stats() : Promise.resolve(null),
    !path ? stub.log(ref, { limit: 1 }).catch(() => []) : Promise.resolve([]),
    root && !path ? stub.releaseSummary(caller).catch(() => null) : Promise.resolve(null),
  ]);
  const counts = stats ? { issues: stats.openIssues, pulls: stats.openPulls } : undefined;
  if (!tree) {
    if (!names.branches.length && !names.tags.length) {
      return render(c, { title: `${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code", counts } }, <QuickSetup c={c} l={l} />);
    }
    // Branches were pushed, but not the default one: say so and list them rather than answer 404.
    if (root && !path && ref === repo.default_branch) {
      return render(c, { title: `${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code", counts } }, <NoDefaultBranch base={base} branch={ref} names={names} />);
    }
    const blob = path ? await stub.blob(ref, path).catch(() => null) : null;
    if (blob) return c.redirect(`${base}/blob/${encPath(ref)}/${encPath(path)}`, 302);
    throw new HttpError(404, "path not found");
  }
  const readme = tree.items.find((i) => i.type === "blob" && /^readme(\.(md|markdown|txt))?$/i.test(i.name));
  const readmeBlob = readme && (readme.size ?? 0) < MAX_RENDER ? await stub.blob(ref, readme.path).catch(() => null) : null;
  const head = last[0];
  const canWrite = atLeast(caller.role, "write") && names.branches.includes(ref);
  const main = (
    <div>
      <div class="row between mb">
        <div class="row">
          <RefSwitcher current={ref} branches={names.branches} tags={names.tags} to={(r) => `${base}/tree/${encPath(r)}${path ? `/${encPath(path)}` : ""}`} />
          {path ? <Crumbs base={base} ref={ref} path={path} /> : null}
          {!path ? (
            <span class="muted small">
              <a href={`${base}/branches`}>
                {raw(ICONS.branch)} {names.branches.length} branch{names.branches.length === 1 ? "" : "es"}
              </a>{" "}
              ·{" "}
              <a href={`${base}/tags`}>
                {raw(ICONS.tag)} {names.tags.length} tag{names.tags.length === 1 ? "" : "s"}
              </a>
            </span>
          ) : null}
        </div>
        <div class="row">
          {canWrite ? (
            <a class="btn sm" href={`${base}/new/${encPath(ref)}${path ? `/${encPath(path)}` : ""}`}>
              {raw(ICONS.plus)} Add file
            </a>
          ) : null}
          <a class="btn sm" href={`${base}/commits/${encPath(ref)}${path ? qs({ path }) : ""}`}>
            {raw(ICONS.history)} History
          </a>
        </div>
      </div>
      <div class="box">
        {head ? (
          <div class="head small">
            <b>{head.author.name}</b>
            <a href={`${base}/commit/${head.sha}`} class="grow" style="color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {firstLine(head.message)}
            </a>
            <a class="sha" href={`${base}/commit/${head.sha}`}>
              {shortSha(head.sha)}
            </a>
            <Time at={new Date(head.committer.timestamp * 1000).toISOString()} />
          </div>
        ) : null}
        <table class="files">
          {path ? (
            <tr>
              <td class="ic" />
              <td colspan={2}>
                <a href={`${base}/tree/${encPath(ref)}${path.includes("/") ? `/${encPath(path.split("/").slice(0, -1).join("/"))}` : ""}`}>..</a>
              </td>
            </tr>
          ) : null}
          {tree.items.map((it) => (
            <tr>
              <td class={`ic ${it.type === "tree" ? "ic-dir" : ""}`}>{raw(it.type === "tree" ? ICONS.dir : it.type === "commit" ? ICONS.submodule : ICONS.file)}</td>
              <td>
                {it.type === "commit" ? (
                  <span>
                    {it.name} <span class="faint mono small">@ {shortSha(it.oid)}</span>
                  </span>
                ) : (
                  <a href={`${base}/${it.type === "tree" ? "tree" : "blob"}/${encPath(ref)}/${encPath(it.path)}`}>{it.name}</a>
                )}
              </td>
              <td class="sz">{it.type === "blob" ? fmtBytes(it.size) : ""}</td>
            </tr>
          ))}
        </table>
        {tree.items.length === 0 ? <div class="empty">This directory is empty.</div> : null}
      </div>
      {readmeBlob && !readmeBlob.binary ? (
        <div class="box readme">
          <div class="head">
            {raw(ICONS.file)} <b>{readme!.name}</b>
          </div>
          <div class="body">
            {isMarkdown(readme!.name) ? (
              <Markdown text={decoder().decode(readmeBlob.content)} base={{ owner: repo.owner_login, repo: repo.name, ref, dir: path }} />
            ) : (
              <pre style="white-space:pre-wrap;margin:0">{decoder().decode(readmeBlob.content)}</pre>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
  if (path) return render(c, { title: `${path} at ${ref} · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code", ref } }, main);
  return render(
    c,
    { title: `${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code", ref, counts }, jsonLd: repo.visibility === "public" ? [sourceCodeLd(c, repo, tree.items, ref)] : undefined },
    <div class="grid">
      {main}
      <aside class="side">
        <section>
          <h3>Clone</h3>
          <CloneBox url={cloneUrl(c, repo)} />
          <OpenInEditor url={cloneUrl(c, repo)} />
          <p class="small muted" style="margin-top:6px">
            Use a <a href="/settings/tokens">token</a> as the password, or <a href="/docs/repositories/clone-in-your-editor">sign in from your editor</a>.
          </p>
        </section>
        <section>
          <h3>About</h3>
          <p class={repo.description ? "" : "muted"}>{repo.description || "No description."}</p>
          {repo.homepage ? (
            <p>
              <a href={repo.homepage} rel="noopener nofollow ugc">
                {repo.homepage.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            </p>
          ) : null}
          {stats ? (
            <dl class="kv">
              <dt>Default branch</dt>
              <dd class="mono">{repo.default_branch}</dd>
              <dt>Open issues</dt>
              <dd>
                <a href={`${base}/issues`}>{stats.openIssues}</a>
              </dd>
              <dt>Open pull requests</dt>
              <dd>
                <a href={`${base}/pulls`}>{stats.openPulls}</a>
              </dd>
              <dt>Refs</dt>
              <dd>{stats.refs}</dd>
              <dt>Objects</dt>
              <dd>{stats.objects.toLocaleString("en-US")}</dd>
              <dt>Size</dt>
              <dd>{fmtBytes(stats.bytes)}</dd>
              <dt>Last push</dt>
              <dd>{repo.pushed_at ? <Time at={repo.pushed_at} /> : "never"}</dd>
            </dl>
          ) : null}
        </section>
        <ReleasesSection base={base} summary={releases} canWrite={atLeast(caller.role, "write") && !repo.archived} topics={repo.topics} />
        <section>
          <h3>Shortcuts</h3>
          <p class="small muted m0">
            <kbd>Ctrl</kbd> <kbd>K</kbd> jump anywhere · <kbd>t</kbd> find a file · <kbd>g</kbd> <kbd>i</kbd> issues · <kbd>g</kbd> <kbd>p</kbd> pull requests · <kbd>g</kbd> <kbd>a</kbd> actions
          </p>
        </section>
      </aside>
    </div>,
  );
}

/** schema.org data for a public repository's home page, so search engines and AI assistants can tell what it is. */
function sourceCodeLd(c: AppContext, repo: Repo, items: { name: string; type: string }[], ref: string): object {
  const origin = c.env.PUBLIC_URL.replace(/\/$/, "");
  const url = `${origin}/${repo.owner_login}/${repo.name}`;
  const license = items.find((i) => i.type === "blob" && /^(license|licence|copying)(\.(md|txt))?$/i.test(i.name));
  const topics = topicsOf(repo);
  return {
    "@type": "SoftwareSourceCode",
    "@id": `${url}#code`,
    name: repo.name,
    url,
    codeRepository: url,
    ...(repo.description ? { description: repo.description } : {}),
    ...(topics.length ? { keywords: topics.join(", ") } : {}),
    ...(license ? { license: `${url}/blob/${encPath(ref)}/${encPath(license.name)}` } : {}),
    ...(repo.pushed_at ? { dateModified: repo.pushed_at } : {}),
    author: { "@type": "Organization", name: repo.owner_login, url: `${origin}/${repo.owner_login}` },
  };
}

// ---------------------------------------------------------------- editor

interface EditorValues {
  path: string;
  content: string;
  message: string;
  description: string;
  choice: "direct" | "branch";
  newBranch: string;
  head: string;
}

const Editor: FC<{ c: AppContext; l: Loaded; ref: string; mode: "edit" | "new"; orig: string; dir: string; v: EditorValues; error?: string; canDirect: boolean }> = ({ c, l, ref, mode, orig, dir, v, error, canDirect }) => {
  const base = repoUrl(l.repo);
  const t = csrfToken(c);
  const action = mode === "edit" ? `${base}/edit/${encPath(ref)}/${encPath(orig)}` : `${base}/new/${encPath(ref)}${dir ? `/${encPath(dir)}` : ""}`;
  return (
    <div>
      {error ? <div class="flash error">{error}</div> : null}
      <Form action={action} t={t}>
        <input type="hidden" name="head" value={v.head} />
        <div class="row mb">
          <span class="badge">{raw(ICONS.branch)} {ref}</span>
          <div class="grow">
            <input type="text" name="path" value={v.path} required placeholder="path/to/file.ext" aria-label="File path" class="mono" />
          </div>
          {mode === "edit" ? (
            <a class="btn sm" href={`${base}/blob/${encPath(ref)}/${encPath(orig)}`}>
              Cancel
            </a>
          ) : null}
        </div>
        <div class="box">
          <textarea name="content" class="code" spellcheck={false} style="border:0;border-radius:0;min-height:480px" aria-label="File contents">
            {`\n${v.content}`}
          </textarea>
        </div>
        <div class="box">
          <div class="head">
            <h3>Commit changes</h3>
          </div>
          <div class="body">
            <div class="field">
              <input type="text" name="message" value={v.message} required aria-label="Commit message" />
            </div>
            <div class="field">
              <textarea name="description" placeholder="Add an optional extended description…" style="min-height:70px">
                {v.description}
              </textarea>
            </div>
            <div class="field">
              {canDirect ? null : (
                <p class="muted small">
                  {raw(ICONS.shield)} <code>{ref}</code> is protected; your change goes to a new branch and a pull request.
                </p>
              )}
              <KRadio
                name="choice"
                label="Where to commit"
                value={canDirect && v.choice === "direct" ? "direct" : "branch"}
                items={[
                  ...(canDirect
                    ? [
                        {
                          value: "direct",
                          label: (
                            <>
                              Commit directly to the <code>{ref}</code> branch
                            </>
                          ),
                        },
                      ]
                    : []),
                  { value: "branch", label: "Create a new branch for this commit and start a pull request:" },
                ]}
              />
              <input type="text" name="new_branch" value={v.newBranch} style="max-width:320px;margin:6px 0 0 24px" class="mono" aria-label="New branch name" />
            </div>
            <button class="btn primary">Commit changes</button>
          </div>
        </div>
      </Form>
      {mode === "edit" ? (
        <Form action={action} t={t} class="box" confirm={`Delete ${orig}?`}>
          <input type="hidden" name="_delete" value="1" />
          <input type="hidden" name="head" value={v.head} />
          <div class="body row between">
            <span class="muted">Delete this file in a new commit on {ref}.</span>
            <button class="btn sm danger">Delete file</button>
          </div>
        </Form>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------- compare and pull request creation

export interface PullFormValues {
  title: string;
  body: string;
  intent: string;
  draft: boolean;
  /** Turn auto-merge on as it opens; offered only where the base branch has required checks. */
  autoMerge?: boolean;
}

async function comparePage(c: AppContext, l: Loaded, baseRef: string, headRef: string, form?: { values: PullFormValues; error: string }): Promise<Response> {
  const { repo, caller, stub } = l;
  const base = repoUrl(repo);
  const t = csrfToken(c);
  const names = await refNames(stub);
  const all = [...names.branches, ...names.tags.filter((x) => !names.branches.includes(x))];
  let cmp: Awaited<ReturnType<typeof stub.compare>> | null = null;
  let error: string | null = null;
  try {
    cmp = await stub.compare(baseRef, headRef);
  } catch (e) {
    const s = statusOf(e);
    if (s.status >= 500) throw e;
    error = s.message;
  }
  const bothBranches = names.branches.includes(baseRef) && names.branches.includes(headRef);
  const canPr = c.get("principal").type === "account" && atLeast(caller.role, "write") && bothBranches && !!cmp && cmp.aheadBy > 0;
  let existing: number | null = null;
  // Auto-merge as it opens: offered where the base has a required check, ticked by the person's own setting.
  let offerAutoMerge = false;
  if (canPr) {
    const [open, rules] = await Promise.all([stub.issues({ kind: "pull", state: "open", limit: 100 }), stub.protectionFor(baseRef)]);
    existing = open.items.find((i) => i.pull?.head === headRef && i.pull?.base === baseRef)?.number ?? null;
    offerAutoMerge = !!rules?.requiredChecks?.length;
  }
  const principal = c.get("principal");
  const mySetting = principal.type === "account" ? parseAutoMergeDefault(principal.account.auto_merge) : null;
  const defaultTitle = cmp && cmp.commits.length === 1 ? firstLine(cmp.commits[0]!.message) : headRef.replace(/[-_/]+/g, " ").replace(/^\w/, (m) => m.toUpperCase());
  const v = form?.values ?? { title: defaultTitle, body: cmp && cmp.commits.length === 1 ? cmp.commits[0]!.message.split("\n").slice(1).join("\n").trim() : "", intent: "", draft: false };
  return render(
    c,
    { title: `Comparing ${baseRef}...${headRef}`, repo: { repo, caller, tab: "pulls", ref: headRef }, wide: !!cmp && cmp.files.length > 0 },
    <div>
      <h1>Compare changes</h1>
      <p class="muted">Choose two branches to see what changed or to start a new pull request.</p>
      <form method="get" action={`${base}/compare`} class="box">
        <div class="body row">
          {raw(ICONS.branch)}
          <span class="row" style="gap:6px">
            base:
            <KSelect name="base" size="sm" label="Base branch" value={all.includes(baseRef) ? baseRef : undefined} options={all.map((n) => ({ value: n, label: n }))} />
          </span>
          <span class="faint">←</span>
          <span class="row" style="gap:6px">
            compare:
            <KSelect name="head" size="sm" label="Compare branch" value={all.includes(headRef) ? headRef : undefined} options={all.map((n) => ({ value: n, label: n }))} />
          </span>
          <button class="btn sm">Compare</button>
          {cmp ? (
            <span class="muted small" style="margin-left:auto">
              {cmp.aheadBy} commit{cmp.aheadBy === 1 ? "" : "s"} ahead, {cmp.behindBy} behind {baseRef}
            </span>
          ) : null}
        </div>
      </form>
      {error ? <div class="flash error">{error}</div> : null}
      {cmp && cmp.aheadBy === 0 ? (
        <div class="blank mb">
          <h3>There isn't anything to compare.</h3>
          <p class="m0">
            <b>{baseRef}</b> is up to date with all commits from <b>{headRef}</b>.
          </p>
        </div>
      ) : null}
      {existing ? (
        <div class="flash info">
          A pull request for these branches already exists:{" "}
          <a href={`${base}/pull/${existing}`}>
            #{existing}
          </a>
        </div>
      ) : canPr ? (
        <Form action={`${base}/pulls`} t={t} class="box" style="max-width:980px">
          <input type="hidden" name="base" value={baseRef} />
          <input type="hidden" name="head" value={headRef} />
          <div class="head">
            <h2>Open a pull request</h2>
            <span class="muted small">
              {headRef} → {baseRef}
            </span>
          </div>
          <div class="body">
            {form?.error ? <div class="flash error">{form.error}</div> : null}
            <div class="field">
              <label for="pt">Title</label>
              <input id="pt" name="title" type="text" required value={v.title} />
            </div>
            <div class="field">
              <label for="pi">Intent (what this change is meant to do — helps reviewers and AI reviewers)</label>
              <textarea id="pi" name="intent" style="min-height:80px" placeholder="e.g. Fix the race in token refresh without changing the public API.">
                {v.intent}
              </textarea>
            </div>
            <div class="field">
              <label for="pb">Description</label>
              <textarea id="pb" name="body" placeholder="Markdown is supported.">
                {v.body}
              </textarea>
            </div>
            {offerAutoMerge ? (
              <div class="field">
                <input type="hidden" name="auto_merge_offered" value="1" />
                <KCheckbox
                  name="auto_merge"
                  checked={v.autoMerge ?? !!mySetting}
                  label="Merge by itself once checks pass"
                  description={
                    <>
                      Turns on auto-merge: it merges once {baseRef}'s required checks pass and every rule of the branch is met, approvals included. {mySetting ? "Ticked by your setting in " : "Tick it for every pull request you open in "}
                      <a href="/settings/pull-requests">Settings → Pull requests</a>.
                    </>
                  }
                />
              </div>
            ) : null}
            <div class="row between">
              <KCheckbox name="draft" checked={v.draft} label="Create as draft" />
              <button class="btn green">Create pull request</button>
            </div>
          </div>
        </Form>
      ) : null}
      {cmp && cmp.commits.length ? (
        <div class="box">
          <div class="head">
            <h3>
              {raw(ICONS.commit)} {cmp.commits.length} commit{cmp.commits.length === 1 ? "" : "s"}
            </h3>
          </div>
          <ul class="list">
            {cmp.commits.map((cm) => (
              <CommitRow base={base} sha={cm.sha} message={cm.message} author={cm.author} signed={cm.signed} />
            ))}
          </ul>
        </div>
      ) : null}
      {cmp && cmp.files.length ? (
        <>
          <div class="row between mb">
            <DiffStats files={cmp.totalFiles} additions={cmp.additions} deletions={cmp.deletions} />
            {cmp.truncated ? <span class="badge amber">showing the first {cmp.files.length} files</span> : null}
          </div>
          <FileSummary files={cmp.files as DiffFile[]} />
          <DiffView files={cmp.files as DiffFile[]} opts={{ viewHref: (p) => `${base}/blob/${encPath(headRef)}/${encPath(p)}` }} />
        </>
      ) : null}
    </div>,
  );
}

// ---------------------------------------------------------------- routes

export function registerCode(web: WebApp): void {
  web.get("/:owner/:repo", async (c) => {
    const name = prm(c, "repo");
    if (name.endsWith(".git")) return c.redirect(`/${prm(c, "owner")}/${name.slice(0, -4)}`, 301);
    const l = await loadRepo(c, prm(c, "owner"), name, "read");
    if (l.repo.owner_login !== prm(c, "owner") || l.repo.name !== name) return c.redirect(repoUrl(l.repo), 301);
    return treePage(c, l, l.repo.default_branch, "", true);
  });

  web.get("/:owner/:repo/tree/*", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const rest = restOfPath(c, 3);
    if (!rest) return c.redirect(repoUrl(l.repo), 302);
    const { ref, path } = await splitRefPath(l.stub, rest);
    return treePage(c, l, ref, path, !path);
  });

  web.get("/:owner/:repo/blob/*", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const { ref, path } = await splitRefPath(stub, restOfPath(c, 3));
    if (!path) return c.redirect(`${base}/tree/${encPath(ref)}`, 302);
    const [blob, names] = await Promise.all([stub.blob(ref, path), refNames(stub)]);
    if (!blob) {
      const tree = await stub.tree(ref, path);
      if (tree) return c.redirect(`${base}/tree/${encPath(ref)}/${encPath(path)}`, 302);
      throw new HttpError(404, "file not found");
    }
    const ext = extOf(path);
    const rawUrl = `${base}/raw/${encPath(ref)}/${encPath(path)}`;
    const plain = c.req.query("plain") === "1";
    const canEdit = atLeast(caller.role, "write") && names.branches.includes(ref) && !blob.binary && blob.size <= MAX_RENDER && !repo.archived;
    let content: Child;
    let lineCount = 0;
    if (IMAGE_TYPES[ext] && ext !== "svg") {
      content = (
        <div class="body" style="text-align:center;background:var(--bg2)">
          <img src={rawUrl} alt={path} style="max-width:100%" />
        </div>
      );
    } else if (blob.binary) {
      content = (
        <div class="empty">
          Binary file, {fmtBytes(blob.size)} ({blob.size.toLocaleString("en-US")} bytes).{" "}
          <a class="btn sm" href={rawUrl}>
            {raw(ICONS.download)} Download
          </a>
        </div>
      );
    } else if (blob.size > MAX_RENDER) {
      content = (
        <div class="empty">
          This file is too large to display ({fmtBytes(blob.size)}). <a href={rawUrl}>View raw</a>
        </div>
      );
    } else {
      const text = decoder().decode(blob.content);
      const lines = text.split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      lineCount = lines.length;
      if (isMarkdown(path) && !plain) {
        content = (
          <div class="body readme" style="margin:0;padding:24px 32px">
            <Markdown text={text} base={{ owner: repo.owner_login, repo: repo.name, ref, dir: path.split("/").slice(0, -1).join("/") }} empty="Empty file." />
          </div>
        );
      } else {
        const shown = lines.map((l) => l.replace(/\r$/, ""));
        const toks = await highlightLines(shown, langForPath(path));
        content = (
          <div class="code-wrap">
            <table class="blob">
              {shown.map((line, i) => (
                <tr id={`L${i + 1}`}>
                  <td class="ln">
                    <a href={`#L${i + 1}`}>{i + 1}</a>
                  </td>
                  {toks?.[i] ? <td class="sh">{tokens(toks[i])}</td> : <td>{line}</td>}
                </tr>
              ))}
            </table>
          </div>
        );
      }
    }
    return render(
      c,
      { title: `${path} at ${ref} · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code", ref } },
      <div>
        <div class="row between mb">
          <div class="row">
            <RefSwitcher current={ref} branches={names.branches} tags={names.tags} to={(r) => `${base}/blob/${encPath(r)}/${encPath(path)}`} />
            <Crumbs base={base} ref={ref} path={path} />
            <CopyButton text={path} label="Copy path" />
          </div>
        </div>
        <div class="box">
          <div class="head small">
            <span class="muted">
              {lineCount ? `${lineCount} line${lineCount === 1 ? "" : "s"} · ` : ""}
              {fmtBytes(blob.size)}
              {blob.mode === "100755" ? " · executable" : ""}
            </span>
            <span class="grow" />
            {isMarkdown(path) && !blob.binary ? (
              <div class="subnav">
                <a href={`?`} class={!plain ? "on" : ""}>
                  Preview
                </a>
                <a href={`?plain=1`} class={plain ? "on" : ""}>
                  Code
                </a>
              </div>
            ) : null}
            <a class="btn sm" href={rawUrl}>
              Raw
            </a>
            <a class="btn sm" href={`${base}/commits/${encPath(ref)}${qs({ path })}`}>
              {raw(ICONS.history)} History
            </a>
            {canEdit ? (
              <a class="btn sm" href={`${base}/edit/${encPath(ref)}/${encPath(path)}`}>
                {raw(ICONS.edit)} Edit
              </a>
            ) : null}
          </div>
          {content}
        </div>
      </div>,
    );
  });

  web.get("/:owner/:repo/raw/*", async (c) => {
    const { stub } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { ref, path } = await splitRefPath(stub, restOfPath(c, 3));
    const blob = path ? await stub.blob(ref, path) : null;
    if (!blob) throw new HttpError(404, "file not found");
    const ext = extOf(path);
    const type = IMAGE_TYPES[ext] ?? (blob.binary ? "application/octet-stream" : "text/plain; charset=utf-8");
    const name = path.split("/").pop() ?? "file";
    const headers: Record<string, string> = {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "cache-control": /^[0-9a-f]{40}$/.test(ref) ? "private, max-age=86400, immutable" : "private, max-age=60",
      "content-disposition": `${type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-frame-options": "DENY",
    };
    return new Response(blob.content, { headers });
  });

  // Editor (edit an existing file / create a new one).
  const editorGet = async (c: AppContext, mode: "edit" | "new") => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const names = await refNames(stub);
    const empty = !names.branches.length && !names.tags.length;
    const rest = restOfPath(c, 3);
    const split = empty ? { ref: rest.split("/")[0] || repo.default_branch, path: rest.split("/").slice(1).join("/") } : await splitRefPath(stub, rest);
    const ref = split.ref;
    if (!empty && !names.branches.includes(ref)) throw new HttpError(422, "files can only be edited on a branch");
    const meName = caller.login;
    const patchBranch = `${meName}-patch-${Math.floor(Date.now() / 1000) % 100000}`;
    const canDirect = await canCommitDirect(l, ref);
    if (mode === "edit") {
      const blob = split.path ? await stub.blob(ref, split.path) : null;
      if (!blob) throw new HttpError(404, "file not found");
      if (blob.binary) throw new HttpError(422, "binary files cannot be edited in the browser");
      return render(
        c,
        { title: `Editing ${split.path}`, repo: { repo, caller, tab: "code", ref } },
        <Editor
          c={c}
          l={l}
          ref={ref}
          mode="edit"
          orig={split.path}
          dir=""
          canDirect={canDirect}
          v={{ path: split.path, content: decoder().decode(blob.content), message: `Update ${split.path.split("/").pop()}`, description: "", choice: canDirect ? "direct" : "branch", newBranch: patchBranch, head: blob.sha }}
        />,
      );
    }
    const headSha = empty ? "" : ((await stub.resolve(ref)) ?? "");
    const filename = c.req.query("filename") ?? "";
    const dir = split.path;
    return render(
      c,
      { title: `New file · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code", ref } },
      <>
        <p class="muted">
          Create a new file in <a href={`${base}/tree/${encPath(ref)}${dir ? `/${encPath(dir)}` : ""}`}>{dir || repo.name}</a>.
        </p>
        <Editor
          c={c}
          l={l}
          ref={ref}
          mode="new"
          orig=""
          dir={dir}
          canDirect={canDirect || empty}
          v={{ path: `${dir ? `${dir}/` : ""}${cleanPath(filename) ?? ""}`, content: "", message: filename ? `Create ${filename}` : "Create new file", description: "", choice: canDirect || empty ? "direct" : "branch", newBranch: patchBranch, head: headSha }}
        />
      </>,
    );
  };

  const editorPost = async (c: AppContext, mode: "edit" | "new", f: FormData) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const names = await refNames(stub);
    const empty = !names.branches.length && !names.tags.length;
    const rest = restOfPath(c, 3);
    const split = empty ? { ref: rest.split("/")[0] || repo.default_branch, path: rest.split("/").slice(1).join("/") } : await splitRefPath(stub, rest);
    const ref = split.ref;
    const orig = mode === "edit" ? split.path : "";
    const head = f.s("head");

    if (mode === "edit" && f.b("_delete")) {
      return act(c, `${base}/blob/${encPath(ref)}/${encPath(orig)}`, async () => {
        await stub.commitFiles({ branch: ref, message: `Delete ${orig}`, changes: [{ path: orig, delete: true }], expectedHeadSha: head || undefined }, caller);
        const parent = orig.split("/").slice(0, -1).join("/");
        return `${base}/tree/${encPath(ref)}${parent ? `/${encPath(parent)}` : ""}`;
      });
    }

    let content = f.s("content");
    if (content.startsWith("\r\n")) content = content.slice(2);
    else if (content.startsWith("\n")) content = content.slice(1);
    let mode100: "100644" | "100755" | "120000" | undefined;
    if (mode === "edit") {
      const old = await stub.blob(ref, orig);
      const crlf = !!old && decoder().decode(old.content.slice(0, 65536)).includes("\r\n");
      if (!crlf) content = content.replace(/\r\n/g, "\n");
      if (old && (old.mode === "100755" || old.mode === "120000")) mode100 = old.mode;
    } else content = content.replace(/\r\n/g, "\n");
    const values: EditorValues = {
      path: f.s("path"),
      content,
      message: f.s("message"),
      description: f.s("description"),
      choice: f.s("choice") === "direct" ? "direct" : "branch",
      newBranch: f.s("new_branch").trim(),
      head,
    };
    const canDirect = empty || (await canCommitDirect(l, ref));
    try {
      const path = cleanPath(values.path);
      if (!path) throw new HttpError(422, "enter a valid file path");
      if (!values.message.trim()) throw new HttpError(422, "a commit message is required");
      const toBranch = values.choice === "direct" && canDirect ? ref : values.newBranch;
      if (!toBranch) throw new HttpError(422, "enter a branch name");
      const changes: Array<{ path: string; content?: Uint8Array; delete?: boolean; mode?: "100644" | "100755" | "120000" }> = [];
      if (mode === "edit" && path !== orig) changes.push({ path: orig, delete: true });
      if (mode === "new" && !empty && (await stub.blob(ref, path))) throw new HttpError(422, `${path} already exists`);
      changes.push({ path, content: new TextEncoder().encode(content), mode: mode100 });
      const message = values.description.trim() ? `${values.message.trim()}\n\n${values.description.trim()}` : values.message.trim();
      const newBranch = toBranch !== ref;
      if (newBranch && names.branches.includes(toBranch)) throw new HttpError(422, `branch ${toBranch} already exists`);
      await stub.commitFiles({ branch: toBranch, message, changes, expectedHeadSha: !newBranch && head ? head : undefined, createBranchFrom: newBranch ? ref : undefined }, caller);
      c.executionCtx.waitUntil(c.get("dir").touchPushed(repo.id));
      if (newBranch) return c.redirect(`${base}/compare/${encPath(ref)}...${encPath(toBranch)}`, 303);
      return c.redirect(`${base}/blob/${encPath(ref)}/${encPath(path)}`, 303);
    } catch (e) {
      const s = statusOf(e);
      if (s.status >= 500) throw e;
      return render(
        c,
        { title: mode === "edit" ? `Editing ${orig}` : "New file", repo: { repo, caller, tab: "code", ref }, status: s.status },
        <Editor c={c} l={l} ref={ref} mode={mode} orig={orig} dir={mode === "new" ? split.path : ""} canDirect={canDirect} v={values} error={s.message} />,
      );
    }
  };

  web.get("/:owner/:repo/edit/*", (c) => editorGet(c, "edit"));
  post(web, "/:owner/:repo/edit/*", (c, f) => editorPost(c, "edit", f));
  web.get("/:owner/:repo/new/*", (c) => editorGet(c, "new"));
  post(web, "/:owner/:repo/new/*", (c, f) => editorPost(c, "new", f));

  // History
  web.get("/:owner/:repo/commits/*", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const ref = restOfPath(c, 3) || repo.default_branch;
    const path = c.req.query("path") ?? "";
    const page = pageNum(c);
    const per = 30;
    const [commits, names] = await Promise.all([stub.log(ref, { path: path || undefined, limit: per + 1, skip: (page - 1) * per }), refNames(stub)]);
    const hasNext = commits.length > per;
    const shown = commits.slice(0, per);
    const groups = new Map<string, typeof shown>();
    for (const cm of shown) {
      const day = new Date(cm.committer.timestamp * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
      groups.set(day, [...(groups.get(day) ?? []), cm]);
    }
    return render(
      c,
      { title: `Commits · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code", ref } },
      <div>
        <div class="row between mb">
          <div class="row">
            <h1 class="m0">Commits</h1>
            <RefSwitcher current={ref} branches={names.branches} tags={names.tags} to={(r) => `${base}/commits/${encPath(r)}${qs({ path })}`} />
            {path ? (
              <span class="muted">
                for <span class="mono">{path}</span> · <a href={`${base}/commits/${encPath(ref)}`}>all files</a>
              </span>
            ) : null}
          </div>
        </div>
        {shown.length === 0 ? <div class="blank">No commits found.</div> : null}
        {[...groups.entries()].map(([day, list]) => (
          <div class="mb">
            <h3 class="muted small" style="font-weight:500">
              {raw(ICONS.commit)} Commits on {day}
            </h3>
            <div class="box">
              <ul class="list">
                {list.map((cm) => (
                  <CommitRow base={base} sha={cm.sha} message={cm.message} author={cm.author} signed={cm.signed} />
                ))}
              </ul>
            </div>
          </div>
        ))}
        <Pager page={page} hasNext={hasNext} href={(p) => `${base}/commits/${encPath(ref)}${qs({ path, page: p > 1 ? p : undefined })}`} />
      </div>,
    );
  });
  web.get("/:owner/:repo/commits", (c) => c.redirect(`/${prm(c, "owner")}/${prm(c, "repo")}/commits/HEAD`, 302));

  web.get("/:owner/:repo/commit/:sha", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const cm = await stub.commitWithDiff(prm(c, "sha"));
    const checks = await stub.checksAndStatuses(cm.sha).catch(() => []);
    const [title, ...rest] = cm.message.split("\n");
    const body = rest.join("\n").trim();
    const files = cm.files as DiffFile[];
    return render(
      c,
      { title: `${firstLine(cm.message)} · ${shortSha(cm.sha)}`, repo: { repo, caller, tab: "code", ref: cm.sha }, wide: true },
      <div>
        <div class="box">
          <div class="body">
            <h2 style="font-size:18px">{title}</h2>
            {body ? <pre style="white-space:pre-wrap;margin:0 0 12px;font-size:13px">{body}</pre> : null}
            <div class="row small muted">
              <b style="color:var(--fg)">{cm.author.name}</b> authored <Time at={new Date(cm.author.timestamp * 1000).toISOString()} />
              {cm.committer.name !== cm.author.name ? (
                <span>
                  · <b style="color:var(--fg)">{cm.committer.name}</b> committed <Time at={new Date(cm.committer.timestamp * 1000).toISOString()} />
                </span>
              ) : null}
              {cm.signed ? <span class="badge green">signed</span> : null}
              <span class="grow" />
              <span>
                {cm.parents.length} parent{cm.parents.length === 1 ? "" : "s"}{" "}
                {cm.parents.map((p) => (
                  <a class="sha" href={`${base}/commit/${p}`} style="margin-left:4px">
                    {shortSha(p)}
                  </a>
                ))}
              </span>
              <span>
                commit <span class="sha">{cm.sha}</span>
              </span>
              <CopyButton text={cm.sha} />
              <a class="btn sm" href={`${base}/tree/${cm.sha}`}>
                Browse files
              </a>
            </div>
            {checks.length ? (
              <ul class="checks mt">
                {checks.map((ch) => (
                  <li>
                    <Status status={ch.status} conclusion={ch.conclusion} />
                    <CheckName base={base} ch={ch} />
                    <span class="muted small">{ch.output?.title ?? ""}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        <div class="row between mb">
          <DiffStats files={cm.totalFiles} additions={cm.additions} deletions={cm.deletions} />
          {cm.truncated ? <span class="badge amber">showing the first {files.length} files</span> : null}
        </div>
        <FileSummary files={files} />
        <DiffView files={files} opts={{ viewHref: (p) => `${base}/blob/${cm.sha}/${encPath(p)}` }} />
      </div>,
    );
  });

  // Branches and tags
  web.get("/:owner/:repo/branches", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const { repo, caller, stub } = l;
    const base = repoUrl(repo);
    const t = csrfToken(c);
    const branches = await stub.branches();
    branches.sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name)));
    const infos = await Promise.all(branches.slice(0, 40).map((b) => stub.commitInfo(b.sha).catch(() => null)));
    const canWrite = atLeast(caller.role, "write") && !repo.archived;
    return render(
      c,
      { title: `Branches · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code" } },
      <div>
        <div class="row between mb">
          <h1 class="m0">Branches</h1>
        </div>
        <div class="box">
          {branches.length ? (
            <ul class="list">
              {branches.map((b, i) => {
                const info = infos[i];
                return (
                  <li>
                    <span class="st faint">{raw(ICONS.branch)}</span>
                    <div class="grow">
                      <a class="title mono" href={`${base}/tree/${encPath(b.name)}`}>
                        {b.name}
                      </a>{" "}
                      {b.isDefault ? <span class="badge blue">default</span> : null} {b.protected ? <span class="badge">{raw(ICONS.shield)} protected</span> : null}
                      {info ? (
                        <div class="meta">
                          {firstLine(info.message)} · {info.author.name} · <Time at={new Date(info.committer.timestamp * 1000).toISOString()} />
                        </div>
                      ) : null}
                    </div>
                    <a class="sha" href={`${base}/commit/${b.sha}`}>
                      {shortSha(b.sha)}
                    </a>
                    {!b.isDefault ? (
                      <a class="btn sm" href={`${base}/compare/${encPath(repo.default_branch)}...${encPath(b.name)}`}>
                        {raw(ICONS.pr)} Compare
                      </a>
                    ) : null}
                    {canWrite && !b.isDefault ? (
                      <Form action={`${base}/branches/delete`} t={t} class="inline" confirm={`Delete branch ${b.name}?`}>
                        <input type="hidden" name="name" value={b.name} />
                        <button class="btn sm danger" title="Delete branch">
                          {raw(ICONS.x)}
                        </button>
                      </Form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div class="empty">No branches yet.</div>
          )}
        </div>
        {canWrite && branches.length ? (
          <Form action={`${base}/branches`} t={t} class="box">
            <div class="head">
              <h3>Create a branch</h3>
            </div>
            <div class="body row" style="align-items:flex-end">
              <div class="field grow m0">
                <label>Branch name</label>
                <input name="name" type="text" required class="mono" />
              </div>
              <div class="field m0">
                <label>From</label>
                <KSelect name="from" label="From" value={branches.find((b) => b.isDefault)?.name} options={branches.map((b) => ({ value: b.name, label: b.name }))} />
              </div>
              <button class="btn primary">Create branch</button>
            </div>
          </Form>
        ) : null}
      </div>,
    );
  });

  post(web, "/:owner/:repo/branches", async (c, f) => {
    const { repo, caller, stub } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    const base = repoUrl(repo);
    return act(c, `${base}/branches`, async () => {
      const name = f.s("name").trim();
      const sha = await stub.resolve(f.s("from"));
      if (!sha) throw new HttpError(422, "unknown source branch");
      await stub.createRef(`refs/heads/${name}`, sha, caller);
      return `${base}/tree/${encPath(name)}`;
    });
  });

  post(web, "/:owner/:repo/branches/delete", async (c, f) => {
    const { repo, caller, stub } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    return act(c, `${repoUrl(repo)}/branches`, async () => stub.deleteRef(`refs/heads/${f.s("name")}`, caller), "Branch deleted.");
  });

  web.get("/:owner/:repo/tags", async (c) => {
    const { repo, caller, stub } = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const base = repoUrl(repo);
    const tags = (await stub.tags()).reverse();
    const infos = await Promise.all(tags.slice(0, 40).map((tg) => stub.commitInfo(tg.target).catch(() => null)));
    return render(
      c,
      { title: `Tags · ${repo.owner_login}/${repo.name}`, repo: { repo, caller, tab: "code" } },
      <div>
        <h1>Tags</h1>
        <div class="box">
          {tags.length ? (
            <ul class="list">
              {tags.map((tg, i) => (
                <li>
                  <span class="st faint">{raw(ICONS.tag)}</span>
                  <div class="grow">
                    <a class="title mono" href={`${base}/tree/${encPath(tg.name)}`}>
                      {tg.name}
                    </a>
                    {infos[i] ? (
                      <div class="meta">
                        {firstLine(infos[i]!.message)} · <Time at={new Date(infos[i]!.committer.timestamp * 1000).toISOString()} />
                      </div>
                    ) : null}
                  </div>
                  <a class="sha" href={`${base}/commit/${tg.target}`}>
                    {shortSha(tg.target)}
                  </a>
                  <a class="btn sm" href={`${base}/compare/${encPath(tg.name)}...${encPath(repo.default_branch)}`}>
                    Compare
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">
              No tags yet. Create one with <code>git tag v1.0.0 && git push --tags</code>.
            </div>
          )}
        </div>
      </div>,
    );
  });

  // Compare
  web.get("/:owner/:repo/compare", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const base = repoUrl(l.repo);
    const b = c.req.query("base");
    const h = c.req.query("head");
    if (b && h) return c.redirect(`${base}/compare/${encPath(b)}...${encPath(h)}`, 302);
    const names = await refNames(l.stub);
    const other = names.branches.find((x) => x !== l.repo.default_branch);
    return comparePage(c, l, l.repo.default_branch, h ?? other ?? l.repo.default_branch);
  });

  web.get("/:owner/:repo/compare/*", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const spec = restOfPath(c, 3);
    const idx = spec.indexOf("...");
    const baseRef = idx >= 0 ? spec.slice(0, idx) : l.repo.default_branch;
    const headRef = idx >= 0 ? spec.slice(idx + 3) : spec;
    if (!headRef) return c.redirect(`${repoUrl(l.repo)}/compare`, 302);
    return comparePage(c, l, baseRef || l.repo.default_branch, headRef);
  });

  post(web, "/:owner/:repo/pulls", async (c, f) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    if (c.get("principal").type !== "account") throw new HttpError(401, "sign in required");
    const values: PullFormValues = { title: f.s("title").trim(), body: f.s("body").replace(/\r\n/g, "\n"), intent: f.s("intent").replace(/\r\n/g, "\n").trim(), draft: f.b("draft"), ...(f.b("auto_merge_offered") ? { autoMerge: f.b("auto_merge") } : {}) };
    const baseRef = f.s("base") || l.repo.default_branch;
    const headRef = f.s("head");
    try {
      const pr = await l.stub.createPull({ title: values.title, body: values.body, head: headRef, base: baseRef, draft: values.draft, intent: values.intent || undefined, ...(values.autoMerge !== undefined ? { autoMerge: values.autoMerge } : {}) }, l.caller);
      return c.redirect(`${repoUrl(l.repo)}/pull/${pr.number}`, 303);
    } catch (e) {
      const s = statusOf(e);
      if (s.status >= 500) throw e;
      return comparePage(c, l, baseRef, headRef, { values, error: s.message });
    }
  });
}

/** Whether a web commit straight to `branch` would pass protection rules for this caller. */
async function canCommitDirect(l: Loaded, branch: string): Promise<boolean> {
  const rules = (await l.stub.listProtections()).find((p) => globToRegExp(p.pattern).test(branch))?.rules;
  if (l.caller.kind === "agent" && (branch === l.repo.default_branch || rules) && !rules?.agentsMayPush) return false;
  if (!rules) return true;
  if (l.caller.role === "admin" && !rules.enforceAdmins) return true;
  return !rules.requirePullRequest;
}

