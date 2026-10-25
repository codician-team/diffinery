import { describe, expect, it } from "vitest";
import { isDotGitName, unsafeTreeName, unsafeTreePath } from "../../src/lib/tree-names.js";

describe("tree entry names", () => {
  it("accepts ordinary names", () => {
    for (const n of ["README.md", ".gitignore", ".github", "git", "a b", "50%", ".git-blame-ignore-revs", "gitk~1"]) expect(unsafeTreeName(n)).toBeNull();
  });

  it("refuses . and .. and separators", () => {
    for (const n of ["", ".", "..", "a/b", "a\\b", "a\0b"]) expect(unsafeTreeName(n)).not.toBeNull();
  });

  it("refuses every spelling a checkout would treat as .git", () => {
    for (const n of [".git", ".GIT", ".Git", ".git.", ".git ", ".git. .", "git~1", "GIT~1", ".g‌it", "‎.git", ".git﻿"]) {
      expect(isDotGitName(n)).toBe(true);
      expect(unsafeTreeName(n)).not.toBeNull();
    }
  });

  it("refuses long names", () => {
    expect(unsafeTreeName("a".repeat(255))).toBeNull();
    expect(unsafeTreeName("a".repeat(256))).not.toBeNull();
  });

  it("checks every segment of a path", () => {
    expect(unsafeTreePath("src/lib/a.ts")).toBeNull();
    expect(unsafeTreePath("/src//lib/")).toBeNull();
    for (const p of ["", "/", "a/../b", "./a", ".git/config", "sub/.GIT/hooks/pre-commit", "x/git~1/y", "a\\b", "a\0", "sub/.git./x"]) expect(unsafeTreePath(p)).not.toBeNull();
    expect(unsafeTreePath("a/".repeat(2100))).not.toBeNull();
  });
});
