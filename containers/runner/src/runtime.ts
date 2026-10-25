import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { totalmem } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { JobSpec } from "@diffinery/shared";

/**
 * Client for the Actions runtime services (ACTIONS_RESULTS_URL): the Twirp
 * cache and artifact services and their signed blob URLs. The built-in cache
 * and artifact actions use it, so they share storage (and archive formats)
 * with the official actions.
 */

export class RuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/** Uploads at most this much in one request; larger files go up as blocks. */
const SINGLE_SHOT = 32 * 1024 * 1024;
/**
 * Larger files go up in blocks of this size, this many at a time (measured on hosted runners: 4 of
 * 32 MiB ran at 23-33 MiB/s, 16 of 16 MiB at 58-62 MiB/s). Blocks in flight are held in memory, so
 * the 1 GiB runner sends fewer and smaller ones (32 MiB at most).
 */
const SMALL_MACHINE = totalmem() < 2 * 1024 ** 3;
const BLOCK_SIZE = (SMALL_MACHINE ? 8 : 16) * 1024 * 1024;
const UPLOAD_CONCURRENCY = SMALL_MACHINE ? 4 : 8;
/** Downloads come in ranges of this size, this many at a time (measured on hosted runners: 16 of 8 MiB ran 2-5x faster than one stream). */
const DOWNLOAD_CHUNK = 8 * 1024 * 1024;
// Fewer on the smallest runner (1 GiB), so ranges waiting their turn hold at most 32 MiB there.
const DOWNLOAD_CONCURRENCY = SMALL_MACHINE ? 4 : 16;

export class RuntimeClient {
  constructor(
    readonly token: string,
    readonly resultsUrl: string,
    private readonly opts: { retries?: number; minBackoffMs?: number } = {},
  ) {}

  static fromSpec(spec: JobSpec): RuntimeClient | null {
    return spec.runtime ? new RuntimeClient(spec.runtime.token, spec.runtime.resultsUrl) : null;
  }

  async withRetries<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const retries = this.opts.retries ?? 5;
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep((this.opts.minBackoffMs ?? 1000) * 2 ** (attempt - 1));
      try {
        return await fn();
      } catch (e) {
        if (e instanceof RuntimeError && !retryable(e.status)) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? new Error(`${what}: ${last.message}`) : new Error(`${what} failed`);
  }

  /** Calls a Twirp method (JSON). Errors become RuntimeError with the Twirp code. */
  async twirp<T>(service: "CacheService" | "ArtifactService", method: string, body: Record<string, unknown>): Promise<T> {
    const url = `${new URL(this.resultsUrl).origin}/twirp/github.actions.results.api.v1.${service}/${method}`;
    return this.withRetries(method, async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "user-agent": "diffinery-runner" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        let code = "unknown";
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { code?: string; msg?: string };
          code = j.code ?? code;
          msg = j.msg ?? msg;
        } catch {
          /* not Twirp JSON */
        }
        throw new RuntimeError(res.status, code, `${method} failed (${res.status} ${code}): ${msg}`);
      }
      return JSON.parse(text) as T;
    });
  }

  /** Uploads a file to a signed URL (Put Blob, or Put Block + Put Block List). */
  async upload(url: string, file: string, contentType = "application/octet-stream"): Promise<number> {
    const size = (await stat(file)).size;
    const fh = await open(file, "r");
    try {
      const read = async (offset: number, length: number) => {
        const buf = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return buf.subarray(0, got);
      };
      const put = (target: string, body: Buffer, headers: Record<string, string>) =>
        this.withRetries("upload", async () => {
          const res = await fetch(target, { method: "PUT", headers: { "x-ms-version": "2025-01-05", ...headers }, body });
          if (res.status !== 201) {
            const text = await res.text().catch(() => "");
            throw new RuntimeError(res.status, "upload", `upload failed (${res.status}): ${text.slice(0, 300)}`);
          }
        });
      if (size <= SINGLE_SHOT) {
        await put(url, await read(0, size), { "x-ms-blob-type": "BlockBlob", "x-ms-blob-content-type": contentType, "content-type": "application/octet-stream" });
        return size;
      }
      const blocks: string[] = [];
      for (let off = 0, i = 0; off < size; off += BLOCK_SIZE, i++) blocks.push(Buffer.from(`block-${String(i).padStart(8, "0")}`).toString("base64"));
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < blocks.length; i = next++) {
          const body = await read(i * BLOCK_SIZE, Math.min(BLOCK_SIZE, size - i * BLOCK_SIZE));
          await put(`${url}&comp=block&blockid=${encodeURIComponent(blocks[i]!)}`, body, { "content-type": "application/octet-stream" });
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, blocks.length) }, worker));
      const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blocks.map((b) => `<Latest>${b}</Latest>`).join("")}</BlockList>`;
      await put(`${url}&comp=blocklist`, Buffer.from(xml), { "x-ms-blob-content-type": contentType, "content-type": "application/xml" });
      return size;
    } finally {
      await fh.close();
    }
  }

  /**
   * Downloads a signed URL to a file. Large blobs come down in ranges, several at once, which is
   * what makes a cache or artifact of a few hundred MB restore in seconds (one stream from R2 through
   * the Worker often runs at 20-30 MB/s). Returns the response's content type and file name.
   */
  async download(url: string, file: string): Promise<{ contentType: string; fileName: string | null }> {
    const out = createWriteStream(file);
    const dl = this.downloadStream(url);
    await pipeline(dl, out);
    return dl.meta!;
  }

  /**
   * The blob at a signed URL as a stream, in order. It asks for the first range; a server that
   * answers with ranges (as Diffinery's does) gets the rest DOWNLOAD_CONCURRENCY at a time, each
   * range retried on its own, and at most that many ranges are held in memory. A server that
   * ignores ranges sends the whole body in one response. Every range must come from the same
   * object (size and ETag), or the stream fails rather than mix two versions.
   */
  downloadStream(url: string, o: { onSize?: (size: number) => void } = {}): Readable & { meta?: { contentType: string; fileName: string | null }; size?: number } {
    const abort = new AbortController();
    const client = this;
    const get = (range: { start: number; end: number } | null) =>
      fetch(url, { headers: { "user-agent": "diffinery-runner", ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}) }, signal: abort.signal });
    const fail = async (res: Response) => {
      const text = await res.text().catch(() => "");
      return new RuntimeError(res.status, "download", `download failed (${res.status}): ${text.slice(0, 200)}`);
    };
    async function* chunks(this: void): AsyncGenerator<Buffer> {
      // The first range, or the whole body from a server that doesn't do ranges (or an empty blob: 416).
      const first = await client.withRetries("download", async () => {
        let res = await get({ start: 0, end: DOWNLOAD_CHUNK - 1 });
        if (res.status === 416) {
          await res.body?.cancel();
          res = await get(null);
        }
        if (!res.ok || !res.body) throw await fail(res);
        return res;
      });
      stream.meta = { contentType: (first.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(), fileName: fileNameOf(first.headers.get("content-disposition") ?? "") };
      const total = first.status === 206 ? Number(/\/(\d+)$/.exec(first.headers.get("content-range") ?? "")?.[1]) : NaN;
      if (first.status !== 206 || !Number.isSafeInteger(total)) {
        const declared = first.headers.get("content-length");
        // fetch decodes a compressed body, so its length only counts when the body isn't encoded.
        const length = declared === null || first.headers.get("content-encoding") ? NaN : Number(declared);
        if (Number.isSafeInteger(length)) o.onSize?.(length);
        let n = 0;
        for await (const c of Readable.fromWeb(first.body as unknown as WebReadableStream)) {
          n += (c as Buffer).length;
          yield c as Buffer;
        }
        if (Number.isSafeInteger(length) && n !== length) throw new Error(`download: got ${n} of ${length} bytes`);
        stream.size = n;
        return;
      }
      stream.size = total;
      o.onSize?.(total);
      const etag = first.headers.get("etag");
      const ranges: Array<{ start: number; end: number }> = [];
      for (let start = 0; start < total; start += DOWNLOAD_CHUNK) ranges.push({ start, end: Math.min(start + DOWNLOAD_CHUNK, total) - 1 });
      const body = async (res: Response, r: { start: number; end: number }) => {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== r.end - r.start + 1) throw new Error(`download: got ${buf.length} bytes for bytes ${r.start}-${r.end}`);
        return buf;
      };
      const fetchRange = (r: { start: number; end: number }) =>
        client.withRetries("download", async () => {
          const res = await get(r);
          if (res.status !== 206) {
            await res.body?.cancel();
            throw res.ok ? new RuntimeError(412, "download", `download failed: the server stopped answering with ranges (${res.status})`) : await fail(res);
          }
          const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
          if (!m || Number(m[1]) !== r.start || Number(m[2]) !== r.end || Number(m[3]) !== total || (etag && res.headers.get("etag") !== etag)) {
            await res.body?.cancel();
            throw new RuntimeError(412, "download", "download failed: the blob changed while it was being downloaded");
          }
          return body(res, r);
        });
      const pending: Array<Promise<Buffer>> = [body(first, ranges[0]!).catch(() => fetchRange(ranges[0]!))];
      let next = 1;
      const fill = () => {
        while (next < ranges.length && pending.length < DOWNLOAD_CONCURRENCY) {
          const p = fetchRange(ranges[next++]!);
          p.catch(() => {}); // awaited in order below; this keeps an early failure from going unhandled meanwhile
          pending.push(p);
        }
      };
      fill();
      while (pending.length) {
        const buf = await pending.shift()!;
        fill();
        yield buf;
      }
    }
    const stream: Readable & { meta?: { contentType: string; fileName: string | null }; size?: number } = Readable.from(chunks(), { objectMode: false });
    stream.once("close", () => abort.abort());
    return stream;
  }
}

function fileNameOf(cd: string): string | null {
  const star = /filename\*\s*=\s*UTF-8''([^;\r\n]*)/i.exec(cd)?.[1];
  const plain = /(?<!\*)filename\s*=\s*"?([^;\r\n"]*)"?/i.exec(cd)?.[1];
  try {
    return star ? decodeURIComponent(star) : (plain ?? null);
  } catch {
    return plain ?? null;
  }
}
