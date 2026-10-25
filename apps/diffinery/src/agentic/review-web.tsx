/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { atLeast } from "../repo/types.js";
import { csrfToken } from "../web/csrf.js";
import { KCheckbox, KRadio, KSelect } from "../web/kumo.js";
import { page as settingsPage } from "../web/repo-settings.js";
import { Form, Time, act, post, prm, repoUrl, statusOf, type WebApp } from "../web/ui.js";
import { ModelKeys, PROVIDERS, type Provider } from "./keys.js";
import { AUTHORS, findingId, MAX_AUTOFIXES, PR_DAILY_AUTOMATIC, PR_DAILY_REVIEWS, REPO_DAILY_DEFAULT, REPO_DAILY_MAX, REVIEW_MAX_MODEL_CALLS, REVIEW_TIMEOUT_MS, REVIEW_TOKENS_DEFAULT, REVIEW_TOKENS_MAX, REVIEW_TOKENS_MIN, TRIGGERS, type ReviewSettings } from "./review.js";
import { askForReview, reviewSettings, saveReviewSettings } from "./reviews.js";
import { parseRuntimeChoice, runtimeChoices, runtimeLabel } from "./runtimes.js";
import { drivableAgents } from "./tasks.js";
import { OpenRouterModel } from "./tasks-web.js";

/**
 * Web pages for agent code review: Settings → Agent review, the PR page's
 * "Request agent review" button and the "Fix it" link on findings.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

/** What the PR page needs: set when reviews are on and the viewer is a person with write access. */
export interface PullReviewCtx {
  agent: string;
}

export async function pullReviewCtx(c: AppContext, l: Loaded): Promise<PullReviewCtx | null> {
  if (l.caller.kind !== "user" || !atLeast(l.caller.role, "write") || l.repo.archived) return null;
  const s = await reviewSettings(c.env, l.repo.id).catch(() => null);
  return s?.enabled ? { agent: s.agent.login } : null;
}

/** The Reviewers sidebar's button. */
export const RequestAgentReview: FC<{ c: AppContext; l: Loaded; pr: number; ctx: PullReviewCtx }> = ({ c, l, pr, ctx }) => (
  <Form action={`${repoUrl(l.repo)}/pull/${pr}/agent-review`} t={csrfToken(c)} style="margin-top:8px">
    <button class="btn sm block" title={`Ask ${ctx.agent} to review this pull request now`}>
      Request agent review
    </button>
  </Form>
);

/** "Fix it" under an agent review finding, for people with write access. */
export const FixIt: FC<{ l: Loaded; pr: number; comment: { id: string; body: string; author: { kind: string } } }> = ({ l, pr, comment }) =>
  comment.author.kind === "agent" && findingId(comment.body) && atLeast(l.caller.role, "write") && l.caller.kind === "user" && !l.repo.archived ? (
    <a class="btn sm" href={`${repoUrl(l.repo)}/tasks/new?pull=${pr}&finding=${encodeURIComponent(comment.id)}`} title="Start an agent task that fixes this on the pull request's branch">
      Fix it
    </a>
  ) : null;

async function settingsForm(c: AppContext, l: Loaded, error?: string, values?: Partial<Record<string, string>>) {
  const me = requireAccount(c);
  const base = repoUrl(l.repo);
  const [current, agents, keys] = await Promise.all([reviewSettings(c.env, l.repo.id), drivableAgents(c, me, l), new ModelKeys(c.env).providers(me.id)]);
  const v = (k: string, d: string) => values?.[k] ?? d;
  const s: Partial<ReviewSettings> = current ?? {};
  const runtimes = runtimeChoices(keys, Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.name])) as Record<Provider, string>);
  const currentChoice = s.runtime ? (s.via ? `${s.runtime}+${s.via}` : s.runtime) : undefined;
  const youPay = !current || current.person.id === me.id;
  return settingsPage(
    c,
    l,
    "agent-review",
    <>
      <h1>Agent review</h1>
      <p class="muted">
        One of your agents reviews pull requests for bugs, security issues and logic errors, like Cursor's Bugbot. It reads the changes in a read-only sandbox, then posts its findings as review comments, with an <b>Agent review</b> check that fails when a finding is blocking (branch protection can require it). Rules in <code>REVIEW.md</code> or <code>.cursor/BUGBOT.md</code> files apply. See <a href="/docs/agents/review">Agent review</a>.
      </p>
      {error ? <div class="flash error">{error}</div> : null}
      {current ? (
        <div class={`flash ${current.enabled ? "info" : ""}`}>
          {current.enabled ? (
            <>
              Agent review is <b>on</b>: {current.agent.login} reviews with {runtimeLabel(current.runtime, current)}, using <b>{current.person.login}</b>'s model key (since <Time at={current.optedInAt} />).
            </>
          ) : (
            <>Agent review is <b>off</b>.</>
          )}
        </div>
      ) : null}
      <Form action={`${base}/settings/agent-review`} t={csrfToken(c)} class="box">
        <div class="head">
          <h2>{current?.enabled ? "Change agent review" : "Turn on agent review"}</h2>
        </div>
        <div class="body fbody">
          {!agents.length ? (
            <div class="flash info">
              You don't have an agent with write access here yet. <a href="/settings/agents">Create an agent</a>, then give it write access to this repository.
            </div>
          ) : null}
          <div class="field">
            <label for="agent">Agent</label>
            <KSelect id="agent" name="agent" block label="Agent" value={v("agent", s.agent && agents.some((a) => a.id === s.agent!.id) ? s.agent.login : (agents[0]?.login ?? ""))} options={agents.map((a) => ({ value: a.login, label: a.name ? `${a.login} (${a.name})` : a.login }))} placeholder="Choose an agent" />
          </div>
          <div class="field">
            <label>Runtime</label>
            <KRadio name="runtime" label="Runtime" value={v("runtime", currentChoice ?? runtimes.find((r) => !r.disabled)?.value ?? "custom")} items={runtimes} />
          </div>
          <OpenRouterModel value={v("model", s.model ?? "")} />
          <div class="field">
            <label for="command">
              Command <span class="faint">(custom runtime only)</span>
            </label>
            <input id="command" name="command" type="text" maxlength={2000} value={v("command", s.command ?? "")} placeholder='my-reviewer --prompt "$DIFFINERY_TASK_PROMPT"' />
            <div class="hint">Gets the review instructions in $DIFFINERY_TASK_PROMPT and must end its output with the findings block they describe.</div>
          </div>
          <div class="field">
            <label>When to review</label>
            <KRadio name="trigger" label="When to review" value={v("trigger", s.trigger ?? "push")} items={Object.entries(TRIGGERS).map(([value, label]) => ({ value, label }))} />
            <div class="hint">People with write access can always ask: the Request agent review button, a comment starting with @{s.agent?.login ?? "agent"} review, or requesting the agent as a reviewer.</div>
          </div>
          <div class="field">
            <label>Which pull requests</label>
            <KRadio name="authors" label="Which pull requests" value={v("authors", s.authors ?? "all")} items={Object.entries(AUTHORS).map(([value, label]) => ({ value, label }))} />
          </div>
          <div class="fchecks">
            <KCheckbox name="drafts" checked={v("drafts", s.drafts ? "1" : "") === "1"} label="Review draft pull requests too" />
            <KCheckbox
              name="autofix"
              checked={v("autofix", s.autofix ? "1" : "") === "1"}
              label="Autofix"
              description={<>When a review finds blocking problems, start an agent task that fixes them on the pull request's branch, at most {MAX_AUTOFIXES} times per pull request.</>}
            />
          </div>
          <div class="fgrid">
            <div class="field">
              <label for="daily_limit">Daily limit</label>
              <input id="daily_limit" name="daily_limit" type="number" min={1} max={REPO_DAILY_MAX} step={1} value={v("daily_limit", String(s.dailyLimit ?? REPO_DAILY_DEFAULT))} />
              <div class="hint">The most reviews and autofix runs this repository starts in 24 hours. When it is reached, pull requests get an action-required check instead of a review, autofix waits, and you get an email. Each pull request also gets at most {PR_DAILY_AUTOMATIC} automatic reviews and {PR_DAILY_REVIEWS} in all a day.</div>
            </div>
            <div class="field">
              <label for="tokens_per_review">Tokens per review</label>
              <input id="tokens_per_review" name="tokens_per_review" type="number" min={REVIEW_TOKENS_MIN} max={REVIEW_TOKENS_MAX} step={1} value={v("tokens_per_review", String(s.tokensPerReview ?? REVIEW_TOKENS_DEFAULT))} />
              <div class="hint">
                A review stops when its next model request could take it past this many tokens (cache reads count as a tenth), after {REVIEW_MAX_MODEL_CALLS} model requests, or after {REVIEW_TIMEOUT_MS / 60_000} minutes, whichever comes first. Diffinery books the most each request may cost before sending it, then counts the tokens your provider reports.
              </div>
            </div>
          </div>
          <div class="flash info">
            Every review on this repository, automatic or asked for by anyone with write access, runs with <b>your</b> model key{youPay ? "" : `, instead of ${current!.person.login}'s`}. Anything the agent reads, including code in pull requests, can try to trick it ("prompt injection"); its sandbox is read-only, but it can use your model access while a review runs. Use a dedicated key with a spending limit.
          </div>
          <div class="fchecks">
            <KCheckbox name="accept" label="Agent reviews on this repository, including ones other people ask for, use my model key" />
          </div>
          <div class="factions">
            <button class="btn primary" disabled={!agents.length}>
              {current?.enabled ? "Save" : "Turn on agent review"}
            </button>
          </div>
        </div>
      </Form>
      {current?.enabled ? (
        <Form action={`${base}/settings/agent-review/off`} t={csrfToken(c)} class="box" confirm="Turn off agent review? Reviews already running finish.">
          <div class="body row">
            <div class="grow muted small">Turning it off stops new reviews. Findings already posted stay on their pull requests.</div>
            <button class="btn danger">Turn off</button>
          </div>
        </Form>
      ) : null}
    </>,
    error ? 422 : undefined,
  );
}

export function registerReviews(web: WebApp): void {
  const admin = (c: AppContext) => loadRepo(c, prm(c, "owner"), prm(c, "repo"), "admin");

  web.get("/:owner/:repo/settings/agent-review", async (c) => settingsForm(c, await admin(c)));

  post(web, "/:owner/:repo/settings/agent-review", async (c, f) => {
    const l = await admin(c);
    const values = { agent: f.s("agent"), runtime: f.s("runtime") || "claude-code", model: f.s("model"), command: f.s("command"), trigger: f.s("trigger") || "push", authors: f.s("authors") || "all", drafts: f.all("drafts").length ? "1" : "", autofix: f.all("autofix").length ? "1" : "", daily_limit: f.s("daily_limit"), tokens_per_review: f.s("tokens_per_review") };
    try {
      const { runtime, provider } = parseRuntimeChoice(values.runtime);
      const s = await saveReviewSettings(c, l, { ...values, runtime, provider, model: provider ? values.model : undefined, drafts: !!values.drafts, autofix: !!values.autofix, accept: f.all("accept").length > 0 });
      const me = requireAccount(c);
      c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "review.settings", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { enabled: true, agent: s?.agent.login, runtime: s?.runtime, provider: s?.via ?? undefined, model: s?.model ?? undefined, trigger: s?.trigger, autofix: s?.autofix, daily_limit: s?.dailyLimit, tokens_per_review: s?.tokensPerReview } }));
    } catch (e) {
      const st = statusOf(e);
      if (st.status >= 500) throw e;
      return settingsForm(c, l, st.message, values);
    }
    return act(c, `${repoUrl(l.repo)}/settings/agent-review`, async () => {}, "Agent review is on.");
  });

  post(web, "/:owner/:repo/settings/agent-review/off", async (c) => {
    const l = await admin(c);
    return act(
      c,
      `${repoUrl(l.repo)}/settings/agent-review`,
      async () => {
        await saveReviewSettings(c, l, { enabled: false });
        const me = requireAccount(c);
        c.executionCtx.waitUntil(c.get("dir").audit({ actorId: me.id, actorLogin: me.login, action: "review.settings", target: `${l.repo.owner_login}/${l.repo.name}`, detail: { enabled: false } }));
      },
      "Agent review is off.",
    );
  });

  post(web, "/:owner/:repo/pull/:number/agent-review", async (c) => {
    const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "write");
    const n = Number(c.req.param("number"));
    return act(
      c,
      `${repoUrl(l.repo)}/pull/${n}`,
      async () => {
        await askForReview(c, l, n);
      },
      "Agent review requested. The result appears here and in the Agent review check.",
    );
  });
}
