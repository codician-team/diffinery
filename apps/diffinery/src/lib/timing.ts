import type { Env } from "../env.js";

/**
 * Where a request's time goes, for the `Server-Timing` header that browsers' developer tools
 * show: D1 queries and Durable Object calls, each counted and summed (parallel calls overlap, so
 * a sum can pass the total), and the whole request. Signed-in callers get it on answers that
 * aren't errors (app.ts): an error could tell a private repository from a missing one by how
 * many lookups it took.
 */
export class Timing {
  private readonly start = Date.now();
  private readonly spans = new Map<string, { n: number; ms: number }>();
  /** Where D1 answered from, as its results say (only `all`, `run` and `batch` results carry it). */
  private d1Where: string | null = null;

  /** Notes where a D1 result came from: its region, and whether the primary or a replica answered. */
  d1Result(r: unknown): void {
    const meta = (r as { meta?: { served_by_region?: string; served_by_primary?: boolean } } | null)?.meta;
    if (this.d1Where || !meta?.served_by_region || !/^[A-Z]{2,8}$/.test(meta.served_by_region)) return;
    this.d1Where = `${meta.served_by_region} ${meta.served_by_primary ? "primary" : "replica"}`;
  }

  /** Times `p` under `kind` and hands it back unchanged. */
  track<T>(kind: string, p: T): T {
    if (!(p && typeof (p as { then?: unknown }).then === "function")) return p;
    const t0 = Date.now();
    const done = () => {
      const s = this.spans.get(kind) ?? { n: 0, ms: 0 };
      s.n++;
      s.ms += Date.now() - t0;
      this.spans.set(kind, s);
    };
    (p as unknown as PromiseLike<unknown>).then(done, done);
    return p;
  }

  header(colo?: string): string {
    const out = [`total;dur=${Date.now() - this.start}`];
    for (const [kind, s] of this.spans) {
      const what = kind === "d1" ? `quer${s.n === 1 ? "y" : "ies"}${this.d1Where ? `, ${this.d1Where}` : ""}` : `call${s.n === 1 ? "" : "s"}`;
      out.push(`${kind};dur=${s.ms};desc="${s.n} ${what}"`);
    }
    if (colo && /^[A-Z]{3}$/.test(colo)) out.push(`colo;desc="${colo}"`);
    return out.join(", ");
  }
}

const STATEMENT_RUNS = ["first", "all", "run", "raw"] as const;

/** A D1 statement whose runs are timed. The statement itself stays the real one, so `batch` still takes it. */
function timedStatement(t: Timing, s: D1PreparedStatement): D1PreparedStatement {
  const st = s as unknown as Record<string, (...a: unknown[]) => unknown>;
  try {
    for (const m of STATEMENT_RUNS) {
      const run = st[m];
      if (typeof run === "function")
        st[m] = (...a: unknown[]) => {
          const p = t.track("d1", run.apply(s, a));
          if (m === "all" || m === "run") (p as Promise<unknown>).then((r) => t.d1Result(r), () => {});
          return p;
        };
    }
    const bind = st.bind;
    if (typeof bind === "function") st.bind = (...a: unknown[]) => timedStatement(t, bind.apply(s, a) as D1PreparedStatement);
  } catch {
    // A statement that can't take own methods runs untimed.
  }
  return s;
}

function timedDb(t: Timing, db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "prepare") return (q: string) => timedStatement(t, (v as (q: string) => D1PreparedStatement).call(target, q));
      if (prop === "batch" || prop === "exec")
        return (...a: unknown[]) => {
          const p = t.track("d1", (v as (...a: unknown[]) => unknown).apply(target, a));
          if (prop === "batch") (p as Promise<unknown[]>).then((rs) => t.d1Result(rs?.[0]), () => {});
          return p;
        };
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/** Stub members that aren't calls to the object (or must stay as they are). */
const NOT_CALLS = new Set<PropertyKey>(["then", "catch", "finally", "dup", "id", "name", "connect"]);

function timedStub<S extends object>(t: Timing, stub: S): S {
  return new Proxy(stub, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function" || typeof prop === "symbol" || NOT_CALLS.has(prop)) return v;
      // Reflect.apply: the stub's members are RPC proxies, whose own `apply` would be a call to the object.
      return (...a: unknown[]) => t.track("do", Reflect.apply(v as (...a: unknown[]) => unknown, target, a));
    },
  });
}

function timedNamespace<N extends object>(t: Timing, ns: N): N {
  return new Proxy(ns, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const f = (v as (...a: unknown[]) => unknown).bind(target);
      return prop === "get" || prop === "getByName" ? (...a: unknown[]) => timedStub(t, f(...a) as object) : f;
    },
  });
}

/** `env` with its D1 database and the repository and agent-task Durable Objects timed into `t`. */
export function timedEnv(env: Env, t: Timing): Env {
  return {
    ...env,
    DB: env.DB ? timedDb(t, env.DB) : env.DB,
    REPO: env.REPO ? timedNamespace(t, env.REPO) : env.REPO,
    PROJECT: env.PROJECT ? timedNamespace(t, env.PROJECT) : env.PROJECT,
  };
}
