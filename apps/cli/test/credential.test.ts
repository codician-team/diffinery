import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCredentialInput } from "../src/commands/auth.js";
import { isolatedEnv, run, tempDir } from "./helpers.js";

describe("git credential helper", () => {
  const env = isolatedEnv({ DIFFINERY_URL: "https://forge.example.com", DIFFINERY_TOKEN: "dfy_secret" });

  it("parses key=value lines up to the blank line", () => {
    expect(parseCredentialInput("protocol=https\nhost=a.b\npath=x/y.git\n\nignored=1\n")).toEqual({ protocol: "https", host: "a.b", path: "x/y.git" });
  });

  it("answers get for the configured host", async () => {
    const r = await run(["auth", "git-credential", "get"], { env, stdin: "protocol=https\nhost=forge.example.com\n\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("protocol=https\nhost=forge.example.com\nusername=x-token\npassword=dfy_secret\n");
  });

  it("stays silent for other hosts, other protocols and other operations", async () => {
    for (const stdin of ["protocol=https\nhost=github.com\n\n", "protocol=http\nhost=forge.example.com\n\n"]) {
      const r = await run(["auth", "git-credential", "get"], { env, stdin });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    for (const op of ["store", "erase"]) {
      const r = await run(["auth", "git-credential", op], { env, stdin: "protocol=https\nhost=forge.example.com\nusername=x\npassword=y\n\n" });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("matches hosts with ports", async () => {
    const e = { ...env, DIFFINERY_URL: "http://127.0.0.1:8787" };
    const r = await run(["auth", "git-credential", "get"], { env: e, stdin: "protocol=http\nhost=127.0.0.1:8787\n" });
    expect(r.stdout).toContain("password=dfy_secret");
  });

  it("prints nothing without a token", async () => {
    const e = { ...env };
    delete e.DIFFINERY_TOKEN;
    const r = await run(["auth", "git-credential", "get"], { env: e, stdin: "protocol=https\nhost=forge.example.com\n" });
    expect(r.stdout).toBe("");
  });

  it("auth setup-git configures a URL-scoped helper in the global git config", async () => {
    const r = await run(["auth", "setup-git"], { env });
    expect(r.code).toBe(0);
    const helpers = execFileSync("git", ["config", "--global", "--get-all", "credential.https://forge.example.com.helper"], { env }).toString().split("\n");
    expect(helpers.slice(0, 2)).toEqual(["", "!diffinery auth git-credential"]);
    // Idempotent.
    await run(["auth", "setup-git"], { env });
    expect(execFileSync("git", ["config", "--global", "--get-all", "credential.https://forge.example.com.helper"], { env }).toString().split("\n").slice(0, -1)).toEqual(["", "!diffinery auth git-credential"]);
  });

  it("auth setup-gh signs gh in to the host with the token on stdin, never in its arguments", async () => {
    const bin = tempDir("diffinery-fake-gh-");
    const seen = path.join(bin, "seen");
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s ' "$@" > "${seen}.args"\ncat > "${seen}.stdin"\n`);
    chmodSync(path.join(bin, "gh"), 0o755);
    const e = { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` };
    const r = await run(["auth", "setup-gh"], { env: e });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("gh is signed in to forge.example.com");
    expect(r.stdout).not.toContain("dfy_secret");
    expect(readFileSync(`${seen}.args`, "utf8").trim()).toBe("auth login --hostname forge.example.com --with-token --git-protocol https");
    expect(readFileSync(`${seen}.stdin`, "utf8")).toBe("dfy_secret\n");
  });

  it("auth setup-gh refuses plain HTTP, which gh doesn't speak", async () => {
    const r = await run(["auth", "setup-gh"], { env: { ...env, DIFFINERY_URL: "http://127.0.0.1:8787" } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("HTTPS");
  });
});
