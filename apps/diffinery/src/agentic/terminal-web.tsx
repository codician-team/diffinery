/** @jsxImportSource hono/jsx */
import { blockedBy, killSwitches } from "../lib/killswitch.js";
import type { FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import { csrfToken } from "../web/csrf.js";
import { KCheckbox, KRadio, KSelect } from "../web/kumo.js";
import { Form, Time, act, post, prm, render, repoUrl, statusOf, type WebApp } from "../web/ui.js";
import TERMINAL_JS from "../../build/islands/terminal.js.txt";
import TERMINAL_CSS from "../../build/islands/terminal.css.txt";
import { taskCaller, TaskAccessError } from "./access.js";
import { RUNTIME_VERSIONS } from "./runtimes.js";
import { drivableAgents, projectStub, requirePersonSession, requireTaskReader } from "./tasks.js";
import { endTerminal, MAX_TERMINALS, MAX_TERMINALS_PER_REPO, openTerminal, startTaskInTerminal, TERMINAL_END_TEXT, TERMINAL_IDLE_MS, TERMINAL_MAX_MS, terminalId, terminalsEnabled, Terminals, type TerminalEndReason, type TerminalRow } from "./terminals.js";

/**
 * Web pages for terminals (phase 4): the list and open form on a repository, the terminal page
 * (xterm.js, islands/terminal.ts) and its WebSocket. Only the person who opened a terminal sees it.
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

/** The providers' own terms for signing in with a subscription (plan.md, "what the providers allow"). */
const SUBSCRIPTION_TERMS = [
  { label: "Anthropic's Consumer Terms", url: "https://www.anthropic.com/legal/consumer-terms" },
  { label: "Claude Code's legal and compliance page", url: "https://code.claude.com/docs/en/legal-and-compliance" },
  { label: "OpenAI's Terms of Use", url: "https://openai.com/policies/terms-of-use" },
];

/** What the toolbar buttons type: install the published CLI if it isn't there yet, then start it. */
export const START_CLAUDE = `command -v claude >/dev/null || npm install --global --no-fund --no-audit --loglevel=error @anthropic-ai/claude-code@${RUNTIME_VERSIONS["claude-code"]}; claude`;
export const START_CODEX = `command -v codex >/dev/null || npm install --global --no-fund --no-audit --loglevel=error @openai/codex@${RUNTIME_VERSIONS.codex}; codex login status >/dev/null 2>&1 || codex login --device-auth; codex`;

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
const ASSETS = { js: `/-/terminal/${fnv(TERMINAL_JS)}.js`, css: `/-/terminal/${fnv(TERMINAL_CSS)}.css` };

const STATE: Record<TerminalRow["status"], { label: string; tone: string }> = {
  starting: { label: "Starting", tone: "blue" },
  running: { label: "Open", tone: "green" },
  ended: { label: "Ended", tone: "" },
};

async function forTerminals(c: AppContext): Promise<Loaded> {
  if (c.get("principal").type !== "account") throw new HttpError(401, "sign in required");
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
  requireTaskReader(l);
  return l;
}

const TermsLinks: FC = () => (
  <>
    {SUBSCRIPTION_TERMS.map((x, i) => (
      <>
        {i ? ", " : ""}
        <a href={x.url} rel="noopener noreferrer" target="_blank">
          {x.label}
        </a>
      </>
    ))}
  </>
);

async function listPage(c: AppContext, l: Loaded, error?: string, v: { agent?: string; ref?: string; tasks?: string } = {}) {
  const me = requireAccount(c);
  const base = repoUrl(l.repo);
  const tk = csrfToken(c);
  const terminals = new Terminals(c.env);
  const [mine, agents, branches, termsAt] = await Promise.all([terminals.list(me.id, l.repo.id), drivableAgents(c, me, l), l.stub.refs("refs/heads/"), terminals.termsAt(me.id)]);
  const enabled = terminalsEnabled(c.env);
  const open = mine.filter((t) => t.status !== "ended");
  const agentLogin = new Map(agents.map((a) => [a.id, a.login]));
  return render(
    c,
    { title: `Terminals · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "project" }, status: error ? 422 : undefined, refresh: mine.some((t) => t.status === "starting") ? 5 : undefined },
    <div style="max-width:880px">
      <div class="row mb">
        <h1 class="grow m0">Terminals</h1>
        <a class="btn" href={`${base}/tasks`}>
          Agent tasks
        </a>
      </div>
      <p class="muted">
        A terminal is a sandbox with this repository checked out, in your browser. Sign in there to Claude Code with your Claude Pro or Max plan, or to Codex with your ChatGPT plan{l.repo.visibility === "public" ? " (private repositories only)" : ""}, and work with the agent directly. The sign-in happens in the provider's own flow and stays in that sandbox: Diffinery never sees or keeps it, and it's gone when the terminal ends. See <a href="/docs/agents/terminal">Terminals</a>.
      </p>
      {error ? <div class="flash error">{error}</div> : null}
      {!enabled ? <div class="flash info">Terminals are switched off on this Diffinery.</div> : null}
      {mine.length ? (
        <div class="box mb">
          <ul class="list">
            {mine.map((t) => (
              <li>
                <div class="grow">
                  <a href={`${base}/terminals/${t.id}`}>
                    <b>Terminal on {t.ref}</b>
                  </a>{" "}
                  <span class={`badge ${STATE[t.status].tone}`}>{STATE[t.status].label}</span>
                  <div class="muted small">
                    as {agentLogin.get(t.agent_id) ?? "an agent"} · opened <Time at={t.created_at} />
                    {t.status === "ended" && t.end_reason ? <> · {TERMINAL_END_TEXT[t.end_reason as TerminalEndReason] ?? t.end_reason}</> : null}
                  </div>
                </div>
                {t.status !== "ended" ? (
                  <Form action={`${base}/terminals/${t.id}/end`} t={tk} class="inline" confirm="End this terminal? Its sandbox stops, and anything in it, including any sign-in, is gone.">
                    <button class="btn sm danger">End</button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {enabled && !l.repo.archived ? (
        <Form action={`${base}/terminals`} t={tk} class="box">
          <div class="head">
            <h2>Open a terminal</h2>
          </div>
          <div class="body">
            {!agents.length ? (
              <div class="flash info">
                You don't have an agent with write access here yet. <a href="/settings/agents">Create an agent</a>, then give it write access to this repository (or let it inherit yours).
              </div>
            ) : null}
            <div class="row" style="align-items:flex-start;flex-wrap:wrap">
              <div class="field grow">
                <label for="agent">Agent</label>
                <KSelect id="agent" name="agent" block label="Agent" value={v.agent ?? agents[0]?.login} options={agents.map((a) => ({ value: a.login, label: a.name ? `${a.login} (${a.name})` : a.login }))} placeholder="Choose an agent" />
                <div class="hint">The terminal pushes and opens pull requests as this agent, under the same rules as its tasks.</div>
              </div>
              <div class="field grow">
                <label for="ref">Branch</label>
                <KSelect id="ref" name="ref" block label="Branch" value={v.ref ?? l.repo.default_branch} options={branches.slice(0, 500).map((b) => ({ value: b.name.slice("refs/heads/".length), label: b.name.slice("refs/heads/".length) }))} />
              </div>
            </div>
            <div class="field">
              <KCheckbox name="tasks" label="Will run agent tasks" checked={v.tasks === "1"} />
              <div class="hint">
                Lets you give it agent tasks that run with the Claude Code or Codex you sign in to there, in a jail with only that sign-in and limited internet. <a href="/docs/agents/terminal#give-it-a-task">How tasks run</a>. Without it, the terminal never runs one.
              </div>
            </div>
            {termsAt ? (
              <p class="muted small">
                You accepted the notice about your own provider accounts <Time at={termsAt} />.
              </p>
            ) : (
              <div class="field">
                <KCheckbox
                  name="accept"
                  label={
                    <>
                      I use Claude Code and Codex in my terminals with my own Anthropic or OpenAI account, under that provider's terms (<TermsLinks />
                      ). Usage is billed to my account. Diffinery only provides the sandbox, and never sees or keeps my sign-in. A task I give a terminal I opened for tasks runs the agent without asking before each step, in a jail in that terminal's sandbox, with my sign-in. Content in the repository can steer it: it can read my sign-in, and send it or the repository's code to an AI provider or package registry it can reach, under someone else's account. So I give tasks only in repositories whose contents I trust.
                    </>
                  }
                />
              </div>
            )}
            <p class="muted small">
              A terminal ends when you end it, after {TERMINAL_IDLE_MS / 60_000} minutes with no tab attached, or after {TERMINAL_MAX_MS / 3600_000} hours. You can have {MAX_TERMINALS_PER_REPO} open in a repository and {MAX_TERMINALS} in all{open.length ? `; ${open.length} open here now` : ""}.
            </p>
            <button class="btn primary" disabled={!agents.length}>
              Open a terminal
            </button>
          </div>
        </Form>
      ) : null}
    </div>,
  );
}

async function terminalPage(c: AppContext, l: Loaded, t: TerminalRow) {
  const base = repoUrl(l.repo);
  const tk = csrfToken(c);
  const agent = await c.get("dir").account(t.agent_id);
  const endsAt = t.started_at ? new Date(Date.parse(t.started_at) + TERMINAL_MAX_MS).toISOString() : null;
  const running = t.status === "running";
  const current = running ? await projectStub(c.env, l.repo.id).terminalTask(t.id) : null;
  return render(
    c,
    {
      title: `Terminal · ${l.repo.owner_login}/${l.repo.name}`,
      repo: { repo: l.repo, caller: l.caller, tab: "project" },
      wide: true,
      refresh: t.status === "starting" ? 3 : undefined,
      head: running ? <link rel="stylesheet" href={ASSETS.css} /> : undefined,
      scriptSrc: running ? [ASSETS.js] : undefined,
    },
    <div>
      <div class="row mb" style="flex-wrap:wrap;gap:8px">
        <h1 class="grow m0" style="font-size:20px">
          <a href={`${base}/terminals`}>Terminals</a> / {t.ref}
        </h1>
        {running ? (
          <>
            <button type="button" class="btn sm" data-terminal-type={START_CLAUDE}>
              Start Claude Code
            </button>
            {l.repo.visibility !== "public" ? (
              <button type="button" class="btn sm" data-terminal-type={START_CODEX}>
                Start Codex
              </button>
            ) : null}
          </>
        ) : null}
        {t.status !== "ended" ? (
          <Form action={`${base}/terminals/${t.id}/end`} t={tk} class="inline" confirm="End this terminal? Its sandbox stops, and anything in it, including any sign-in, is gone.">
            <button class="btn sm danger">End</button>
          </Form>
        ) : null}
      </div>
      <div class="muted small mb">
        <span class={`badge ${STATE[t.status].tone}`}>{STATE[t.status].label}</span> as {agent?.login ?? "an agent"}
        {endsAt ? (
          <>
            {" "}
            · ends by <time datetime={endsAt} title={endsAt}>{new Date(endsAt).toUTCString().slice(17, 22)} UTC</time> at the latest
          </>
        ) : null}
        {running ? (
          <>
            {" "}
            · <span id="dfy-terminal-status" class="term-status" aria-live="polite"></span>
          </>
        ) : null}
      </div>
      {t.status === "starting" ? <div class="box"><div class="body muted">Starting the sandbox and checking out {t.ref}…</div></div> : null}
      {t.status === "ended" ? (
        <div class="box">
          <div class="body">
            This terminal ended <Time at={t.ended_at} />. {t.end_reason ? (TERMINAL_END_TEXT[t.end_reason as TerminalEndReason] ?? "") : ""} Its sandbox is gone, with anything that was in it. <a href={`${base}/terminals`}>Open another</a>.
          </div>
        </div>
      ) : null}
      {running ? (
        <>
          <div id="dfy-terminal" class="term" data-socket={`${base}/terminals/${t.id}/socket`}></div>
          <div class="box mt">
            <div class="head">
              <h3>Give it a task</h3>
            </div>
            <div class="body">
              {!t.tasks ? (
                <p class="m0 muted">
                  This terminal was opened without agent tasks, so it never runs one. To give tasks to the Claude Code or Codex you sign in to, <a href={`${base}/terminals`}>open a terminal</a> with <b>Will run agent tasks</b>.
                </p>
              ) : current ? (
                <p class="m0">
                  <a href={`${base}/tasks/${current}`}>Task #{current}</a> is running in this terminal. One task at a time: it ends when the task does, or when you stop it.
                </p>
              ) : (
                <Form action={`${base}/terminals/${t.id}/task`} t={tk}>
                  <div class="field">
                    <label for="goal">Goal</label>
                    <textarea id="goal" name="goal" rows={3} required maxlength={20000} placeholder="Fix the Contact sales link on the pricing page so it goes to /contact, and add a test."></textarea>
                  </div>
                  <div class="field">
                    <KRadio
                      name="runtime"
                      value="claude-code"
                      orientation="horizontal"
                      label="Runs with"
                      items={[{ value: "claude-code", label: "Claude Code" }, ...(l.repo.visibility !== "public" ? [{ value: "codex", label: "Codex" }] : [])]}
                    />
                  </div>
                  <p class="muted small">
                    It runs here with the one you're signed in to, on your own subscription, as {agent?.login ?? "your agent"}, in a clone of {t.ref} of its own (yours is left alone), jailed: it sees only that clone and your sign-in, and reaches only Claude, ChatGPT and package registries. Diffinery pushes its work to a new branch and opens a pull request. Its checks don't start fix runs by themselves. <a href="/docs/agents/terminal#what-a-task-can-reach">What a task can reach</a>
                  </p>
                  <button class="btn primary">Run with my subscription</button>
                </Form>
              )}
            </div>
          </div>
          <details class="box mt">
            <summary class="body">Signing in</summary>
            <div class="body muted small">
              <p>
                <b>Claude Code</b>: click <b>Start Claude Code</b>, then type <code>/login</code> and choose your Claude subscription. Open the link it shows, sign in with Anthropic, and paste the code back here. You can also use your own API key: <code>export ANTHROPIC_API_KEY=…</code> before starting it.
              </p>
              {l.repo.visibility !== "public" ? (
                <p>
                  <b>Codex</b>: click <b>Start Codex</b>. It runs <code>codex login --device-auth</code>: open the link it shows, sign in with OpenAI and enter the code. A ChatGPT workspace admin may have to allow device codes.
                </p>
              ) : (
                <p>
                  <b>Codex</b>: OpenAI allows signing in with a ChatGPT plan only on private repositories, so this public repository's terminal doesn't offer it. You can use an OpenAI API key instead.
                </p>
              )}
              <p>The sign-in stays in this sandbox and ends with it. Your work is pushed as {agent?.login ?? "your agent"}, so its pull requests need a person's approval like any agent's.</p>
            </div>
          </details>
        </>
      ) : null}
    </div>,
  );
}

export function registerTerminals(web: WebApp): void {
  web.get("/-/terminal/:file", (c) => {
    const headers = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };
    if (c.req.path === ASSETS.js) return c.body(TERMINAL_JS, 200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
    if (c.req.path === ASSETS.css) return c.body(TERMINAL_CSS, 200, { ...headers, "content-type": "text/css; charset=utf-8" });
    return c.text("Not found", 404);
  });

  web.get("/:owner/:repo/terminals", async (c) => listPage(c, await forTerminals(c)));

  post(web, "/:owner/:repo/terminals", async (c, f) => {
    const l = await forTerminals(c);
    const v = { agent: f.s("agent"), ref: f.s("ref"), tasks: f.all("tasks").length > 0 ? "1" : undefined };
    try {
      const t = await openTerminal(c, l, { agent: v.agent, ref: v.ref, accept: f.all("accept").length > 0, tasks: !!v.tasks });
      return c.redirect(`${repoUrl(l.repo)}/terminals/${t.id}`, 303);
    } catch (e) {
      const st = statusOf(e);
      if (st.status >= 500) throw e;
      return listPage(c, l, st.message, v);
    }
  });

  web.get("/:owner/:repo/terminals/:id", async (c) => {
    const l = await forTerminals(c);
    const t = await new Terminals(c.env).mine(terminalId(c.req.param("id")), requireAccount(c), l.repo);
    return terminalPage(c, l, t);
  });

  // Phase 4b: only the opener's own click here starts a task in their terminal.
  post(web, "/:owner/:repo/terminals/:id/task", async (c, f) => {
    const l = await forTerminals(c);
    const id = terminalId(c.req.param("id"));
    return act(
      c,
      `${repoUrl(l.repo)}/terminals/${encodeURIComponent(id)}`,
      async () => `${repoUrl(l.repo)}/tasks/${(await startTaskInTerminal(c, l, id, { goal: f.s("goal"), runtime: f.s("runtime") })).number}`,
      "The task is running in your terminal.",
    );
  });

  post(web, "/:owner/:repo/terminals/:id/end", async (c) => {
    const l = await forTerminals(c);
    const me = requireAccount(c);
    const t = await new Terminals(c.env).mine(terminalId(c.req.param("id")), me, l.repo);
    return act(c, `${repoUrl(l.repo)}/terminals/${t.id}`, async () => endTerminal(c.env, c.get("dir"), t, "person", me), "The terminal ended.");
  });

  // The terminal's WebSocket: only its opener, in a browser session on this site, while it runs.
  web.get("/:owner/:repo/terminals/:id/socket", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.text("expected a WebSocket", 426);
    if (c.req.header("origin") !== new URL(c.env.PUBLIC_URL).origin) return c.text("forbidden", 403);
    const me = requirePersonSession(c);
    const l = await forTerminals(c);
    const t = await new Terminals(c.env).mine(terminalId(c.req.param("id")), me, l.repo);
    if (t.status !== "running" || !t.sandbox_id || !terminalsEnabled(c.env)) return c.text("this terminal isn't running", 409);
    // A kill switch (lib/killswitch.ts) stops sandboxes here: no attaching until it's lifted.
    const block = blockedBy(await killSwitches(c.env, l.repo.id), "sandbox");
    if (block) return c.text(block, 403);
    const dir = c.get("dir");
    const agent = await dir.account(t.agent_id);
    try {
      if (!agent) throw new TaskAccessError("the agent is gone");
      await taskCaller(dir, me, agent, l.repo);
    } catch (e) {
      if (e instanceof TaskAccessError) return c.text(e.message, 403);
      throw e;
    }
    const q = new URL(c.req.url).searchParams;
    const size = (k: string) => {
      const n = Number(q.get(k));
      return Number.isFinite(n) && n >= 1 ? String(Math.min(1000, Math.floor(n))) : "";
    };
    return c.env.SANDBOX.get(c.env.SANDBOX.idFromName(t.sandbox_id)).fetch(new Request(`http://sandbox/pty?cols=${size("cols")}&rows=${size("rows")}`, c.req.raw));
  });
}
