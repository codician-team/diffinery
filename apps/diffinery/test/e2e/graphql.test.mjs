// End-to-end GraphQL API (/api/graphql), on a real `wrangler dev` Worker with the real git CLI:
// the queries Claude Code sends to show a session's pull request and its CI (the badge and the
// check counts), the ones the GitHub CLI sends for `gh pr view` and `gh pr checks`, and the pull
// request mutations behind `gh pr create`, `gh pr ready`, `gh pr edit`, `gh pr comment`,
// `gh pr close`, `gh pr reopen` and `gh pr merge`. Also covers sign-in, token scopes, limits and
// GitHub's error shape.
//
//   pnpm --filter @diffinery/app exec node --test test/e2e/graphql.test.mjs
import "./fresh-connections.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { migratedState } from "./d1-state.mjs";
import { freePort } from "./ports.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "diffinery-graphql-e2e-"));
let dev;
let base;
let log = "";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const T = { ann: `dfy_ann_${randomBytes(12).toString("hex")}`, annRead: `dfy_anr_${randomBytes(12).toString("hex")}`, bob: `dfy_bob_${randomBytes(12).toString("hex")}` };

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const persist = join(work, "state");
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: APP, stdio: "pipe", env: { ...process.env, CI: "1" } });
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 30 * 86400_000).toISOString();
  const person = (id, login) => `INSERT INTO accounts (id, login, kind, name, email, status, site_admin, created_at) VALUES ('${id}', '${login}', 'user', '${login}', '${login}@example.com', 'active', 0, '${at}')`;
  const token = (id, account, t, scope) => `INSERT INTO tokens (id, account_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES ('${id}', '${account}', 'e2e', '${hash(t)}', '${t.slice(0, 10)}', '["${scope}"]', '${later}', '${at}')`;
  migratedState(APP, persist);
  wrangler("d1", "execute", "diffinery-dev", "--local", "-e", "dev", "--persist-to", persist, "--command", [person("u-ann", "ann"), person("u-bob", "bob"), token("t-ann", "u-ann", T.ann, "admin"), token("t-anr", "u-ann", T.annRead, "read"), token("t-bob", "u-bob", T.bob, "admin")].join("; "));
  // No fixed dev identity (DEV_AUTH empty), so a request without a token is anonymous.
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "-e", "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", persist, "--var", `PUBLIC_URL:${base}`, "--var", "DEV_AUTH:", "--show-interactive-dev-session=false"], {
    cwd: APP,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  const end = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (Date.now() > end) assert.fail(`wrangler dev did not start\n${log.slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});

after(() => {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {}
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

async function rest(method, path, body, tok = T.ann) {
  const res = await fetch(`${base}/api/v3${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** POST /api/graphql; returns { status, body }. */
async function gql(query, variables = {}, tok = T.ann) {
  const res = await fetch(`${base}/api/graphql`, { method: "POST", headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  return { status: res.status, body: await res.json() };
}

/** The data of a query that must succeed without errors. */
async function data(query, variables, tok) {
  const r = await gql(query, variables, tok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.errors, undefined, JSON.stringify(r.body.errors));
  return r.body.data;
}

function git(cwd, args) {
  const auth = Buffer.from(`x-token:${T.ann}`).toString("base64");
  return execFileSync("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "-c", "user.name=ann", "-c", "user.email=ann@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Claude Code's query for the pull requests of its sessions (one alias per repository and pull request).
const CLAUDE_BATCH = `fragment pr on PullRequest {
  number title state isDraft additions deletions
  reviewDecision
  commits(last:1){nodes{commit{statusCheckRollup{
    state
    contexts(first:0){
      checkRunCountsByState{state count}
      statusContextCountsByState{state count}
    }
  }}}}
}
query {
  rateLimit { cost remaining resetAt }
  r0: repository(owner: "ann", name: "app") { p0_0: pullRequest(number: 1) { ...pr } }
}`;

let headSha;
let repoId;
let prId;

test("setup: a private repository with a pull request, two check runs and a commit status", async () => {
  await rest("POST", "/user/repos", { name: "app", private: true });
  const src = join(work, "app");
  mkdirSync(src);
  writeFileSync(join(src, "README.md"), "# app\n");
  git(src, ["init", "-q", "-b", "main"]);
  git(src, ["add", "-A"]);
  git(src, ["commit", "-q", "-m", "init"]);
  git(src, ["push", "-q", `${base}/ann/app.git`, "main"]);
  git(src, ["checkout", "-q", "-b", "feature/chip"]);
  writeFileSync(join(src, "README.md"), "# app\n\nA second line.\nAnd a third.\n");
  git(src, ["commit", "-q", "-am", "more readme"]);
  git(src, ["push", "-q", `${base}/ann/app.git`, "feature/chip"]);
  headSha = git(src, ["rev-parse", "HEAD"]).trim();

  // gh pr create: the repository's id, then createPullRequest.
  const d = await data(`query RepositoryInfo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name owner { login } viewerPermission defaultBranchRef { name } squashMergeAllowed } }`, { owner: "ann", name: "app" });
  assert.equal(d.repository.viewerPermission, "ADMIN");
  assert.equal(d.repository.defaultBranchRef.name, "main");
  repoId = d.repository.id;
  const created = await data(`mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url number isDraft } } }`, {
    input: { repositoryId: repoId, baseRefName: "main", headRefName: "feature/chip", title: "Longer readme", body: "Two lines.", draft: true, maintainerCanModify: true },
  });
  assert.equal(created.createPullRequest.pullRequest.url, `${base}/ann/app/pull/1`);
  assert.equal(created.createPullRequest.pullRequest.isDraft, true);
  prId = created.createPullRequest.pullRequest.id;

  await rest("POST", "/repos/ann/app/check-runs", { name: "lint", head_sha: headSha, status: "completed", conclusion: "success" });
  await rest("POST", "/repos/ann/app/check-runs", { name: "tests", head_sha: headSha, status: "in_progress" });
  await rest("POST", `/repos/ann/app/statuses/${headSha}`, { state: "success", context: "deploy/preview" });
});

test("Claude Code: the current branch's pull request and its review decision", async () => {
  // Over REST, as Claude Code looks it up for the branch it's on.
  const list = await rest("GET", "/repos/ann/app/pulls?head=ann:feature/chip&state=open&per_page=1");
  assert.equal(list.length, 1);
  assert.equal(list[0].number, 1);
  assert.equal(list[0].html_url, `${base}/ann/app/pull/1`);
  const d = await data(`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewDecision}}}`, { o: "ann", r: "app", n: 1 });
  assert.equal(d.repository.pullRequest.reviewDecision, null);
});

test("Claude Code: CI counts and pull request state for the badge", async () => {
  const d = await data(CLAUDE_BATCH);
  assert.ok(d.rateLimit.remaining > 0);
  const p = d.r0.p0_0;
  assert.deepEqual({ number: p.number, title: p.title, state: p.state, isDraft: p.isDraft, additions: p.additions, deletions: p.deletions }, { number: 1, title: "Longer readme", state: "OPEN", isDraft: true, additions: 3, deletions: 0 });
  const rollup = p.commits.nodes[0].commit.statusCheckRollup;
  assert.equal(rollup.state, "PENDING");
  const counts = (list) => Object.fromEntries(list.map((x) => [x.state, x.count]));
  assert.deepEqual(counts(rollup.contexts.checkRunCountsByState), { IN_PROGRESS: 1, SUCCESS: 1 });
  assert.deepEqual(counts(rollup.contexts.statusContextCountsByState), { SUCCESS: 1 });
});

test("gh pr checks and gh pr view: the rollup, node lookup and fields Diffinery doesn't have", async () => {
  const d = await data(
    `query PullRequestStatusChecks($id: ID!) { node(id: $id) { ...on PullRequest { statusCheckRollup: commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes { __typename ...on StatusContext { context state targetUrl } ...on CheckRun { name status conclusion workflowName: checkSuite { workflowRun { workflow { name } } } } } pageInfo { hasNextPage endCursor } } } } } } } } }`,
    { id: prId },
  );
  const nodes = d.node.statusCheckRollup.nodes[0].commit.statusCheckRollup.contexts.nodes;
  assert.equal(d.node.statusCheckRollup.nodes[0].commit.oid, headSha);
  assert.deepEqual(nodes.map((n) => n.name ?? n.context).sort(), ["deploy/preview", "lint", "tests"]);
  assert.equal(nodes.find((n) => n.name === "tests").status, "IN_PROGRESS");
  assert.equal(nodes.find((n) => n.name === "lint").conclusion, "SUCCESS");

  // A field GitHub has and Diffinery doesn't is left out and named, so gh carries on.
  const r = await gql(`query { repository(owner: "ann", name: "app") { pullRequest(number: 1) { number mergeStateStatus mergeable notAThing } } }`);
  assert.equal(r.body.errors, undefined, JSON.stringify(r.body));
  assert.equal(r.body.data.repository.pullRequest.number, 1);
  assert.equal(r.body.data.repository.pullRequest.mergeStateStatus, "DRAFT");
  assert.equal(r.body.data.repository.pullRequest.mergeable, "MERGEABLE");
  assert.ok(r.body.extensions.unsupported.some((m) => m.includes("notAThing")));

  // gh pr status: pull requests by the viewer, through search.
  const s = await data(`query { search(query: "repo:ann/app is:pr is:open author:@me", type: ISSUE, first: 10) { issueCount nodes { ...on PullRequest { number } } } }`);
  assert.equal(s.search.issueCount, 1);
});

test("gh pr ready, edit, comment, close, reopen and merge", async () => {
  const pr = async () => (await data(`query { repository(owner: "ann", name: "app") { pullRequest(number: 1) { title body state isDraft merged labels(first: 10) { nodes { name } } comments(first: 10) { nodes { body } } } } }`)).repository.pullRequest;
  await data(`mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`, { id: prId });
  assert.equal((await pr()).isDraft, false);

  await rest("POST", "/repos/ann/app/labels", { name: "docs", color: "0075ca" });
  const label = (await data(`query { repository(owner: "ann", name: "app") { labels(first: 10) { nodes { id name } } } }`)).repository.labels.nodes.find((l) => l.name === "docs");
  await data(`mutation($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { pullRequest { title } } }`, { input: { pullRequestId: prId, title: "A longer readme", body: "Three lines." } });
  await data(`mutation($input: AddLabelsToLabelableInput!) { addLabelsToLabelable(input: $input) { clientMutationId } }`, { input: { labelableId: prId, labelIds: [label.id] } });
  await data(`mutation($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { url } } } }`, { input: { subjectId: prId, body: "Looks right." } });
  let p = await pr();
  assert.equal(p.title, "A longer readme");
  assert.equal(p.body, "Three lines.");
  assert.deepEqual(p.labels.nodes.map((l) => l.name), ["docs"]);
  assert.deepEqual(p.comments.nodes.map((c) => c.body), ["Looks right."]);

  await data(`mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { pullRequest { state } } }`, { id: prId });
  assert.equal((await pr()).state, "CLOSED");
  await data(`mutation($id: ID!) { reopenPullRequest(input: { pullRequestId: $id }) { pullRequest { state } } }`, { id: prId });
  assert.equal((await pr()).state, "OPEN");

  // A read token can look but not change anything.
  const refused = await gql(`mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { pullRequest { state } } }`, { id: prId }, T.annRead);
  assert.equal(refused.body.errors?.[0]?.type, "FORBIDDEN", JSON.stringify(refused.body));
  assert.equal((await pr()).state, "OPEN");

  await data(`mutation($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }`, { input: { pullRequestId: prId, mergeMethod: "SQUASH" } });
  p = await pr();
  assert.equal(p.state, "MERGED");
  assert.equal(p.merged, true);
});

test("sign-in, privacy, limits and GitHub's error shape", async () => {
  const anonymous = await gql(`query { viewer { login } }`, {}, null);
  assert.equal(anonymous.status, 401);
  assert.equal((await data(`query UserCurrent { viewer { login } }`)).viewer.login, "ann");

  // Someone without access gets GitHub's NOT_FOUND, the same as for a repository that doesn't exist.
  for (const [owner, name, tok] of [["ann", "app", T.bob], ["ann", "nope", T.ann]]) {
    const r = await gql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }`, { o: owner, n: name }, tok);
    assert.equal(r.body.data.repository, null);
    assert.equal(r.body.errors[0].type, "NOT_FOUND");
  }

  let deep = "id";
  for (let i = 0; i < 20; i++) deep = `parent { ${deep} }`;
  const tooDeep = await gql(`query { repository(owner: "ann", name: "app") { ${deep} } }`);
  assert.match(tooDeep.body.errors[0].message, /nested/);

  const sub = await gql(`subscription { viewer { login } }`);
  assert.match(sub.body.errors[0].message, /Subscriptions/);

  // gh auth login checks the REST root of a GitHub Enterprise host.
  const root = await fetch(`${base}/api/v3/`, { headers: { authorization: `Bearer ${T.ann}` } });
  assert.equal(root.status, 200);
  assert.equal((await root.json()).graphql, `${base}/api/graphql`);
});
