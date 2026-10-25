// End-to-end security checks, continued from security.test.mjs (same seeded accounts, in a
// `wrangler dev` of this file's own, so the two files run side by side): environment reviewers,
// invitations by username, per-account quotas, kill switches and the Markdown image proxy.
//
//   pnpm --filter @diffinery/app e2e
import "./fresh-connections.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { work, base, T, S, OWNER, TIMER_MINUTE_MS, sleep, until, api, runnerClaim, ok, status, b64, collaborator, repoWithReadme, auditLog, oliveSubmits, submitsAs, gitRun } from "./security-harness.mjs";

test("security: environment reviewers hold a deploy job until a listed person approves, and nobody else can", async () => {
  const R = `/repos/${OWNER}/gated-deploy`;
  await repoWithReadme("gated-deploy");
  await collaborator(R, "rita", "read", T.rita);
  await collaborator(R, "sam", "read", T.sam);
  await status(204, "PUT", `${R}/collaborators/olive-bot`, { permission: "write" });
  const ritaId = (await ok("GET", "/user", undefined, T.rita)).id;

  // Only people with access can be reviewers, never an agent or a team; limits are GitHub's; agents can't set them.
  await ok("PUT", `${R}/environments/production`, {});
  await status(422, "PUT", `${R}/environments/production`, { reviewers: [{ type: "User", login: "olive-bot" }] });
  await status(422, "PUT", `${R}/environments/production`, { reviewers: [{ type: "Team", id: 1 }] });
  await status(422, "PUT", `${R}/environments/production`, { reviewers: [{ type: "User", login: "milo" }] });
  await status(422, "PUT", `${R}/environments/production`, { wait_timer: 43_201 });
  await status(403, "PUT", `${R}/environments/production`, { reviewers: [{ type: "User", login: "rita" }] }, T.bot);
  await status(201, "PUT", `${R}/environments/production/secrets/DEPLOY_KEY`, { value: "deploy-value" });
  const env = await ok("PUT", `${R}/environments/production`, { reviewers: [{ type: "User", id: ritaId }, { type: "User", login: "sam" }, { type: "User", login: "olive" }], prevent_self_review: true, deployment_branch_policy: null });
  assert.equal(env.can_admins_bypass, false);
  const rule = env.protection_rules.find((r) => r.type === "required_reviewers");
  assert.deepEqual(rule.reviewers.map((r) => r.reviewer.login).sort(), ["olive", "rita", "sam"]);
  assert.equal(rule.prevent_self_review, true);

  const wf = (n) => `name: deploy\non: push\njobs:\n  ship${n}:\n    runs-on: [self-hosted, linux]\n    environment: production\n    steps:\n      - run: echo ship\n        env:\n          K: \${{ secrets.DEPLOY_KEY }}\n`;
  const claim = async () => {
    const r = await runnerClaim(R, ["linux"]);
    if (r.status !== 200) return null;
    const spec = await (await fetch(`${base}/runner/jobs/${r.json.job_id}`, { headers: { authorization: `Bearer ${r.json.token}` } })).json();
    await fetch(`${base}/runner/jobs/${r.json.job_id}/complete`, { method: "POST", headers: { authorization: `Bearer ${r.json.token}`, "content-type": "application/json" }, body: JSON.stringify({ conclusion: "success", outputs: {} }) });
    return spec;
  };
  const waitingRun = async (sha) => {
    const run = await until("a run waiting for review", async () => (await ok("GET", `${R}/actions/runs`)).workflow_runs.find((r) => r.head_sha === sha && r.status === "waiting"));
    const jobs = (await ok("GET", `${R}/actions/runs/${run.id}/jobs`)).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "waiting");
    // Held before anything starts: no runner can claim it, so no token or secret has left.
    assert.equal(await claim(), null);
    return run;
  };

  // olive pushes: the job waits, and the deployment says so.
  const first = (await ok("PUT", `${R}/contents/.github/workflows/deploy.yml`, { message: "deploy", content: b64(wf(1)) })).commit.sha;
  const run = await waitingRun(first);
  const pendingAs = async (as, id = run.id) => (await ok("GET", `${R}/actions/runs/${id}/pending_deployments`, undefined, as))[0];
  const p = await pendingAs(T.rita);
  assert.equal(p.environment.name, "production");
  assert.equal(p.current_user_can_approve, true);
  assert.equal((await pendingAs(T.olive)).current_user_can_approve, false, "olive started the run and the environment prevents self-review");
  const deployment = (await ok("GET", `${R}/deployments?environment=production`))[0];
  assert.equal((await ok("GET", `${R}/deployments/${deployment.id}/statuses`))[0].state, "waiting");

  // Nobody but a listed person, other than the run's starter, with a token that may write, decides.
  const body = { environment_ids: [p.environment.id], state: "approved", comment: "ship it" };
  assert.match((await api("POST", `${R}/actions/runs/${run.id}/pending_deployments`, body)).json.message, /doesn't let whoever started a run approve it/);
  assert.equal((await api("POST", `${R}/actions/runs/${run.id}/pending_deployments`, body, T.bot)).status, 403);
  assert.equal((await api("POST", `${R}/actions/runs/${run.id}/pending_deployments`, body, T.reader)).status, 403);
  assert.equal((await api("POST", `${R}/actions/runs/${run.id}/pending_deployments`, body, T.milo)).status, 404);
  await status(422, "POST", `${R}/actions/runs/${run.id}/pending_deployments`, { ...body, environment_ids: [999] }, T.rita);
  const approved = await ok("POST", `${R}/actions/runs/${run.id}/pending_deployments`, body, T.rita);
  assert.equal(approved[0].environment, "production");
  // One decision counts: a second one finds nothing waiting.
  await status(422, "POST", `${R}/actions/runs/${run.id}/pending_deployments`, { ...body, state: "rejected" }, T.sam);

  // Now the job starts, and only now gets the environment's secret.
  const spec = await until("the approved job", claim);
  assert.equal(spec.secrets.DEPLOY_KEY, "deploy-value");
  const done = await until("the run done", async () => {
    const r = await ok("GET", `${R}/actions/runs/${run.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(done.conclusion, "success");
  const approvals = await ok("GET", `${R}/actions/runs/${run.id}/approvals`);
  assert.deepEqual(approvals.map((a) => [a.state, a.user.login, a.comment, a.environments[0].name]), [["approved", "rita", "ship it", "production"]]);
  assert.deepEqual((await ok("GET", `${R}/deployments/${deployment.id}/statuses`)).map((s) => s.state), ["success", "in_progress", "waiting"]);

  // A rejection fails the job without starting it. sam decides in the browser, from the run page.
  const file = await ok("GET", `${R}/contents/.github/workflows/deploy.yml`);
  const second = (await ok("PUT", `${R}/contents/.github/workflows/deploy.yml`, { message: "deploy 2", content: b64(wf(2)), sha: file.sha })).commit.sha;
  const run2 = await waitingRun(second);
  const page = await (await fetch(`${base}/${OWNER}/gated-deploy/actions/runs/${run2.id}`, { headers: { cookie: `__Host-dfy_session=${S.olive}` } })).text();
  assert.match(page, /Waiting for review/);
  assert.match(page, /You started this run, and this environment doesn&#39;t let you approve it|You started this run, and this environment doesn't let you approve it/);
  const envId = (await pendingAs(T.rita, run2.id)).environment.id;
  const rejected = await submitsAs(S.sam, `/${OWNER}/gated-deploy/actions/runs/${run2.id}`, `/${OWNER}/gated-deploy/actions/runs/${run2.id}/review`, { environment: String(envId), comment: "not today", state: "rejected" });
  assert.equal(rejected.status, 303);
  assert.match(rejected.flash, /Rejected/);
  const failed = await until("the rejected run done", async () => {
    const r = await ok("GET", `${R}/actions/runs/${run2.id}`);
    return r.status === "completed" ? r : null;
  });
  assert.equal(failed.conclusion, "failure");
  const job = (await ok("GET", `${R}/actions/runs/${run2.id}/jobs`)).jobs[0];
  assert.match(job.failure.message, /rejected by sam: not today/);
  assert.equal(await claim(), null);

  // Self-review compares accounts, not names: sam starts a run, renames, and still can't approve it.
  await collaborator(R, "sam", "write", T.sam);
  const file3 = await ok("GET", `${R}/contents/.github/workflows/deploy.yml`);
  const fourth = (await ok("PUT", `${R}/contents/.github/workflows/deploy.yml`, { message: "deploy 4", content: b64(wf(4)), sha: file3.sha }, T.sam)).commit.sha;
  const run4 = await waitingRun(fourth);
  const env4 = (await pendingAs(T.rita, run4.id)).environment.id;
  const renamed = await submitsAs(S.sam, "/settings", "/settings/profile", { login: "sam-renamed", name: "sam" });
  assert.equal(renamed.status, 303);
  try {
    assert.equal((await ok("GET", "/user", undefined, T.sam)).login, "sam-renamed");
    assert.equal((await pendingAs(T.sam, run4.id)).current_user_can_approve, false);
    const self = await api("POST", `${R}/actions/runs/${run4.id}/pending_deployments`, { environment_ids: [env4], state: "approved" }, T.sam);
    assert.equal(self.status, 403);
    assert.match(self.json.message, /doesn't let whoever started a run approve it/);
  } finally {
    assert.equal((await submitsAs(S.sam, "/settings", "/settings/profile", { login: "sam", name: "sam" })).status, 303);
  }

  // Access counts when deciding, not only when the list was set: on a public repository, where
  // anyone may read, a reviewer removed from it no longer approves.
  await ok("PATCH", R, { visibility: "public" });
  await status(204, "DELETE", `${R}/collaborators/rita`);
  assert.equal((await pendingAs(T.rita, run4.id)).current_user_can_approve, false);
  const removed = await api("POST", `${R}/actions/runs/${run4.id}/pending_deployments`, { environment_ids: [env4], state: "approved" }, T.rita);
  assert.equal(removed.status, 403);
  assert.match(removed.json.message, /only people with access to this repository/);
  await ok("POST", `${R}/actions/runs/${run4.id}/pending_deployments`, { environment_ids: [env4], state: "rejected", comment: "cleanup" });
  await ok("PATCH", R, { visibility: "private" });
  await collaborator(R, "rita", "read", T.rita);

  // A wait timer alone holds the job until it passes; nobody skips it.
  await ok("PUT", `${R}/environments/production`, { reviewers: [], wait_timer: 1 });
  const file2 = await ok("GET", `${R}/contents/.github/workflows/deploy.yml`);
  const third = (await ok("PUT", `${R}/contents/.github/workflows/deploy.yml`, { message: "deploy 3", content: b64(wf(3)), sha: file2.sha })).commit.sha;
  const run3 = await waitingRun(third);
  const timer = await pendingAs(T.rita, run3.id);
  assert.equal(timer.wait_timer, 1);
  assert.equal(timer.current_user_can_approve, false);
  await status(422, "POST", `${R}/actions/runs/${run3.id}/pending_deployments`, { environment_ids: [timer.environment.id], state: "approved" }, T.rita);
  // The Worker runs with a short wait-timer minute (WAIT_TIMER_MINUTE_MS), so the timer passes in seconds.
  if (Date.now() < Date.parse(timer.wait_timer_started_at) + TIMER_MINUTE_MS - 2000) assert.equal(await claim(), null, "nothing starts before the timer passes");
  const timed = await until("the job after its wait timer", claim, 60_000);
  assert.ok(Date.now() >= Date.parse(timer.wait_timer_started_at) + TIMER_MINUTE_MS - 1000, "the job waited for its timer");
  assert.equal(timed.secrets.DEPLOY_KEY, "deploy-value");
});

test("security: adding someone by username sends an invitation, and they get access only once they accept", async () => {
  // ------------------------------------------------------------ a repository: milo is invited, not added
  await repoWithReadme("by-name");
  const R = `/repos/${OWNER}/by-name`;
  const inv = await status(201, "PUT", `${R}/collaborators/milo`, { permission: "write" });
  assert.equal(inv.invitee.login, "milo");
  assert.equal(inv.permissions, "write");
  await status(404, "GET", R, undefined, T.milo);
  // The admin's list names the username, never the person's email address.
  const listed = await ok("GET", `${R}/invitations`);
  assert.deepEqual(listed.map((i) => [i.login, i.email, i.role]), [["milo", null, "write"]]);
  // In-app and in milo's own list.
  assert.ok((await ok("GET", "/notifications", undefined, T.milo)).some((n) => /olive invited you to olive\/by-name/.test(n.title)));
  const mine = await ok("GET", "/user/repository_invitations", undefined, T.milo);
  assert.deepEqual(mine.map((i) => [i.id, i.repository.full_name]), [[inv.id, `${OWNER}/by-name`]]);
  // Nobody else can accept it, and a read token can't either.
  await status(404, "PATCH", `/user/repository_invitations/${inv.id}`, undefined, T.rita);
  assert.deepEqual(await ok("GET", "/user/repository_invitations", undefined, T.rita), []);
  await status(404, "GET", R, undefined, T.rita);
  // Asking again changes the pending invitation's role rather than sending another.
  assert.equal((await status(201, "PUT", `${R}/collaborators/milo`, { permission: "admin" })).id, inv.id);
  // milo accepts and has the role offered.
  await status(204, "PATCH", `/user/repository_invitations/${inv.id}`, undefined, T.milo);
  assert.equal((await ok("GET", R, undefined, T.milo)).permissions.admin, true);
  await status(404, "PATCH", `/user/repository_invitations/${inv.id}`, undefined, T.milo);
  // A collaborator's role then changes at once.
  await status(204, "PUT", `${R}/collaborators/milo`, { permission: "read" });
  assert.equal((await ok("GET", R, undefined, T.milo)).permissions.push, false);
  // The settings form that sets a role invites someone new the same way.
  const viaForm = await oliveSubmits(`/${OWNER}/by-name/settings/access`, `/${OWNER}/by-name/settings/access`, { login: "rita", role: "write" });
  assert.equal(viaForm.status, 303);
  assert.match(viaForm.flash, /Invited rita/);
  await status(404, "GET", R, undefined, T.rita);
  // rita declines: no access, and the invitation is gone.
  const ritas = await ok("GET", "/user/repository_invitations", undefined, T.rita);
  assert.equal(ritas.length, 1);
  await status(204, "DELETE", `/user/repository_invitations/${ritas[0].id}`, undefined, T.rita);
  await status(404, "GET", R, undefined, T.rita);
  assert.deepEqual(await ok("GET", `${R}/invitations`), []);
  // Agents are still added directly: they act for a person who already has access.
  await status(204, "PUT", `${R}/collaborators/olive-bot`, { permission: "write" });

  // ------------------------------------------------------------ an organization: Add people and the role form both invite
  await ok("POST", "/user/orgs", { login: "by-name-org" });
  const members = async () => (await ok("GET", "/orgs/by-name-org/members")).map((u) => u.login);
  const added = await oliveSubmits("/by-name-org?tab=people", "/by-name-org/-/org/people", { who: "milo", role: "member" });
  assert.equal(added.status, 303);
  assert.match(added.flash, /Invited milo to by-name-org/);
  const roleForm = await oliveSubmits("/by-name-org?tab=people", "/by-name-org/-/org/members", { login: "sam", role: "admin" });
  assert.match(roleForm.flash, /Invited sam to by-name-org/);
  assert.deepEqual(await members(), ["olive"]);
  assert.equal((await ok("GET", "/user/memberships/orgs/by-name-org", undefined, T.milo)).state, "pending");
  assert.deepEqual((await ok("GET", "/user/memberships/orgs?state=pending", undefined, T.milo)).map((m) => m.organization.login), ["by-name-org"]);
  // milo accepts through the API, sam declines on the web.
  assert.equal((await ok("PATCH", "/user/memberships/orgs/by-name-org", { state: "active" }, T.milo)).state, "active");
  const samInvite = (await ok("GET", "/orgs/by-name-org/invitations")).find((i) => i.login === "sam");
  const page = await (await fetch(`${base}/settings/invitations`, { headers: { cookie: `__Host-dfy_session=${S.sam}` } })).text();
  assert.match(page, /by-name-org/);
  const declined = await submitsAs(S.sam, "/settings/invitations", `/settings/invitations/${samInvite.id}/decline`, {});
  assert.match(declined.flash, /Invitation declined/);
  assert.deepEqual((await members()).sort(), ["milo", "olive"]);
  await status(404, "GET", "/user/memberships/orgs/by-name-org", undefined, T.sam);

  // ------------------------------------------------------------ someone waiting for an invite accepts it from the waiting page
  await repoWithReadme("for-penny");
  const pennyInvite = await status(201, "PUT", `/repos/${OWNER}/for-penny/collaborators/penny`, { permission: "read" });
  const waiting = await (await fetch(base, { headers: { cookie: `__Host-dfy_session=${S.penny}` } })).text();
  assert.match(waiting, /Waiting for an invite/);
  assert.match(waiting, new RegExp(`${OWNER}/for-penny`));
  const accepted = await submitsAs(S.penny, "/", `/settings/invitations/${pennyInvite.id}/accept`, {});
  assert.equal(accepted.status, 303, accepted.flash);
  assert.equal(accepted.location, `/${OWNER}/for-penny`);
  assert.equal((await fetch(`${base}/${OWNER}/for-penny`, { headers: { cookie: `__Host-dfy_session=${S.penny}` } })).status, 200);

  // ------------------------------------------------------------ a repository with invitations can still be deleted
  await repoWithReadme("invited-then-deleted");
  await status(201, "PUT", `/repos/${OWNER}/invited-then-deleted/collaborators/rita`, { permission: "read" });
  await status(204, "DELETE", `/repos/${OWNER}/invited-then-deleted`);
  assert.deepEqual(await ok("GET", "/user/repository_invitations", undefined, T.rita), []);
});

test("security: per-account quotas on hosted minutes, hosted jobs at once, sandboxes and repositories", async () => {
  // Only site administrators see or change another account's quotas.
  await status(403, "PATCH", "/admin/accounts/rita/quotas", { repositories: 1 });
  await status(403, "GET", "/admin/accounts/rita/quotas", undefined, T.rita);
  await status(422, "PATCH", "/admin/accounts/rita/quotas", { storage: 1 }, T.sully);
  const set = await ok("PATCH", "/admin/accounts/rita/quotas", { repositories: 1, hosted_minutes: 0, sandboxes: 0 }, T.sully);
  assert.deepEqual([set.repositories.limit, set.hosted_minutes.limit, set.sandboxes.limit, set.exempt], [1, 0, 0, false]);
  await until("the audit entry", async () => auditLog("account.quotas.set").some((e) => e.target === "rita" && e.actor_login === "sully"));
  // rita sees her own usage and limits.
  const mine = await ok("GET", "/user/usage", undefined, T.rita);
  assert.deepEqual([mine.account, mine.repositories.limit, mine.hosted_minutes.used], ["rita", 1, 0]);

  // ------------------------------------------------------------ repositories
  const owned = mine.repositories.count;
  await setRitaRepos(owned + 1);
  await ok("POST", "/user/repos", { name: "rita-quota-1" }, T.rita);
  assert.match((await status(403, "POST", "/user/repos", { name: "rita-quota-2" }, T.rita)).message, /rita has reached its limit of \d+ repositories/);

  // ------------------------------------------------------------ hosted minutes: a hosted job isn't started
  const R = "/repos/rita/rita-quota-1";
  await ok("PUT", `${R}/contents/.github/workflows/ci.yml`, { message: "ci", content: b64("name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n") }, T.rita);
  const job = await until("the job to fail", async () => {
    const runs = (await ok("GET", `${R}/actions/runs`, undefined, T.rita)).workflow_runs;
    if (!runs.length) return null;
    const jobs = (await ok("GET", `${R}/actions/runs/${runs[0].id}/jobs`, undefined, T.rita)).jobs;
    return jobs[0]?.status === "completed" ? { run: runs[0].id, job: jobs[0] } : null;
  });
  assert.equal(job.job.conclusion, "failure");
  const page = await (await fetch(`${base}/rita/rita-quota-1/actions/runs/${job.run}`, { headers: { authorization: `Bearer ${T.rita}` } })).text();
  assert.match(page, /used its 0 hosted minutes for this month/);

  // ------------------------------------------------------------ sandboxes: the minutes count for them too, and so does their own limit
  assert.match((await status(429, "POST", `${R}/diffinery/sandboxes`, {}, T.rita)).message, /used its 0 hosted minutes/);
  await ok("PATCH", "/admin/accounts/rita/quotas", { hosted_minutes: null, hosted_jobs: 0 }, T.sully);
  assert.match((await status(429, "POST", `${R}/diffinery/sandboxes`, {}, T.rita)).message, /already has 0 agent sandboxes open/);

  // ------------------------------------------------------------ hosted jobs at once: the job waits, then starts once there's room
  const file = await ok("GET", `${R}/contents/.github/workflows/ci.yml`, undefined, T.rita);
  await ok("PUT", `${R}/contents/.github/workflows/ci.yml`, { message: "again", sha: file.sha, content: b64("name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo again\n") }, T.rita);
  const held = await until("a second run", async () => {
    const runs = (await ok("GET", `${R}/actions/runs`, undefined, T.rita)).workflow_runs;
    if (runs.length < 2) return null;
    const jobs = (await ok("GET", `${R}/actions/runs/${runs[0].id}/jobs`, undefined, T.rita)).jobs;
    return jobs[0] ? { run: runs[0].id, job: jobs[0] } : null;
  });
  await sleep(3000);
  assert.equal((await ok("GET", `${R}/actions/runs/${held.run}/jobs`, undefined, T.rita)).jobs[0].status, "queued");
  // With room again, the alarm starts it within a minute (here it then fails: no containers under wrangler dev).
  await ok("PATCH", "/admin/accounts/rita/quotas", { hosted_jobs: null }, T.sully);
  await until("the held job to leave the queue", async () => (await ok("GET", `${R}/actions/runs/${held.run}/jobs`, undefined, T.rita)).jobs[0].status !== "queued", 120_000);
});

test("security: a per-account storage quota refuses pushes, Git LFS and release asset uploads past it; reads and deletes keep working", async () => {
  const R = "/repos/milo/hoard";
  await ok("POST", "/user/repos", { name: "hoard" }, T.milo);
  const usage = async () => (await ok("GET", "/user/usage", undefined, T.milo)).storage_bytes;
  assert.equal((await usage()).limit, 10 * 1024 ** 3);
  // Push main and a topic branch, and upload a release asset, while there is room.
  const clone = join(work, "hoard");
  const remote = `${base.replace("://", "://x:" + T.milo + "@")}/milo/hoard.git`;
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  const commit = (name) => {
    writeFileSync(join(clone, name), randomBytes(2000).toString("hex"));
    gitRun(["add", name], clone);
    gitRun(["commit", "-q", "-m", name], clone);
  };
  const push = (...args) => spawnSync("git", ["-c", "protocol.version=2", "push", remote, ...args], { cwd: clone, encoding: "utf8" });
  commit("a.txt");
  assert.equal(push("HEAD:main", "HEAD:refs/heads/topic").status, 0);
  // Repositories report what they store as it changes: wait until the count stops moving.
  const settled = async (what, test) => {
    let last = -1;
    return until(what, async () => {
      const u = (await usage()).used;
      if (u === last && test(u)) return u;
      last = u;
      await sleep(1000);
      return null;
    });
  };
  const pushed = await settled("the push to be counted", (u) => u > 2000);
  const rel = await ok("POST", `${R}/releases`, { tag_name: "v1", target_commitish: "main" }, T.milo);
  const upload = (bytes) => fetch(`${base}/api/uploads/repos/milo/hoard/releases/${rel.id}/assets?name=${bytes.length}.bin`, { method: "POST", headers: { authorization: `Bearer ${T.milo}`, "content-type": "application/octet-stream" }, body: bytes });
  const asset = await (await upload(randomBytes(3000))).json();
  assert.equal(asset.size, 3000);
  const used = await settled("the asset to be counted", (u) => u === pushed + 3000);
  assert.equal((await ok("GET", "/admin/accounts/milo/quotas", undefined, T.sully)).storage_bytes.used, used);

  // ------------------------------------------------------------ at the limit: nothing new is stored
  const set = await ok("PATCH", "/admin/accounts/milo/quotas", { storage_bytes: used }, T.sully);
  assert.deepEqual(set.storage_bytes, { used, limit: used });
  const full = new RegExp(`milo has reached its storage limit of ${used} bytes`);
  commit("b.txt");
  const refused = push("HEAD:main");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(`remote: Push refused: ${full.source}`));
  assert.match(refused.stderr, /storage limit reached/);
  const lfsOid = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const lfsBlob = randomBytes(1000);
  const batch = async () => {
    const r = await fetch(`${base}/milo/hoard.git/info/lfs/objects/batch`, { method: "POST", headers: { authorization: `Bearer ${T.milo}`, accept: "application/vnd.git-lfs+json", "content-type": "application/vnd.git-lfs+json" }, body: JSON.stringify({ operation: "upload", objects: [{ oid: lfsOid(lfsBlob), size: lfsBlob.length }] }) });
    assert.equal(r.status, 200);
    return (await r.json()).objects[0];
  };
  const lfs = await batch();
  assert.equal(lfs.error.code, 507);
  assert.match(lfs.error.message, full);
  const put = await fetch(`${base}/milo/hoard.git/info/lfs/objects/${lfsOid(lfsBlob)}`, { method: "PUT", headers: { authorization: `Bearer ${T.milo}`, "content-type": "application/octet-stream" }, body: lfsBlob });
  assert.equal(put.status, 507);
  const late = await upload(randomBytes(10));
  assert.equal(late.status, 403);
  assert.match((await late.json()).message, full);
  assert.match((await status(403, "PUT", `${R}/contents/c.txt`, { message: "c", content: b64("more") }, T.milo)).message, full);
  assert.match((await status(403, "POST", `${R}/git/blobs`, { content: "more" }, T.milo)).message, full);
  // A chunked registry upload declares no length, so its bytes are counted as they arrive.
  const reg = { authorization: `Basic ${Buffer.from(`milo:${T.milo}`).toString("base64")}` };
  const started = await fetch(`${base}/v2/milo/hoard/blobs/uploads/`, { method: "POST", headers: reg });
  assert.equal(started.status, 202, await started.clone().text());
  const chunked = new ReadableStream({
    start(ctl) {
      ctl.enqueue(randomBytes(1000));
      ctl.close();
    },
  });
  const sneak = await fetch(`${base}${started.headers.get("location")}`, { method: "PATCH", headers: { ...reg, "content-type": "application/octet-stream" }, body: chunked, duplex: "half" });
  assert.equal(sneak.status, 403);
  assert.match(await sneak.text(), /milo has reached its storage limit/);
  // An upload refused at the quota can't finish, so it is gone with its bytes: a retry has to start again.
  assert.equal((await fetch(`${base}${started.headers.get("location")}`, { headers: reg })).status, 404);

  // ------------------------------------------------------------ reads, ref deletions and ref moves still work
  assert.equal((await ok("GET", `${R}/contents/a.txt`, undefined, T.milo)).size, 4000);
  assert.equal(push(":refs/heads/topic").status, 0);
  assert.equal(push("HEAD~1:refs/heads/copy").status, 0);
  assert.deepEqual((await ok("GET", `${R}/branches`, undefined, T.milo)).map((b) => b.name).sort(), ["copy", "main"]);

  // ------------------------------------------------------------ deleting brings usage down, and there is room again
  await status(204, "DELETE", `${R}/releases/assets/${asset.id}`, undefined, T.milo);
  await until("the asset's bytes to be given back", async () => (await usage()).used === used - 3000);
  assert.ok((await batch()).actions.upload);
  await ok("PATCH", "/admin/accounts/milo/quotas", { storage_bytes: null }, T.sully);
  assert.equal(push("HEAD:main").status, 0);
});

/** Set rita's repository quota (site administrators only). */
async function setRitaRepos(n) {
  await ok("PATCH", "/admin/accounts/rita/quotas", { repositories: n }, T.sully);
}

test("security: kill switches suspend Actions for a repository or an account, and pause hosted compute on the instance", async () => {
  const R = `/repos/${OWNER}/halted`;
  const S = `/admin/repos/${OWNER}/halted/actions-suspension`;
  const A = `/admin/accounts/${OWNER}/actions-suspension`;
  const P = "/admin/hosted-compute-pause";
  await repoWithReadme("halted");
  const runs = async () => (await ok("GET", `${R}/actions/runs`)).workflow_runs;
  const html = async (path, as = T.olive) => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${as}` } })).text();
  const push = async (path, text) => ok("PUT", `${R}/contents/${path}`, { message: path, content: b64(text) });
  // A self-hosted job that no runner takes yet: the run stays in progress.
  await push(".github/workflows/ci.yml", "name: ci\non:\n  push:\n  workflow_dispatch:\n  repository_dispatch:\njobs:\n  build:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: echo hi\n");
  const first = await until("a run waiting for a runner", async () => {
    const [run] = await runs();
    return run && (await ok("GET", `${R}/actions/runs/${run.id}/jobs`)).jobs.length ? run : null;
  });

  try {
    // ------------------------------------------------------------ only site administrators
    for (const path of [S, A, P]) {
      for (const method of ["GET", "PUT", "DELETE"]) assert.match((await status(403, method, path, method === "PUT" ? { reason: "mine" } : undefined, T.olive)).message, /only site administrators/);
      await status(401, "PUT", path, { reason: "no token" }, null);
    }
    await status(422, "PUT", S, {}, T.sully);
    await status(404, "PUT", `/admin/repos/${OWNER}/nowhere/actions-suspension`, { reason: "x" }, T.sully);
    await status(404, "PUT", "/admin/accounts/olive-bot/actions-suspension", { reason: "x" }, T.sully);
    assert.equal((await ok("GET", S, undefined, T.sully)).suspended, false);

    // ------------------------------------------------------------ a repository: what runs stops, nothing new starts
    const s = await ok("PUT", S, { reason: "crypto mining" }, T.sully);
    assert.deepEqual([s.suspended, s.reason, s.suspended_by, s.stopped.runs, s.stopped.jobs], [true, "crypto mining", "sully", 1, 1]);
    const cancelled = await until("the run to be cancelled", async () => {
      const r = await ok("GET", `${R}/actions/runs/${first.id}`);
      return r.status === "completed" ? r : null;
    });
    assert.equal(cancelled.conclusion, "cancelled");
    assert.match(await html(`/${OWNER}/halted/actions/runs/${first.id}`), /Cancelled: Actions are suspended for this repository by a site administrator: crypto mining/);
    assert.equal((await runnerClaim(R, ["linux"])).status, 204);
    assert.match((await status(403, "POST", `${R}/actions/workflows/ci.yml/dispatches`, { ref: "main" })).message, /Actions are suspended for this repository by a site administrator: crypto mining/);
    assert.match((await status(403, "POST", `${R}/dispatches`, { event_type: "go" })).message, /suspended for this repository/);
    assert.match((await status(403, "POST", `${R}/actions/runs/${first.id}/rerun`)).message, /suspended for this repository/);
    assert.match((await status(403, "POST", `${R}/diffinery/sandboxes`, {})).message, /suspended for this repository/);
    const before = (await runs()).length;
    await push("one.txt", "one\n");
    await sleep(3000);
    assert.equal((await runs()).length, before, "a push starts no run while Actions are suspended");
    for (const path of [`/${OWNER}/halted/actions`, `/${OWNER}/halted/settings`]) assert.match(await html(path), /Actions are suspended for this repository by a site administrator/, path);
    assert.match(await html("/settings/admin/kill-switches", T.sully), new RegExp(`${OWNER}/halted`));
    await until("the suspension's audit entry", async () => auditLog("actions.suspend").some((e) => e.target === `${OWNER}/halted` && e.actor_login === "sully" && JSON.parse(e.detail).reason === "crypto mining"));

    // Lifting it lets new work start; nothing restarts.
    assert.equal((await ok("DELETE", S, undefined, T.sully)).suspended, false);
    assert.equal((await ok("GET", `${R}/actions/runs/${first.id}`)).conclusion, "cancelled");
    await push("two.txt", "two\n");
    await until("a new run", async () => (await runs()).length > before);
    await ok("POST", `${R}/actions/workflows/ci.yml/dispatches`, { ref: "main" });
    const sandbox = await api("POST", `${R}/diffinery/sandboxes`, {});
    assert.notEqual(sandbox.status, 403, JSON.stringify(sandbox.json)); // 503 here: no sandbox pool under this test
    await until("the lift's audit entry", async () => auditLog("actions.unsuspend").some((e) => e.target === `${OWNER}/halted` && e.actor_login === "sully"));

    // ------------------------------------------------------------ an account: every repository it owns
    const a = await ok("PUT", A, { reason: "abuse report" }, T.sully);
    assert.deepEqual([a.account, a.suspended, a.reason], [OWNER, true, "abuse report"]);
    assert.ok(a.stopped.runs >= 1, JSON.stringify(a.stopped));
    assert.equal((await ok("GET", S, undefined, T.sully)).owner_suspended, true);
    assert.match((await status(403, "POST", `${R}/actions/workflows/ci.yml/dispatches`, { ref: "main" })).message, /Actions are suspended for every repository of olive by a site administrator: abuse report/);
    assert.match((await status(403, "POST", `${R}/diffinery/sandboxes`, {})).message, /every repository of olive/);
    const during = (await runs()).length;
    await push("three.txt", "three\n");
    await sleep(3000);
    assert.equal((await runs()).length, during);
    assert.match(await html(`/${OWNER}/halted/actions`), /Actions are suspended for every repository of olive by a site administrator/);
    assert.equal((await ok("DELETE", A, undefined, T.sully)).suspended, false);
    await until("the account's audit entries", async () => auditLog("actions.suspend").some((e) => e.target === OWNER && JSON.parse(e.detail).kind === "account") && auditLog("actions.unsuspend").some((e) => e.target === OWNER));

    // ------------------------------------------------------------ the instance: hosted compute stops, self-hosted runners go on
    const p = await ok("PUT", P, { reason: "cost overrun" }, T.sully);
    assert.deepEqual([p.paused, p.reason, p.paused_by], [true, "cost overrun", "sully"]);
    assert.equal((await ok("GET", P, undefined, T.sully)).paused, true);
    assert.match((await status(403, "POST", `${R}/diffinery/sandboxes`, {})).message, /Agent sandboxes are paused on this instance by a site administrator: cost overrun/);
    assert.match(await html("/settings/admin", T.sully), /Hosted compute is paused on this instance/);
    assert.match(await html(`/${OWNER}/halted/actions`), /Hosted runners are paused on this instance by a site administrator/);
    await push(".github/workflows/hosted.yml", "name: hosted\non: push\njobs:\n  cloud:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
    const hosted = await until("the hosted job to fail", async () => {
      const run = (await runs()).find((r) => r.name === "hosted");
      if (!run) return null;
      const [job] = (await ok("GET", `${R}/actions/runs/${run.id}/jobs`)).jobs;
      return job?.status === "completed" ? { run: run.id, job } : null;
    });
    assert.equal(hosted.job.conclusion, "failure");
    assert.match(await html(`/${OWNER}/halted/actions/runs/${hosted.run}`), /The job was not started: Hosted runners are paused on this instance by a site administrator: cost overrun/);
    // The self-hosted job of the same push is still handed to a runner.
    const claim = await until("a self-hosted job claimed", async () => {
      const r = await runnerClaim(R, ["linux"]);
      return r.status === 200 ? r.json : null;
    });
    await fetch(`${base}/runner/jobs/${claim.job_id}/complete`, { method: "POST", headers: { authorization: `Bearer ${claim.token}`, "content-type": "application/json" }, body: JSON.stringify({ conclusion: "success", outputs: {} }) });
    assert.equal((await ok("DELETE", P, undefined, T.sully)).paused, false);
    assert.doesNotMatch(await html("/settings/admin", T.sully), /Hosted compute is paused/);
    assert.notEqual((await api("POST", `${R}/diffinery/sandboxes`, {})).status, 403);
    await until("the pause's audit entries", async () => auditLog("compute.pause").some((e) => e.actor_login === "sully" && JSON.parse(e.detail).reason === "cost overrun") && auditLog("compute.unpause").length > 0);
  } finally {
    for (const path of [S, A, P]) await api("DELETE", path, undefined, T.sully);
  }
});

test("security: Markdown images from other sites load through Diffinery's signed image proxy", async () => {
  // A stand-in for another site, which records what it is sent.
  const seen = [];
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
  const site = createHttpServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === "/pixel.png") return res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" }).end(PNG);
    if (req.url === "/moved.png") return res.writeHead(302, { location: "/pixel.png" }).end();
    if (req.url === "/page.html") return res.writeHead(200, { "content-type": "text/html" }).end("<script>alert(1)</script>");
    if (req.url === "/drawing.svg") return res.writeHead(200, { "content-type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    res.writeHead(404).end();
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const other = `http://127.0.0.1:${site.address().port}`;
  try {
    await repoWithReadme("pictures");
    const body = [`![pixel](${other}/pixel.png)`, `[![moved](${other}/moved.png)](${other}/page.html)`, `![page](${other}/page.html)`, `![drawing](${other}/drawing.svg)`, "![own](/static/none.png)"].join("\n\n");
    const issue = await ok("POST", `/repos/${OWNER}/pictures/issues`, { title: "pictures", body });
    const page = await fetch(`${base}/${OWNER}/pictures/issues/${issue.number}`, { headers: { cookie: `__Host-dfy_session=${S.olive}` } });
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /img-src 'self' data: blob:(;|$)/);
    assert.doesNotMatch(csp, /img-src[^;]*https:/);
    const html = await page.text();
    const srcs = [...html.matchAll(/<img src="([^"]*)" alt="(pixel|moved|page|drawing|own)"/g)].map((m) => [m[2], m[1].replaceAll("&amp;", "&")]);
    const src = Object.fromEntries(srcs);
    assert.deepEqual(Object.keys(src).sort(), ["drawing", "moved", "own", "page", "pixel"]);
    for (const name of ["pixel", "moved", "page", "drawing"]) assert.match(src[name], /^\/-\/camo\/[\w-]{43}\/[\w-]+$/, name);
    assert.equal(src.own, `/${OWNER}/pictures/raw/main/static/none.png`);
    assert.ok(!html.includes(`src="${other}`), "no image loads from the other site directly");
    // Links keep their original target.
    assert.ok(html.includes(`href="${other}/page.html"`));
    assert.equal(seen.length, 0, "rendering fetches nothing");

    // The proxy fetches the image without the viewer's cookies, and answers from its cache next time.
    const get = (path, init = {}) => fetch(`${base}${path}`, init);
    const first = await get(src.pixel, { headers: { cookie: `__Host-dfy_session=${S.olive}`, "user-agent": "viewer-browser/1" } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/png");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    assert.match(first.headers.get("cache-control") ?? "", /^public, max-age=3600$/);
    assert.equal(first.headers.get("set-cookie"), null);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), PNG);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.cookie, undefined);
    assert.match(seen[0].headers["user-agent"] ?? "", /^Diffinery-Camo/);
    assert.equal((await get(src.pixel)).status, 200);
    assert.equal(seen.filter((r) => r.url === "/pixel.png").length, 1, "the second view is served from the cache");

    // Redirects are followed; HTML is refused; SVG can't run scripts.
    assert.equal((await get(src.moved)).status, 200);
    assert.equal((await get(src.page)).status, 404);
    const svg = await get(src.drawing);
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.equal(svg.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");

    // Only URLs Diffinery signed: a tampered signature or URL, or one Diffinery never signed, is a 404 that fetches nothing.
    const before = seen.length;
    const [, , , sig, enc] = src.pixel.split("/");
    const evil = Buffer.from(`${other}/page.html?x`).toString("base64url");
    for (const path of [`/-/camo/${sig}/${evil}`, `/-/camo/${sig.slice(0, -2)}AA/${enc}`, `/-/camo/x/${enc}`, `/-/camo/${sig}`, `/-/camo/${"A".repeat(43)}/${Buffer.from(base).toString("base64url")}`]) {
      assert.equal((await get(path)).status, 404, path);
    }
    assert.equal(seen.length, before);
  } finally {
    site.close();
  }
});
