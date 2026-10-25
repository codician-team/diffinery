/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { loadRepo } from "../http/common.js";
import { ImportService, type Candidate, type ImportRow, type ImportSummary, type StepState, type StoredRequest } from "../imports/service.js";
import { webHostOf } from "../imports/options.js";
import { HttpError } from "../lib/util.js";
import { SettingsNav } from "./account.js";
import { csrfToken } from "./csrf.js";
import { KCheckbox, KRadio, KSelect } from "./kumo.js";
import { Actor, Form, Status, Time, act, fmtBytes, flash, post, prm, qs, render, repoUrl, type WebApp } from "./ui.js";

/**
 * Import from GitHub (Kumo controls throughout): the start form (one repository,
 * or many from an organization or user), the repository picker for bulk imports,
 * auto-refreshing progress pages, the list of past imports, the page for setting
 * secret values afterwards, and the linked-accounts settings page.
 */

const OPTIONS: Array<[keyof StoredRequest["options"], string, string]> = [
  ["issues", "Issues and pull requests", "With comments, reviews, labels and milestones, keeping their numbers."],
  ["labels", "Labels and milestones", "Even without issues."],
  ["protection", "Branch protection", "Mapped to Diffinery's rules; required checks are matched to this repository's workflows."],
  ["variables", "Actions variables and secret names", "Variable values and the names of secrets (never their values)."],
  ["releases", "Releases", "Release notes and their assets. The tags come with the Git data either way."],
  ["lfs", "Git LFS objects", "Large files tracked with Git LFS."],
];

const statusBadge = (s: string) =>
  s === "succeeded" ? <span class="badge green">succeeded</span> : s === "failed" ? <span class="badge red">failed</span> : s === "cancelled" ? <span class="badge">cancelled</span> : s === "running" ? <span class="badge amber">running</span> : s === "draft" ? <span class="badge">draft</span> : <span class="badge">{s}</span>;

const StartForm: FC<{ t: string; owners: string[]; values: Record<string, string>; error?: string }> = ({ t, owners, values, error }) => (
  <div style="max-width:760px;margin:0 auto">
    <h1>Import from GitHub</h1>
    <p class="muted">Copy a repository — or every repository of an organization or user — from GitHub.com or GitHub Enterprise, keeping its history, issues, pull requests, reviews, labels and more.</p>
    {error ? <div class="flash error">{error}</div> : null}
    <Form action="/new/import" t={t} class="box">
      <div class="body">
        <div class="field">
          <label>What to import</label>
          <KRadio
            name="mode"
            label="What to import"
            value={values.mode === "owner" ? "owner" : "repo"}
            items={[
              { value: "repo", label: "One repository", description: "owner/name, or a GitHub URL." },
              { value: "owner", label: "A whole organization or user", description: "Choose which of its repositories to import on the next step." },
            ]}
          />
        </div>
        <div class="field">
          <label for="source">GitHub repository, or organization/user</label>
          <input id="source" name="source" type="text" value={values.source} placeholder="diffy/hello-world  or  diffy" autofocus autocomplete="off" required />
          <p class="muted small m0">Example: a URL like https://github.com/diffy/hello-world, or just diffy/hello-world. For a whole account, its name.</p>
        </div>
        <div class="row" style="align-items:flex-end;gap:10px">
          <div class="field" style="min-width:200px">
            <label for="owner">Import into</label>
            <KSelect id="owner" name="owner" block label="Import into" value={values.owner && owners.includes(values.owner) ? values.owner : (owners[0] ?? "")} options={owners.map((o) => ({ value: o, label: o }))} />
          </div>
          <div class="field grow">
            <label for="name">
              New repository name <span class="faint">(one repository only; defaults to the GitHub name)</span>
            </label>
            <input id="name" name="name" type="text" value={values.name} autocomplete="off" placeholder="hello-world" />
          </div>
        </div>
        <div class="field">
          <label>Visibility</label>
          <KRadio
            name="visibility"
            label="Visibility"
            value={values.visibility || "keep"}
            orientation="horizontal"
            items={[
              { value: "keep", label: "Keep" },
              { value: "private", label: "Private" },
              { value: "public", label: "Public" },
            ]}
          />
        </div>
        <div class="field">
          <label for="github_token">
            GitHub token <span class="faint">(required for private repositories, LFS, variables and protection)</span>
          </label>
          <input id="github_token" name="github_token" type="password" autocomplete="off" placeholder="ghp_… or a fine-grained token" />
          <p class="muted small m0">A read token (classic `repo`, or a fine-grained token with Contents, Issues, Pull requests, Metadata). Used only for this import, encrypted at rest, and deleted when the import finishes.</p>
        </div>
        <details>
          <summary class="small" style="cursor:pointer;color:var(--accent)">
            What to copy, and GitHub Enterprise
          </summary>
          <div class="kstack mt" style="margin-top:8px">
            {OPTIONS.map(([k, label, desc]) => (
              <KCheckbox name={`opt_${k}`} checked={values[`opt_${k}`] !== "0"} label={<span><b>{label}</b> <span class="muted small">{desc}</span></span>} />
            ))}
          </div>
          <div class="field mt" style="margin-top:12px">
            <label>Secrets found in old history (push protection)</label>
            <KRadio
              name="secrets"
              label="Secrets in history"
              value={values.secrets || "bypass"}
              items={[
                { value: "bypass", label: "Import with an audited bypass", description: "The history is already on GitHub. A human admin's bypass is recorded, and the summary lists what to rotate." },
                { value: "stop", label: "Stop the import", description: "Fail if push protection finds a secret, so you can scrub the history first." },
              ]}
            />
          </div>
          <div class="field mt" style="margin-top:12px">
            <label for="github_api_url">
              GitHub Enterprise API URL <span class="faint">(optional)</span>
            </label>
            <input id="github_api_url" name="github_api_url" type="text" autocomplete="off" placeholder="https://ghe.example.com/api/v3" value={values.github_api_url} />
          </div>
        </details>
        <div class="field">
          <label for="concurrency">
            Repositories at a time <span class="faint">(organization or user imports)</span>
          </label>
          <input id="concurrency" name="concurrency" type="number" min="1" max="8" value={values.concurrency || "3"} style="max-width:100px" />
        </div>
        <button class="btn primary">Start import</button>
      </div>
    </Form>
  </div>
);

const SelectForm: FC<{ t: string; row: ImportRow; candidates: Candidate[]; filter: string; selected: Set<string> }> = ({ t, row, candidates, filter, selected }) => {
  const shown = filter ? candidates.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase())) : candidates;
  return (
    <div style="max-width:760px;margin:0 auto">
      <h1>Choose repositories</h1>
      <p class="muted">
        {candidates.length} repositories in <b>{row.source}</b>. Tick the ones to import.
      </p>
      <Form action={`/imports/${row.id}/select`} t={t} class="box">
        <div class="body">
          <div class="row" style="gap:8px">
            <input type="text" name="filter" value={filter} placeholder="Filter by name…" autocomplete="off" class="grow" />
            <button class="btn" name="do" value="filter">
              Filter
            </button>
            <button class="btn" name="do" value="all">
              Select all{filter ? " shown" : ""}
            </button>
            <button class="btn" name="do" value="none">
              Clear
            </button>
          </div>
          <div class="kstack mt" style="margin-top:10px;max-height:420px;overflow:auto">
            {shown.length ? (
              shown.map((cand) => (
                <KCheckbox
                  name="repositories"
                  value={cand.name}
                  checked={selected.has(cand.name)}
                  label={
                    <span>
                      <b>{cand.name}</b> {cand.private ? <span class="badge">private</span> : null} {cand.fork ? <span class="badge">fork</span> : null} {cand.archived ? <span class="badge amber">archived</span> : null}
                      {cand.description ? <span class="muted small"> — {cand.description}</span> : null}
                    </span>
                  }
                />
              ))
            ) : (
              <p class="muted small">No repositories match "{filter}".</p>
            )}
          </div>
          {/* Keep selections that are filtered out of view. */}
          {filter ? candidates.filter((c) => selected.has(c.name) && !shown.includes(c)).map((c) => <input type="hidden" name="repositories" value={c.name} />) : null}
          <p class="muted small">{selected.size} selected.</p>
          <button class="btn primary" name="do" value="start">
            Import {selected.size || ""} {selected.size === 1 ? "repository" : "repositories"}
          </button>
        </div>
      </Form>
    </div>
  );
};

const Steps: FC<{ row: ImportRow }> = ({ row }) => {
  const state = JSON.parse(row.steps || "{}") as Record<string, StepState>;
  const list = (row.kind === "bulk"
    ? [["organization", "Organization variables and secret names"], ["repositories", "Repositories"], ["finalize", "Finish"]]
    : [["repository", "Create the repository"], ["git", "Copy branches, tags and history"], ["labels", "Labels and milestones"], ["issues", "Issues and pull requests"], ["comments", "Comments"], ["reviews", "Reviews"], ["review_comments", "Review comments"], ["protection", "Branch protection"], ["variables", "Variables and secret names"], ["releases", "Releases"], ["finalize", "Finish"]]) as Array<[string, string]>;
  return (
    <ul class="list">
      {list.map(([name, title]) => {
        const s = state[name] ?? { status: "pending" };
        const st = s.status === "done" ? { conclusion: "success" } : s.status === "failed" ? { conclusion: "failure" } : s.status === "skipped" ? { conclusion: "skipped" } : s.status === "running" ? { status: "in_progress" } : { status: "queued" };
        return (
          <li>
            <Status {...st} />
            <div class="grow">
              <b>{title}</b>
              {s.message ? <div class="meta">{s.message}</div> : null}
            </div>
            {typeof s.count === "number" && s.count > 0 ? <span class="muted small">{s.count}</span> : null}
          </li>
        );
      })}
    </ul>
  );
};

const Summary: FC<{ row: ImportRow; secretsHref?: string }> = ({ row, secretsHref }) => {
  const s = JSON.parse(row.summary || "{}") as ImportSummary;
  const warnings = JSON.parse(row.warnings || "[]") as string[];
  return (
    <>
      {s.counts ? (
        <div class="box mt">
          <div class="body">
            <h3 class="m0">Imported</h3>
            <p class="muted small">
              {s.counts.issues} issues, {s.counts.pulls} pull requests, {s.counts.comments} comments, {s.counts.reviews} reviews, {s.counts.labels} labels, {s.counts.milestones} milestones.
              {s.git ? ` ${s.git.branches} branches, ${s.git.tags} tags, ${s.git.pullRefs} pull request heads${s.git.lfsObjects ? `, ${s.git.lfsObjects} LFS objects (${fmtBytes(s.git.lfsBytes)})` : ""}.` : ""}
            </p>
            {s.pullRefs?.missing?.length ? <p class="muted small">{s.pullRefs.missing.length} pull requests had no head commit on GitHub (deleted forks).</p> : null}
          </div>
        </div>
      ) : null}
      {s.children ? (
        <div class="box mt">
          <div class="body">
            <h3 class="m0">Repositories</h3>
            <p class="muted small">
              {s.children.succeeded} of {s.children.total} imported{s.children.failed ? `, ${s.children.failed} failed` : ""}{s.children.cancelled ? `, ${s.children.cancelled} cancelled` : ""}.
            </p>
          </div>
        </div>
      ) : null}
      {s.secretNames?.length || s.orgSecretNames?.length ? (
        <div class="box mt">
          <div class="body">
            <h3 class="m0">Secret names</h3>
            <p class="muted small">GitHub never returns secret values, so only the names came across. An admin sets the values.</p>
            {s.secretNames?.length ? <p class="small m0">Repository: {s.secretNames.map((n) => <code style="margin-right:6px">{n}</code>)}</p> : null}
            {s.orgSecretNames?.length ? <p class="small">Organization: {s.orgSecretNames.map((n) => <code style="margin-right:6px">{n}</code>)}</p> : null}
            {secretsHref ? <a class="btn sm" href={secretsHref}>Set secret values</a> : null}
          </div>
        </div>
      ) : null}
      {s.findings?.length ? (
        <div class="box mt" style="border-color:var(--amber)">
          <div class="body">
            <h3 class="m0">Possible secrets in history (rotate these)</h3>
            <p class="muted small">Push protection found these in old commits; they were imported with an audited bypass because the history is already public on GitHub.</p>
            <ul class="small">
              {s.findings.slice(0, 50).map((f) => (
                <li>
                  {f.kind} {f.path ? <span class="muted">in {f.path}</span> : null} <code>{f.blob.slice(0, 10)}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {warnings.length ? (
        <div class="box mt">
          <div class="body">
            <h3 class="m0">Warnings</h3>
            <ul class="small">
              {warnings.map((w) => (
                <li>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
};

async function loadRow(c: AppContext, svc: ImportService, me: Account): Promise<ImportRow> {
  const row = await svc.row(prm(c, "id"));
  if (!row || !(await svc.visibleTo(row, me))) throw new HttpError(404, "import not found");
  return row;
}

export function registerImports(web: WebApp): void {
  // ---------------------------------------------------------------- start

  web.get("/new/import", async (c) => {
    const me = requireAccount(c);
    const owners = [me.login, ...(await c.get("dir").orgsFor(me.id)).filter((o) => o.role !== "member").map((o) => o.login)];
    const values = { owner: c.req.query("owner") ?? me.login, mode: c.req.query("mode") === "owner" ? "owner" : "repo", source: c.req.query("source") ?? "" };
    return render(c, { title: "Import from GitHub" }, <StartForm t={csrfToken(c)} owners={owners} values={values} />);
  });

  post(web, "/new/import", async (c, f) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const mode = f.s("mode") === "owner" ? "owner" : "repo";
    const options = Object.fromEntries(OPTIONS.map(([k]) => [k, f.b(`opt_${k}`)])) as Record<string, boolean>;
    const source = f.s("source").trim();
    const body = {
      ...(mode === "owner" ? { source_owner: source } : { source }),
      owner: f.s("owner"),
      name: f.s("name").trim() || undefined,
      visibility: f.s("visibility") || "keep",
      github_token: f.s("github_token").trim() || undefined,
      github_api_url: f.s("github_api_url").trim() || undefined,
      concurrency: Number(f.s("concurrency")) || 3,
      options: { issues: options.issues, labels: options.labels, branch_protection: options.protection, variables: options.variables, releases: options.releases, lfs: options.lfs, secrets: f.s("secrets") === "stop" ? "stop" : "bypass" },
    };
    try {
      const scopes = (c.get("principal") as { scopes?: Array<"read" | "write" | "admin"> }).scopes ?? ["admin"];
      const row = await svc.create(me, scopes, body, { draft: mode === "owner" });
      return c.redirect(row.status === "draft" ? `/imports/${row.id}/select` : `/imports/${row.id}`, 303);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      const owners = [me.login, ...(await c.get("dir").orgsFor(me.id)).filter((o) => o.role !== "member").map((o) => o.login)];
      const values = { ...body, source, mode, ...Object.fromEntries(OPTIONS.map(([k]) => [`opt_${k}`, options[k] ? "1" : "0"])), secrets: body.options.secrets } as unknown as Record<string, string>;
      return render(c, { title: "Import from GitHub", status: e.status }, <StartForm t={csrfToken(c)} owners={owners} values={values} error={e.detail} />);
    }
  });

  // ---------------------------------------------------------------- bulk: choose repositories

  web.get("/imports/:id/select", async (c) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const row = await loadRow(c, svc, me);
    if (row.kind !== "bulk" || row.status !== "draft") return c.redirect(`/imports/${row.id}`, 302);
    const req = JSON.parse(row.request || "{}") as StoredRequest;
    const candidates = req.candidates ?? [];
    return render(c, { title: "Choose repositories" }, <SelectForm t={csrfToken(c)} row={row} candidates={candidates} filter="" selected={new Set(candidates.filter((c) => !c.fork && !c.archived).map((c) => c.name))} />);
  });

  post(web, "/imports/:id/select", async (c, f) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const row = await loadRow(c, svc, me);
    if (row.kind !== "bulk" || row.status !== "draft") return c.redirect(`/imports/${row.id}`, 303);
    const candidates = (JSON.parse(row.request || "{}") as StoredRequest).candidates ?? [];
    const selected = new Set(f.all("repositories"));
    const action = f.s("do");
    if (action === "start") {
      try {
        await svc.select(row.id, me, [...selected]);
        return c.redirect(`/imports/${row.id}`, 303);
      } catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        flash(c, "error", e.detail);
      }
    }
    const filter = f.s("filter").trim();
    if (action === "all") for (const cand of candidates) if (!filter || cand.name.toLowerCase().includes(filter.toLowerCase())) selected.add(cand.name);
    if (action === "none") selected.clear();
    return render(c, { title: "Choose repositories" }, <SelectForm t={csrfToken(c)} row={row} candidates={candidates} filter={filter} selected={selected} />);
  });

  // ---------------------------------------------------------------- list and detail

  web.get("/imports", async (c) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const rows = await svc.list(me.id);
    return render(
      c,
      { title: "Imports" },
      <div style="max-width:860px;margin:0 auto">
        <div class="row between mb">
          <h1 class="m0">Imports</h1>
          <a class="btn primary sm" href="/new/import">
            Import from GitHub
          </a>
        </div>
        {rows.length ? (
          <ul class="list box">
            {rows.map((r) => (
              <li>
                <div class="grow">
                  <a class="title" href={`/imports/${r.id}`}>
                    {r.source}
                  </a>{" "}
                  {statusBadge(r.status)} <span class="muted small">{r.kind === "bulk" ? "organization/user" : "repository"}</span>
                  <div class="meta">Started <Time at={r.created_at} /></div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">No imports yet. <a href="/new/import">Import a repository from GitHub</a>.</div>
        )}
      </div>,
    );
  });

  web.get("/imports/:id", async (c) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const row = await loadRow(c, svc, me);
    if (row.status === "draft" && row.kind === "bulk") return c.redirect(`/imports/${row.id}/select`, 302);
    const s = JSON.parse(row.summary || "{}") as ImportSummary;
    const children = row.kind === "bulk" ? await svc.children(row.id) : [];
    const owner = (await c.get("dir").account(row.target_owner_id))?.login ?? "";
    const target = row.repo_id ? `${owner}/${row.target_name}` : null;
    const running = row.status === "running" || row.status === "queued";
    const canSecrets = !!row.repo_id && (s.secretNames?.length || s.orgSecretNames?.length);
    const t = csrfToken(c);
    return render(
      c,
      { title: `Import of ${row.source}`, refresh: running ? 4 : undefined },
      <div style="max-width:860px;margin:0 auto">
        <div class="row between mb">
          <h1 class="m0" style="word-break:break-all">
            {row.source}
          </h1>
          {statusBadge(row.status)}
        </div>
        <p class="muted">
          {row.kind === "bulk" ? "Organization or user import" : "Repository import"} into <b>{owner}</b>
          {target ? <> → <a href={`/${target}`}>{target}</a></> : null}. Started <Time at={row.created_at} />.
          {row.source.includes("/") ? <> From <a href={`https://${webHostOf(row.api_url)}/${row.source}`} rel="noreferrer noopener">GitHub</a>.</> : null}
        </p>
        {row.error ? <div class="flash error">{row.error}</div> : null}
        {running ? <p class="muted small">This page refreshes automatically.</p> : null}
        <div class="box">
          <div class="body">
            <Steps row={row} />
          </div>
        </div>
        {children.length ? (
          <div class="box mt">
            <div class="body">
              <h3 class="m0">Repositories</h3>
              <ul class="list">
                {children.map((ch) => (
                  <li>
                    <div class="grow">
                      <a class="title" href={`/imports/${ch.id}`}>
                        {ch.source}
                      </a>{" "}
                      {statusBadge(ch.status)}
                      {ch.error ? <div class="meta">{ch.error}</div> : null}
                    </div>
                    {ch.repo_id ? <a class="btn sm" href={`/${owner}/${ch.target_name}`}>Open</a> : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        <Summary row={row} secretsHref={canSecrets ? `/imports/${row.id}/secrets` : undefined} />
        <div class="row mt" style="gap:8px">
          {running ? (
            <Form action={`/imports/${row.id}/cancel`} t={t} confirm="Cancel this import?">
              <button class="btn">Cancel import</button>
            </Form>
          ) : null}
          {(row.status === "failed" || row.status === "cancelled") && !row.parent_id ? (
            <Form action={`/imports/${row.id}/retry`} t={t} class="box">
              <div class="body">
                <h3 class="m0">Retry this import</h3>
                <p class="muted small m0">The GitHub token from the first run was discarded. For a private source (or LFS, variables or protection), give a token again; leave it blank for a public repository.</p>
                <div class="field">
                  <label for="retry_token">GitHub token <span class="faint">(optional)</span></label>
                  <input id="retry_token" name="github_token" type="password" autocomplete="off" placeholder="ghp_… or a fine-grained token" />
                </div>
                <button class="btn primary">Retry</button>
              </div>
            </Form>
          ) : null}
        </div>
      </div>,
    );
  });

  post(web, "/imports/:id/cancel", async (c) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const row = await loadRow(c, svc, me);
    return act(c, `/imports/${row.id}`, () => svc.cancel(row.id, me).then(() => undefined), "Import cancelled.");
  });

  post(web, "/imports/:id/retry", async (c, f) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const row = await loadRow(c, svc, me);
    const token = f.s("github_token").trim() || null;
    return act(c, `/imports/${row.id}`, () => svc.retry(row.id, me, token).then(() => undefined), "Import restarted.");
  });

  // ---------------------------------------------------------------- set secret values afterwards

  web.get("/imports/:id/secrets", async (c) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const row = await loadRow(c, svc, me);
    if (!row.repo_id) throw new HttpError(404, "no repository yet");
    const repo = (await c.get("dir").repoById(row.repo_id))!;
    const { caller } = await loadRepo(c, repo.owner_login, repo.name, "admin");
    if (caller.kind === "agent") throw new HttpError(403, "agents cannot set secrets");
    const names = (JSON.parse(row.summary || "{}") as ImportSummary).secretNames ?? [];
    const existing = new Set((await loadRepo(c, repo.owner_login, repo.name, "admin").then((l) => l.stub.secretNames())).map((s) => s.name));
    return render(
      c,
      { title: "Set secret values" },
      <div style="max-width:720px;margin:0 auto">
        <h1>Secret values</h1>
        <p class="muted">
          GitHub never reveals secret values, so only the names were imported for <a href={repoUrl(repo)}>{repo.owner_login}/{repo.name}</a>. Set the values here; they are encrypted at rest and never shown again.
        </p>
        {names.length ? (
          names.map((name) => (
            <Form action={`/${repo.owner_login}/${repo.name}/settings/secrets`} t={csrfToken(c)} class="box mb">
              <div class="body row" style="align-items:flex-end;gap:10px">
                <div class="field grow">
                  <label>
                    {name} {existing.has(name) ? <span class="badge green">set</span> : <span class="badge amber">empty</span>}
                  </label>
                  <input type="hidden" name="name" value={name} />
                  <input name="value" type="password" autocomplete="off" placeholder="Value" required />
                </div>
                <button class="btn primary">Save</button>
              </div>
            </Form>
          ))
        ) : (
          <div class="empty">No secret names were imported.</div>
        )}
        <p class="muted small">
          You can manage all secrets under the repository's <a href={`/${repo.owner_login}/${repo.name}/settings/secrets`}>settings</a>.
        </p>
      </div>,
    );
  });

  // ---------------------------------------------------------------- linked GitHub accounts

  const renderLinked = async (c: AppContext, challenge: { nonce: string; host: string; apiUrl: string } | null) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const links = await svc.links(me.id);
    const t = csrfToken(c);
    return render(
      c,
      { title: "Linked accounts" },
      <div class="grid left">
        <SettingsNav me={me} tab="linked" db={c.env.DB} />
        <div style="max-width:640px">
          <h1>Linked GitHub accounts</h1>
          <p class="muted">When you import from GitHub, work by a linked GitHub account is attributed to your Diffinery account. Prove you control the account by putting a one-time code in a public gist; no token is needed.</p>
          {links.length ? (
            <ul class="list box mb">
              {links.map((l) => (
                <li>
                  <div class="grow">
                    <b>{l.login}</b> <span class="muted small">on {l.host}</span>
                    <div class="meta">Linked <Time at={l.createdAt} /></div>
                  </div>
                  <Form action="/settings/linked-accounts/delete" t={t} confirm={`Unlink ${l.login}?`}>
                    <input type="hidden" name="id" value={l.id} />
                    <button class="btn sm">Unlink</button>
                  </Form>
                </li>
              ))}
            </ul>
          ) : null}
          {svc.oauthEnabled ? (
            <Form action="/settings/linked-accounts/github/oauth" t={t} class="box mb">
              <div class="body">
                <h3 class="m0">Link with GitHub</h3>
                <p class="muted small">Sign in to GitHub and authorise read-only access to your profile.</p>
                <button class="btn primary">Continue to GitHub</button>
              </div>
            </Form>
          ) : null}
          {challenge ? (
            <div class="box mb">
              <div class="body">
                <h3 class="m0">Step 2 · verify your gist</h3>
                <p class="muted small">Create a <b>public</b> gist on {challenge.host} whose description or a file contains this code, then enter your GitHub username and verify:</p>
                <pre class="code" style="user-select:all">{challenge.nonce}</pre>
                <Form action="/settings/linked-accounts/github" t={t}>
                  <input type="hidden" name="api_url" value={challenge.apiUrl} />
                  <div class="field">
                    <label for="llogin">Your GitHub username on {challenge.host}</label>
                    <input id="llogin" name="login" type="text" autocomplete="off" placeholder="diffy" required />
                  </div>
                  <button class="btn primary">Verify and link</button>
                </Form>
              </div>
            </div>
          ) : null}
          <Form action="/settings/linked-accounts/github/challenge" t={t} class="box">
            <div class="body">
              <h3 class="m0">Step 1 · get a code</h3>
              <div class="field">
                <label for="lapi">
                  GitHub Enterprise API URL <span class="faint">(leave blank for github.com)</span>
                </label>
                <input id="lapi" name="api_url" type="text" autocomplete="off" placeholder="https://ghe.example.com/api/v3" value={challenge?.apiUrl ?? ""} />
              </div>
              <button class="btn">Get my code</button>
            </div>
          </Form>
        </div>
      </div>,
    );
  };

  web.get("/settings/linked-accounts", async (c) => renderLinked(c, null));

  post(web, "/settings/linked-accounts/github/challenge", async (c, f) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    const ch = await svc.linkChallenge(me, f.s("api_url").trim() || null);
    return renderLinked(c, { nonce: ch.nonce, host: ch.host, apiUrl: f.s("api_url").trim() });
  });

  post(web, "/settings/linked-accounts/github", async (c, f) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    return act(c, "/settings/linked-accounts", async () => {
      await svc.linkByGist(me, f.s("login").trim(), f.s("api_url").trim() || null);
    }, "GitHub account linked.");
  });

  post(web, "/settings/linked-accounts/github/oauth", async (c) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    return c.redirect(await svc.oauthStart(me));
  });

  web.get("/settings/linked/github/callback", async (c) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    return act(c, "/settings/linked-accounts", async () => {
      await svc.oauthCallback(me, c.req.query("code") ?? "", c.req.query("state") ?? "");
    }, "GitHub account linked.");
  });

  post(web, "/settings/linked-accounts/delete", async (c, f) => {
    const me = requireAccount(c);
    const svc = new ImportService(c.env);
    return act(c, "/settings/linked-accounts", () => svc.unlink(me, f.s("id")), "Account unlinked.");
  });
}
