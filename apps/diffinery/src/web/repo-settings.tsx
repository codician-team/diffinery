/** @jsxImportSource hono/jsx */
import { refreshRepoLimit } from "../agentic/org-policy.js";
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { requireAccount, requireRecentSignIn, type AppContext } from "../auth/principal.js";
import { loadRepo, WHILE_IMPORTING } from "../http/common.js";
import { normalizeHomepage, normalizeTopics, topicsOf } from "../http/gh.js";
import { HttpError } from "../lib/util.js";
import { MAX_REVIEWERS, MAX_WAIT_TIMER, type Environment } from "../repo/deployments.js";
import { resolveReviewers } from "../http/environment-reviews.js";
import { parseCheckList } from "../repo/required.js";
import { atLeast, type ProtectionRules, type ProtectionRulesInput, type Role } from "../repo/types.js";
import { ICONS } from "./assets.js";
import { KCheckbox, KRadio, KSelect, type KOption } from "./kumo.js";
import { csrfToken, type FormData } from "./csrf.js";
import { ActionsBlockedBanner } from "./kill-switches.js";
import { Actor, CopyButton, Form, PendingInvites, ROLES, Time, cap, act, ago, flash, post, refNames, render, repoUrl, statusOf, type WebApp, prm } from "./ui.js";

type Loaded = Awaited<ReturnType<typeof loadRepo>>;
export type SettingsTab = "general" | "access" | "branches" | "merge-on-green" | "actions" | "environments" | "secrets" | "webhooks" | "agent-review" | "project" | "agent-setup";
type Tab = SettingsTab;

const WEBHOOK_EVENTS = ["push", "pull_request", "pull_request_review", "issues", "issue_comment", "workflow_run", "workflow_dispatch"];

const load = (c: AppContext, opts: { whileArchived?: boolean; whileImporting?: boolean } = {}) => loadRepo(c, prm(c, "owner"), prm(c, "repo"), "admin", opts);

function audit(c: AppContext, l: Loaded, action: string, detail?: Record<string, unknown>): void {
  const p = c.get("principal");
  const actor = p.type === "account" ? p.account : null;
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: actor?.id, actorLogin: actor?.login, onBehalfOf: l.caller.onBehalfOf, action, target: `${l.repo.owner_login}/${l.repo.name}`, detail })
      .catch((e) => console.error("audit failed", e)),
  );
}

export function page(c: AppContext, l: Loaded, tab: Tab, body: Child, status?: number, script?: string) {
  const base = `${repoUrl(l.repo)}/settings`;
  const all: Array<[Tab, string, string]> = [
    ["general", "General", base],
    ["access", "Collaborators", `${base}/access`],
    ["branches", "Branch protection", `${base}/branches`],
    ["merge-on-green", "Merge on green", `${base}/merge-on-green`],
    ["actions", "Actions", `${base}/actions`],
    ["environments", "Environments", `${base}/environments`],
    ["secrets", "Secrets and variables", `${base}/secrets`],
    ["webhooks", "Webhooks", `${base}/webhooks`],
    ["agent-review", "Agent review", `${base}/agent-review`],
    ["project", "Project", `${base}/project`],
    ["agent-setup", "Agent setup", `${base}/agent-setup`],
  ];
  // People with write access but not admin reach only Agent setup (web/agent-setup.tsx).
  const nav = atLeast(l.caller.role, "admin") ? all : all.filter(([k]) => k === "agent-setup");
  return render(
    c,
    { title: `Settings · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "settings" }, status, script },
    <div class="grid left">
      <aside class="side">
        <section>
          <div class="nav">
            {nav.map(([k, label, href]) => (
              <a href={href} class={tab === k ? "on" : ""}>
                {label}
              </a>
            ))}
          </div>
        </section>
      </aside>
      <div>
        <ActionsBlockedBanner env={c.env} repoId={l.repo.id} />
        {body}
      </div>
    </div>,
  );
}

const Once: FC<{ title: string; value: string; note: string }> = ({ title, value, note }) => (
  <div class="box" style="border-color:var(--amber)">
    <div class="body">
      <h3>{title}</h3>
      <p class="muted">{note}</p>
      <div class="row">
        <div class="secret grow">{value}</div>
        <CopyButton text={value} size="base" />
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------- protection form

type FlagGroup = "reviews" | "history" | "agents";

const RULE_FLAGS: Array<[keyof ProtectionRules & keyof ProtectionRulesInput, FlagGroup, string, string]> = [
  ["requirePullRequest", "reviews", "Require a pull request before merging", "Direct pushes are rejected; changes land through reviewed pull requests."],
  ["dismissStaleReviews", "reviews", "Dismiss stale approvals when new commits are pushed", ""],
  ["requireLinearHistory", "history", "Require linear history", "Merge commits are rejected; use squash or rebase merges."],
  ["allowForcePush", "history", "Allow force pushes", "Off by default for protected branches."],
  ["allowDeletion", "history", "Allow deletion", ""],
  ["enforceAdmins", "history", "Do not allow administrators to bypass these rules", "Off: administrators can push past these rules and merge without meeting them."],
  ["agentsMayPush", "agents", "Allow agents to push directly", "By default agents must open pull requests against protected and default branches."],
  ["agentsMayMerge", "agents", "Allow agents to merge pull requests", "By default a human must merge into protected and default branches."],
  [
    "allowAgentAutoMerge",
    "agents",
    "Allow agents to land pull requests through auto-merge",
    "Agents may turn on auto-merge or add pull requests to the merge queue; Diffinery merges once every rule is met, with no bypass. Needs at least one required status check.",
  ],
  [
    "agentAutoMergeWithoutApproval",
    "agents",
    "Let agents' auto-merges land without an approving review",
    "With the setting above: green required checks are enough for what Diffinery lands for agents. Requested changes still block it, and a change to a workflow file still needs a person.",
  ],
];

const MERGE_METHODS: KOption[] = [
  { value: "merge", label: "Create a merge commit" },
  { value: "squash", label: "Squash and merge" },
  { value: "rebase", label: "Rebase and merge" },
];

/** A titled part of a settings form; the first one in a form has no rule above it. */
export const Section: FC<{ title?: string; note?: Child; children?: Child }> = ({ title, note, children }) => (
  <section class="fsec">
    {title ? <h3>{title}</h3> : null}
    {note ? <p class="fsec-d">{note}</p> : null}
    {children}
  </section>
);

const Flags: FC<{ group: FlagGroup; rules: ProtectionRules }> = ({ group, rules }) => (
  <div class="fchecks">
    {RULE_FLAGS.filter(([, g]) => g === group).map(([key, , label, hint]) => (
      <KCheckbox name={key} checked={!!rules[key]} label={label} description={hint || undefined} />
    ))}
  </div>
);

const RuleForm: FC<{ c: AppContext; base: string; pattern?: string; rules?: ProtectionRules }> = ({ c, base, pattern, rules = {} }) => {
  // Field ids must be unique on a page that shows several rules.
  const id = (name: string) => `${name}-${pattern ? pattern.replace(/[^A-Za-z0-9_-]/g, "_") : "new"}`;
  return (
    <Form action={`${base}/settings/branches`} t={csrfToken(c)} class="body fbody">
      <input type="hidden" name="original" value={pattern ?? ""} />
      <Section>
        <div class="field">
          <label for={id("pattern")}>Branch name pattern</label>
          <input id={id("pattern")} name="pattern" type="text" required value={pattern ?? ""} placeholder="main, release/*, **" class="mono" />
          <div class="hint">
            <code>*</code> matches within a path segment, <code>**</code> across segments.
          </div>
        </div>
      </Section>
      <Section title="Pull requests and reviews">
        <Flags group="reviews" rules={rules} />
        <div class="fgrid c3">
          <div class="field">
            <label for={id("approvals")}>Required approvals</label>
            <input id={id("approvals")} name="requiredApprovals" type="number" min={0} max={10} value={String(rules.requiredApprovals ?? 0)} />
            <div class="hint">From 0 to 10.</div>
          </div>
        </div>
      </Section>
      <Section title="Status checks">
        <div class="field">
          <label for={id("checks")}>Required status checks</label>
          <textarea id={id("checks")} name="requiredChecks" class="mono" rows={3} autocomplete="off" spellcheck={false} placeholder={"CI / test\nlint"}>
            {(rules.requiredChecks ?? []).join("\n")}
          </textarea>
          <div class="hint">One check name per line, exactly as it appears on pull requests. Names may contain commas.</div>
        </div>
      </Section>
      <Section title="Pushes and history">
        <Flags group="history" rules={rules} />
      </Section>
      <Section title="Agents">
        <Flags group="agents" rules={rules} />
        <div class="fgrid c3">
          <div class="field span2">
            <label for={id("agents")}>Auto-merge pull requests from these agents</label>
            <textarea id={id("agents")} name="autoMergeAgents" class="mono" rows={2} autocomplete="off" spellcheck={false} placeholder="my-agent">
              {(rules.autoMergeAgents ?? []).map((a) => a.login).join("\n")}
            </textarea>
            <div class="hint">
              One agent login per line. Needs <b>Allow agents to land pull requests through auto-merge</b>. Diffinery turns auto-merge on by itself for their pull requests, so nobody has to click Merge: each lands once every rule on this page is met (an approval too, unless agents' auto-merges may land without one). A change to a workflow file still needs a person.
            </div>
          </div>
          <div class="field">
            <label for={id("agent-method")}>Their merge method</label>
            <KSelect id={id("agent-method")} name="autoMergeMethod" label="Their merge method" block value={rules.autoMergeMethod ?? "default"} options={[{ value: "default", label: "As the branch merges" }, ...MERGE_METHODS]} />
          </div>
        </div>
      </Section>
      <Section title="Merge queue">
        <div class="fchecks">
          <KCheckbox
            name="mergeQueue"
            checked={!!rules.mergeQueue}
            label="Require a merge queue"
            description={
              <>
                Pull requests merge in order, each tested on top of the base and the ones ahead of it. Workflows run on the queue through the <code>merge_group</code> event.
              </>
            }
          />
        </div>
        <div class="fgrid c3">
          <div class="field">
            <label for={id("mq-method")}>Merge method</label>
            <KSelect id={id("mq-method")} name="mqMethod" label="Merge method" block value={rules.mergeQueue?.method ?? "merge"} options={MERGE_METHODS} />
          </div>
          <div class="field">
            <label for={id("mq-concurrency")}>Build concurrency</label>
            <input id={id("mq-concurrency")} name="mqConcurrency" type="number" min={1} max={20} value={String(rules.mergeQueue?.buildConcurrency ?? 5)} />
            <div class="hint">Builds that run at once, 1 to 20.</div>
          </div>
          <div class="field">
            <label for={id("mq-timeout")}>Check timeout (minutes)</label>
            <input id={id("mq-timeout")} name="mqTimeout" type="number" min={1} max={360} value={String(rules.mergeQueue?.checkTimeoutMinutes ?? 60)} />
            <div class="hint">Longer waits for required checks fail, 1 to 360.</div>
          </div>
        </div>
      </Section>
      <div class="factions">
        <button class="btn primary">{pattern ? "Save rule" : "Create rule"}</button>
      </div>
    </Form>
  );
};

function rulesFrom(f: FormData): ProtectionRulesInput {
  const rules: ProtectionRulesInput = {};
  for (const [key] of RULE_FLAGS) if (f.b(key)) (rules as Record<string, unknown>)[key] = true;
  const approvals = Math.max(0, Math.min(10, parseInt(f.s("requiredApprovals"), 10) || 0));
  if (approvals) rules.requiredApprovals = approvals;
  const checks = parseCheckList(f.s("requiredChecks"));
  if (checks.length) rules.requiredChecks = checks;
  const agents = f
    .s("autoMergeAgents")
    .split(/[\s,]+/)
    .map((x) => x.trim().replace(/^@/, ""))
    .filter(Boolean);
  if (agents.length) rules.autoMergeAgents = agents;
  const agentMethod = f.s("autoMergeMethod");
  if (agents.length && (agentMethod === "merge" || agentMethod === "squash" || agentMethod === "rebase")) rules.autoMergeMethod = agentMethod;
  if (f.b("mergeQueue")) {
    const method = f.s("mqMethod");
    rules.mergeQueue = {
      method: method === "squash" || method === "rebase" ? method : "merge",
      buildConcurrency: parseInt(f.s("mqConcurrency"), 10) || 5,
      checkTimeoutMinutes: parseInt(f.s("mqTimeout"), 10) || 60,
    };
  }
  return rules;
}

// ---------------------------------------------------------------- pages

/** Where the signed-in person may transfer a repository: their own account and the organizations they own or administer. */
async function transferTargets(c: AppContext, l: Loaded): Promise<KOption[]> {
  const p = c.get("principal");
  if (p.type !== "account" || p.account.kind !== "user" || l.caller.kind !== "user") return [];
  const me = p.account;
  // A personal repository is transferred by its owner only.
  if (l.repo.owner_kind !== "org" && l.repo.owner_id !== me.id && !me.site_admin) return [];
  const orgs = (await c.get("dir").orgsFor(me.id)).filter((o) => o.role === "owner" || o.role === "admin");
  return [{ value: me.login, label: `${me.login} (your account)` }, ...orgs.map((o) => ({ value: o.login, label: o.login }))].filter((o) => o.value.toLowerCase() !== l.repo.owner_login.toLowerCase());
}

async function generalPage(c: AppContext, l: Loaded) {
  const { repo } = l;
  const base = repoUrl(repo);
  const t = csrfToken(c);
  const [names, targets] = await Promise.all([refNames(l.stub), transferTargets(c, l)]);
  const full = `${repo.owner_login}/${repo.name}`;
  return page(
    c,
    l,
    "general",
    <>
      <h1>General</h1>
      <Form action={`${base}/settings/general`} t={t} class="box">
        <div class="body fbody">
          <div class="fgrid">
            <div class="field">
              <label for="repo-name">Repository name</label>
              <input id="repo-name" name="name" type="text" value={repo.name} required pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,99}" />
              <div class="hint">Renaming changes the clone URL; update your remotes afterwards.</div>
            </div>
            <div class="field">
              <label for="default-branch">Default branch</label>
              {names.branches.length ? (
                <KSelect
                  id="default-branch"
                  name="default_branch"
                  block
                  label="Default branch"
                  value={names.branches.includes(repo.default_branch) ? repo.default_branch : undefined}
                  options={names.branches.map((b) => ({ value: b, label: b }))}
                />
              ) : (
                <input id="default-branch" name="default_branch" type="text" value={repo.default_branch} />
              )}
              <div class="hint">The branch people see first, and the one pull requests target by default.</div>
            </div>
            <div class="field full">
              <label for="repo-description">Description</label>
              <input id="repo-description" name="description" type="text" value={repo.description} maxlength={350} />
            </div>
            <div class="field full">
              <label for="repo-homepage">Website</label>
              <input id="repo-homepage" name="homepage" type="url" value={repo.homepage ?? ""} maxlength={500} placeholder="https://example.com" />
              <div class="hint">The project's site, linked from the repository's About box.</div>
            </div>
            <div class="field full">
              <label for="repo-topics">Topics</label>
              <input id="repo-topics" name="topics" type="text" value={topicsOf(repo).join(" ")} placeholder="cloudflare ci git" />
              <div class="hint">Up to 20, separated by spaces or commas: lowercase letters, digits and hyphens. They help people and search engines find the repository.</div>
            </div>
            <div class="field full">
              <label>Visibility</label>
              <KRadio name="visibility" label="Visibility" orientation="horizontal" value={repo.visibility} items={(["private", "public"] as const).map((v) => ({ value: v, label: v === "public" ? "Public" : "Private" }))} />
              <div class="hint">Private repositories are visible to you, collaborators and organization members; public ones to anyone.</div>
            </div>
          </div>
          <div class="factions">
            <button class="btn primary">Save changes</button>
          </div>
        </div>
      </Form>
      <div class="box" style="border-color:color-mix(in srgb,var(--red) 45%,transparent)">
        <div class="head" style="background:var(--red-soft)">
          <h2 class="bad">Danger zone</h2>
        </div>
        <div class="body">
          <Form action={`${base}/settings/archive`} t={t} class="drow mb" confirm={repo.archived ? "Unarchive this repository?" : "Archive this repository? It becomes read-only."}>
            <input type="hidden" name="archived" value={repo.archived ? "0" : "1"} />
            <div>
              <b>{repo.archived ? "Unarchive this repository" : "Archive this repository"}</b>
              <div class="muted small">{repo.archived ? "Make the repository writable again." : "Mark it read-only: no pushes, issues, pull requests or runs."}</div>
            </div>
            <button class="btn danger">{repo.archived ? "Unarchive" : "Archive"}</button>
          </Form>
          <hr />
          <Form action={`${base}/settings/transfer`} t={t} match={full}>
            <b>Transfer ownership</b>
            <p class="muted small">
              Move this repository to your account or an organization you own or administer. Its history, issues, pull requests, runs, secrets and settings move with it, and its old URLs redirect to the new ones. People who only had access through {repo.owner_login} lose it.
            </p>
            {targets.length ? (
              <>
                <div class="formrow">
                  <div class="field">
                    <label for="new_owner">New owner</label>
                    <KSelect id="new_owner" name="new_owner" label="New owner" placeholder="Choose an owner" options={targets} />
                  </div>
                  <div class="field grow">
                    <label for="new_name">
                      New name <span class="faint">(optional)</span>
                    </label>
                    <input id="new_name" name="new_name" type="text" pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,99}" placeholder={repo.name} autocomplete="off" />
                  </div>
                </div>
                <p class="muted small">
                  Type <b class="mono">{full}</b> to confirm.
                </p>
                <div class="row">
                  <input name="confirm" type="text" required autocomplete="off" style="max-width:320px" aria-label="Confirm repository name" />
                  <button class="btn danger">Transfer</button>
                </div>
              </>
            ) : (
              <p class="muted small m0">{repo.owner_kind !== "org" && l.caller.id !== repo.owner_id ? `Only ${repo.owner_login} can transfer this repository.` : "You don't own or administer another account or organization to transfer it to."}</p>
            )}
          </Form>
          <hr />
          <Form action={`${base}/settings/purge`} t={t} class="drow mb" confirm="Permanently delete every commit and file that no branch, tag or open pull request reaches?">
            <div>
              <b>Purge unreachable objects</b>
              <div class="muted small">After you force-push a secret away: permanently delete the commits and files no branch, tag or open pull request reaches, so nobody can fetch them by their SHA. Rotate the secret too.</div>
            </div>
            <button class="btn danger">Purge</button>
          </Form>
          <hr />
          <Form action={`${base}/settings/delete-closed-pulls`} t={t} match={full}>
            <b>Delete closed pull requests</b>
            <p class="muted small">
              To start over with fresh history after rewriting the branches: permanently delete every closed and merged pull request with its conversation, reviews and refs, then purge the commits and files nothing else reaches. Issues, open pull requests, branches, tags and workflow runs stay. Type <b class="mono">{full}</b> to confirm.
            </p>
            <div class="row">
              <input name="confirm" type="text" required autocomplete="off" style="max-width:320px" aria-label="Confirm repository name" />
              <button class="btn danger">Delete closed pull requests</button>
            </div>
          </Form>
          <hr />
          <Form action={`${base}/settings/delete`} t={t} match={full}>
            <b>Delete this repository</b>
            <p class="muted small">
              This permanently deletes the repository, its history, issues, pull requests, runs and secrets. Type <b class="mono">{full}</b> to confirm.
            </p>
            <div class="row">
              <input name="confirm" type="text" required autocomplete="off" style="max-width:320px" aria-label="Confirm repository name" />
              <button class="btn danger">Delete this repository</button>
            </div>
          </Form>
        </div>
      </div>
    </>,
  );
}

async function accessPage(c: AppContext, l: Loaded, invite?: { url: string; email: string }) {
  const { repo } = l;
  const base = repoUrl(repo);
  const t = csrfToken(c);
  const [collaborators, invites] = await Promise.all([c.get("dir").collaborators(repo.id), c.get("dir").invites({ repoId: repo.id, pending: true })]);
  return page(
    c,
    l,
    "access",
    <>
      <h1>Collaborators</h1>
      <p class="muted">
        {repo.owner_kind === "org" ? (
          <>
            Members of <a href={`/${repo.owner_login}`}>{repo.owner_login}</a> have the organization's base permission (owners and admins: admin). Add people here for more access.
          </>
        ) : (
          <>
            <b>{repo.owner_login}</b> owns this repository. Add collaborators to share it with friends or agents.
          </>
        )}
      </p>
      {invite ? <Once title={`Invitation sent to ${invite.email}`} value={invite.url} note="We emailed them an invitation. You can also send them this link yourself. It works once and expires in 14 days: they get access when they accept it, creating an account and passkey first if they don't have one." /> : null}
      <Form action={`${base}/settings/access/people`} t={t} class="box">
        <div class="head">
          <h3>{raw(ICONS.userPlus)} Add people</h3>
        </div>
        <div class="body">
          <div class="formrow">
            <div class="field grow">
              <label for="who">Username or email</label>
              <input id="who" name="who" type="text" required autocomplete="off" spellcheck={false} placeholder="diffy, review-bot or name@example.com" />
            </div>
            <div class="field">
              <label for="role">Role</label>
              <KSelect id="role" name="role" label="Role" value="write" options={ROLES.map((r) => ({ value: r, label: cap(r) }))} />
            </div>
            <button class="btn primary">Add</button>
          </div>
          <div class="hint">A person's username gets an invitation in their Settings → Invitations; they get access once they accept it. Agents, organization members and existing collaborators get the role at once. An email address gets an invitation link that also creates an account if they don't have one.</div>
        </div>
      </Form>
      <div class="box">
        {collaborators.length ? (
          <table class="tbl">
            <thead>
              <tr>
                <th>Account</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {collaborators.map((x) => (
                <tr>
                  <td>
                    <Actor login={x.account.login} kind={x.account.kind} />
                  </td>
                  <td>
                    <Form action={`${base}/settings/access`} t={t} class="row" style="gap:6px;flex-wrap:nowrap">
                      <input type="hidden" name="login" value={x.account.login} />
                      <KSelect name="role" size="sm" label={`Role of ${x.account.login}`} value={x.role} options={ROLES.map((r) => ({ value: r, label: cap(r) }))} />
                      <button class="btn sm">Save</button>
                    </Form>
                  </td>
                  <td class="right">
                    <Form action={`${base}/settings/access`} t={t} class="inline" confirm={`Remove ${x.account.login}'s access?`}>
                      <input type="hidden" name="login" value={x.account.login} />
                      <input type="hidden" name="role" value="remove" />
                      <button class="btn sm danger">Remove</button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="empty">No direct collaborators.</div>
        )}
      </div>
      <PendingInvites invites={invites} revoke={(id) => `${base}/settings/access/invites/${id}/revoke`} t={t} />
      <div class="box">
        <div class="body small muted">
          <b>Roles:</b> read — view and clone · triage — manage issues and labels · write — push, open and merge pull requests, run workflows · maintain — also move tags · admin — settings, secrets and access.
        </div>
      </div>
    </>,
  );
}

async function branchesPage(c: AppContext, l: Loaded) {
  const base = repoUrl(l.repo);
  const t = csrfToken(c);
  const rules = await l.stub.listProtections();
  return page(
    c,
    l,
    "branches",
    <>
      <h1>Branch protection</h1>
      <p class="muted">
        Rules protect matching branches from force pushes, deletion and unreviewed changes. The default branch (<span class="mono">{l.repo.default_branch}</span>) is always protected from agents. To have pull requests merge by themselves once their checks pass, use{" "}
        <a href={`${base}/settings/merge-on-green`}>Merge on green</a>.
      </p>
      {rules.map((r) => (
        <details class="box">
          <summary class="head" style="cursor:pointer">
            {raw(ICONS.shield)} <b class="mono">{r.pattern}</b>
            <span class="muted small grow">
              {[
                r.rules.requirePullRequest ? "PR required" : "",
                r.rules.requiredApprovals ? `${r.rules.requiredApprovals} approval${r.rules.requiredApprovals === 1 ? "" : "s"}` : "",
                r.rules.requiredChecks?.length ? `${r.rules.requiredChecks.length} required check${r.rules.requiredChecks.length === 1 ? "" : "s"}` : "",
                r.rules.requireLinearHistory ? "linear history" : "",
                r.rules.mergeQueue ? "merge queue" : "",
                r.rules.autoMergeAgents?.length ? `auto-merges ${r.rules.autoMergeAgents.map((a) => a.login).join(", ")}` : "",
                r.rules.enforceAdmins ? "admins included" : "",
              ]
                .filter(Boolean)
                .join(" · ") || "basic protection"}
            </span>
            <Form action={`${base}/settings/branches/delete`} t={t} class="inline" confirm={`Delete the rule for ${r.pattern}?`}>
              <input type="hidden" name="pattern" value={r.pattern} />
              <button class="btn sm danger">Delete</button>
            </Form>
          </summary>
          <RuleForm c={c} base={base} pattern={r.pattern} rules={r.rules} />
        </details>
      ))}
      {rules.length === 0 ? <div class="blank mb">No branch protection rules yet.</div> : null}
      <div class="box">
        <div class="head">
          <h3>Add a rule</h3>
        </div>
        <RuleForm c={c} base={base} rules={{ requirePullRequest: true, requiredApprovals: 1 }} />
      </div>
    </>,
  );
}

/** GitHub's Settings → Actions → General → Workflow permissions: what a job's GITHUB_TOKEN gets by default. */
async function actionsPage(c: AppContext, l: Loaded) {
  const base = repoUrl(l.repo);
  const settings = await l.stub.workflowSettings();
  return page(
    c,
    l,
    "actions",
    <>
      <h1>Actions</h1>
      <Form action={`${base}/settings/actions`} t={csrfToken(c)} class="box">
        <div class="head">
          <h2>Workflow permissions</h2>
        </div>
        <div class="body fbody">
          <Section
            title="Default token permissions"
            note={
              <>
                The default permissions of the <code>GITHUB_TOKEN</code> each job gets. A workflow or job can ask for less, or more, with a <code>permissions:</code> block.
              </>
            }
          >
            <KRadio
              name="default_permissions"
              value={settings.defaultPermissions}
              items={[
                { value: "read", label: "Read repository contents and packages permissions", description: "Jobs can read the repository and its packages, and nothing else unless the workflow asks." },
                { value: "write", label: "Read and write permissions", description: "Jobs can read and write in every scope unless the workflow asks for less." },
              ]}
            />
          </Section>
          <Section title="Pull requests and secrets">
            <div class="fchecks">
              <KCheckbox name="can_approve" checked={settings.canApprovePullRequests} label="Allow GitHub Actions to create and approve pull requests" description="Approvals from workflows never count toward required reviews." />
              <KCheckbox
                name="agent_secrets"
                checked={settings.agentRunSecrets}
                label="Give runs of agent code the repository's and organization's secrets"
                description="Off: a run whose code an agent pushed, or whose pull request an agent opened, gets only its job token. Environment secrets follow the environment's own rules."
              />
            </div>
          </Section>
          <div class="factions">
            <button class="btn primary">Save</button>
          </div>
        </div>
      </Form>
    </>,
  );
}

// ---------------------------------------------------------------- environments

const envPath = (l: Loaded, name?: string) => `${repoUrl(l.repo)}/settings/environments${name ? `/${encodeURIComponent(name)}` : ""}`;

function rulesSummary(e: Environment): string {
  const parts: string[] = [];
  if (e.protection.reviewers.length) parts.push(`${e.protection.reviewers.length} required reviewer${e.protection.reviewers.length === 1 ? "" : "s"}`);
  if (e.protection.waitTimer) parts.push(`${e.protection.waitTimer} minute wait timer`);
  if (e.policy) parts.push(e.policy.protected_branches ? "protected branches only" : `${e.policy.patterns.length} branch and tag rule${e.policy.patterns.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "No protection rules";
}

async function environmentsPage(c: AppContext, l: Loaded) {
  const t = csrfToken(c);
  const envs = await l.stub.environments();
  return page(
    c,
    l,
    "environments",
    <>
      <h1>Environments</h1>
      <p class="muted">
        A workflow job with <code>environment: name</code> deploys to that environment and gets its secrets. Required reviewers and a wait timer hold such jobs before anything starts: nothing runs, and no secret is handed out, until a reviewer approves and the timer has passed.
      </p>
      <div class="box">
        {envs.length ? (
          <ul class="list">
            {envs.map((e) => (
              <li>
                <div class="grow">
                  <a class="title" href={envPath(l, e.name)}>
                    {e.name}
                  </a>
                  <div class="meta">{rulesSummary(e)}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">No environments yet. A workflow job that names one creates it.</div>
        )}
        <Form action={envPath(l)} t={t} class="body row" style="align-items:flex-end;border-top:1px solid var(--border2)">
          <div class="field m0" style="min-width:240px">
            <label>New environment</label>
            <input name="name" type="text" required maxlength={255} placeholder="production" autocomplete="off" />
          </div>
          <button class="btn">Add environment</button>
        </Form>
      </div>
    </>,
  );
}

async function environmentPage(c: AppContext, l: Loaded, name: string) {
  const t = csrfToken(c);
  const e = await l.stub.environment(name);
  const p = e.protection;
  return page(
    c,
    l,
    "environments",
    <>
      <div class="muted small">
        <a href={envPath(l)}>Environments</a> /
      </div>
      <h1>{e.name}</h1>
      <Form action={envPath(l, e.name)} t={t} class="box">
        <div class="head">
          <h2>Deployment protection rules</h2>
        </div>
        <div class="body fbody">
          <div class="fgrid c3">
            <div class="field span2">
              <label for="env-reviewers">Required reviewers</label>
              <input id="env-reviewers" name="reviewers" type="text" value={p.reviewers.map((r) => r.login).join(", ")} placeholder="alice, bob" autocomplete="off" />
              <div class="hint">
                Up to {MAX_REVIEWERS} people with access to this repository, separated by commas. One approval lets a run's jobs deploy here. Agents can't be reviewers, and an agent's approval never counts.
              </div>
            </div>
            <div class="field">
              <label for="env-wait">Wait timer (minutes)</label>
              <input id="env-wait" name="wait_timer" type="number" min={0} max={MAX_WAIT_TIMER} value={String(p.waitTimer)} />
              <div class="hint">Jobs wait this long after they're ready to start, up to {MAX_WAIT_TIMER} (30 days). Nobody can skip it.</div>
            </div>
          </div>
          <div class="fchecks">
            <KCheckbox name="prevent_self_review" checked={p.preventSelfReview} label="Prevent self-review" description="Whoever started a run (or re-ran it, or owns the agent that did) can't approve it." />
          </div>
          <div class="field">
            <label>Deployment branches</label>
            <div class="muted small">{e.policy ? (e.policy.protected_branches ? "Protected branches only." : `Only refs matching: ${e.policy.patterns.map((x) => `${x.type} ${x.name}`).join(", ") || "(none yet)"}.`) : "Any branch or tag."} Change it with the REST API (deployment branch policies).</div>
          </div>
          <div class="factions">
            <button class="btn primary">Save protection rules</button>
          </div>
        </div>
      </Form>
      <Form action={`${envPath(l, e.name)}/delete`} t={t} class="box" confirm={`Delete the ${e.name} environment, its secrets and its variables?`}>
        <div class="body drow">
          <div>
            <b>Delete this environment</b>
            <div class="muted small">Its secrets, variables and protection rules go with it. Past deployments stay.</div>
          </div>
          <button class="btn danger">Delete environment</button>
        </div>
      </Form>
    </>,
  );
}

async function secretsPage(c: AppContext, l: Loaded) {
  const base = repoUrl(l.repo);
  const t = csrfToken(c);
  const [secrets, vars] = await Promise.all([l.stub.secretNames(), l.stub.variables(false)]);
  return page(
    c,
    l,
    "secrets",
    <>
      <h1>Secrets and variables</h1>
      <p class="muted">
        Use them in workflows as <code>{"${{ secrets.NAME }}"}</code> and <code>{"${{ vars.NAME }}"}</code>. Secret values are encrypted and never shown again; they are masked in logs.
      </p>
      <div class="box">
        <div class="head">
          <h2>{raw(ICONS.key)} Repository secrets</h2>
        </div>
        {secrets.length ? (
          <ul class="list">
            {secrets.map((s) => (
              <li style="align-items:center">
                <span class="mono grow">
                  <b>{s.name}</b>
                </span>
                <span class="muted small">updated {ago(s.updatedAt)}</span>
                <Form action={`${base}/settings/secrets/delete`} t={t} class="inline" confirm={`Delete secret ${s.name}?`}>
                  <input type="hidden" name="name" value={s.name} />
                  <button class="btn sm danger">Delete</button>
                </Form>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">No secrets yet.</div>
        )}
        <Form action={`${base}/settings/secrets`} t={t} class="body fbody" style="border-top:1px solid var(--border2)">
          <div class="fgrid">
            <div class="field">
              <label for="secret-name">Name</label>
              <input id="secret-name" name="name" type="text" required pattern="[A-Za-z_][A-Za-z0-9_]*" class="mono" placeholder="API_TOKEN" autocomplete="off" />
            </div>
            <div class="field full">
              <label for="secret-value">Value</label>
              <textarea id="secret-value" name="value" required class="mono" rows={4} autocomplete="off" spellcheck={false}></textarea>
              <div class="hint">Setting an existing name replaces its value.</div>
            </div>
          </div>
          <div class="factions">
            <button class="btn primary">Save secret</button>
          </div>
        </Form>
      </div>
      <div class="box">
        <div class="head">
          <h2>Variables</h2>
        </div>
        {Object.keys(vars).length ? (
          <table class="tbl">
            <tbody>
              {Object.entries(vars)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <tr>
                    <td class="mono">
                      <b>{k}</b>
                    </td>
                    <td class="mono small" style="word-break:break-all">
                      {v}
                    </td>
                    <td class="right">
                      <Form action={`${base}/settings/variables/delete`} t={t} class="inline" confirm={`Delete variable ${k}?`}>
                        <input type="hidden" name="name" value={k} />
                        <button class="btn sm danger">Delete</button>
                      </Form>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <div class="empty">No variables yet.</div>
        )}
        <Form action={`${base}/settings/variables`} t={t} class="body row" style="align-items:flex-end;border-top:1px solid var(--border2)">
          <div class="field m0" style="min-width:200px">
            <label>Name</label>
            <input name="name" type="text" required pattern="[A-Za-z_][A-Za-z0-9_]*" class="mono" />
          </div>
          <div class="field grow m0">
            <label>Value</label>
            <input name="value" type="text" class="mono" />
          </div>
          <button class="btn primary">Save variable</button>
        </Form>
      </div>
    </>,
  );
}

async function webhooksPage(c: AppContext, l: Loaded, created?: { secret: string; url: string }) {
  const base = repoUrl(l.repo);
  const t = csrfToken(c);
  const hooks = await l.stub.webhooks();
  return page(
    c,
    l,
    "webhooks",
    <>
      <h1>Webhooks</h1>
      <p class="muted">
        Diffinery POSTs JSON events to these URLs, signed with an HMAC-SHA256 of the body using the webhook's secret.
      </p>
      {created ? <Once title={`Webhook created for ${created.url}`} value={created.secret} note="This is the signing secret. Copy it now; it will not be shown again." /> : null}
      <div class="box">
        {hooks.length ? (
          <ul class="list">
            {hooks.map((h) => (
              <li style="align-items:center">
                <span class={`st ${h.lastStatus === null ? "faint" : h.lastStatus >= 200 && h.lastStatus < 300 ? "ok" : "bad"}`}>{raw(h.lastStatus === null ? ICONS.queued : h.lastStatus >= 200 && h.lastStatus < 300 ? ICONS.success : ICONS.failure)}</span>
                <div class="grow">
                  <b class="mono" style="word-break:break-all">
                    {h.url}
                  </b>
                  <div class="meta">
                    {h.events.join(", ")} · {h.active ? "active" : "inactive"}
                    {h.lastDeliveryAt ? (
                      <>
                        {" "}
                        · last delivery {h.lastStatus ?? "?"} <Time at={h.lastDeliveryAt} />
                      </>
                    ) : (
                      " · no deliveries yet"
                    )}
                  </div>
                </div>
                <Form action={`${base}/settings/webhooks/delete`} t={t} class="inline" confirm="Delete this webhook?">
                  <input type="hidden" name="id" value={h.id} />
                  <button class="btn sm danger">Delete</button>
                </Form>
              </li>
            ))}
          </ul>
        ) : (
          <div class="empty">No webhooks yet.</div>
        )}
      </div>
      <Form action={`${base}/settings/webhooks`} t={t} class="box">
        <div class="head">
          <h3>Add a webhook</h3>
        </div>
        <div class="body fbody">
          <div class="field">
            <label for="hook-url">Payload URL</label>
            <input id="hook-url" name="url" type="url" required placeholder="https://example.com/hooks/diffinery" pattern="https://.*" />
          </div>
          <div class="field">
            <label>Events</label>
            <div class="fchecks cols">
              <KCheckbox name="events" value="*" checked label="Everything" />
              {WEBHOOK_EVENTS.map((e) => (
                <KCheckbox name="events" value={e} label={<span class="mono small">{e}</span>} />
              ))}
            </div>
          </div>
          <div class="fgrid">
            <div class="field">
              <label for="hook-secret">
                Secret <span class="faint">(optional)</span>
              </label>
              <input id="hook-secret" name="secret" type="text" autocomplete="off" class="mono" />
              <div class="hint">Left empty, Diffinery generates one and shows it once.</div>
            </div>
          </div>
          <div class="factions">
            <button class="btn primary">Add webhook</button>
          </div>
        </div>
      </Form>
    </>,
  );
}

// ---------------------------------------------------------------- routes

export function registerRepoSettings(web: WebApp): void {
  web.get("/:owner/:repo/settings", async (c) => generalPage(c, await load(c)));
  web.get("/:owner/:repo/settings/access", async (c) => accessPage(c, await load(c)));
  web.get("/:owner/:repo/settings/branches", async (c) => branchesPage(c, await load(c)));
  web.get("/:owner/:repo/settings/actions", async (c) => actionsPage(c, await load(c)));
  web.get("/:owner/:repo/settings/secrets", async (c) => secretsPage(c, await load(c)));
  web.get("/:owner/:repo/settings/environments", async (c) => environmentsPage(c, await load(c)));
  web.get("/:owner/:repo/settings/environments/:env", async (c) => environmentPage(c, await load(c), prm(c, "env")));

  post(web, "/:owner/:repo/settings/environments", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    const name = f.s("name").trim();
    return act(c, envPath(l), async () => {
      const e = await l.stub.upsertEnvironment(name, {}, l.caller);
      audit(c, l, "environment.update", { environment: e.name });
      return envPath(l, e.name);
    });
  });

  post(web, "/:owner/:repo/settings/environments/:env", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    const name = prm(c, "env");
    return act(
      c,
      envPath(l, name),
      async () => {
        const logins = f
          .s("reviewers")
          .split(/[\s,]+/)
          .map((x) => x.replace(/^@/, ""))
          .filter(Boolean);
        const reviewers = await resolveReviewers(c, l.repo, logins.map((login) => ({ type: "User", login })));
        const raw = f.s("wait_timer").trim();
        const waitTimer = raw === "" ? 0 : Number(raw);
        const e = await l.stub.upsertEnvironment(name, { reviewers, wait_timer: waitTimer, prevent_self_review: f.s("prevent_self_review") === "1" }, l.caller);
        audit(c, l, "environment.update", { environment: e.name, reviewers: e.protection.reviewers.map((r) => r.login), wait_timer: e.protection.waitTimer, prevent_self_review: e.protection.preventSelfReview });
      },
      "Protection rules saved.",
    );
  });

  post(web, "/:owner/:repo/settings/environments/:env/delete", async (c) => {
    const l = await load(c, WHILE_IMPORTING);
    const name = prm(c, "env");
    return act(
      c,
      envPath(l),
      async () => {
        await l.stub.deleteEnvironment(name, l.caller);
        audit(c, l, "environment.delete", { environment: name });
      },
      `Deleted ${name}.`,
    );
  });
  web.get("/:owner/:repo/settings/webhooks", async (c) => webhooksPage(c, await load(c)));

  post(web, "/:owner/:repo/settings/actions", async (c, f) => {
    const l = await load(c);
    return act(
      c,
      `${repoUrl(l.repo)}/settings/actions`,
      async () => {
        const defaultPermissions = f.s("default_permissions") === "write" ? "write" : "read";
        await l.stub.setWorkflowSettings({ defaultPermissions, canApprovePullRequests: f.s("can_approve") === "1", agentRunSecrets: f.s("agent_secrets") === "1" }, l.caller);
      },
      "Actions settings saved.",
    );
  });

  post(web, "/:owner/:repo/settings/general", async (c, f) => {
    const l = await load(c);
    const dir = c.get("dir");
    return act(
      c,
      `${repoUrl(l.repo)}/settings`,
      async () => {
        const name = f.s("name").trim();
        const visibility = (["private", "public"] as const).find((v) => v === f.s("visibility"));
        const defaultBranch = f.s("default_branch").trim();
        if (name && name !== l.repo.name && (await dir.repo(l.repo.owner_login, name))) throw new HttpError(422, "a repository with that name already exists");
        // Forms without these fields (older pages, scripts) leave them alone.
        const has = (k: string) => f.keys().includes(k);
        const topics = has("topics") ? normalizeTopics(f.s("topics").split(/[\s,]+/)) : undefined;
        const topicsChanged = topics !== undefined && topics.join(" ") !== topicsOf(l.repo).join(" ");
        const homepage = has("homepage") ? normalizeHomepage(f.s("homepage")) : undefined;
        const updated = await dir.updateRepo(l.repo, {
          name: name && name !== l.repo.name ? name : undefined,
          description: f.s("description").trim(),
          homepage: homepage !== (l.repo.homepage ?? "") ? homepage : undefined,
          topics: topicsChanged ? topics : undefined,
          visibility: visibility && visibility !== l.repo.visibility ? visibility : undefined,
          defaultBranch: defaultBranch && defaultBranch !== l.repo.default_branch ? defaultBranch : undefined,
        });
        audit(c, l, "repo.update", { name: updated.name, visibility: updated.visibility, defaultBranch: updated.default_branch, homepage: updated.homepage ?? "" });
        if (topicsChanged) audit(c, l, "repo.topics", { names: topics });
        return `${repoUrl(updated)}/settings`;
      },
      "Settings saved.",
    );
  });

  post(web, "/:owner/:repo/settings/archive", async (c, f) => {
    const l = await load(c, { whileArchived: true });
    const archived = f.s("archived") === "1";
    return act(
      c,
      `${repoUrl(l.repo)}/settings`,
      async () => {
        await c.get("dir").updateRepo(l.repo, { archived });
        audit(c, l, archived ? "repo.archive" : "repo.unarchive");
      },
      archived ? "Repository archived." : "Repository unarchived.",
    );
  });

  post(web, "/:owner/:repo/settings/delete", async (c, f) => {
    const l = await load(c, { whileArchived: true });
    requireAccount(c);
    const full = `${l.repo.owner_login}/${l.repo.name}`;
    return act(
      c,
      `${repoUrl(l.repo)}/settings`,
      async () => {
        if (f.s("confirm").trim() !== full) throw new HttpError(422, `type ${full} to confirm deletion`);
        requireRecentSignIn(c, `${repoUrl(l.repo)}/settings`);
        await c.get("dir").deleteRepo(l.repo);
        audit(c, l, "repo.delete");
        return "/";
      },
      `Deleted ${full}.`,
    );
  });

  post(web, "/:owner/:repo/settings/purge", async (c) => {
    const l = await load(c);
    requireAccount(c);
    return act(c, `${repoUrl(l.repo)}/settings`, async () => {
      requireRecentSignIn(c, `${repoUrl(l.repo)}/settings`);
      const r = await l.stub.purgeUnreachable(l.caller);
      audit(c, l, "repo.purge_unreachable", { objects: r.objects, bytes: r.bytes });
      flash(c, "notice", r.objects ? `Purged ${r.objects} unreachable object${r.objects === 1 ? "" : "s"}.` : "Nothing to purge: every object is reachable.");
    });
  });

  post(web, "/:owner/:repo/settings/delete-closed-pulls", async (c, f) => {
    const l = await load(c);
    requireAccount(c);
    const full = `${l.repo.owner_login}/${l.repo.name}`;
    return act(c, `${repoUrl(l.repo)}/settings`, async () => {
      if (f.s("confirm").trim() !== full) throw new HttpError(422, `type ${full} to confirm`);
      requireRecentSignIn(c, `${repoUrl(l.repo)}/settings`);
      const r = await l.stub.deleteClosedPullRequests(l.caller);
      audit(c, l, "repo.delete_closed_pulls", { pull_requests: r.pullRequests, objects: r.objects, bytes: r.bytes });
      flash(c, "notice", r.pullRequests ? `Deleted ${r.pullRequests} closed pull request${r.pullRequests === 1 ? "" : "s"} and purged ${r.objects} unreachable object${r.objects === 1 ? "" : "s"}.` : `No closed pull requests to delete; purged ${r.objects} unreachable object${r.objects === 1 ? "" : "s"}.`);
    });
  });

  post(web, "/:owner/:repo/settings/transfer", async (c, f) => {
    const l = await load(c, { whileArchived: true });
    const me = requireAccount(c);
    const full = `${l.repo.owner_login}/${l.repo.name}`;
    return act(
      c,
      `${repoUrl(l.repo)}/settings`,
      async () => {
        if (f.s("confirm").trim() !== full) throw new HttpError(422, `type ${full} to confirm the transfer`);
        requireRecentSignIn(c, `${repoUrl(l.repo)}/settings`);
        const dir = c.get("dir");
        const target = await dir.accountByLogin(f.s("new_owner").trim());
        if (!target) throw new HttpError(422, "choose the new owner");
        const moved = await dir.transferRepo(l.repo, me, target, f.s("new_name").trim() || undefined);
        c.executionCtx.waitUntil(refreshRepoLimit(c.env, moved));
        audit(c, { ...l, repo: moved }, "repo.transfer", { from: full, to: `${moved.owner_login}/${moved.name}` });
        flash(c, "notice", `Transferred ${full} to ${moved.owner_login}/${moved.name}.`);
        return `${repoUrl(moved)}/settings`;
      },
    );
  });

  post(web, "/:owner/:repo/settings/access", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    const dir = c.get("dir");
    return act(c, `${repoUrl(l.repo)}/settings/access`, async () => {
      const who = await dir.accountByLogin(f.s("login").trim());
      if (!who || who.kind === "org") throw new HttpError(404, "no person or agent with that username");
      const roleIn = f.s("role");
      const role: Role | null = roleIn === "remove" ? null : (ROLES.find((r) => r === roleIn) ?? null);
      if (roleIn !== "remove" && !role) throw new HttpError(422, "invalid role");
      if (!role) {
        await dir.setCollaborator(l.repo.id, who.id, null);
        audit(c, l, "repo.collaborator.remove", { login: who.login });
        return;
      }
      // Someone without access yet gets an invitation to accept (see Directory.grantRepoAccess).
      const r = await dir.grantRepoAccess(l.repo, requireAccount(c), who, role);
      if ("invitedUser" in r) {
        flash(c, "notice", r.renewed ? `${who.login} already had a pending invitation; it now offers ${role} access.` : `Invited ${who.login} with ${role} access. They get access once they accept.`);
        audit(c, l, "repo.invite", { login: who.login, role });
      } else audit(c, l, "repo.collaborator.set", { login: who.login, role });
    });
  });

  post(web, "/:owner/:repo/settings/access/invites/:id/revoke", async (c) => {
    const l = await load(c, WHILE_IMPORTING);
    return act(c, `${repoUrl(l.repo)}/settings/access`, async () => {
      if (!(await c.get("dir").revokeInvite(prm(c, "id"), { repoId: l.repo.id }))) throw new HttpError(404, "this invitation was already used, revoked or never existed");
      audit(c, l, "repo.invite.revoke", { id: prm(c, "id") });
    }, "Invitation revoked.");
  });

  post(web, "/:owner/:repo/settings/access/people", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    const me = requireAccount(c);
    const role = ROLES.find((r) => r === f.s("role")) ?? "write";
    let invited: { email: string; url: string } | undefined;
    const res = await act(c, `${repoUrl(l.repo)}/settings/access`, async () => {
      const r = await c.get("dir").addRepoPerson(l.repo, me, f.s("who"), role);
      if ("added" in r) {
        flash(c, "notice", `${r.added.login} now has ${role} access. We let them know.`);
        audit(c, l, "repo.collaborator.set", { login: r.added.login, role });
      } else if ("invitedUser" in r) {
        flash(c, "notice", r.renewed ? `${r.invitedUser.login} already had a pending invitation; it now offers ${role} access.` : `Invited ${r.invitedUser.login} with ${role} access. They get access once they accept.`);
        audit(c, l, "repo.invite", { login: r.invitedUser.login, role });
      } else {
        invited = r.invited;
        audit(c, l, "repo.invite", { email: r.invited.email, role });
      }
    });
    return invited ? accessPage(c, l, invited) : res;
  });

  post(web, "/:owner/:repo/settings/branches", async (c, f) => {
    const l = await load(c);
    return act(
      c,
      `${repoUrl(l.repo)}/settings/branches`,
      async () => {
        const pattern = f.s("pattern").trim();
        if (!pattern || /\s/.test(pattern)) throw new HttpError(422, "enter a branch name pattern");
        const original = f.s("original").trim();
        const rules = rulesFrom(f);
        // The form doesn't edit which app must report each required check; keep those bindings (set through the API).
        const before = (await l.stub.listProtections()).find((p) => p.pattern === (original || pattern))?.rules.requiredCheckSources;
        if (before && rules.requiredChecks?.length) {
          const kept = Object.fromEntries(Object.entries(before).filter(([name]) => rules.requiredChecks!.includes(name)));
          if (Object.keys(kept).length) rules.requiredCheckSources = kept;
        }
        if (original && original !== pattern) await l.stub.setProtection(original, null, l.caller);
        await l.stub.setProtection(pattern, rules, l.caller);
        audit(c, l, "repo.protection.set", { pattern, rules });
      },
      "Branch protection saved.",
    );
  });

  post(web, "/:owner/:repo/settings/branches/delete", async (c, f) => {
    const l = await load(c);
    return act(c, `${repoUrl(l.repo)}/settings/branches`, async () => {
      await l.stub.setProtection(f.s("pattern"), null, l.caller);
      audit(c, l, "repo.protection.delete", { pattern: f.s("pattern") });
    });
  });

  post(web, "/:owner/:repo/settings/secrets", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    return act(
      c,
      `${repoUrl(l.repo)}/settings/secrets`,
      async () => {
        const name = f.s("name").trim();
        try {
          await l.stub.setSecret(name, f.s("value"));
        } catch (e) {
          const s = statusOf(e);
          if (s.status < 500) throw e;
          throw new HttpError(422, `could not store the secret: ${(e as Error).message || "encryption unavailable"} (is MASTER_KEY configured?)`);
        }
        audit(c, l, "repo.secret.set", { name: name.toUpperCase() });
      },
      "Secret saved.",
    );
  });

  post(web, "/:owner/:repo/settings/secrets/delete", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    return act(c, `${repoUrl(l.repo)}/settings/secrets`, async () => {
      await l.stub.deleteSecret(f.s("name"));
      audit(c, l, "repo.secret.delete", { name: f.s("name") });
    });
  });

  post(web, "/:owner/:repo/settings/variables", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    return act(c, `${repoUrl(l.repo)}/settings/secrets`, async () => {
      const name = f.s("name").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new HttpError(422, "invalid variable name");
      await l.stub.setVariable(name, f.s("value"));
      audit(c, l, "repo.variable.set", { name });
    });
  });

  post(web, "/:owner/:repo/settings/variables/delete", async (c, f) => {
    const l = await load(c, WHILE_IMPORTING);
    return act(c, `${repoUrl(l.repo)}/settings/secrets`, async () => {
      await l.stub.setVariable(f.s("name"), null);
      audit(c, l, "repo.variable.delete", { name: f.s("name") });
    });
  });

  post(web, "/:owner/:repo/settings/webhooks", async (c, f) => {
    const l = await load(c);
    const url = f.s("url").trim();
    const events = f.all("events").filter((e) => e === "*" || WEBHOOK_EVENTS.includes(e));
    try {
      const hook = await l.stub.createWebhook(url, events.includes("*") ? ["*"] : events, f.s("secret").trim() || undefined);
      audit(c, l, "repo.webhook.create", { url, events });
      return webhooksPage(c, l, { secret: hook.secret, url });
    } catch (e) {
      const s = statusOf(e);
      if (s.status >= 500) throw e;
      return act(c, `${repoUrl(l.repo)}/settings/webhooks`, async () => {
        throw e;
      });
    }
  });

  post(web, "/:owner/:repo/settings/webhooks/delete", async (c, f) => {
    const l = await load(c);
    return act(c, `${repoUrl(l.repo)}/settings/webhooks`, async () => {
      await l.stub.deleteWebhook(f.s("id"));
      audit(c, l, "repo.webhook.delete", { id: f.s("id") });
    });
  });
}
