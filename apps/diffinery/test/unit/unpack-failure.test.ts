import { describe, expect, it } from "vitest";
import { unpackFailure } from "../../src/git/protocol.js";

describe("unpack failures", () => {
  it("say to split a push that ran out of memory, so clients and the importer push smaller chunks", () => {
    expect(unpackFailure(new RangeError("Array buffer allocation failed"))).toBe("the push needs more memory than one push may use; split it into smaller pushes (Array buffer allocation failed)");
    expect(unpackFailure(new Error("Out of memory"))).toMatch(/split it into smaller pushes/);
  });
  it("pass other errors through as they are", () => {
    expect(unpackFailure(new Error("pack checksum mismatch"))).toBe("pack checksum mismatch");
    expect(unpackFailure("odd")).toBe("odd");
  });
});
