import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ImportSpec } from "@diffinery/shared";
import { batchBySize, furthestWithin, importDestination, importRefKind, isSecretRejection, isSizeRejection, parsePorcelain, parseSecretFindings, sortRefsForImport, storageRejection } from "../src/import-plan.js";
import { pushFailure, transfer } from "../src/importer.js";

describe("import chunk planning", () => {
  it("finds the furthest commit within budget with few probes", async () => {
    const sizes = [10, 25, 40, 70, 90, 140, 200];
    const probes: number[] = [];
    const at = async (i: number) => (probes.push(i), sizes[i]!);
    expect(await furthestWithin(sizes.length, at, 100)).toEqual({ index: 4, size: 90 });
    expect(probes.length).toBeLessThanOrEqual(4);
    expect(await furthestWithin(sizes.length, at, 1000)).toEqual({ index: 6, size: 200 });
    expect(await furthestWithin(sizes.length, at, 5)).toBeNull();
    expect(await furthestWithin(0, at, 100)).toBeNull();
    // Exactly on the budget counts as fitting.
    expect(await furthestWithin(sizes.length, at, 40)).toEqual({ index: 2, size: 40 });
  });

  it("batches objects by size, keeping oversized ones alone", () => {
    const items = [{ size: 30 }, { size: 30 }, { size: 50 }, { size: 500 }, { size: 10 }];
    expect(batchBySize(items, 100).map((b) => b.map((x) => x.size))).toEqual([[30, 30], [50], [500], [10]]);
    expect(batchBySize([], 100)).toEqual([]);
  });

  it("orders refs: default branch, branches, tags, then pull heads by number", () => {
    const refs = ["refs/pull/10/head", "refs/tags/v1", "refs/heads/zeta", "refs/pull/2/head", "refs/heads/main", "refs/heads/alpha"];
    expect(sortRefsForImport(refs, "main")).toEqual(["refs/heads/main", "refs/heads/alpha", "refs/heads/zeta", "refs/tags/v1", "refs/pull/2/head", "refs/pull/10/head"]);
    expect(importRefKind("refs/pull/3/merge")).toBeNull();
    expect(importRefKind("refs/notes/commits")).toBeNull();
    expect(importRefKind("refs/pull/3/head")).toBe("pull");
    expect(importRefKind("refs/heads/gh-readonly-queue/main/pr-3-abc")).toBeNull();
    expect(importDestination("refs/pull/3/head")).toBe("refs/diffinery-import/pull/3");
    expect(importDestination("refs/heads/main")).toBe("refs/heads/main");
  });

  it("reads push protection and size rejections from git output", () => {
    const out = "remote: Push protection bypassed by alice: Imported from GitHub o/r\nremote:   AWS access key in blob 0123456789\nremote:   Private key in blob abcdef0123\n";
    expect(parseSecretFindings(out)).toEqual([
      { kind: "AWS access key", blob: "0123456789" },
      { kind: "Private key", blob: "abcdef0123" },
    ]);
    expect(isSecretRejection("! [remote rejected] main -> main (secret detected (push protection))")).toBe(true);
    expect(isSizeRejection("remote: push exceeds 100 MB; split it into smaller pushes")).toBe(true);
    expect(isSizeRejection("error: RPC failed; HTTP 413 curl 22")).toBe(true);
    expect(isSizeRejection("! [rejected] main (non-fast-forward)")).toBe(false);
    expect(isSizeRejection("error: remote unpack failed: the push needs more memory than one push may use; split it into smaller pushes (Array buffer allocation failed)")).toBe(true);
    expect(storageRejection("remote: Push refused: acme has reached its storage limit of 1000 bytes (git objects); delete some        \nerror: failed to push some refs")).toBe("acme has reached its storage limit of 1000 bytes (git objects); delete some");
    expect(storageRejection("error: failed to push some refs")).toBeNull();
    expect(parsePorcelain("To x\n*\trefs/heads/a:refs/heads/a\t[new branch]\n!\trefs/heads/b:refs/heads/b\t[remote rejected] (invalid ref name)\nDone\n")).toEqual([
      { ref: "refs/heads/a", ok: true, reason: "[new branch]" },
      { ref: "refs/heads/b", ok: false, reason: "invalid ref name" },
    ]);
    // A failed push says why in the server's words, not git's generic last line.
    const generic = "error: failed to push some refs to 'https://diffinery.com/o/r.git'";
    expect(pushFailure({ stdout: "To x\n!\trefs/heads/b:refs/heads/b\t[remote rejected] (missing objects)\nDone\n", stderr: generic })).toBe("missing objects");
    const unpack = "error: remote unpack failed: pack checksum mismatch";
    expect(pushFailure({ stdout: "To x\n!\trefs/heads/b:refs/heads/b\t[remote rejected] (unpacker error)\nDone\n", stderr: `${unpack}\n${generic}` })).toBe("pack checksum mismatch");
    expect(pushFailure({ stdout: "", stderr: `remote: Push refused: bad tree\n${generic}` })).toBe("remote: Push refused: bad tree");
    expect(pushFailure({ stdout: "", stderr: generic })).toBe(generic);
  });
});

describe("import transfer (real git)", () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();

  // Real git with many pushes: well past vitest's 5 s default on a busy runner.
  it("pushes history in chunks under a size limit the server enforces, then every ref, and cleans up", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "diffinery-import-"));
    const work = path.join(root, "work");
    g(root, "init", "-q", "-b", "main", work);
    for (let i = 0; i < 12; i++) {
      writeFileSync(path.join(work, `f${i}.bin`), randomBytes(40 * 1024));
      g(work, "add", "-A");
      g(work, "commit", "-q", "-m", `c${i}`);
    }
    // A side branch merged back, and one commit too large for any single push.
    g(work, "checkout", "-q", "-b", "side", "HEAD~6");
    for (let i = 0; i < 4; i++) {
      writeFileSync(path.join(work, `s${i}.bin`), randomBytes(40 * 1024));
      g(work, "add", "-A");
      g(work, "commit", "-q", "-m", `s${i}`);
    }
    g(work, "checkout", "-q", "main");
    g(work, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    for (let i = 0; i < 5; i++) writeFileSync(path.join(work, `big${i}.bin`), randomBytes(60 * 1024));
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "big");
    g(work, "tag", "-a", "v1", "-m", "release 1");
    g(work, "tag", "light");
    const source = path.join(root, "source.git");
    g(root, "clone", "-q", "--bare", work, source);
    g(source, "update-ref", "refs/pull/7/head", g(work, "rev-parse", "side"));
    g(source, "update-ref", "refs/pull/7/merge", g(work, "rev-parse", "main"));
    g(source, "update-ref", "refs/heads/gh-readonly-queue/main/pr-7-abc", g(work, "rev-parse", "main"));

    // The "server": a bare repository whose pre-receive hook refuses packs over 150 KB.
    const target = path.join(root, "target.git");
    g(root, "init", "-q", "--bare", target);
    g(target, "config", "receive.advertisePushOptions", "true");
    const hook = path.join(target, "hooks", "pre-receive");
    const sizes = path.join(root, "sizes.log");
    writeFileSync(
      hook,
      `#!/bin/sh
size=$(du -sb "$GIT_QUARANTINE_PATH" 2>/dev/null | cut -f1)
echo "$size $GIT_PUSH_OPTION_0" >> "${sizes}"
if [ "\${size:-0}" -gt 153600 ]; then echo "push exceeds 100 MB; split it into smaller pushes"; exit 1; fi
`,
    );
    chmodSync(hook, 0o755);

    const spec: ImportSpec = {
      importId: "t1",
      source: { fullName: "octo/repo", cloneUrl: `file://${source}`, defaultBranch: "main" },
      githubToken: null,
      target: { fullName: "me/repo", pushUrl: `file://${target}` },
      pushToken: "dfy_test",
      lfs: false,
      secrets: "bypass",
      bypassReason: "Imported from GitHub octo/repo",
      // Deliberately larger than what the server accepts: the agent must split further.
      chunkBytes: 1024 * 1024,
    };
    const phases: string[] = [];
    const result = await transfer(spec, { workRoot: path.join(root, "agent"), progress: async (p) => void phases.push(p.phase), log: () => {} });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result).toMatchObject({ branches: 2, tags: 2, pullRefs: 1, defaultBranch: "main" });
    expect(result.chunks).toBeGreaterThan(3);
    expect(phases).toContain("push");

    const refsOf = (dir: string) => g(dir, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").sort();
    // Pull request heads wait in the import namespace for the server; merge refs and merge queue branches are skipped.
    const expected = refsOf(source)
      .filter((l) => !l.startsWith("refs/pull/7/merge") && !l.startsWith("refs/heads/gh-readonly-queue/"))
      .map((l) => l.replace("refs/pull/7/head", "refs/diffinery-import/pull/7"))
      .sort();
    expect(refsOf(target)).toEqual(expected);
    g(target, "fsck", "--no-progress");
    // Every accepted push carried the import option, and the oversized ones were refused, then split.
    const log = readFileSync(sizes, "utf8").trim().split("\n");
    expect(log.every((l) => l.endsWith("diffinery-import"))).toBe(true);
    expect(log.some((l) => Number(l.split(" ")[0]) > 153600)).toBe(true);
  }, 30_000);
  it("pushes every version of a large file first and whole, so the server never rebuilds one from a delta", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "diffinery-import-"));
    const work = path.join(root, "work");
    g(root, "init", "-q", "-b", "main", work);
    // A large text file in six versions (git stores them as deltas of each other), and small random files.
    let lines = Array.from({ length: 6000 }, (_, i) => `line ${i} ${randomBytes(12).toString("hex")}`);
    for (let v = 0; v < 6; v++) {
      lines = lines.map((l, i) => (i % 500 === v ? `${l} v${v}` : l));
      writeFileSync(path.join(work, "data.txt"), lines.join("\n"));
      writeFileSync(path.join(work, `small${v}.bin`), randomBytes(2048));
      g(work, "add", "-A");
      g(work, "commit", "-q", "-m", `v${v}`);
    }
    const source = path.join(root, "source.git");
    g(root, "clone", "-q", "--bare", work, source);
    g(source, "repack", "-adq");
    const target = path.join(root, "target.git");
    g(root, "init", "-q", "--bare", target);
    g(target, "config", "receive.advertisePushOptions", "true");
    // Pushes are kept as packs (not unpacked to loose objects), so the hook can look at them.
    g(target, "config", "receive.unpackLimit", "1");
    // The "server" refuses a push that holds a file as a delta, as Diffinery does past its memory.
    const hook = path.join(target, "hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh
for idx in "$GIT_QUARANTINE_PATH"/pack/*.idx; do
  [ -f "$idx" ] || continue
  if git verify-pack -v "$idx" | awk '$2 == "blob" && NF >= 7 { found = 1 } END { exit !found }'; then
    echo "pack needs more than 80 MiB of memory to unpack; split it into smaller pushes"; exit 1
  fi
done
`,
    );
    chmodSync(hook, 0o755);
    const spec: ImportSpec = {
      importId: "t3",
      source: { fullName: "octo/data", cloneUrl: `file://${source}`, defaultBranch: "main" },
      githubToken: null,
      target: { fullName: "me/data", pushUrl: `file://${target}` },
      pushToken: "dfy_test",
      lfs: false,
      secrets: "bypass",
      bypassReason: "Imported from GitHub octo/data",
      chunkBytes: 1024 * 1024,
    };
    const result = await transfer(spec, { workRoot: path.join(root, "agent"), largeBlobBytes: 64 * 1024, progress: async () => {}, log: () => {} });
    expect(result.ok).toBe(true);
    expect(g(target, "rev-parse", "refs/heads/main")).toBe(g(work, "rev-parse", "HEAD"));
    g(target, "fsck", "--no-progress");
  });

  it("splits a refused batch of a large commit's files again, rather than retrying it whole", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "diffinery-import-"));
    const work = path.join(root, "work");
    g(root, "init", "-q", "-b", "main", work);
    // One commit over the budget, of files that each fit in a push the server takes, but not all together.
    for (let i = 0; i < 8; i++) writeFileSync(path.join(work, `f${i}.bin`), randomBytes(40 * 1024));
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "many files");
    const source = path.join(root, "source.git");
    g(root, "clone", "-q", "--bare", work, source);
    const target = path.join(root, "target.git");
    g(root, "init", "-q", "--bare", target);
    g(target, "config", "receive.advertisePushOptions", "true");
    // Every push is kept as the pack that came (git otherwise stores only the objects it lacks), so
    // the commit itself must come without the files its batches already brought.
    g(target, "config", "receive.unpackLimit", "1");
    const hook = path.join(target, "hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh
size=$(du -sb "$GIT_QUARANTINE_PATH" 2>/dev/null | cut -f1)
if [ "\${size:-0}" -gt 153600 ]; then echo "pack takes more than 500 reads (or 1 bytes) of storage to unpack; split it into smaller pushes"; exit 1; fi
`,
    );
    chmodSync(hook, 0o755);
    const spec: ImportSpec = {
      importId: "t2",
      source: { fullName: "octo/many", cloneUrl: `file://${source}`, defaultBranch: "main" },
      githubToken: null,
      target: { fullName: "me/many", pushUrl: `file://${target}` },
      pushToken: "dfy_test",
      lfs: false,
      secrets: "bypass",
      bypassReason: "Imported from GitHub octo/many",
      // The commit is batched at 256 KB (six files), which the server refuses.
      chunkBytes: 256 * 1024,
    };
    const result = await transfer(spec, { workRoot: path.join(root, "agent"), progress: async () => {}, log: () => {} });
    expect(result.ok).toBe(true);
    expect(g(target, "rev-parse", "refs/heads/main")).toBe(g(work, "rev-parse", "HEAD"));
    g(target, "fsck", "--no-progress");
  }, 30_000);
});
