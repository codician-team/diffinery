import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A D1Database over node:sqlite with every migration applied: enough for prepare/bind/first/all/run and batch. */
export function testD1(): D1Database & { sqlite: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const statement = (query: string, bindings: unknown[] = []) => ({
    bind: (...b: unknown[]) => statement(query, b),
    first: async <T>() => (db.prepare(query).get(...(bindings as never[])) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(query).all(...(bindings as never[])) as T[], success: true, meta: {} }),
    run: async () => {
      const r = db.prepare(query).run(...(bindings as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    sqlite: db,
    prepare: (q: string) => statement(q),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database & { sqlite: DatabaseSync };
}
