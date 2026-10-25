// A fresh local database for an end-to-end test's `wrangler dev --persist-to` directory, with
// every migration applied.
//
// `wrangler d1 migrations apply --local` takes about 20 s (most of a test file's start), and
// every file used to pay it. The first call in a run applies the migrations once, the same way,
// into a template in the OS temp directory; every call then copies that template, which takes
// milliseconds. The template's name carries a hash of the migrations, the Wrangler config and
// Wrangler's version, so a change to any of them builds a new one. It is built in a directory
// of its own and renamed into place, so test files starting side by side never copy half of one.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Copies a database with every migration applied into `persist` (the `--persist-to` directory). */
export function migratedState(app, persist) {
  const migrations = join(app, "migrations");
  const hash = createHash("sha256");
  for (const name of readdirSync(migrations).sort()) hash.update(`${name}\0`).update(readFileSync(join(migrations, name))).update("\0");
  hash.update(readFileSync(join(app, "wrangler.jsonc")));
  hash.update(createRequire(join(app, "package.json"))("wrangler/package.json").version);
  const template = join(tmpdir(), `diffinery-e2e-d1-${hash.digest("hex").slice(0, 16)}`);
  if (!existsSync(template)) {
    const building = `${template}.building-${process.pid}-${randomBytes(4).toString("hex")}`;
    execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "diffinery-dev", "--local", "-e", "dev", "--persist-to", building], { cwd: app, stdio: "pipe", env: { ...process.env, CI: "1" } });
    try {
      renameSync(building, template);
    } catch (e) {
      // Another test file finished the same template first.
      if (!existsSync(template)) throw e;
      rmSync(building, { recursive: true, force: true });
    }
  }
  cpSync(template, persist, { recursive: true });
}
