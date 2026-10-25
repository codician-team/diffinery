import { ByteWriter, concat, fromUtf8, utf8 } from "./bytes.js";

export const FLUSH = utf8("0000");
export const DELIM = utf8("0001");
export const RESPONSE_END = utf8("0002");

export function pkt(data: string | Uint8Array): Uint8Array {
  const body = typeof data === "string" ? utf8(data) : data;
  if (body.length > 65516) throw new Error("pkt-line too long");
  return concat([utf8((body.length + 4).toString(16).padStart(4, "0")), body]);
}

export type Pkt = { type: "data"; data: Uint8Array } | { type: "flush" } | { type: "delim" } | { type: "end" };

/** Decode a buffer of pkt-lines. Returns the packets and the offset where parsing stopped. */
export function readPkts(buf: Uint8Array, start = 0, stopAtFlush = false): { pkts: Pkt[]; offset: number } {
  const pkts: Pkt[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const len = parseInt(fromUtf8(buf.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at ${i}`);
    if (len === 0) {
      pkts.push({ type: "flush" });
      i += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) {
      pkts.push({ type: "delim" });
      i += 4;
      continue;
    }
    if (len === 2) {
      pkts.push({ type: "end" });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error(`truncated pkt-line at ${i}`);
    pkts.push({ type: "data", data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { pkts, offset: i };
}

/** Text of a data pkt without its trailing newline. */
export const pktText = (p: Pkt): string => (p.type === "data" ? fromUtf8(p.data).replace(/\n$/, "") : "");

/** Wrap pack bytes in side-band-64k packets on the given band. */
export function sideband(band: 1 | 2 | 3, data: Uint8Array, w: ByteWriter): void {
  const max = 65515;
  for (let i = 0; i < data.length; i += max) {
    const chunk = data.subarray(i, Math.min(data.length, i + max));
    w.write(pkt(concat([new Uint8Array([band]), chunk])));
  }
}
