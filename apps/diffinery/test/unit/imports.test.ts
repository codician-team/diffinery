import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { checkPublicUrl, isPrivateAddress, normalizeApiUrl, parseImportRequest, parseOptions, parseRepoSource, safeAssetName, visibilityFor } from "../../src/imports/options.js";
import { People, mapIssue, mapPull, mapReview, type GhIssue, type GhPull, type Link } from "../../src/imports/mapping.js";
import { RepoImports } from "../../src/repo/imports.js";
import { REPO_SCHEMA, migrateRepoSchema } from "../../src/repo/schema.js";
import { Releases, type ImportedRelease } from "../../src/repo/releases.js";
import type { RepoDO } from "../../src/repo/RepoDO.js";
import type { Caller } from "../../src/repo/types.js";
import type { Env } from "../../src/env.js";
import type { Account } from "../../src/lib/directory.js";
import { ImportService } from "../../src/imports/service.js";
import { GitHubClient, GitHubError, RateLimited } from "../../src/imports/github.js";

// ---------------------------------------------------------------- request and option validation

describe("import request validation", () => {
  const dev = { dev: false };

  it("accepts a single repository and defaults the name and visibility", () => {
    const r = parseImportRequest({ source: "octo/App", owner: "me" }, dev);
    expect(r.mode).toBe("repo");
    expect(r.source).toBe("octo/App");
    expect(r.name).toBe("App");
    expect(r.visibility).toBe("keep");
    expect(r.apiUrl).toBe("https://api.github.com");
  });

  it("derives the Enterprise API base from a repository URL", () => {
    const r = parseImportRequest({ source: "https://ghe.example.com/octo/app", owner: "me" }, dev);
    expect(r.apiUrl).toBe("https://ghe.example.com/api/v3");
  });

  it("maps GitHub internal visibility to private", () => {
    expect(parseImportRequest({ source: "o/r", owner: "me", visibility: "internal" }, dev).visibility).toBe("private");
  });

  it("rejects an unknown visibility and a bad name", () => {
    expect(() => parseImportRequest({ source: "o/r", owner: "me", visibility: "secret" }, dev)).toThrow(/visibility/);
    expect(() => parseImportRequest({ source: "o/r", owner: "me", name: "../etc" }, dev)).toThrow(/not a valid repository name/);
  });

  it("requires exactly one of source and source_owner", () => {
    expect(() => parseImportRequest({ owner: "me" }, dev)).toThrow(/either source/);
    expect(() => parseImportRequest({ source: "o/r", source_owner: "o", owner: "me" }, dev)).toThrow(/either source/);
  });

  it("validates a bulk selection and its size", () => {
    const r = parseImportRequest({ source_owner: "octo", owner: "me", repositories: ["a", "a", "b"] }, dev);
    expect(r.mode).toBe("bulk");
    expect(r.repositories).toEqual(["a", "b"]);
    expect(() => parseImportRequest({ source_owner: "octo", owner: "me", repositories: [] }, dev)).toThrow(/omit it/);
    expect(() => parseImportRequest({ source_owner: "octo", owner: "me", concurrency: 99 }, dev)).toThrow(/concurrency/);
  });

  it("rejects a token that looks malformed", () => {
    expect(() => parseImportRequest({ source: "o/r", owner: "me", github_token: "has spaces" }, dev)).toThrow(/token/);
  });

  it("reads known options and rejects unknown ones", () => {
    const o = parseOptions({ issues: false, branch_protection: false, secrets: "stop" });
    expect(o.issues).toBe(false);
    expect(o.protection).toBe(false);
    expect(o.secrets).toBe("stop");
    expect(() => parseOptions({ nope: true })).toThrow(/unknown option/);
    expect(() => parseOptions({ secrets: "maybe" })).toThrow(/bypass/);
  });
});

describe("source and visibility helpers", () => {
  it("parses owner/name, URLs and SSH remotes", () => {
    expect(parseRepoSource("octo/app")).toMatchObject({ owner: "octo", name: "app", host: null });
    expect(parseRepoSource("https://github.com/octo/app.git")).toMatchObject({ owner: "octo", name: "app", host: null });
    expect(parseRepoSource("git@ghe.example.com:octo/app.git")).toMatchObject({ owner: "octo", name: "app", host: "ghe.example.com" });
  });

  it("maps every GitHub visibility to public or private", () => {
    expect(visibilityFor("keep", { visibility: "public" })).toBe("public");
    expect(visibilityFor("keep", { visibility: "internal" })).toBe("private");
    expect(visibilityFor("keep", { private: true })).toBe("private");
    expect(visibilityFor("keep", { private: false })).toBe("public");
    expect(visibilityFor("public", { private: true })).toBe("public");
    expect(visibilityFor("private", { visibility: "public" })).toBe("private");
  });

  it("normalises GitHub.com and Enterprise API bases", () => {
    expect(normalizeApiUrl("", false)).toBe("https://api.github.com");
    expect(normalizeApiUrl("https://github.com", false)).toBe("https://api.github.com");
    expect(normalizeApiUrl("https://ghe.example.com", false)).toBe("https://ghe.example.com/api/v3");
    // The import container clones from this host itself: no other ports, and never Diffinery.
    expect(normalizeApiUrl("https://ghe.example.com:443", false)).toBe("https://ghe.example.com/api/v3");
    expect(() => normalizeApiUrl("https://ghe.example.com:8443", false)).toThrow(/port/);
    expect(() => normalizeApiUrl("https://diffinery.com/api/v3", false, "diffinery.com")).toThrow(/Diffinery itself/);
  });
});

describe("SSRF guard", () => {
  it("allows public https and refuses private, loopback and bare hosts", () => {
    expect(() => checkPublicUrl("https://api.github.com", false)).not.toThrow();
    expect(() => checkPublicUrl("http://api.github.com", false)).toThrow(/https/);
    expect(() => checkPublicUrl("https://localhost", false)).toThrow(/public host/);
    expect(() => checkPublicUrl("https://169.254.169.254", false)).toThrow(/public host/);
    expect(() => checkPublicUrl("https://10.0.0.1", false)).toThrow(/public host/);
    expect(() => checkPublicUrl("https://user:pw@example.com", false)).toThrow(/credentials/);
    // Loopback and plain http are allowed only in development (for test doubles).
    expect(() => checkPublicUrl("http://127.0.0.1:8787", true)).not.toThrow();
  });

  it("treats a trailing dot as the same host, and can refuse Diffinery's own host", () => {
    for (const u of ["https://localhost./x", "https://localhost../x", "https://metadata.internal./x", "https://intranet./x"]) expect(() => checkPublicUrl(u, false)).toThrow(/public host/);
    for (const u of ["https://diffinery.com/x", "https://DIFFINERY.COM./x", "https://api.diffinery.com/x"]) expect(() => checkPublicUrl(u, false, "webhook URL", "diffinery.com")).toThrow(/Diffinery itself/);
    expect(() => checkPublicUrl("https://notdiffinery.com/x", false, "webhook URL", "diffinery.com")).not.toThrow();
  });

  it("recognises private address ranges", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "169.254.0.1", "100.64.0.1", "::1", "fd00::1"]) expect(isPrivateAddress(h)).toBe(true);
    for (const h of ["8.8.8.8", "140.82.112.3", "2606:2800::1"]) expect(isPrivateAddress(h)).toBe(false);
  });
});

// ---------------------------------------------------------------- people mapping (verified links only)

describe("people mapping", () => {
  const links: Link[] = [{ externalId: "42", externalLogin: "octocat", accountId: "acc_1", login: "octo" }];

  it("maps a GitHub user to a Diffinery account by numeric id, surviving a rename", () => {
    const people = new People(links);
    // Linked by id even though the login on the object differs (GitHub logins can be renamed).
    const p = people.person({ login: "renamed-login", id: 42 });
    expect(p).toEqual({ id: "acc_1", login: "octo", kind: "user" });
    expect(people.login({ login: "renamed-login", id: 42 })).toBe("octo");
  });

  it("leaves unlinked users as imported GitHub users and never invents accounts", () => {
    const people = new People(links);
    const p = people.person({ login: "stranger", id: 7 });
    expect(p).toEqual({ id: "github:7", login: "stranger", kind: "github" });
    expect(people.login({ login: "stranger", id: 7 })).toBe("github:stranger");
    expect(people.person(null)).toMatchObject({ kind: "github", login: "ghost" });
  });
});

// ---------------------------------------------------------------- number-preserving mapping

const issue = (over: Partial<GhIssue>): GhIssue => ({ number: 1, title: "t", body: "b", state: "open", user: { login: "a", id: 1 }, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", ...over });

describe("issue and pull-request mapping keeps numbers", () => {
  const people = new People([]);

  it("keeps the GitHub issue number and maps the author", () => {
    const m = mapIssue(issue({ number: 57, state: "closed", state_reason: "completed" }), people);
    expect(m.number).toBe(57);
    expect(m.kind).toBe("issue");
    expect(m.state).toBe("closed");
    expect(m.author.kind).toBe("github");
  });

  it("maps a merged pull request with its number and merge metadata", () => {
    const pull: GhPull = {
      ...issue({ number: 12, state: "closed" }),
      merged_at: "2024-02-02T00:00:00Z",
      merged_by: { login: "mergebot", id: 9 },
      merge_commit_sha: "abc123",
      head: { ref: "feature", sha: "deadbeef", repo: { full_name: "octo/app" } },
      base: { ref: "main", sha: "cafe", repo: { full_name: "octo/app" } },
    };
    const m = mapPull(pull, "octo/app", people);
    expect(m.number).toBe(12);
    expect(m.kind).toBe("pull");
    expect(m.pull?.merged).toBe(true);
    expect(m.pull?.headRef).toBe("feature");
    expect(m.pull?.baseRef).toBe("main");
  });

  it("maps a review, skipping pending ones", () => {
    expect(mapReview({ id: 1, user: { login: "r", id: 2 }, state: "PENDING" }, 5, people)).toBeNull();
    const m = mapReview({ id: 1, user: { login: "r", id: 2 }, state: "APPROVED", submitted_at: "2024-03-03T00:00:00Z" }, 5, people);
    expect(m?.number).toBe(5);
    expect(m?.state).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------- safe server-side names

describe("safeAssetName", () => {
  it("keeps a plain filename and strips any path", () => {
    expect(safeAssetName("app-linux-amd64.tar.gz")).toBe("app-linux-amd64.tar.gz");
    expect(safeAssetName("dir/../evil/app.bin")).toBe("app.bin");
    expect(safeAssetName("a\\b\\c.zip")).toBe("c.zip");
  });

  it("rejects empty, dot and .git names, and control characters", () => {
    for (const n of ["", ".", "..", ".git", ".GIT", "git~1", "\0", "..."]) expect(safeAssetName(n)).toBeNull();
    expect(safeAssetName(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- numbers preserved in storage

/** A minimal SqlStorage over node:sqlite, enough for RepoImports' inserts and reads. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  db.exec(REPO_SCHEMA);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        const rows = stmt.all(...(bindings as never[]));
        return { toArray: () => rows, one: () => rows[0] } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
      }
      stmt.run(...(bindings as never[]));
      return { toArray: () => [], one: () => undefined } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
    },
  } as unknown as SqlStorage;
  // Apply the ALTER-added columns (e.g. the `imported` provenance columns) just as RepoDO does.
  migrateRepoSchema(sql);
  return sql;
}

describe("imports keep original issue and pull-request numbers", () => {
  it("inserts with the GitHub numbers, raises the counter and reports counts", () => {
    const imp = new RepoImports(sqlStorage());
    const people = new People([]);
    const rows = [
      mapIssue(issue({ number: 1, title: "first" }), people),
      mapIssue(issue({ number: 5, title: "a later issue" }), people),
      mapPull({ ...issue({ number: 2, title: "a pull" }), head: { ref: "f", sha: "s", repo: { full_name: "o/r" } }, base: { ref: "main", repo: { full_name: "o/r" } } }, "o/r", people),
      mapIssue(issue({ number: 42, title: "high number" }), people),
    ];
    expect(imp.issues(rows, "imp-1")).toBe(4);

    const counts = imp.counts();
    expect(counts.issues).toBe(3); // issue rows that are not pulls
    expect(counts.pulls).toBe(1);
    expect(counts.maxNumber).toBe(42);
    // The gap at 3 and 4 is preserved: no renumbering.
    expect(imp.pullNumbers(0, 10).map((p) => p.number)).toEqual([2]);
  });
});

// ---------------------------------------------------------------- releases: idempotent import, provenance

/** Releases over the node:sqlite storage, with just the RepoDO fields importRelease reads. */
function releases() {
  const sql = sqlStorage();
  const repo = { sql, meta: { repoId: "r1", defaultBranch: "main" } } as unknown as RepoDO;
  return { sql, rel: new Releases(repo, {} as Env), imp: new RepoImports(sql) };
}
const importer = (importId: string): Caller => ({ id: "u1", login: "olive", kind: "user", role: "admin", importId });
const ghRelease = (over: Partial<ImportedRelease> = {}): ImportedRelease => ({ tag_name: "v1.0.0", name: "1.0.0", body: "first", created_at: "2024-01-01T00:00:00Z", published_at: "2024-01-01T00:00:00Z", author: { login: "github:octocat" }, ...over });

describe("release import", () => {
  it("is idempotent: importing the same release again updates the one row", () => {
    const { sql, rel } = releases();
    const first = rel.importRelease(ghRelease(), importer("imp-1"));
    const again = rel.importRelease(ghRelease({ body: "edited" }), importer("imp-1"));
    expect(again.id).toBe(first.id);
    expect(sql.exec<{ id: number; body: string }>("SELECT id, body FROM releases").toArray()).toEqual([{ id: first.id, body: "edited" }]);
    // Another tag is another release.
    expect(rel.importRelease(ghRelease({ tag_name: "v2.0.0" }), importer("imp-1")).id).not.toBe(first.id);
  });

  it("counts a release the import did not write as foreign content", () => {
    const { rel, imp, sql } = releases();
    rel.importRelease(ghRelease(), importer("imp-1"));
    expect(imp.hasForeignContent("imp-1")).toBe(false);
    expect(imp.hasForeignContent("imp-2")).toBe(true);
    sql.exec("DELETE FROM releases");
    // A release people created by hand (no import provenance).
    sql.exec("INSERT INTO releases (tag_name, target_commitish, author_id, author_login, created_at, updated_at) VALUES ('v9', 'main', 'u1', 'olive', '2024-01-01', '2024-01-01')");
    expect(imp.hasForeignContent("imp-1")).toBe(true);
  });
});

// ---------------------------------------------------------------- who may import, retry, and the size limit

type Acc = Partial<Account> & { id: string; login: string; kind: Account["kind"] };
const acc = (a: Acc): Account => ({ status: "active", site_admin: 0, owner_id: null, agent_policy: null, ...a }) as unknown as Account;
const people = {
  olive: acc({ id: "u-olive", login: "olive", kind: "user" }),
  rita: acc({ id: "u-rita", login: "rita", kind: "user" }),
  milo: acc({ id: "u-milo", login: "milo", kind: "user" }),
  gone: acc({ id: "u-gone", login: "gone", kind: "user", status: "disabled" }),
  guild: acc({ id: "o-guild", login: "guild", kind: "org" }),
  shop: acc({ id: "o-shop", login: "shop", kind: "org" }),
  bot: acc({ id: "a-bot", login: "olive-bot", kind: "agent", owner_id: "u-olive" }),
  reader: acc({ id: "a-reader", login: "olive-reader", kind: "agent", owner_id: "u-olive", agent_policy: JSON.stringify({ maxRole: "read" }) }),
  orphan: acc({ id: "a-orphan", login: "gone-bot", kind: "agent", owner_id: "u-gone" }),
  guildBot: acc({ id: "a-guild", login: "guild-bot", kind: "agent", owner_id: "o-guild" }),
};
// olive owns guild and is a plain member of shop; rita administers guild; milo is a guild member.
const roles: Record<string, string> = { "o-guild/u-olive": "owner", "o-guild/u-rita": "admin", "o-guild/u-milo": "member", "o-shop/u-olive": "member" };

/** An ImportService over fake D1, workflow and directory lookups (enough for the permission checks). */
function service(env: Record<string, unknown> = {}) {
  const db = { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => ({ n: 0 }) }) }) };
  const svc = new ImportService({ DB: db, IMPORT_WORKFLOW: { create: async () => ({}) }, ...env } as unknown as Env);
  const byId = new Map(Object.values(people).map((a) => [a.id, a]));
  Object.assign(svc.dir, {
    account: async (id: string) => byId.get(id) ?? null,
    accountByLogin: async (login: string) => Object.values(people).find((a) => a.login === login) ?? null,
    orgRole: async (org: string, user: string) => roles[`${org}/${user}`] ?? null,
    audit: async () => undefined,
  });
  return svc;
}

describe("where an agent may import", () => {
  it("imports only where its owner may: the owner's account or an organization the owner administers", async () => {
    const svc = service();
    const may = (a: Account, o: Account) => svc.canImportInto(a, o);
    expect(await may(people.bot, people.olive)).toBe(true);
    expect(await may(people.bot, people.guild)).toBe(true);
    expect(await may(people.bot, people.rita)).toBe(false);
    expect(await may(people.bot, people.shop)).toBe(false);
    expect(await may(people.orphan, people.gone)).toBe(false);
    expect(await may(people.guildBot, people.guild)).toBe(true);
    expect(await may(people.guildBot, people.shop)).toBe(false);
    // The same rule as for the owner themselves.
    expect(await may(people.olive, people.olive)).toBe(true);
    expect(await may(people.olive, people.shop)).toBe(false);
  });

  it("needs an agent whose policy allows write, even where its owner may import", async () => {
    const svc = service();
    await expect(svc.create(people.reader, ["write"], { source: "octo/app", owner: "olive" })).rejects.toMatchObject({ status: 403, detail: expect.stringMatching(/write/) });
    await expect(svc.create(people.bot, ["write"], { source: "octo/app", owner: "rita" })).rejects.toMatchObject({ status: 403, detail: expect.stringMatching(/owner/) });
  });
});

describe("retrying an agent's import", () => {
  const failed = (over: Record<string, unknown> = {}) => ({ id: "imp-1", parent_id: null, kind: "repo", status: "failed", created_by: people.bot.id, target_owner_id: people.guild.id, repo_id: "r1", attempt: 1, token_ciphertext: null, source: "octo/app", ...over });
  const withRow = (row: ReturnType<typeof failed>) => {
    const svc = service();
    (svc as unknown as { row: () => Promise<unknown> }).row = async () => row;
    return svc;
  };

  it("lets a person who administers the target retry it, and tells the agent so", async () => {
    await expect(withRow(failed()).retry("imp-1", people.bot, null)).rejects.toMatchObject({ status: 403, detail: expect.stringMatching(/a person who administers guild/) });
    await expect(withRow(failed()).retry("imp-1", people.rita, null)).resolves.toBeTruthy();
    await expect(withRow(failed()).retry("imp-1", people.olive, null)).resolves.toBeTruthy();
  });

  it("still refuses everyone else", async () => {
    // A guild member who does not administer it.
    await expect(withRow(failed()).retry("imp-1", people.milo, null)).rejects.toMatchObject({ status: 404 });
    // A person's import stays theirs to retry, even for an admin of the target.
    await expect(withRow(failed({ created_by: people.olive.id })).retry("imp-1", people.rita, null)).rejects.toMatchObject({ status: 404 });
  });
});

describe("IMPORT_MAX_REPO_KB", () => {
  const check = (value: string | undefined, sizeKb: number) => (service({ IMPORT_MAX_REPO_KB: value }) as unknown as { assertRepoSize(kb: number): void }).assertRepoSize(sizeKb);

  it("treats a non-positive or invalid value as the default (10 GB)", () => {
    for (const v of ["-1", "0", "-0.5", "abc", "", undefined]) {
      expect(() => check(v, 1024), String(v)).not.toThrow();
      expect(() => check(v, 11 * 1024 * 1024), String(v)).toThrow(/10 GB import limit/);
    }
  });

  it("uses a positive value", () => {
    expect(() => check("2048", 2048)).not.toThrow();
    expect(() => check("2048", 2049)).toThrow(/import limit/);
  });
});

// ---------------------------------------------------------------- rate limits

describe("a GitHub rate limit pauses an import, it never fails it", () => {
  it("looking up the source repository waits out the limit and leaves the step running", async () => {
    const svc = service();
    const steps: Array<Record<string, unknown>> = [];
    const gh = { get: async () => { throw new RateLimited(42); } };
    Object.assign(svc, {
      context: async () => ({ row: { id: "imp", source: "octo/app" }, gh, steps: {}, summary: {} }),
      setStep: async (_id: string, _name: string, patch: Record<string, unknown>) => void steps.push(patch),
    });
    expect(await svc.stepRepository("imp")).toEqual({ wait: 42 });
    expect(steps.at(-1)).toEqual({ message: "GitHub rate limit reached; continuing in 42 seconds" });
    expect(steps.some((p) => p.status === "failed" || p.status === "done")).toBe(false);
  });
});

describe("transient GitHub failures are retried, real answers are not", () => {
  const client = (answers: Array<number | Error>) => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      const a = answers.shift() ?? 200;
      if (a instanceof Error) throw a;
      return new Response(JSON.stringify({ full_name: "octo/app" }), { status: a, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { gh: new GitHubClient("https://api.github.com", null, fetcher, [0, 0]), calls };
  };

  it("retries a dropped connection and a 503, then answers", async () => {
    const { gh, calls } = client([new TypeError("Network connection lost."), 503]);
    expect(await gh.get("repos/octo/app")).toEqual({ full_name: "octo/app" });
    expect(calls).toHaveLength(3);
  });

  it("gives up after its retries with GitHub's error", async () => {
    const { gh, calls } = client([502, 503, 504]);
    await expect(gh.get("repos/octo/app")).rejects.toBeInstanceOf(GitHubError);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 404 or a timeout", async () => {
    const a = client([404]);
    await expect(a.gh.get("repos/octo/app")).rejects.toMatchObject({ status: 404 });
    expect(a.calls).toHaveLength(1);
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const b = client([timeout]);
    await expect(b.gh.get("repos/octo/app")).rejects.toThrow(/timeout/);
    expect(b.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- texts that point at the web UI

describe("import texts name what the web UI shows", () => {
  const source = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const repoTabs = [...source("../../src/web/repo-settings.tsx").matchAll(/\["\w+", "([^"]+)", `\$\{base\}/g)].map((m) => m[1]);

  it("points at repository settings tabs that exist", () => {
    expect(repoTabs).toContain("Branch protection");
    for (const f of ["../../src/imports/service.ts", "../../src/web/imports.tsx"]) {
      for (const m of source(f).matchAll(/Settings → ([A-Z][A-Za-z ]*[a-z])/g)) expect(repoTabs, `${f}: ${m[0]}`).toContain(m[1]);
    }
  });

  it("the migration guide's web import steps use the web UI's labels", () => {
    const guide = source("../../docs/migrate-from-github.md");
    const section = guide.slice(guide.indexOf("## Import from the web"), guide.indexOf("## Import with the CLI"));
    // Labels are text nodes or props (radio options, checkboxes), so look for them anywhere in the source.
    const ui = ["imports.tsx", "account.tsx", "ui.tsx"].map((f) => source(`../../src/web/${f}`)).join("\n");
    // Labels the page puts together from parts.
    const built: Record<string, string> = { "Select all shown": 'Select all{filter ? " shown"', "Import N repositories": '"repository" : "repositories"' };
    const labels = [...section.matchAll(/\*\*([A-Z][^*\n]+)\*\*/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(10);
    for (const label of labels) for (const part of label.split(" → ")) expect(ui.includes(built[part] ?? part), `migrate-from-github.md: **${label}** (${part})`).toBe(true);
  });

  it("does not say releases are unsupported", () => {
    expect(source("../../src/web/imports.tsx")).not.toMatch(/When Diffinery supports releases/);
    expect(source("../../docs/migrate-from-github.md")).not.toMatch(/where the server's releases feature is enabled/);
  });
});
