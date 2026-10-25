import { describe, expect, it } from "vitest";
import { Directory, type Account, type Repo } from "../../src/lib/directory.js";
import { testD1 } from "./stubs/d1.js";
import type { Env } from "../../src/env.js";

/**
 * Who can see what, by the batched lookups (reposVisibleTo, publicRepos, readersOf) against the
 * one-at-a-time roleFor they stand in for.
 */
function world() {
  const DB = testD1();
  const t = "2026-10-01T00:00:00.000Z";
  const acct = DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  acct.run("ada", "ada", "user", "active", 0, null, t);
  acct.run("bob", "bob", "user", "active", 0, null, t);
  acct.run("cy", "cy", "user", "active", 0, null, t);
  acct.run("dee", "dee", "user", "disabled", 0, null, t);
  acct.run("root", "root", "user", "active", 1, null, t);
  acct.run("bot", "ada-bot", "agent", "active", 0, "ada", t);
  acct.run("acme", "acme", "org", "active", 0, null, t);
  acct.run("shut", "shut", "org", "active", 0, null, t);
  DB.sqlite.prepare("UPDATE accounts SET base_role = 'none' WHERE id = 'shut'").run();
  const member = DB.sqlite.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, '2026-10-01')");
  member.run("acme", "bob", "member");
  member.run("shut", "bob", "member");
  member.run("shut", "cy", "admin");
  const repo = DB.sqlite.prepare("INSERT INTO repos (id, owner_id, name, visibility, created_at, updated_at, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  repo.run("r-ada", "ada", "notes", "private", t, t, "2026-10-02T00:00:00.000Z");
  repo.run("r-acme", "acme", "app", "private", t, t, "2026-10-03T00:00:00.000Z");
  repo.run("r-shut", "shut", "vault", "private", t, t, "2026-10-04T00:00:00.000Z");
  repo.run("r-shut-pub", "shut", "site", "public", t, t, "2026-10-05T00:00:00.000Z");
  repo.run("r-pub", "cy", "tool", "public", t, t, "2026-10-06T00:00:00.000Z");
  DB.sqlite.prepare("UPDATE repos SET description = 'A fast 100% thing', topics = '[\"cli\"]' WHERE id = 'r-pub'").run();
  DB.sqlite.prepare("INSERT INTO repo_access (repo_id, account_id, role) VALUES ('r-ada', 'cy', 'read')").run();
  const dir = new Directory({ DB } as unknown as Env);
  return { dir };
}

const ids = (rs: Repo[]) => rs.map((r) => r.id);

describe("repository visibility at scale", () => {
  it("lists the repositories an account works with, not every public one", async () => {
    const { dir } = world();
    const get = async (id: string) => (await dir.account(id))!;
    expect(ids(await dir.reposVisibleTo(await get("ada")))).toEqual(["r-ada"]);
    // bob: acme's repository as a member (base read), shut's public one but not its private one (base none).
    expect(ids(await dir.reposVisibleTo(await get("bob")))).toEqual(["r-shut-pub", "r-acme"]);
    // cy: own public repo, shut's as an admin, ada's shared with them.
    expect(ids(await dir.reposVisibleTo(await get("cy")))).toEqual(["r-pub", "r-shut-pub", "r-shut", "r-ada"]);
    // An agent sees what its owner works with.
    expect(ids(await dir.reposVisibleTo(await get("bot")))).toEqual(["r-ada"]);
    expect(await dir.reposVisibleTo(await get("dee"))).toEqual([]);
    // One owner's repositories still include its public ones for anyone.
    expect(ids(await dir.reposVisibleTo(await get("ada"), "cy"))).toEqual(["r-pub"]);
    expect(ids(await dir.reposVisibleTo(await get("ada"), "shut"))).toEqual(["r-shut-pub"]);
  });

  it("finds public repositories by words and owners in D1", async () => {
    const { dir } = world();
    expect(ids(await dir.publicRepos(10))).toEqual(["r-pub", "r-shut-pub"]);
    expect(ids(await dir.publicRepos(10, { words: ["TOOL"] }))).toEqual(["r-pub"]);
    expect(ids(await dir.publicRepos(10, { words: ["100%", "cli"] }))).toEqual(["r-pub"]);
    // % and _ are matched literally.
    expect(ids(await dir.publicRepos(10, { words: ["1_0"] }))).toEqual([]);
    expect(ids(await dir.publicRepos(10, { words: ["shut/"] }))).toEqual(["r-shut-pub"]);
    expect(ids(await dir.publicRepos(10, { owners: ["SHUT"] }))).toEqual(["r-shut-pub"]);
  });

  it("finds a repository's readers in a few queries, as roleFor would one by one", async () => {
    const { dir } = world();
    const everyone = (await dir.accountsByIds(["ada", "bob", "cy", "dee", "root", "bot", "acme", "nobody"])) as Account[];
    expect(everyone.map((a) => a.id).sort()).toEqual(["acme", "ada", "bob", "bot", "cy", "dee", "root"]);
    for (const id of ["r-ada", "r-acme", "r-shut", "r-shut-pub", "r-pub"]) {
      const repo = (await dir.repoById(id))!;
      const want = new Set<string>();
      for (const a of everyone) if (a.kind !== "org" && (await dir.roleFor(a, repo))) want.add(a.id);
      expect([...(await dir.readersOf(repo, everyone))].sort(), id).toEqual([...want].sort());
    }
    expect((await dir.accountsByLogins(["ADA", "ada-bot", "ghost"])).map((a) => a.id).sort()).toEqual(["ada", "bot"]);
  });
});
