import { describe, expect, it } from "vitest";
import { freeSlot, IN_FLIGHT_LEASE_MS, MAX_IN_FLIGHT, takeSlot } from "../../src/agentic/inflight.js";
import { testD1 } from "./stubs/d1.js";

describe("model requests at once (phase 5b)", () => {
  it("gives a scope at most MAX_IN_FLIGHT slots, frees them, and lets an expired lease stop counting", async () => {
    const env = { DB: testD1() };
    const at = Date.parse("2026-10-14T09:00:00Z");
    const ids = [];
    for (let i = 0; i < MAX_IN_FLIGHT; i++) ids.push(await takeSlot(env, "org:acme:mia", at));
    expect(ids.every((x) => typeof x === "string")).toBe(true);
    expect(await takeSlot(env, "org:acme:mia", at)).toBeNull();
    // Other scopes have their own.
    expect(await takeSlot(env, "org:acme:otto", at)).toBeTypeOf("string");
    await freeSlot(env, ids[0]!);
    expect(await takeSlot(env, "org:acme:mia", at)).toBeTypeOf("string");
    expect(await takeSlot(env, "org:acme:mia", at)).toBeNull();
    // A lease whose request never settled (its Worker died) counts until it expires.
    expect(await takeSlot(env, "org:acme:mia", at + IN_FLIGHT_LEASE_MS - 1)).toBeNull();
    expect(await takeSlot(env, "org:acme:mia", at + IN_FLIGHT_LEASE_MS)).toBeTypeOf("string");
  });
});
