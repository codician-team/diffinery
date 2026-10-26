import type { MailJob, Recipient, ThreadData } from "./types.js";

/**
 * One example of every email Diffinery sends, for the template gallery in site
 * administration, the "send me every email" check and the template tests.
 */
export function sampleJobs(pub: string, to: Recipient, me: string, repo = "acme/website"): Array<{ id: string; label: string; job: MailJob }> {
  const at = new Date().toISOString();
  const repoId = "sample";
  const thread = (over: Partial<ThreadData>): ThreadData => ({
    repo,
    repoId,
    number: 42,
    kind: "pull",
    title: "Cache build artifacts between workflow runs",
    event: "opened",
    actor: "diffy-dev",
    url: `${pub}/${repo}/pull/42`,
    base: "main",
    head: "cache-artifacts",
    ...over,
  });
  const body = "This keeps `node_modules` and the build output in the Actions cache, keyed on the lockfile.\n\n- Cold build: **3m 40s**\n- Warm build: **48s**\n\nCloses #37. cc @" + me;
  const item = (id: string, label: string, j: Omit<MailJob, "to" | "at">) => ({ id, label, job: { ...j, to, at } as MailJob });
  const exp = new Date(Date.now() + 6 * 86400_000).toISOString();
  return [
    item("pr-opened", "Pull request opened", { kind: "thread", reason: "review_requested", data: thread({ body, intent: "Make CI twice as fast without changing what it tests.", reviewers: [me], commits: [{ sha: "3f9c2a1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a", message: "Cache node_modules on the lockfile hash" }, { sha: "8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b", message: "Cache the build output too" }] }) }),
    item("issue-opened", "Issue opened (watching)", { kind: "thread", reason: "subscribed", data: thread({ kind: "issue", number: 37, title: "CI takes almost four minutes on every push", url: `${pub}/${repo}/issues/37`, body: "Every push reinstalls all dependencies. Could we cache them?", base: undefined, head: undefined }) }),
    item("comment", "New comment (mention)", { kind: "thread", reason: "mention", data: thread({ event: "comment", actor: "rivera", body: `Looks good to me. @${me}, can you double-check the cache key on Windows runners?`, url: `${pub}/${repo}/pull/42#c-sample` }) }),
    item("review-approved", "Review: approved", { kind: "thread", reason: "author", data: thread({ event: "review", state: "APPROVED", actor: "rivera", body: "Nice speed-up. Ship it." }) }),
    item("review-changes", "Review: changes requested", { kind: "thread", reason: "author", data: thread({ event: "review", state: "CHANGES_REQUESTED", actor: "kim", body: "**.github/workflows/ci.yml:18**\n\nThe key should include the runner OS, or Linux and macOS caches will collide." }) }),
    item("review-requested", "Review requested", { kind: "thread", reason: "review_requested", data: thread({ event: "review_requested", reviewers: [me], intent: "Make CI twice as fast without changing what it tests." }) }),
    item("assigned", "Assigned", { kind: "thread", reason: "assign", data: thread({ kind: "issue", number: 37, title: "CI takes almost four minutes on every push", event: "assigned", assignees: [me], url: `${pub}/${repo}/issues/37` }) }),
    item("pushed", "New commits pushed", { kind: "thread", reason: "comment", data: thread({ event: "pushed", commits: [{ sha: "c0ffee1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a", message: "Include the runner OS in the cache key" }] }) }),
    item("merged", "Pull request merged", { kind: "thread", reason: "author", data: thread({ event: "merged", actor: "kim" }) }),
    item("closed", "Issue closed", { kind: "thread", reason: "author", data: thread({ kind: "issue", number: 37, title: "CI takes almost four minutes on every push", event: "closed", stateReason: "completed", url: `${pub}/${repo}/issues/37` }) }),
    item("reopened", "Issue reopened", { kind: "thread", reason: "comment", data: thread({ kind: "issue", number: 37, title: "CI takes almost four minutes on every push", event: "reopened", url: `${pub}/${repo}/issues/37` }) }),
    item("run-failed", "Workflow run failed", {
      kind: "run",
      reason: "ci_activity",
      data: {
        repo,
        repoId,
        runId: "sample",
        runNumber: 318,
        workflow: "CI",
        title: "Cache node_modules on the lockfile hash",
        conclusion: "failure",
        event: "push",
        branch: "main",
        sha: "3f9c2a1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a",
        actor: me,
        url: `${pub}/${repo}/actions/runs/sample`,
        jobs: [
          { name: "Typecheck and test", conclusion: "failure", url: `${pub}/${repo}/actions/runs/sample/job/1`, failure: "Process completed with exit code 1 (step: Unit tests)" },
          { name: "Lint", conclusion: "success", url: `${pub}/${repo}/actions/runs/sample/job/2` },
          { name: "Deploy", conclusion: "skipped", url: `${pub}/${repo}/actions/runs/sample/job/3` },
        ],
      },
    }),
    item("signin", "New sign-in", { kind: "signin_new", reason: "security_alert", data: { method: "passkey", device: "Safari on macOS", ip: "203.0.113.24", location: "Istanbul, TR", passkey: "MacBook Touch ID" } }),
    item("passkey-added", "Passkey added", { kind: "passkey_added", reason: "security_alert", data: { name: "iPhone", via: "settings" } }),
    item("passkey-removed", "Passkey removed", { kind: "passkey_removed", reason: "security_alert", data: { name: "Old YubiKey" } }),
    item("token-created", "Access token created", { kind: "token_created", reason: "security_alert", data: { name: "laptop", scopes: ["write"] } }),
    item("token-expiring", "Access token expiring", { kind: "token_expiring", reason: "security_alert", data: { name: "ci-deploy", prefix: "dfy_Ab12Cd", expiresAt: exp } }),
    item("agent-created", "Agent added", { kind: "agent_created", reason: "security_alert", data: { agent: "review-bot" } }),
    item("model-key-added", "Model key added", { kind: "model_key_added", reason: "security_alert", data: { provider: "Anthropic", hint: "x7Qa" } }),
    item("org-model-key-added", "Organization model key added", { kind: "model_key_added", reason: "security_alert", data: { provider: "OpenAI", hint: "9fKe", org: "acme", by: me } }),
    item("deployment-review", "Deployment waiting for review", { kind: "deployment_review_requested", reason: "review_requested", data: { repo, environment: "production", workflow: "Deploy", runNumber: 128, title: "Release 2.4", branch: "main", sha: "4f1c2e9d0b7a6c5e3f2d1c0b9a8e7d6c5b4a3f2e", requestor: me, url: `${pub}/${repo}/actions/runs/sample` } }),
    item("review-limit", "Agent review limit reached", { kind: "review_limit_reached", reason: "your_activity", data: { repo, limit: 50, pr: 42 } }),
    item("push-bypassed", "Push protection bypassed", { kind: "push_bypassed", reason: "security_alert", data: { repo, pusher: me, kinds: ["AWS access key"], reason: "Fake key used by a test fixture", refs: ["refs/heads/main"] } }),
    item("push-blocked", "Push blocked", { kind: "push_blocked", reason: "security_alert", data: { repo, kinds: ["GitHub token"], refs: ["refs/heads/feature"] } }),
    item("commit-blocked", "Commit blocked", { kind: "push_blocked", reason: "security_alert", data: { repo, kinds: ["AWS access key"], paths: ["config.env"] } }),
    item("account-disabled", "Account disabled", { kind: "account_status", reason: "account", data: { status: "disabled" } }),
    item("account-enabled", "Account enabled", { kind: "account_status", reason: "account", data: { status: "active" } }),
    item("account-deleted", "Account deleted", { kind: "account_deleted", reason: "account", data: { login: me, cooldownDays: 90 } }),
    item("site-admin-granted", "Made a site administrator", { kind: "site_admin", reason: "security_alert", data: { granted: true, by: "admin" } }),
    item("site-admin-revoked", "No longer a site administrator", { kind: "site_admin", reason: "security_alert", data: { granted: false, by: "admin" } }),
    item("export-ready", "Account export ready", { kind: "export_ready", reason: "account", data: { url: `${pub}/settings/account`, size: 48_300_000, expiresAt: exp } }),
    item("account-suspended", "Account suspended", { kind: "account_status", reason: "account", data: { status: "suspended", reason: "Spam in issues across several repositories" } }),
    item("account-unsuspended", "Account unsuspended", { kind: "account_status", reason: "account", data: { status: "unsuspended" } }),
    item("invite-org", "Invitation (organization)", { kind: "invite", reason: "invitation", data: { inviter: me, url: `${pub}/invite/sample`, org: repo.split("/")[0], role: "member", expiresAt: exp } }),
    item("invite-repo", "Invitation (repository)", { kind: "invite", reason: "invitation", data: { inviter: me, url: `${pub}/invite/sample`, repo, role: "write", expiresAt: exp } }),
    item("invite-account", "Invitation (by username)", { kind: "invite", reason: "invitation", data: { inviter: me, url: `${pub}/settings/invitations`, repo, role: "write", expiresAt: exp, existing: true } }),
    item("invite-accepted", "Invitation accepted", { kind: "invite_accepted", reason: "account", data: { login: "rivera", email: "rivera@example.com", org: repo.split("/")[0] } }),
    item("welcome", "Welcome", { kind: "welcome", reason: "account", data: { login: me } }),
    item("signin-link", "Sign-in link", { kind: "signin_link", reason: "account", data: { url: `${pub}/signin#sample`, admin: "admin", expiresAt: new Date(Date.now() + 86400_000).toISOString() } }),
    item("signup-code", "Sign-up code", { kind: "signup_code", reason: "signup", data: { code: "042917", expiresAt: new Date(Date.now() + 600_000).toISOString() } }),
    item("email-verify", "Confirm an address after a bounce", { kind: "email_verify", reason: "account", data: { email: "diffy@example.com", url: `${pub}/settings/email/verify/sample`, expiresAt: new Date(Date.now() + 86400_000).toISOString() } }),
    item("signup-attempt", "Sign-up with an existing address", { kind: "signup_attempt", reason: "account", data: { email: "diffy@example.com" } }),
    item("access-request", "Access request", { kind: "access_request", reason: "admin", data: { email: "newcomer@example.com", login: "newcomer", note: "I'm joining the platform team next week." } }),
    item("early-access-confirm", "Early access: confirm the request", { kind: "early_access_confirm", reason: "early_access", data: { url: `${pub}/early-access/confirm#sample`, expiresAt: exp } }),
    item("early-access-remove", "Early access: remove the request", { kind: "early_access_remove", reason: "early_access", data: { url: `${pub}/early-access/remove/confirm#sample`, expiresAt: exp } }),
    item("early-access-waiting", "Early access: already on the list", { kind: "early_access_known", reason: "early_access", data: { variant: "waiting", since: at } }),
    item("early-access-invited", "Early access: already invited", { kind: "early_access_known", reason: "early_access", data: { variant: "invited", since: at } }),
    item("early-access-account", "Early access: already has an account", { kind: "early_access_known", reason: "early_access", data: { variant: "account", since: at } }),
    item("contact-confirm", "Contact: confirm the message", { kind: "contact_confirm", reason: "contact", data: { url: `${pub}/contact/confirm#sample`, expiresAt: exp, topic: "A question about Diffinery" } }),
    item("contact-received", "Contact: copy for a signed-in sender", { kind: "contact_received", reason: "account", data: { id: "0123456789abcdef0123456789abcdef", topic: "Running my own Diffinery", message: "Hi! We'd like to run Diffinery for our 40 repositories.\n\nDoes it work with a custom domain on a Cloudflare zone we already have?" } }),
    item("contact-message", "Contact: new message for site administrators", {
      kind: "contact_message",
      reason: "admin",
      data: { id: "0123456789abcdef0123456789abcdef", name: "Rivera Kim", email: "rivera@example.com", login: null, topic: "Partnerships and integrations", message: "Hello,\n\nWe build a code review tool and would like to list Diffinery as a supported forge. Who should we talk to?\n\nThanks, Rivera" },
    }),
    item("security-report", "Security report", { kind: "security_report", reason: "admin", data: { id: "0123456789abcdef0123456789abcdef", summary: "Stored XSS in release notes" } }),
    item("org-member", "Organization membership", { kind: "org_membership", reason: "account", data: { org: repo.split("/")[0]!, role: "admin", previous: "member", by: "diffy-dev" } }),
    item("repo-access", "Repository access", { kind: "repo_access", reason: "account", data: { repo, role: "write", previous: null } }),
    item("repo-created", "Repository created", { kind: "repo_created", reason: "your_activity", data: { repo, creator: me, visibility: "private", defaultBranch: "main", description: "Marketing site" } }),
    item("repo-deleted", "Repository deleted", { kind: "repo_deleted", reason: "admin", data: { repo, actor: "kim" } }),
    item("repo-transferred", "Repository transferred", { kind: "repo_transferred", reason: "admin", data: { from: `${me}/${repo.split("/")[1]}`, to: repo, actor: "kim" } }),
    item("digest", "Morning digest", {
      kind: "digest",
      reason: "digest",
      data: {
        since: new Date(Date.now() - 86400_000).toISOString(),
        summary: {
          date: new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }),
          counts: { needsYou: 2, agents: 1, merged: 3, failed: 1 },
          repositories: 4,
          incomplete: false,
          sections: [
            {
              id: "needs_you",
              title: "Needs you",
              total: 2,
              items: [
                { title: "Cache build artifacts between workflow runs", url: `${pub}/${repo}/pull/42`, where: `${repo}#42`, note: "Review requested · by diffy-dev", mark: "dot" },
                { title: "Retry flaky upload step", url: `${pub}/${repo}/pull/44`, where: `${repo}#44`, note: "Agent PR needs a person's approval · by fixer-bot", mark: "dot" },
              ],
            },
            { id: "agents", title: "Agents at work", total: 1, items: [{ title: "Retry flaky upload step", url: `${pub}/${repo}/pull/44`, where: `${repo}#44`, note: "Waiting for approval · fixer-bot", mark: "dot" }] },
            { id: "failures", title: "Failed runs", total: 1, items: [{ title: "Nightly build", url: `${pub}/${repo}/actions/runs/1`, where: repo, note: "nightly on main · " + me, mark: "fail" }] },
            {
              id: "landed",
              title: "Merged",
              total: 3,
              items: [
                { title: "Bump the runner image", url: `${pub}/${repo}/pull/40`, where: `${repo}#40`, note: "by fixer-bot (agent), merged by " + me, mark: "ok" },
                { title: "Docs: caching", url: `${pub}/${repo}/pull/41`, where: `${repo}#41`, note: "by rivera", mark: "ok" },
                { title: "Fix the release notes link", url: `${pub}/${repo}/pull/39`, where: `${repo}#39`, note: "by " + me, mark: "ok" },
              ],
            },
          ],
        },
      },
    }),
    item("test", "Test email", { kind: "test", reason: "account", data: { by: me } }),
  ];
}
