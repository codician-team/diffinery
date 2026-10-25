#!/usr/bin/env python3
"""Packs each Claude Code plugin under plugins/ into dist/<name>-<version>.zip.

The zip has the plugin's files at its root (.claude-plugin/plugin.json first), which is what
claude.ai's Customize > Plugins > Add > Upload plugin and `claude --plugin-dir <zip>` take.
Tests and the Codex-only parts stay out. The output is byte-for-byte reproducible: sorted
entries, a fixed timestamp and fixed permissions, so a rebuild of the same sources is the
same file (Diffinery serves a copy of these zips; see apps/diffinery/claude-plugins/README.md).

  python3 scripts/pack-plugins.py            # every plugin
  python3 scripts/pack-plugins.py diffinery-ci
"""
import json
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {"tests", ".codex-plugin", "codex-skills", "node_modules"}
# Codex reads its own MCP config: Codex substitutes no ${user_config.*} values.
SKIP_FILES = {"codex.mcp.json"}
STAMP = (2026, 1, 1, 0, 0, 0)


def files(plugin: pathlib.Path):
    out = []
    for p in plugin.rglob("*"):
        rel = p.relative_to(plugin)
        if not p.is_file() or any(part in SKIP_DIRS for part in rel.parts) or rel.as_posix() in SKIP_FILES:
            continue
        # The engine lays generated type files beside a mod it loads from a working folder.
        if rel.parts[:2] == (".claude-plugin", "types"):
            continue
        out.append(rel)
    manifest = pathlib.Path(".claude-plugin/plugin.json")
    return sorted(out, key=lambda r: (r != manifest, r.as_posix()))


def pack(plugin: pathlib.Path) -> pathlib.Path:
    meta = json.loads((plugin / ".claude-plugin/plugin.json").read_text())
    dest = ROOT / "dist" / f"{meta['name']}-{meta['version']}.zip"
    dest.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files(plugin):
            info = zipfile.ZipInfo(rel.as_posix(), STAMP)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, (plugin / rel).read_bytes())
    return dest


def main() -> None:
    names = sys.argv[1:] or sorted(p.name for p in (ROOT / "plugins").iterdir() if (p / ".claude-plugin/plugin.json").is_file())
    for name in names:
        print(pack(ROOT / "plugins" / name).relative_to(ROOT))


if __name__ == "__main__":
    main()
