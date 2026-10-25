import { describe, expect, it } from "vitest";
import { d1Session, isBookmark, sessionConstraint } from "../../src/lib/d1.js";
import type { Env } from "../../src/env.js";

const BM = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";

describe("D1 sessions", () => {
  it("recognises bookmarks and nothing else", () => {
    expect(isBookmark(BM)).toBe(true);
    expect(isBookmark("first-primary")).toBe(false);
    expect(isBookmark("x; Path=/")).toBe(false);
    expect(isBookmark(`${BM}${"0".repeat(200)}`)).toBe(false);
    expect(isBookmark(undefined)).toBe(false);
  });

  it("starts browsers from their cookie and token clients from the primary", () => {
    expect(sessionConstraint({ token: false })).toBe("first-unconstrained");
    expect(sessionConstraint({ token: false, cookie: BM })).toBe(BM);
    expect(sessionConstraint({ token: false, cookie: "junk" })).toBe("first-unconstrained");
    expect(sessionConstraint({ token: true, cookie: BM })).toBe("first-primary");
    expect(sessionConstraint({ token: true, header: BM })).toBe(BM);
    expect(sessionConstraint({ token: false, header: BM, cookie: "00000001-00000001" })).toBe(BM);
  });

  it("wraps the binding in a session and reports its bookmark", () => {
    const seen: string[] = [];
    const DB = { withSession: (c: string) => (seen.push(c), { prepare: () => null, batch: async () => [], getBookmark: () => BM }) };
    const s = d1Session({ DB } as unknown as Env, "first-primary");
    expect(seen).toEqual(["first-primary"]);
    expect(s.bookmark()).toBe(BM);
    expect(typeof s.env.DB.prepare).toBe("function");
    // Without withSession (test doubles), the binding is used as is.
    const plain = { prepare: () => null } as unknown as D1Database;
    expect(d1Session({ DB: plain } as unknown as Env, "first-primary").env.DB).toBe(plain);
  });
});
