import { describe, expect, it } from "vitest";
import { parse } from "graphql";
import { measure } from "../../src/http/graphql.js";
import { randomAlnum } from "../../src/lib/util.js";

describe("GraphQL limits", () => {
  it("counts fields and depth with fragments expanded where they're spread", () => {
    const doc = parse(`fragment pr on PullRequest { number title commits(last: 1) { nodes { commit { oid } } } }
      query { a: repository(owner: "o", name: "r") { p1: pullRequest(number: 1) { ...pr } p2: pullRequest(number: 2) { ...pr } } }`);
    // repository + 2 × (pullRequest + number + title + commits + nodes + commit + oid)
    expect(measure(doc)).toEqual({ fields: 15, depth: 6 });
  });

  it("doesn't loop on a fragment that spreads itself", () => {
    const doc = parse(`fragment f on Repository { id parent { ...f } } query { repository(owner: "o", name: "r") { ...f } }`);
    expect(measure(doc).fields).toBe(3);
  });
});

describe("randomAlnum", () => {
  it("draws letters and digits only, at the asked length", () => {
    for (const n of [1, 40, 200]) expect(randomAlnum(n)).toMatch(new RegExp(`^[A-Za-z0-9]{${n}}$`));
    expect(new Set(Array.from({ length: 20 }, () => randomAlnum(40))).size).toBe(20);
  });
});
