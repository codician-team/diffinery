import { describe, expect, it, vi } from "vitest";
import { STAGE_RETRY_DELAYS, runStages, type Stage, type StageRetry } from "../../src/lib/stages.js";

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("event stages", () => {
  it("retries only the stage that failed", async () => {
    quiet();
    const ran: Stage[] = [];
    const queued: Array<[StageRetry<string>, number]> = [];
    const run = async (s: Stage) => {
      ran.push(s);
      if (s === "notify") throw new Error("D1 hiccup");
    };
    await runStages("ev", ["webhooks", "notify"], run, async (r, d) => void queued.push([r, d]));
    expect(ran.sort()).toEqual(["notify", "webhooks"]);
    expect(queued).toEqual([[{ type: "stage_retry", stage: "notify", event: "ev", attempt: 1 }, STAGE_RETRY_DELAYS[0]]]);

    // The retry runs notifications alone: webhooks are not sent again.
    ran.length = 0;
    queued.length = 0;
    await runStages("ev", ["notify"], async (s) => void ran.push(s), async (r, d) => void queued.push([r, d]), 1);
    expect(ran).toEqual(["notify"]);
    expect(queued).toEqual([]);
  });

  it("backs off and eventually gives up without throwing", async () => {
    quiet();
    const delays: number[] = [];
    const fail = async () => {
      throw new Error("down");
    };
    for (let attempt = 0; attempt <= STAGE_RETRY_DELAYS.length; attempt++) await runStages("ev", ["webhooks"], fail, async (_r, d) => void delays.push(d), attempt);
    expect(delays).toEqual(STAGE_RETRY_DELAYS);
  });

  it("does not throw when the retry can't be queued", async () => {
    quiet();
    await expect(
      runStages(
        "ev",
        ["notify"],
        async () => {
          throw new Error("x");
        },
        async () => {
          throw new Error("queue down");
        },
      ),
    ).resolves.toBeUndefined();
  });
});
