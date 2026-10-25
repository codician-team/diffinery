// Reads the plugin zip in apps/jetbrains/dist for Diffinery's server build (apps/diffinery/scripts/build-docs.mjs),
// which serves it at /-/jetbrains/. The zip is checked in because the server's build has no JDK, so this refuses one
// that doesn't match the sources: its version must be gradle.properties' pluginVersion, and the fingerprint of
// src/main built into it (see sourcesFingerprint in build.gradle.kts) must match the sources as they are now.
// Rebuild it with `./gradlew dist`.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The entries of a zip file, by name. Enough of the format for what Gradle writes: stored or deflated, no zip64. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name.endsWith("/")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) entries.set(name, raw);
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error(`${name}: zip method ${method} isn't supported`);
  }
  return entries;
}

/** The same fingerprint of src/main as build.gradle.kts computes. */
export async function sourcesFingerprint() {
  const src = path.join(root, "src/main");
  const files = (await readdir(src, { recursive: true, withFileTypes: true })).filter((d) => d.isFile()).map((d) => path.relative(src, path.join(d.parentPath, d.name)).split(path.sep).join("/"));
  files.sort();
  let listing = "";
  for (const f of files) listing += `${f} ${sha256(await readFile(path.join(src, f)))}\n`;
  return sha256(listing);
}

export async function readPlugin() {
  const props = Object.fromEntries(
    (await readFile(path.join(root, "gradle.properties"), "utf8"))
      .split("\n")
      .filter((l) => /^\w+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const version = props.pluginVersion;
  const fileName = `diffinery-jetbrains-${version}.zip`;
  const rebuild = "rebuild it with `./gradlew dist` in apps/jetbrains (see apps/jetbrains/README.md)";
  const inDist = (await readdir(path.join(root, "dist")).catch(() => [])).filter((f) => f.endsWith(".zip"));
  if (!inDist.includes(fileName)) throw new Error(`apps/jetbrains/dist/${fileName} is missing: ${rebuild}`);
  if (inDist.length > 1) throw new Error(`apps/jetbrains/dist has more than one zip (${inDist.join(", ")}): keep only ${fileName}`);
  const zip = await readFile(path.join(root, "dist", fileName));
  const jarName = `diffinery-jetbrains/lib/diffinery-jetbrains-${version}.jar`;
  const jarBytes = unzip(zip).get(jarName);
  if (!jarBytes) throw new Error(`apps/jetbrains/dist/${fileName} has no ${jarName}: ${rebuild}`);
  const jar = unzip(jarBytes);
  const xml = jar.get("META-INF/plugin.xml")?.toString("utf8") ?? "";
  const built = jar.get("META-INF/diffinery-sources.sha256")?.toString("utf8").trim();
  if (built !== (await sourcesFingerprint())) throw new Error(`apps/jetbrains/dist/${fileName} was built from other sources than apps/jetbrains/src/main: ${rebuild}`);
  const attr = (re) => xml.match(re)?.[1];
  const id = attr(/<id>([^<]+)<\/id>/);
  const sinceBuild = attr(/since-build="([^"]+)"/);
  if (id !== "com.diffinery" || attr(/<version>([^<]+)<\/version>/) !== version || sinceBuild !== props.sinceBuild)
    throw new Error(`apps/jetbrains/dist/${fileName}: its plugin.xml doesn't match gradle.properties: ${rebuild}`);
  return { id, version, sinceBuild, fileName, zip, description: attr(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.trim() ?? "" };
}
