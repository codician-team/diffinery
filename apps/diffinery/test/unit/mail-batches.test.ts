import { describe, expect, it } from "vitest";
import { MAX_QUEUED_BODY, enqueueMail, mailBatches } from "../../src/mail/send.js";
import type { MailJob } from "../../src/mail/types.js";
import type { Env } from "../../src/env.js";

const thread = (i: number, body: string): MailJob =>
  ({ kind: "thread", data: { repo: "acme/app", repoId: "r", number: 1, kind: "issue", title: "t", event: "comment", actor: "ada", url: "u", body }, to: { accountId: `u${i}` }, reason: "subscribed", at: "2026-10-14T00:00:00Z" }) as MailJob;

describe("queueing email in batches the queue accepts", () => {
  it("cuts batches by size, under the 256 KB sendBatch limit", () => {
    const jobs = Array.from({ length: 200 }, (_, i) => thread(i, "x".repeat(20_000)));
    const batches = mailBatches(jobs);
    expect(batches.flat()).toHaveLength(200);
    for (const b of batches) expect(new TextEncoder().encode(JSON.stringify(b.map((body) => ({ body })))).length).toBeLessThan(256_000);
    // Small jobs still go 50 at a time.
    expect(mailBatches(Array.from({ length: 120 }, (_, i) => thread(i, "hi"))).map((b) => b.length)).toEqual([50, 50, 20]);
  });

  it("shortens a body too long for one queue message", () => {
    const [[job]] = mailBatches([thread(0, "y".repeat(500_000))]) as [[MailJob]];
    const body = (job as unknown as { data: { body: string } }).data.body;
    expect(body.length).toBeLessThan(MAX_QUEUED_BODY + 10);
    expect(body.endsWith("…")).toBe(true);
  });

  it("leaves out a job too large for one queue message, not the batch it would be in", () => {
    const huge = { ...thread(1, "hi"), data: { ...(thread(1, "hi") as unknown as { data: object }).data, title: "z".repeat(200_000) } } as unknown as MailJob;
    expect(mailBatches([thread(0, "hi"), huge, thread(2, "hi")]).flat().map((j) => j.to)).toEqual([{ accountId: "u0" }, { accountId: "u2" }]);
  });

  it("queues every batch even when one is refused", async () => {
    const sent: number[] = [];
    let calls = 0;
    const env = { MAIL: { sendBatch: async (b: unknown[]) => { if (calls++ === 0) throw new Error("refused"); sent.push(b.length); } } } as unknown as Env;
    await enqueueMail(env, Array.from({ length: 120 }, (_, i) => thread(i, "hi")));
    expect(sent).toEqual([50, 20]);
  });
});
