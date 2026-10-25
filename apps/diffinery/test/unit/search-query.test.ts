import { describe, expect, it } from "vitest";
import { inRange, matchesText, parseIssueQuery, parseRange, parseRepoQuery, tokenize } from "../../src/lib/search-query.js";

describe("search query tokenizer", () => {
  it("splits qualifiers, quoted values and negations", () => {
    expect(tokenize('repo:o/r label:"good first issue" -label:wontfix crash')).toEqual([
      { key: "repo", value: "o/r", negated: false },
      { key: "label", value: "good first issue", negated: false },
      { key: "label", value: "wontfix", negated: true },
      { key: null, value: "crash", negated: false },
    ]);
  });

  it("keeps a quoted phrase as one word", () => {
    expect(tokenize('"null pointer" -flaky')).toEqual([
      { key: null, value: "null pointer", negated: false },
      { key: null, value: "flaky", negated: true },
    ]);
  });
});

describe("issue search queries", () => {
  it("reads the qualifiers actions and scripts use", () => {
    const q = parseIssueQuery("repo:acme/api is:pr is:open label:bug,ci -label:wip author:alice assignee:bob head:feature base:main in:title fix crash");
    expect(q.repos).toEqual(["acme/api"]);
    expect(q.kind).toBe("pull");
    expect(q.state).toBe("open");
    expect(q.labels).toEqual(["bug", "ci"]);
    expect(q.notLabels).toEqual(["wip"]);
    expect(q.author).toBe("alice");
    expect(q.assignee).toBe("bob");
    expect(q.head).toBe("feature");
    expect(q.base).toBe("main");
    expect(q.in).toEqual(["title"]);
    expect(q.text).toEqual(["fix", "crash"]);
  });

  it("handles merged, draft, locked, no: and negated author", () => {
    const q = parseIssueQuery("is:merged -is:draft is:locked no:label no:assignee -author:dependabot user:acme");
    expect(q.kind).toBe("pull");
    expect(q.merged).toBe(true);
    expect(q.draft).toBe(false);
    expect(q.locked).toBe(true);
    expect(q.noLabel).toBe(true);
    expect(q.noAssignee).toBe(true);
    expect(q.notAuthor).toBe("dependabot");
    expect(q.owners).toEqual(["acme"]);
    expect(parseIssueQuery("is:unmerged").merged).toBe(false);
    expect(parseIssueQuery("-is:open").state).toBe("closed");
    expect(parseIssueQuery("type:issue state:closed").kind).toBe("issue");
  });

  it("parses date ranges and sort", () => {
    const q = parseIssueQuery("created:>=2024-01-01 updated:2024-01-01..2024-02-01 closed:<2023-06-01 sort:updated-asc");
    expect(q.created).toEqual({ gte: "2024-01-01" });
    expect(q.updated).toEqual({ gte: "2024-01-01", lte: "2024-02-01T23:59:59.999Z" });
    expect(q.closed).toEqual({ lt: "2023-06-01" });
    expect(q.sort).toEqual({ field: "updated", dir: "asc" });
    // The sort and order parameters win over a sort: qualifier.
    expect(parseIssueQuery("sort:updated-asc", { sort: "comments", order: "desc" }).sort).toEqual({ field: "comments", dir: "desc" });
  });

  it("treats unknown qualifiers and bad repo names as text or ignores them", () => {
    const q = parseIssueQuery("milestone:v2 repo:not-a-repo");
    expect(q.text).toEqual(["milestone:v2"]);
    expect(q.repos).toEqual([]);
  });
});

describe("date ranges", () => {
  it("covers whole days and open ends", () => {
    expect(parseRange(">2024-01-01")).toEqual({ gt: "2024-01-01T23:59:59.999Z" });
    expect(parseRange("<=2024-01-01")).toEqual({ lte: "2024-01-01T23:59:59.999Z" });
    expect(parseRange("2024-03-05")).toEqual({ gte: "2024-03-05", lte: "2024-03-05T23:59:59.999Z" });
    expect(parseRange("2024-01-01..*")).toEqual({ gte: "2024-01-01" });
    expect(parseRange("*..2024-01-01")).toEqual({ lte: "2024-01-01T23:59:59.999Z" });
    expect(parseRange("yesterday")).toBeNull();
    expect(parseRange(">soon")).toBeNull();
  });

  it("matches ISO timestamps", () => {
    const day = parseRange("2024-03-05")!;
    expect(inRange("2024-03-05T10:00:00Z", day)).toBe(true);
    expect(inRange("2024-03-06T00:00:00Z", day)).toBe(false);
    expect(inRange(null, day)).toBe(false);
    expect(inRange(null, undefined)).toBe(true);
    expect(inRange("2024-01-02T00:00:00Z", parseRange(">2024-01-01")!)).toBe(true);
    expect(inRange("2024-01-01T12:00:00Z", parseRange(">2024-01-01")!)).toBe(false);
  });
});

describe("repository search queries", () => {
  it("reads owners, topics, visibility and archived", () => {
    const q = parseRepoQuery("org:acme topic:CLI is:private archived:false in:name,description tool language:go");
    expect(q.owners).toEqual(["acme"]);
    expect(q.topics).toEqual(["cli"]);
    expect(q.visibility).toBe("private");
    expect(q.archived).toBe(false);
    expect(q.in).toEqual(["name", "description"]);
    expect(q.text).toEqual(["tool"]);
  });
});

describe("text matching", () => {
  it("needs every word and none of the excluded ones, ignoring case", () => {
    expect(matchesText([], ["anything"])).toBe(true);
    expect(matchesText(["Crash", "login"], ["App crashes on login"])).toBe(true);
    expect(matchesText(["crash", "-login"], ["App crashes on login"])).toBe(false);
    expect(matchesText(["crash"], ["title", "body mentions a CRASH"])).toBe(true);
    expect(matchesText(["-"], ["a - b"])).toBe(true);
  });
});
