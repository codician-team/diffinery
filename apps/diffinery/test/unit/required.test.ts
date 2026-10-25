import { describe, expect, it } from "vitest";
import { ACTIONS_APP, normalizeCheckSources, parseCheckList, requiredCheck } from "../../src/repo/required.js";
import type { Check } from "../../src/repo/collab.js";

type Entry = Partial<Check> & Pick<Check, "name" | "app" | "status">;
const entry = (e: Entry): Check => ({ conclusion: null, creatorLogin: null, creatorKind: null, ...e }) as unknown as Check;
const actions = (status: string, conclusion: string | null = null) => entry({ name: "ci", app: ACTIONS_APP, status, conclusion } as Entry);
const by = (login: string, kind: string, conclusion: string) => entry({ name: "ci", app: login, status: "completed", conclusion, creatorLogin: login, creatorKind: kind } as Entry);

describe("requiredCheck", () => {
  it("is missing when nothing reported the name", () => {
    expect(requiredCheck("ci", []).state).toBe("missing");
    expect(requiredCheck("ci", [entry({ name: "lint", app: ACTIONS_APP, status: "completed", conclusion: "success" } as Entry)]).state).toBe("missing");
  });

  it("passes on success, skipped and neutral", () => {
    for (const c of ["success", "skipped", "neutral"]) expect(requiredCheck("ci", [actions("completed", c)]).state).toBe("success");
  });

  it("lets Diffinery Actions be the authority over anyone else", () => {
    // A user posting a green status of the same name can't outvote a failing workflow.
    expect(requiredCheck("ci", [actions("completed", "failure"), by("alice", "user", "success")]).state).toBe("failure");
    expect(requiredCheck("ci", [actions("in_progress"), by("alice", "user", "success")]).state).toBe("pending");
  });

  it("fails when any counted report fails, so a newer green one can't hide it", () => {
    expect(requiredCheck("ci", [by("alice", "user", "failure"), by("bob", "user", "success")]).state).toBe("failure");
  });

  it("never counts reports from agents", () => {
    expect(requiredCheck("ci", [by("bot", "agent", "success")]).state).toBe("missing");
    expect(requiredCheck("ci", [by("alice", "user", "failure"), by("bot", "agent", "success")]).state).toBe("failure");
  });

  it("only counts the bound source when there is one", () => {
    const entries = [actions("completed", "failure"), by("ci-bot", "user", "success")];
    expect(requiredCheck("ci", entries, "ci-bot").state).toBe("success");
    expect(requiredCheck("ci", [by("alice", "user", "success")], "ci-bot").state).toBe("missing");
    expect(requiredCheck("ci", entries, ACTIONS_APP).state).toBe("failure");
  });
});

describe("normalizeCheckSources", () => {
  it("lowercases valid sources", () => {
    expect(normalizeCheckSources({ ci: "Diffinery-Actions", deploy: "CI-Bot" })).toEqual({ ci: "diffinery-actions", deploy: "ci-bot" });
  });
  it("refuses anything else", () => {
    for (const v of [null, [], "x", { ci: 1 }, { ci: "" }, { ci: "a b" }, { "": "x" }]) expect(() => normalizeCheckSources(v)).toThrow();
  });
});

describe("parseCheckList", () => {
  it("takes one name per line, commas and all", () => {
    expect(parseCheckList("CI / Typecheck and bundle\r\nEnd-to-end / End-to-end (git, PRs, Actions)\n\n lint \n")).toEqual(["CI / Typecheck and bundle", "End-to-end / End-to-end (git, PRs, Actions)", "lint"]);
  });

  it("splits a single line on commas outside parentheses and brackets", () => {
    expect(parseCheckList("CI / Unit tests (1/2), End-to-end (git, PRs, Actions), build [linux, arm64], lint")).toEqual(["CI / Unit tests (1/2)", "End-to-end (git, PRs, Actions)", "build [linux, arm64]", "lint"]);
  });

  it("drops blanks and duplicates", () => {
    expect(parseCheckList(" , lint,,lint ")).toEqual(["lint"]);
    expect(parseCheckList("")).toEqual([]);
  });
});
