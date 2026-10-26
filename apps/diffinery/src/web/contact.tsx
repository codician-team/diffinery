/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { turnstileMode } from "../auth/signup.js";
import { formStamp } from "../lib/early-access.js";
import type { Account, Directory } from "../lib/directory.js";
import {
  CONFIRM_HOURS,
  ContactMessages,
  MAX_MESSAGE,
  MAX_NAME,
  MAX_NOTE,
  MESSAGE_STATES,
  TOPICS,
  UNCONFIRMED_DAYS,
  changeMessage,
  confirmMessage,
  deleteMessage,
  isTopic,
  submitMessage,
  topicLabel,
  validateMessage,
  type ContactMessage,
  type MessageState,
} from "../lib/contact.js";
import { HttpError } from "../lib/util.js";
import { ICONS } from "./assets.js";
import { SettingsNav } from "./account.js";
import { csrfToken } from "./csrf.js";
import { CONFIRM_SCRIPT, Protections, guard } from "./early-access.js";
import { ComputePausedBanner } from "./kill-switches.js";
import { KSelect } from "./kumo.js";
import { Form, Pager, Time, act, flash, pageNum, post, principalAccount, prm, qs, render, statusOf, type WebApp } from "./ui.js";

/**
 * The contact form in the web UI (lib/contact.ts): /contact for anyone, signed in or not, the page
 * its confirmation email links to, and the **Contact messages** page of site administration, where
 * messages are read, marked handled or spam, noted and deleted.
 */

/** Largest message form, in bytes: the message's cap with room for percent-encoded UTF-8. */
const MAX_FORM_BYTES = 64 * 1024;
const BASE = "/settings/admin/contact";

const TURNSTILE_MISSING = "This instance has no Turnstile configured (TURNSTILE_SITE_KEY and TURNSTILE_SECRET), so its contact form takes messages only from people who are signed in.";

export const STATE_TEXT: Record<MessageState, string> = { new: "New", handled: "Handled", spam: "Spam", unconfirmed: "Unconfirmed" };
const STATE_BADGE: Record<MessageState, string> = { new: "badge blue", handled: "badge green", spam: "badge red", unconfirmed: "badge" };
const StateBadge: FC<{ state: MessageState }> = ({ state }) => <span class={STATE_BADGE[state]}>{STATE_TEXT[state]}</span>;

/** Who writes as themselves: an active person signed in. Anyone else goes through Turnstile and confirms by email. */
const senderOf = (c: AppContext): Account | null => {
  const a = principalAccount(c);
  return a && a.kind === "user" && a.status === "active" ? a : null;
};

interface FormValues {
  email?: string;
  name?: string;
  topic?: string;
  message?: string;
}

// ---------------------------------------------------------------- the form

const Way: FC<{ icon: string; title: string; children: Child }> = ({ icon, title, children }) => (
  <li>
    <span class="ic">{raw(icon)}</span>
    <span>
      <b>{title}</b>
      <span class="muted">{children}</span>
    </span>
  </li>
);

async function contactPage(c: AppContext, o: { values?: FormValues; error?: string; status?: number } = {}): Promise<Response> {
  const me = senderOf(c);
  const mode = turnstileMode(c.env);
  const siteKey = !me && mode === "verify" ? c.env.TURNSTILE_SITE_KEY : undefined;
  const closed = !me && mode === "missing";
  const v = o.values ?? {};
  const stamp = me || closed ? "" : await formStamp(c.env);
  const topic = v.topic ?? (isTopic(c.req.query("topic") ?? "") ? c.req.query("topic") : "");
  const origin = c.env.PUBLIC_URL.replace(/\/$/, "");
  return render(
    c,
    {
      title: "Contact us",
      seoTitle: "Contact the Diffinery team",
      status: o.status,
      turnstile: !!siteKey,
      description: "Write to the people who run this Diffinery instance: questions, help with your account, running your own Diffinery, partnerships, press and privacy requests.",
      jsonLd: [{ "@type": "ContactPage", "@id": `${origin}/contact#webpage`, url: `${origin}/contact`, name: "Contact the Diffinery team", isPartOf: { "@id": `${origin}/#website` }, about: { "@id": `${origin}/#organization` }, inLanguage: "en" }],
    },
    <div class="ea ct">
      <section class="ea-head">
        <span class="ea-eyebrow">{raw(ICONS.envelope)} Contact</span>
        <h1>Contact us</h1>
        <p class="ea-lede">Questions, help with your account, running your own Diffinery, partnerships or press: write to the people who run this instance. A person reads every message and replies by email.</p>
      </section>
      <section class="ea-more">
        <ul class="ea-points">
          <Way icon={ICONS.shield} title="Found a security problem?">
            Report it privately with the <a href="/security/report">security report form</a> instead, so only the site administrators see it.
          </Way>
          <Way icon={ICONS.zap} title="Is something down?">
            The <a href="/status">status page</a> shows incidents as they happen.
          </Way>
          <Way icon={ICONS.code} title="Want to know how something works?">
            The <a href="/docs">docs</a> answer most questions, and the <a href="/faq">FAQ</a> the common ones.
          </Way>
        </ul>
        {me ? null : (
          <ol class="ea-steps">
            <li>Send this form.</li>
            <li>Confirm your email address with the link we send you.</li>
            <li>Your message goes to the team, who reply to that address.</li>
          </ol>
        )}
      </section>
      <div class="box ea-card">
        <div class="body">
          {closed ? (
            <p class="m0">
              {TURNSTILE_MISSING} <a href="/login?next=%2Fcontact">Sign in</a> to write to them.
            </p>
          ) : (
            <Form action="/contact" t={csrfToken(c)}>
              <h2>Send us a message</h2>
              <p class="muted small">{me ? `Signed in as ${me.login}. We'll reply to ${me.email ?? "your account's email address"}.` : "Every field is required."}</p>
              {o.error ? (
                <div class="flash error" role="alert">
                  {o.error}
                </div>
              ) : null}
              <div class="field">
                <label for="ct-name">Name</label>
                <input id="ct-name" name="name" type="text" required maxlength={MAX_NAME} value={v.name ?? (me ? me.name || "" : undefined)} autocomplete="name" />
              </div>
              {me ? null : (
                <div class="field">
                  <label for="ct-email">Email</label>
                  <input id="ct-email" name="email" type="email" required maxlength={254} value={v.email} autocomplete="email" placeholder="you@example.com" />
                </div>
              )}
              <div class="field">
                <label>Topic</label>
                <KSelect name="topic" label="Topic" block value={topic || undefined} placeholder="Choose a topic" options={TOPICS.map((t) => ({ value: t.value, label: t.label }))} />
              </div>
              <div class="field">
                <label for="ct-message">Message</label>
                <textarea id="ct-message" name="message" required maxlength={MAX_MESSAGE} style="min-height:160px">
                  {v.message ?? ""}
                </textarea>
              </div>
              {me ? null : <Protections stamp={stamp} siteKey={siteKey} />}
              <button class="btn primary block">Send message</button>
              <p class="ea-privacy">
                Only the site administrators can read your message. We use it and your address only to reply, and delete it within a year of handling it. See <a href="/privacy">Privacy</a>.
              </p>
            </Form>
          )}
        </div>
      </div>
    </div>,
  );
}

/** What someone who isn't signed in sees after sending, whatever happened to the message. */
function checkInboxPage(c: AppContext, email: string): Response | Promise<Response> {
  return render(
    c,
    { title: "Check your inbox" },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.envelope)}</span>
      <h1>Check your inbox</h1>
      <p>
        We've sent <b>{email}</b> a link to confirm your message. Open it within {CONFIRM_HOURS} hours and your message goes to the team.
      </p>
      <p class="muted">Nothing there? Check your spam folder. Messages that are never confirmed are deleted after {UNCONFIRMED_DAYS} days, unread.</p>
      <p class="row" style="justify-content:center">
        <a class="btn" href="/">
          Back to the home page
        </a>
        <a class="btn" href="/docs">
          Read the docs meanwhile
        </a>
      </p>
    </div>,
  );
}

/** What a signed-in person sees after sending. */
function sentPage(c: AppContext, email: string): Response | Promise<Response> {
  return render(
    c,
    { title: "Message sent" },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.check)}</span>
      <h1>Message sent</h1>
      <p>
        Thanks for writing to us. The team reads every message and replies to <b>{email}</b>. We've emailed you a copy.
      </p>
      <p class="row" style="justify-content:center">
        <a class="btn" href="/">
          Back to your dashboard
        </a>
      </p>
    </div>,
  );
}

/** Runs on the confirmation page: the early access form's, for this form. */
const SCRIPT = CONFIRM_SCRIPT.replace('"ea-confirm"', '"ct-confirm"').replace('"ea-confirm-status"', '"ct-confirm-status"');

function confirmPage(c: AppContext): Response | Promise<Response> {
  return render(
    c,
    { title: "Confirm your message", script: SCRIPT },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.envelope)}</span>
      <h1>Confirm your message</h1>
      <p class="muted" id="ct-confirm-status" aria-live="polite">
        Checking your link…
      </p>
      <noscript>
        <p class="muted">Turn on JavaScript for this page to confirm your message: the link's code stays in your browser until you press the button.</p>
      </noscript>
      <Form action="/contact/confirm" t={csrfToken(c)} id="ct-confirm" style="display:none">
        <input type="hidden" name="token" value="" />
        <p>Press the button to confirm that you wrote this message from this email address. It then goes to the team.</p>
        <button class="btn primary">Confirm my message</button>
      </Form>
    </div>,
  );
}

function confirmedPage(c: AppContext, m: ContactMessage | null): Response | Promise<Response> {
  if (!m)
    return render(
      c,
      { title: "This link doesn't work", status: 410 },
      <div class="ea-done">
        <span class="ic">{raw(ICONS.x)}</span>
        <h1>This link doesn't work any more</h1>
        <p class="muted">Confirmation links work once, for {CONFIRM_HOURS} hours. If you already confirmed, your message is with the team and there's nothing else to do.</p>
        <p>
          <a class="btn primary" href="/contact">
            Write a new message
          </a>
        </p>
      </div>,
    );
  return render(
    c,
    { title: "Message sent" },
    <div class="ea-done">
      <span class="ic">{raw(ICONS.check)}</span>
      <h1>Your message is with the team</h1>
      <p>
        Thanks, <b>{m.name}</b>. A person reads every message and replies to <b>{m.email}</b>.
      </p>
      <p class="row" style="justify-content:center">
        <a class="btn" href="/">
          Back to the home page
        </a>
        <a class="btn" href="/docs">
          Read the docs meanwhile
        </a>
      </p>
    </div>,
  );
}

// ---------------------------------------------------------------- site administration

/** The initial on a message's avatar: its sender's name's first letter. */
const initial = (m: Pick<ContactMessage, "name" | "email">) => (m.name || m.email).trim().charAt(0).toUpperCase() || "?";

const Actions: FC<{ m: ContactMessage; t: string; back: string }> = ({ m, t, back }) => {
  const button = (state: "new" | "handled" | "spam", label: Child, cls = "btn sm") => (
    <Form action={`${BASE}/${m.id}/state`} t={t} class="inline">
      <input type="hidden" name="state" value={state} />
      <input type="hidden" name="back" value={back} />
      <button class={cls}>{label}</button>
    </Form>
  );
  return (
    <>
      {m.state === "new" || m.state === "unconfirmed" ? button("handled", <>{raw(ICONS.check)} Mark handled</>, "btn sm primary") : null}{" "}
      {m.state !== "spam" ? button("spam", "Spam") : null} {m.state === "handled" || m.state === "spam" ? button("new", "Reopen") : null}
    </>
  );
};

type Row = ContactMessage & { account_login: string | null };

/** Messages with the login of an active account that uses the address, if any (a signed-in sender's own). */
async function withAccounts(db: D1Database, rows: ContactMessage[]): Promise<Row[]> {
  if (!rows.length) return [];
  const emails = [...new Set(rows.map((r) => r.email.toLowerCase()))];
  const found = (
    await db
      .prepare(`SELECT lower(email) AS email, login FROM accounts WHERE kind = 'user' AND status = 'active' AND lower(email) IN (${emails.map(() => "?").join(", ")})`)
      .bind(...emails)
      .all<{ email: string; login: string }>()
  ).results;
  const by = new Map(found.map((f) => [f.email, f.login]));
  return rows.map((r) => ({ ...r, account_login: r.sender_login ?? by.get(r.email.toLowerCase()) ?? null }));
}

/** A reply in the site administrator's own mail app, to the sender, quoting the topic. */
const mailto = (m: ContactMessage) => `mailto:${encodeURIComponent(m.email).replace(/%40/g, "@")}?subject=${encodeURIComponent(`Re: ${topicLabel(m.topic)}`)}`;

const backTo = (v: string): string => (v.startsWith(BASE) && !v.startsWith("//") && !/[\r\n]/.test(v) ? v : BASE);

export function registerContact(web: WebApp): void {
  // ------------------------------------------------------------ the form

  web.get("/contact", (c) => contactPage(c));
  web.get("/contact/", (c) => c.redirect("/contact", 301));

  post(
    web,
    "/contact",
    async (c, f) => {
      const values: FormValues = { email: f.s("email").slice(0, 254), name: f.s("name").slice(0, MAX_NAME * 2), topic: f.s("topic").slice(0, 40), message: f.s("message").slice(0, MAX_MESSAGE * 2) };
      try {
        const me = senderOf(c);
        // A filled honeypot or a form sent faster than a person types: answer as if it worked, keep nothing.
        if (!me && (await guard(c, f, TURNSTILE_MISSING)) === "silent") return checkInboxPage(c, values.email?.trim() || "your address");
        const input = validateMessage(values, !!me);
        await submitMessage(c.env, (e) => c.get("dir").audit(e), input, me, c.req.header("cf-connecting-ip") ?? null);
        return me ? sentPage(c, me.email ?? "your address") : checkInboxPage(c, input.email!);
      } catch (e) {
        const s = statusOf(e);
        if (s.status >= 500 && s.status !== 503) throw e;
        return contactPage(c, { values, error: s.message, status: s.status });
      }
    },
    { maxBytes: MAX_FORM_BYTES },
  );

  web.get("/contact/confirm", (c) => confirmPage(c));

  post(
    web,
    "/contact/confirm",
    async (c, f) => confirmedPage(c, await confirmMessage(c.env, (e) => c.get("dir").audit(e), f.s("token").slice(0, 200))),
    { maxBytes: 4096 },
  );

  // ------------------------------------------------------------ site administration: Contact messages

  /** Messages don't exist for anyone but site administrators: 404, not 403. */
  const requireSiteAdmin = (c: AppContext): Account => {
    const me = requireAccount(c);
    if (!me.site_admin || me.kind !== "user") throw new HttpError(404, "not found");
    return me;
  };

  const page = (c: AppContext, me: Account, title: string, body: Child) =>
    render(
      c,
      { title },
      <div class="grid left">
        <SettingsNav me={me} tab="contact" db={c.env.DB} />
        <div>
          <ComputePausedBanner env={c.env} />
          {body}
        </div>
      </div>,
    );

  const PER_PAGE = 50;

  web.get(BASE, async (c) => {
    const me = requireSiteAdmin(c);
    const qState = c.req.query("state");
    const state: MessageState | "all" = qState === "all" ? "all" : MESSAGE_STATES.includes(qState as MessageState) ? (qState as MessageState) : "new";
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const pg = pageNum(c);
    const store = new ContactMessages(c.env.DB);
    const [list, counts] = await Promise.all([store.list({ state: state === "all" ? undefined : state, q, limit: PER_PAGE, offset: (pg - 1) * PER_PAGE }), store.counts()]);
    const rows = await withAccounts(c.env.DB, list.items);
    const total = counts.new + counts.handled + counts.spam + counts.unconfirmed;
    const here = `${BASE}${qs({ state: state === "new" ? undefined : state, q, page: pg > 1 ? pg : undefined })}`;
    const t = csrfToken(c);
    const tab = (s: MessageState | "all", label: string, n: number) => (
      <a href={`${BASE}${qs({ state: s === "new" ? undefined : s, q })}`} class={state === s ? "on" : ""}>
        {label} <span class="n">{n}</span>
      </a>
    );
    return page(
      c,
      me,
      "Contact messages",
      <>
        <h1>Contact messages</h1>
        <p class="muted">
          Messages from <a href="/contact">/contact</a>. A message from someone who isn't signed in arrives once its address follows the emailed link. Reply from your own mailbox (the notification email's Reply-To is the sender), then mark it handled. Every change is in the <a href="/settings/audit">audit log</a>.
        </p>
        <nav class="tabs mb" aria-label="Messages by state">
          {tab("new", "New", counts.new)}
          {tab("handled", "Handled", counts.handled)}
          {tab("spam", "Spam", counts.spam)}
          {tab("unconfirmed", "Unconfirmed", counts.unconfirmed)}
          {tab("all", "All", total)}
        </nav>
        <form method="get" action={BASE} class="row mb" role="search">
          {state === "new" ? null : <input type="hidden" name="state" value={state} />}
          <input type="search" name="q" value={q} maxlength={100} placeholder="Search by email, name or message" aria-label="Search messages" class="grow" style="max-width:420px" />
          <button class="btn">{raw(ICONS.search)} Search</button>
          {q ? (
            <a class="btn" href={`${BASE}${qs({ state: state === "new" ? undefined : state })}`}>
              Clear
            </a>
          ) : null}
        </form>
        <div class="box">
          {rows.length ? (
            <ul class="list ea-list">
              {rows.map((m) => (
                <li>
                  <span class="ea-av" aria-hidden="true">
                    {initial(m)}
                  </span>
                  <div class="grow" style="min-width:0">
                    <div class="row" style="gap:6px;flex-wrap:wrap">
                      <a class="title" href={`${BASE}/${m.id}`}>
                        {m.name}
                      </a>
                      <span class="muted small">{m.email}</span>
                      <StateBadge state={m.state} />
                      {m.account_login ? <span class="badge amber">{m.sender_login ? "signed in" : "has an account"}: {m.account_login}</span> : null}
                    </div>
                    <div class="meta">
                      {topicLabel(m.topic)} · sent <Time at={m.created_at} />
                      {m.handled_at && m.updated_by ? (
                        <>
                          {" "}
                          · {m.state === "spam" ? "marked spam" : "handled"} by {m.updated_by} <Time at={m.handled_at} />
                        </>
                      ) : null}
                    </div>
                    <div class="ea-use">{m.message.replace(/\s+/g, " ")}</div>
                  </div>
                  <div class="ea-actions nowrap">
                    <Actions m={m} t={t} back={here} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">{q ? "No messages match your search." : state === "new" ? "No new messages. Messages show up here once their address confirms." : state === "all" ? "No contact messages yet." : `No ${STATE_TEXT[state].toLowerCase()} messages.`}</div>
          )}
        </div>
        <Pager page={pg} hasNext={list.more} href={(p) => `${BASE}${qs({ state: state === "new" ? undefined : state, q, page: p > 1 ? p : undefined })}`} />
      </>,
    );
  });

  web.get(`${BASE}/:id`, async (c) => {
    const me = requireSiteAdmin(c);
    const found = await new ContactMessages(c.env.DB).get(prm(c, "id"));
    if (!found) throw new HttpError(404, "no contact message with that id");
    const [m] = (await withAccounts(c.env.DB, [found])) as [Row];
    const t = csrfToken(c);
    const here = `${BASE}/${m.id}`;
    return page(
      c,
      me,
      `Contact: ${m.name}`,
      <>
        <p class="small">
          <a href={BASE}>← Contact messages</a>
        </p>
        <div class="row mb" style="gap:12px;align-items:center;flex-wrap:wrap">
          <span class="ea-av lg" aria-hidden="true">
            {initial(m)}
          </span>
          <div class="grow" style="min-width:0">
            <h1 class="m0" style="overflow-wrap:anywhere">{m.name}</h1>
            <div class="row" style="gap:6px;margin-top:4px;flex-wrap:wrap">
              <StateBadge state={m.state} />
              <span class="badge">{topicLabel(m.topic)}</span>
            </div>
          </div>
          <div class="ea-actions">
            <a class="btn sm" href={mailto(m)}>
              {raw(ICONS.envelope)} Reply by email
            </a>
            <Actions m={m} t={t} back={here} />
          </div>
        </div>
        <h2>Message</h2>
        <div class="box">
          {/* Plain text exactly as sent: never rendered as Markdown or HTML. */}
          <pre class="body m0" style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--sans);font-size:14px">
            {m.message}
          </pre>
        </div>
        <div class="box">
          <div class="body">
            <dl class="kv m0">
              <dt>From</dt>
              <dd style="overflow-wrap:anywhere">
                {m.name} &lt;<a href={mailto(m)}>{m.email}</a>&gt;
              </dd>
              <dt>Account</dt>
              <dd>
                {m.account_login ? (
                  <>
                    <a href={`/${m.account_login}`}>{m.account_login}</a> <span class="muted small">{m.sender_login ? "sent it signed in" : "uses this address"}</span>
                  </>
                ) : (
                  <span class="muted">none uses this address</span>
                )}
              </dd>
              <dt>Topic</dt>
              <dd>{topicLabel(m.topic)}</dd>
              <dt>Sent</dt>
              <dd>
                <Time at={m.created_at} /> <span class="muted small">{m.created_at}</span>
              </dd>
              <dt>Confirmed</dt>
              <dd>{m.confirmed_at ? m.sender_login ? <span class="muted">signed in, so no confirmation was needed</span> : <Time at={m.confirmed_at} /> : <span class="muted">not yet: the address hasn't followed the emailed link</span>}</dd>
              {m.handled_at && m.updated_by ? (
                <>
                  <dt>{m.state === "spam" ? "Marked spam" : "Handled"}</dt>
                  <dd>
                    by {m.updated_by} <Time at={m.handled_at} />
                  </dd>
                </>
              ) : null}
              <dt>Reference</dt>
              <dd class="mono">{m.id}</dd>
            </dl>
          </div>
        </div>
        <h2>Note</h2>
        <Form action={`${BASE}/${m.id}/note`} t={t} class="box">
          <div class="body">
            <div class="field">
              <label for="ct-note">For the other site administrators: who replied, what was agreed. The sender never sees it.</label>
              <textarea id="ct-note" name="note" maxlength={MAX_NOTE} style="min-height:80px;width:100%">
                {m.note ?? ""}
              </textarea>
            </div>
            <button class="btn">Save note</button>
          </div>
        </Form>
        <h2>Delete</h2>
        <Form action={`${BASE}/${m.id}/delete`} t={t} class="box" confirm={`Delete the message from ${m.email} and everything stored about it? This can't be undone.`}>
          <div class="body row between" style="gap:12px;flex-wrap:wrap">
            <span class="muted">For someone who asks for their data to be removed. The audit log keeps that a message was deleted, not what it said.</span>
            <button class="btn danger">{raw(ICONS.trash)} Delete message</button>
          </div>
        </Form>
      </>,
    );
  });

  const audit = (c: AppContext) => (e: Parameters<Directory["audit"]>[0]) => c.get("dir").audit(e);
  const DONE: Record<MessageState, string> = { new: "Reopened the message.", unconfirmed: "Reopened the message. Its address still has to confirm it.", handled: "Marked the message handled.", spam: "Marked the message as spam. Nothing more from its address gets through while it stays spam." };

  post(web, `${BASE}/:id/state`, async (c, f) => {
    const me = requireSiteAdmin(c);
    return act(c, backTo(f.s("back")), async () => {
      const m = await changeMessage(c.env.DB, audit(c), me, prm(c, "id"), { state: f.s("state") }, "web");
      return void flash(c, "notice", DONE[m.state]);
    });
  });
  post(
    web,
    `${BASE}/:id/note`,
    async (c, f) => {
      const me = requireSiteAdmin(c);
      return act(c, `${BASE}/${encodeURIComponent(prm(c, "id"))}`, async () => {
        const m = await changeMessage(c.env.DB, audit(c), me, prm(c, "id"), { note: f.s("note") }, "web");
        return void flash(c, "notice", m.note ? "Note saved." : "Note cleared.");
      });
    },
    { maxBytes: 16 * 1024 },
  );
  post(web, `${BASE}/:id/delete`, async (c) => {
    const me = requireSiteAdmin(c);
    return act(c, `${BASE}/${encodeURIComponent(prm(c, "id"))}`, async () => {
      await deleteMessage(c.env.DB, audit(c), me, prm(c, "id"), "web");
      flash(c, "notice", "Message deleted.");
      return BASE;
    });
  });
}
