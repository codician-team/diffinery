import { HttpError } from "./util.js";

/** R2 multipart parts must all be the same size (except the last) and at least 5 MiB. */
export const PART_SIZE = 8 * 1024 * 1024;

type Bucket = Pick<R2Bucket, "put" | "createMultipartUpload">;

/**
 * Writes chunks to one R2 object with bounded memory: objects under one part
 * go up with a single put, larger ones as a multipart upload of equal parts.
 * Stops with a 413 once `limit` bytes have been written.
 */
export class R2Sink {
  private buf: Uint8Array[] = [];
  private buffered = 0;
  private total = 0;
  private upload: R2MultipartUpload | null = null;
  private parts: R2UploadedPart[] = [];

  constructor(
    private bucket: Bucket,
    private key: string,
    private contentType: string,
    private limit: number,
    private tooLarge = "the object is too large",
  ) {}

  get size(): number {
    return this.total;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!chunk.length) return;
    this.total += chunk.length;
    if (this.total > this.limit) throw new HttpError(413, this.tooLarge);
    this.buf.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= PART_SIZE) await this.flushPart(PART_SIZE);
  }

  /** Take exactly `n` buffered bytes (or all of them) off the front. */
  private take(n: number): Uint8Array {
    const out = new Uint8Array(Math.min(n, this.buffered));
    let o = 0;
    while (o < out.length) {
      const head = this.buf[0]!;
      const want = out.length - o;
      if (head.length <= want) {
        out.set(head, o);
        o += head.length;
        this.buf.shift();
      } else {
        out.set(head.subarray(0, want), o);
        this.buf[0] = head.subarray(want);
        o += want;
      }
    }
    this.buffered -= out.length;
    return out;
  }

  private async flushPart(n: number): Promise<void> {
    this.upload ??= await this.bucket.createMultipartUpload(this.key, { httpMetadata: { contentType: this.contentType } });
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.take(n)));
  }

  /** Finish the object; returns its size. */
  async close(): Promise<number> {
    if (!this.upload) {
      await this.bucket.put(this.key, this.take(this.buffered), { httpMetadata: { contentType: this.contentType } });
      return this.total;
    }
    if (this.buffered) await this.flushPart(this.buffered);
    await this.upload.complete(this.parts);
    return this.total;
  }

  async abort(): Promise<void> {
    this.buf = [];
    this.buffered = 0;
    await this.upload?.abort().catch(() => undefined);
  }
}
