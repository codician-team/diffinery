import { ByteWriter, FLUSH, DELIM, ZERO_OID, fromUtf8, planFetch, parseTag, pkt, pktText, readPkts, sideband, packStream, utf8, type ObjectReader } from "@diffinery/git-core";
import type { RawObject } from "../repo/objects.js";

export const AGENT = "diffinery/0.1";

export type RefEntry = {
  name: string;
  oid: string;
};

export interface UploadContext {
  /** `readRawAll`: the same objects as readRaw, in order, read in batches (the repository's store has it). */
  store: ObjectReader & { readRaw(oid: string): Promise<RawObject | null>; readRawAll?(oids: readonly string[]): AsyncIterable<RawObject>; has(oid: string): boolean };
  refs: RefEntry[];
  /** e.g. refs/heads/main — HEAD points here even when the branch does not exist yet. */
  headTarget: string;
}

// ------------------------------------------------------------------ advertisements

export function advertiseUploadPackV2(): Uint8Array {
  const w = new ByteWriter();
  w.write(pkt("version 2\n"));
  w.write(pkt(`agent=${AGENT}\n`));
  w.write(pkt("ls-refs=unborn\n"));
  w.write(pkt("fetch=shallow wait-for-done\n"));
  w.write(pkt("server-option\n"));
  w.write(pkt("object-format=sha1\n"));
  w.write(FLUSH);
  return w.bytes();
}

export function advertiseReceivePack(refs: RefEntry[]): Uint8Array {
  const w = new ByteWriter();
  w.write(pkt("# service=git-receive-pack\n"));
  w.write(FLUSH);
  const caps = `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 agent=${AGENT}`;
  if (refs.length === 0) {
    w.write(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => w.write(pkt(i === 0 ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`)));
  }
  w.write(FLUSH);
  return w.bytes();
}

// ------------------------------------------------------------------ protocol v2: upload-pack

interface V2Request {
  command: string;
  capabilities: string[];
  args: string[];
}

function parseV2(body: Uint8Array): V2Request {
  const { pkts } = readPkts(body);
  const req: V2Request = { command: "", capabilities: [], args: [] };
  let section: "caps" | "args" = "caps";
  for (const p of pkts) {
    if (p.type === "delim") {
      section = "args";
      continue;
    }
    if (p.type === "flush") break;
    const line = pktText(p);
    if (section === "caps") {
      if (line.startsWith("command=")) req.command = line.slice(8);
      else req.capabilities.push(line);
    } else req.args.push(line);
  }
  return req;
}

/** Where a response goes, piece by piece; each write resolves once the client has taken it. */
export type Sink = (bytes: Uint8Array) => Promise<void>;

export async function handleUploadPackV2(body: Uint8Array, ctx: UploadContext, sink: Sink): Promise<void> {
  const req = parseV2(body);
  if (req.command === "ls-refs") return sink(await lsRefs(req, ctx));
  if (req.command === "fetch") return fetchCommand(req, ctx, sink);
  throw new Error(`unsupported command: ${req.command || "(none)"}`);
}

async function lsRefs(req: V2Request, ctx: UploadContext): Promise<Uint8Array> {
  const prefixes = req.args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice(11));
  const symrefs = req.args.includes("symrefs");
  const peel = req.args.includes("peel");
  const unborn = req.args.includes("unborn");
  const match = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const w = new ByteWriter();
  const head = ctx.refs.find((r) => r.name === ctx.headTarget);
  if (match("HEAD")) {
    if (head) w.write(pkt(`${head.oid} HEAD${symrefs ? ` symref-target:${ctx.headTarget}` : ""}\n`));
    else if (unborn) w.write(pkt(`unborn HEAD${symrefs ? ` symref-target:${ctx.headTarget}` : ""}\n`));
  }
  for (const r of ctx.refs) {
    if (!match(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.name.startsWith("refs/tags/")) {
      const o = await ctx.store.read(r.oid);
      if (o?.type === "tag") line += ` peeled:${parseTag(o.content).object}`;
    }
    w.write(pkt(`${line}\n`));
  }
  w.write(FLUSH);
  return w.bytes();
}

async function fetchCommand(req: V2Request, ctx: UploadContext, sink: Sink): Promise<void> {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let waitForDone = false;
  let noProgress = false;
  let depth: number | undefined;
  let since: number | undefined;
  const clientShallow = new Set<string>();
  for (const a of req.args) {
    if (a.startsWith("want ")) wants.push(a.slice(5));
    else if (a.startsWith("want-ref ")) {
      const ref = ctx.refs.find((r) => r.name === a.slice(9));
      if (ref) wants.push(ref.oid);
    } else if (a.startsWith("have ")) haves.push(a.slice(5));
    else if (a === "done") done = true;
    else if (a === "wait-for-done") waitForDone = true;
    else if (a === "no-progress") noProgress = true;
    else if (a.startsWith("shallow ")) clientShallow.add(a.slice(8));
    else if (a.startsWith("deepen ")) depth = Math.max(1, Number.parseInt(a.slice(7), 10) || 1);
    else if (a.startsWith("deepen-since ")) since = Number.parseInt(a.slice(13), 10);
    else if (a === "deepen-relative") {
      // Approximation: treat relative deepening as absolute depth from the wants.
    } else if (a.startsWith("deepen-not ")) throw new Error("--shallow-exclude is not supported; use --depth or --shallow-since");
    else if (a.startsWith("filter ")) throw new Error("partial clones (--filter) are not supported yet");
  }
  for (const w of wants) if (!ctx.store.has(w)) throw new Error(`not our ref ${w}`);
  const common = haves.filter((h) => ctx.store.has(h));

  const out = new ByteWriter();
  if (!done) {
    out.write(pkt("acknowledgments\n"));
    if (common.length === 0) out.write(pkt("NAK\n"));
    for (const c of common) out.write(pkt(`ACK ${c}\n`));
    if (waitForDone) {
      // Negotiation only (git push with push.negotiate): no "ready" and no pack until "done".
      out.write(FLUSH);
      return sink(out.bytes());
    }
    out.write(pkt("ready\n"));
    out.write(DELIM);
  }
  const plan = await planFetch(ctx.store, wants, common, { depth, since, clientShallow });
  if (depth !== undefined || since !== undefined || clientShallow.size) {
    out.write(pkt("shallow-info\n"));
    for (const oid of plan.shallow) out.write(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.write(pkt(`unshallow ${oid}\n`));
    out.write(DELIM);
  }
  out.write(pkt("packfile\n"));
  const oids = plan.oids;
  if (!noProgress) sideband(2, utf8(`Enumerating objects: ${oids.length}, done.\n`), out);
  await sink(out.bytes());

  // The pack goes out as it is read, in side-band packets, so memory holds one object at a time and
  // a clone of a large repository can't exhaust the Durable Object.
  async function* entries() {
    if (ctx.store.readRawAll) {
      for await (const raw of ctx.store.readRawAll(oids)) yield { type: raw.type, size: raw.size, deflated: raw.deflated };
      return;
    }
    for (const oid of oids) {
      const raw = await ctx.store.readRaw(oid);
      if (!raw) throw new Error(`missing object ${oid}`);
      yield { type: raw.type, size: raw.size, deflated: raw.deflated };
    }
  }
  const band = new SidebandBuffer(sink);
  try {
    for await (const part of packStream(oids.length, entries())) await band.write(part);
    await band.flush();
  } catch (e) {
    // Mid-pack, the only way to tell the client is the error band.
    const w = new ByteWriter();
    sideband(3, utf8(`${(e as Error).message}\n`), w);
    await sink(w.bytes());
    throw e;
  }
  const end = new ByteWriter();
  if (!noProgress) sideband(2, utf8(`Total ${oids.length} (delta 0), reused ${oids.length} (delta 0)\n`), end);
  end.write(FLUSH);
  await sink(end.bytes());
}

/**
 * Gathers pack bytes into full side-band-64k packets (65515 bytes of data each), written in place
 * after room for the packet's length and band: a clone passes its whole pack through here, so each
 * byte is copied once. Every packet gets a buffer of its own, since the sink may still hold the last.
 */
class SidebandBuffer {
  private static readonly MAX = 65515;
  private static readonly HEAD = 5;
  private buf = new Uint8Array(SidebandBuffer.HEAD + SidebandBuffer.MAX);
  private used = 0;
  constructor(private sink: Sink) {}

  async write(data: Uint8Array): Promise<void> {
    let i = 0;
    while (i < data.length) {
      const take = Math.min(SidebandBuffer.MAX - this.used, data.length - i);
      this.buf.set(data.subarray(i, i + take), SidebandBuffer.HEAD + this.used);
      this.used += take;
      i += take;
      if (this.used === SidebandBuffer.MAX) await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.used) return;
    const packet = this.buf.subarray(0, SidebandBuffer.HEAD + this.used);
    packet.set(utf8(packet.length.toString(16).padStart(4, "0")), 0);
    packet[4] = 1;
    this.buf = new Uint8Array(SidebandBuffer.HEAD + SidebandBuffer.MAX);
    this.used = 0;
    await this.sink(packet);
  }
}

// ------------------------------------------------------------------ receive-pack

export interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface ReceiveRequest {
  commands: RefCommand[];
  capabilities: Set<string>;
  pushOptions: string[];
  pack: Uint8Array | null;
}

export function parseReceivePack(body: Uint8Array): ReceiveRequest {
  const { pkts, offset } = readPkts(body, 0, true);
  const commands: RefCommand[] = [];
  let capabilities = new Set<string>();
  for (const p of pkts) {
    if (p.type !== "data") continue;
    let line = fromUtf8(p.data).replace(/\n$/, "");
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).trim().split(" ").filter(Boolean));
      line = line.slice(0, nul);
    }
    if (line.startsWith("shallow ")) continue;
    const [oldOid, newOid, ref] = line.split(" ");
    if (!oldOid || !newOid || !ref) throw new Error(`bad command: ${line}`);
    commands.push({ oldOid, newOid, ref });
  }
  let rest = offset;
  const pushOptions: string[] = [];
  if (capabilities.has("push-options")) {
    const opts = readPkts(body, rest, true);
    for (const p of opts.pkts) if (p.type === "data") pushOptions.push(pktText(p));
    rest = opts.offset;
  }
  const pack = rest < body.length ? body.subarray(rest) : null;
  return { commands, capabilities, pushOptions, pack };
}

/**
 * `parseReceivePack` for the start of a push body read on its own (a large push staged in R2): the
 * commands and push options, and the offset where the pack starts, or null when `head` ends before
 * them, so the caller reads more.
 */
export function parseReceivePackHead(head: Uint8Array): { req: ReceiveRequest; packOffset: number } | null {
  const complete = (start: number) => {
    try {
      const r = readPkts(head, start, true);
      return r.pkts.at(-1)?.type === "flush" ? r.offset : null;
    } catch (e) {
      if (/truncated pkt-line/.test((e as Error).message)) return null;
      throw e;
    }
  };
  const commandsEnd = complete(0);
  if (commandsEnd === null) return null;
  const req = parseReceivePack(head.subarray(0, commandsEnd));
  let packOffset = commandsEnd;
  if (req.capabilities.has("push-options")) {
    const optionsEnd = complete(commandsEnd);
    if (optionsEnd === null) return null;
    for (const p of readPkts(head, commandsEnd, true).pkts) if (p.type === "data") req.pushOptions.push(pktText(p));
    packOffset = optionsEnd;
  }
  return { req, packOffset };
}

export interface RefResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

/** The platform's error for a Durable Object stopped by a new version of its code. */
export const resetByDeploy = (e: unknown) => e instanceof Error && /durable object reset because its code was updated/i.test(e.message);

/**
 * The unpack status for a push that couldn't be unpacked or stored. Running out of memory says to
 * split the push, the wording clients (and the GitHub importer, which then pushes smaller chunks)
 * already treat as "too big".
 */
export function unpackFailure(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof RangeError || /allocation failed|out of memory/i.test(message)) {
    return `the push needs more memory than one push may use; split it into smaller pushes (${message})`;
  }
  return message;
}

export function reportStatus(req: ReceiveRequest, unpackError: string | null, results: RefResult[], messages: string[] = []): Uint8Array {
  const report = new ByteWriter();
  report.write(pkt(unpackError ? `unpack ${unpackError}\n` : "unpack ok\n"));
  for (const r of results) report.write(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? "rejected"}\n`));
  report.write(FLUSH);
  if (!req.capabilities.has("side-band-64k")) return report.bytes();
  const out = new ByteWriter();
  for (const m of messages) sideband(2, utf8(`${m}\n`), out);
  sideband(1, report.bytes(), out);
  out.write(FLUSH);
  return out.bytes();
}

export function errorPacket(message: string): Uint8Array {
  const w = new ByteWriter();
  w.write(pkt(`ERR ${message}\n`));
  return w.bytes();
}
