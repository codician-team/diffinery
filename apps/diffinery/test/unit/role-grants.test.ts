import { describe, expect, it } from "vitest";
import { Directory, type Account, type RepoGrants } from "../../src/lib/directory.js";
import { testD1 } from "./stubs/d1.js";
import type { Env } from "../../src/env.js";

/** roleFor with the grants loadRepo reads alongside the repository (grantsFor) gives the same role as reading them itself. */
function world() {
  const DB = testD1();
  const t = "2026-10-01T00:00:00.000Z";
  const acct = DB.sqlite.prepare("INSERT INTO accounts (id, login, kind, status, site_admin, owner_id, agent_policy, base_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  acct.run("ada", "ada", "user", "active", 0, null, null, null, t);
  acct.run("bob", "bob", "user", "active", 0, null, null, null, t);
  acct.run("cy", "cy", "user", "active", 0, null, null, null, t);
  acct.run("dee", "dee", "user", "disabled", 0, null, null, null, t);
  acct.run("root", "root", "user", "active", 1, null, null, null, t);
  acct.run("eve", "eve", "user", "active", 0, null, null, null, t);
  acct.run("acme", "acme", "org", "active", 0, null, null, "write", t);
  acct.run("shut", "shut", "org", "active", 0, null, null, "none", t);
  acct.run("ada-bot", "ada-bot", "agent", "active", 0, "ada", null, null, t);
  acct.run("bob-bot", "bob-bot", "agent", "active", 0, "bob", JSON.stringify({ maxRole: "triage" }), null, t);
  acct.run("cy-bot", "cy-bot", "agent", "active", 0, "cy", null, null, t);
  acct.run("acme-bot", "acme-bot", "agent", "active", 0, "acme", null, null, t);
  acct.run("dee-bot", "dee-bot", "agent", "active", 0, "dee", null, null, t);
  const member = DB.sqlite.prepare("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, ?, ?, '2026-10-01')");
  member.run("acme", "bob", "member");
  member.run("acme", "ada", "owner");
  member.run("shut", "bob", "member");
  member.run("shut", "cy", "admin");
  const repo = DB.sqlite.prepare("INSERT INTO repos (id, owner_id, name, visibility, created_at, updated_at, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  repo.run("r-ada", "ada", "notes", "private", t, t, t);
  repo.run("r-acme", "acme", "app", "private", t, t, t);
  repo.run("r-acme-pub", "acme", "site", "public", t, t, t);
  repo.run("r-shut", "shut", "vault", "private", t, t, t);
  repo.run("r-pub", "cy", "tool", "public", t, t, t);
  const grant = DB.sqlite.prepare("INSERT INTO repo_access (repo_id, account_id, role) VALUES (?, ?, ?)");
  grant.run("r-ada", "cy", "read");
  grant.run("r-acme", "eve", "maintain");
  grant.run("r-shut", "bob", "write");
  grant.run("r-acme", "bob-bot", "admin");
  grant.run("r-ada", "ada-bot", "read");
  grant.run("r-shut", "cy-bot", "triage");
  return new Directory({ DB } as unknown as Env);
}

describe("roles from grants read alongside the repository", () => {
  it("match roleFor reading them itself, for people and agents", async () => {
    const dir = world();
    const everyone = (await dir.accountsByIds(["ada", "bob", "cy", "dee", "root", "eve", "ada-bot", "bob-bot", "cy-bot", "acme-bot", "dee-bot"])) as Account[];
    let compared = 0;
    for (const id of ["r-ada", "r-acme", "r-acme-pub", "r-shut", "r-pub"]) {
      const repo = (await dir.repoById(id))!;
      for (const a of everyone) {
        const owner = a.owner_id ? await dir.account(a.owner_id) : null;
        const ids = a.kind === "agent" ? [a.id, ...(owner?.kind === "user" ? [owner.id] : [])] : [a.id];
        const grants: RepoGrants[] = (await Promise.all(ids.map((x) => dir.grantsFor(repo.owner_login, repo.name, x)))).flat();
        expect(grants.every((g) => g.repoId === repo.id)).toBe(true);
        expect(await dir.roleFor(a, repo, owner, grants), `${a.login} on ${id}`).toBe(await dir.roleFor(a, repo));
        compared++;
      }
    }
    expect(compared).toBe(55);
  });

  it("are ignored for another repository, and read by name with .git and any case", async () => {
    const dir = world();
    const bob = (await dir.account("bob"))!;
    const shut = (await dir.repoById("r-shut"))!;
    // Grants read for acme/app don't stand in for shut/vault: roleFor reads shut/vault's own.
    const other = await dir.grantsFor("acme", "app", "bob");
    expect(other[0]!.repoId).toBe("r-acme");
    expect(await dir.roleFor(bob, shut, undefined, other)).toBe("write");
    expect((await dir.grantsFor("SHUT", "vault.git", "bob"))[0]).toMatchObject({ repoId: "r-shut", access: "write", memberRole: "member", baseRole: "none" });
    expect(await dir.grantsFor("shut", "missing", "bob")).toEqual([]);
  });
});
