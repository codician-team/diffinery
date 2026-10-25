import { unzip, zip } from "../lib/archive.js";

/** The URL the plugins' "Diffinery URL" setting (userConfig `url`) defaults to in their sources. */
export const PLUGIN_DEFAULT_URL = "https://diffinery.com";
const MANIFEST = ".claude-plugin/plugin.json";
// The fixed timestamp scripts/pack-plugins.py gives every entry, so a rewrite of the same zip is the same bytes.
const STAMP = Date.UTC(2026, 0, 1) / 1000;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * A Claude Code plugin zip as `origin` serves it. A self-hosted instance's copy defaults the plugin's
 * Diffinery URL setting to that instance, so a plugin uploaded to claude.ai or set up by `diffinery setup`
 * from there reaches it with nothing to configure; diffinery.com serves the zip as packed.
 */
export async function pluginZipFor(origin: string, packed: Uint8Array, sha256: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  if (origin === PLUGIN_DEFAULT_URL) return { bytes: packed, sha256 };
  const entries = await unzip(packed);
  let changed = false;
  const out = entries.map((e) => {
    if ("dir" in e || e.path !== MANIFEST) return e;
    const manifest = JSON.parse(new TextDecoder().decode(e.content)) as { userConfig?: { url?: { default?: unknown } } };
    const url = manifest.userConfig?.url;
    if (!url || url.default !== PLUGIN_DEFAULT_URL) return e;
    url.default = origin;
    changed = true;
    return { ...e, content: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) };
  });
  if (!changed) return { bytes: packed, sha256 };
  const bytes = await zip(out, STAMP);
  return { bytes, sha256: hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)) };
}
