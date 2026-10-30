/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { GitHubRunnerLinks, SETUP_PATH, type LinkedInstallation } from "../github-runners/links.js";
import type { RunnerJobRow } from "../github-runners/service.js";
import { computeUsage, quotasFor } from "../lib/quotas.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { SettingsNav } from "./account.js";
import { csrfToken } from "./csrf.js";
import { KSelect } from "./kumo.js";
import { Form, Time, act, flash, post, render, type WebApp } from "./ui.js";

/**
 * Settings → GitHub runners: link a GitHub App installation to the Diffinery account that pays, and see the
 * runners its jobs got (github-runners/). Linking and unlinking need a person signed in with a passkey:
 * no token or agent can make an account pay for GitHub jobs.
 */

const links = (c: AppContext) => new GitHubRunnerLinks(c.env, c.get("dir"));

/** A person (not an agent, token or app) signed in with a passkey in a browser. */
function person(c: AppContext, what: string): Account {
  const p = c.get("principal");
  if (p.type === "anonymous") throw new HttpError(401, "sign in required");
  if (p.type === "account" && (p.via === "session" || p.via === "dev")) {
    const a = requireAccount(c);
    if (a.kind === "user") return a;
  }
  throw new HttpError(403, `only a person signed in with a passkey in a browser can ${what}`);
}

const page = (c: AppContext, me: Account, title: string, body: unknown) =>
  render(
    c,
    { title },
    <div class="grid left">
      <SettingsNav me={me} tab="github-runners" db={c.env.DB} />
      <div style="max-width:880px">{body}</div>
    </div>,
  );

const STATUS: Record<RunnerJobRow["status"], [string, string]> = {
  queued: ["waiting", "badge amber"],
  starting: ["starting", "badge blue"],
  running: ["running", "badge blue"],
  completed: ["done", "badge green"],
  skipped: ["skipped", "badge"],
  failed: ["failed", "badge red"],
};

function duration(from: string | null, to: string | null): string {
  if (!from || !to) return "";
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const Jobs: FC<{ jobs: RunnerJobRow[] }> = ({ jobs }) =>
  jobs.length ? (
    <table class="tbl">
      <thead>
        <tr>
          <th>Job</th>
          <th>Runner</th>
          <th>Status</th>
          <th>Queued</th>
          <th>Ran for</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const [label, cls] = STATUS[j.status] ?? [j.status, "badge"];
          return (
            <tr>
              <td>
                <div>{j.html_url ? <a href={j.html_url}>{j.ran_job_name ?? j.job_name ?? `job ${j.github_job_id}`}</a> : (j.ran_job_name ?? j.job_name ?? `job ${j.github_job_id}`)}</div>
                <div class="meta">
                  {j.repo}
                  {j.workflow_name ? ` · ${j.workflow_name}` : ""}
                </div>
                {j.message ? <div class="meta">{j.message}</div> : null}
              </td>
              <td class="small">{j.size}</td>
              <td>
                <span class={cls}>{label}</span>
                {j.conclusion ? <div class="meta">{j.conclusion}</div> : null}
              </td>
              <td class="small nowrap">
                <Time at={j.created_at} />
              </td>
              <td class="small nowrap">{duration(j.started_at, j.ended_at)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  ) : (
    <div class="empty">No jobs yet. Set a job's runs-on to diffinery and push.</div>
  );

const Installation: FC<{ inst: LinkedInstallation; webUrl: string; t: string }> = ({ inst, webUrl, t }) => {
  const configure = inst.github_type === "Organization" ? `${webUrl}/organizations/${encodeURIComponent(inst.github_login)}/settings/installations/${inst.id}` : `${webUrl}/settings/installations/${inst.id}`;
  return (
    <li>
      <div class="grow">
        <a href={`${webUrl}/${encodeURIComponent(inst.github_login)}`}>
          <b>{inst.github_login}</b>
        </a>{" "}
        <span class="badge">{inst.github_type === "Organization" ? "organization" : "user"}</span> {inst.suspended_at ? <span class="badge amber">suspended on GitHub</span> : null}
        <div class="meta">
          Linked <Time at={inst.linked_at} /> · <a href={configure}>Choose repositories on GitHub</a>
        </div>
      </div>
      <Form action="/settings/github-runners/unlink" t={t} confirm={`Unlink ${inst.github_login}? Its jobs that wait for a runner won't get one.`} class="inline">
        <input type="hidden" name="installation" value={String(inst.id)} />
        <button class="btn sm">Unlink</button>
      </Form>
    </li>
  );
};

async function overviewPage(c: AppContext) {
  const me = requireAccount(c);
  const l = links(c);
  const t = csrfToken(c);
  const overview = l.enabled ? await l.overview(me) : [];
  const payers = overview.map((o) => o.account);
  const minutes = await Promise.all(
    overview.map(async (o) => {
      const [q, u] = await Promise.all([quotasFor(c.env, o.account.id), computeUsage(c.env, o.account.id)]);
      return q.hosted_minutes < 0 ? `${u.hosted_minutes} hosted minutes this month` : `${u.hosted_minutes} of ${q.hosted_minutes} hosted minutes this month`;
    }),
  );
  return page(
    c,
    me,
    "GitHub runners",
    <>
      <h1>GitHub runners</h1>
      <p class="muted">
        Keep your code on GitHub and run its Actions jobs on this Diffinery's hosted runners. Install the app on a GitHub account or organization, link it to the Diffinery account whose hosted minutes pay for the jobs, and set a job's{" "}
        <code>runs-on</code> to <code>diffinery</code> (4 vCPU) or <code>diffinery-medium</code>, <code>diffinery-small</code>, <code>diffinery-tiny</code>. See <a href="/docs/actions/github-runners">GitHub runners</a>.
      </p>
      {!l.enabled ? (
        <div class="flash notice">This Diffinery has no GitHub App, so GitHub runners are off. A site administrator can set one up: see <a href="/docs/self-hosting/configuration#github-runners">Configuration</a>.</div>
      ) : (
        <>
          <Form action="/settings/github-runners/connect" t={t} class="box mb">
            <div class="head">
              <h2>Connect GitHub</h2>
            </div>
            <div class="body fbody">
              <div class="field">
                <label>Account that pays</label>
                <KSelect name="account" options={payers.map((p) => ({ value: p.id, label: p.kind === "org" ? `${p.login} (organization)` : `${p.login} (you)` }))} value={me.id} block />
              </div>
              <div class="factions">
                <button class="btn primary" name="mode" value="install">
                  Install on GitHub
                </button>
                <button class="btn" name="mode" value="existing">
                  Link an existing installation
                </button>
              </div>
            </div>
          </Form>
          <div class="box mb">
            <div class="head">
              <h2>In a workflow</h2>
            </div>
            <div class="body">
              <pre class="code">{"jobs:\n  test:\n    runs-on: diffinery   # or diffinery-medium, diffinery-small, diffinery-tiny\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n"}</pre>
            </div>
          </div>
          {overview.map((o, i) =>
            o.installations.length || o.jobs.length ? (
              <div class="box mb">
                <div class="head row between">
                  <h2>{o.account.login}</h2>
                  <span class="muted small">{minutes[i]}</span>
                </div>
                {o.installations.length ? (
                  <ul class="list">
                    {o.installations.map((inst) => (
                      <Installation inst={inst} webUrl={l.client!.app.webUrl} t={t} />
                    ))}
                  </ul>
                ) : (
                  <div class="empty">No installation is linked to {o.account.login}.</div>
                )}
                <Jobs jobs={o.jobs} />
              </div>
            ) : null,
          )}
        </>
      )}
    </>,
  );
}

export function registerGitHubRunners(web: WebApp): void {
  web.get("/settings/github-runners", overviewPage);

  post(web, "/settings/github-runners/connect", async (c, f) =>
    act(c, "/settings/github-runners", async () => {
      const me = person(c, "link GitHub runners");
      const l = links(c);
      return f.s("mode") === "existing" ? l.authorizeUrl(me, f.s("account") || me.id) : l.installUrl(me, f.s("account") || me.id);
    }),
  );

  // GitHub's setup URL and callback URL: after installing the app, or after authorizing it.
  web.get(SETUP_PATH, async (c) => {
    const installation = Number(c.req.query("installation_id"));
    let me: Account;
    let r;
    try {
      me = person(c, "link GitHub runners");
      r = await links(c).setup(me, { installationId: Number.isSafeInteger(installation) && installation > 0 ? installation : null, code: c.req.query("code") || null, state: c.req.query("state") || null });
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      flash(c, "error", e.message);
      return c.redirect("/settings/github-runners", 303);
    }
    if ("redirect" in r) return c.redirect(r.redirect, 302);
    if ("linked" in r) {
      flash(c, "notice", `Linked ${r.linked.github_login}. Its jobs with runs-on: diffinery now run here.`);
      return c.redirect("/settings/github-runners", 303);
    }
    const t = csrfToken(c);
    const payers = await links(c).payers(me);
    return page(
      c,
      me,
      "Link a GitHub installation",
      <>
        <h1>Link a GitHub installation</h1>
        <p class="muted">These are the installations of the app your GitHub account can manage. Pick one and the Diffinery account that pays for its jobs.</p>
        {r.choose.length ? (
          <ul class="list box">
            {r.choose.map((i) => (
              <li>
                <div class="grow">
                  <b>{i.login}</b> <span class="badge">{i.type === "Organization" ? "organization" : "user"}</span>
                  {i.linkedTo ? <div class="meta">Linked to {i.linkedTo}; linking it here moves it.</div> : null}
                </div>
                <Form action="/settings/github-runners/link" t={t} class="row" style="gap:8px">
                  <input type="hidden" name="proof" value={i.proof} />
                  <KSelect name="account" size="sm" options={payers.map((p) => ({ value: p.id, label: p.login }))} value={r.payer.id} />
                  <button class="btn sm primary">Link</button>
                </Form>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">
            Your GitHub account can't manage any installation of the app yet. <a href="/settings/github-runners">Install it first</a>.
          </div>
        )}
      </>,
    );
  });

  post(web, "/settings/github-runners/link", async (c, f) =>
    act(c, "/settings/github-runners", async () => {
      const me = person(c, "link GitHub runners");
      const linked = await links(c).linkWithProof(me, f.s("proof"), f.s("account") || me.id);
      flash(c, "notice", `Linked ${linked.github_login}. Its jobs with runs-on: diffinery now run here.`);
    }),
  );

  post(web, "/settings/github-runners/unlink", async (c, f) =>
    act(
      c,
      "/settings/github-runners",
      async () => {
        const me = person(c, "unlink GitHub runners");
        const id = Number(f.s("installation"));
        if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(422, "no installation given");
        await links(c).unlink(me, id);
      },
      "Unlinked. Runners already started finish their jobs.",
    ),
  );
}
