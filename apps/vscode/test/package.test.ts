import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script without type declarations
import { manifestFor, packageExtension, vsixManifest } from "../scripts/package.mjs";

const pkg = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8"));
const updateDefault = (m: typeof pkg): boolean => m.contributes.configuration.properties["diffinery.checkForUpdates"].default;

describe("package.mjs", () => {
  it("keeps the self-update check on for diffinery.com's build and turns it off for marketplaces", () => {
    expect(updateDefault(manifestFor(pkg))).toBe(true);
    expect(updateDefault(manifestFor(pkg, { marketplace: true }))).toBe(false);
    expect(updateDefault(pkg)).toBe(true);
    expect(manifestFor(pkg, { marketplace: true })).toMatchObject({ name: "diffinery", publisher: "codician", license: "Apache-2.0" });
  });

  it("ships the license in both builds", async () => {
    for (const marketplace of [false, true]) {
      const { vsix } = await packageExtension({ marketplace });
      const text = Buffer.from(vsix).toString("latin1");
      expect(text).toContain("extension/LICENSE.txt");
    }
    expect(vsixManifest(manifestFor(pkg))).toContain('<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />');
  });
});
