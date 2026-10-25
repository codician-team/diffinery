/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { requireAccount, requireBrowserSession, requireRecentSignIn, type AppContext } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { AGENT_SETUP_DAYS, AgentSetup, agentMayMerge, defaultTokenName, type AgentSetupToken, type SetupCheck } from "../lib/agent-setup.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { parseAutoMergeDefault } from "../repo/auto-merge.js";
import { atLeast, type ProtectionRules } from "../repo/types.js";
import { csrfToken } from "./csrf.js";
import { KCheckbox } from "./kumo.js";
import { mergeOnGreenOn } from "./merge-on-green.js";
import { page as settingsPage } from "./repo-settings.js";
import { CopyButton, Form, Time, act, prm, post, publicUrl, repoUrl, type WebApp } from "./ui.js";

/**
 * Settings → Agent setup (lib/agent-setup.ts): a token that reaches only this repository, and the three
 * boxes a cloud agent environment needs (Network, Setup script, Environment variables), in the order
 * Claude Code's "Edit cloud environment" dialog asks for them, then the Check the setup script reports.
 * For people with write access, in a browser: no token sees this page or mints one.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

/** The repository, for a person in a browser with write access. */
async function load(c: AppContext): Promise<Loaded & { me: Account }> {
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
  const p = c.get("principal");
  if (l.caller.kind !== "user" || p.type !== "account" || (p.via !== "session" && p.via !== "dev")) throw new HttpError(403, "Agent setup is for people signed in to Diffinery in a browser");
  return { ...l, me: requireAccount(c) };
}

const date = (at: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** One copyable box: the value as it is pasted, and a Copy button when it's complete. */
const Paste: FC<{ value: string; copy?: boolean; id?: string }> = ({ value, copy = true, id }) => (
  <div class="row" style="align-items:flex-start;gap:8px">
    <pre class="cmd one grow" id={id} style="white-space:pre-wrap">
      {value}
    </pre>
    {copy ? <CopyButton text={value} size="base" /> : null}
  </div>
);

export function envBlock(o: { token: string | null; prefix: string | null; host: string; slug: string; url: string }): string {
  const shown = o.token ?? (o.prefix ? `${o.prefix}…` : "<token>");
  return [`DIFFINERY_TOKEN=${shown}`, `GH_ENTERPRISE_TOKEN=${shown}`, `GH_HOST=${o.host}`, `DIFFINERY_REPO=${o.slug}`, ...(o.url === "https://diffinery.com" ? [] : [`DIFFINERY_URL=${o.url}`])].join("\n");
}

/** The Check: green once a session's setup script passed every check. */
export const CheckStatus: FC<{ check: SetupCheck | null }> = ({ check }) => {
  if (!check) {
    return (
      <div class="flash info" style="margin:0">
        <b>Not connected yet.</b> This turns green when a session runs the setup script and every check passes.
      </div>
    );
  }
  const by = (
    <>
      {check.account ? <b>{check.account.login}</b> : "a deleted account"}
      {check.token ? (
        <>
          {" "}
          with the token <b>{check.token.name}</b> (<span class="mono">{check.token.prefix}…</span>)
        </>
      ) : null}
    </>
  );
  const failed = check.checks.filter((l) => !l.ok);
  return (
    <div>
      {check.ok ? (
        <div class="flash notice" style="margin:0 0 8px">
          <b>Connected.</b> The setup script passed every check <Time at={check.at} />, run by {by}.
        </div>
      ) : (
        <div class="flash error" style="margin:0 0 8px">
          <b>The last check failed</b> <Time at={check.at} />, run by {by}. Fix what it says and start a new session, or run the setup script again.
          {check.firstOkAt ? (
            <>
              {" "}
              It first passed <Time at={check.firstOkAt} />.
            </>
          ) : null}
        </div>
      )}
      <ul class="small" style="margin:0;padding-left:18px">
        {(failed.length ? failed : check.checks).map((l) => (
          <li>
            <span class={l.ok ? "ok" : "bad"}>{l.ok ? "✓" : "✗"}</span> <b>{l.name}</b>: {l.message}
          </li>
        ))}
      </ul>
      {check.cliVersion ? <div class="hint">CLI {check.cliVersion}</div> : null}
    </div>
  );
};

/** What "Merge its pull requests on green" does here, given the default branch's rule (web/merge-on-green.tsx). */
const MergeOnGreenNote: FC<{ branch: string; rules: ProtectionRules | null; admin: boolean; base: string }> = ({ branch, rules, admin, base }) => {
  const setUp = admin ? (
    <>
      {" "}
      <a href={`${base}/settings/merge-on-green`}>Set up merge on green</a>.
    </>
  ) : (
    " An admin of the repository can set up merge on green."
  );
  if (!rules?.requiredChecks?.length) {
    return (
      <>
        Turns on auto-merge for each pull request it opens. {branch} has no required checks yet, so here it would not wait for CI and stays off.
        {setUp}
      </>
    );
  }
  if (mergeOnGreenOn(rules)) {
    return <>Turns on auto-merge for each pull request it opens: here it merges once {branch}'s required checks pass{rules.agentAutoMergeWithoutApproval ? "" : " and a person approved its latest commit"}. A change to a workflow file still needs a person.</>;
  }
  return (
    <>
      Turns on auto-merge for each pull request it opens: here, with Can merge pull requests, it merges once {branch}'s required checks pass and a person approved its latest commit.
      {setUp}
    </>
  );
};

/** Polls the Check while the page is open, so it turns green without a reload. */
const POLL = `(()=>{const el=document.getElementById('agent-check');if(!el)return;let n=0;const tick=async()=>{if(document.hidden||n++>360)return;try{const r=await fetch(el.dataset.src,{credentials:'same-origin'});if(r.ok){const h=await r.text();if(h!==el.innerHTML)el.innerHTML=h}}catch(_){}};setInterval(tick,10000)})();`;

const TokenRow: FC<{ c: AppContext; base: string; t: AgentSetupToken }> = ({ base, t, c }) => {
  const soon = Date.parse(t.expiresAt) - Date.now() < 14 * 86400_000;
  // A list row rather than a table row: on a phone the buttons wrap below the token's details.
  return (
    <li style="flex-wrap:wrap;align-items:center">
      <div class="grow" style="min-width:200px">
        <b>{t.name}</b> <span class="small muted mono">{t.prefix}…</span>
        <div class="small muted">
          <span class={soon ? "warn" : ""}>Expires {date(t.expiresAt)}</span> · created {date(t.createdAt)} · {t.lastUsedAt ? <>last used <Time at={t.lastUsedAt} /></> : "never used"}
        </div>
      </div>
      <div class="row" style="gap:6px">
        <Form action={`${base}/tokens/${t.id}/renew`} t={csrfToken(c)} class="inline">
          <button class="btn sm" title={`Keep this token working for ${AGENT_SETUP_DAYS} days from today; nothing to paste again`}>
            Renew
          </button>
        </Form>
        <Form action={`${base}/tokens/${t.id}/regenerate`} t={csrfToken(c)} class="inline" confirm="Revoke this token and make a new one? Sessions using it stop working until you paste the new one.">
          <button class="btn sm">Revoke and regenerate</button>
        </Form>
        <Form action={`${base}/tokens/${t.id}/revoke`} t={csrfToken(c)} class="inline" confirm="Revoke this token? Environments using it stop working.">
          <button class="btn sm danger">Revoke</button>
        </Form>
      </div>
    </li>
  );
};

async function agentSetupPage(c: AppContext, l: Loaded & { me: Account }, created?: { token: string; name: string; prefix: string }) {
  const setup = new AgentSetup(c.env, c.get("dir"));
  const { repo, me } = l;
  const slug = `${repo.owner_login}/${repo.name}`;
  const url = publicUrl(c);
  const host = new URL(url).host;
  const base = `${repoUrl(repo)}/settings/agent-setup`;
  const admin = atLeast(l.caller.role, "admin");
  const agent = await setup.agentOf(repo, me);
  const active = agent?.status === "active" ? agent : null;
  const [tokens, check, everyone, rule] = await Promise.all([active ? setup.tokens(active) : Promise.resolve([]), setup.check(repo), admin ? setup.agents(repo) : Promise.resolve([]), l.stub.protectionRuleFor(repo.default_branch)]);
  const others = await Promise.all(everyone.filter((x) => x.person?.id !== me.id && x.agent.status === "active").map(async (x) => ({ ...x, tokens: await setup.tokens(x.agent) })));
  const t = csrfToken(c);
  const latest = tokens[0];
  const env = envBlock({ token: created?.token ?? null, prefix: created ? null : (latest?.prefix ?? null), host, slug, url });
  const script = `curl -fsSL ${url}/${slug}/agent-setup.sh | bash`;
  return settingsPage(
    c,
    l,
    "agent-setup",
    <>
      <h1>Agent setup</h1>
      <p class="muted">
        Everything a cloud agent environment needs to work on <b>{slug}</b> from its first session: a token that reaches only this repository, and three boxes to paste into the environment's settings. In a Claude Code cloud environment they are the <b>Network access</b>, <b>Setup script</b> and <b>Environment variables</b> fields of
        its Edit cloud environment dialog; Codex and other agent platforms have the same three. Then git, gh and the <code>diffinery</code> CLI work in every session. See <a href="/docs/connect/cloud-agents">Cloud agent environments</a>.
      </p>

      <div class="box">
        <div class="head">
          <h2>1. Token</h2>
        </div>
        <div class="body">
          {created ? (
            <div class="flash warn">
              <b>Copy it now:</b> the new token <b>{created.name}</b> is filled into Environment variables below, and it won't be shown again.
            </div>
          ) : null}
          {active ? (
            <p class="small">
              Acts as the agent <b>{active.login}</b>, which only you control and which can only reach {slug}: read and write code (protected branches still apply, and it opens pull requests instead of pushing to {repo.default_branch}), pull requests and issues, and re-running workflows. No secrets or settings, and never more than
              you can do. Each token lasts {AGENT_SETUP_DAYS} days.
            </p>
          ) : (
            <p class="small">
              Generating a token also makes your agent for this repository: an agent account that only you control, that can reach {slug} and nothing else, and that can never do more than you. Tokens last {AGENT_SETUP_DAYS} days.
            </p>
          )}
          {tokens.length ? (
            <ul class="list mb" style="border:1px solid var(--border2);border-radius:7px">
              {tokens.map((k) => (
                <TokenRow c={c} base={base} t={k} />
              ))}
            </ul>
          ) : null}
          {/* The button lines up with the input, and drops below it where both don't fit. */}
          <Form action={`${base}/generate`} t={t} class="field m0">
            <label for="tname">Label</label>
            <div class="row">
              <input id="tname" name="name" type="text" maxlength={100} value={defaultTokenName()} style="flex:1 1 240px;width:auto;min-width:0" />
              <button class="btn primary">{tokens.length ? "Generate another token" : "Generate agent token"}</button>
            </div>
            <div class="hint">Shown in the token list and in audit logs, so you can tell environments apart.</div>
            {active ? null : (
              <div class="fchecks mt">
                <KCheckbox name="auto_merge" label="Merge its pull requests on green" description={<MergeOnGreenNote branch={repo.default_branch} rules={rule?.rules ?? null} admin={admin} base={repoUrl(repo)} />} />
              </div>
            )}
          </Form>
          {active ? (
            <Form action={`${base}/merge`} t={t} class="mt">
              <div class="fchecks">
                <KCheckbox
                  name="mayMerge"
                  checked={agentMayMerge(active)}
                  label="Can merge pull requests"
                  description="It merges, or turns on auto-merge, only once a person approved the pull request's latest commit and every rule of the branch is met. A change to a workflow file always needs a person to merge."
                />
                <KCheckbox
                  name="auto_merge"
                  checked={!!parseAutoMergeDefault(active.auto_merge)}
                  label="Merge its pull requests on green"
                  description={<MergeOnGreenNote branch={repo.default_branch} rules={rule?.rules ?? null} admin={admin} base={repoUrl(repo)} />}
                />
              </div>
              <button class="btn sm mt">Save</button>
            </Form>
          ) : null}
        </div>
      </div>

      <div class="box">
        <div class="head">
          <h2>2. Network</h2>
        </div>
        <div class="body">
          <Paste value={host} />
          <p class="small muted mt" style="margin-bottom:0">
            The domain the environment must reach (the container registry is on it too). In Claude Code, set <b>Network access</b> to <b>Custom</b>, add it under <b>Allowed domains</b> and keep <b>Also include default list of common package managers</b> ticked; or choose <b>Full</b>. The default <b>Trusted</b> level
            doesn't include it.
          </p>
        </div>
      </div>

      <div class="box">
        <div class="head">
          <h2>3. Setup script</h2>
        </div>
        <div class="body">
          <Paste value={script} />
          <p class="small muted mt" style="margin-bottom:0">
            Installs the <code>diffinery</code> CLI on PATH, makes git and gh use the token from the environment (it never writes the token to disk or prints it), clones {slug} unless it's there (into <code>/home/user/{repo.name}</code> in Claude Code; set <code>DIFFINERY_NO_CLONE=1</code> to skip), adds Claude Code's Diffinery plugins so Claude hears when CI on its pushed commit passes or fails (<a href="/docs/connect/ci-status-in-claude">CI status in Claude</a>), then checks that
            everything works and reports to the Check below. Safe to run every session, and quick once the CLI is installed. <a href={`/${slug}/agent-setup.sh`}>Read the script</a>.
          </p>
        </div>
      </div>

      <div class="box">
        <div class="head">
          <h2>4. Environment variables</h2>
        </div>
        <div class="body">
          <Paste value={env} copy={!!created} id="agent-env" />
          <p class="small muted mt" style="margin-bottom:0">
            {created
              ? "Paste these lines as they are. The token is in two of them: the CLI and git read DIFFINERY_TOKEN, gh reads GH_ENTERPRISE_TOKEN, and GH_HOST points gh at Diffinery."
              : tokens.length
                ? "The token is shown only once, so it's masked here. Paste the lines with your token in both places, or choose Revoke and regenerate above to get a new one filled in."
                : "Generate a token above and it's filled in here."}
          </p>
        </div>
      </div>

      <div class="box">
        <div class="head">
          <h2>5. Check</h2>
        </div>
        <div class="body" id="agent-check" data-src={`${base}/check`}>
          <CheckStatus check={check} />
        </div>
      </div>

      <div class="box">
        <div class="head">
          <h2>Keep the token safe</h2>
        </div>
        <div class="body small">
          <ul style="margin:0;padding-left:18px">
            <li>Environment variables are visible to anyone who uses that environment, so treat the token as shared with them.</li>
            <li>Never paste the token into a chat or a screenshot. If it leaks, choose Revoke and regenerate: the old one stops working at once.</li>
            <li>
              Claude Code's <b>Network secrets</b> keep a credential out of the session, but they don't reach setup scripts, and gh won't run without a token of its own, so this page uses environment variables.
            </li>
          </ul>
        </div>
      </div>

      <details class="box">
        <summary class="head" style="cursor:pointer">
          <h2>Advanced</h2>
        </summary>
        <div class="body">
          <h3>MCP server</h3>
          <p class="small muted">
            For an agent that speaks MCP, the same token in its MCP settings (what <code>diffinery mcp-config</code> prints; clients such as Claude Code fill in <code>{"${DIFFINERY_TOKEN}"}</code> from the environment):
          </p>
          <Paste value={JSON.stringify({ mcpServers: { diffinery: { type: "http", url: `${url}/mcp`, headers: { Authorization: "Bearer ${DIFFINERY_TOKEN}" } } } }, null, 2)} />
          <h3 class="mt">Without the hosted script</h3>
          <p class="small muted">The same steps by hand, with the environment variables above set:</p>
          <Paste
            value={[
              `curl -fsSL ${url}/install | DIFFINERY_NO_MODIFY_PATH=1 bash`,
              `ln -sf "$HOME/.diffinery/bin/diffinery" /usr/local/bin/diffinery`,
              `diffinery auth setup-git`,
              `git clone ${url}/${slug}.git`,
              `gh api user --hostname ${host} --jq .login`,
              `diffinery setup --repo ${slug}   # the self-test and the Check`,
            ].join("\n")}
          />
        </div>
      </details>

      {admin && others.length ? (
        <div class="box">
          <div class="head">
            <h2>Other people's agents here</h2>
          </div>
          <div class="body small muted">As an admin you can turn off anyone's agent for this repository, which revokes its tokens at once.</div>
          <ul class="list">
            {others.map((x) => (
              <li class="row">
                <b>{x.agent.login}</b>
                <span class="muted small">
                  {x.person?.login ?? "?"}'s · {x.tokens.length} live token{x.tokens.length === 1 ? "" : "s"}
                  {x.tokens[0]?.lastUsedAt ? (
                    <>
                      {" "}
                      · last used <Time at={x.tokens[0].lastUsedAt} />
                    </>
                  ) : null}
                </span>
                <span class="grow" />
                <Form action={`${base}/agents/${x.agent.id}/disable`} t={t} class="inline" confirm={`Turn off ${x.agent.login}? Its tokens stop working at once.`}>
                  <button class="btn sm danger">Turn off</button>
                </Form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>,
    undefined,
    POLL,
  );
}

function audit(c: AppContext, l: Loaded & { me: Account }, action: string, detail: Record<string, unknown>): void {
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: l.me.id, actorLogin: l.me.login, action, target: `${l.repo.owner_login}/${l.repo.name}`, detail })
      .catch((e) => console.error("audit failed", e)),
  );
}

export function registerAgentSetup(web: WebApp): void {
  web.get("/:owner/:repo/settings/agent-setup", async (c) => agentSetupPage(c, await load(c)));

  // The Check alone, for the page's polling.
  web.get("/:owner/:repo/settings/agent-setup/check", async (c) => {
    const l = await load(c);
    const check = await new AgentSetup(c.env, c.get("dir")).check(l.repo);
    c.header("cache-control", "no-store");
    return c.html(<CheckStatus check={check} />);
  });

  // Minting a credential: a person signed in with a passkey in the last 2 hours (as for any token).
  post(web, "/:owner/:repo/settings/agent-setup/generate", async (c, f) => {
    const l = await load(c);
    requireBrowserSession(c);
    requireRecentSignIn(c, `${repoUrl(l.repo)}/settings/agent-setup`);
    const setup = new AgentSetup(c.env, c.get("dir"));
    const { agent, created } = await setup.ensureAgent(l.repo, l.me);
    const name = f.s("name").trim() || defaultTokenName();
    const t = await setup.mintToken(agent, l.repo, name);
    // Offered while the agent doesn't exist yet: its pull requests turn on auto-merge as they open.
    if (f.b("auto_merge")) await c.get("dir").setAutoMerge(agent.id, "default");
    audit(c, l, "agent_setup.token.create", { agent: agent.login, token: name, agent_created: created, ...(f.b("auto_merge") ? { auto_merge: true } : {}) });
    return agentSetupPage(c, l, { token: t.token, name, prefix: t.token.slice(0, 10) });
  });

  const mine = async (c: AppContext) => {
    const l = await load(c);
    const setup = new AgentSetup(c.env, c.get("dir"));
    const agent = await setup.agentOf(l.repo, l.me);
    if (!agent || agent.status !== "active") throw new HttpError(404, "you have no agent for this repository yet");
    const tokenId = c.req.param("id");
    if (tokenId && !(await setup.tokens(agent)).some((k) => k.id === tokenId)) throw new HttpError(404, "token not found");
    return { l, setup, agent, tokenId };
  };

  post(web, "/:owner/:repo/settings/agent-setup/tokens/:id/revoke", async (c) => {
    const { l, setup, agent, tokenId } = await mine(c);
    return act(c, `${repoUrl(l.repo)}/settings/agent-setup`, async () => {
      await setup.revoke(agent, tokenId!);
      audit(c, l, "agent_setup.token.revoke", { agent: agent.login, token_id: tokenId });
    }, "Token revoked.");
  });

  post(web, "/:owner/:repo/settings/agent-setup/tokens/:id/regenerate", async (c) => {
    requireBrowserSession(c);
    const { l, setup, agent, tokenId } = await mine(c);
    requireRecentSignIn(c, `${repoUrl(l.repo)}/settings/agent-setup`);
    const old = (await setup.tokens(agent)).find((k) => k.id === tokenId)!;
    await setup.revoke(agent, tokenId!);
    const t = await setup.mintToken(agent, l.repo, old.name);
    audit(c, l, "agent_setup.token.regenerate", { agent: agent.login, token: old.name, revoked: tokenId });
    return agentSetupPage(c, l, { token: t.token, name: old.name, prefix: t.token.slice(0, 10) });
  });

  post(web, "/:owner/:repo/settings/agent-setup/tokens/:id/renew", async (c) => {
    requireBrowserSession(c);
    const { l, setup, agent, tokenId } = await mine(c);
    requireRecentSignIn(c, `${repoUrl(l.repo)}/settings/agent-setup`);
    return act(c, `${repoUrl(l.repo)}/settings/agent-setup`, async () => {
      const until = await setup.renew(agent, tokenId!);
      audit(c, l, "agent_setup.token.renew", { agent: agent.login, token_id: tokenId, expires_at: until });
    }, `Renewed: the token works until ${date(new Date(Date.now() + AGENT_SETUP_DAYS * 86400_000).toISOString())}.`);
  });

  post(web, "/:owner/:repo/settings/agent-setup/merge", async (c, f) => {
    const { l, setup, agent } = await mine(c);
    const mayMerge = f.s("mayMerge") === "1";
    const autoMerge = f.b("auto_merge");
    return act(
      c,
      `${repoUrl(l.repo)}/settings/agent-setup`,
      async () => {
        await setup.setMayMerge(agent, mayMerge);
        audit(c, l, "agent_setup.merge", { agent: agent.login, may_merge: mayMerge });
        if (autoMerge !== !!parseAutoMergeDefault(agent.auto_merge)) {
          await c.get("dir").setAutoMerge(agent.id, autoMerge ? "default" : null);
          audit(c, l, "agent.auto_merge", { agent: agent.login, merge_method: autoMerge ? "default" : null });
        }
      },
      `${mayMerge ? `${agent.login} can merge pull requests a person approved` : `${agent.login} can no longer merge pull requests`}${autoMerge ? ", and turns on auto-merge for its pull requests" : ""}.`,
    );
  });

  // Admins: turn off someone else's agent for this repository (its tokens stop at once).
  post(web, "/:owner/:repo/settings/agent-setup/agents/:id/disable", async (c) => {
    const l = await load(c);
    if (!atLeast(l.caller.role, "admin")) throw new HttpError(403, "admin access required");
    const setup = new AgentSetup(c.env, c.get("dir"));
    const x = (await setup.agents(l.repo)).find((a) => a.agent.id === prm(c, "id"));
    if (!x) throw new HttpError(404, "agent not found");
    return act(c, `${repoUrl(l.repo)}/settings/agent-setup`, async () => {
      await c.get("dir").setStatus(x.agent.id, "disabled");
      audit(c, l, "agent_setup.agent.disable", { agent: x.agent.login, person: x.person?.login ?? null });
    }, `${x.agent.login} is off; its tokens no longer work.`);
  });
}
