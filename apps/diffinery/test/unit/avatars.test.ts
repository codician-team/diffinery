import { describe, expect, it } from "vitest";
import { avatarHue, avatarInitial, avatarPath, avatarSize, initialsSvg } from "../../src/http/avatars.js";

describe("avatar URLs and initials", () => {
  it("snaps requested sizes to the stored ones", () => {
    expect([1, 20, 64, 65, 128, 129, 256, 4000].map(avatarSize)).toEqual([64, 64, 64, 128, 128, 256, 256, 256]);
  });

  it("builds image paths with an optional size and version", () => {
    expect(avatarPath("dev")).toBe("/api/avatars/dev");
    expect(avatarPath("dev", 128)).toBe("/api/avatars/dev");
    expect(avatarPath("dev", 64, 1791892043)).toBe("/api/avatars/dev?s=64&v=1791892043");
    expect(avatarPath("a.b", 256, null)).toBe("/api/avatars/a.b?s=256");
  });

  it("draws initials like the old .av span: same hue hash, first letter or digit", () => {
    // The hash the web UI used before pictures (h * 31 + code, mod 360).
    const old = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % 360;
    for (const login of ["dev", "acme", "Claude-bot", "x"]) expect(avatarHue(login)).toBe(old(login));
    expect(avatarInitial("dev")).toBe("D");
    expect(avatarInitial("-9lives")).toBe("9");
    expect(avatarInitial("---")).toBe("?");
    const svg = initialsSvg("dev", 64);
    expect(svg).toContain(`fill="hsl(${avatarHue("dev")},55%,55%)"`);
    expect(svg).toContain('width="64" height="64"');
    expect(svg).toMatch(/>D<\/text><\/svg>$/);
    // Logins are restricted, but the SVG never carries more than one [A-Za-z0-9?] character of them.
    expect(initialsSvg("<script>", 128)).toMatch(/>S<\/text>/);
  });
});
