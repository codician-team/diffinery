import { describe, expect, it } from "vitest";
import { movedLoginPath, movedPath, movedStatus } from "../../src/lib/redirects.js";

const from = { owner: "codician-team", name: "diffinery" };
const to = { owner: "codician", name: "diffinery" };

describe("moved repository paths", () => {
  it("rewrites web pages and keeps the rest of the path", () => {
    expect(movedPath("/codician-team/diffinery", from, to)).toBe("/codician/diffinery");
    expect(movedPath("/codician-team/diffinery/blob/main/README.md", from, to)).toBe("/codician/diffinery/blob/main/README.md");
    expect(movedPath("/codician-team/diffinery/issues/", from, to)).toBe("/codician/diffinery/issues/");
  });

  it("rewrites REST paths", () => {
    expect(movedPath("/api/v3/repos/codician-team/diffinery/issues/3", from, to)).toBe("/api/v3/repos/codician/diffinery/issues/3");
    expect(movedPath("/api/v3/repos/codician-team/diffinery", from, { owner: "codician", name: "forge" })).toBe("/api/v3/repos/codician/forge");
  });

  it("keeps a .git suffix on Git URLs", () => {
    expect(movedPath("/codician-team/diffinery.git/info/refs", from, to)).toBe("/codician/diffinery.git/info/refs");
    expect(movedPath("/codician-team/diffinery/info/refs", from, to)).toBe("/codician/diffinery/info/refs");
  });

  it("matches owner and name without regard to case, like the directory", () => {
    expect(movedPath("/Codician-Team/Diffinery/pulls", from, to)).toBe("/codician/diffinery/pulls");
  });

  it("only rewrites a whole owner/name pair", () => {
    expect(movedPath("/codician-team/diffinery-old/pulls", from, to)).toBeNull();
    expect(movedPath("/codician-team-2/diffinery", from, to)).toBeNull();
    expect(movedPath("/codician-team", from, to)).toBeNull();
  });

  it("is null when the name came from somewhere other than the path", () => {
    expect(movedPath("/mcp", from, to)).toBeNull();
    expect(movedPath("/settings/files", from, to)).toBeNull();
  });

  it("encodes the new names and survives malformed escapes", () => {
    expect(movedPath("/codician-team/diffinery/tree/a%2Fb", from, { owner: "x", name: "y" })).toBe("/x/y/tree/a%2Fb");
    expect(movedPath("/%E0%A4%A/diffinery", from, to)).toBeNull();
  });
});

describe("renamed account paths", () => {
  it("rewrites the first segment only", () => {
    expect(movedLoginPath("/old-org", "old-org", "new-org")).toBe("/new-org");
    expect(movedLoginPath("/Old-Org/site/issues", "old-org", "new-org")).toBe("/new-org/site/issues");
    expect(movedLoginPath("/other/old-org", "old-org", "new-org")).toBeNull();
  });
});

describe("moved status", () => {
  it("is 301 for reads and 307 for everything else, as on GitHub", () => {
    expect(movedStatus("GET")).toBe(301);
    expect(movedStatus("HEAD")).toBe(301);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(movedStatus(m)).toBe(307);
  });
});
