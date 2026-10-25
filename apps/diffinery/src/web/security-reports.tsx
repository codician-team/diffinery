/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { turnstileMode, verifyTurnstile } from "../auth/signup.js";
import type { Account } from "../lib/directory.js";
import { MAX_AREA, MAX_DETAILS, MAX_NOTE, MAX_SUMMARY, REPORT_STATES, SecurityReports, changeReport, submitReport, validateReport, type ReportState, type SecurityReport } from "../lib/security-reports.js";
import { HttpError } from "../lib/util.js";
import { contactUris } from "../http/security-txt.js";
import { SettingsNav } from "./account.js";
import { csrfToken } from "./csrf.js";
import { ComputePausedBanner } from "./kill-switches.js";
import { KSelect } from "./kumo.js";
import { Form, Time, act, post, principalAccount, prm, render, statusOf, type WebApp } from "./ui.js";

/**
 * Private security reports in the web UI (lib/security-reports.ts): the report form at
 * /security/report, which security.txt names first, and the **Security reports** page of site
 * administration, the only place (with the API) where reports can be read.
 */

/** Largest report form, in bytes: the details' cap with room for percent-encoded UTF-8. */
const MAX_FORM_BYTES = 256 * 1024;

const STATE_TEXT: Record<ReportState, string> = { new: "New", triaged: "Triaged", resolved: "Resolved" };
const STATE_BADGE: Record<ReportState, string> = { new: "badge red", triaged: "badge amber", resolved: "badge green" };
export const StateBadge: FC<{ state: ReportState }> = ({ state }) => <span class={STATE_BADGE[state]}>{STATE_TEXT[state]}</span>;

/** Who reports as themselves: an active person signed in. Anyone else goes through Turnstile. */
const reporterOf = (c: AppContext): Account | null => {
  const a = principalAccount(c);
  return a && a.kind === "user" && a.status === "active" ? a : null;
};

const TURNSTILE_MISSING = "This instance has no Turnstile configured (TURNSTILE_SITE_KEY and TURNSTILE_SECRET), so it takes reports only from people who are signed in.";

interface FormValues {
  summary?: string;
  details?: string;
  area?: string;
  replyTo?: string;
}

function reportPage(c: AppContext, o: { values?: FormValues; error?: string; status?: number } = {}): Response | Promise<Response> {
  const me = reporterOf(c);
  const mode = turnstileMode(c.env);
  const siteKey = !me && mode === "verify" ? c.env.TURNSTILE_SITE_KEY : undefined;
  const closed = !me && mode === "missing";
  const others = contactUris(c.env.SECURITY_CONTACT);
  const v = o.values ?? {};
  return render(
    c,
    { title: "Report a security problem", status: o.status, turnstile: !!siteKey, description: "Report a security problem in this Diffinery instance privately to its site administrators." },
    <div style="max-width:720px;margin:32px auto">
      <h1>Report a security problem</h1>
      <p class="muted">
        Found a vulnerability in this Diffinery instance? Tell its site administrators privately here: only they can read what you send. Please read the <a href="/docs/security/disclosure">disclosure policy</a> first, for what is in scope and the safe harbour for good-faith research. Don't report it in a public issue.
      </p>
      {o.error ? (
        <div class="flash error" role="alert">
          {o.error}
        </div>
      ) : null}
      {closed ? (
        <div class="box">
          <div class="body">
            <p class="m0">
              {TURNSTILE_MISSING} <a href={`/login?next=${encodeURIComponent("/security/report")}`}>Sign in</a> to send a report
              {others.length ? (
                <>
                  , or use {others.length === 1 ? "this contact" : "one of these contacts"}:{" "}
                  {others.map((u, i) => (
                    <>
                      {i ? ", " : ""}
                      <a href={u} rel="nofollow">
                        {u.replace(/^mailto:/, "")}
                      </a>
                    </>
                  ))}
                </>
              ) : null}
              .
            </p>
          </div>
        </div>
      ) : (
        <Form action="/security/report" t={csrfToken(c)} class="box">
          <div class="body">
            <div class="field">
              <label for="sr-summary">Summary</label>
              <input id="sr-summary" name="summary" type="text" required maxlength={MAX_SUMMARY} value={v.summary} placeholder="e.g. Stored XSS in release notes" autocomplete="off" />
              <div class="hint">One line. The site administrators get it by email; the details stay here.</div>
            </div>
            <div class="field">
              <label for="sr-details">Details</label>
              <textarea id="sr-details" name="details" required maxlength={MAX_DETAILS} style="min-height:220px" placeholder="What is affected, the steps or requests that show it, what you expected and what happened, and what an attacker could do with it.">
                {v.details ?? ""}
              </textarea>
              <div class="hint">Plain text, up to {MAX_DETAILS.toLocaleString("en")} characters. Leave out secrets and other people's data you came across; say that you saw them instead.</div>
            </div>
            <div class="field">
              <label for="sr-area">Affected URL or area (optional)</label>
              <input id="sr-area" name="area" type="text" maxlength={MAX_AREA} value={v.area} placeholder="e.g. /api/v3/repos/{owner}/{repo}/releases, git push, the MCP server" autocomplete="off" />
            </div>
            <div class="field">
              <label for="sr-reply">{me ? "Reply-to email (optional)" : "Reply-to email"}</label>
              <input id="sr-reply" name="reply_to" type="email" required={!me} maxlength={254} value={v.replyTo} autocomplete="email" />
              <div class="hint">{me ? <>Leave it empty and we reply to your account's address{me.email ? <> ({me.email})</> : null}.</> : <>Where we can reply. Or <a href={`/login?next=${encodeURIComponent("/security/report")}`}>sign in</a> to report as yourself.</>}</div>
            </div>
            {siteKey ? <div class="cf-turnstile" data-sitekey={siteKey} data-theme="auto" style="margin-bottom:12px"></div> : null}
            <button class="btn primary">Send the report</button>
          </div>
        </Form>
      )}
    </div>,
  );
}

function sentPage(c: AppContext, r: SecurityReport): Response | Promise<Response> {
  return render(
    c,
    { title: "Report sent", status: 201 },
    <div style="max-width:720px;margin:32px auto">
      <h1>Thank you: your report was sent</h1>
      <p>
        The site administrators of this instance have it, and only they can read it. Your reference is <span class="mono">{r.id}</span>.
      </p>
      <p class="muted">
        {r.reply_to ? (
          <>
            They will reply to <b>{r.reply_to}</b>.
          </>
        ) : (
          <>You gave no address and your account has none, so they can't reply by email.</>
        )}{" "}
        The <a href="/docs/security/disclosure#what-to-expect">disclosure policy</a> says how quickly we aim to answer. Please keep the problem private until it is fixed.
      </p>
    </div>,
  );
}

export function registerSecurityReports(web: WebApp): void {
  // ------------------------------------------------------------ the report form

  web.get("/security/report", (c) => reportPage(c));

  post(
    web,
    "/security/report",
    async (c, f) => {
      const values: FormValues = { summary: f.s("summary").slice(0, MAX_SUMMARY * 2), details: f.s("details").slice(0, MAX_DETAILS * 2), area: f.s("area").slice(0, MAX_AREA * 2), replyTo: f.s("reply_to").slice(0, 254) };
      try {
        const me = reporterOf(c);
        const ip = c.req.header("cf-connecting-ip") ?? null;
        if (!me) {
          // The same check as open sign-up: Turnstile when configured, none in local development, refused otherwise.
          const mode = turnstileMode(c.env);
          if (mode === "missing") throw new HttpError(503, TURNSTILE_MISSING);
          if (mode === "verify" && !(await verifyTurnstile(c.env.TURNSTILE_SECRET!, f.s("cf-turnstile-response"), ip))) throw new HttpError(403, "We couldn't confirm that you're a person. Please try again.");
        }
        const input = validateReport(values, !!me);
        const r = await submitReport(c.env, (e) => c.get("dir").audit(e), input, me, ip);
        return sentPage(c, r);
      } catch (e) {
        const s = statusOf(e);
        if (s.status >= 500 && s.status !== 503) throw e;
        return reportPage(c, { values, error: s.message, status: s.status });
      }
    },
    { maxBytes: MAX_FORM_BYTES },
  );

  // ------------------------------------------------------------ site administration: Security reports

  /** Reports don't exist for anyone but site administrators: 404, not 403. */
  const requireSiteAdmin = (c: AppContext): Account => {
    const me = requireAccount(c);
    if (!me.site_admin) throw new HttpError(404, "not found");
    return me;
  };

  const page = (c: AppContext, me: Account, title: string, body: Child) =>
    render(
      c,
      { title },
      <div class="grid left">
        <SettingsNav me={me} tab="security-reports" db={c.env.DB} />
        <div>
          <ComputePausedBanner env={c.env} />
          {body}
        </div>
      </div>,
    );

  const BASE = "/settings/admin/security-reports";

  web.get(BASE, async (c) => {
    const me = requireSiteAdmin(c);
    const q = c.req.query("state");
    const state = REPORT_STATES.includes(q as ReportState) ? (q as ReportState) : undefined;
    const reports = new SecurityReports(c.env.DB);
    const [rows, counts] = await Promise.all([reports.list({ state, limit: 200 }), reports.counts()]);
    return page(
      c,
      me,
      "Security reports",
      <>
        <h1>Security reports</h1>
        <p class="muted">
          Private vulnerability reports sent through <a href="/security/report">/security/report</a>, the first contact in <a href="/.well-known/security.txt">security.txt</a>. Only site administrators can see them. Each new one emails every site administrator its summary. Changes are in the <a href="/settings/audit">audit log</a>.
        </p>
        <form method="get" action={BASE} class="row mb">
          <KSelect
            name="state"
            label="Show"
            value={state ?? ""}
            autosubmit
            options={[{ value: "", label: `All (${counts.new + counts.triaged + counts.resolved})` }, ...REPORT_STATES.map((s) => ({ value: s, label: `${STATE_TEXT[s]} (${counts[s]})` }))]}
          />
        </form>
        <div class="box" style="overflow:auto">
          {rows.length ? (
            <table class="tbl">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Summary</th>
                  <th>From</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td class="small nowrap">
                      <Time at={r.created_at} />
                    </td>
                    <td>
                      <a href={`${BASE}/${r.id}`}>{r.summary}</a>
                    </td>
                    <td class="small">{r.reporter_login ?? <span class="muted">not signed in</span>}</td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="empty">{state ? `No ${STATE_TEXT[state].toLowerCase()} reports.` : "No security reports yet."}</div>
          )}
        </div>
      </>,
    );
  });

  web.get(`${BASE}/:id`, async (c) => {
    const me = requireSiteAdmin(c);
    const r = await new SecurityReports(c.env.DB).get(prm(c, "id"));
    if (!r) throw new HttpError(404, "no security report with that id");
    return page(
      c,
      me,
      `Security report: ${r.summary}`,
      <>
        <p class="small">
          <a href={BASE}>← Security reports</a>
        </p>
        <h1>{r.summary}</h1>
        <div class="box">
          <div class="body">
            <dl class="kv m0">
              <dt>State</dt>
              <dd>
                <StateBadge state={r.state} />
                {r.updated_by ? (
                  <span class="muted small">
                    {" "}
                    by {r.updated_by} <Time at={r.updated_at} />
                  </span>
                ) : null}
              </dd>
              <dt>Received</dt>
              <dd>
                <Time at={r.created_at} /> <span class="muted small">{r.created_at}</span>
              </dd>
              <dt>From</dt>
              <dd>{r.reporter_login ? <a href={`/${r.reporter_login}`}>{r.reporter_login}</a> : <span class="muted">someone not signed in</span>}</dd>
              <dt>Reply to</dt>
              <dd>{r.reply_to ? <a href={`mailto:${r.reply_to}`}>{r.reply_to}</a> : <span class="muted">no address</span>}</dd>
              <dt>Affected</dt>
              <dd class="mono" style="overflow-wrap:anywhere">
                {r.area ?? <span class="muted">not given</span>}
              </dd>
              <dt>Reference</dt>
              <dd class="mono">{r.id}</dd>
            </dl>
          </div>
        </div>
        <h2>Details</h2>
        <div class="box">
          {/* Plain text exactly as sent: never rendered as Markdown or HTML. */}
          <pre class="body m0" style="white-space:pre-wrap;overflow-wrap:anywhere">
            {r.details}
          </pre>
        </div>
        <h2>Triage</h2>
        <Form action={`${BASE}/${r.id}`} t={csrfToken(c)} class="box mb">
          <div class="body">
            <div class="field">
              <label>State</label>
              <KSelect name="state" label="State" value={r.state === "new" ? "triaged" : r.state} options={REPORT_STATES.map((s) => ({ value: s, label: STATE_TEXT[s] }))} />
            </div>
            <div class="field">
              <label for="sr-note">Note</label>
              <textarea id="sr-note" name="note" maxlength={MAX_NOTE} style="min-height:90px" placeholder="e.g. Reproduced; fix in the next release. Replied to the reporter.">
                {r.note ?? ""}
              </textarea>
              <div class="hint">Only site administrators see it. Each change is in the audit log.</div>
            </div>
            <button class="btn primary">Save</button>
          </div>
        </Form>
      </>,
    );
  });

  post(web, `${BASE}/:id`, async (c, f) => {
    const me = requireSiteAdmin(c);
    const id = prm(c, "id");
    return act(c, `${BASE}/${id}`, async () => {
      const r = await changeReport(c.env.DB, (e) => c.get("dir").audit(e), me, id, f.s("state"), f.s("note"), "web");
      return `${BASE}/${r.id}`;
    }, "Report updated.");
  });
}
