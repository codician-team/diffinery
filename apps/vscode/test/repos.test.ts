import { describe, expect, it } from "vitest";
import { compareVersions, credentialInput, dedupe, matches, nextLink, repoNameFrom, repoRef, type RepoJson } from "../src/util";


const S = "https://diffinery.com";
const repo = (full: string, description: string | null = null): RepoJson => ({
  full_name: full,
  name: full.split("/")[1]!,
  owner: { login: full.split("/")[0]! },
  description,
  private: true,
  clone_url: `${S}/${full}.git`,
  html_url: `${S}/${full}`,
});

describe("repositories", () => {
  it("reads owner/repo from names and URLs on this server only", () => {
    expect(repoRef(S, "codician/diffinery")).toEqual({ owner: "codician", repo: "diffinery" });
    expect(repoRef(S, "https://diffinery.com/codician/diffinery.git")).toEqual({ owner: "codician", repo: "diffinery" });
    expect(repoRef(S, "https://diffinery.com/codician/diffinery/tree/main/src")).toEqual({ owner: "codician", repo: "diffinery" });
    expect(repoRef(S, "https://github.com/codician/diffinery")).toBeNull();
    expect(repoRef(S, "diffinery")).toBeNull();
    expect(repoRef(S, "a/b/c")).toBeNull();
    expect(repoRef(S, "a b/c")).toBeNull();
    expect(repoRef("http://localhost:8787", "http://localhost:8787/ada/x.git")).toEqual({ owner: "ada", repo: "x" });
  });

  it("matches every word, merges without duplicates", () => {
    const a = repo("codician/diffinery", "A git forge for agents");
    const b = repo("acme/website", "Marketing site");
    expect(matches(a, "forge DIFF")).toBe(true);
    expect(matches(b, "forge")).toBe(false);
    expect(dedupe([a], [b, repo("Codician/Diffinery")]).map((r) => r.full_name)).toEqual(["codician/diffinery", "acme/website"]);
  });

  it("follows Link headers", () => {
    expect(nextLink('<https://diffinery.com/api/v3/user/repos?page=2>; rel="next", <https://diffinery.com/api/v3/user/repos?page=5>; rel="last"')).toBe("https://diffinery.com/api/v3/user/repos?page=2");
    expect(nextLink('<https://x/?page=1>; rel="prev"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });

  it("names a repository after a folder", () => {
    expect(repoNameFrom("My Project (old)")).toBe("My-Project-old");
    expect(repoNameFrom("...")).toBe("repository");
  });
});

describe("updates and Git", () => {
  it("compares versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.10")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
  });

  it("writes what git credential approve reads", () => {
    expect(credentialInput(S, "ada", "dfy_x", 1_800_000_000_500)).toBe("protocol=https\nhost=diffinery.com\nusername=ada\npassword=dfy_x\npassword_expiry_utc=1800000000\n\n");
    expect(credentialInput("http://localhost:8787", "ada", "t")).toBe("protocol=http\nhost=localhost:8787\nusername=ada\npassword=t\n\n");
    expect(() => credentialInput(S, "ada\nhost=evil", "t")).toThrow();
  });
});
