import { CODE_TYPES, TYPE_CODES, deflate, deflateChunks, hashObject, inflateSized, type GitObject, type ObjectStore, type ObjectType } from "@diffinery/git-core";
import { sized } from "../lib/blob-store.js";

/** Objects larger than this (compressed) go to R2 instead of SQLite (rows are capped at 2 MB). */
export const INLINE_LIMIT = 512 * 1024;

/**
 * Objects larger than this are compressed a chunk at a time to be stored, never holding a second,
 * compressed copy whole: once to learn its length, then again as it is written.
 */
const WHOLE_DEFLATE_MAX = 1024 * 1024;
const CACHE_BYTES = 24 * 1024 * 1024;
/** readRawAll: objects per query (SQLite's bound parameters), and stored bytes held per batch. */
const BATCH_OIDS = 100;
const BATCH_BYTES = 4 * 1024 * 1024;

export interface RawObject {
  type: ObjectType;
  size: number;
  deflated: Uint8Array;
}

/**
 * Git object storage for one repository: SQLite inside the Durable Object for
 * small objects, R2 for large ones, with an in-memory LRU of inflated objects.
 */
export class RepoObjectStore implements ObjectStore {
  private cache = new Map<string, GitObject>();
  private cacheBytes = 0;

  /** `onAdded` is told when objects were stored (for the owner's storage quota, lib/quotas.ts). */
  constructor(private sql: SqlStorage, private bucket: R2Bucket, private repoId: string, private onAdded?: () => void) {}

  private r2Key(oid: string) {
    return `repos/${this.repoId}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
  }

  /** Where an object kept in R2 lives, for deleting it. */
  r2KeyOf(oid: string): string {
    return this.r2Key(oid);
  }

  /** Drop the in-memory cache (after objects were deleted). */
  forget(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private remember(oid: string, obj: GitObject) {
    if (obj.content.length > 4 * 1024 * 1024) return;
    this.cache.set(oid, obj);
    this.cacheBytes += obj.content.length;
    while (this.cacheBytes > CACHE_BYTES) {
      const [k, v] = this.cache.entries().next().value as [string, GitObject];
      this.cache.delete(k);
      this.cacheBytes -= v.content.length;
    }
  }

  /** What reading an object holds at once, its zlib data and its content, or null when it isn't stored. */
  readCost(oid: string): number | null {
    const row = this.sql.exec<{ size: number; z: number }>("SELECT size, coalesce(stored, CASE WHEN r2 = 1 THEN size ELSE length(data) END) AS z FROM objects WHERE oid = ?", oid).toArray()[0];
    return row ? row.size + row.z : null;
  }

  /** An object's inflated size without reading it, or null when it isn't stored. */
  size(oid: string): number | null {
    return this.sql.exec<{ size: number }>("SELECT size FROM objects WHERE oid = ?", oid).toArray()[0]?.size ?? null;
  }

  has(oid: string): boolean {
    return this.sql.exec("SELECT 1 FROM objects WHERE oid = ?", oid).toArray().length > 0;
  }

  async readRaw(oid: string): Promise<RawObject | null> {
    const row = this.sql.exec<{ type: number; size: number; data: ArrayBuffer | null; r2: number }>("SELECT type, size, data, r2 FROM objects WHERE oid = ?", oid).toArray()[0];
    if (!row) return null;
    let deflated: Uint8Array;
    if (row.r2) {
      const o = await this.bucket.get(this.r2Key(oid));
      if (!o) throw new Error(`object ${oid} missing from R2`);
      deflated = new Uint8Array(await o.arrayBuffer());
    } else {
      deflated = new Uint8Array(row.data!);
    }
    return { type: CODE_TYPES[row.type]!, size: row.size, deflated };
  }

  /**
   * The raw objects for `oids`, in that order, read a batch at a time: a clone reads every object, and
   * a query for each was a quarter of its time. A batch holds at most BATCH_BYTES of stored data (and
   * always one object); objects kept in R2 are fetched one by one. Throws on one that isn't stored.
   */
  async *readRawAll(oids: readonly string[]): AsyncGenerator<RawObject> {
    for (let at = 0; at < oids.length; at += BATCH_OIDS) {
      const ids = oids.slice(at, at + BATCH_OIDS);
      const rows = this.sql.exec<{ oid: string; type: number; size: number; r2: number; z: number }>(
        `SELECT oid, type, size, r2, coalesce(length(data), 0) AS z FROM objects WHERE oid IN (${ids.map(() => "?").join(", ")})`,
        ...ids,
      );
      const meta = new Map(rows.toArray().map((r) => [r.oid, r]));
      let i = 0;
      while (i < ids.length) {
        // The next run of objects whose inline data fits in one batch.
        const inline: string[] = [];
        let bytes = 0;
        let end = i;
        for (; end < ids.length; end++) {
          const m = meta.get(ids[end]!);
          if (!m || m.r2) continue;
          if (inline.length && bytes + m.z > BATCH_BYTES) break;
          inline.push(ids[end]!);
          bytes += m.z;
        }
        const data = new Map<string, ArrayBuffer>();
        if (inline.length) {
          const q = `SELECT oid, data FROM objects WHERE oid IN (${inline.map(() => "?").join(", ")})`;
          for (const r of this.sql.exec<{ oid: string; data: ArrayBuffer }>(q, ...inline).toArray()) data.set(r.oid, r.data);
        }
        for (; i < end; i++) {
          const oid = ids[i]!;
          const m = meta.get(oid);
          if (!m) throw new Error(`missing object ${oid}`);
          let deflated: Uint8Array;
          if (m.r2) {
            const o = await this.bucket.get(this.r2Key(oid));
            if (!o) throw new Error(`object ${oid} missing from R2`);
            deflated = new Uint8Array(await o.arrayBuffer());
          } else {
            deflated = new Uint8Array(data.get(oid)!);
          }
          yield { type: CODE_TYPES[m.type]!, size: m.size, deflated };
        }
      }
    }
  }

  async read(oid: string): Promise<GitObject | null> {
    const hit = this.cache.get(oid);
    if (hit) {
      this.cache.delete(oid);
      this.cache.set(oid, hit);
      return hit;
    }
    const raw = await this.readRaw(oid);
    if (!raw) return null;
    const obj = { type: raw.type, content: inflateSized(raw.deflated, raw.size) };
    this.remember(oid, obj);
    return obj;
  }

  async write(type: ObjectType, content: Uint8Array): Promise<string> {
    const oid = await hashObject(type, content);
    await this.writeKnown(oid, type, content);
    return oid;
  }

  /**
   * Store an object whose oid is already verified. `cache`: keep it in memory too (a large push
   * doesn't, to stay small). `zlibSize`: what it compresses to, when already measured.
   */
  async writeKnown(oid: string, type: ObjectType, content: Uint8Array, cache = true, zlibSize?: number): Promise<void> {
    if (this.has(oid)) return;
    if (content.length <= WHOLE_DEFLATE_MAX) {
      const deflated = deflate(content);
      const r2 = deflated.length > INLINE_LIMIT;
      if (r2) await this.bucket.put(this.r2Key(oid), deflated);
      this.insert(oid, type, content.length, deflated.length, r2 ? null : deflated);
    } else {
      let length = zlibSize ?? 0;
      if (zlibSize === undefined) for (const c of deflateChunks(content)) length += c.length;
      if (length > INLINE_LIMIT) {
        const chunks = deflateChunks(content);
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = chunks.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
        });
        await this.bucket.put(this.r2Key(oid), sized(stream, length));
        this.insert(oid, type, content.length, length, null);
      } else {
        const out = new Uint8Array(length);
        let at = 0;
        for (const c of deflateChunks(content)) {
          out.set(c, at);
          at += c.length;
        }
        this.insert(oid, type, content.length, length, out);
      }
    }
    if (cache) this.remember(oid, { type, content });
  }

  /**
   * Store an object from zlib data that is already in hand (a large blob as it sits in a pushed
   * pack), without inflating or recompressing it. The data goes to R2 in slices, never copied whole.
   * `content`: the object inflated, when already in hand, to keep in the memory cache as writeKnown does.
   */
  async writeDeflated(oid: string, type: ObjectType, size: number, deflated: Uint8Array, content?: Uint8Array): Promise<void> {
    if (this.has(oid)) return;
    const r2 = deflated.length > INLINE_LIMIT;
    if (r2) await this.bucket.put(this.r2Key(oid), sized(slices(deflated), deflated.length));
    this.insert(oid, type, size, deflated.length, r2 ? null : deflated.slice());
    if (content) this.remember(oid, { type, content });
  }

  /**
   * `writeDeflated` for zlib data that arrives in slices (a large blob in a pushed pack read from R2
   * in ranges): what is too big for SQLite goes to R2 as it arrives, never held whole.
   */
  async writeDeflatedSlices(oid: string, type: ObjectType, size: number, length: number, data: () => AsyncIterable<Uint8Array>): Promise<void> {
    if (this.has(oid)) return;
    if (length > INLINE_LIMIT) {
      const it = data()[Symbol.asyncIterator]();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await it.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value.slice());
        },
      });
      await this.bucket.put(this.r2Key(oid), sized(stream, length));
      this.insert(oid, type, size, length, null);
      return;
    }
    const out = new Uint8Array(length);
    let at = 0;
    for await (const s of data()) {
      out.set(s, at);
      at += s.length;
    }
    this.insert(oid, type, size, length, out);
  }

  /** Record an object (`data` null: it is in R2) and count its bytes, unless a concurrent write recorded it first. */
  private insert(oid: string, type: ObjectType, size: number, stored: number, data: Uint8Array | null): void {
    const added = this.sql.exec("INSERT OR IGNORE INTO objects (oid, type, size, data, r2, stored) VALUES (?, ?, ?, ?, ?, ?) RETURNING oid", oid, TYPE_CODES[type], size, data, data ? 0 : 1, stored).toArray().length;
    if (!added) return;
    this.sql.exec("UPDATE counters SET value = value + ? WHERE name = 'stored_bytes'", stored);
    this.onAdded?.();
  }

  count(): number {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM objects").one().n;
  }

  /**
   * Bytes the objects take as stored (compressed), kept as a running total. It is added up once when
   * missing: in a repository from before it was kept (R2 objects stored then count at their inflated
   * size), and after a purge deleted objects.
   */
  sizeBytes(): number {
    const kept = this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = 'stored_bytes'").toArray()[0];
    if (kept) return kept.value;
    const n = this.sql.exec<{ n: number }>("SELECT coalesce(sum(coalesce(stored, CASE WHEN r2 = 1 THEN size ELSE length(data) END)), 0) AS n FROM objects").one().n;
    this.sql.exec("INSERT INTO counters (name, value) VALUES ('stored_bytes', ?)", n);
    return n;
  }

  /** Forget the running total (objects were deleted); the next sizeBytes adds them up again. */
  recount(): void {
    this.sql.exec("DELETE FROM counters WHERE name = 'stored_bytes'");
  }
}

/** `data` as a stream of 1 MiB views. */
function slices(data: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= data.length) return controller.close();
      const end = Math.min(data.length, at + 1024 * 1024);
      controller.enqueue(data.subarray(at, end));
      at = end;
    },
  });
}
