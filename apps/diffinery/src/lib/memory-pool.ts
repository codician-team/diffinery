/** A share of a MemoryPool: what one task may hold until it releases it. */
export interface Lease {
  readonly bytes: number;
  /** Waits for a larger share: this one is given back first, so nothing it held may still be in use. */
  grow(bytes: number): Promise<void>;
  /** Gives the share back; a second call does nothing. */
  release(): void;
}

/**
 * Bytes that tasks in one isolate may hold at once (a Durable Object or a Worker has 128 MB, shared
 * by every request in flight there). take(n) waits until n bytes fit beside what is taken, behind
 * every earlier waiter, so a large task isn't kept waiting by a stream of small ones. A task asking
 * for more than the whole pool gets all of it, and runs alone.
 */
export class MemoryPool {
  private used = 0;
  private readonly queue: Array<{ n: number; go: () => void }> = [];

  constructor(readonly size: number) {}

  /** Whether `bytes` would be given at once. */
  fits(bytes: number): boolean {
    return !this.queue.length && this.used + Math.min(bytes, this.size) <= this.size;
  }

  async take(bytes: number): Promise<Lease> {
    let n = await this.acquire(bytes);
    let held = true;
    const lease: Lease = {
      get bytes() {
        return held ? n : 0;
      },
      grow: async (more) => {
        if (held && more <= n) return;
        lease.release();
        n = await this.acquire(more);
        held = true;
      },
      release: () => {
        if (!held) return;
        held = false;
        this.used -= n;
        this.drain();
      },
    };
    return lease;
  }

  private async acquire(bytes: number): Promise<number> {
    const n = Math.min(Math.max(0, bytes), this.size);
    if (this.fits(n)) this.used += n;
    else await new Promise<void>((go) => this.queue.push({ n, go }));
    return n;
  }

  private drain(): void {
    while (this.queue.length && this.used + this.queue[0]!.n <= this.size) {
      const w = this.queue.shift()!;
      this.used += w.n;
      w.go();
    }
  }
}
