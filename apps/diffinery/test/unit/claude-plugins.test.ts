import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginZipFor } from "../../src/docs/claude-plugins.js";
import { unzip } from "../../src/lib/archive.js";

const dec = new TextDecoder();
const dir = new URL("../../claude-plugins/", import.meta.url);

/** The checked-in zip of one plugin (claude-plugins/<name>-<version>.zip), as the build embeds it. */
function packed(name: string): { bytes: Uint8Array; sha256: string } {
  const file = readdirSync(dir).find((f) => new RegExp(`^${name}-\\d+\\.\\d+\\.\\d+\\.zip$`).test(f))!;
  const bytes = new Uint8Array(readFileSync(new URL(file, dir)));
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const files = async (bytes: Uint8Array) =>
  Object.fromEntries((await unzip(bytes)).map((e) => ["dir" in e ? e.path : e.path, "dir" in e ? "" : dec.decode(e.content)]));

describe("Claude Code plugins served by an instance", () => {
  for (const name of ["diffinery", "diffinery-ci"]) {
    it(`${name}: diffinery.com serves the packed zip as it is`, async () => {
      const p = packed(name);
      const out = await pluginZipFor("https://diffinery.com", p.bytes, p.sha256);
      expect(out.bytes).toBe(p.bytes);
      expect(out.sha256).toBe(p.sha256);
    });

    it(`${name}: a self-hosted instance defaults the Diffinery URL setting to itself and changes nothing else`, async () => {
      const p = packed(name);
      const before = await files(p.bytes);
      const out = await pluginZipFor("https://git.example.com", p.bytes, p.sha256);
      expect(out.sha256).toBe(createHash("sha256").update(out.bytes).digest("hex"));
      const after = await files(out.bytes);
      expect(Object.keys(after)).toEqual(Object.keys(before));
      const manifest = JSON.parse(after[".claude-plugin/plugin.json"]!);
      expect(manifest.userConfig.url.default).toBe("https://git.example.com");
      expect({ ...manifest, userConfig: undefined }).toEqual({ ...JSON.parse(before[".claude-plugin/plugin.json"]!), userConfig: undefined });
      for (const f of Object.keys(before)) if (f !== ".claude-plugin/plugin.json") expect(after[f]).toBe(before[f]);
      // The same instance gets the same bytes every time (a fixed timestamp, as pack-plugins.py writes).
      expect((await pluginZipFor("https://git.example.com", p.bytes, p.sha256)).sha256).toBe(out.sha256);
    });
  }

  it("the diffinery plugin's MCP server follows the setting", async () => {
    const mcp = JSON.parse((await files(packed("diffinery").bytes))[".mcp.json"]!);
    expect(mcp.mcpServers.diffinery.url).toBe("${user_config.url}/mcp");
  });
});
