import { describe, expect, it } from "vitest";
import { timerMinute } from "../../src/repo/actions.js";
import { localTimer } from "../../src/auth/dev.js";

const local = { WAIT_TIMER_MINUTE_MS: "10000", ACCESS_AUD: "", PUBLIC_URL: "http://127.0.0.1:41234" };

describe("an environment's wait-timer minute", () => {
  it("is a real minute unless the end-to-end setting is there", () => {
    expect(timerMinute({ ...local, WAIT_TIMER_MINUTE_MS: undefined })).toBe(60_000);
    expect(timerMinute(local)).toBe(10_000);
    expect(timerMinute({ ...local, PUBLIC_URL: "http://localhost:8787" })).toBe(10_000);
  });

  it("ignores the setting on a deployed Worker", () => {
    expect(timerMinute({ ...local, PUBLIC_URL: "https://diffinery.com" })).toBe(60_000);
    expect(timerMinute({ ...local, PUBLIC_URL: "https://localhost.evil.example" })).toBe(60_000);
    expect(timerMinute({ ...local, ACCESS_AUD: "aud-tag" })).toBe(60_000);
    expect(timerMinute({ ...local, PUBLIC_URL: "" })).toBe(60_000);
  });

  it("ignores values that aren't a length from 1 ms to a minute", () => {
    for (const v of ["0", "-5", "1.5", "60001", "soon", ""]) expect(timerMinute({ ...local, WAIT_TIMER_MINUTE_MS: v })).toBe(60_000);
  });
});

describe("test-only polls (agent tasks, web terminals)", () => {
  const env = { ACCESS_AUD: "", PUBLIC_URL: "http://127.0.0.1:41234" };
  it("shortens a poll only on a Worker on this machine", () => {
    expect(localTimer(env, "500", 3000, 200)).toBe(500);
    expect(localTimer(env, undefined, 3000, 200)).toBe(3000);
    expect(localTimer({ ...env, PUBLIC_URL: "https://diffinery.com" }, "500", 3000, 200)).toBe(3000);
    expect(localTimer({ ...env, PUBLIC_URL: "https://localhost.evil.example" }, "500", 3000, 200)).toBe(3000);
    expect(localTimer({ ...env, ACCESS_AUD: "aud-tag" }, "500", 3000, 200)).toBe(3000);
  });

  it("ignores values below the floor, above the default, or not whole milliseconds", () => {
    for (const v of ["0", "199", "3001", "1.5", "soon", ""]) expect(localTimer(env, v, 3000, 200)).toBe(3000);
  });
});
