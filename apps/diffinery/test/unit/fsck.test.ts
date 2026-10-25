import { describe, expect, it } from "vitest";
import { MAX_COMMIT_BYTES, MAX_TREE_BYTES, fsckObjects, fsckSize, isDotGitmodulesName, unsafeGitmodules } from "../../src/git/fsck.js";

const enc = new TextEncoder();
const OID = "a".repeat(40);

function tree(...entries: Array<[mode: string, name: string, oid?: string]>): { oid: string; type: string; content: Uint8Array } {
  const parts: number[] = [];
  for (const [mode, name, oid = OID] of entries) {
    parts.push(...enc.encode(`${mode} ${name}\0`));
    for (let i = 0; i < 40; i += 2) parts.push(parseInt(oid.slice(i, i + 2), 16));
  }
  return { oid: "t".repeat(40), type: "tree", content: new Uint8Array(parts) };
}
const blob = (oid: string, text: string) => ({ oid, type: "blob", content: enc.encode(text) });

describe("fsck of pushed objects", () => {
  it("accepts ordinary trees", () => {
    expect(fsckObjects([tree(["100644", "README.md"], ["40000", "src"], ["120000", "link"], ["160000", "vendor"])])).toBeNull();
    expect(fsckObjects([tree(["100644", ".gitignore"], ["100644", "..."], ["100644", ".github"])])).toBeNull();
  });

  it.each([
    ["..", /not a valid name/],
    [".", /not a valid name/],
    ["", /empty name/],
    ["a/b", /contains '\/'/],
    [".git", /reserved/],
    [".GIT", /reserved/],
    [".git.", /reserved/],
    ["git~1", /reserved/],
    [".g‌it", /reserved/],
  ])("refuses a tree entry named %j", (name, why) => {
    expect(fsckObjects([tree(["40000", name])])).toMatch(why);
  });

  it("refuses duplicate entries", () => {
    expect(fsckObjects([tree(["100644", "a"], ["40000", "a"])])).toMatch(/duplicate entry 'a'/);
  });

  it("refuses a symlinked .gitmodules, in any spelling", () => {
    expect(fsckObjects([tree(["120000", ".gitmodules"])])).toMatch(/symbolic link/);
    expect(fsckObjects([tree(["120000", "GITMOD~1"])])).toMatch(/symbolic link/);
    expect(isDotGitmodulesName(".GitModules. ")).toBe(true);
  });

  it("refuses .gitmodules that escape .git/modules or pass options to git", () => {
    const bad = "b".repeat(40);
    expect(fsckObjects([tree(["100644", ".gitmodules", bad]), blob(bad, '[submodule "../../hooks"]\n\tpath = x\n\turl = https://example.com/x.git\n')])).toMatch(/can't contain '\.\.'/);
    expect(unsafeGitmodules('[submodule "x"]\n\turl = --upload-pack=touch /tmp/pwned\n')).toMatch(/url that starts with '-'/);
    expect(unsafeGitmodules('[submodule "x"]\n\tpath = "-x"\n')).toMatch(/path that starts with '-'/);
    expect(unsafeGitmodules('[submodule "a\\\\..\\\\b"]\n')).toMatch(/can't contain/);
    expect(unsafeGitmodules('[submodule "lib/x"]\n\tpath = lib/x\n\turl = ../x.git\n[core]\n\turl = -fine-outside-submodules\n')).toBeNull();
  });

  it("refuses malformed trees", () => {
    expect(fsckObjects([{ oid: "t".repeat(40), type: "tree", content: enc.encode("100644 broken") }])).toMatch(/malformed tree/);
  });

  it("refuses a tree too large to check, before reading its names", () => {
    // Entries of 36 bytes each: "100644 f0000001\0" and a 20-byte oid.
    const many = (n: number) => {
      const content = new Uint8Array(n * 36);
      for (let i = 0; i < n; i++) content.set(enc.encode(`100644 f${String(i).padStart(7, "0")}\0`), i * 36);
      return { oid: "t".repeat(40), type: "tree", content };
    };
    const huge = many(Math.ceil((MAX_TREE_BYTES + 1) / 36));
    expect(huge.content.length).toBeGreaterThan(MAX_TREE_BYTES);
    expect(fsckObjects([huge])).toMatch(/larger than 8 MiB/);
    // A large but ordinary directory is fine, and a truncated last entry is malformed.
    const big = many(50_000);
    expect(fsckObjects([big])).toBeNull();
    expect(fsckObjects([{ ...big, content: big.content.subarray(0, big.content.length - 3) }])).toMatch(/malformed tree/);
  });

  it("refuses a commit or tag over 4 MiB, which would be decoded whole after the push", () => {
    const big = (type: string, n: number) => ({ oid: "c".repeat(40), type, content: new Uint8Array(n).fill(0x61) });
    expect(fsckObjects([big("commit", MAX_COMMIT_BYTES)])).toBeNull();
    expect(fsckObjects([big("commit", MAX_COMMIT_BYTES + 1)])).toBe(`commit ${"c".repeat(40)}: larger than 4 MiB`);
    expect(fsckObjects([big("tag", MAX_COMMIT_BYTES + 1)])).toMatch(/^tag c+: larger than 4 MiB$/);
    // Blobs of any size are for the large-object path, not this check.
    expect(fsckSize("b".repeat(40), "blob", 100 * 1024 * 1024)).toBeNull();
  });
});
