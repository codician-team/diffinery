/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { requireRecentSignIn, type AppContext } from "../auth/principal.js";
import type { Env } from "../env.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { KCheckbox, KRadio } from "../web/kumo.js";
import { Form, Time, act, post, prm, type WebApp } from "../web/ui.js";
import { isProvider, ModelKeys, PROVIDERS, type ModelKeyInfo, type Provider } from "./keys.js";
import { orgUsageReport, type OrgUsageLine } from "./ledger.js";
import { DEFAULT_POLICY, MONTHLY_TOKENS_MAX, MONTHLY_TOKENS_MIN, orgPolicy, orgSpend, parsePolicy, savePolicy, spendMonth, type KeysPolicy, type OrgSpend, type StoredPolicy } from "./org-policy.js";
import { MAX_RUNNING_MAX, MAX_RUNNING_MIN } from "./project.js";
import { RUNTIMES, type RuntimeId } from "./runtimes.js";
import { requirePersonSession } from "./tasks.js";
import { UsageCells } from "./tasks-web.js";
import { formatTokens } from "./usage.js";

/**
 * Phase 5b on an organization's Settings tab (owners only): its agent policy, its model keys and what they paid
 * for. The REST API has the same under /orgs/{org}/diffinery (agentic/api.ts).
 */

export interface OrgAgentData {
  policy: StoredPolicy;
  keys: ModelKeyInfo[];
  usage: { days: number; lines: OrgUsageLine[] };
  spend: OrgSpend[];
}

export async function orgAgentData(env: Env, orgId: string): Promise<OrgAgentData> {
  const [policy, keys, usage, spend] = await Promise.all([orgPolicy(env, orgId), new ModelKeys(env).list(orgId), orgUsageReport(env, orgId), orgSpend(env, orgId)]);
  return { policy, keys, usage, spend };
}

const KEYS_LABEL: Record<KeysPolicy, { label: string; description: string }> = {
  personal: { label: "Each person's own keys", description: "The default: people run agents with their own keys, as anywhere else." },
  either: { label: "The organization's keys, when it has them", description: "Members' runs use the organization's key for the provider they need, otherwise their own. Outside collaborators always use their own." },
  organization: { label: "Only the organization's keys", description: "Personal keys are never used in the organization's repositories. Only members can run agents here; outside collaborators can't." },
};

export const OrgAgentSettings: FC<{ org: Account; data: OrgAgentData; t: string }> = ({ org, data, t }) => {
  const base = `/${org.login}/-/org`;
  const p = data.policy;
  const keys = new Map(data.keys.map((k) => [k.provider, k]));
  const cap = p.memberMonthlyTokens;
  return (
    <>
      <h2 id="agent-policy">Agents</h2>
      <Form action={`${base}/agent-policy`} t={t} class="box">
        <div class="head">
          <h2>Agent policy</h2>
          {p.updatedAt ? (
            <span class="muted small">
              Changed by {p.updatedBy ?? "someone"} <Time at={p.updatedAt} />
            </span>
          ) : (
            <span class="badge">Defaults</span>
          )}
        </div>
        <div class="body">
          <p class="muted">
            How agents may work in {org.login}'s repositories, and whose key pays. With nothing changed, members use their own keys and everything is allowed. See <a href="/docs/agents/organizations">Agents in organizations</a>.
          </p>
          <div class="field">
            <label>Whose key pays</label>
            <KRadio name="keys" label="Whose key pays" value={p.keys} items={(Object.keys(KEYS_LABEL) as KeysPolicy[]).map((k) => ({ value: k, label: KEYS_LABEL[k].label, description: KEYS_LABEL[k].description }))} />
            <div class="hint">A task keeps whose key pays from when it starts. Every model request checks again that the person is still a member, the repository still the organization's, and the key still allowed; if not, the task stops.</div>
          </div>
          <div class="field">
            <label>Allowed runtimes</label>
            {(Object.keys(RUNTIMES) as RuntimeId[]).map((r) => (
              <div>
                <KCheckbox name="runtimes" value={r} checked={p.runtimes.includes(r)} label={RUNTIMES[r].name} />
              </div>
            ))}
          </div>
          <div class="field">
            <label>Allowed providers</label>
            {(Object.keys(PROVIDERS) as Provider[]).map((x) => (
              <div>
                <KCheckbox name="providers" value={x} checked={p.providers.includes(x)} label={PROVIDERS[x].name} />
              </div>
            ))}
            <div class="hint">Checked when tasks, reviews, coordinators and terminals start, and on every model request.</div>
          </div>
          <div class="field">
            <label for="org-max-running">Most tasks at once per repository</label>
            <input id="org-max-running" name="max_running" type="number" min={MAX_RUNNING_MIN} max={MAX_RUNNING_MAX} step={1} required style="max-width:8em" value={String(p.maxRunning)} />
            <div class="hint">
              From {MAX_RUNNING_MIN} to {MAX_RUNNING_MAX}. Each project's own "tasks at once" is held to it; more wait in the queue.
            </div>
          </div>
          <div class="field">
            <label>Web terminals</label>
            <div>
              <KCheckbox name="terminals" checked={p.terminals} label="Allow web terminals" />
            </div>
            <div>
              <KCheckbox name="terminal_tasks" checked={p.terminalTasks} label="Let terminals run agent tasks" />
            </div>
            <div class="hint">Turning terminals off closes none that are open, but no new ones open and no new tasks start in them.</div>
          </div>
          <div class="field">
            <label>Agent review</label>
            <KCheckbox name="review" checked={p.review} label="Allow agent review" />
            <div class="hint">Turning it off stops new reviews; repository admins' settings stay for when it's on again.</div>
          </div>
          <div class="field">
            <label for="org-monthly">Monthly tokens per person on the organization's keys</label>
            <input id="org-monthly" name="member_monthly_tokens" type="number" min={MONTHLY_TOKENS_MIN} max={MONTHLY_TOKENS_MAX} step={1} style="max-width:14em" value={cap === null ? "" : String(cap)} placeholder="No limit" />
            <div class="hint">
              Leave empty for no limit. Each request books what it may use before it goes to the provider; past the limit the person's runs on the organization's keys stop until next month (UTC). Cache reads count a tenth, as in budgets.
            </div>
          </div>
          <button class="btn primary">Save agent policy</button>
        </div>
      </Form>

      <div class="box" id="model-keys">
        <div class="head">
          <h2>Model keys</h2>
          <span class="badge">{data.keys.length ? `${data.keys.length} saved` : "None"}</span>
        </div>
        <div class="body">
          <p class="muted">
            Keys the organization pays with, when its policy says so. Only owners see or change them, and every owner gets an email when one is added. Diffinery keeps them encrypted, never shows them again, and never puts them in a sandbox, container or terminal: the model proxy adds the key to each request itself. Use dedicated keys with a spending limit.
          </p>
          {(Object.keys(PROVIDERS) as Provider[]).map((id) => {
            const info = PROVIDERS[id];
            const k = keys.get(id);
            return (
              <div class="mb">
                <div class="row">
                  <b class="grow">{info.name}</b>
                  {k ? (
                    <>
                      <span class="mono">…{k.hint}</span>
                      <span class="muted small">
                        terms accepted by {k.optedInBy ?? "an owner"} <Time at={k.optedInAt} />
                      </span>
                      <Form action={`${base}/model-keys/${id}/delete`} t={t} class="inline" confirm={`Delete ${org.login}'s ${info.name} key? Running tasks that use it stop getting model access.`}>
                        <button class="btn sm danger">Delete</button>
                      </Form>
                    </>
                  ) : (
                    <span class="muted small">No key</span>
                  )}
                </div>
                <details>
                  <summary class="small">{k ? "Replace" : "Add a key"}</summary>
                  <Form action={`${base}/model-keys/${id}`} t={t}>
                    <div class="field">
                      <label for={`org-key-${id}`}>{org.login}'s {info.name} API key</label>
                      <input id={`org-key-${id}`} name="key" type="password" autocomplete="off" required placeholder={id === "anthropic" ? "sk-ant-…" : id === "openrouter" ? "sk-or-…" : "sk-…"} />
                      <div class="hint">
                        Create one at <a href={info.keysUrl} rel="noopener noreferrer" target="_blank">{info.keysUrl.replace("https://", "")}</a>.
                      </div>
                    </div>
                    <div class="field">
                      <KCheckbox
                        name="accept"
                        label={
                          <>
                            {org.login} uses {info.name} through Diffinery under its own {info.name} account and its terms ({info.terms.map((x, i) => (
                              <>
                                {i ? ", " : ""}
                                <a href={x.url} rel="noopener noreferrer" target="_blank">
                                  {x.label}
                                </a>
                              </>
                            ))}
                            ), which I accept for it. Usage is billed to its account. Diffinery only provides the ability.
                          </>
                        }
                      />
                    </div>
                    <button class="btn primary">{k ? "Replace key" : "Save key"}</button>
                  </Form>
                </details>
              </div>
            );
          })}
        </div>
      </div>

      <div class="box" id="org-usage">
        <div class="head">
          <h2>Paid with the organization's keys</h2>
        </div>
        <div class="body">
          <h3>This month ({spendMonth()}, UTC)</h3>
          {data.spend.length ? (
            <div class="xscroll">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th class="r">Tokens</th>
                    <th class="r">Allowance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.spend.map((x) => (
                    <tr>
                      <td>{x.login ? <a href={`/${x.login}`}>{x.login}</a> : <span class="muted">Deleted account</span>}</td>
                      <td class="r">{formatTokens(x.tokens)}</td>
                      <td class="r">{cap === null ? "No limit" : `${Math.min(100, Math.round((x.tokens / cap) * 100))}% of ${formatTokens(cap)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="muted">Nobody has used the organization's keys this month.</p>
          )}
          <h3 class="mt">Runs in the last {data.usage.days} days</h3>
          {data.usage.lines.length ? (
            <div class="xscroll">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Person</th>
                    <th>For</th>
                    <th class="r">Runs</th>
                    <th class="r">Requests</th>
                    <th class="r">Input</th>
                    <th class="r">Output</th>
                    <th class="r">Cache read / write</th>
                    <th class="r">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usage.lines.map((l) => (
                    <tr>
                      <td>{l.repository ? <a href={`/${l.repository}/tasks`}>{l.repository}</a> : <span class="muted">Unknown</span>}</td>
                      <td>{l.person ?? <span class="muted">Deleted account</span>}</td>
                      <td>{l.kind === "task" ? "Tasks" : l.kind === "review" ? "Agent reviews" : "Coordinator"}</td>
                      <td class="r">{l.runs}</td>
                      <UsageCells u={l} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="muted">No runs used the organization's keys in the last {data.usage.days} days.</p>
          )}
          <p class="muted small mt">
            Diffinery counts each request from the provider's answer. Tokens this month are weighted as budgets weigh them (a cache read counts a tenth). Also at <code>GET /api/v3/orgs/{org.login}/diffinery/model-usage</code>.
          </p>
        </div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------- posts

/** An owner of the organization (or a site admin, audited as themselves) in a browser session. */
async function orgOwner(c: AppContext) {
  const me = requirePersonSession(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(prm(c, "owner"));
  if (!org || org.kind !== "org" || org.status === "disabled") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, me.id);
  if (role !== "owner" && !me.site_admin) throw new HttpError(403, "organization owners only");
  return { me, org, dir, asSiteAdmin: role !== "owner", back: `/${org.login}?tab=settings` };
}

export function registerOrgAgents(web: WebApp): void {
  post(web, "/:owner/-/org/agent-policy", async (c, f) => {
    const { me, org, dir, back } = await orgOwner(c);
    return act(
      c,
      `${back}#agent-policy`,
      async () => {
        const monthly = f.s("member_monthly_tokens").trim();
        const p = parsePolicy(
          {
            keys: f.s("keys") || DEFAULT_POLICY.keys,
            runtimes: f.all("runtimes"),
            providers: f.all("providers"),
            max_running: f.s("max_running"),
            terminals: f.all("terminals").length > 0,
            terminal_tasks: f.all("terminal_tasks").length > 0,
            review: f.all("review").length > 0,
            member_monthly_tokens: monthly === "" ? null : monthly,
          },
          await orgPolicy(c.env, org.id),
        );
        await savePolicy(c.env, dir, org, me, p, (x) => c.executionCtx.waitUntil(x));
      },
      "Agent policy saved.",
    );
  });

  post(web, "/:owner/-/org/model-keys/:provider", async (c, f) => {
    const { me, org, dir, asSiteAdmin, back } = await orgOwner(c);
    const provider = prm(c, "provider");
    if (!isProvider(provider)) throw new HttpError(404, "not found");
    return act(
      c,
      `${back}#model-keys`,
      async () => {
        requireRecentSignIn(c, back);
        const k = await new ModelKeys(c.env).set(org, provider, f.s("key"), f.all("accept").length > 0, me);
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.model_key.set", target: org.login, detail: { provider, hint: k.hint, opted_in_at: k.optedInAt, ...(asSiteAdmin ? { site_admin: true } : {}) } }));
      },
      `${org.login}'s ${PROVIDERS[provider].name} key saved.`,
    );
  });

  post(web, "/:owner/-/org/model-keys/:provider/delete", async (c) => {
    const { me, org, dir, asSiteAdmin, back } = await orgOwner(c);
    const provider = prm(c, "provider");
    if (!isProvider(provider)) throw new HttpError(404, "not found");
    return act(
      c,
      `${back}#model-keys`,
      async () => {
        requireRecentSignIn(c, back);
        await new ModelKeys(c.env).delete(org.id, provider);
        c.executionCtx.waitUntil(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.model_key.delete", target: org.login, detail: { provider, ...(asSiteAdmin ? { site_admin: true } : {}) } }));
      },
      `${org.login}'s ${PROVIDERS[provider].name} key deleted.`,
    );
  });
}
