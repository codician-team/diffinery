import { describe, expect, it } from "vitest";
import { devAuth } from "../../src/auth/dev.js";

const dev = { DEV_AUTH: "dev@diffinery.local", ACCESS_AUD: "", PUBLIC_URL: "http://localhost:8787" };

describe("the development sign-in", () => {
  it("works only on this machine", () => {
    expect(devAuth(dev, "http://localhost:8787/api/v3/user")).toBe(true);
    expect(devAuth(dev, "http://127.0.0.1:41234/")).toBe(true);
    expect(devAuth(dev, "http://[::1]:8787/")).toBe(true);
    expect(devAuth(dev)).toBe(true);
  });

  it("does nothing when a deployed configuration keeps DEV_AUTH", () => {
    // Reached under a public name, whatever PUBLIC_URL says.
    expect(devAuth(dev, "https://diffinery-dev.example.workers.dev/")).toBe(false);
    expect(devAuth(dev, "https://localhost.evil.example/")).toBe(false);
    // A public PUBLIC_URL turns it off everywhere, request or not.
    const deployed = { ...dev, PUBLIC_URL: "https://diffinery.com" };
    expect(devAuth(deployed, "http://localhost:8787/")).toBe(false);
    expect(devAuth(deployed)).toBe(false);
    // So does Cloudflare Access, or no DEV_AUTH at all.
    expect(devAuth({ ...dev, ACCESS_AUD: "aud" }, "http://localhost:8787/")).toBe(false);
    expect(devAuth({ ...dev, DEV_AUTH: undefined }, "http://localhost:8787/")).toBe(false);
  });
});
