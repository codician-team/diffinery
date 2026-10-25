/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import type { Env } from "../env.js";
import { computePause, killSwitches, suspendedList, type KillSwitches, type Suspension } from "../lib/killswitch.js";
import { Form, Time } from "./ui.js";

/**
 * Kill switches in the web UI (lib/killswitch.ts): the banners people see while one is on, and
 * the **Kill switches** page of site administration (its routes are in account.tsx).
 */

const By: FC<{ s: Suspension }> = ({ s }) => (
  <>
    {s.by ? <> by {s.by}</> : null} <Time at={s.at} />
  </>
);

/** On the admin pages: hosted compute is paused, so nobody forgets it is. */
export const ComputePausedBanner: FC<{ env: Env }> = async ({ env }) => {
  const p = await computePause(env).catch(() => null);
  if (!p) return <></>;
  return (
    <div class="flash error" role="status" data-kill="paused">
      <b>Hosted compute is paused on this instance.</b> Hosted Actions jobs fail without starting and no agent sandbox can start; self-hosted runners still work. Paused
      <By s={p} />
      {p.reason ? <>: {p.reason}</> : null}. <a href="/settings/admin/kill-switches">Kill switches</a>
    </div>
  );
};

/** What ActionsBlockedBanner shows, for a page to start reading early. Never rejects. */
export const actionsSwitches = (env: Env, repoId: string): Promise<KillSwitches | null> => killSwitches(env, repoId).catch(() => null);

/** On a repository's Actions pages and settings: its Actions are suspended, or hosted compute is paused. */
export const ActionsBlockedBanner: FC<{ env: Env; repoId: string; switches?: Promise<KillSwitches | null> }> = async ({ env, repoId, switches }) => {
  // `switches`: read by the page alongside its own data (actionsSwitches), so the banner doesn't wait for it after them.
  const k = await (switches ?? actionsSwitches(env, repoId));
  if (!k) return <></>;
  const s = k.repo ?? k.account;
  if (s)
    return (
      <div class="flash error" role="status" data-kill="suspended">
        <b>Actions are suspended {k.repo ? "for this repository" : <>for every repository of {k.account!.login}</>} by a site administrator</b>
        {s.reason ? <>: {s.reason}</> : null}. No workflow runs start, queued jobs fail, and agent sandboxes can't start until a site administrator lifts the suspension. Suspended
        <By s={s} />.
      </div>
    );
  if (k.paused)
    return (
      <div class="flash error" role="status" data-kill="paused">
        <b>Hosted runners are paused on this instance by a site administrator</b>
        {k.paused.reason ? <>: {k.paused.reason}</> : null}. Jobs on hosted runners fail without starting and agent sandboxes can't start; jobs on self-hosted runners still run.
      </div>
    );
  return <></>;
};

/** The body of Settings → Kill switches. */
export const KillSwitchesPage: FC<{ env: Env; t: string }> = async ({ env, t }) => {
  const [paused, list] = await Promise.all([computePause(env), suspendedList(env)]);
  return (
    <>
      <h1>Kill switches</h1>
      <p class="muted">
        Stop Actions and agent sandboxes quickly: for one repository, for every repository of an account, or hosted compute on the whole instance. Turning one on stops what is running at once; turning it off only lets new work start. Nobody is exempt, site administrators included. Every change is in the{" "}
        <a href="/settings/audit">audit log</a>.
      </p>
      <div class="box">
        <div class="head">
          <h2>Hosted compute</h2>
          {paused ? <span class="badge red">paused</span> : <span class="badge green">running</span>}
        </div>
        <div class="body">
          {paused ? (
            <>
              <p class="m0">
                Paused
                <By s={paused} />
                {paused.reason ? <>: {paused.reason}</> : null}.
              </p>
              <Form action="/settings/admin/kill-switches/resume" t={t} class="mt">
                <button class="btn primary">Resume hosted compute</button>
              </Form>
            </>
          ) : (
            <Form action="/settings/admin/kill-switches/pause" t={t} confirm="Pause hosted compute on the whole instance? Running hosted jobs and open sandboxes stop now.">
              <div class="formrow">
                <div class="field grow">
                  <label for="pause-reason">Reason</label>
                  <input id="pause-reason" name="reason" required maxlength={500} placeholder="e.g. abuse investigation, cost overrun" />
                </div>
                <button class="btn danger">Pause hosted compute</button>
              </div>
              <div class="hint">Hosted Actions jobs fail without starting and no agent sandbox can start, in every repository. Self-hosted runners keep working.</div>
            </Form>
          )}
        </div>
      </div>
      <Form action="/settings/admin/kill-switches/accounts" t={t} class="box" confirm="Suspend Actions for every repository of this account? Its runs are cancelled and its sandboxes closed now.">
        <div class="head">
          <h2>Suspend Actions for an account</h2>
        </div>
        <div class="body">
          <div class="formrow">
            <div class="field">
              <label for="ks-login">Person or organization</label>
              <input id="ks-login" name="login" required placeholder="login" autocomplete="off" />
            </div>
            <div class="field grow">
              <label for="ks-areason">Reason</label>
              <input id="ks-areason" name="reason" required maxlength={500} />
            </div>
            <button class="btn danger">Suspend</button>
          </div>
          <div class="hint">Every repository the account owns: no workflow runs (hosted or self-hosted) and no agent sandboxes.</div>
        </div>
      </Form>
      <Form action="/settings/admin/kill-switches/repos" t={t} class="box" confirm="Suspend Actions for this repository? Its runs are cancelled and its sandboxes closed now.">
        <div class="head">
          <h2>Suspend Actions for a repository</h2>
        </div>
        <div class="body">
          <div class="formrow">
            <div class="field">
              <label for="ks-repo">Repository</label>
              <input id="ks-repo" name="repo" required placeholder="owner/name" autocomplete="off" />
            </div>
            <div class="field grow">
              <label for="ks-rreason">Reason</label>
              <input id="ks-rreason" name="reason" required maxlength={500} />
            </div>
            <button class="btn danger">Suspend</button>
          </div>
        </div>
      </Form>
      <div class="box">
        <div class="head">
          <h2>Suspended</h2>
          <span class="badge">{list.accounts.length + list.repos.length}</span>
        </div>
        {list.accounts.length + list.repos.length ? (
          <ul class="list">
            {list.accounts.map((a) => (
              <li>
                <div class="grow">
                  <b>{a.login}</b> <span class="badge">{a.kind === "org" ? "organization" : "person"}</span> <span class="muted small">every repository · suspended<By s={a} /></span>
                  {a.reason ? <div class="meta">{a.reason}</div> : null}
                </div>
                <Form action={`/settings/admin/kill-switches/accounts/${encodeURIComponent(a.login)}/lift`} t={t} class="inline">
                  <button class="btn sm">Lift</button>
                </Form>
              </li>
            ))}
            {list.repos.map((r) => (
              <li>
                <div class="grow">
                  <a href={`/${r.owner}/${r.name}/actions`}>
                    <b>
                      {r.owner}/{r.name}
                    </b>
                  </a>{" "}
                  <span class="badge">repository</span> <span class="muted small">suspended<By s={r} /></span>
                  {r.reason ? <div class="meta">{r.reason}</div> : null}
                </div>
                <Form action={`/settings/admin/kill-switches/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/lift`} t={t} class="inline">
                  <button class="btn sm">Lift</button>
                </Form>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">No account or repository has its Actions suspended.</div>
        )}
      </div>
    </>
  );
};
