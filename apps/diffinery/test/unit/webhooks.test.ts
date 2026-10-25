import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { Collab } from "../../src/repo/collab.js";
import { encryptSecret } from "../../src/lib/crypto.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import { deliverWebhook, WEBHOOK_RETRY_DELAYS, type WebhookDeps, type WebhookRetry } from "../../src/lib/webhooks.js";

const hook = { id: "h1", url: "https://hooks.example/x", secret: "s3cret" };
const msg: WebhookRetry = { type: "webhook_retry", repoId: "r1", hookId: "h1", event: "push", diffineryEvent: "push", body: '{"ok":true}', delivery: "d1", attempt: 0 };

function harness(statuses: Array<number | Error>, current: typeof hook | null = hook) {
  const recorded: number[] = [];
  const requeued: Array<{ r: WebhookRetry; delay: number }> = [];
  const sent: Request[] = [];
  const deps: WebhookDeps = {
    hook: async () => current,
    record: async (_repo, _hook, status) => void recorded.push(status),
    requeue: async (r, delay) => void requeued.push({ r, delay }),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push(new Request(url, init));
      const next = statuses.shift()!;
      if (next instanceof Error) throw next;
      return new Response(null, { status: next });
    }) as typeof fetch,
  };
  return { deps, recorded, requeued, sent };
}

describe("webhook delivery", () => {
  it("signs the body and does not retry a success", async () => {
    const h = harness([200]);
    expect(await deliverWebhook(h.deps, msg)).toBe(200);
    expect(h.recorded).toEqual([200]);
    expect(h.requeued).toEqual([]);
    expect(h.sent[0]!.headers.get("x-github-event")).toBe("push");
    expect(h.sent[0]!.headers.get("x-hub-signature-256")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("retries network errors, rate limits and server errors with growing delays", async () => {
    for (const failure of [new Error("connection reset"), 429, 503]) {
      const h = harness([failure]);
      await deliverWebhook(h.deps, msg);
      expect(h.requeued).toEqual([{ r: { ...msg, attempt: 1 }, delay: WEBHOOK_RETRY_DELAYS[0] }]);
    }
    const h = harness([500]);
    await deliverWebhook(h.deps, { ...msg, attempt: 2 });
    expect(h.requeued[0]!.delay).toBe(WEBHOOK_RETRY_DELAYS[2]);
    expect(h.requeued[0]!.r.delivery).toBe("d1");
  });

  it("does not retry client errors, and gives up after the last delay", async () => {
    const rejected = harness([404]);
    await deliverWebhook(rejected.deps, msg);
    expect(rejected.requeued).toEqual([]);
    const last = harness([500]);
    await deliverWebhook(last.deps, { ...msg, attempt: WEBHOOK_RETRY_DELAYS.length });
    expect(last.recorded).toEqual([500]);
    expect(last.requeued).toEqual([]);
  });

  it("drops a retry when the hook was deleted or disabled", async () => {
    const h = harness([200], null);
    expect(await deliverWebhook(h.deps, { ...msg, attempt: 1 })).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it("never delivers to an internal address or Diffinery itself, even for a hook saved before URLs were checked", async () => {
    for (const url of ["https://127.0.0.1/x", "https://localhost./x", "http://hooks.example/x", "https://diffinery.com/api/v3/x"]) {
      const h = harness([200], { ...hook, url });
      expect(await deliverWebhook({ ...h.deps, ownHost: "diffinery.com" }, msg)).toBe(0);
      expect(h.sent).toEqual([]);
      expect(h.recorded).toEqual([0]);
      expect(h.requeued).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- signing secrets at rest

/** A minimal SqlStorage over node:sqlite with the repository schema. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec(REPO_SCHEMA);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...(bindings as never[]));
        return { toArray: () => rows, one: () => rows[0] } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [], one: () => undefined } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
    },
  } as unknown as SqlStorage;
  migrateRepoSchema(sql);
  return sql;
}

describe("webhook secrets", () => {
  const env = { MASTER_KEY: Buffer.alloc(32, 7).toString("base64") } as Env;
  const collab = () => {
    const sql = sqlStorage();
    return { sql, collab: new Collab({ sql, meta: { repoId: "r1" } } as unknown as RepoDO, env) };
  };
  const stored = (sql: SqlStorage, id: string) => sql.exec<{ secret: string; secret_encrypted: number }>("SELECT secret, secret_encrypted FROM webhooks WHERE id = ?", id).one();

  it("are stored encrypted, never listed, and decrypted for delivery", async () => {
    const { sql, collab: c } = collab();
    const made = await c.createWebhook("https://hooks.example/x", ["push"], "s3cret", "diffinery.test");
    expect(made.secret).toBe("s3cret");
    const row = stored(sql, made.id);
    expect(row.secret_encrypted).toBe(1);
    expect(row.secret).toMatch(/^v2\.[0-9a-f]{8}\./);
    expect(row.secret).not.toContain("s3cret");
    expect(c.webhooks()[0]).not.toHaveProperty("secret");
    expect((await c.deliverableWebhooks()).map((h) => h.secret)).toEqual(["s3cret"]);
    // A generated secret is shown once and encrypted the same way.
    const generated = await c.createWebhook("https://hooks.example/y", [], undefined, "diffinery.test");
    expect(stored(sql, generated.id).secret).not.toContain(generated.secret);
    expect((await c.deliverableWebhooks()).find((h) => h.id === generated.id)?.secret).toBe(generated.secret);
  });

  it("can't be moved to another hook", async () => {
    const { sql, collab: c } = collab();
    const a = await c.createWebhook("https://hooks.example/a", [], "aaa", "diffinery.test");
    const b = await c.createWebhook("https://hooks.example/b", [], "bbb", "diffinery.test");
    sql.exec("UPDATE webhooks SET secret = ? WHERE id = ?", stored(sql, a.id).secret, b.id);
    // Only the hook whose secret doesn't decrypt goes undelivered.
    expect((await c.deliverableWebhooks()).map((h) => [h.id, h.secret])).toEqual([[a.id, "aaa"]]);
  });

  it("saved in plaintext before keep signing, and are encrypted on their next delivery", async () => {
    const { sql, collab: c } = collab();
    // A row as older versions wrote it; one that looks like an envelope is still taken as plaintext.
    sql.exec("INSERT INTO webhooks (id, url, secret, events, created_at) VALUES ('old', 'https://hooks.example/old', 'v1.not.encrypted', '[\"*\"]', '2026-01-01T00:00:00Z')");
    expect((await c.deliverableWebhooks()).map((h) => h.secret)).toEqual(["v1.not.encrypted"]);
    const row = stored(sql, "old");
    expect(row.secret_encrypted).toBe(1);
    expect(row.secret).not.toBe("v1.not.encrypted");
    expect((await c.deliverableWebhooks()).map((h) => h.secret)).toEqual(["v1.not.encrypted"]);
  });

  it("sealed with the previous MASTER_KEY, or as v1, are sealed again with the current one on delivery", async () => {
    const sql = sqlStorage();
    const next = { MASTER_KEY: Buffer.alloc(32, 8).toString("base64"), MASTER_KEY_PREV: env.MASTER_KEY } as Env;
    const before = new Collab({ sql, meta: { repoId: "r1" } } as unknown as RepoDO, env);
    const a = await before.createWebhook("https://hooks.example/a", [], "aaa", "diffinery.test");
    const b = await before.createWebhook("https://hooks.example/b", [], "bbb", "diffinery.test");
    // b as the v1 code wrote it: the same ciphertext without a key id.
    const [, , iv, ct] = stored(sql, b.id).secret.split(".");
    sql.exec("UPDATE webhooks SET secret = ? WHERE id = ?", `v1.${iv}.${ct}`, b.id);
    const kid = (await encryptSecret(next, "x", "x")).split(".")[1];
    const during = new Collab({ sql, meta: { repoId: "r1" } } as unknown as RepoDO, next);
    expect((await during.deliverableWebhooks()).map((h) => h.secret).sort()).toEqual(["aaa", "bbb"]);
    for (const id of [a.id, b.id]) expect(stored(sql, id).secret.split(".").slice(0, 2)).toEqual(["v2", kid]);
    // After the rotation, without the previous key.
    const after = new Collab({ sql, meta: { repoId: "r1" } } as unknown as RepoDO, { MASTER_KEY: next.MASTER_KEY } as Env);
    expect((await after.deliverableWebhooks()).map((h) => h.secret).sort()).toEqual(["aaa", "bbb"]);
  });

  it("leave inactive hooks out of delivery", async () => {
    const { sql, collab: c } = collab();
    const h = await c.createWebhook("https://hooks.example/x", [], "s", "diffinery.test");
    sql.exec("UPDATE webhooks SET active = 0 WHERE id = ?", h.id);
    expect(await c.deliverableWebhooks()).toEqual([]);
    expect(c.webhooks()).toHaveLength(1);
  });

  it("can't be stored without MASTER_KEY", async () => {
    const sql = sqlStorage();
    const c = new Collab({ sql, meta: { repoId: "r1" } } as unknown as RepoDO, {} as Env);
    await expect(c.createWebhook("https://hooks.example/x", [], "s", "diffinery.test")).rejects.toThrow(/is MASTER_KEY configured/);
    expect(c.webhooks()).toEqual([]);
  });
});
