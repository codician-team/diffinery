import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeServer, isolatedEnv, run, tempDir, type FakeServer } from "./helpers.js";

describe("migrate github", () => {
  let srv: FakeServer;
  let env: NodeJS.ProcessEnv;
  let gitRoot: string;
  let srcBare: string;

  beforeEach(async () => {
    env = isolatedEnv();
    const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();
    // Source repository standing in for GitHub: main, develop, a tag and a pull ref.
    const work = tempDir("diffinery-src-");
    g(work, "init", "-q", "-b", "main");
    g(work, "commit", "-q", "--allow-empty", "-m", "one");
    g(work, "tag", "v1");
    g(work, "checkout", "-q", "-b", "develop");
    g(work, "commit", "-q", "--allow-empty", "-m", "two");
    srcBare = path.join(tempDir("diffinery-gh-"), "widgets.git");
    g(work, "clone", "-q", "--bare", work, srcBare);
    g(srcBare, "update-ref", "refs/pull/2/head", g(work, "rev-parse", "HEAD"));
    // Target: an empty bare repository served over smart HTTP.
    gitRoot = tempDir("diffinery-git-");
    mkdirSync(path.join(gitRoot, "alice"));
    g(path.join(gitRoot, "alice"), "init", "-q", "--bare", "widgets.git");

    srv = await fakeServer({ gitRoot, gitAuth: `Basic ${Buffer.from("x-token:dfy_t").toString("base64")}` });
    const now = "2024-05-01T10:00:00Z";
    const ghRepo = { full_name: "gh-org/widgets", name: "widgets", private: false, visibility: "public", description: "Widgets!", default_branch: "develop", clone_url: srcBare, html_url: "https://github.com/gh-org/widgets" };
    srv.on("GET", "/gh/repos/gh-org/widgets", { body: ghRepo });
    srv.on("GET", "/gh/repos/gh-org/widgets/actions/variables", { body: { total_count: 1, variables: [{ name: "REGION", value: "eu-west" }] } });
    srv.on("GET", "/gh/repos/gh-org/widgets/actions/secrets", { body: { total_count: 1, secrets: [{ name: "NPM_TOKEN" }] } });
    srv.on("GET", "/gh/repos/gh-org/widgets/labels", { body: [{ name: "bug", color: "d73a4a", description: "Broken" }] });
    srv.on("GET", "/gh/repos/gh-org/widgets/pulls", {
      body: [
        { number: 2, title: "Develop work", body: "PR body", draft: false, user: { login: "carol" }, created_at: now, head: { ref: "develop", repo: { full_name: "gh-org/widgets" } }, base: { ref: "main" } },
        { number: 4, title: "From a fork", body: null, user: { login: "mallory" }, created_at: now, head: { ref: "patch-1", repo: { full_name: "mallory/widgets" } }, base: { ref: "main" } },
      ],
    });
    srv.on("GET", "/gh/repos/gh-org/widgets/issues", {
      body: [
        { number: 5, title: "Open issue", body: "five", state: "open", user: { login: "dave" }, labels: [], comments: 0, created_at: now },
        { number: 1, title: "Old bug", body: "it breaks", state: "closed", state_reason: "not_planned", user: { login: "bob" }, labels: [{ name: "bug" }], comments: 1, created_at: now },
        { number: 2, title: "Develop work", body: "PR body", state: "open", user: { login: "carol" }, labels: [], comments: 0, created_at: now, pull_request: {} },
        { number: 3, title: "Merged PR", body: "", state: "closed", user: { login: "carol" }, labels: [], comments: 0, created_at: now, pull_request: {} },
        { number: 4, title: "From a fork", body: null, state: "open", user: { login: "mallory" }, labels: [], comments: 0, created_at: now, pull_request: {} },
      ],
    });
    srv.on("GET", "/gh/repos/gh-org/widgets/issues/1/comments", { body: [{ body: "me too", user: { login: "erin" }, created_at: "2024-05-02T00:00:00Z" }] });

    let n = 0;
    srv.on("GET", "/api/v3/user", { body: { login: "alice" } });
    srv.on("POST", "/api/v3/user/repos", (r) => ({ status: 201, body: { full_name: "alice/widgets", visibility: (r.body as { visibility: string }).visibility } }));
    srv.on("PATCH", "/api/v3/repos/alice/widgets", { body: {} });
    srv.on("PUT", /\/actions\/variables\//, { status: 204 });
    srv.on("POST", "/api/v3/repos/alice/widgets/labels", (r) => ({ status: 201, body: r.body }));
    srv.on("POST", "/api/v3/repos/alice/widgets/issues", (r) => ({ status: 201, body: { number: ++n, title: (r.body as { title: string }).title } }));
    srv.on("POST", "/api/v3/repos/alice/widgets/pulls", (r) => ({ status: 201, body: { number: ++n, title: (r.body as { title: string }).title } }));
    srv.on("POST", /\/issues\/\d+\/comments$/, { status: 201, body: {} });
    srv.on("PATCH", /\/issues\/\d+$/, { body: {} });
    Object.assign(env, { DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "dfy_t", GH_TOKEN: "ght", GITHUB_API_URL: `${srv.url}/gh` });
  });
  afterEach(() => srv.close());

  it("creates the repo, pushes branches and tags, and copies issues, PRs, variables and secret names", async () => {
    const r = await run(["migrate", "github", "gh-org/widgets", "--local", "--issues"], { env });
    expect(r.stderr).not.toContain("error");
    expect(r.code).toBe(0);

    // Repository created with GitHub's visibility and description.
    expect(srv.find("POST", "/api/v3/user/repos")[0]!.body).toEqual({ name: "widgets", description: "Widgets!", visibility: "public" });

    // Git data: heads and tags only.
    const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: path.join(gitRoot, "alice", "widgets.git"), env }).toString().trim().split("\n").sort();
    expect(refs).toEqual(["refs/heads/develop", "refs/heads/main", "refs/tags/v1"]);
    expect(srv.find("PATCH", "/api/v3/repos/alice/widgets")[0]!.body).toEqual({ default_branch: "develop" });

    // Variables copied, secrets listed.
    expect(srv.find("PUT", /\/actions\/variables\//).map((q) => [q.path, q.body])).toEqual([["/api/v3/repos/alice/widgets/actions/variables/REGION", { value: "eu-west" }]]);
    expect(r.stdout).toContain("diffinery secret set NPM_TOKEN -R alice/widgets");

    // Labels, then issues and PRs in GitHub number order.
    expect(srv.find("POST", "/api/v3/repos/alice/widgets/labels")[0]!.body).toEqual({ name: "bug", color: "d73a4a", description: "Broken" });
    const issues = srv.find("POST", "/api/v3/repos/alice/widgets/issues").map((q) => q.body as { title: string; body: string; labels?: string[] });
    expect(issues.map((i) => i.title)).toEqual(["Old bug", "Open issue"]);
    expect(issues[0]!.body).toBe("> Imported from GitHub issue [#1](https://github.com/gh-org/widgets/issues/1) by @bob on 2024-05-01\n\nit breaks");
    expect(issues[0]!.labels).toEqual(["bug"]);
    const comment = srv.find("POST", /\/issues\/1\/comments$/)[0]!.body as { body: string };
    expect(comment.body).toBe("> Imported from GitHub: comment by @erin on 2024-05-02\n\nme too");
    expect(srv.find("PATCH", /\/issues\/1$/)[0]!.body).toEqual({ state: "closed", state_reason: "not_planned" });

    const pulls = srv.find("POST", "/api/v3/repos/alice/widgets/pulls").map((q) => q.body);
    expect(pulls).toEqual([{ title: "Develop work", body: "> Imported from GitHub pull request [#2](https://github.com/gh-org/widgets/pull/2) by @carol on 2024-05-01\n\nPR body", head: "develop", base: "main" }]);
    expect(r.stdout).toContain("#4: head branch is in a fork");
    expect(r.stdout).toContain("issues:     2 (1 comments)");

    // The GitHub token went to GitHub only, the Diffinery token to Diffinery only.
    for (const q of srv.requests) {
      if (q.path.startsWith("/gh/")) expect(q.headers.authorization).toBe("Bearer ght");
      else if (q.path.startsWith("/api/")) expect(q.headers.authorization).toBe("Bearer dfy_t");
    }
  });

  it("repo clone authenticates for that command only", async () => {
    await run(["migrate", "github", "gh-org/widgets", "--local"], { env });
    const cwd = tempDir("diffinery-clone-");
    const r = await run(["repo", "clone", "alice/widgets", "w"], { env, cwd });
    expect(r.code).toBe(0);
    const dir = path.join(cwd, "w");
    expect(execFileSync("git", ["branch", "-r"], { cwd: dir, env }).toString()).toContain("origin/develop");
    const config = execFileSync("git", ["config", "--list", "--local"], { cwd: dir, env }).toString();
    expect(config).toContain(`remote.origin.url=${srv.url}/alice/widgets.git`);
    expect(config).not.toMatch(/extraheader|dfy_t|Basic/i);
    // Without the header, the server refuses.
    const anon = await run(["repo", "clone", "alice/widgets", "w2"], { env: { ...env, DIFFINERY_TOKEN: "", GIT_TERMINAL_PROMPT: "0" }, cwd });
    expect(anon.code).not.toBe(0);
  });

  it("without --local, starts a server import and follows it to completion", async () => {
    const base = {
      id: "imp1",
      html_url: `${srv.url}/imports/imp1`,
      kind: "repository",
      source: { full_name: "gh-org/widgets" },
      target: { full_name: "alice/widgets", html_url: `${srv.url}/alice/widgets` },
      git: { phase: "done", message: "pushed", bytes: 123, chunks: 1 },
      summary: { secretNames: ["NPM_TOKEN"], environments: { secretNames: ["prod/DEPLOY_KEY", "Staging EU/API_KEY"] } },
      warnings: [] as string[],
      error: null,
      children: [] as unknown[],
    };
    const steps = (s: string) => [
      { name: "repository", title: "Repository", status: "done", message: "alice/widgets", count: null },
      { name: "git", title: "Git data", status: s === "succeeded" ? "done" : "running", message: null, count: null },
    ];
    srv.on("POST", "/api/v3/diffinery/imports", { status: 201, body: { ...base, status: "queued", steps: steps("queued") } });
    let polls = 0;
    srv.on("GET", "/api/v3/diffinery/imports/imp1", () => {
      polls++;
      const status = polls >= 2 ? "succeeded" : "running";
      return { status: 200, body: { ...base, status, steps: steps(status) } };
    });

    const r = await run(["migrate", "github", "gh-org/widgets"], { env });
    expect(r.code).toBe(0);
    // The request carried the source, resolved owner, keep-visibility and the GitHub token.
    const post = srv.find("POST", "/api/v3/diffinery/imports")[0]!.body as Record<string, unknown>;
    expect(post).toMatchObject({ source: "gh-org/widgets", owner: "alice", visibility: "keep", github_token: "ght" });
    // The ambient GitHub token goes along, and the command says so.
    expect(r.stderr).toContain(`note: sending GH_TOKEN to ${srv.url} so it can read gh-org/widgets from GitHub during the import`);
    // It polled until the import finished, and reported the result and the secrets to set by hand.
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(r.stdout).toContain("Imported gh-org/widgets → alice/widgets");
    expect(r.stdout).toContain("diffinery secret set NPM_TOKEN -R alice/widgets");
    // An environment secret gets a command that works (`secret set` has no environment option).
    expect(r.stdout).not.toContain("secret set prod/");
    const envLines = r.stdout.split("\n").filter((l) => l.includes("/environments/"));
    expect(envLines.map((l) => l.trim())).toEqual([
      "diffinery api PUT /repos/alice/widgets/environments/prod/secrets/DEPLOY_KEY -f value=...",
      "diffinery api PUT /repos/alice/widgets/environments/Staging%20EU/secrets/API_KEY -f value=...",
    ]);
    // Running the printed command (with a value) sets that environment secret.
    srv.on("PUT", "/api/v3/repos/alice/widgets/environments/Staging%20EU/secrets/API_KEY", { status: 201 });
    const set = await run(envLines[1]!.trim().replace(/^diffinery /, "").replace(/\.\.\.$/, "s3cret").split(" "), { env });
    expect(set.code).toBe(0);
    expect(srv.find("PUT", "/api/v3/repos/alice/widgets/environments/Staging%20EU/secrets/API_KEY")[0]!.body).toEqual({ value: "s3cret" });
    // The git data was NOT cloned or pushed by the CLI; the server does that.
    expect(srv.find("POST", "/api/v3/user/repos")).toHaveLength(0);
    // The GitHub token never went to Diffinery's own endpoints.
    for (const q of srv.requests) if (q.path.startsWith("/api/")) expect(q.headers.authorization).toBe("Bearer dfy_t");
  });

  it("--private and --to override the target", async () => {
    srv.on("GET", "/api/v3/repos/team/w2", { status: 404, body: { message: "repository not found" } });
    srv.on("POST", "/api/v3/orgs/team/repos", { status: 201, body: { full_name: "team/w2", visibility: "private" } });
    srv.on("PATCH", "/api/v3/repos/team/w2", { body: {} });
    mkdirSync(path.join(gitRoot, "team"));
    execFileSync("git", ["init", "-q", "--bare", "w2.git"], { cwd: path.join(gitRoot, "team"), env });
    const r = await run(["migrate", "github", "https://github.com/gh-org/widgets", "--local", "--to", "team/w2", "--private"], { env });
    expect(r.code).toBe(0);
    expect(srv.find("POST", "/api/v3/orgs/team/repos")[0]!.body).toMatchObject({ name: "w2", visibility: "private" });
    expect(srv.find("POST", /\/issues$/)).toHaveLength(0);
  });
});
