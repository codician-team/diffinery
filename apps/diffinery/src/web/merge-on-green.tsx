/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { AgentSetup } from "../lib/agent-setup.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { parseAutoMergeDefault, type MergeMethod } from "../repo/auto-merge.js";
import { parseCheckList } from "../repo/required.js";
import type { ProtectionRules, ProtectionRulesInput } from "../repo/types.js";
import { csrfToken } from "./csrf.js";
import { KCheckbox, KRadio, KSelect } from "./kumo.js";
import { Section, page as settingsPage } from "./repo-settings.js";
import { Form, act, post, prm, repoUrl, type WebApp } from "./ui.js";

/**
 * Settings → Merge on green: one page that makes pull requests into the default branch merge by themselves once
 * their checks pass. It writes the default branch's protection rule (the same fields as Branch protection:
 * required checks, allowAgentAutoMerge, agentAutoMergeWithoutApproval, autoMergeAgents), suggests the checks that
 * ran on recent pull requests and the agents working here, and can turn on the admin's own "auto-merge my pull
 * requests" setting (repo/auto-merge.ts applyOwn). Nothing here lands what auto-merge wouldn't: a person's pull
 * request still waits for the approvals the rule asks for, and an agent's change to a workflow file for a person.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

export type MergeOnGreenInput = { checks: string[]; agents: string[]; withoutApproval: boolean; method: MergeMethod | null };

/** The rule with merge on green on: these required checks and agents, everything else as it was. */
export function withMergeOnGreen(rules: ProtectionRules | null, o: MergeOnGreenInput): ProtectionRulesInput {
  const { autoMergeAgents: _a, autoMergeMethod: _m, agentAutoMergeWithoutApproval: _w, requiredCheckSources, ...rest } = rules ?? {};
  // A required check bound to one reporter (set through the API) keeps its binding while it stays required.
  const kept = Object.fromEntries(Object.entries(requiredCheckSources ?? {}).filter(([name]) => o.checks.includes(name)));
  return {
    ...rest,
    requiredChecks: o.checks,
    ...(Object.keys(kept).length ? { requiredCheckSources: kept } : {}),
    allowAgentAutoMerge: true,
    ...(o.withoutApproval ? { agentAutoMergeWithoutApproval: true } : {}),
    ...(o.agents.length ? { autoMergeAgents: o.agents, ...(o.method ? { autoMergeMethod: o.method } : {}) } : {}),
  };
}

/** The rule with merge on green off: agents' auto-merges are no longer allowed; the required checks stay. */
export function withoutMergeOnGreen(rules: ProtectionRules): ProtectionRules {
  const { allowAgentAutoMerge: _a, agentAutoMergeWithoutApproval: _w, autoMergeAgents: _g, autoMergeMethod: _m, ...rest } = rules;
  return rest;
}

export const mergeOnGreenOn = (rules: ProtectionRules | null | undefined): boolean => !!rules?.allowAgentAutoMerge && !!rules.requiredChecks?.length;

const load = (c: AppContext) => loadRepo(c, prm(c, "owner"), prm(c, "repo"), "admin");

const METHODS = [
  { value: "squash", label: "Squash and merge" },
  { value: "merge", label: "Create a merge commit" },
  { value: "rebase", label: "Rebase and merge" },
];

type AgentRow = { login: string; note: string; checked: boolean };

/** The agents to offer: the rule's own, this repository's Agent setup agents, and agents that opened pull requests here. */
async function agentRows(c: AppContext, l: Loaded, rules: ProtectionRules | null, hinted: Array<{ id: string; login: string }>): Promise<AgentRow[]> {
  const on = mergeOnGreenOn(rules);
  const named = new Set((rules?.autoMergeAgents ?? []).map((a) => a.id));
  const setup = (await new AgentSetup(c.env, c.get("dir")).agents(l.repo)).filter((x) => x.agent.status === "active");
  const authors = await c.get("dir").accountsByIds(hinted.map((a) => a.id));
  const rows = new Map<string, AgentRow & { id: string }>();
  const add = (a: Pick<Account, "id" | "login">, note: string) => {
    if (!rows.has(a.id)) rows.set(a.id, { id: a.id, login: a.login, note, checked: on ? named.has(a.id) : true });
  };
  for (const a of rules?.autoMergeAgents ?? []) add(a, "Its pull requests auto-merge now");
  for (const x of setup) add(x.agent, `${x.person?.login ?? "Someone"}'s agent from Agent setup`);
  for (const a of authors) if (a.kind === "agent" && a.status === "active") add(a, "Opened pull requests here");
  return [...rows.values()];
}

const OnBanner: FC<{ branch: string; rules: ProtectionRules }> = ({ branch, rules }) => (
  <div class="flash notice">
    <b>Merge on green is on for {branch}.</b> Pull requests with auto-merge on merge as soon as {rules.requiredChecks!.length === 1 ? "the required check passes" : `the ${rules.requiredChecks!.length} required checks pass`}
    {rules.autoMergeAgents?.length ? `; it turns on by itself for ${rules.autoMergeAgents.map((a) => a.login).join(", ")}` : ""}.
    {rules.agentAutoMergeWithoutApproval ? " Agents' pull requests need no approval." : " Agents' pull requests also wait for a person's approval."}
  </div>
);

async function mergeOnGreenPage(c: AppContext, l: Loaded) {
  const me = requireAccount(c);
  const branch = l.repo.default_branch;
  const base = repoUrl(l.repo);
  const [found, hints] = await Promise.all([l.stub.protectionRuleFor(branch), l.stub.mergeOnGreenHints()]);
  const rules = found?.rules ?? null;
  const on = mergeOnGreenOn(rules);
  const agents = await agentRows(c, l, rules, hints.agents);
  const required = rules?.requiredChecks ?? [];
  const checkRows = [
    ...hints.checks.map((h) => ({ name: h.name, note: `Ran on ${h.pulls} of the last ${hints.pulls} pull request${hints.pulls === 1 ? "" : "s"} with checks`, checked: required.length ? required.includes(h.name) : h.latest })),
    ...required.filter((n) => !hints.checks.some((h) => h.name === n)).map((name) => ({ name, note: "Required now; it hasn't run on a recent pull request", checked: true })),
  ];
  const approvals = rules?.requiredApprovals ?? 0;
  const waiver = on ? !!rules?.agentAutoMergeWithoutApproval : approvals === 0;
  const linear = !!rules?.requireLinearHistory;
  const mine = parseAutoMergeDefault(me.auto_merge);
  const t = csrfToken(c);
  return settingsPage(
    c,
    l,
    "merge-on-green",
    <>
      <h1>Merge on green</h1>
      <p class="muted">
        Pull requests into <b class="mono">{branch}</b> merge by themselves once their checks pass, with nobody clicking Merge: your agents' pull requests, and your own if you like. Every other rule of {branch} still applies, and a change to a workflow file made by an agent still needs a person to merge it. See{" "}
        <a href="/docs/collaboration/merge-on-green">Merge on green automatically</a>.
      </p>
      {on && rules ? <OnBanner branch={branch} rules={rules} /> : null}
      {found && found.pattern !== branch ? (
        <div class="flash info">
          {branch} follows the rule <span class="mono">{found.pattern}</span>. Saving here makes a rule for {branch} alone, a copy of that one with merge on green added, so other branches stay as they are.
        </div>
      ) : null}
      <Form action={`${base}/settings/merge-on-green`} t={t} class="box">
        <div class="body fbody">
          <Section
            title="Checks that must pass"
            note={
              <>
                Auto-merge waits for these on each pull request. They become {branch}'s required status checks, which also means a direct push to {branch} by someone who isn't an admin must already have passed them, as on GitHub.
              </>
            }
          >
            {checkRows.length ? (
              <div class="fchecks">
                {checkRows.map((r) => (
                  <KCheckbox name="check" value={r.name} checked={r.checked} label={<span class="mono">{r.name}</span>} description={r.note} />
                ))}
              </div>
            ) : (
              <p class="small">
                No checks have run on a pull request here yet. Add a workflow that runs <code>on: pull_request</code> (see <a href="/docs/actions/overview">Actions</a>), open a pull request, and come back: its checks show up here. Or type their names below.
              </p>
            )}
            <div class="field">
              <label for="mog-other">{checkRows.length ? "Other checks" : "Check names"}</label>
              <textarea id="mog-other" name="otherChecks" class="mono" rows={2} autocomplete="off" spellcheck={false} placeholder={"CI / test"} />
              <div class="hint">One per line, exactly as the check is named on pull requests.</div>
            </div>
          </Section>
          <Section
            title="Agents"
            note={
              <>
                Diffinery turns on auto-merge by itself for pull requests these agents open. Any other agent with write access may also turn it on for its own pull requests, under the same rules, and agents can set it for every pull request they open (their owner turns it on in <a href="/settings/agents">Settings → Agents</a> or{" "}
                <a href={`${base}/settings/agent-setup`}>Agent setup</a>).
              </>
            }
          >
            {agents.length ? (
              <div class="fchecks">
                {agents.map((a) => (
                  <KCheckbox name="agent" value={a.login} checked={a.checked} label={<b>{a.login}</b>} description={a.note} />
                ))}
              </div>
            ) : (
              <p class="small">
                No agents work here yet. Make one in <a href={`${base}/settings/agent-setup`}>Agent setup</a>, or name one below.
              </p>
            )}
            <div class="fgrid c3">
              <div class="field span2">
                <label for="mog-agents">{agents.length ? "Other agents" : "Agent logins"}</label>
                <input id="mog-agents" name="otherAgents" type="text" class="mono" autocomplete="off" spellcheck={false} placeholder="my-agent" />
                <div class="hint">Separate logins with spaces or commas.</div>
              </div>
              <div class="field">
                <label for="mog-method">Their merge method</label>
                <KSelect id="mog-method" name="method" label="Their merge method" block value={rules?.autoMergeMethod && !(linear && rules.autoMergeMethod === "merge") ? rules.autoMergeMethod : "squash"} options={linear ? METHODS.filter((m) => m.value !== "merge") : METHODS} />
              </div>
            </div>
            <div class="field">
              <label>Agents' pull requests merge</label>
              <KRadio
                name="approval"
                value={waiver ? "checks" : "approval"}
                items={[
                  { value: "checks", label: "As soon as the checks pass", description: "No approving review needed for what Diffinery lands for agents here. A person's requested changes still stop it." },
                  { value: "approval", label: "Once the checks pass and a person approved", description: "A person approves the latest commit, and it merges by itself; nobody clicks Merge." },
                ]}
              />
            </div>
          </Section>
          <Section
            title="Your own pull requests"
            note={approvals ? `${branch} needs ${approvals} approving review${approvals === 1 ? "" : "s"}, so people's pull requests wait for ${approvals === 1 ? "it" : "them"} as well as the checks.` : `${branch} needs no approving review, so people's pull requests with auto-merge on merge as soon as the checks pass.`}
          >
            {mine ? (
              <p class="small m0">
                Auto-merge already turns on by itself for pull requests you open (<a href="/settings/pull-requests">Settings → Pull requests</a>).
              </p>
            ) : (
              <div class="fchecks">
                <KCheckbox
                  name="mine"
                  label="Turn on auto-merge for pull requests I open"
                  description="In every repository, wherever the branch has required checks; each still waits for every rule of its branch. Change it any time in Settings → Pull requests."
                />
              </div>
            )}
          </Section>
          <div class="factions">
            <button class="btn primary">{on ? "Save" : "Turn on merge on green"}</button>
          </div>
        </div>
      </Form>
      {on ? (
        <Form action={`${base}/settings/merge-on-green/off`} t={t} class="box" confirm={`Turn off merge on green for ${branch}? Agents' pull requests then need a person to merge them.`}>
          <div class="body row">
            <span class="grow small">Turning it off stops agents' pull requests landing through auto-merge. The required checks stay; change them in Branch protection.</span>
            <button class="btn danger">Turn off</button>
          </div>
        </Form>
      ) : null}
      <p class="small muted">
        Everything here is part of {branch}'s rule in <a href={`${base}/settings/branches`}>Branch protection</a>, where the other settings are.
      </p>
    </>,
  );
}

function audit(c: AppContext, l: Loaded, me: Account, action: string, detail: Record<string, unknown>): void {
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: me.id, actorLogin: me.login, action, target: `${l.repo.owner_login}/${l.repo.name}`, detail })
      .catch((e) => console.error("audit failed", e)),
  );
}

export function registerMergeOnGreen(web: WebApp): void {
  web.get("/:owner/:repo/settings/merge-on-green", async (c) => mergeOnGreenPage(c, await load(c)));

  post(web, "/:owner/:repo/settings/merge-on-green", async (c, f) => {
    const l = await load(c);
    const me = requireAccount(c);
    const branch = l.repo.default_branch;
    return act(
      c,
      `${repoUrl(l.repo)}/settings/merge-on-green`,
      async () => {
        const checks = [...new Set([...f.all("check").map((n) => n.trim()), ...parseCheckList(f.s("otherChecks"))].filter(Boolean))];
        if (!checks.length) throw new HttpError(422, "choose at least one check that must pass: merge on green waits for it");
        const agents = [
          ...new Set(
            [...f.all("agent"), ...f.s("otherAgents").split(/[\s,]+/)]
              .map((x) => x.trim().replace(/^@/, ""))
              .filter(Boolean),
          ),
        ];
        const m = f.s("method");
        const method = m === "merge" || m === "squash" || m === "rebase" ? m : null;
        const found = await l.stub.protectionRuleFor(branch);
        await l.stub.setProtection(branch, withMergeOnGreen(found?.rules ?? null, { checks, agents, withoutApproval: f.s("approval") === "checks", method }), l.caller);
        audit(c, l, me, "repo.merge_on_green", { branch, enabled: true, checks, agents, withoutApproval: f.s("approval") === "checks", method });
        if (f.b("mine") && !parseAutoMergeDefault(me.auto_merge)) {
          await c.get("dir").setAutoMerge(me.id, "default");
          audit(c, l, me, "account.auto_merge", { merge_method: "default" });
        }
      },
      `Merge on green is on for ${branch}.`,
    );
  });

  post(web, "/:owner/:repo/settings/merge-on-green/off", async (c) => {
    const l = await load(c);
    const me = requireAccount(c);
    const branch = l.repo.default_branch;
    return act(
      c,
      `${repoUrl(l.repo)}/settings/merge-on-green`,
      async () => {
        const found = await l.stub.protectionRuleFor(branch);
        if (!found || !mergeOnGreenOn(found.rules)) return;
        await l.stub.setProtection(found.pattern, withoutMergeOnGreen(found.rules), l.caller);
        audit(c, l, me, "repo.merge_on_green", { branch, enabled: false, pattern: found.pattern });
      },
      `Merge on green is off for ${branch}.`,
    );
  });
}
