import { connect } from "cloudflare:sockets";
import type { Env } from "../env.js";
import type { Outgoing } from "./send.js";

/**
 * Sending over SMTP, for an instance without Cloudflare Email Sending (the EMAIL binding), such as
 * one on celld. SMTP_URL names the server and the user and SMTP_PASSWORD (a secret) the password:
 * `smtps://user@host:465` is TLS from the first byte, and `smtp://user@host:587` upgrades with
 * STARTTLS and refuses to go on without it, so the password never crosses the network in the clear.
 * Each email is one TCP connection (`cloudflare:sockets`, which celld provides too). Nothing of the
 * conversation is logged; errors carry the server's replies, never the commands sent.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** `implicit`: TLS from the start (smtps://). `starttls`: plain until STARTTLS, which is required (smtp://). */
  tls: "implicit" | "starttls";
  user: string | null;
  password: string | null;
}

/**
 * E_SMTP_TRANSIENT (a 4xx reply, a timeout or a dropped connection) is retried. E_SMTP_RECIPIENT_REJECTED
 * (the server refused the recipient for good) suppresses the address. E_SMTP_REJECTED (any other 5xx,
 * such as a wrong password) and E_SMTP_CONFIG fail the email and change nothing else.
 */
export type SmtpErrorCode = "E_SMTP_CONFIG" | "E_SMTP_TRANSIENT" | "E_SMTP_REJECTED" | "E_SMTP_RECIPIENT_REJECTED";

export class SmtpError extends Error {
  constructor(
    readonly code: SmtpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/** The SMTP settings, null when SMTP_URL is unset, or what is wrong with them. */
export function smtpConfig(env: Pick<Env, "SMTP_URL" | "SMTP_PASSWORD">): SmtpConfig | { error: string } | null {
  const raw = env.SMTP_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: "SMTP_URL is not a URL" };
  }
  const tls = u.protocol === "smtps:" ? "implicit" : u.protocol === "smtp:" ? "starttls" : null;
  if (!tls) return { error: "SMTP_URL must start with smtps:// or smtp://" };
  if (u.password) return { error: "the password goes in the SMTP_PASSWORD secret, not in SMTP_URL" };
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) return { error: "SMTP_URL has no host" };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { error: "SMTP_URL takes no path or query" };
  let user: string | null;
  try {
    user = u.username ? decodeURIComponent(u.username) : null;
  } catch {
    return { error: "SMTP_URL has a badly escaped user" };
  }
  const password = env.SMTP_PASSWORD || null;
  if (user && !password) return { error: "SMTP_URL names a user but the SMTP_PASSWORD secret is not set" };
  if (password && !user) return { error: "SMTP_PASSWORD is set but SMTP_URL names no user" };
  return { host, port: u.port ? Number(u.port) : tls === "implicit" ? 465 : 587, tls, user, password };
}

/** SMTP_URL as an administrator may see it: scheme, user, host and port. */
export const smtpLabel = (c: SmtpConfig): string =>
  `${c.tls === "implicit" ? "smtps" : "smtp"}://${c.user ? `${encodeURIComponent(c.user)}@` : ""}${c.host.includes(":") ? `[${c.host}]` : c.host}:${c.port}${c.tls === "starttls" ? " (STARTTLS)" : ""}`;

/** How long to wait for each reply, and for each write. */
export const SMTP_TIMEOUT_MS = 30_000;

const enc = new TextEncoder();

function b64(s: string): string {
  let bin = "";
  for (const b of enc.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Base64 in lines of 76 characters (RFC 2045). */
const b64Lines = (s: string): string => b64(s).replace(/.{76}/g, "$&\r\n");

const ASCII = /^[\x20-\x7e]*$/;

/** A header value with non-ASCII text as RFC 2047 encoded words of at most 39 bytes of UTF-8 each, so a folded line stays under 78 characters. */
function encodeWords(s: string): string {
  if (ASCII.test(s)) return s;
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (cur && enc.encode(cur + ch).length > 39) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ");

function mailbox(m: { name: string; email: string } | string): string {
  if (typeof m === "string") return oneLine(m);
  const name = oneLine(m.name).trim();
  if (!name) return oneLine(m.email);
  return `${ASCII.test(name) ? `"${name.replace(/[\\"]/g, "\\$&")}"` : encodeWords(name)} <${oneLine(m.email)}>`;
}

/** Headers formatMessage writes itself; the same names in Outgoing.headers are left out. */
const OWN_HEADERS = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version", "content-type", "content-transfer-encoding"]);

/** The email as RFC 5322 text with CRLF line ends: text and HTML as multipart/alternative, each in base64. */
export function formatMessage(msg: Outgoing, o: { messageId: string; date: Date; boundary?: string }): string {
  const boundary = o.boundary ?? `=_diffinery_${crypto.randomUUID().replace(/-/g, "")}`;
  const headers: Array<[string, string]> = [
    ["From", mailbox(msg.from)],
    ["To", mailbox(msg.to)],
    ...(msg.replyTo ? [["Reply-To", mailbox(msg.replyTo)] as [string, string]] : []),
    ["Subject", encodeWords(oneLine(msg.subject))],
    ["Date", o.date.toUTCString().replace(/GMT$/, "+0000")],
    ["Message-ID", o.messageId],
    ["MIME-Version", "1.0"],
    ...Object.entries(msg.headers)
      .filter(([k]) => /^[A-Za-z0-9-]+$/.test(k) && !OWN_HEADERS.has(k.toLowerCase()))
      .map(([k, v]) => [k, encodeWords(oneLine(v))] as [string, string]),
    ["Content-Type", `multipart/alternative; boundary="${boundary}"`],
  ];
  const part = (type: string, body: string) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Lines(body)}\r\n`;
  return `${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${part("text/plain", msg.text)}${part("text/html", msg.html)}--${boundary}--\r\n`;
}

/** Enhanced status codes (RFC 3463) that mean the recipient's address is bad for good: no such mailbox or domain, or a disabled mailbox. */
const BAD_RECIPIENT = new Set(["5.1.1", "5.1.2", "5.1.3", "5.1.6", "5.1.10", "5.2.1"]);

interface Reply {
  code: number;
  text: string;
}

/** Whether a 5xx reply to RCPT TO is about the address rather than the sender, the relay or the message. */
function recipientGone(r: Reply): boolean {
  const enhanced = /^5\.\d{1,3}\.\d{1,3}\b/.exec(r.text)?.[0];
  return enhanced ? BAD_RECIPIENT.has(enhanced) : r.code === 550 || r.code === 551 || r.code === 553;
}

function failure(stage: string, r: Reply): SmtpError {
  const detail = `SMTP ${stage}: ${r.code} ${r.text}`.slice(0, 300);
  if (r.code >= 400 && r.code < 500) return new SmtpError("E_SMTP_TRANSIENT", detail);
  if (r.code >= 500) return new SmtpError(stage === "RCPT TO" && recipientGone(r) ? "E_SMTP_RECIPIENT_REJECTED" : "E_SMTP_REJECTED", detail);
  return new SmtpError("E_SMTP_TRANSIENT", `${detail} (unexpected reply)`);
}

/** One SMTP connection: reads replies line by line and writes commands, each within the timeout. */
class Session {
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private decoder = new TextDecoder();
  private buf = "";

  constructor(
    private socket: Socket,
    private timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    // A connection that fails shows up in the next read; these would otherwise be unhandled rejections.
    socket.opened.catch(() => {});
    socket.closed.catch(() => {});
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.buf = "";
  }

  private async within<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpError("E_SMTP_TRANSIENT", `SMTP ${what}: no answer from the server in ${this.timeoutMs / 1000} seconds`)), this.timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async line(stage: string): Promise<string> {
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl >= 0) {
        const l = this.buf.slice(0, nl).replace(/\r$/, "");
        this.buf = this.buf.slice(nl + 1);
        return l;
      }
      if (this.buf.length > 64_000) throw new SmtpError("E_SMTP_TRANSIENT", `SMTP ${stage}: reply line too long`);
      const { value, done } = await this.within(this.reader.read(), stage);
      if (done) throw new SmtpError("E_SMTP_TRANSIENT", `SMTP ${stage}: the server closed the connection`);
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }

  /** One reply, all lines of a multiline one (`250-...` up to `250 ...`) joined. */
  async reply(stage: string): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.line(stage);
      const m = /^(\d{3})([ -]|$)(.*)$/.exec(l);
      if (!m) throw new SmtpError("E_SMTP_TRANSIENT", `SMTP ${stage}: not an SMTP reply`);
      lines.push(m[3]!);
      if (m[2] !== "-") return { code: Number(m[1]), text: lines.join("\n") };
    }
  }

  async write(data: string, stage: string): Promise<void> {
    await this.within(this.writer.write(enc.encode(data)), stage);
  }

  /** Send a command and expect one of the codes. `stage` names it in errors, so a command with a password in it never shows up. */
  async command(line: string, ok: number[], stage: string): Promise<Reply> {
    await this.write(`${line}\r\n`, stage);
    return this.expect(ok, stage);
  }

  async expect(ok: number[], stage: string): Promise<Reply> {
    const r = await this.reply(stage);
    if (!ok.includes(r.code)) throw failure(stage, r);
    return r;
  }

  /** EHLO, and the extensions the server lists (keyword → parameters). */
  async ehlo(name: string): Promise<Map<string, string>> {
    const r = await this.command(`EHLO ${name}`, [250], "EHLO");
    const caps = new Map<string, string>();
    for (const l of r.text.split("\n").slice(1)) {
      const [k, ...rest] = l.trim().split(/\s+/);
      if (k) caps.set(k.toUpperCase(), rest.join(" ").toUpperCase());
    }
    return caps;
  }

  /** Switch to TLS after the server's 220 to STARTTLS. Anything it sent before is dropped, so it can't be injected into the TLS session. */
  startTls(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.attach(this.socket.startTls());
  }

  async close(): Promise<void> {
    await this.socket.close().catch(() => {});
  }
}

const ADDRESS = /^[^\s<>()[\],;:"\\@]+@[^\s<>()[\],;:"\\@]+$/;

/**
 * Send one email over SMTP. Resolves with the Message-ID it gave the email; throws SmtpError.
 * `ehlo` is the name Diffinery greets the server with (its own hostname).
 */
export async function sendSmtp(cfg: SmtpConfig, msg: Outgoing, opts: { ehlo: string; timeoutMs?: number; now?: Date }): Promise<{ messageId: string }> {
  const from = msg.from.email;
  const to = typeof msg.to === "string" ? msg.to : msg.to.email;
  for (const a of [from, to]) if (!ADDRESS.test(a)) throw new SmtpError("E_SMTP_REJECTED", `not an address SMTP can send to: ${oneLine(a).slice(0, 100)}`);
  const messageId = `<${crypto.randomUUID()}@${from.slice(from.lastIndexOf("@") + 1)}>`;
  const data = formatMessage(msg, { messageId, date: opts.now ?? new Date() });

  let session: Session;
  try {
    session = new Session(connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: cfg.tls === "implicit" ? "on" : "starttls", allowHalfOpen: false }), opts.timeoutMs ?? SMTP_TIMEOUT_MS);
  } catch (e) {
    throw new SmtpError("E_SMTP_TRANSIENT", `SMTP connect: ${(e as Error).message ?? String(e)}`);
  }
  try {
    await session.expect([220], "greeting");
    let caps = await session.ehlo(opts.ehlo);
    if (cfg.tls === "starttls") {
      if (!caps.has("STARTTLS")) throw new SmtpError("E_SMTP_REJECTED", "SMTP: the server doesn't offer STARTTLS, and Diffinery doesn't send without TLS");
      await session.command("STARTTLS", [220], "STARTTLS");
      session.startTls();
      caps = await session.ehlo(opts.ehlo);
    }
    if (cfg.user && cfg.password) {
      const mechanisms = (caps.get("AUTH") ?? "").split(" ");
      if (mechanisms.includes("PLAIN")) {
        await session.command(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password}`)}`, [235], "AUTH");
      } else if (mechanisms.includes("LOGIN")) {
        await session.command("AUTH LOGIN", [334], "AUTH");
        await session.command(b64(cfg.user), [334], "AUTH");
        await session.command(b64(cfg.password), [235], "AUTH");
      } else {
        throw new SmtpError("E_SMTP_REJECTED", "SMTP: the server offers neither AUTH PLAIN nor AUTH LOGIN");
      }
    }
    const utf8 = !ASCII.test(from + to);
    if (utf8 && !caps.has("SMTPUTF8")) throw new SmtpError("E_SMTP_REJECTED", "SMTP: the address isn't ASCII and the server doesn't offer SMTPUTF8");
    await session.command(`MAIL FROM:<${from}>${utf8 ? " SMTPUTF8" : ""}`, [250], "MAIL FROM");
    await session.command(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await session.command("DATA", [354], "DATA");
    // A line that starts with a dot gets another (RFC 5321 4.5.2); a dot alone ends the message.
    await session.write(`${data.replace(/^\./gm, "..")}.\r\n`, "DATA");
    await session.expect([250], "DATA");
    await session.write("QUIT\r\n", "QUIT").catch(() => {});
    return { messageId };
  } catch (e) {
    if (e instanceof SmtpError) throw e;
    throw new SmtpError("E_SMTP_TRANSIENT", `SMTP: ${(e as Error).message ?? String(e)}`);
  } finally {
    await session.close();
  }
}
