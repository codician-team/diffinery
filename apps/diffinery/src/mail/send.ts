import { devAuth } from "../auth/dev.js";
import type { Env } from "../env.js";
import { Directory, type Account } from "../lib/directory.js";
import { MailStore, wantsEmail } from "./prefs.js";
import { compose, toHtml, toText, type RenderCtx } from "./templates.js";
import { categoryOf, isMandatory, type MailJob } from "./types.js";
import { SmtpError, sendSmtp, smtpConfig, type SmtpConfig } from "./smtp.js";
import { REASON_TEXT, Suppressions, sendSuppression } from "./suppression.js";
import { unsubUrl } from "./unsubscribe.js";

/**
 * Sending: jobs go on the `diffinery-mail` queue (so a slow or failing send
 * never holds up a request, and failures retry with backoff), and the queue
 * consumer checks the recipient's settings, renders and sends each one through
 * Cloudflare Email Sending, or over SMTP (smtp.ts) where there is no EMAIL binding.
 * Nothing goes to an address on the suppression list (suppression.ts), and an
 * address Email Sending or the SMTP server refuses for good goes on it.
 */

/**
 * Queues limit a message to 128 KB and a sendBatch to 100 messages and 256 KB. A long comment sent to
 * many watchers passed 256 KB in one batch of 50, and the whole batch was refused and lost. Batches are
 * cut by size now, and a body longer than MAX_QUEUED_BODY is shortened (the email links to the thread).
 */
const MAX_BATCH_BYTES = 200_000;
const MAX_BATCH_JOBS = 50;
/** Under Queues' 128 KB per message, with room for its own envelope. */
const MAX_MESSAGE_BYTES = 120_000;
export const MAX_QUEUED_BODY = 32_000;

/** A job as it goes on the queue: the thread body cut to MAX_QUEUED_BODY characters. */
export function queuedJob(job: MailJob): MailJob {
  const data = (job as { data?: { body?: unknown } }).data;
  if (!data || typeof data.body !== "string" || data.body.length <= MAX_QUEUED_BODY) return job;
  return { ...job, data: { ...data, body: `${data.body.slice(0, MAX_QUEUED_BODY)}\n\n…` } } as MailJob;
}

/** Jobs in sendBatch-sized groups: at most MAX_BATCH_JOBS and about MAX_BATCH_BYTES of JSON each. */
export function mailBatches(jobs: MailJob[]): MailJob[][] {
  const out: MailJob[][] = [];
  let cur: MailJob[] = [];
  let bytes = 0;
  for (const job of jobs.map(queuedJob)) {
    const size = new TextEncoder().encode(JSON.stringify(job)).length + 100;
    // Queues would refuse it, and the batch it is in with it: it is left out on its own.
    if (size > MAX_MESSAGE_BYTES) {
      console.error("email too large to queue; dropped", job.kind, size);
      continue;
    }
    if (cur.length && (cur.length >= MAX_BATCH_JOBS || bytes + size > MAX_BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(job);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Queue emails. Never throws: email must not break the action that caused it. */
export async function enqueueMail(env: Env, jobs: MailJob[]): Promise<void> {
  if (!jobs.length) return;
  if (!env.MAIL) {
    console.warn("mail queue not bound; dropping", jobs.length, "email(s)");
    return;
  }
  // One refused batch doesn't stop the others.
  for (const batch of mailBatches(jobs)) {
    try {
      await env.MAIL.sendBatch(batch.map((body) => ({ body })));
    } catch (e) {
      console.error("could not queue email", batch.length, e);
    }
  }
}

const RETRYABLE = new Set(["E_RATE_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_DELIVERY_FAILED", "E_SMTP_TRANSIENT"]);

export class RetryableMailError extends Error {}

/**
 * How this instance sends email: Cloudflare Email Sending when the EMAIL binding is there, else
 * the SMTP server in SMTP_URL (with what is wrong with it, if anything); null when neither is set.
 */
export type MailTransport = { kind: "email-sending"; binding: SendEmail } | { kind: "smtp"; config: SmtpConfig } | { kind: "smtp"; error: string };

export function mailTransport(env: Pick<Env, "EMAIL" | "SMTP_URL" | "SMTP_PASSWORD">): MailTransport | null {
  if (env.EMAIL) return { kind: "email-sending", binding: env.EMAIL };
  const smtp = smtpConfig(env);
  if (!smtp) return null;
  return "error" in smtp ? { kind: "smtp", error: smtp.error } : { kind: "smtp", config: smtp };
}

/** The address every email is sent from: MAIL_FROM, or notifications@ the public host. */
export const senderAddress = (env: Pick<Env, "MAIL_FROM" | "PUBLIC_URL">): string => env.MAIL_FROM || `notifications@${new URL(env.PUBLIC_URL).hostname}`;

const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const listIdLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "x";

export interface Outgoing {
  from: { name: string; email: string };
  to: { name: string; email: string } | string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  replyTo?: { name: string; email: string } | string;
}

/** Render a job for one recipient: the message plus the headers mail clients use for threading and unsubscribing. */
export async function buildMessage(env: Env, job: MailJob, to: { email: string; name?: string; login?: string; accountId?: string }): Promise<Outgoing> {
  const pub = env.PUBLIC_URL;
  const email = compose(job, pub, to.login, env.MAIL_FROM);
  const category = categoryOf(job);
  const unsubscribe: Array<{ label: string; url: string }> = [];
  // The one-click List-Unsubscribe header (RFC 8058) turns this kind of email off for the recipient.
  let oneClick: string | undefined;
  if (to.accountId && !isMandatory(category)) {
    const a = to.accountId;
    if (job.kind === "thread") {
      const d = job.data;
      unsubscribe.push({ label: "Mute this thread", url: await unsubUrl(env, { accountId: a, scope: { t: "thread", repoId: d.repoId, number: d.number, repo: d.repo } }) });
      if (job.reason === "subscribed") unsubscribe.push({ label: `Stop watching ${d.repo}`, url: await unsubUrl(env, { accountId: a, scope: { t: "repo", repoId: d.repoId, repo: d.repo } }) });
    }
    if (category !== "security" && category !== "account") {
      oneClick = await unsubUrl(env, { accountId: a, scope: { t: "category", category } });
      unsubscribe.push({ label: "Unsubscribe from emails like this", url: oneClick });
    }
  }
  const ctx: RenderCtx = { publicUrl: pub, login: to.login, reason: job.reason, unsubscribe, settingsUrl: to.accountId ? `${pub}/settings/notifications` : undefined };
  const host = new URL(pub).hostname;
  const headers: Record<string, string> = {
    "Auto-Submitted": "auto-generated",
    "X-Diffinery-Reason": job.reason,
    "X-Diffinery-Kind": job.kind,
  };
  if (to.login) headers["X-Diffinery-Recipient"] = to.login;
  if (!isMandatory(category)) headers.Precedence = "list";
  if (email.thread) {
    const ref = `<${email.thread}@${host}>`;
    headers.References = ref;
    if (job.kind === "thread" && job.data.event !== "opened") headers["In-Reply-To"] = ref;
  }
  if (email.context) {
    const [owner, name] = email.context.label.includes("/") ? email.context.label.split("/") : [email.context.label, ""];
    headers["List-Id"] = `${clean(email.context.label)} <${name ? `${listIdLabel(name)}.` : ""}${listIdLabel(owner!)}.${host}>`;
    headers["X-Diffinery-Repository"] = email.context.label;
  }
  if (oneClick) {
    headers["List-Unsubscribe"] = `<${oneClick}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return {
    from: { name: email.fromName ? `${clean(email.fromName)} (Diffinery)` : "Diffinery", email: senderAddress(env) },
    to: to.name ? { name: clean(to.name), email: to.email } : to.email,
    subject: clean(email.subject).slice(0, 900),
    html: toHtml(email, ctx),
    text: toText(email, ctx),
    headers,
    ...(email.replyTo ? { replyTo: email.replyTo.name ? { name: clean(email.replyTo.name), email: email.replyTo.email } : email.replyTo.email } : {}),
  };
}

export interface DeliverOptions {
  /**
   * Send even to a suppressed address. Only for the verification email the address's owner
   * asks for on Settings → Email (suppression.ts); never set on queued jobs.
   */
  ignoreSuppression?: boolean;
}

/** Send one job now: resolve the recipient, apply their settings and the suppression list, render and send. */
export async function deliver(env: Env, job: MailJob, opts: DeliverOptions = {}): Promise<{ status: "sent" | "skipped" | "failed"; detail?: string; messageId?: string }> {
  const dir = new Directory(env);
  const store = new MailStore(env.DB);
  const category = categoryOf(job);
  let to: { email: string; name?: string; login?: string; accountId?: string };
  let account: Account | null = null;
  if ("accountId" in job.to) {
    const accountId = job.to.accountId;
    const a = await dir.account(accountId);
    const skip = async (detail: string) => {
      await store.log({ account_id: accountId, to_addr: a?.email ?? "", kind: job.kind, subject: "", status: "skipped", detail, message_id: null, dev_copy: null });
      return { status: "skipped" as const, detail };
    };
    if (!a) return skip("no such account");
    if (a.kind !== "user") return skip(`${a.kind} accounts have no email`);
    if (!a.email) return skip("no email address");
    if (a.status === "disabled" && job.kind !== "account_status") return skip("account disabled");
    if (!job.force && !isMandatory(category) && !wantsEmail(await store.prefs(a.id), category)) return skip(`turned off ${category} emails`);
    to = { email: a.email, name: a.name || undefined, login: a.login, accountId: a.id };
    account = a;
  } else {
    to = { email: job.to.email, name: job.to.name };
  }
  if (!opts.ignoreSuppression) {
    const s = await new Suppressions(env.DB).get(to.email);
    if (s) {
      const detail = `address is suppressed: ${REASON_TEXT[s.reason]}`;
      await store.log({ account_id: to.accountId ?? null, to_addr: to.email, kind: job.kind, subject: "", status: "skipped", detail, message_id: null, dev_copy: null });
      return { status: "skipped", detail };
    }
  }

  // The morning digest is gathered now, as it is sent (agentic/digest.ts), and a scheduled one with nothing in it isn't sent.
  if (job.kind === "digest" && !job.data.summary) {
    if (!account) return { status: "skipped", detail: "a digest needs an account" };
    const { gatherDigest } = await import("../agentic/digest.js");
    const summary = await gatherDigest(env, dir, account, job.data.since, (await store.prefs(account.id)).digest.timeZone);
    if (!summary.sections.length && !job.data.now) {
      const detail = "nothing to report since the last digest";
      await store.log({ account_id: account.id, to_addr: to.email, kind: job.kind, subject: "", status: "skipped", detail, message_id: null, dev_copy: null });
      return { status: "skipped", detail };
    }
    job = { ...job, data: { ...job.data, summary } };
  }

  const msg = await buildMessage(env, job, to);
  const devCopy = devAuth(env) ? JSON.stringify(msg) : null;
  const base = { account_id: to.accountId ?? null, to_addr: to.email, kind: job.kind, subject: msg.subject, dev_copy: devCopy };
  const transport = mailTransport(env);
  if (!transport) {
    await store.log({ ...base, status: "skipped", detail: "email sending is not configured (no EMAIL binding or SMTP_URL)", message_id: null });
    return { status: "skipped", detail: "no EMAIL binding or SMTP_URL" };
  }
  let res: { messageId?: string };
  try {
    if (transport.kind === "email-sending") res = await transport.binding.send(msg);
    else if ("error" in transport) throw new SmtpError("E_SMTP_CONFIG", transport.error);
    else res = await sendSmtp(transport.config, msg, { ehlo: new URL(env.PUBLIC_URL).hostname });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    const detail = `${code ? `${code}: ` : ""}${(e as Error).message ?? String(e)}`;
    if (RETRYABLE.has(code)) throw new RetryableMailError(detail);
    // A permanent failure for this recipient (it's on Cloudflare's suppression list, or the SMTP server has no such mailbox) puts it on ours.
    const s = sendSuppression(to.email, { error: e });
    if (s) await suppressFromSend(env, s);
    await store.log({ ...base, status: "failed", detail, message_id: null });
    console.error("email failed", job.kind, to.email, detail);
    return { status: "failed", detail };
  }
  const bounced = sendSuppression(to.email, { result: res });
  if (bounced) {
    await suppressFromSend(env, bounced);
    const detail = bounced.detail ?? "permanent bounce";
    await store.log({ ...base, status: "failed", detail, message_id: res.messageId ?? null });
    return { status: "failed", detail, messageId: res.messageId };
  }
  await store.log({ ...base, status: "sent", detail: null, message_id: res.messageId ?? null });
  return { status: "sent", messageId: res.messageId };
}

/** Suppress an address Email Sending or the SMTP server refused for good (source `send`), audited like any other addition. Never throws. */
async function suppressFromSend(env: Env, s: NonNullable<ReturnType<typeof sendSuppression>>): Promise<void> {
  try {
    await new Suppressions(env.DB).add({ ...s, source: "send" });
    await new Directory(env).audit({ action: "email.suppression.add", target: s.email, detail: { reason: s.reason, source: "send", detail: s.detail } });
  } catch (e) {
    console.error("could not suppress", s.email, e);
  }
}

/** Queue consumer for `diffinery-mail`. */
export async function mailQueue(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await deliver(env, msg.body);
      msg.ack();
    } catch (e) {
      console.error("email delivery error", msg.body.kind, e);
      if (msg.attempts >= 6) {
        await new MailStore(env.DB)
          .log({ account_id: "accountId" in msg.body.to ? msg.body.to.accountId : null, to_addr: "email" in msg.body.to ? msg.body.to.email : "", kind: msg.body.kind, subject: "", status: "failed", detail: `gave up after ${msg.attempts} attempts: ${(e as Error).message}`, message_id: null, dev_copy: null })
          .catch(() => {});
        msg.ack();
      } else msg.retry({ delaySeconds: Math.min(600, 15 * 2 ** msg.attempts) });
    }
  }
}
