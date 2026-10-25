/**
 * Email templates. Each email is a list of blocks rendered twice: as HTML
 * (table layout and inline styles that hold up in Gmail, Outlook and Apple
 * Mail, light and dark) and as plain text. The look follows the site: Kumo's
 * neutral palette, blue for actions and the orange mark.
 */
import { escapeHtml, renderMarkdown, stripHtmlComments } from "../web/markdown.js";
import type { DigestData, MailJob, Reason, RunData, ThreadData } from "./types.js";

export type Inline = string | { b: string } | { a: string; href: string } | { code: string };

export type Block =
  | { p: Inline[]; muted?: boolean }
  | { md: string; base?: { owner: string; repo: string; ref: string } }
  | { kv: Array<[string, Inline[] | string]> }
  | { button: { label: string; url: string }; secondary?: { label: string; url: string } }
  | { callout: Inline[]; tone: "info" | "warn" | "danger" }
  | { code: string }
  | { items: Array<{ mark: "ok" | "fail" | "skip" | "dot"; text: Inline[]; url?: string }> }
  | { quote: Inline[] };

export interface Email {
  subject: string;
  /** Hidden preview line shown by mail clients next to the subject. */
  preheader: string;
  /** Small label above the title (e.g. "Security", "Pull request"). */
  eyebrow?: { text: string; tone: "neutral" | "blue" | "green" | "red" | "amber" | "purple" };
  title: Inline[];
  blocks: Block[];
  /** Display name on the From address, e.g. the person who commented. */
  fromName?: string;
  /** Repository the email is about, shown next to the logo and used for List-Id. */
  context?: { label: string; url: string };
  /** Thread id for In-Reply-To / References, e.g. "owner/repo/issues/12". */
  thread?: string;
  /** Main link (also "View it on Diffinery" in the footer). */
  url?: string;
}

export interface RenderCtx {
  publicUrl: string;
  /** The recipient's login, when they have an account. */
  login?: string;
  reason: Reason;
  /** Footer links: unsubscribe (thread, watch or settings group) and settings. */
  unsubscribe?: Array<{ label: string; url: string }>;
  settingsUrl?: string;
}

// ---------------------------------------------------------------- palette (Kumo, as hex for mail clients)

const C = {
  canvas: "#f4f4f5",
  card: "#ffffff",
  border: "#e4e4e7",
  fg: "#18181b",
  fg2: "#52525b",
  fg3: "#71717a",
  accent: "#1447e6",
  brand: "#f6821f",
  codeBg: "#f4f4f5",
  tones: {
    neutral: ["#f4f4f5", "#3f3f46"],
    blue: ["#e6edfd", "#1447e6"],
    green: ["#e3f6ec", "#007a55"],
    red: ["#fdecec", "#c10007"],
    amber: ["#fdf3dc", "#a65f00"],
    purple: ["#f3e8ff", "#8200db"],
  } as Record<string, [string, string]>,
};
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace`;

// ---------------------------------------------------------------- rendering

const esc = escapeHtml;

function inlineHtml(parts: Inline[] | string): string {
  const list = typeof parts === "string" ? [parts] : parts;
  return list
    .map((x) => {
      if (typeof x === "string") return esc(x);
      if ("b" in x) return `<strong style="font-weight:600">${esc(x.b)}</strong>`;
      if ("code" in x) return `<code class="code" style="font-family:${MONO};font-size:12.5px;background:${C.codeBg};border-radius:4px;padding:1px 5px">${esc(x.code)}</code>`;
      return `<a href="${esc(x.href)}" style="color:${C.accent};text-decoration:none">${esc(x.a)}</a>`;
    })
    .join("");
}

function inlineText(parts: Inline[] | string): string {
  const list = typeof parts === "string" ? [parts] : parts;
  return list.map((x) => (typeof x === "string" ? x : "b" in x ? x.b : "code" in x ? `\`${x.code}\`` : `${x.a} (${x.href})`)).join("");
}

/** Markdown from issues and comments, with relative links made absolute. */
function markdownHtml(md: string, publicUrl: string, base?: { owner: string; repo: string; ref: string }): string {
  const html = renderMarkdown(md.length > 20_000 ? `${md.slice(0, 20_000)}\n\n…` : md, base ? { base: { ...base, dir: "" } } : {});
  const abs = html.replace(/(href|src)="\/(?!\/)/g, `$1="${publicUrl}/`).replace(/href="#/g, `href="${publicUrl}/#`);
  // Images from other hosts become links: an email that loads them would tell whoever wrote the comment when and where it was read.
  return abs.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\ssrc="([^"]*)"/i.exec(tag)?.[1] ?? "";
    if (src.startsWith(`${publicUrl}/`)) return tag;
    const alt = /\salt="([^"]*)"/i.exec(tag)?.[1] || "image";
    return src ? `<a href="${src}">[${alt}]</a>` : "";
  });
}

function blockHtml(b: Block, ctx: RenderCtx): string {
  const P = `margin:0 0 14px;font-size:15px;line-height:1.6;color:${C.fg}`;
  if ("p" in b) return `<p class="${b.muted ? "muted" : "fg"}" style="${P}${b.muted ? `;color:${C.fg3};font-size:13px` : ""}">${inlineHtml(b.p)}</p>`;
  if ("md" in b)
    return `<div class="md box" style="margin:0 0 16px;padding:14px 16px;border:1px solid ${C.border};border-radius:8px;font-size:14px;line-height:1.6;color:${C.fg};overflow-wrap:anywhere">${markdownHtml(b.md, ctx.publicUrl, b.base) || `<span style="color:${C.fg3}">No description provided.</span>`}</div>`;
  if ("kv" in b)
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="box" style="margin:0 0 16px;border:1px solid ${C.border};border-radius:8px;border-collapse:separate">${b.kv
      .map(
        ([k, v], i) =>
          `<tr><td class="muted" style="padding:9px 14px;${i ? `border-top:1px solid ${C.border};` : ""}font-size:13px;color:${C.fg3};width:130px;vertical-align:top">${esc(k)}</td><td class="fg" style="padding:9px 14px;${i ? `border-top:1px solid ${C.border};` : ""}font-size:13px;color:${C.fg};overflow-wrap:anywhere">${inlineHtml(v)}</td></tr>`,
      )
      .join("")}</table>`;
  if ("button" in b) {
    const btn = (l: { label: string; url: string }, primary: boolean) =>
      `<a href="${esc(l.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;${primary ? `background:${C.accent};color:#ffffff;border:1px solid ${C.accent}` : `background:${C.card};color:${C.fg};border:1px solid ${C.border}`}" class="${primary ? "" : "btn2"}">${esc(l.label)}</a>`;
    return `<p style="margin:6px 0 18px">${btn(b.button, true)}${b.secondary ? `&nbsp;&nbsp;${btn(b.secondary, false)}` : ""}</p>`;
  }
  if ("callout" in b) {
    const [bg, fg] = C.tones[b.tone === "info" ? "blue" : b.tone === "warn" ? "amber" : "red"]!;
    return `<div style="margin:0 0 16px;padding:12px 14px;border-radius:8px;background:${bg};color:${fg};font-size:13.5px;line-height:1.55">${inlineHtml(b.callout)}</div>`;
  }
  if ("code" in b)
    return `<pre class="md" style="margin:0 0 16px;padding:12px 14px;border-radius:8px;background:${C.codeBg};font-family:${MONO};font-size:12.5px;line-height:1.55;color:${C.fg};white-space:pre-wrap;overflow-wrap:anywhere">${esc(b.code)}</pre>`;
  if ("quote" in b) return `<div class="muted" style="margin:0 0 16px;padding:2px 0 2px 14px;border-left:3px solid ${C.border};color:${C.fg2};font-size:14px;line-height:1.6">${inlineHtml(b.quote)}</div>`;
  const marks = { ok: ["✓", C.tones.green![1]], fail: ["✕", C.tones.red![1]], skip: ["–", C.fg3], dot: ["•", C.fg3] } as const;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="box" style="margin:0 0 16px;border:1px solid ${C.border};border-radius:8px;border-collapse:separate">${b.items
    .map(
      (it, i) =>
        `<tr><td style="padding:8px 0 8px 14px;${i ? `border-top:1px solid ${C.border};` : ""}width:18px;font-size:14px;font-weight:700;color:${marks[it.mark][1]};vertical-align:top">${marks[it.mark][0]}</td><td class="fg" style="padding:8px 14px 8px 8px;${i ? `border-top:1px solid ${C.border};` : ""}font-size:13.5px;color:${C.fg};overflow-wrap:anywhere">${it.url ? `<a href="${esc(it.url)}" style="color:${C.fg};text-decoration:none">${inlineHtml(it.text)}</a>` : inlineHtml(it.text)}</td></tr>`,
    )
    .join("")}</table>`;
}

function blockText(b: Block): string {
  if ("p" in b) return inlineText(b.p);
  if ("md" in b) return (stripHtmlComments(b.md).trim() || "No description provided.").split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
  if ("kv" in b) return b.kv.map(([k, v]) => `${k}: ${inlineText(v)}`).join("\n");
  if ("button" in b) return `${b.button.label}: ${b.button.url}${b.secondary ? `\n${b.secondary.label}: ${b.secondary.url}` : ""}`;
  if ("callout" in b) return `! ${inlineText(b.callout)}`;
  if ("code" in b) return b.code.split("\n").map((l) => `    ${l}`).join("\n");
  if ("quote" in b) return `> ${inlineText(b.quote)}`;
  const marks = { ok: "[ok]", fail: "[failed]", skip: "[skipped]", dot: "-" };
  return b.items.map((it) => `${marks[it.mark]} ${inlineText(it.text)}${it.url ? ` <${it.url}>` : ""}`).join("\n");
}

export const REASON_TEXT: Record<Reason, string> = {
  author: "You are receiving this because you opened this thread.",
  comment: "You are receiving this because you commented.",
  mention: "You are receiving this because you were mentioned.",
  assign: "You are receiving this because you were assigned.",
  review_requested: "You are receiving this because your review was requested.",
  manual: "You are receiving this because you subscribed to this thread.",
  state_change: "You are receiving this because you changed this thread's state.",
  subscribed: "You are receiving this because you are watching this repository.",
  ci_activity: "You are receiving this because this workflow run was triggered by you, or you watch this repository.",
  security_alert: "This is a security notice about your Diffinery account. These can't be turned off.",
  your_activity: "You are receiving this because of something you did on Diffinery.",
  invitation: "You are receiving this because someone invited this email address to Diffinery. If you weren't expecting it, you can ignore this email.",
  admin: "You are receiving this because you are an administrator.",
  account: "You are receiving this because you have a Diffinery account.",
  signup: "You are receiving this because someone asked to create a Diffinery account with this email address. If it wasn't you, you can ignore this email.",
  early_access: "You are receiving this because someone asked for early access to Diffinery with this email address. If it wasn't you, you can ignore this email.",
  digest: "You are receiving this because you turned on the morning digest in your notification settings.",
};

const LOGO = (url: string) => `${url}/icon-512.png`;

/** Full HTML document. */
export function toHtml(e: Email, ctx: RenderCtx): string {
  const tone = e.eyebrow ? C.tones[e.eyebrow.tone]! : null;
  const footerLinks = [
    ...(e.url ? [{ label: "View it on Diffinery", url: e.url }] : []),
    ...(ctx.unsubscribe ?? []),
    ...(ctx.settingsUrl ? [{ label: "Notification settings", url: ctx.settingsUrl }] : []),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(e.subject)}</title>
<style>
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
.md p{margin:0 0 10px}.md p:last-child{margin-bottom:0}
.md pre{background:${C.codeBg};padding:10px 12px;border-radius:6px;overflow:auto;font-family:${MONO};font-size:12.5px;line-height:1.5;white-space:pre-wrap}
.md code{background:${C.codeBg};border-radius:4px;padding:1px 4px;font-family:${MONO};font-size:12.5px}
.md pre code{padding:0;background:none}
.md blockquote{margin:0 0 10px;padding:0 12px;border-left:3px solid ${C.border};color:${C.fg3}}
.md table{border-collapse:collapse;margin:0 0 10px}.md td,.md th{border:1px solid ${C.border};padding:4px 8px}
.md img{max-width:100%;height:auto}.md a{color:${C.accent}}.md h1,.md h2,.md h3{font-size:16px;margin:12px 0 8px}
.md ul,.md ol{padding-left:22px;margin:0 0 10px}
@media (prefers-color-scheme:dark){
.bg{background:#0a0a0a !important}.card{background:#171717 !important;border-color:#2e2e2e !important}
.fg,.fg a,h1.fg{color:#f4f4f5 !important}.muted{color:#a3a3a3 !important}.box{border-color:#2e2e2e !important}
.box td{border-color:#2e2e2e !important}.md,.md td,.md th{color:#e4e4e7 !important}.md pre,.md code,pre.md,code.code{background:#262626 !important;color:#f4f4f5 !important}
.btn2{background:#262626 !important;color:#f4f4f5 !important;border-color:#3f3f46 !important}}
@media (max-width:620px){.card{border-radius:0 !important;padding:22px 18px !important}.outer{padding:0 !important}}
</style></head>
<body class="bg" style="margin:0;padding:0;background:${C.canvas}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(e.preheader)}${"&#8199;&#65279;&#847; ".repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${C.canvas};font-family:${FONT}">
<tr><td align="center" class="outer" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:0 4px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle"><a href="${esc(ctx.publicUrl)}" style="text-decoration:none"><img src="${esc(LOGO(ctx.publicUrl))}" width="26" height="26" alt="" style="vertical-align:middle;border:0;border-radius:6px"> <span class="fg" style="vertical-align:middle;font-size:16px;font-weight:650;color:${C.fg};letter-spacing:-.01em">Diffinery</span></a></td>
${e.context ? `<td align="right" style="vertical-align:middle;font-size:13px"><a href="${esc(e.context.url)}" class="muted" style="color:${C.fg3};text-decoration:none">${esc(e.context.label)}</a></td>` : ""}
</tr></table>
</td></tr>
<tr><td class="card" style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:28px 32px">
${e.eyebrow && tone ? `<div style="margin:0 0 12px"><span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${tone[0]};color:${tone[1]};font-size:12px;font-weight:600">${esc(e.eyebrow.text)}</span></div>` : ""}
<h1 class="fg" style="margin:0 0 16px;font-size:20px;line-height:1.35;font-weight:650;color:${C.fg};letter-spacing:-.01em">${inlineHtml(e.title)}</h1>
${e.blocks.map((b) => blockHtml(b, ctx)).join("\n")}
</td></tr>
<tr><td class="muted" style="padding:18px 8px 0;font-size:12px;line-height:1.6;color:${C.fg3}">
<p style="margin:0 0 6px">${esc(REASON_TEXT[ctx.reason])}</p>
${footerLinks.length ? `<p style="margin:0 0 6px">${footerLinks.map((l) => `<a href="${esc(l.url)}" style="color:${C.fg3};text-decoration:underline">${esc(l.label)}</a>`).join(" &middot; ")}</p>` : ""}
<p style="margin:0">Diffinery &middot; Code hosting and CI on Cloudflare &middot; <a href="${esc(ctx.publicUrl)}" style="color:${C.fg3}">${esc(new URL(ctx.publicUrl).host)}</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function toText(e: Email, ctx: RenderCtx): string {
  const lines = [inlineText(e.title), "", ...e.blocks.map(blockText).flatMap((t) => [t, ""])];
  lines.push("--", REASON_TEXT[ctx.reason]);
  if (e.url) lines.push(`View it on Diffinery: ${e.url}`);
  for (const u of ctx.unsubscribe ?? []) lines.push(`${u.label}: ${u.url}`);
  if (ctx.settingsUrl) lines.push(`Notification settings: ${ctx.settingsUrl}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------- the emails

const at = (iso: string) => new Date(iso).toUTCString().replace("GMT", "UTC");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });
const user = (login: string) => `@${login}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ROLE_TEXT: Record<string, string> = { read: "read", triage: "triage", write: "write", maintain: "maintain", admin: "admin", member: "member", owner: "owner" };
const roleText = (r: string) => ROLE_TEXT[r] ?? r;
const mib = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** The domain email is sent from: MAIL_FROM's, else PUBLIC_URL's host. */
function mailDomain(pub: string, mailFrom?: string): string {
  const at = mailFrom?.lastIndexOf("@") ?? -1;
  if (mailFrom && at >= 0) return mailFrom.slice(at + 1).replace(/>.*$/, "").trim();
  try {
    return new URL(pub).hostname;
  } catch {
    return pub;
  }
}

function repoContext(pub: string, repo: string) {
  return { label: repo, url: `${pub}/${repo}` };
}

function threadEmail(d: ThreadData, pub: string, login?: string): Email {
  const isPull = d.kind === "pull";
  const noun = isPull ? "pull request" : "issue";
  const tag = `${isPull ? "PR" : "Issue"} #${d.number}`;
  const threadUrl = `${pub}/${d.repo}/${isPull ? "pull" : "issues"}/${d.number}`;
  const [owner, name] = d.repo.split("/") as [string, string];
  const mdBase = { owner, repo: name, ref: d.base ?? "HEAD" };
  const subject = `${d.event === "opened" ? "" : "Re: "}[${d.repo}] ${d.title} (${tag})`;
  const me = (l: string) => !!login && l.toLowerCase() === login.toLowerCase();
  let title: Inline[];
  let eyebrow: Email["eyebrow"] = { text: isPull ? "Pull request" : "Issue", tone: isPull ? "purple" : "green" };
  const blocks: Block[] = [];
  const ref: Inline = { a: `${d.repo}#${d.number}`, href: threadUrl };
  switch (d.event) {
    case "opened":
      title = isPull ? [user(d.actor), " wants to merge ", { code: d.head ?? "" }, " into ", { code: d.base ?? "" }] : [user(d.actor), " opened ", ref];
      blocks.push({ p: [{ b: d.title }] });
      if (isPull && d.intent) blocks.push({ callout: [{ b: "Intent: " }, d.intent], tone: "info" });
      blocks.push({ md: d.body ?? "", base: mdBase });
      if (d.commits?.length) blocks.push({ items: d.commits.slice(0, 10).map((c) => ({ mark: "dot" as const, text: [{ code: c.sha.slice(0, 7) }, " ", c.message.split("\n")[0]!.slice(0, 120)] })) });
      if (d.reviewers?.length) blocks.push({ p: ["Review requested from ", d.reviewers.map(user).join(", "), "."], muted: true });
      if (d.assignees?.length) blocks.push({ p: ["Assigned to ", d.assignees.map(user).join(", "), "."], muted: true });
      blocks.push({ button: { label: `View ${noun}`, url: threadUrl }, ...(isPull ? { secondary: { label: "Files changed", url: `${threadUrl}/files` } } : {}) });
      break;
    case "comment":
      title = [user(d.actor), " commented on ", ref];
      blocks.push({ md: d.body ?? "", base: mdBase }, { button: { label: "Reply on Diffinery", url: d.url } });
      break;
    case "review": {
      const s = d.state ?? "COMMENTED";
      title = s === "APPROVED" ? [user(d.actor), " approved ", ref] : s === "CHANGES_REQUESTED" ? [user(d.actor), " requested changes on ", ref] : [user(d.actor), " reviewed ", ref];
      eyebrow = s === "APPROVED" ? { text: "Approved", tone: "green" } : s === "CHANGES_REQUESTED" ? { text: "Changes requested", tone: "red" } : { text: "Review", tone: "purple" };
      if (d.body?.trim()) blocks.push({ md: d.body, base: mdBase });
      blocks.push({ button: { label: "View review", url: d.url }, secondary: { label: "Files changed", url: `${threadUrl}/files` } });
      break;
    }
    case "closed":
      title = [user(d.actor), " closed ", ref, d.stateReason === "not_planned" ? " as not planned" : isPull ? "" : " as completed"];
      eyebrow = { text: "Closed", tone: isPull ? "red" : "purple" };
      blocks.push({ p: [{ b: d.title }] }, { button: { label: `View ${noun}`, url: threadUrl } });
      break;
    case "merged":
      title = [user(d.actor), " merged ", ref, " into ", { code: d.base ?? "" }];
      eyebrow = { text: "Merged", tone: "purple" };
      blocks.push({ p: [{ b: d.title }] }, { button: { label: "View pull request", url: threadUrl } });
      break;
    case "reopened":
      title = [user(d.actor), " reopened ", ref];
      eyebrow = { text: "Reopened", tone: "green" };
      blocks.push({ p: [{ b: d.title }] }, { button: { label: `View ${noun}`, url: threadUrl } });
      break;
    case "assigned": {
      const who = d.assignees ?? [];
      title = who.some(me) ? [user(d.actor), " assigned you to ", ref] : [user(d.actor), " assigned ", who.map(user).join(", "), " to ", ref];
      blocks.push({ p: [{ b: d.title }] }, { button: { label: `View ${noun}`, url: threadUrl } });
      break;
    }
    case "review_requested": {
      const who = d.reviewers ?? [];
      title = who.some(me) ? [user(d.actor), " requested your review on ", ref] : [user(d.actor), " requested a review from ", who.map(user).join(", "), " on ", ref];
      eyebrow = { text: "Review requested", tone: "amber" };
      blocks.push({ p: [{ b: d.title }] });
      if (d.intent) blocks.push({ callout: [{ b: "Intent: " }, d.intent], tone: "info" });
      blocks.push({ button: { label: "Review changes", url: `${threadUrl}/files` }, secondary: { label: "View pull request", url: threadUrl } });
      break;
    }
    case "pushed": {
      const n = d.commits?.length ?? 0;
      title = [user(d.actor), ` pushed ${n ? plural(n, "commit") : "new commits"} to `, { code: d.head ?? "" }];
      blocks.push({ p: [ref, " ", { b: d.title }] });
      if (n) blocks.push({ items: d.commits!.slice(-10).map((c) => ({ mark: "dot" as const, text: [{ code: c.sha.slice(0, 7) }, " ", c.message.split("\n")[0]!.slice(0, 120)], url: `${pub}/${d.repo}/commit/${c.sha}` })) });
      blocks.push({ button: { label: "View changes", url: `${threadUrl}/files` } });
      break;
    }
  }
  return { subject, preheader: stripHtmlComments(d.body ?? "").trim().slice(0, 140) || `${inlineText(title)}`, eyebrow, title, blocks, fromName: d.actor, context: repoContext(pub, d.repo), thread: `${d.repo}/${isPull ? "pull" : "issues"}/${d.number}`, url: d.url };
}

function runEmail(d: RunData, pub: string): Email {
  const failed = d.conclusion === "failure" || d.conclusion === "timed_out";
  const sha = d.sha.slice(0, 7);
  const word = failed ? "failed" : d.conclusion === "success" ? "succeeded" : d.conclusion;
  return {
    subject: `[${d.repo}] Run ${word}: ${d.workflow} - ${d.branch} (${sha})`,
    preheader: `${d.workflow} #${d.runNumber} ${word} on ${d.branch}: ${d.title}`,
    eyebrow: failed ? { text: "Workflow run failed", tone: "red" } : { text: `Workflow run ${word}`, tone: d.conclusion === "success" ? "green" : "neutral" },
    title: [{ b: d.workflow }, ` #${d.runNumber} ${word} on `, { code: d.branch }],
    blocks: [
      {
        kv: [
          ["Repository", [{ a: d.repo, href: `${pub}/${d.repo}` }]],
          ["Commit", [{ a: sha, href: `${pub}/${d.repo}/commit/${d.sha}` }, " ", d.title]],
          ["Triggered by", `${d.event} by @${d.actor}`],
        ],
      },
      { items: d.jobs.slice(0, 20).map((j) => ({ mark: j.conclusion === "success" ? ("ok" as const) : j.conclusion === "failure" || j.conclusion === "timed_out" ? ("fail" as const) : ("skip" as const), text: [j.name, j.failure ? ` — ${j.failure.slice(0, 160)}` : j.conclusion && !["success", "failure", "skipped"].includes(j.conclusion) ? ` (${j.conclusion.replace(/_/g, " ")})` : ""], url: j.url })) },
      { button: { label: "View workflow run", url: d.url } },
    ],
    context: repoContext(pub, d.repo),
    url: d.url,
  };
}

/** Build the email for a job. `login` is the recipient's login when they have an account. */
/** `mailFrom`: the sender (MAIL_FROM), named in the test email; without it, PUBLIC_URL's host. */
export function compose(job: MailJob, pub: string, login?: string, mailFrom?: string): Email {
  const settings = `${pub}/settings/security`;
  const securityTip: Block = { callout: ["If this wasn't you, sign out of every other browser and remove any passkey or token you don't recognize under ", { a: "Passkeys and sessions", href: settings }, ", then tell a site administrator."], tone: "warn" };
  switch (job.kind) {
    case "thread":
      return threadEmail(job.data, pub, login);
    case "run":
      return runEmail(job.data, pub);
    case "signin_new": {
      const d = job.data;
      const how = d.method === "access" ? "email recovery" : d.method === "link" ? "a one-time sign-in link" : `the passkey “${d.passkey ?? "passkey"}”`;
      return {
        subject: "[Diffinery] New sign-in to your account",
        preheader: `Signed in with ${how} on ${d.device}.`,
        eyebrow: { text: "Security", tone: "red" },
        title: ["New sign-in to ", { b: user(login ?? "your account") }],
        blocks: [
          { p: [`Your Diffinery account was just signed in to from a browser or device it hasn't seen before, using ${how}.`] },
          { kv: [["When", at(job.at)], ["Device", d.device], ...(d.location ? ([["Location", d.location]] as Array<[string, string]>) : []), ...(d.ip ? ([["IP address", d.ip]] as Array<[string, string]>) : [])] },
          securityTip,
          { button: { label: "Review passkeys and sessions", url: settings } },
        ],
        url: settings,
      };
    }
    case "passkey_added":
      return {
        subject: "[Diffinery] A passkey was added to your account",
        preheader: `The passkey “${job.data.name}” can now sign in to your account.`,
        eyebrow: { text: "Security", tone: "red" },
        title: ["A passkey was added to your account"],
        blocks: [
          { p: ["The passkey ", { b: `“${job.data.name}”` }, job.data.via === "signin-link" ? " was added with a one-time sign-in link from an administrator." : " was added to your account.", " It can now sign you in."] },
          { kv: [["When", at(job.at)], ["Passkey", job.data.name]] },
          securityTip,
          { button: { label: "Review passkeys", url: settings } },
        ],
        url: settings,
      };
    case "passkey_removed":
      return {
        subject: "[Diffinery] A passkey was removed from your account",
        preheader: `The passkey “${job.data.name}” can no longer sign in.`,
        eyebrow: { text: "Security", tone: "red" },
        title: ["A passkey was removed from your account"],
        blocks: [{ p: ["The passkey ", { b: `“${job.data.name}”` }, " was removed and can no longer sign in. Browsers it signed in were signed out."] }, { kv: [["When", at(job.at)]] }, securityTip, { button: { label: "Review passkeys", url: settings } }],
        url: settings,
      };
    case "token_created": {
      const d = job.data;
      const page = d.agent ? `${pub}/settings/agents` : `${pub}/settings/tokens`;
      return {
        subject: d.agent ? `[Diffinery] A token was created for the agent ${d.agent}` : "[Diffinery] A personal access token was added to your account",
        preheader: `“${d.name}” with ${d.scopes.join(", ")} access.`,
        eyebrow: { text: "Security", tone: "red" },
        title: d.agent ? ["A token was created for ", { b: user(d.agent) }] : ["A personal access token was added to your account"],
        blocks: [
          { p: [d.agent ? "Anything holding this token can act as the agent, within its policy." : "Anything holding this token can use Git, the API, the CLI and MCP as you, within its scopes."] },
          { kv: [["Name", d.name], ["Scopes", d.scopes.join(", ")], ["When", at(job.at)]] },
          { callout: ["If you didn't create this token, revoke it now."], tone: "warn" },
          { button: { label: d.agent ? "Review agents" : "Review tokens", url: page } },
        ],
        url: page,
      };
    }
    case "token_expiring": {
      const d = job.data;
      const page = d.agent ? `${pub}/settings/agents` : `${pub}/settings/tokens`;
      return {
        subject: `[Diffinery] Your token “${d.name}” expires on ${day(d.expiresAt)}`,
        preheader: "Create a new token before then so Git, CI and agents keep working.",
        eyebrow: { text: "Token expiring", tone: "amber" },
        title: ["Your token ", { b: `“${d.name}”` }, ` expires on ${day(d.expiresAt)}`],
        blocks: [
          { p: [d.agent ? `The token for the agent @${d.agent}` : "This personal access token", " stops working then. Create a new one and swap it in wherever the old one is used (Git credentials, CI secrets, MCP clients)."] },
          { kv: [["Name", d.name], ["Starts with", [{ code: `${d.prefix}…` }]], ["Expires", at(d.expiresAt)]] },
          { button: { label: "Create a new token", url: page } },
        ],
        url: page,
      };
    }
    case "agent_created":
      return {
        subject: `[Diffinery] A new agent was added: ${job.data.agent}`,
        preheader: `The agent @${job.data.agent} can act on your behalf once it has a token.`,
        eyebrow: { text: "Security", tone: "red" },
        title: ["A new agent was added: ", { b: user(job.data.agent) }],
        blocks: [
          { p: ["Agents act on behalf of their owner, capped by their policy. They can't push to protected branches, and their pull requests need a human approval."] },
          { kv: [["Agent", user(job.data.agent)], ["When", at(job.at)]] },
          { callout: ["If you didn't add this agent, disable it now."], tone: "warn" },
          { button: { label: "Review agents", url: `${pub}/settings/agents` } },
        ],
        url: `${pub}/settings/agents`,
      };
    case "model_key_added": {
      const d = job.data;
      if (d.org) {
        const page = `${pub}/${d.org}?tab=settings#model-keys`;
        return {
          subject: `[Diffinery] An ${d.provider} API key was added to ${d.org}`,
          preheader: `Agents in ${d.org}'s repositories can now run on the organization's ${d.provider} key.`,
          eyebrow: { text: "Security", tone: "red" },
          title: [`An ${d.provider} API key was added to `, { b: d.org }],
          blocks: [
            { p: [`Agent runs that ${d.org}'s policy lets the organization pay for will use this key, and the provider bills the organization's account. Diffinery never shows the key again. You get this email because you're an owner of ${d.org}.`] },
            { kv: [["Organization", d.org], ["Provider", d.provider], ["Ends with", [{ code: `…${d.hint}` }]], ...(d.by ? ([["Added by", user(d.by)]] as Array<[string, string]>) : []), ["When", at(job.at)]] },
            { callout: ["If nobody in the organization added this key, delete it here and revoke it with the provider."], tone: "warn" },
            { button: { label: "Review the organization's model keys", url: page } },
          ],
          url: page,
        };
      }
      const page = `${pub}/settings/model-access`;
      return {
        subject: `[Diffinery] Your ${d.provider} API key was added to Diffinery`,
        preheader: `Agent tasks you start can now use your ${d.provider} key.`,
        eyebrow: { text: "Security", tone: "red" },
        title: [`Your ${d.provider} API key was added to Diffinery`],
        blocks: [
          { p: ["Agent tasks you start will use this key, and the provider bills your account for them. Diffinery never shows the key again."] },
          { kv: [["Provider", d.provider], ["Ends with", [{ code: `…${d.hint}` }]], ["When", at(job.at)]] },
          { callout: ["If you didn't add this key, delete it here and revoke it with the provider."], tone: "warn" },
          { button: { label: "Review model access", url: page } },
        ],
        url: page,
      };
    }
    case "review_limit_reached": {
      const d = job.data;
      const page = `${pub}/${d.repo}/settings/agent-review`;
      return {
        subject: `[${d.repo}] Agent review reached its daily limit`,
        preheader: `${d.limit} reviews ran with your model key in the last 24 hours, so new ones wait.`,
        eyebrow: { text: "Agent review", tone: "amber" },
        title: ["Agent review on ", { a: d.repo, href: `${pub}/${d.repo}` }, " reached its daily limit"],
        blocks: [
          { p: [`Agent reviews on this repository use your model key. ${d.limit} ran in the last 24 hours, the daily limit you set, so pull requests get an action-required check instead of a review until older reviews fall out of the 24 hours. Then reviews run again when someone asks or pushes.`] },
          { kv: [["Repository", d.repo], ["Daily limit", String(d.limit)], ["Last pull request", [{ a: `#${d.pr}`, href: `${pub}/${d.repo}/pull/${d.pr}` }]], ["When", at(job.at)]] },
          { callout: ["If this is more reviews than you expected, look at which pull requests ran them on the Tasks tab. Something may be pushing often, or asking for reviews."], tone: "warn" },
          { button: { label: "Agent review settings", url: page } },
        ],
        context: repoContext(pub, d.repo),
        url: page,
      };
    }
    case "deployment_review_requested": {
      const d = job.data;
      return {
        subject: `[${d.repo}] Deployment to ${d.environment} is waiting for your review`,
        preheader: `${d.requestor}'s ${d.workflow} run #${d.runNumber} on ${d.branch} waits for a required reviewer before it deploys to ${d.environment}.`,
        eyebrow: { text: "Deployment review", tone: "amber" },
        title: ["Deploy to ", { b: d.environment }, " in ", { a: d.repo, href: `${pub}/${d.repo}` }, "?"],
        blocks: [
          { p: [`You're a required reviewer for the ${d.environment} environment. Its jobs in this run wait, with no runner started and no secret handed out, until a reviewer approves or rejects them. One approval is enough.`] },
          { kv: [["Run", [{ a: `${d.workflow} #${d.runNumber}`, href: d.url }]], ["Title", d.title || d.workflow], ["Branch", [{ code: d.branch }]], ["Commit", [{ code: d.sha.slice(0, 12) }]], ["Started by", d.requestor], ["When", at(job.at)]] },
          { button: { label: "Review deployment", url: d.url } },
        ],
        context: repoContext(pub, d.repo),
        url: d.url,
      };
    }
    case "push_bypassed": {
      const d = job.data;
      return {
        subject: `[${d.repo}] Push protection was bypassed`,
        preheader: `@${d.pusher} pushed ${d.kinds.join(", ")} past push protection: ${d.reason}`,
        eyebrow: { text: "Push protection bypassed", tone: "amber" },
        title: [user(d.pusher), " pushed possible secrets to ", { a: d.repo, href: `${pub}/${d.repo}` }],
        blocks: [
          { p: ["Push protection found possible secrets, and a repository admin pushed anyway with a reason. The bypass is in the audit log."] },
          { kv: [["Pushed by", user(d.pusher)], ["Secrets", d.kinds.join(", ")], ["Reason", d.reason], ...(d.refs?.length ? ([["Refs", d.refs.join(", ")]] as Array<[string, string]>) : []), ["When", at(job.at)]] },
          { callout: ["If any of these are real credentials, rotate them now: removing them from Git history doesn't make them safe again."], tone: "danger" },
          { button: { label: "View repository", url: `${pub}/${d.repo}` } },
        ],
        context: repoContext(pub, d.repo),
        url: `${pub}/${d.repo}`,
      };
    }
    case "push_blocked": {
      const d = job.data;
      // A commit made without git (web editor, API or MCP) carries the files it was refused for.
      if (d.paths)
        return {
          subject: `[${d.repo}] Your commit was blocked: possible secrets`,
          preheader: `Found ${d.kinds.join(", ")}. Nothing was committed.`,
          eyebrow: { text: "Push protection", tone: "red" },
          title: ["Your commit to ", { a: d.repo, href: `${pub}/${d.repo}` }, " was blocked"],
          blocks: [
            { p: ["Push protection found what look like secrets in the files you tried to commit, so nothing was committed."] },
            { kv: [["Found", d.kinds.join(", ")], ...(d.paths.length ? ([["Files", d.paths.join(", ")]] as Array<[string, string]>) : []), ["When", at(job.at)]] },
            { p: ["Remove the secret and commit again. If it was a real credential, rotate it. For a test fixture, add a ", { code: "diffinery:allow-secret" }, " comment to the file."] },
          ],
          context: repoContext(pub, d.repo),
          url: `${pub}/${d.repo}`,
        };
      return {
        subject: `[${d.repo}] Your push was blocked: possible secrets`,
        preheader: `Found ${d.kinds.join(", ")}. Nothing from the push was kept.`,
        eyebrow: { text: "Push protection", tone: "red" },
        title: ["Your push to ", { a: d.repo, href: `${pub}/${d.repo}` }, " was blocked"],
        blocks: [
          { p: ["Push protection found what look like secrets in your commits, so nothing from this push was kept."] },
          { kv: [["Found", d.kinds.join(", ")], ...(d.refs?.length ? ([["Refs", d.refs.join(", ")]] as Array<[string, string]>) : []), ["When", at(job.at)]] },
          { p: ["Remove the secret from your commits (for example with ", { code: "git commit --amend" }, " or an interactive rebase) and push again. If it was a real credential, rotate it. For a test fixture, add a ", { code: "diffinery:allow-secret" }, " comment to the file. A repository admin can push past the check with ", { code: "git push -o allow-secrets=<reason>" }, ", which is audited."] },
        ],
        context: repoContext(pub, d.repo),
        url: `${pub}/${d.repo}`,
      };
    }
    case "account_status":
      if (job.data.status === "suspended")
        return {
          subject: "[Diffinery] Your account was suspended",
          preheader: "You can't sign in, and your tokens, agents and runners don't work while it lasts.",
          eyebrow: { text: "Account", tone: "red" },
          title: ["Your Diffinery account was suspended"],
          blocks: [
            { p: ["A site administrator suspended your account. While it is suspended you can't sign in, your access tokens, agents and runners don't work, and your repositories, profile and comments are hidden from other people."] },
            ...(job.data.reason ? [{ kv: [["Reason", job.data.reason]] as Array<[string, string]> }] : []),
            { p: ["If you think this is a mistake, contact an administrator of this Diffinery instance."], muted: true },
          ],
        };
      if (job.data.status === "unsuspended")
        return {
          subject: "[Diffinery] Your account is no longer suspended",
          preheader: "You can sign in again; your tokens work again.",
          eyebrow: { text: "Account", tone: "green" },
          title: ["Your Diffinery account is no longer suspended"],
          blocks: [{ p: ["A site administrator lifted the suspension of your account. Sign in with your passkey; your access tokens, agents and runners work again, and your repositories and comments are visible again."] }, { button: { label: "Sign in", url: `${pub}/login` } }],
          url: `${pub}/login`,
        };
      return job.data.status === "disabled"
        ? {
            subject: "[Diffinery] Your account was disabled",
            preheader: "You can't sign in, and your tokens were revoked.",
            eyebrow: { text: "Account", tone: "red" },
            title: ["Your Diffinery account was disabled"],
            blocks: [{ p: ["A site administrator disabled your account. You can't sign in, and every access token you had was revoked."] }, { p: ["If you think this is a mistake, contact an administrator of this Diffinery instance."], muted: true }],
          }
        : {
            subject: "[Diffinery] Your account was enabled",
            preheader: "You can sign in with your passkey again.",
            eyebrow: { text: "Account", tone: "green" },
            title: ["Your Diffinery account was enabled"],
            blocks: [{ p: ["A site administrator enabled your account again. Sign in with your passkey, and create new access tokens: the old ones were revoked when the account was disabled."] }, { button: { label: "Sign in", url: `${pub}/login` } }],
            url: `${pub}/login`,
          };
    case "account_deleted":
      return {
        subject: "[Diffinery] Your account was deleted",
        preheader: `@${job.data.login} and its repositories are gone.`,
        eyebrow: { text: "Account", tone: "red" },
        title: ["Your Diffinery account ", { b: user(job.data.login) }, " was deleted"],
        blocks: [
          { p: [job.data.by ? `A site administrator, ${user(job.data.by)}, deleted your account.` : "You deleted your account.", " Your repositories, container images, access tokens, passkeys and settings are gone, and every browser was signed out. Issues, pull requests and comments you wrote in other people's repositories stay, shown as written by ", { b: "ghost" }, "."] },
          { p: [`Your username can be used again, by anyone, ${job.data.cooldownDays} days from now. This is the last email you get from this Diffinery instance.`], muted: true },
        ],
      };
    case "site_admin":
      return job.data.granted
        ? {
            subject: "[Diffinery] You are now a site administrator",
            preheader: `${user(job.data.by)} made you a site administrator.`,
            eyebrow: { text: "Security", tone: "amber" },
            title: ["You are now a site administrator"],
            blocks: [
              { p: [user(job.data.by), " made you a site administrator of this Diffinery instance. You have admin on every repository and organization, and the Site administration pages in Settings."] },
              { button: { label: "Open Site administration", url: `${pub}/settings/admin` } },
              { callout: ["If you didn't expect this, tell another site administrator."], tone: "warn" },
            ],
            url: `${pub}/settings/admin`,
          }
        : {
            subject: "[Diffinery] You are no longer a site administrator",
            preheader: `${user(job.data.by)} removed your site administration.`,
            eyebrow: { text: "Security", tone: "amber" },
            title: ["You are no longer a site administrator"],
            blocks: [{ p: [user(job.data.by), " removed you from the site administrators of this Diffinery instance. Your own repositories and organizations are unchanged."] }],
          };
    case "export_ready":
      return {
        subject: "[Diffinery] Your account export is ready",
        preheader: `Download it before ${day(job.data.expiresAt)}.`,
        eyebrow: { text: "Account", tone: "green" },
        title: ["Your account export is ready"],
        blocks: [
          { p: [`The archive of your account (${mib(job.data.size)}) is ready: your profile and settings, your repositories as Git bundles, and the issues, pull requests and comments you wrote. Download it from Settings → Account before `, at(job.data.expiresAt), "."] },
          { button: { label: "Download your export", url: job.data.url } },
          { p: ["You'll be asked to sign in again before the download starts. If you didn't ask for an export, sign out your other browsers and tell a site administrator."], muted: true },
        ],
        url: job.data.url,
      };
    case "invite": {
      const d = job.data;
      const what = d.org ? `join the ${d.org} organization` : d.repo ? `collaborate on ${d.repo}` : "join Diffinery";
      return {
        subject: d.org ? `@${d.inviter} invited you to join the ${d.org} organization on Diffinery` : d.repo ? `@${d.inviter} invited you to collaborate on ${d.repo}` : `@${d.inviter} invited you to Diffinery`,
        preheader: d.existing ? `Accept or decline it in Diffinery by ${day(d.expiresAt)}.` : `Accept by ${day(d.expiresAt)}. You'll sign in with a passkey, no password needed.`,
        eyebrow: { text: "Invitation", tone: "blue" },
        title: [{ b: user(d.inviter) }, ` invited you to ${what}`],
        blocks: [
          { p: ["Diffinery is where the team keeps its code: Git repositories, pull requests, issues and GitHub Actions–compatible CI, with AI agents as first-class collaborators."] },
          { kv: [["Invited by", user(d.inviter)], ...(d.org ? ([["Organization", d.org]] as Array<[string, string]>) : []), ...(d.repo ? ([["Repository", d.repo]] as Array<[string, string]>) : []), ...(d.org || d.repo ? ([["Role", roleText(d.role)]] as Array<[string, string]>) : []), ["Expires", day(d.expiresAt)]] },
          { button: { label: d.existing ? "View invitation" : "Accept invitation", url: d.url } },
          d.existing
            ? { p: ["You'll have access once you accept. Sign in to accept or decline it; if you don't recognize this, decline it or let it expire."], muted: true }
            : { p: ["You'll pick a username and create a passkey with your fingerprint, face or screen lock. This invitation only works for this email address."], muted: true },
        ],
        url: d.url,
      };
    }
    case "invite_accepted": {
      const d = job.data;
      const where = d.org ? `the ${d.org} organization` : d.repo ? d.repo : "Diffinery";
      return {
        subject: `[Diffinery] @${d.login} accepted your invitation`,
        preheader: `${d.email || `@${d.login}`} joined ${where}.`,
        eyebrow: { text: "Invitation accepted", tone: "green" },
        title: [{ b: user(d.login) }, ` accepted your invitation to ${where}`],
        blocks: [{ kv: [["Username", user(d.login)], ...(d.email ? ([["Email", d.email]] as Array<[string, string]>) : [])] }, { button: { label: "View profile", url: `${pub}/${d.login}` } }],
        url: `${pub}/${d.login}`,
      };
    }
    case "welcome":
      return {
        subject: `Welcome to Diffinery, @${job.data.login}`,
        preheader: "Your account is ready. Here's how to get going.",
        eyebrow: { text: "Welcome", tone: "blue" },
        title: ["Welcome to Diffinery, ", { b: user(job.data.login) }],
        blocks: [
          { p: ["Your account is ready, and you sign in with the passkey you just created. A few things worth doing first:"] },
          {
            items: [
              { mark: "dot", text: [{ b: "Add a second passkey" }, " on another device, or keep it in a password manager that syncs."], url: `${pub}/settings/security` },
              { mark: "dot", text: [{ b: "Create an access token" }, " for Git over HTTPS, the CLI and MCP clients."], url: `${pub}/settings/tokens` },
              { mark: "dot", text: [{ b: "Create a repository" }, " or push an existing one. Workflows in .github/workflows run as they do on GitHub."], url: `${pub}/new` },
              { mark: "dot", text: [{ b: "Choose your notifications" }, ": which emails you get, and which repositories you watch."], url: `${pub}/settings/notifications` },
            ],
          },
          { button: { label: "Go to your dashboard", url: pub } },
        ],
        url: pub,
      };
    case "signin_link":
      return {
        subject: "[Diffinery] Your one-time sign-in link",
        preheader: `Add a new passkey before ${day(job.data.expiresAt)}.`,
        eyebrow: { text: "Account recovery", tone: "amber" },
        title: ["Add a new passkey to your account"],
        blocks: [
          { p: [user(job.data.admin), " created a one-time link so you can add a new passkey and sign in again. It works once and expires ", at(job.data.expiresAt), "."] },
          { button: { label: "Add a passkey", url: job.data.url } },
          { callout: ["Anyone with this link can add a passkey to your account. Don't forward this email. If you didn't ask for it, tell a site administrator."], tone: "warn" },
        ],
        url: job.data.url,
      };
    case "signup_code":
      return {
        // The code stays out of the subject, which the email log keeps.
        subject: "[Diffinery] Your sign-up code",
        preheader: `Your code is ${job.data.code}. It expires in 10 minutes.`,
        eyebrow: { text: "Sign-up", tone: "blue" },
        title: ["Confirm your email address"],
        blocks: [
          { p: ["Enter this code on the Diffinery sign-up page to confirm your email address. Then you pick a username and create a passkey."] },
          { code: job.data.code },
          { p: ["It works once and expires ", at(job.data.expiresAt), ". If you didn't ask to sign up, ignore this email: nothing happens without the code."], muted: true },
        ],
      };
    case "email_verify":
      return {
        subject: "[Diffinery] Confirm your email address to get email again",
        preheader: `Confirm before ${day(job.data.expiresAt)} and Diffinery emails you again.`,
        eyebrow: { text: "Account", tone: "blue" },
        title: ["Confirm your email address"],
        blocks: [
          { p: ["Diffinery stopped emailing ", { b: job.data.email }, " after a bounce or a spam report. You asked to get email here again: confirm that this inbox is yours and works."] },
          { button: { label: "Confirm and get email again", url: job.data.url } },
          { p: ["The link works while you're signed in to Diffinery as ", ...(login ? [{ b: user(login) }] : ["yourself"]), " and expires ", at(job.data.expiresAt), ". If you didn't ask for it, ignore this email: nothing changes."], muted: true },
        ],
        url: job.data.url,
      };
    case "signup_attempt":
      return {
        subject: "[Diffinery] Someone tried to sign up with your email address",
        preheader: "No new account was created. Sign in with your passkey instead.",
        eyebrow: { text: "Account", tone: "amber" },
        title: ["Someone tried to sign up with your email address"],
        blocks: [
          { p: ["Someone asked to create a new Diffinery account for ", { b: job.data.email }, ", which already belongs to your account", ...(login ? [" ", { b: user(login) }] : []), ". No account was created and no code was sent."] },
          { p: ["If it was you, sign in with your passkey. If you lost it, the sign-in page shows how to recover your account."] },
          { button: { label: "Sign in", url: `${pub}/login` } },
          { p: ["If it wasn't you, you can ignore this email: nobody can sign up with your address without reading your mail."], muted: true },
        ],
        url: `${pub}/login`,
      };
    case "early_access_confirm":
      return {
        subject: "[Diffinery] Confirm your early access request",
        preheader: `Confirm before ${day(job.data.expiresAt)} to join the list. Nothing happens without it.`,
        eyebrow: { text: "Early access", tone: "blue" },
        title: ["Confirm your early access request"],
        blocks: [
          { p: ["Thanks for asking for early access to Diffinery. Confirm that this is your email address and your request joins the list the team reviews."] },
          { button: { label: "Confirm my request", url: job.data.url } },
          { p: ["When there's a place for you, we'll email you an invitation to pick a username and create a passkey. There are no passwords."] },
          { p: ["The link works once and expires ", at(job.data.expiresAt), ". If you didn't ask for early access, ignore this email: nothing is kept unless the link is opened, and the unconfirmed request is deleted after a week."], muted: true },
        ],
        url: job.data.url,
      };
    case "early_access_remove":
      return {
        subject: "[Diffinery] Remove your early access request",
        preheader: `Remove it before ${day(job.data.expiresAt)}. Nothing changes unless you do.`,
        eyebrow: { text: "Early access", tone: "amber" },
        title: ["Remove your early access request"],
        blocks: [
          { p: ["Someone asked to remove the early access request for this email address. Open the link and press the button to delete it and everything stored about it."] },
          { button: { label: "Remove my request", url: job.data.url } },
          { p: ["The link works once and expires ", at(job.data.expiresAt), ". If you didn't ask for this, ignore this email: your request stays as it is."], muted: true },
        ],
        url: job.data.url,
      };
    case "early_access_known": {
      const d = job.data;
      if (d.variant === "account")
        return {
          subject: "[Diffinery] You already have a Diffinery account",
          preheader: "No request was needed. Sign in with your passkey instead.",
          eyebrow: { text: "Early access", tone: "blue" },
          title: ["You already have an account"],
          blocks: [
            { p: ["Someone asked for early access to Diffinery with this email address, which already belongs to your account", ...(login ? [" ", { b: user(login) }] : []), ". Nothing changed and no request was stored."] },
            { button: { label: "Sign in", url: `${pub}/login` } },
            { p: ["If you lost your passkey, the sign-in page shows how to recover your account. If it wasn't you, you can ignore this email."], muted: true },
          ],
          url: `${pub}/login`,
        };
      if (d.variant === "invited")
        return {
          subject: "[Diffinery] You're already invited",
          preheader: `We sent your invitation on ${day(d.since)}. Look for it in this inbox.`,
          eyebrow: { text: "Early access", tone: "green" },
          title: ["You're already invited"],
          blocks: [
            { p: ["You asked for early access again, but we already sent this address an invitation on ", { b: day(d.since) }, ". Look for an email titled \"invited you to Diffinery\", and check your spam folder too."] },
            { p: ["Opening its link lets you pick a username and create a passkey. Invitations expire after 14 days; if yours has, let the person named in it know and they can send a new one."], muted: true },
          ],
        };
      return {
        subject: "[Diffinery] We already have your early access request",
        preheader: "There's nothing else to do. We'll email you when there's a place.",
        eyebrow: { text: "Early access", tone: "blue" },
        title: ["We already have your request"],
        blocks: [
          { p: ["You asked for early access to Diffinery again. Your request from ", { b: day(d.since) }, " is already on the list, so there's nothing else to do."] },
          { p: ["When there's a place for you, we'll email you an invitation to pick a username and create a passkey."] },
          { p: ["If it wasn't you who asked again, you can ignore this email."], muted: true },
        ],
      };
    }
    case "access_request":
      return {
        subject: `[Diffinery] ${job.data.email} asked for access`,
        preheader: job.data.note ? job.data.note.slice(0, 140) : `@${job.data.login} is waiting for an invite.`,
        eyebrow: { text: "Access request", tone: "blue" },
        title: [{ b: job.data.email }, " asked for access to Diffinery"],
        blocks: [
          { kv: [["Username", user(job.data.login)], ["Email", job.data.email], ["When", at(job.at)]] },
          ...(job.data.note ? [{ quote: [job.data.note] } as Block] : []),
          { button: { label: "Review access requests", url: `${pub}/settings/admin` } },
        ],
        url: `${pub}/settings/admin`,
      };
    case "security_report": {
      // Only the summary: the details stay in Diffinery, behind a site administrator's sign-in.
      const url = `${pub}/settings/admin/security-reports/${job.data.id}`;
      return {
        subject: "[Diffinery] New security report",
        preheader: "Someone reported a security problem. Read it in Site administration.",
        eyebrow: { text: "Security report", tone: "red" },
        title: ["New security report"],
        blocks: [
          { p: ["Someone sent a private security report through ", { a: "/security/report", href: `${pub}/security/report` }, ". Its summary, as the reporter wrote it:"] },
          { quote: [job.data.summary] },
          { button: { label: "Read the report", url } },
          { p: ["The details are only in Site administration → Security reports. Reply to the reporter from your own mailbox, and don't forward this email beyond the people who handle security."], muted: true },
        ],
        url,
      };
    }
    case "org_membership": {
      const d = job.data;
      const url = `${pub}/${d.org}`;
      const title: Inline[] = !d.role ? ["You were removed from the ", { b: d.org }, " organization"] : d.previous ? ["Your role in ", { b: d.org }, ` changed to ${roleText(d.role)}`] : ["You're now ", article(roleText(d.role)), " ", roleText(d.role), " of ", { b: d.org }];
      return {
        subject: `[Diffinery] ${inlineText(title)}`,
        preheader: d.role ? `You can see ${d.org}'s repositories according to your role.` : `You no longer have access to ${d.org}'s private repositories.`,
        eyebrow: { text: "Organization", tone: d.role ? "blue" : "neutral" },
        title,
        blocks: [
          { kv: [["Organization", d.org], ["Role", d.role ? roleText(d.role) : "none"], ...(d.previous ? ([["Previously", roleText(d.previous)]] as Array<[string, string]>) : []), ...(d.by ? ([[d.role && !d.previous ? "Added by" : "Changed by", d.by]] as Array<[string, string]>) : [])] },
          ...(d.role ? [{ button: { label: `Open ${d.org}`, url } } as Block] : []),
        ],
        context: { label: d.org, url },
        url: d.role ? url : undefined,
      };
    }
    case "repo_access": {
      const d = job.data;
      const url = `${pub}/${d.repo}`;
      const title: Inline[] = d.role ? (d.previous ? ["Your access to ", { b: d.repo }, ` changed to ${roleText(d.role)}`] : ["You now have ", roleText(d.role), " access to ", { b: d.repo }]) : ["Your access to ", { b: d.repo }, " was removed"];
      return {
        subject: `[${d.repo}] ${inlineText(title)}`,
        preheader: d.role ? `Open ${d.repo} on Diffinery.` : "You can no longer see it unless it's public.",
        eyebrow: { text: "Repository access", tone: d.role ? "blue" : "neutral" },
        title,
        blocks: [{ kv: [["Repository", d.repo], ["Role", d.role ? roleText(d.role) : "none"], ...(d.previous ? ([["Previously", roleText(d.previous)]] as Array<[string, string]>) : [])] }, ...(d.role ? [{ button: { label: "Open repository", url } } as Block] : [])],
        context: repoContext(pub, d.repo),
        url: d.role ? url : undefined,
      };
    }
    case "repo_created": {
      const d = job.data;
      const url = `${pub}/${d.repo}`;
      const mine = job.reason === "your_activity";
      return {
        subject: `[${d.repo}] New ${d.visibility} repository`,
        preheader: mine ? `Push your code to ${url}.git` : `@${d.creator} created ${d.repo}.`,
        eyebrow: { text: "New repository", tone: "green" },
        title: mine ? ["Your repository ", { b: d.repo }, " is ready"] : [user(d.creator), " created ", { b: d.repo }],
        blocks: [
          ...(d.description ? [{ p: [d.description] } as Block] : []),
          { kv: [["Repository", [{ a: d.repo, href: url }]], ["Visibility", d.visibility], ["Default branch", d.defaultBranch], ["Created by", user(d.creator)]] },
          ...(mine
            ? [
                { p: ["Push an existing repository from the command line:"] } as Block,
                { code: `git remote add origin ${url}.git\ngit push -u origin ${d.defaultBranch}` } as Block,
                { p: ["Use an ", { a: "access token", href: `${pub}/settings/tokens` }, " as the password. Workflows in .github/workflows start running on the first push."], muted: true } as Block,
              ]
            : []),
          { button: { label: "Open repository", url } },
        ],
        context: repoContext(pub, d.repo),
        url,
      };
    }
    case "repo_deleted":
      return {
        subject: `[${job.data.repo}] Repository deleted`,
        preheader: `@${job.data.actor} deleted ${job.data.repo}.`,
        eyebrow: { text: "Repository deleted", tone: "red" },
        title: [user(job.data.actor), " deleted ", { b: job.data.repo }],
        blocks: [{ p: ["The repository, its issues, pull requests, workflow runs and settings are gone."] }, { kv: [["Repository", job.data.repo], ["Deleted by", user(job.data.actor)], ["When", at(job.at)]] }],
      };
    case "repo_transferred": {
      const d = job.data;
      const url = `${pub}/${d.to}`;
      return {
        subject: `[${d.to}] Repository transferred from ${d.from}`,
        preheader: `@${d.actor} moved ${d.from} to ${d.to}.`,
        eyebrow: { text: "Repository transferred", tone: "blue" },
        title: [user(d.actor), " transferred ", { b: d.from }, " to ", { b: d.to }],
        blocks: [
          { p: ["Its history, issues, pull requests, workflow runs, secrets and settings moved with it. Links, clones and API calls that use the old name keep working for people who can still read it; update your remotes when you can:"] },
          { code: `git remote set-url origin ${url}.git` },
          { kv: [["From", d.from], ["To", [{ a: d.to, href: url }]], ["Transferred by", user(d.actor)], ["When", at(job.at)]] },
          { button: { label: "Open repository", url } },
        ],
        context: repoContext(pub, d.to),
        url,
      };
    }
    case "digest":
      return digestEmail(job.data, pub);
    case "test":
      return {
        subject: "[Diffinery] Test email",
        preheader: "Email from Diffinery works.",
        eyebrow: { text: "Test", tone: "green" },
        title: ["Email from Diffinery works"],
        blocks: [{ p: [user(job.data.by), " sent this test email at ", at(job.at), `. It came from Cloudflare Email Sending, signed with DKIM for ${mailDomain(pub, mailFrom)}.`] }, { button: { label: "Notification settings", url: `${pub}/settings/notifications` } }],
        url: `${pub}/settings/notifications`,
      };
  }
}

// ---------------------------------------------------------------- the morning digest (phase 5c)

/** Today by email: what needs you, your agents, and what happened since the last digest (agentic/digest.ts). */
function digestEmail(d: DigestData, pub: string): Email {
  const today = `${pub}/`;
  const s = d.summary;
  if (!s) {
    // deliver() always fills the summary in; this only shows if something sends the job without it.
    return { subject: "[Diffinery] Your morning digest", preheader: "Open Today on Diffinery.", eyebrow: { text: "Today", tone: "blue" }, title: ["Your morning digest"], blocks: [{ button: { label: "Open Today", url: today } }], url: today };
  }
  const c = s.counts;
  const parts = [c.needsYou ? `${c.needsYou} need${c.needsYou === 1 ? "s" : ""} you` : "", c.agents ? plural(c.agents, "agent pull request") : "", c.merged ? `${c.merged} merged` : "", c.failed ? plural(c.failed, "failed run") : ""].filter(Boolean);
  const headline = parts.length ? parts.join(", ") : "nothing needs you";
  const blocks: Block[] = [];
  if (!s.sections.length) blocks.push({ p: ["Nothing needs you, your agents have no open pull requests, and nothing merged, released or failed since the last digest."] });
  for (const sec of s.sections) {
    blocks.push({ p: [{ b: sec.title }, sec.total > sec.items.length ? ` · ${sec.items.length} of ${sec.total}` : ` · ${sec.total}`] });
    blocks.push({ items: sec.items.map((it) => ({ mark: it.mark, text: [{ b: it.title }, ` ${it.where} · ${it.note}`], url: it.url })) });
  }
  blocks.push({ button: { label: "Open Today", url: today } });
  blocks.push({ p: [`Since ${at(d.since)}, across ${plural(s.repositories, "active repository", "active repositories")}${s.incomplete ? " (some were left out; Today shows the most recently active)" : ""}.`], muted: true });
  return {
    subject: `[Diffinery] Today: ${headline}`,
    preheader: s.sections.length ? s.sections.map((x) => `${x.title}: ${x.total}`).join(" · ") : "A quiet morning.",
    eyebrow: { text: s.date, tone: c.needsYou ? "purple" : "blue" },
    title: [c.needsYou ? `${c.needsYou} ${c.needsYou === 1 ? "thing needs" : "things need"} you today` : "Your morning digest"],
    blocks,
    url: today,
  };
}
