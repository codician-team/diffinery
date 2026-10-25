import { describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/principal.js";
import { searchFanOut } from "../../src/http/search.js";

describe("issue search fan-out", () => {
  it("searches fewer repositories for anonymous callers than for signed-in ones", () => {
    expect(searchFanOut({ type: "anonymous" })).toBe(10);
    expect(searchFanOut({ type: "account" } as Principal)).toBe(50);
    expect(searchFanOut({ type: "repo-token", repoId: "r", token: "t" })).toBe(50);
  });
});
