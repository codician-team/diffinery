import { describe, expect, it } from "vitest";
import { globMatch, matchesPatternList, matchesTrigger, parseWorkflow, type Workflow } from "../src/index.js";

function wf(on: string): Workflow {
  const src = `on:${on}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  const { workflow, errors } = parseWorkflow(src, ".github/workflows/t.yml");
  if (!workflow) throw new Error(JSON.stringify(errors));
  return workflow;
}

describe("globMatch (GitHub filter pattern cheat sheet)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["feature/*", "feature/my-branch", true],
    ["feature/*", "feature/your-branch", true],
    ["feature/*", "feature/a/b", false],
    ["feature/**", "feature/beta-a/my-branch", true],
    ["feature/**", "feature/mona/the/octocat", true],
    ["main", "main", true],
    ["main", "main2", false],
    ["releases/mona-the-octocat", "releases/mona-the-octocat", true],
    ["*", "main", true],
    ["*", "releases/v1", false],
    ["**", "all/the/branches", true],
    ["*feature", "mona-feature", true],
    ["*feature", "feature", true],
    ["*feature", "ver-10-feature", true],
    ["v2*", "v2", true],
    ["v2*", "v2.0", true],
    ["v2*", "v2.9", true],
    ["v2*", "v3", false],
    ["v[12].[0-9]+.[0-9]+", "v1.10.1", true],
    ["v[12].[0-9]+.[0-9]+", "v2.0.0", true],
    ["v[12].[0-9]+.[0-9]+", "v3.0.0", false],
    ["v[12].[0-9]+.[0-9]+", "v1..0", false],
    ["v1.?", "v1.", true],
    ["v1.?", "v1", true],
    ["v1.?", "v1x", false],
    ["*.jsx?", "page.js", true],
    ["*.jsx?", "page.jsx", true],
    ["*.jsx?", "dir/page.js", false],
    ["**.js", "index.js", true],
    ["**.js", "js/index.js", true],
    ["**.js", "src/js/app.js", true],
    ["docs/*", "docs/README.md", true],
    ["docs/*", "docs/file.txt", true],
    ["docs/*", "docs/a/file.txt", false],
    ["docs/**", "docs/README.md", true],
    ["docs/**", "docs/mona/octocat.txt", true],
    ["docs/**/*.md", "docs/README.md", true],
    ["docs/**/*.md", "docs/mona/hello-world.md", true],
    ["docs/**/*.md", "docs/a/markdown/file.md", true],
    ["**/docs/**", "docs/hello.md", true],
    ["**/docs/**", "dir/docs/my-file.txt", true],
    ["**/docs/**", "space/docs/plan/space.doc", true],
    ["**/README.md", "README.md", true],
    ["**/README.md", "js/README.md", true],
    ["**/*src/**", "a/src/app.js", true],
    ["**/*src/**", "my-src/code/js/app.js", true],
    ["**/*-post.md", "my-post.md", true],
    ["**/*-post.md", "path/their-post.md", true],
    ["**/migrate-*.sql", "migrate-10909.sql", true],
    ["**/migrate-*.sql", "db/migrate-v1.0.sql", true],
    ["**/migrate-*.sql", "db/sept/migrate-v1.sql", true],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["releases/\\*", "releases/*", true],
    ["releases/\\*", "releases/x", false],
    ["a+b", "aaab", true],
    ["a+b", "b", false],
    ["file(1).txt", "file(1).txt", true],
    ["v1.0", "v1x0", false],
  ];
  for (const [pattern, value, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${value}`, () => {
      expect(globMatch(pattern, value)).toBe(expected);
    });
  }

  it("evaluates negations in order", () => {
    const patterns = ["releases/**", "!releases/**-alpha"];
    expect(matchesPatternList(patterns, "releases/10")).toBe(true);
    expect(matchesPatternList(patterns, "releases/10-alpha")).toBe(false);
    expect(matchesPatternList(patterns, "main")).toBe(false);
    // A later positive pattern re-includes.
    const reinclude = ["sub-package/**", "!sub-package/docs/**", "sub-package/docs/important.md"];
    expect(matchesPatternList(reinclude, "sub-package/docs/important.md")).toBe(true);
    expect(matchesPatternList(reinclude, "sub-package/docs/other.md")).toBe(false);
    // A negation before the positive pattern has no effect.
    expect(matchesPatternList(["!releases/**-alpha", "releases/**"], "releases/10-alpha")).toBe(true);
  });
});

describe("matchesTrigger: push", () => {
  it("bare push runs for every branch and tag", () => {
    const w = wf(" push");
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/anything" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v1" })).toBe(true);
    expect(matchesTrigger(w, { name: "pull_request", action: "opened", baseRef: "main" })).toBe(false);
  });

  it("branch filters", () => {
    const w = wf(`\n  push:\n    branches: [main, 'releases/**', '!releases/**-alpha']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/releases/v1" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/releases/v1-alpha" })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/dev" })).toBe(false);
    // Only branches defined: tag pushes do not trigger.
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v1" })).toBe(false);
  });

  it("branches-ignore", () => {
    const w = wf(`\n  push:\n    branches-ignore: ['mona/octocat', 'releases/**-alpha']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/mona/octocat" })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/releases/beta/3-alpha" })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v1" })).toBe(false);
  });

  it("tag filters only: branch pushes do not trigger", () => {
    const w = wf(`\n  push:\n    tags: ['v*.*.*']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v1.2.3" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/latest" })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main" })).toBe(false);
  });

  it("tags-ignore", () => {
    const w = wf(`\n  push:\n    tags-ignore: ['v1.*']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v2.0" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v1.9" })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main" })).toBe(false);
  });

  it("branches and tags together", () => {
    const w = wf(`\n  push:\n    branches: [main]\n    tags: ['v*']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v1" })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/dev" })).toBe(false);
  });

  it("paths filters", () => {
    const w = wf(`\n  push:\n    paths: ['**.js', '!docs/**']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["src/a.js"] })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["docs/a.js"] })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["docs/a.js", "lib/b.js"] })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["README.md"] })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: [] })).toBe(false);
    // Unknown changed files: run.
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main" })).toBe(true);
    // Paths are not evaluated for tags.
    expect(matchesTrigger(w, { name: "push", ref: "refs/tags/v1", changedFiles: ["README.md"] })).toBe(true);
  });

  it("paths-ignore runs unless every file is ignored", () => {
    const w = wf(`\n  push:\n    paths-ignore: ['docs/**', '*.md']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["docs/a.txt", "README.md"] })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["docs/a.txt", "src/x.ts"] })).toBe(true);
  });

  it("branches and paths must both match", () => {
    const w = wf(`\n  push:\n    branches: [main]\n    paths: ['src/**']`);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["src/a"] })).toBe(true);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/dev", changedFiles: ["src/a"] })).toBe(false);
    expect(matchesTrigger(w, { name: "push", ref: "refs/heads/main", changedFiles: ["test/a"] })).toBe(false);
  });
});

describe("matchesTrigger: pull_request", () => {
  it("default types are opened, synchronize, reopened", () => {
    const w = wf(" [pull_request]");
    for (const a of ["opened", "synchronize", "reopened"]) {
      expect(matchesTrigger(w, { name: "pull_request", action: a, baseRef: "main" })).toBe(true);
    }
    expect(matchesTrigger(w, { name: "pull_request", action: "closed", baseRef: "main" })).toBe(false);
    expect(matchesTrigger(w, { name: "pull_request", action: "labeled", baseRef: "main" })).toBe(false);
  });

  it("explicit types and branch filters on the base branch", () => {
    const w = wf(`\n  pull_request:\n    types: [closed, labeled]\n    branches: ['releases/**']`);
    expect(matchesTrigger(w, { name: "pull_request", action: "closed", baseRef: "releases/1.x" })).toBe(true);
    expect(matchesTrigger(w, { name: "pull_request", action: "closed", baseRef: "refs/heads/releases/1.x" })).toBe(true);
    expect(matchesTrigger(w, { name: "pull_request", action: "opened", baseRef: "releases/1.x" })).toBe(false);
    expect(matchesTrigger(w, { name: "pull_request", action: "closed", baseRef: "main" })).toBe(false);
  });

  it("types as a single string", () => {
    const w = wf(`\n  pull_request:\n    types: closed`);
    expect(matchesTrigger(w, { name: "pull_request", action: "closed", baseRef: "main" })).toBe(true);
    expect(matchesTrigger(w, { name: "pull_request", action: "opened", baseRef: "main" })).toBe(false);
  });

  it("pull_request_target is separate from pull_request", () => {
    const w = wf(`\n  pull_request_target:\n    branches-ignore: [gh-pages]\n    paths: ['src/**']`);
    expect(matchesTrigger(w, { name: "pull_request", action: "opened", baseRef: "main" })).toBe(false);
    expect(matchesTrigger(w, { name: "pull_request_target", action: "opened", baseRef: "main", changedFiles: ["src/x"] })).toBe(true);
    expect(matchesTrigger(w, { name: "pull_request_target", action: "opened", baseRef: "gh-pages" })).toBe(false);
    expect(matchesTrigger(w, { name: "pull_request_target", action: "opened", baseRef: "main", changedFiles: ["x"] })).toBe(false);
  });
});

describe("matchesTrigger: other events", () => {
  it("schedule matches by cron string", () => {
    const w = wf(`\n  schedule:\n    - cron: '30 5 * * 1,3'\n    - cron: '0 0 * * *'`);
    expect(matchesTrigger(w, { name: "schedule", cron: "30 5 * * 1,3" })).toBe(true);
    expect(matchesTrigger(w, { name: "schedule", cron: "0  0 * * *" })).toBe(true);
    expect(matchesTrigger(w, { name: "schedule", cron: "0 1 * * *" })).toBe(false);
  });

  it("workflow_dispatch", () => {
    expect(matchesTrigger(wf(" workflow_dispatch"), { name: "workflow_dispatch" })).toBe(true);
    expect(matchesTrigger(wf(" push"), { name: "workflow_dispatch" })).toBe(false);
  });

  it("activity types for generic events", () => {
    const w = wf(`\n  issues:\n    types: [opened, labeled]\n  issue_comment:\n  release:\n    types: [published]`);
    expect(matchesTrigger(w, { name: "issues", action: "opened" })).toBe(true);
    expect(matchesTrigger(w, { name: "issues", action: "closed" })).toBe(false);
    expect(matchesTrigger(w, { name: "issue_comment", action: "created" })).toBe(true);
    expect(matchesTrigger(w, { name: "release", action: "published" })).toBe(true);
    expect(matchesTrigger(w, { name: "release", action: "created" })).toBe(false);
    expect(matchesTrigger(w, { name: "watch", action: "started" })).toBe(false);
  });

  it("workflow_run filters by workflow, type and branch", () => {
    const w = wf(`\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]`);
    expect(matchesTrigger(w, { name: "workflow_run", action: "completed", workflow: "CI", branch: "main" })).toBe(true);
    expect(matchesTrigger(w, { name: "workflow_run", action: "requested", workflow: "CI", branch: "main" })).toBe(false);
    expect(matchesTrigger(w, { name: "workflow_run", action: "completed", workflow: "Deploy", branch: "main" })).toBe(false);
    expect(matchesTrigger(w, { name: "workflow_run", action: "completed", workflow: "CI", branch: "dev" })).toBe(false);
  });

  it("merge_group defaults to checks_requested and filters on the base branch", () => {
    const any = wf(" [pull_request, merge_group]");
    expect(matchesTrigger(any, { name: "merge_group", action: "checks_requested", baseRef: "refs/heads/main" })).toBe(true);
    expect(matchesTrigger(any, { name: "merge_group", action: "destroyed", baseRef: "main" })).toBe(false);
    const w = wf(`\n  merge_group:\n    types: [checks_requested]\n    branches: [main, 'release/**']`);
    expect(w.on.merge_group).toEqual({ types: ["checks_requested"], branches: ["main", "release/**"] });
    expect(matchesTrigger(w, { name: "merge_group", action: "checks_requested", baseRef: "refs/heads/release/1.x" })).toBe(true);
    expect(matchesTrigger(w, { name: "merge_group", action: "checks_requested", baseRef: "dev" })).toBe(false);
    expect(matchesTrigger(wf(" push"), { name: "merge_group", action: "checks_requested", baseRef: "main" })).toBe(false);
  });
});
