// Builds the extension and packs it as a .vsix, the file VS Code, Cursor, Windsurf and VSCodium install.
//
//   node apps/vscode/scripts/package.mjs [--out dir] [--marketplace]
//
// writes <dir>/diffinery-<version>.vsix (default dir apps/vscode/dist). --marketplace writes
// diffinery-<version>-marketplace.vsix instead, the build for the Visual Studio Marketplace and Open VSX:
// the same extension with diffinery.checkForUpdates off by default, because the marketplace updates it.
//
// apps/diffinery/scripts/build-docs.mjs calls packageExtension() too, so the Worker serves the build at
// /-/vscode/diffinery.vsix. The .vsix has the layout `vsce package` writes (extension.vsixmanifest,
// [Content_Types].xml, extension/…), so it can also go to the Visual Studio Marketplace and Open VSX
// unchanged. Packing it here keeps @vscode/vsce and its dependencies out of every CI install. File dates
// are fixed, so the same sources always give the same bytes (and the same published digest).
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_NAME = "diffinery";

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The manifest as installed: the workspace package's fields, named for the editor (publisher.name = codician.diffinery).
 * A marketplace build turns the extension's own update check off by default, so it doesn't offer diffinery.com's
 * build next to the marketplace's updates.
 */
export function manifestFor(pkg, { marketplace = false } = {}) {
  const { scripts: _s, devDependencies: _d, dependencies: _deps, private: _p, ...rest } = structuredClone(pkg);
  if (marketplace) rest.contributes.configuration.properties["diffinery.checkForUpdates"].default = false;
  return { ...rest, name: EXTENSION_NAME };
}

export function vsixManifest(m) {
  const props = [
    ["Microsoft.VisualStudio.Code.Engine", m.engines.vscode],
    ["Microsoft.VisualStudio.Code.ExtensionDependencies", (m.extensionDependencies ?? []).join(",")],
    ["Microsoft.VisualStudio.Code.ExtensionPack", ""],
    ["Microsoft.VisualStudio.Code.ExtensionKind", (m.extensionKind ?? ["workspace"]).join(",")],
    ["Microsoft.VisualStudio.Code.LocalizedLanguages", ""],
    ["Microsoft.VisualStudio.Services.Links.Source", m.repository.url],
    ["Microsoft.VisualStudio.Services.Links.Getstarted", m.repository.url],
    ["Microsoft.VisualStudio.Services.Links.Support", m.bugs.url],
    ["Microsoft.VisualStudio.Services.Links.Learn", m.homepage],
    ["Microsoft.VisualStudio.Services.Branding.Color", m.galleryBanner.color],
    ["Microsoft.VisualStudio.Services.Branding.Theme", m.galleryBanner.theme],
    ["Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown", "true"],
    ["Microsoft.VisualStudio.Services.Content.Pricing", "Free"],
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(m.name)}" Version="${xml(m.version)}" Publisher="${xml(m.publisher)}" />
    <DisplayName>${xml(m.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(m.description)}</Description>
    <Tags>${xml((m.keywords ?? []).join(","))}</Tags>
    <Categories>${xml(m.categories.join(","))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
${props.map(([k, v]) => `      <Property Id="${k}" Value="${xml(v)}" />`).join("\n")}
    </Properties>
    <Icon>extension/${xml(m.icon)}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xml(m.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function contentTypes(names) {
  const types = { ".json": "application/json", ".js": "application/javascript", ".md": "text/markdown", ".txt": "text/plain", ".png": "image/png", ".woff": "font/woff", ".vsixmanifest": "text/xml" };
  const exts = [...new Set(names.map((n) => path.extname(n).toLowerCase()).filter((e) => e && types[e]))].sort();
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${exts.map((e) => `<Default Extension="${e}" ContentType="${types[e]}"/>`).join("")}</Types>
`;
}

// ---------------------------------------------------------------- a small, deterministic zip writer

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// 2026-01-01 00:00 in MS-DOS date/time.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(data);
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** Builds and packs the extension (for a marketplace with `marketplace: true`). Returns its version and the .vsix bytes. */
export async function packageExtension({ marketplace = false } = {}) {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const manifest = manifestFor(pkg, { marketplace });
  const bundle = await build({
    entryPoints: [path.join(ROOT, "src/extension.ts")],
    bundle: true,
    minify: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    external: ["vscode"],
    legalComments: "none",
    write: false,
    logLevel: "error",
  });
  const files = [
    ["extension/package.json", JSON.stringify(manifest, null, 2)],
    ["extension/readme.md", await readFile(path.join(ROOT, "README.md"))],
    ["extension/changelog.md", await readFile(path.join(ROOT, "CHANGELOG.md"))],
    ["extension/LICENSE.txt", await readFile(path.join(ROOT, "../../LICENSE"))],
    ["extension/dist/extension.js", bundle.outputFiles[0].contents],
    [`extension/${manifest.icon}`, await readFile(path.join(ROOT, manifest.icon))],
    ["extension/media/diffinery-icons.woff", await readFile(path.join(ROOT, "media/diffinery-icons.woff"))],
  ];
  const entries = [
    { name: "extension.vsixmanifest", data: vsixManifest(manifest) },
    { name: "[Content_Types].xml", data: contentTypes(["extension.vsixmanifest", ...files.map(([n]) => n)]) },
    ...files.map(([name, data]) => ({ name, data })),
  ];
  return { version: manifest.version, vsix: zip(entries) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(ROOT, "dist");
  const marketplace = process.argv.includes("--marketplace");
  const { version, vsix } = await packageExtension({ marketplace });
  await mkdir(out, { recursive: true });
  const file = path.join(out, `${EXTENSION_NAME}-${version}${marketplace ? "-marketplace" : ""}.vsix`);
  await writeFile(file, vsix);
  console.log(`vscode: ${path.relative(process.cwd(), file)} (${(vsix.length / 1024).toFixed(0)} KB)`);
}
