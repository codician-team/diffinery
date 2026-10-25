import { chmod, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Api } from "../api.js";
import type { Command } from "../cli.js";
import { CliError } from "../io.js";
import { VERSION } from "../version.js";

const SHEBANG = "#!/usr/bin/env node\n";

/** Replaces the file this CLI runs from with the server's current build (served at /-/cli/diffinery.mjs). */
export const upgradeCommand: Command = {
  name: "upgrade",
  summary: "Update the CLI to the server's latest build",
  description: `Downloads <server>/-/cli/diffinery.mjs and replaces the file this CLI runs from, when it changed.
The install script (curl -fsSL https://diffinery.com/install | bash) does the same and sets up PATH.`,
  maxArgs: 0,
  async run(ctx) {
    const cfg = await ctx.config();
    if (!ctx.io.selfPath) throw new CliError("can't tell which file this CLI runs from; reinstall with curl -fsSL https://diffinery.com/install | bash");
    const self = await realpath(ctx.io.selfPath);
    const current = await readFile(self, "utf8").catch(() => "");
    if (!current.startsWith(SHEBANG)) throw new CliError(`${self} isn't an installed diffinery CLI (running from source?); reinstall with curl -fsSL ${cfg.url}/install | bash`);
    const res = await new Api(cfg.url, null).raw<string>("GET", "/-/cli/diffinery.mjs", { text: true, headers: { accept: "text/javascript" } });
    const next = res.data;
    if (!next.startsWith(SHEBANG) || next.length < 10_000) throw new CliError(`${cfg.url}/-/cli/diffinery.mjs doesn't look like the CLI; nothing changed`);
    const version = res.headers.get("x-diffinery-cli-version") ?? VERSION;
    if (next === current) {
      ctx.out(`diffinery ${VERSION} is up to date.`);
      return;
    }
    // Write beside it and rename over it, so a failed download never leaves half a file.
    const tmp = path.join(path.dirname(self), `.diffinery-upgrade-${process.pid}.mjs`);
    try {
      await writeFile(tmp, next, { mode: 0o755 });
      await chmod(tmp, 0o755);
      await rename(tmp, self);
    } catch (e) {
      await rm(tmp, { force: true });
      throw new CliError(`couldn't replace ${self}: ${(e as Error).message}`);
    }
    ctx.out(`${ctx.c.green("✓")} Updated diffinery ${VERSION === version ? VERSION : `${VERSION} → ${version}`} (${self})`);
  },
};
