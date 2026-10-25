import { describe, expect, it } from "vitest";
import { parseReleaseConfig, renderReleaseNotes, type NotesPull } from "../../src/repo/release-notes.js";

const pr = (number: number, title: string, author: string, labels: string[] = []): NotesPull => ({ number, title, author, labels, url: `https://example.test/o/r/pull/${number}` });
const changelogUrl = "https://example.test/o/r/compare/v1.0.0...v1.1.0";

describe("generated release notes", () => {
  it("lists merged pull requests, new contributors and the changelog link like GitHub", () => {
    const pulls = [pr(1, "Add search", "alice"), pr(2, "Fix crash", "bob")];
    expect(renderReleaseNotes({ pulls, newContributors: [pulls[1]!], changelogUrl })).toBe(
      [
        "## What's Changed",
        "* Add search by @alice in https://example.test/o/r/pull/1",
        "* Fix crash by @bob in https://example.test/o/r/pull/2",
        "",
        "## New Contributors",
        "* @bob made their first contribution in https://example.test/o/r/pull/2",
        "",
        `**Full Changelog**: ${changelogUrl}`,
      ].join("\n"),
    );
  });

  it("has only the changelog link when nothing was merged", () => {
    expect(renderReleaseNotes({ pulls: [], newContributors: [], changelogUrl })).toBe(`**Full Changelog**: ${changelogUrl}`);
  });

  it("groups by the categories in .github/release.yml and applies exclusions", () => {
    const config = parseReleaseConfig(`
changelog:
  exclude:
    labels: [ignore-for-release]
    authors: [dependabot]
  categories:
    - title: Breaking Changes
      labels: [breaking]
    - title: Features
      labels: [feature, enhancement]
      exclude:
        labels: [internal]
    - title: Everything else
      labels: ["*"]
`);
    expect(config.exclude).toEqual({ labels: ["ignore-for-release"], authors: ["dependabot"] });
    expect(config.categories?.map((c) => c.title)).toEqual(["Breaking Changes", "Features", "Everything else"]);
    const notes = renderReleaseNotes({
      pulls: [
        pr(1, "New API", "alice", ["breaking", "feature"]),
        pr(2, "Dark mode", "bob", ["enhancement"]),
        pr(3, "Bump deps", "Dependabot", ["deps"]),
        pr(4, "Hidden", "carol", ["ignore-for-release"]),
        pr(5, "Refactor", "dave", ["feature", "internal"]),
      ],
      newContributors: [],
      config,
      changelogUrl,
    });
    expect(notes).toBe(
      [
        "## What's Changed",
        "### Breaking Changes",
        "* New API by @alice in https://example.test/o/r/pull/1",
        "",
        "### Features",
        "* Dark mode by @bob in https://example.test/o/r/pull/2",
        "",
        "### Everything else",
        "* Refactor by @dave in https://example.test/o/r/pull/5",
        "",
        `**Full Changelog**: ${changelogUrl}`,
      ].join("\n"),
    );
  });

  it("puts uncategorised pull requests under Other Changes", () => {
    const config = parseReleaseConfig("changelog:\n  categories:\n    - title: Fixes\n      labels: bug\n");
    const notes = renderReleaseNotes({ pulls: [pr(1, "Fix", "a", ["bug"]), pr(2, "Docs", "b")], newContributors: [], config, changelogUrl });
    expect(notes).toContain("### Fixes\n* Fix by @a");
    expect(notes).toContain("### Other Changes\n* Docs by @b");
  });

  it("ignores malformed configuration", () => {
    expect(parseReleaseConfig(": : :\n  - [")).toEqual({});
    expect(parseReleaseConfig("just text")).toEqual({});
    expect(parseReleaseConfig("changelog:\n  categories:\n    - labels: [x]\n")).toEqual({ categories: [] });
  });
});
