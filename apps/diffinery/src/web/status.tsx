/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import {
  COMPONENTS,
  IMPACTS,
  INCIDENT_STATES,
  MAX_BODY,
  MAX_TITLE,
  RECENT_DAYS,
  StatusIncidents,
  openIncident,
  postUpdate,
  statusSummary,
  validateIncident,
  validateUpdate,
  type ComponentStatus,
  type Impact,
  type Incident,
  type IncidentState,
  type Indicator,
} from "../lib/status.js";
import { HttpError } from "../lib/util.js";
import { SettingsNav } from "./account.js";
import { csrfToken } from "./csrf.js";
import { ComputePausedBanner } from "./kill-switches.js";
import { KCheckbox, KSelect } from "./kumo.js";
import { Form, Time, act, post, prm, render, type WebApp } from "./ui.js";

/**
 * The status page in the web UI (lib/status.ts): the public page at /status, which anyone can open
 * without signing in, and the **Status** page of site administration, where incidents are opened,
 * updated and resolved.
 */

const STATUS_TEXT: Record<ComponentStatus, string> = {
  operational: "Operational",
  under_maintenance: "Under maintenance",
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
};
const STATUS_BADGE: Record<ComponentStatus, string> = { operational: "badge green", under_maintenance: "badge blue", degraded_performance: "badge amber", partial_outage: "badge red", major_outage: "badge red" };
const BANNER: Record<Indicator, string> = { none: "flash notice", maintenance: "flash info", minor: "flash warn", major: "flash error", critical: "flash error" };
const IMPACT_TEXT: Record<Impact, string> = { minor: "Minor", major: "Major", critical: "Critical", maintenance: "Maintenance" };
const IMPACT_BADGE: Record<Impact, string> = { minor: "badge amber", major: "badge red", critical: "badge red", maintenance: "badge blue" };
const STATE_TEXT: Record<IncidentState, string> = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
const NAMES = new Map<string, string>(COMPONENTS.map((c) => [c.id, c.name]));

/** An incident with its updates, newest first. Site administrators also see who wrote each one. */
const IncidentBox: FC<{ i: Incident; admin?: boolean; children?: Child }> = ({ i, admin, children }) => (
  <div class="box mb" id={`incident-${i.id}`} data-incident={i.id}>
    <div class="body">
      <h3 class="m0">
        {i.title} <span class={IMPACT_BADGE[i.impact]}>{IMPACT_TEXT[i.impact]}</span>
      </h3>
      <div class="muted small">
        Affects {i.components.map((c) => NAMES.get(c) ?? c).join(", ")}. {i.resolved_at ? <>Resolved </> : <>Opened </>}
        <Time at={i.resolved_at ?? i.created_at} />.
      </div>
    </div>
    <ul class="list">
      {i.updates.map((u) => (
        <li>
          <div class="grow">
            <b>{STATE_TEXT[u.state]}</b>{" "}
            <span class="muted small">
              <Time at={u.created_at} />
              {admin && u.author_login ? <> by {u.author_login}</> : null}
            </span>
            {/* Plain text exactly as written: never rendered as Markdown or HTML. */}
            <div style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px">{u.body}</div>
          </div>
        </li>
      ))}
    </ul>
    {children}
  </div>
);

export function registerStatus(web: WebApp): void {
  // ------------------------------------------------------------ the public page

  web.get("/status", async (c) => {
    const s = await statusSummary(c.env);
    return render(
      c,
      { title: "Status", description: "Whether this Diffinery instance is working: each component's status, incidents in progress and recent ones." },
      <div style="max-width:820px;margin:32px auto">
        <h1>Status</h1>
        <div class={BANNER[s.status.indicator]} role="status" data-indicator={s.status.indicator}>
          <b>{s.status.description}</b>
        </div>
        {s.incidents.length ? (
          <>
            <h2>Active incidents</h2>
            {s.incidents.map((i) => (
              <IncidentBox i={i} />
            ))}
          </>
        ) : null}
        <h2>Components</h2>
        <div class="box mb">
          <ul class="list">
            {s.components.map((comp) => (
              <li data-component={comp.id} data-status={comp.status}>
                <div class="grow">
                  <b>{comp.name}</b>
                  {comp.note ? <div class="meta">{comp.note}</div> : null}
                </div>
                <span class={STATUS_BADGE[comp.status]}>{STATUS_TEXT[comp.status]}</span>
              </li>
            ))}
          </ul>
        </div>
        <h2>Past incidents</h2>
        {s.resolved.length ? (
          s.resolved.map((i) => <IncidentBox i={i} />)
        ) : (
          <div class="box mb">
            <div class="empty">No incidents in the last {RECENT_DAYS} days.</div>
          </div>
        )}
        <p class="muted small">
          Updated <Time at={s.updated_at} />. Also as JSON at <a href="/api/v3/diffinery/status">/api/v3/diffinery/status</a>. This page is served by this instance itself, so it can't load when the whole instance is down.
        </p>
      </div>,
    );
  });

  // ------------------------------------------------------------ site administration: Status

  /** Incidents are managed by site administrators only: 404, not 403, for anyone else. */
  const requireSiteAdmin = (c: AppContext): Account => {
    const me = requireAccount(c);
    if (!me.site_admin) throw new HttpError(404, "not found");
    return me;
  };

  const BASE = "/settings/admin/status";
  const stateOptions = (states: readonly IncidentState[]) => states.map((s) => ({ value: s, label: STATE_TEXT[s] }));

  web.get(BASE, async (c) => {
    const me = requireSiteAdmin(c);
    const t = csrfToken(c);
    const [s, all] = await Promise.all([statusSummary(c.env), new StatusIncidents(c.env.DB).list({ limit: 50 })]);
    return render(
      c,
      { title: "Status" },
      <div class="grid left">
        <SettingsNav me={me} tab="status" db={c.env.DB} />
        <div>
          <ComputePausedBanner env={c.env} />
          <h1>Status</h1>
          <p class="muted">
            Incidents on the public <a href="/status">status page</a>. While an incident isn't resolved, its impact sets the status of each component it affects. Pausing hosted compute under <a href="/settings/admin/kill-switches">Kill switches</a> puts Actions and agent sandboxes under maintenance there without an incident. Changes are in the <a href="/settings/audit">audit log</a>.
          </p>
          <div class={BANNER[s.status.indicator]} role="status">
            The status page says: <b>{s.status.description}</b>.
          </div>

          <h2>Open an incident</h2>
          <Form action={BASE} t={t} class="box mb">
            <div class="body">
              <div class="field">
                <label for="si-title">Title</label>
                <input id="si-title" name="title" type="text" required maxlength={MAX_TITLE} placeholder="e.g. Pushes are slow or failing" autocomplete="off" />
              </div>
              <div class="field">
                <label>Impact</label>
                <KSelect
                  name="impact"
                  label="Impact"
                  value="minor"
                  options={IMPACTS.map((i) => ({ value: i, label: { minor: "Minor: degraded performance", major: "Major: partial outage", critical: "Critical: major outage", maintenance: "Maintenance: under maintenance" }[i] }))}
                />
              </div>
              <div class="field">
                <label>Affected components</label>
                <div class="row" style="flex-wrap:wrap;gap:6px 16px">
                  {COMPONENTS.map((comp) => (
                    <KCheckbox name="components" value={comp.id} label={comp.name} />
                  ))}
                </div>
              </div>
              <div class="field">
                <label>State</label>
                <KSelect name="state" label="State" value="investigating" options={stateOptions(INCIDENT_STATES.filter((s) => s !== "resolved"))} />
              </div>
              <div class="field">
                <label for="si-body">First update</label>
                <textarea id="si-body" name="body" required maxlength={MAX_BODY} style="min-height:90px" placeholder="e.g. We are investigating reports of failed pushes."></textarea>
                <div class="hint">Plain text, shown to everyone on the status page.</div>
              </div>
              <button class="btn primary">Open the incident</button>
            </div>
          </Form>

          <h2>Open incidents</h2>
          {s.incidents.length ? (
            s.incidents.map((i) => (
              <IncidentBox i={i} admin>
                <Form action={`${BASE}/${i.id}`} t={t} class="body" style="border-top:1px solid var(--border2)">
                  <div class="field">
                    <label>State</label>
                    <KSelect name="state" label="State" value={i.state} options={stateOptions(INCIDENT_STATES)} />
                  </div>
                  <div class="field">
                    <label for={`si-body-${i.id}`}>Update</label>
                    <textarea id={`si-body-${i.id}`} name="body" required maxlength={MAX_BODY} style="min-height:70px" placeholder="e.g. We found the cause and are rolling out a fix."></textarea>
                    <div class="hint">Choose Resolved to close the incident: it then moves to past incidents.</div>
                  </div>
                  <button class="btn primary">Post the update</button>
                </Form>
              </IncidentBox>
            ))
          ) : (
            <div class="box mb">
              <div class="empty">No open incidents.</div>
            </div>
          )}

          <h2>Recent incidents</h2>
          <div class="box" style="overflow:auto">
            {all.length ? (
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Opened</th>
                    <th>Title</th>
                    <th>Impact</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((i) => (
                    <tr>
                      <td class="small nowrap">
                        <Time at={i.created_at} />
                      </td>
                      <td>
                        {i.title}
                        <div class="muted small">{i.created_by ? <>by {i.created_by}</> : null}</div>
                      </td>
                      <td>
                        <span class={IMPACT_BADGE[i.impact]}>{IMPACT_TEXT[i.impact]}</span>
                      </td>
                      <td>{STATE_TEXT[i.state]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="empty">No incidents yet.</div>
            )}
          </div>
        </div>
      </div>,
    );
  });

  post(web, BASE, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(
      c,
      BASE,
      async () => {
        const input = validateIncident({ title: f.s("title"), impact: f.s("impact"), components: f.all("components"), state: f.s("state"), body: f.s("body") });
        await openIncident(c.env.DB, (e) => c.get("dir").audit(e), me, input, "web");
      },
      "Incident opened. It is on the status page now.",
    );
  });

  post(web, `${BASE}/:id`, async (c, f) => {
    const me = requireSiteAdmin(c);
    const id = prm(c, "id");
    return act(
      c,
      BASE,
      async () => {
        const input = validateUpdate({ state: f.s("state"), body: f.s("body") });
        await postUpdate(c.env.DB, (e) => c.get("dir").audit(e), me, id, input, "web");
      },
      f.s("state") === "resolved" ? "Incident resolved. It is under past incidents now." : "Update posted.",
    );
  });
}
