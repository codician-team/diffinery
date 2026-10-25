import { hashObject, type GitObject, type ObjectType } from "./objects.js";
import type { ObjectStore } from "./store.js";

/** In-memory object store, used in tests and as a write buffer. */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, GitObject>();
  constructor(private fallback?: { read(oid: string): Promise<GitObject | null> }) {}

  async read(oid: string): Promise<GitObject | null> {
    return this.objects.get(oid) ?? (this.fallback ? this.fallback.read(oid) : null);
  }

  async write(type: ObjectType, content: Uint8Array): Promise<string> {
    const oid = await hashObject(type, content);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, content });
    return oid;
  }
}
