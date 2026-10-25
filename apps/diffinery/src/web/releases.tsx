/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import type { AppContext } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { storeAsset } from "../http/files.js";
import { HttpError } from "../lib/util.js";
import type { Release } from "../repo/releases.js";
import { atLeast } from "../repo/types.js";
import { ICONS } from "./assets.js";
import { CSRF_FIELD, csrfToken, type FormData } from "./csrf.js";
import { KCheckbox, KSelect } from "./kumo.js";
import { Actor, Form, Markdown, Pager, Time, act, encPath, flash, fmtBytes, pageNum, post, prm, refNames, render, repoUrl, restOfPath, statusOf, type WebApp } from "./ui.js";

/**
 * Releases: the list, a release page per tag, and the new/edit form with
 * asset uploads. Bytes go to R2 through the same path as the REST upload_url.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

/** The largest upload the web form takes in one submission; bigger files go through the API's upload_url. */
const MAX_FORM_UPLOAD = 100 * 1024 * 1024;
/** The whole form body, files plus the other fields; checked before the body is read. */
const MAX_FORM_BODY = MAX_FORM_UPLOAD + 1024 * 1024;

async function forAction(c: AppContext): Promise<Loaded> {
  if (c.get("principal").type !== "account") throw new HttpError(401, "sign in required");
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  return l;
}

function releaseId(c: AppContext, name = "id"): number {
  const n = Number(prm(c, name));
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "not found");
  return n;
}

const tagHref = (base: string, tag: string) => `${base}/releases/tag/${encPath(tag)}`;

// ---------------------------------------------------------------- repo home sidebar

/** The "Releases" section on the repository home page, plus topics when the repo has any. */
export const ReleasesSection: FC<{ base: string; summary: { count: number; latest: Release | null } | null; canWrite: boolean; topics?: string }> = ({ base, summary, canWrite, topics }) => {
  let names: string[] = [];
  try {
    const t = JSON.parse(topics ?? "[]");
    if (Array.isArray(t)) names = t.filter((x): x is string => typeof x === "string");
  } catch {
    names = [];
  }
  return (
    <>
      {names.length ? (
        <section>
          <h3>Topics</h3>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            {names.map((n) => (
              <span class="badge blue">{n}</span>
            ))}
          </div>
        </section>
      ) : null}
      <section>
        <h3>
          <a href={`${base}/releases`} style="color:inherit">
            Releases
          </a>{" "}
          {summary?.count ? <span class="badge">{summary.count}</span> : null}
        </h3>
        {summary?.latest ? (
          <div class="row" style="align-items:flex-start">
            <span class="st green">{raw(ICONS.tag)}</span>
            <div>
              <a href={tagHref(base, summary.latest.tagName)}>
                <b>{summary.latest.name || summary.latest.tagName}</b>
              </a>{" "}
              <span class="badge green">Latest</span>
              <div class="muted small">
                <Time at={summary.latest.publishedAt ?? summary.latest.createdAt} />
              </div>
            </div>
          </div>
        ) : (
          <p class="small muted m0">
            No releases published.{" "}
            {canWrite ? <a href={`${base}/releases/new`}>Create a new release</a> : null}
          </p>
        )}
      </section>
    </>
  );
};

// ---------------------------------------------------------------- list and release pages

const Badges: FC<{ r: Release }> = ({ r }) => (
  <>
    {r.draft ? <span class="badge amber">Draft</span> : null}
    {r.prerelease ? <span class="badge amber">Pre-release</span> : null}
    {r.latest ? <span class="badge green">Latest</span> : null}
  </>
);

const ReleaseCard: FC<{ c: AppContext; l: Loaded; r: Release; full?: boolean }> = ({ c, l, r, full }) => {
  const base = repoUrl(l.repo);
  const canWrite = atLeast(l.caller.role, "write") && !l.repo.archived;
  const t = csrfToken(c);
  return (
    <div class="box" id={`release-${r.id}`}>
      <div class="head">
        <div class="grow">
          <h2 style="margin:0;font-size:20px">
            <a href={tagHref(base, r.tagName)} style="color:var(--fg)">
              {r.name || r.tagName}
            </a>{" "}
            <Badges r={r} />
          </h2>
          <div class="muted small" style="margin-top:4px">
            <span class="faint">{raw(ICONS.tag)}</span>{" "}
            <a class="mono" href={`${base}/tree/${encPath(r.tagName)}`}>
              {r.tagName}
            </a>{" "}
            · <Actor login={r.author.login} kind={r.author.kind} /> {r.draft ? "drafted this" : "released this"} <Time at={r.publishedAt ?? r.createdAt} />
          </div>
        </div>
        {canWrite ? (
          <div class="row">
            <a class="btn sm" href={`${base}/releases/edit/${encPath(r.tagName)}?id=${r.id}`}>
              {raw(ICONS.edit)} Edit
            </a>
            <Form action={`${base}/releases/${r.id}/delete`} t={t} confirm={`Delete the release ${r.name || r.tagName}? The tag stays.`}>
              <button class="btn sm danger">Delete</button>
            </Form>
          </div>
        ) : null}
      </div>
      <div class="body">
        <Markdown text={full || r.body.length < 4000 ? r.body : `${r.body.slice(0, 4000)}…`} base={{ owner: l.repo.owner_login, repo: l.repo.name, ref: r.tagName, dir: "" }} empty="No release notes." />
        <h3 class="mt">
          Assets <span class="badge">{r.assets.length + 2}</span>
        </h3>
        <ul class="list" style="border:1px solid var(--border);border-radius:6px">
          {r.assets.map((a) => (
            <li>
              <span class="st faint">{raw(ICONS.file)}</span>
              <div class="grow">
                <a class="title" href={`${base}/releases/download/${encPath(r.tagName)}/${encodeURIComponent(a.name)}`} rel="nofollow">
                  {a.name}
                </a>
                {a.label && a.label !== a.name ? <span class="muted small"> {a.label}</span> : null}
              </div>
              <span class="muted small">{fmtBytes(a.size)}</span>
              <span class="muted small" title="downloads">
                {raw(ICONS.download)} {a.downloadCount}
              </span>
              {canWrite && full ? (
                <Form action={`${base}/releases/${r.id}/assets/${a.id}/delete`} t={t} confirm={`Delete ${a.name}?`}>
                  <button class="btn sm" title="Delete asset" aria-label={`Delete ${a.name}`}>
                    {raw(ICONS.x)}
                  </button>
                </Form>
              ) : null}
            </li>
          ))}
          {r.draft ? null : (
            <>
              <li>
                <span class="st faint">{raw(ICONS.code)}</span>
                <a class="title grow" href={`${base}/archive/refs/tags/${encPath(r.tagName)}.zip`} rel="nofollow">
                  Source code (zip)
                </a>
              </li>
              <li>
                <span class="st faint">{raw(ICONS.code)}</span>
                <a class="title grow" href={`${base}/archive/refs/tags/${encPath(r.tagName)}.tar.gz`} rel="nofollow">
                  Source code (tar.gz)
                </a>
              </li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
};

async function listPage(c: AppContext): Promise<Response> {
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
  const page = pageNum(c);
  const per = 10;
  const res = await l.stub.listReleases({ limit: per, offset: (page - 1) * per }, l.caller);
  const base = repoUrl(l.repo);
  const canWrite = atLeast(l.caller.role, "write") && !l.repo.archived;
  return render(
    c,
    { title: `Releases · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "code" }, description: `Releases of ${l.repo.owner_login}/${l.repo.name}` },
    <div style="max-width:980px">
      <div class="row between mb">
        <h1 class="m0">Releases</h1>
        <div class="row">
          <a class="btn" href={`${base}/tags`}>
            {raw(ICONS.tag)} Tags
          </a>
          {canWrite ? (
            <a class="btn green" href={`${base}/releases/new`}>
              Draft a new release
            </a>
          ) : null}
        </div>
      </div>
      {res.items.length ? (
        res.items.map((r) => <ReleaseCard c={c} l={l} r={r} />)
      ) : (
        <div class="box">
          <div class="empty">
            There aren't any releases here yet.
            {canWrite ? (
              <>
                {" "}
                <a href={`${base}/releases/new`}>Create the first release</a>, or publish one from a workflow with the REST API.
              </>
            ) : null}
          </div>
        </div>
      )}
      <Pager page={page} hasNext={page * per < res.total} href={(p) => `${base}/releases?page=${p}`} />
    </div>,
  );
}

async function tagPage(c: AppContext): Promise<Response> {
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
  const tag = restOfPath(c, 4);
  if (!tag) return c.redirect(`${repoUrl(l.repo)}/releases`, 302);
  const r = await l.stub.releaseByTag(tag, l.caller, true);
  return render(
    c,
    { title: `${r.name || r.tagName} · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "code" }, description: `Release ${r.tagName} of ${l.repo.owner_login}/${l.repo.name}` },
    <div style="max-width:980px">
      <div class="crumbs mb">
        <a href={`${repoUrl(l.repo)}/releases`}>Releases</a>
        <span class="faint">/</span>
        <b>{r.tagName}</b>
      </div>
      <ReleaseCard c={c} l={l} r={r} full />
    </div>,
  );
}

// ---------------------------------------------------------------- new and edit

type FormValues = { tag: string; newTag: string; target: string; name: string; body: string; prerelease: boolean; latest: boolean; generate: boolean };

const ReleaseForm: FC<{ c: AppContext; l: Loaded; tags: string[]; branches: string[]; v: FormValues; r?: Release; error?: string }> = ({ c, l, tags, branches, v, r, error }) => {
  const base = repoUrl(l.repo);
  const action = r ? `${base}/releases/${r.id}/edit` : `${base}/releases`;
  const targets = [...new Set([l.repo.default_branch, ...branches])];
  return (
    <div style="max-width:900px">
      <h1>{r ? `Edit release ${r.tagName}` : "New release"}</h1>
      {error ? <div class="flash error">{error}</div> : null}
      <form method="post" action={action} enctype="multipart/form-data" class="box">
        <input type="hidden" name={CSRF_FIELD} value={csrfToken(c)} />
        <div class="body">
          <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:wrap">
            <div class="field grow" style="min-width:220px">
              <label>Tag</label>
              <KSelect name="tag" label="Existing tag" placeholder="Choose an existing tag" value={tags.includes(v.tag) ? v.tag : undefined} options={tags.map((t) => ({ value: t, label: t }))} block />
              <input type="text" name="new_tag" value={tags.includes(v.tag) ? "" : v.newTag || v.tag} placeholder="or type a new tag, e.g. v1.2.0" aria-label="New tag name" style="margin-top:6px" />
            </div>
            <div class="field" style="min-width:200px">
              <label>Target for a new tag</label>
              <KSelect name="target" label="Target branch" value={v.target || l.repo.default_branch} options={targets.map((b) => ({ value: b, label: b }))} block />
            </div>
          </div>
          <div class="field">
            <label for="rn">Release title</label>
            <input id="rn" name="name" type="text" value={v.name} placeholder="Defaults to the tag name" />
          </div>
          <div class="field">
            <label for="rb">Release notes</label>
            <textarea id="rb" name="body" style="min-height:240px" placeholder="Markdown is supported.">
              {v.body}
            </textarea>
          </div>
          <div class="field">
            <label for="ra">Attach files</label>
            <input id="ra" name="assets" type="file" multiple />
            <p class="small muted m0">Up to 100 MB per submission. Use the REST API's upload_url for larger files.</p>
          </div>
          {r?.assets.length ? (
            <p class="small muted">
              Attached: {r.assets.map((a) => a.name).join(", ")}. Remove files from the <a href={tagHref(base, r.tagName)}>release page</a>.
            </p>
          ) : null}
          <div class="field checklist">
            <KCheckbox name="prerelease" checked={v.prerelease} label="Set as a pre-release (not production ready)" />
            <KCheckbox name="latest" checked={v.latest} label="Set as the latest release" />
            {r ? null : <KCheckbox name="generate" checked={v.generate} label="Generate release notes from merged pull requests (when the notes are empty)" />}
          </div>
          <div class="row">
            {r && !r.draft ? (
              <button class="btn green" name="action" value="publish">
                Update release
              </button>
            ) : (
              <>
                <button class="btn green" name="action" value="publish">
                  Publish release
                </button>
                <button class="btn" name="action" value="draft">
                  Save draft
                </button>
              </>
            )}
            <a class="btn" href={r ? tagHref(base, r.tagName) : `${base}/releases`}>
              Cancel
            </a>
          </div>
        </div>
      </form>
    </div>
  );
};

function valuesOf(f: FormData): FormValues {
  return {
    tag: f.s("tag").trim(),
    newTag: f.s("new_tag").trim(),
    target: f.s("target").trim(),
    name: f.s("name").trim(),
    body: f.s("body").replace(/\r\n/g, "\n"),
    prerelease: f.b("prerelease"),
    latest: f.b("latest"),
    generate: f.b("generate"),
  };
}

/** The files chosen in the form's file input (empty file inputs submit a nameless, empty part). */
async function uploadedFiles(c: AppContext): Promise<File[]> {
  const raw = (await c.req.parseBody({ all: true })) as Record<string, string | File | Array<string | File>>;
  const v = raw.assets;
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  const files = list.filter((x): x is File => typeof x !== "string" && !!x.name && x.size > 0);
  const total = files.reduce((n, x) => n + x.size, 0);
  if (total > MAX_FORM_UPLOAD) throw new HttpError(413, "the web form takes up to 100 MB of files at once; upload larger files with the REST API");
  return files;
}

async function attach(c: AppContext, l: Loaded, id: number, files: File[]): Promise<void> {
  for (const file of files) {
    await storeAsset(c.env, l.stub, id, { name: file.name, contentType: file.type || "application/octet-stream" }, { stream: file.stream(), length: file.size }, l.caller);
  }
}

async function formPage(c: AppContext, l: Loaded, v: FormValues, r?: Release, error?: string, status?: number): Promise<Response> {
  const names = await refNames(l.stub);
  return render(c, { title: `${r ? "Edit release" : "New release"} · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "code" }, status }, <ReleaseForm c={c} l={l} tags={[...names.tags].reverse()} branches={names.branches} v={v} r={r} error={error} />);
}

// ---------------------------------------------------------------- routes

export function registerReleases(web: WebApp): void {
  web.get("/:owner/:repo/releases", (c) => listPage(c));

  web.get("/:owner/:repo/releases/latest", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
    const r = await l.stub.latestRelease().catch(() => null);
    return c.redirect(r ? tagHref(repoUrl(l.repo), r.tagName) : `${repoUrl(l.repo)}/releases`, 302);
  });

  web.get("/:owner/:repo/releases/tag/*", (c) => tagPage(c));

  web.get("/:owner/:repo/releases/new", async (c) => {
    const l = await forAction(c);
    const tag = (c.req.query("tag") ?? "").trim();
    return formPage(c, l, { tag, newTag: tag, target: l.repo.default_branch, name: "", body: "", prerelease: false, latest: true, generate: true });
  });

  web.get("/:owner/:repo/releases/edit/*", async (c) => {
    const l = await forAction(c);
    const idq = Number(c.req.query("id"));
    const r = Number.isInteger(idq) && idq > 0 ? await l.stub.getRelease(idq, l.caller) : await l.stub.releaseByTag(restOfPath(c, 4), l.caller, true);
    return formPage(c, l, { tag: r.tagName, newTag: r.tagName, target: r.targetCommitish, name: r.name, body: r.body, prerelease: r.prerelease, latest: r.latest, generate: false }, r);
  });

  post(web, "/:owner/:repo/releases", async (c, f) => {
    const l = await forAction(c);
    const v = valuesOf(f);
    const draft = f.s("action") === "draft";
    try {
      const files = await uploadedFiles(c);
      const tag = v.newTag || v.tag;
      if (!tag) throw new HttpError(422, "choose a tag or type a new one");
      const r = await l.stub.createRelease(
        {
          tag_name: tag,
          target_commitish: v.target || undefined,
          name: v.name || null,
          body: v.body || null,
          draft,
          prerelease: v.prerelease,
          make_latest: v.latest ? "true" : "false",
          generate_release_notes: v.generate && !v.body.trim(),
        },
        l.caller,
      );
      try {
        await attach(c, l, r.id, files);
      } catch (e) {
        const s = statusOf(e);
        if (s.status >= 500) throw e;
        flash(c, "error", `The release was saved, but a file couldn't be attached: ${s.message}`);
        return c.redirect(`${repoUrl(l.repo)}/releases/edit/${encPath(r.tagName)}?id=${r.id}`, 303);
      }
      return c.redirect(tagHref(repoUrl(l.repo), r.tagName), 303);
    } catch (e) {
      const s = statusOf(e);
      if (s.status >= 500) throw e;
      return formPage(c, l, v, undefined, s.message, s.status);
    }
  }, { maxBytes: MAX_FORM_BODY });

  post(web, "/:owner/:repo/releases/:id/edit", async (c, f) => {
    const l = await forAction(c);
    const id = releaseId(c);
    const before = await l.stub.getRelease(id, l.caller);
    const v = valuesOf(f);
    const publish = f.s("action") !== "draft";
    try {
      const files = await uploadedFiles(c);
      const tag = v.newTag || v.tag || before.tagName;
      const r = await l.stub.updateRelease(
        id,
        {
          tag_name: tag,
          target_commitish: v.target || undefined,
          name: v.name,
          body: v.body,
          draft: before.draft ? !publish : false,
          prerelease: v.prerelease,
          make_latest: v.latest ? "true" : "false",
        },
        l.caller,
      );
      await attach(c, l, r.id, files);
      return c.redirect(tagHref(repoUrl(l.repo), r.tagName), 303);
    } catch (e) {
      const s = statusOf(e);
      if (s.status >= 500) throw e;
      return formPage(c, l, v, before, s.message, s.status);
    }
  }, { maxBytes: MAX_FORM_BODY });

  post(web, "/:owner/:repo/releases/:id/delete", async (c) => {
    const l = await forAction(c);
    const id = releaseId(c);
    const base = repoUrl(l.repo);
    return act(c, `${base}/releases`, async () => {
      await l.stub.deleteRelease(id, l.caller);
      return `${base}/releases`;
    }, "Release deleted. The tag was kept.");
  });

  post(web, "/:owner/:repo/releases/:id/assets/:asset/delete", async (c) => {
    const l = await forAction(c);
    const id = releaseId(c);
    const r = await l.stub.getRelease(id, l.caller);
    const back = tagHref(repoUrl(l.repo), r.tagName);
    const assetId = releaseId(c, "asset");
    return act(c, back, async () => {
      if (!r.assets.some((a) => a.id === assetId)) throw new HttpError(404, "asset not found");
      await l.stub.deleteReleaseAsset(assetId, l.caller);
    }, "Asset deleted.");
  });
}
