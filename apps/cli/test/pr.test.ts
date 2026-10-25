import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRemote } from "../src/git.js";
import { fakeServer, gitRepo, isolatedEnv, run, type FakeServer } from "./helpers.js";

const pull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: "Add thing",
  body: "",
  state: "open",
  user: { login: "alice", type: "User" },
  labels: [],
  assignees: [],
  comments: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  html_url: `http://x/acme/widgets/pull/${n}`,
  head: { ref: "feature/x", sha: "abc" },
  base: { ref: "main" },
  ...extra,
});

describe("remote parsing", () => {
  it("recognizes https, ssh and scp-style remotes for the configured host", () => {
    expect(parseRemote("https://diffinery.com/acme/widgets.git", "diffinery.com")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRemote("http://127.0.0.1:8787/acme/widgets", "127.0.0.1:8787")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRemote("git@diffinery.com:acme/widgets.git", "diffinery.com")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRemote("https://github.com/acme/widgets.git", "diffinery.com")).toBeNull();
  });
});

describe("pull requests", () => {
  let srv: FakeServer;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    srv = await fakeServer();
    env = isolatedEnv({ DIFFINERY_URL: srv.url, DIFFINERY_TOKEN: "dfy_t" });
  });
  afterEach(() => srv.close());

  it("pr create infers the repo from origin and the head from the current branch", async () => {
    srv.on("POST", "/api/v3/repos/acme/widgets/pulls", { status: 201, body: pull(7) });
    const cwd = gitRepo(env, `${srv.url}/acme/widgets.git`, "feature/x");
    const r = await run(["pr", "create", "--title", "Add thing", "-b", "Body text", "--base", "main", "--draft", "--intent", "Make widgets faster"], { env, cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("#7");
    const req = srv.find("POST", "/api/v3/repos/acme/widgets/pulls")[0]!;
    expect(req.headers.authorization).toBe("Bearer dfy_t");
    expect(req.body).toEqual({ title: "Add thing", body: "Body text", head: "feature/x", base: "main", draft: true, intent: "Make widgets faster" });
  });

  it("pr create with -R and --head omits unset fields", async () => {
    srv.on("POST", "/api/v3/repos/o/r/pulls", { status: 201, body: pull(1) });
    const r = await run(["pr", "create", "-R", "o/r", "--title", "T", "--head", "topic"], { env });
    expect(r.code).toBe(0);
    expect(srv.find("POST", "/api/v3/repos/o/r/pulls")[0]!.body).toEqual({ title: "T", head: "topic" });
  });

  it("pr create --auto and --no-auto send auto_merge, and say what happened", async () => {
    srv.on("POST", "/api/v3/repos/o/r/pulls", (req) =>
      (req.body as { auto_merge?: boolean }).auto_merge
        ? { status: 201, body: { ...pull(2), auto_merge: { merge_method: "squash" } } }
        : { status: 201, body: { ...pull(3), auto_merge: null, auto_merge_skipped: "main has no required status checks, so auto-merge would not wait for CI" } },
    );
    const on = await run(["pr", "create", "-R", "o/r", "--title", "T", "--head", "topic", "--auto"], { env });
    expect(on.code).toBe(0);
    expect(srv.find("POST", "/api/v3/repos/o/r/pulls")[0]!.body).toEqual({ title: "T", head: "topic", auto_merge: true });
    expect(on.stdout).toContain("auto-merge: on (squash)");
    const off = await run(["pr", "create", "-R", "o/r", "--title", "T", "--head", "topic", "--no-auto"], { env });
    expect(srv.find("POST", "/api/v3/repos/o/r/pulls")[1]!.body).toEqual({ title: "T", head: "topic", auto_merge: false });
    expect(off.stdout).not.toContain("auto-merge: on");
    const both = await run(["pr", "create", "-R", "o/r", "--title", "T", "--auto", "--no-auto"], { env });
    expect(both.code).toBe(2);
  });

  it("pr create says why auto-merge stayed off when it was asked for", async () => {
    srv.on("POST", "/api/v3/repos/o/r/pulls", { status: 201, body: { ...pull(4), auto_merge: null, auto_merge_skipped: "main has no required status checks, so auto-merge would not wait for CI" } });
    const r = await run(["pr", "create", "-R", "o/r", "--title", "T", "--head", "topic", "--auto"], { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("warning: auto-merge is off: main has no required status checks");
  });

  it("pr create requires a title", async () => {
    const r = await run(["pr", "create", "-R", "o/r"], { env });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--title is required");
  });

  it("pr merge sends the method and delete_branch", async () => {
    srv.on("PUT", "/api/v3/repos/o/r/pulls/12/merge", { body: { merged: true, sha: "0123456789abcdef", method: "squash" } });
    const r = await run(["pr", "merge", "12", "-R", "o/r", "--squash", "--delete-branch"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Merged #12");
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/12/merge")[0]!.body).toEqual({ merge_method: "squash", delete_branch: true });
  });

  it("pr merge defaults to a merge commit and rejects conflicting flags", async () => {
    srv.on("PUT", "/api/v3/repos/o/r/pulls/3/merge", { body: { merged: true, sha: "abc", method: "merge" } });
    expect((await run(["pr", "merge", "3", "-R", "o/r"], { env })).code).toBe(0);
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/3/merge")[0]!.body).toEqual({ merge_method: "merge" });
    const bad = await run(["pr", "merge", "3", "-R", "o/r", "--squash", "--rebase"], { env });
    expect(bad.code).toBe(2);
  });

  it("pr merge queues the pull request when the base branch uses a merge queue", async () => {
    srv.on("PUT", "/api/v3/repos/o/r/pulls/6/merge", { status: 405, body: { message: "main requires a merge queue: add the pull request to the queue" } });
    srv.on("PUT", "/api/v3/repos/o/r/pulls/6/merge-queue", { status: 201, body: { state: "queued", entry: { position: 2 }, merge_commit_sha: null, reason: null } });
    const r = await run(["pr", "merge", "6", "-R", "o/r", "-d"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Added #6 to the merge queue (position 2)");
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/6/merge-queue")[0]!.body).toEqual({ delete_branch: true });
    // Like gh, --disable-auto turns auto-merge off; a pull request already in the queue leaves it too.
    srv.on("DELETE", "/api/v3/repos/o/r/pulls/6/auto-merge", { status: 204 });
    srv.on("DELETE", "/api/v3/repos/o/r/pulls/6/merge-queue", { status: 204 });
    const off = await run(["pr", "merge", "6", "-R", "o/r", "--disable-auto"], { env });
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("Turned off auto-merge for #6 and removed it from the merge queue");
    expect(srv.find("DELETE", "/api/v3/repos/o/r/pulls/6/auto-merge")).toHaveLength(1);
    const admin = await run(["pr", "merge", "6", "-R", "o/r", "--admin"], { env });
    expect(admin.code).toBe(1);
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/6/merge").at(-1)!.body).toEqual({ merge_method: "merge", bypass_merge_queue: true, bypass_rules: true });
  });

  it("pr merge --auto enables auto-merge like gh, and --disable-auto turns it off", async () => {
    srv.on("PUT", "/api/v3/repos/o/r/pulls/8/auto-merge", { body: { state: "enabled", auto_merge: { merge_method: "squash", enabled_by: { login: "alice" } }, merge_commit_sha: null } });
    const r = await run(["pr", "merge", "8", "-R", "o/r", "--auto", "--squash", "-d", "-t", "Ship it", "--match-head-commit", "abc"], { env });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Auto-merge is on for #8 (squash)");
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/8/auto-merge")[0]!.body).toEqual({ merge_method: "squash", delete_branch: true, commit_title: "Ship it", sha: "abc" });
    // It never tries a direct merge or the queue itself.
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/8/merge")).toHaveLength(0);
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/8/merge-queue")).toHaveLength(0);
    // Without a method flag the server picks one (the queue's, or squash under linear history).
    expect((await run(["pr", "merge", "8", "-R", "o/r", "--auto"], { env })).code).toBe(0);
    expect(srv.find("PUT", "/api/v3/repos/o/r/pulls/8/auto-merge")[1]!.body).toEqual({});
    // When it is ready already, it merges (or joins the queue) at once.
    srv.on("PUT", "/api/v3/repos/o/r/pulls/9/auto-merge", { body: { state: "merged", auto_merge: null, merge_commit_sha: "0123456789abcdef" } });
    expect((await run(["pr", "merge", "9", "-R", "o/r", "--auto"], { env })).stdout).toContain("Merged #9 0123456789ab");
    srv.on("PUT", "/api/v3/repos/o/r/pulls/10/auto-merge", { body: { state: "queued", auto_merge: null, merge_commit_sha: null } });
    expect((await run(["pr", "merge", "10", "-R", "o/r", "--auto"], { env })).stdout).toContain("Added #10 to the merge queue");
    const json = await run(["pr", "merge", "8", "-R", "o/r", "--auto", "--json"], { env });
    expect(JSON.parse(json.stdout).state).toBe("enabled");
    // --auto can't be combined with --admin (a bypass) or --disable-auto.
    expect((await run(["pr", "merge", "8", "-R", "o/r", "--auto", "--admin"], { env })).code).toBe(2);
    expect((await run(["pr", "merge", "8", "-R", "o/r", "--auto", "--disable-auto"], { env })).code).toBe(2);
    // --disable-auto sends DELETE to the same path; not being in a queue is fine.
    srv.on("DELETE", "/api/v3/repos/o/r/pulls/8/auto-merge", { status: 204 });
    srv.on("DELETE", "/api/v3/repos/o/r/pulls/8/merge-queue", { status: 404, body: { message: "#8 is not in the merge queue" } });
    const off = await run(["pr", "merge", "8", "-R", "o/r", "--disable-auto"], { env });
    expect(off.stderr).toBe("");
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("Turned off auto-merge for #8");
    expect(off.stdout).not.toContain("merge queue");
    expect(srv.find("DELETE", "/api/v3/repos/o/r/pulls/8/auto-merge")).toHaveLength(1);
    expect(JSON.parse((await run(["pr", "merge", "8", "-R", "o/r", "--disable-auto", "--json"], { env })).stdout)).toEqual({ auto_merge: null, dequeued: false });
    // Other refusals still surface.
    srv.on("DELETE", "/api/v3/repos/o/r/pulls/11/auto-merge", { status: 403, body: { message: "write access is required to disable auto-merge" } });
    const denied = await run(["pr", "merge", "11", "-R", "o/r", "--disable-auto"], { env });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("write access is required");
  });

  it("surfaces the server's { message } on errors", async () => {
    srv.on("PUT", "/api/v3/repos/o/r/pulls/4/merge", { status: 405, body: { message: "pull request is not mergeable: 1 approval required" } });
    const r = await run(["pr", "merge", "4", "-R", "o/r"], { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("1 approval required");
  });

  it("pr review maps flags to review events", async () => {
    srv.on("POST", "/api/v3/repos/o/r/pulls/5/reviews", { status: 201, body: { id: "rv1", state: "APPROVED" } });
    expect((await run(["pr", "review", "5", "-R", "o/r", "--approve"], { env })).code).toBe(0);
    expect((await run(["pr", "review", "5", "-R", "o/r", "--request-changes", "-b", "fix it"], { env })).code).toBe(0);
    expect((await run(["pr", "review", "5", "-R", "o/r", "--comment"], { env })).code).toBe(2);
    expect(srv.find("POST", "/api/v3/repos/o/r/pulls/5/reviews").map((r) => r.body)).toEqual([{ event: "APPROVE" }, { event: "REQUEST_CHANGES", body: "fix it" }]);
  });

  it("pr list and --json", async () => {
    srv.on("GET", "/api/v3/repos/o/r/pulls", { body: [pull(1), pull(2, { draft: true, title: "WIP" })] });
    const r = await run(["pr", "list", "-R", "o/r"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/#1\s+Add thing/);
    expect(r.stdout).toMatch(/#2\s+WIP.*draft/);
    const j = await run(["pr", "list", "-R", "o/r", "--json"], { env });
    expect(JSON.parse(j.stdout)).toHaveLength(2);
    expect(srv.find("GET", "/api/v3/repos/o/r/pulls")[0]!.query.state).toBe("open");
  });

  it("pr checks exits 1 on failure", async () => {
    srv.on("GET", "/api/v3/repos/o/r/pulls/9", { body: { ...pull(9), checks: [{ name: "ci / test", state: "failure" }, { name: "lint", state: "success" }] } });
    const r = await run(["pr", "checks", "9", "-R", "o/r"], { env });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("ci / test");
  });

  it("pr list --head only lists pull requests from that branch", async () => {
    srv.on("GET", "/api/v3/repos/o/r/pulls", { body: [] });
    const r = await run(["pr", "list", "-R", "o/r", "--head", "topic"], { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("No open pull requests from topic in o/r.");
    expect(srv.find("GET", "/api/v3/repos/o/r/pulls")[0]!.query).toMatchObject({ head: "o:topic", state: "open" });
  });

  it("pr view, checks, diff, comment, review, ready and merge default to the current branch's pull request", async () => {
    srv.on("GET", "/api/v3/repos/acme/widgets/pulls", (req) => ({ body: req.query.head === "acme:feature/x" ? [pull(7)] : [] }));
    srv.on("GET", "/api/v3/repos/acme/widgets/pulls/7", { body: { ...pull(7), checks: [{ name: "ci / test", state: "success" }] } });
    srv.on("GET", "/api/v3/repos/acme/widgets/pulls/7/files", { body: [{ filename: "a.txt", status: "modified" }] });
    srv.on("POST", "/api/v3/repos/acme/widgets/issues/7/comments", { status: 201, body: { id: "c1", body: "hi", user: { login: "alice" }, created_at: "" } });
    srv.on("POST", "/api/v3/repos/acme/widgets/pulls/7/reviews", { status: 201, body: { id: "rv1", state: "APPROVED" } });
    srv.on("PATCH", "/api/v3/repos/acme/widgets/pulls/7", { body: pull(7) });
    srv.on("PUT", "/api/v3/repos/acme/widgets/pulls/7/merge", { body: { merged: true, sha: "abc", method: "squash" } });
    const cwd = gitRepo(env, `${srv.url}/acme/widgets.git`, "feature/x");
    const view = await run(["pr", "view"], { env, cwd });
    expect(view.stderr).toBe("");
    expect(view.code).toBe(0);
    expect(view.stdout).toContain("#7");
    expect(srv.find("GET", "/api/v3/repos/acme/widgets/pulls")[0]!.query).toMatchObject({ head: "acme:feature/x", state: "open" });
    expect((await run(["pr", "checks"], { env, cwd })).code).toBe(0);
    expect((await run(["pr", "diff", "--name-only"], { env, cwd })).stdout).toBe("a.txt\n");
    expect((await run(["pr", "comment", "-b", "hi"], { env, cwd })).stdout).toContain("Commented on #7");
    expect((await run(["pr", "review", "--approve"], { env, cwd })).stdout).toContain("Approved #7");
    expect((await run(["pr", "ready"], { env, cwd })).stdout).toContain("Marked #7 ready");
    expect((await run(["pr", "merge", "--squash"], { env, cwd })).stdout).toContain("Merged #7");
    // Usage errors are reported before any lookup.
    const before = srv.requests.length;
    expect((await run(["pr", "merge", "--auto", "--admin"], { env, cwd })).code).toBe(2);
    expect((await run(["pr", "comment"], { env, cwd, stdinTTY: true })).code).toBe(2);
    expect(srv.requests.length).toBe(before);
  });

  it("pr view shows auto-merge and, for an agent, what is left before it lands", async () => {
    const detail = { mergeable: false, mergeable_state: "blocked", merge_blockers: ["needs 1 more approving review(s)", "required check 'ci' is in_progress"], approvals: 0, required_approvals: 1, checks: [] };
    srv.on("GET", "/api/v3/repos/o/r/pulls/3", { body: { ...pull(3), ...detail, auto_merge: { merge_method: "squash" }, auto_merge_blockers: ["required check 'ci' is in_progress"] } });
    srv.on("GET", "/api/v3/repos/o/r/pulls/4", { body: { ...pull(4), ...detail, auto_merge: { merge_method: "merge" }, auto_merge_blockers: [] } });
    srv.on("GET", "/api/v3/repos/o/r/pulls/5", { body: { ...pull(5), ...detail, auto_merge: { merge_method: "rebase" } } });
    srv.on("GET", "/api/v3/repos/o/r/pulls/6", { body: { ...pull(6), ...detail, auto_merge: null } });
    const agent = (await run(["pr", "view", "3", "-R", "o/r"], { env })).stdout;
    expect(agent).toContain("auto-merge: on (squash), it merges by itself once these are done:\n  • required check 'ci' is in_progress\n");
    expect((await run(["pr", "view", "4", "-R", "o/r"], { env })).stdout).toContain("auto-merge: on (merge), nothing is left, it merges now");
    expect((await run(["pr", "view", "5", "-R", "o/r"], { env })).stdout).toContain("auto-merge: on (rebase), it merges by itself once every requirement is met");
    expect((await run(["pr", "view", "6", "-R", "o/r"], { env })).stdout).not.toContain("auto-merge");
  });

  it("without a number, fails clearly when there is no current branch or no open pull request for it", async () => {
    srv.on("GET", "/api/v3/repos/acme/widgets/pulls", { body: [] });
    const cwd = gitRepo(env, `${srv.url}/acme/widgets.git`, "lonely");
    const none = await run(["pr", "checks"], { env, cwd });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no open pull request for the current branch (lonely) in acme/widgets; pass a pull request number");
    const outside = await run(["pr", "view", "-R", "o/r"], { env });
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain("no current branch");
    expect(outside.stderr).toContain("pass a pull request number");
  });

  it("pr checks --watch polls until nothing is pending", async () => {
    const states = [["queued", "queued"], ["in_progress", "success"], ["in_progress", "success"], ["failure", "success"]];
    let i = 0;
    srv.on("GET", "/api/v3/repos/o/r/pulls/9", () => {
      const [a, b] = states[Math.min(i++, states.length - 1)]!;
      return { body: { ...pull(9), checks: [{ name: "ci / test", state: a }, { name: "lint", state: b }] } };
    });
    // Piped: one table, the final one.
    const r = await run(["pr", "checks", "9", "-R", "o/r", "--watch", "-i", "0"], { env });
    expect(r.code).toBe(1);
    expect(srv.find("GET", "/api/v3/repos/o/r/pulls/9")).toHaveLength(4);
    expect(r.stdout.match(/ci \/ test/g)).toHaveLength(1);
    expect(r.stdout).toMatch(/ci \/ test\s+failure/);
    // On a terminal: the table each time it changes.
    i = 0;
    const tty = await run(["pr", "checks", "9", "-R", "o/r", "--watch", "--interval", "0"], { env: { ...env, NO_COLOR: "1" }, stdoutTTY: true });
    expect(tty.code).toBe(1);
    expect(tty.stdout.match(/ci \/ test/g)).toHaveLength(3);
    expect(tty.stdout).toMatch(/ci \/ test\s+queued[\s\S]*ci \/ test\s+in progress[\s\S]*ci \/ test\s+failure/);
    // --json prints only the final list, and all passing exits 0.
    states.splice(3, 1, ["success", "skipped"]);
    i = 0;
    const j = await run(["pr", "checks", "9", "-R", "o/r", "--watch", "-i", "0", "--json"], { env });
    expect(j.code).toBe(0);
    expect(JSON.parse(j.stdout)).toEqual([{ name: "ci / test", state: "success" }, { name: "lint", state: "skipped" }]);
    // Without --watch, pending checks exit 8.
    i = 0;
    expect((await run(["pr", "checks", "9", "-R", "o/r"], { env })).code).toBe(8);
  });

  it("pr checks --watch waits for the first check right after a push, and gives up after 2 minutes", async () => {
    let i = 0;
    srv.on("GET", "/api/v3/repos/o/r/pulls/9", () => ({ body: { ...pull(9), checks: i++ < 2 ? [] : [{ name: "ci / test", state: i < 4 ? "in_progress" : "success" }] } }));
    const r = await run(["pr", "checks", "9", "-R", "o/r", "--watch", "-i", "0"], { env });
    expect(r.code).toBe(0);
    expect(srv.find("GET", "/api/v3/repos/o/r/pulls/9")).toHaveLength(4);
    expect(r.stdout).toMatch(/ci \/ test\s+success/);
    // A repository without CI: no checks ever appear, so it stops after 2 minutes of polls (1 s each at -i 0).
    srv.on("GET", "/api/v3/repos/o/r/pulls/10", { body: { ...pull(10), checks: [] } });
    const none = await run(["pr", "checks", "10", "-R", "o/r", "--watch", "-i", "0"], { env });
    expect(none.code).toBe(0);
    expect(none.stderr).toContain("No checks reported");
    expect(srv.find("GET", "/api/v3/repos/o/r/pulls/10")).toHaveLength(121);
  });

  it("pr comment posts to the issue comments endpoint", async () => {
    srv.on("POST", "/api/v3/repos/o/r/issues/9/comments", { status: 201, body: { id: "c1", body: "hi", user: { login: "alice" }, created_at: "" } });
    expect((await run(["pr", "comment", "9", "-R", "o/r", "-b", "hi"], { env })).code).toBe(0);
    expect(srv.find("POST", "/api/v3/repos/o/r/issues/9/comments")[0]!.body).toEqual({ body: "hi" });
  });
});
