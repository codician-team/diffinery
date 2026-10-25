import type { Env } from "../env.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { HttpError, now } from "../lib/util.js";
import { ModelKeys, PROVIDERS, type Provider } from "./keys.js";
import { MAX_RUNNING_MAX, MAX_RUNNING_MIN } from "./project.js";
import { RUNTIMES, runtimeLabel, runtimeNeeds, type RuntimeId } from "./runtimes.js";

/**
 * Organizations' agent policies and model keys (phase 5b): what owners decide for agents in the organization's
 * repositories, and whose key pays. Nothing changes for an organization that set nothing, and repositories owned
 * by a person have no policy.
 *
 * Whose key pays is decided when a task starts (a review or coordinator: when its run starts) and kept on the task
 * as `key_owner`: the person's id, or the organization's. The model proxy re-checks it on every request, uncached,
 * before it decrypts the key (proxyPayer): only a member who is a person (never an agent account) spends the
 * organization's key, and only in a repository the organization still owns, under its monthly allowance.
 */

export type KeysPolicy = "personal" | "either" | "organization";
export const KEYS_POLICIES: readonly KeysPolicy[] = ["personal", "either", "organization"];
const RUNTIME_IDS = Object.keys(RUNTIMES) as RuntimeId[];
const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

/** The largest monthly allowance per person on the organization's keys: 10 billion weighted tokens. */
export const MONTHLY_TOKENS_MAX = 10_000_000_000;
export const MONTHLY_TOKENS_MIN = 10_000;

export interface AgentPolicy {
  keys: KeysPolicy;
  runtimes: RuntimeId[];
  providers: Provider[];
  /** Most tasks at once per repository; each project's own setting is clamped to it. */
  maxRunning: number;
  terminals: boolean;
  /** Whether terminals may run agent tasks (only while terminals are allowed). */
  terminalTasks: boolean;
  review: boolean;
  /** Most weighted tokens each person may spend on the organization's keys per calendar month (UTC); null for no limit. */
  memberMonthlyTokens: number | null;
}

export const DEFAULT_POLICY: AgentPolicy = {
  keys: "personal",
  runtimes: [...RUNTIME_IDS],
  providers: [...PROVIDER_IDS],
  maxRunning: MAX_RUNNING_MAX,
  terminals: true,
  terminalTasks: true,
  review: true,
  memberMonthlyTokens: null,
};

export interface StoredPolicy extends AgentPolicy {
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function orgPolicy(env: Env, orgId: string): Promise<StoredPolicy> {
  const row = await env.DB.prepare("SELECT p.json, a.login AS by_login, p.updated_at FROM org_agent_policies p LEFT JOIN accounts a ON a.id = p.updated_by WHERE p.org_id = ?")
    .bind(orgId)
    .first<{ json: string; by_login: string | null; updated_at: string }>();
  if (!row) return { ...DEFAULT_POLICY, updatedBy: null, updatedAt: null };
  return { ...DEFAULT_POLICY, ...(JSON.parse(row.json) as Partial<AgentPolicy>), updatedBy: row.by_login, updatedAt: row.updated_at };
}

/** The policy of the organization that owns `repo`, or null for a person's repository. */
export async function repoPolicy(env: Env, repo: Pick<Repo, "owner_id" | "owner_kind">): Promise<{ orgId: string; policy: AgentPolicy } | null> {
  if (repo.owner_kind !== "org") return null;
  return { orgId: repo.owner_id, policy: await orgPolicy(env, repo.owner_id) };
}

export interface PolicyInput {
  keys?: unknown;
  runtimes?: unknown;
  providers?: unknown;
  max_running?: unknown;
  terminals?: unknown;
  terminal_tasks?: unknown;
  review?: unknown;
  member_monthly_tokens?: unknown;
}

const list = <T extends string>(v: unknown, all: readonly T[], name: string): T[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !all.includes(x as T))) throw new HttpError(422, `\`${name}\` must be a list of: ${all.join(", ")}`);
  return all.filter((x) => v.includes(x));
};

const bool = (v: unknown, name: string): boolean => {
  if (typeof v !== "boolean") throw new HttpError(422, `\`${name}\` must be true or false`);
  return v;
};

/** A policy from the REST body or the settings form; fields left out keep `current`. */
export function parsePolicy(input: PolicyInput, current: AgentPolicy): AgentPolicy {
  const p: AgentPolicy = { ...current };
  if (input.keys !== undefined) {
    if (typeof input.keys !== "string" || !KEYS_POLICIES.includes(input.keys as KeysPolicy)) throw new HttpError(422, `\`keys\` must be ${KEYS_POLICIES.join(", ")}`);
    p.keys = input.keys as KeysPolicy;
  }
  if (input.runtimes !== undefined) p.runtimes = list(input.runtimes, RUNTIME_IDS, "runtimes");
  if (input.providers !== undefined) p.providers = list(input.providers, PROVIDER_IDS, "providers");
  if (input.max_running !== undefined) {
    const n = Number(input.max_running);
    if (input.max_running === "" || input.max_running === null || !Number.isInteger(n) || n < MAX_RUNNING_MIN || n > MAX_RUNNING_MAX) throw new HttpError(422, `\`max_running\` must be a whole number from ${MAX_RUNNING_MIN} to ${MAX_RUNNING_MAX}`);
    p.maxRunning = n;
  }
  if (input.terminals !== undefined) p.terminals = bool(input.terminals, "terminals");
  if (input.terminal_tasks !== undefined) p.terminalTasks = bool(input.terminal_tasks, "terminal_tasks");
  if (input.review !== undefined) p.review = bool(input.review, "review");
  if (input.member_monthly_tokens !== undefined) {
    const v = input.member_monthly_tokens;
    if (v === null || v === "") p.memberMonthlyTokens = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < MONTHLY_TOKENS_MIN || n > MONTHLY_TOKENS_MAX) throw new HttpError(422, `\`member_monthly_tokens\` must be null (no limit) or a whole number from ${MONTHLY_TOKENS_MIN} to ${MONTHLY_TOKENS_MAX}`);
      p.memberMonthlyTokens = n;
    }
  }
  if (!p.runtimes.length) throw new HttpError(422, "allow at least one runtime");
  if (!p.providers.length) throw new HttpError(422, "allow at least one provider");
  return p;
}

export const policyJson = (p: StoredPolicy) => ({
  keys: p.keys,
  runtimes: p.runtimes,
  providers: p.providers,
  max_running: p.maxRunning,
  terminals: p.terminals,
  terminal_tasks: p.terminalTasks,
  review: p.review,
  member_monthly_tokens: p.memberMonthlyTokens,
  updated_by: p.updatedBy,
  updated_at: p.updatedAt,
});

/**
 * Save an organization's policy (the caller checked it's an owner, or a site admin), and clamp its repositories'
 * "how many at once" now: their ProjectDOs keep the organization's limit, which every task start refreshes too.
 */
export async function savePolicy(env: Env, dir: Directory, org: Account, me: Account, p: AgentPolicy, wait: (p: Promise<unknown>) => void): Promise<StoredPolicy> {
  const at = now();
  const json: AgentPolicy = { keys: p.keys, runtimes: p.runtimes, providers: p.providers, maxRunning: p.maxRunning, terminals: p.terminals, terminalTasks: p.terminalTasks, review: p.review, memberMonthlyTokens: p.memberMonthlyTokens };
  await env.DB.prepare("INSERT INTO org_agent_policies (org_id, json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
    .bind(org.id, JSON.stringify(json), me.id, at)
    .run();
  // A site administrator acting for the owners is recorded as such, as on the key audits.
  const asSiteAdmin = !!me.site_admin && (await dir.orgRole(org.id, me.id)) !== "owner";
  wait(dir.audit({ actorId: me.id, actorLogin: me.login, action: "org.agent_policy.update", target: org.login, detail: { ...policyJson({ ...json, updatedBy: null, updatedAt: null }), updated_by: undefined, updated_at: undefined, ...(asSiteAdmin ? { site_admin: true } : {}) } }));
  wait(
    (async () => {
      // Every repository the organization owns, a page at a time.
      for (let after = ""; ; ) {
        const page = (await env.DB.prepare("SELECT id FROM repos WHERE owner_id = ? AND id > ? ORDER BY id LIMIT 500").bind(org.id, after).all<{ id: string }>()).results;
        for (const r of page) await setRepoLimit(env, r.id, p.maxRunning);
        if (page.length < 500) break;
        after = page[page.length - 1]!.id;
      }
    })(),
  );
  return { ...json, updatedBy: me.login, updatedAt: at };
}

const setRepoLimit = (env: Env, repoId: string, n: number | null) =>
  env.PROJECT.get(env.PROJECT.idFromName(repoId))
    .setOrgMaxRunning(n)
    .catch((e: unknown) => console.error("clamping a project's tasks at once failed", e));

/** After a transfer: the repository takes its new owner's limit on tasks at once, or none when a person owns it. */
export async function refreshRepoLimit(env: Env, repo: Repo): Promise<void> {
  await setRepoLimit(env, repo.id, (await repoPolicy(env, repo))?.policy.maxRunning ?? null);
}

// ---------------------------------------------------------------- checks when work starts

const orgName = async (dir: Directory, orgId: string) => (await dir.account(orgId))?.login ?? "the organization";

/** Why the policy refuses a runtime, or the providers a run would use; null when it allows them. */
export function policyRefusal(org: string, p: AgentPolicy, runtime: RuntimeId, providers: Provider[]): string | null {
  if (!p.runtimes.includes(runtime)) return `${org}'s agent policy doesn't allow ${RUNTIMES[runtime].name}`;
  const off = providers.filter((x) => !p.providers.includes(x));
  if (off.length) return `${org}'s agent policy doesn't allow ${off.map((x) => PROVIDERS[x].name).join(" or ")}`;
  return null;
}

/** Whether `person` may spend `orgId`'s key: an active person (never an agent account) who is a member, admin or owner. */
export async function spendsOrgKey(dir: Directory, orgId: string, person: Account | null): Promise<boolean> {
  if (!person || person.kind !== "user" || person.status !== "active") return false;
  return !!(await dir.orgRole(orgId, person.id));
}

export interface Payer {
  /** Whose key pays: the person's id, or the organization's. */
  keyOwner: string;
  providers: Provider[];
  /** The organization's limit on tasks at once, for its repositories. */
  orgMaxRunning: number | null;
}

/**
 * Whose key a run of `person`'s pays, and the providers it gets, under the repository's policy. `fixed` is the key
 * owner a task already has (messages, retries and plan approval keep it); left out, it is decided now. Throws an
 * HttpError saying what to do when nobody's key may pay.
 */
export async function payerFor(env: Env, dir: Directory, repo: Repo, person: Account, runtime: RuntimeId, via: Provider | null, fixed?: string | null): Promise<Payer> {
  const keys = new ModelKeys(env);
  const needs = runtimeNeeds(runtime, via);
  const rp = await repoPolicy(env, repo);
  const personal = async (): Promise<Payer> => {
    const have = await keys.providers(person.id);
    for (const p of needs) if (!have.has(p)) throw new HttpError(422, `${runtimeLabel(runtime, { via })} needs your ${PROVIDERS[p].name} API key: add it in Settings → Model access`);
    let providers = runtime === "custom" ? [...have] : needs;
    if (rp && runtime === "custom") providers = providers.filter((p) => rp.policy.providers.includes(p));
    if (rp && runtime === "custom" && !providers.length) throw new HttpError(403, `${repo.owner_login}'s agent policy allows none of the providers you have a key for`);
    return { keyOwner: person.id, providers, orgMaxRunning: rp?.policy.maxRunning ?? null };
  };
  if (!rp) {
    if (fixed && fixed !== person.id) throw new HttpError(403, "this task was paid for by an organization that no longer owns the repository: start a new task");
    return personal();
  }
  const { orgId, policy } = rp;
  const refusal = policyRefusal(repo.owner_login, policy, runtime, needs);
  if (refusal) throw new HttpError(403, refusal);
  const org = async (): Promise<Payer | null> => {
    if (!(await spendsOrgKey(dir, orgId, person))) return null;
    const have = [...(await keys.providers(orgId))].filter((p) => policy.providers.includes(p));
    const providers = runtime === "custom" ? have : needs.filter((p) => have.includes(p));
    if (!providers.length || (runtime !== "custom" && providers.length < needs.length)) return null;
    return { keyOwner: orgId, providers, orgMaxRunning: policy.maxRunning };
  };
  if (fixed) {
    // A task keeps whose key pays from its start: re-check that it still may.
    if (fixed === person.id) {
      if (policy.keys === "organization") throw new HttpError(403, `${repo.owner_login} now pays for agents in its repositories only with its own keys: start a new task`);
      return personal();
    }
    if (fixed !== orgId) throw new HttpError(403, `this task was paid for by an organization that no longer owns ${repo.owner_login}/${repo.name}: start a new task`);
    if (policy.keys === "personal") throw new HttpError(403, `${repo.owner_login} no longer pays for agents with its keys: start a new task with yours`);
    const o = await org();
    if (!o) throw new HttpError(403, (await spendsOrgKey(dir, orgId, person)) ? `${repo.owner_login} no longer has the ${needs.map((p) => PROVIDERS[p].name).join(" and ")} key this task uses` : `only members of ${repo.owner_login} can run agents on its keys`);
    return o;
  }
  if (policy.keys === "personal") return personal();
  const o = await org();
  if (o) return o;
  if (policy.keys === "organization") {
    if (!(await spendsOrgKey(dir, orgId, person))) throw new HttpError(403, `${repo.owner_login} pays for agents in its repositories with its own keys, which only its members can use`);
    throw new HttpError(422, `${repo.owner_login} pays for agents with its own keys, and has no ${needs.map((p) => PROVIDERS[p].name).join(" and ")} key: an owner can add it on the organization's Settings tab`);
  }
  return personal();
}

/** The policy's word on web terminals in `repo`: null when allowed. */
export async function terminalRefusal(env: Env, repo: Repo, opts: { tasks?: boolean; runtime?: RuntimeId; person?: { dir: Directory; account: Account } }): Promise<string | null> {
  const rp = await repoPolicy(env, repo);
  if (!rp) return null;
  const org = repo.owner_login;
  if (!rp.policy.terminals) return `${org}'s agent policy doesn't allow web terminals`;
  if (opts.tasks && !rp.policy.terminalTasks) return `${org}'s agent policy doesn't allow agent tasks in terminals`;
  // A terminal's task runs on the person's own subscription, with its runtime's provider: the policy's runtimes and providers still hold.
  if (opts.runtime) {
    const refused = policyRefusal(org, rp.policy, opts.runtime, RUNTIMES[opts.runtime].needs);
    if (refused) return refused;
  }
  // Under "only the organization's keys", only its members run agents in its repositories, terminals included.
  if (opts.tasks && opts.person && rp.policy.keys === "organization" && !(await spendsOrgKey(opts.person.dir, repo.owner_id, opts.person.account)))
    return `${org}'s agent policy lets only its members run agent tasks in its repositories`;
  return null;
}

/** The policy's word on agent review in `repo`: null when allowed. */
export async function reviewRefusal(env: Env, repo: Repo): Promise<string | null> {
  const rp = await repoPolicy(env, repo);
  return rp && !rp.policy.review ? `${repo.owner_login}'s agent policy doesn't allow agent review` : null;
}

// ---------------------------------------------------------------- the model proxy's check, every request

/**
 * Whether a run's request may spend `keyOwner`'s key now. Nothing is cached: a member removed, a repository
 * transferred, a policy or key changed applies at the next request. For an organization's key it returns the
 * person's monthly allowance, which the proxy books against.
 */
export async function proxyPayer(
  env: Env,
  dir: Directory,
  run: { repo: Repo; personId: string; keyOwner: string; provider: Provider },
): Promise<{ org: { id: string; login: string; cap: number | null } | null } | { refuse: string }> {
  const { repo, personId, keyOwner, provider } = run;
  const rp = await repoPolicy(env, repo);
  if (keyOwner === personId) {
    if (!rp) return { org: null };
    if (rp.policy.keys === "organization") return { refuse: `${repo.owner_login} now pays for agents in its repositories only with its own keys` };
    if (!rp.policy.providers.includes(provider)) return { refuse: `${repo.owner_login}'s agent policy doesn't allow ${PROVIDERS[provider].name}` };
    return { org: null };
  }
  if (!rp || rp.orgId !== keyOwner) return { refuse: `the organization whose key this task uses no longer owns ${repo.owner_login}/${repo.name}` };
  const { policy } = rp;
  if (policy.keys === "personal") return { refuse: `${repo.owner_login} no longer pays for agents with its keys` };
  if (!policy.providers.includes(provider)) return { refuse: `${repo.owner_login}'s agent policy doesn't allow ${PROVIDERS[provider].name}` };
  const person = await dir.account(personId);
  if (!(await spendsOrgKey(dir, keyOwner, person))) return { refuse: `${person?.login ?? "the person who started this task"} is no longer a member of ${repo.owner_login}, whose key this task uses` };
  return { org: { id: keyOwner, login: repo.owner_login, cap: policy.memberMonthlyTokens } };
}

/** The calendar month (UTC) an organization's allowance counts in, as `2026-10`. */
export const spendMonth = (at = new Date()): string => at.toISOString().slice(0, 7);

/**
 * Book `tokens` (a request's estimate, weighted) against the person's allowance on the organization's keys this
 * month, in one statement: false, booking nothing, when it would go over `cap`. Without a cap it always books, so
 * the month's count is right if an owner sets one later.
 */
export async function bookSpend(env: Env, orgId: string, personId: string, tokens: number, cap: number | null): Promise<boolean> {
  const month = spendMonth();
  if (cap === null) {
    await env.DB.prepare("INSERT INTO org_key_spend (org_id, person_id, month, tokens) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, person_id, month) DO UPDATE SET tokens = tokens + excluded.tokens").bind(orgId, personId, month, tokens).run();
    return true;
  }
  const r = await env.DB.prepare(
    "INSERT INTO org_key_spend (org_id, person_id, month, tokens) SELECT ?1, ?2, ?3, ?4 WHERE ?4 <= ?5 AND ?5 > 0 ON CONFLICT (org_id, person_id, month) DO UPDATE SET tokens = tokens + excluded.tokens WHERE org_key_spend.tokens < ?5 AND org_key_spend.tokens + excluded.tokens <= ?5",
  )
    .bind(orgId, personId, month, tokens, cap)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Settle a booking: `delta` is what the answer used minus what was booked (negative for a refund). */
export async function settleSpend(env: Env, orgId: string, personId: string, delta: number, month = spendMonth()): Promise<void> {
  if (!delta) return;
  await env.DB.prepare("UPDATE org_key_spend SET tokens = MAX(tokens + ?, 0) WHERE org_id = ? AND person_id = ? AND month = ?").bind(delta, orgId, personId, month).run();
}

export interface OrgSpend {
  personId: string;
  login: string | null;
  tokens: number;
}

/** Each person's tokens on the organization's keys this month, most first. */
export async function orgSpend(env: Env, orgId: string, month = spendMonth()): Promise<OrgSpend[]> {
  const r = await env.DB.prepare("SELECT s.person_id, a.login, s.tokens FROM org_key_spend s LEFT JOIN accounts a ON a.id = s.person_id WHERE s.org_id = ? AND s.month = ? ORDER BY s.tokens DESC LIMIT 500")
    .bind(orgId, month)
    .all<{ person_id: string; login: string | null; tokens: number }>();
  return r.results.map((x) => ({ personId: x.person_id, login: x.login, tokens: x.tokens }));
}
