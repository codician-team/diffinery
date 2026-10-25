/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { requireAccount, type AppContext } from "../auth/principal.js";
import { loadRepo } from "../http/common.js";
import { HttpError } from "../lib/util.js";
import { atLeast } from "../repo/types.js";
import { csrfToken } from "../web/csrf.js";
import { page as settingsPage } from "../web/repo-settings.js";
import { KCheckbox, KRadio, KSelect } from "../web/kumo.js";
import { Form, Markdown, Time, act, flash, post, prm, render, repoUrl, statusOf, type WebApp } from "../web/ui.js";
import { COORDINATOR_TOKENS_DEFAULT, TASK_TOKENS_DEFAULT, TASKS_PER_DAY, TASKS_PER_RUN, TOKENS_MAX, TOKENS_MIN, COORDINATOR_TIMEOUT_MS, type CoordinatorSettings } from "./coordinator.js";
import { ModelKeys, PROVIDERS, type Provider } from "./keys.js";
import { BOARD, BOARD_TEXT, lineDiff, PLAN_FIRST, MAX_INSTRUCTIONS, MAX_MEMORY, MAX_POST, MAX_RUNNING_MAX, MAX_RUNNING_MIN, type BoardState, type MemoryRow, type PostRow } from "./project.js";
import type { TaskRow } from "./ProjectDO.js";
import { handlePost, loadBoard, postToProject, saveCoordinator, saveMemory, saveProjectSettings, type Handled } from "./projects.js";
import { parseRuntimeChoice, runtimeChoices, runtimeLabel } from "./runtimes.js";
import { drivableAgents, projectStub, requireTaskReader } from "./tasks.js";
import { terminalsEnabled } from "./terminals.js";
import { OpenRouterModel, TaskBadge } from "./tasks-web.js";

/**
 * The Project tab (phase 3): a repository's task board, its conversation and
 * its memory, and Settings → Project (instructions every task carries, and how
 * many tasks run at once).
 */

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

/** Done and idle tasks pile up: the board shows the latest of them. */
const SETTLED_SHOWN = 8;
/** Conversation lines the Project tab shows. */
const POSTS_SHOWN = 100;

async function forProject(c: AppContext): Promise<Loaded> {
  if (c.get("principal").type !== "account") throw new HttpError(401, "sign in required");
  const l = await loadRepo(c, prm(c, "owner"), prm(c, "repo"), "read");
  requireTaskReader(l);
  return l;
}

const BoardTask: FC<{ base: string; t: TaskRow }> = ({ base, t }) => (
  <li>
    <div class="grow">
      <a href={`${base}/tasks/${t.number}`}>
        <b>{t.title}</b>
      </a>{" "}
      <TaskBadge state={t.state} />
      <div class="muted small">
        #{t.number} · {runtimeLabel(t.runtime, t)} as <a href={`/${t.agent_login}`}>{t.agent_login}</a> · {t.person_login}
        {t.pr_number ? (
          <>
            {" "}
            · <a href={`${base}/pull/${t.pr_number}`}>#{t.pr_number}</a>
          </>
        ) : null}
      </div>
    </div>
    <span class="muted small">
      <Time at={t.updated_at} />
    </span>
  </li>
);

const BoardColumn: FC<{ base: string; state: BoardState; tasks: TaskRow[] }> = ({ base, state, tasks }) => {
  const text = BOARD_TEXT[state];
  const settled = state === "done" || state === "idle";
  const shown = settled ? tasks.slice(0, SETTLED_SHOWN) : tasks;
  return (
    <div class="box" id={`board-${state}`}>
      <div class="head">
        <h2>
          {text.label} <span class={`badge ${text.tone}`}>{tasks.length}</span>
        </h2>
        <span class="muted small">{text.hint}</span>
      </div>
      <ul class="list">
        {shown.map((t) => (
          <BoardTask base={base} t={t} />
        ))}
      </ul>
      {shown.length < tasks.length ? (
        <div class="body muted small">
          And {tasks.length - shown.length} more in <a href={`${base}/tasks`}>all tasks</a>.
        </div>
      ) : null}
    </div>
  );
};

/** A coordinator's memory change, as its event shows it: the diff from the version before, when both are kept. */
type MemoryChange = { before: MemoryRow | null; after: MemoryRow };

const PostView: FC<{ base: string; p: PostRow; canStart: boolean; canHandle: boolean; tk: string; change?: MemoryChange }> = ({ base, p, canStart, canHandle, tk, change }) =>
  p.kind === "event" ? (
    <div id={`post-${p.n}`}>
      <div class="event">
        <span class="grow">{p.task ? <a href={`${base}/tasks/${p.task}`}>{p.body}</a> : p.body}</span>
        <span class="faint small">
          <Time at={p.at} />
        </span>
      </div>
      {change ? (
        <details class="box">
          <summary class="head">
            <span class="grow">The change to the memory</span>
            {change.before ? (
              <a class="btn sm" href={`${base}/project/memory?version=${change.before.n}`} title="Restore the memory as it was before this change">
                Undo
              </a>
            ) : null}
          </summary>
          <div class="body">
            <Diff from={change.before?.body ?? ""} to={change.after.body} />
          </div>
        </details>
      ) : null}
    </div>
  ) : (
    <div class="box" id={`post-${p.n}`}>
      <div class="head">
        <span>
          <a href={`/${p.author_login}`}>
            <b>{p.author_login}</b>
          </a>{" "}
          {p.kind === "coordinator" ? <span class="badge purple">Coordinator</span> : null}{" "}
          <span class="muted small">
            <Time at={p.at} />
            {p.kind === "coordinator" && p.task ? (
              <>
                {" "}
                · <a href={`${base}/tasks/${p.task}`}>run log</a>
              </>
            ) : null}
            {p.kind === "person" && p.handled_by ? (
              <>
                {" "}
                · <a href={`${base}/tasks/${p.handled_by}`}>handled by a coordinator</a>
              </>
            ) : null}
          </span>
        </span>
        {p.kind === "person" ? (
          <span class="row" style="gap:6px">
            {canHandle && !p.handled_by ? (
              <Form action={`${base}/project/posts/${p.n}/handle`} t={tk} class="inline">
                <button class="btn sm" title="Hand this post to your coordinator, on your model key">
                  Handle this
                </button>
              </Form>
            ) : null}
            {canStart ? (
              <a class="btn sm" href={`${base}/tasks/new?post=${p.n}`} title="Start an agent task with this message as its goal">
                Start a task
              </a>
            ) : null}
          </span>
        ) : null}
      </div>
      <div class="body">
        <Markdown text={p.body} />
      </div>
    </div>
  );

async function projectPage(c: AppContext, l: Loaded, error?: string, draft?: string) {
  const base = repoUrl(l.repo);
  const tk = csrfToken(c);
  const me = requireAccount(c);
  const stub = projectStub(c.env, l.repo.id);
  const [board, posts, coordinators] = await Promise.all([loadBoard(c, l), stub.posts(0, POSTS_SHOWN), stub.coordinators()]);
  const mine = coordinators.find((x) => x.person.id === me.id) ?? null;
  const others = coordinators.filter((x) => x !== mine);
  // The memory changes coordinators made, with the version before each, for their diffs.
  const changes = new Map<number, MemoryChange>();
  for (const p of posts.filter((x) => x.memory_version).slice(-10)) {
    const [after, before] = await Promise.all([stub.memoryVersion(p.memory_version!), stub.memoryVersion(p.memory_version! - 1)]);
    if (after) changes.set(p.n, { after, before });
  }
  const writable = !l.repo.archived;
  const admin = atLeast(l.caller.role, "admin");
  const busy = board.columns.working.length + board.columns.queued.length > 0;
  const empty = BOARD.every((s) => !board.columns[s].length);
  return render(
    c,
    { title: `Project · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "project" }, status: error ? 422 : undefined, refresh: busy && !error ? 15 : undefined },
    <div class="grid">
      <div>
        <div class="row mb">
          <h1 class="grow m0">Project</h1>
          <a class="btn" href={`${base}/tasks`}>
            All tasks
          </a>
          {writable && terminalsEnabled(c.env) ? (
            <a class="btn" href={`${base}/terminals`}>
              Terminals
            </a>
          ) : null}
          {writable ? (
            <a class="btn primary" href={`${base}/tasks/new`}>
              New task
            </a>
          ) : null}
        </div>
        {empty ? (
          <div class="box">
            <div class="empty">No agent tasks yet. Give one of your agents a goal; it works in a sandbox and opens a pull request for review. Tasks show here by where they stand.</div>
          </div>
        ) : (
          BOARD.filter((s) => board.columns[s].length).map((s) => <BoardColumn base={base} state={s} tasks={board.columns[s]} />)
        )}
        <h2 class="mt" id="conversation">
          Conversation
        </h2>
        <div class="timeline">
          {posts.length ? (
            posts.map((p) => <PostView base={base} p={p} canStart={writable} canHandle={writable && !!mine} tk={tk} change={changes.get(p.n)} />)
          ) : (
            <p class="muted">Nothing here yet. Post an idea or a plan; tasks add a line when they start, open a pull request, fail or stop.</p>
          )}
        </div>
        {error ? <div class="flash error">{error}</div> : null}
        {writable ? (
          <Form action={`${base}/project/posts`} t={tk} class="box">
            <div class="body">
              <div class="field">
                <label for="body">Post to the project</label>
                <textarea id="body" name="body" rows={4} required maxlength={MAX_POST} placeholder="An idea, a plan or a note for the people here. Markdown works.">
                  {draft ?? ""}
                </textarea>
              </div>
              {mine ? (
                <div class="field">
                  <KCheckbox name="coordinator" checked label={<>Hand this to my coordinator ({mine.agent.login}, on my model key)</>} />
                </div>
              ) : (
                <p class="muted small">
                  <a href={`${base}/project/coordinator`}>Set up your coordinator</a> to have an agent plan your posts into tasks.
                </p>
              )}
              <button class="btn primary">Post</button>
            </div>
          </Form>
        ) : null}
      </div>
      <aside class="side">
        <section>
          <div class="row">
            <h3 class="grow">Your coordinator</h3>
            {writable ? (
              <a class="small" href={`${base}/project/coordinator`}>
                {mine ? "Change" : "Set up"}
              </a>
            ) : null}
          </div>
          {mine ? (
            <p class="muted small">
              <b>{mine.agent.login}</b> handles your posts with {runtimeLabel(mine.runtime, mine)}, on your model key. It can start up to {TASKS_PER_RUN} tasks per post and {TASKS_PER_DAY} a day.
            </p>
          ) : (
            <p class="muted small">An agent that reads your posts, splits the work into tasks, and keeps the memory, on your own model key.</p>
          )}
        </section>
        {others.length ? (
          <section id="coordinators">
            <h3>Other coordinators here</h3>
            {others.map((x) => (
              <p class="muted small">
                {x.agent.login} for <b>{x.person.login}</b>, with {runtimeLabel(x.runtime, x)}, since <Time at={x.optedInAt} />.
              </p>
            ))}
            <p class="faint small">Each handles only its person's posts, and never spends your key.</p>
          </section>
        ) : null}
        <section>
          <div class="row">
            <h3 class="grow">Memory</h3>
            <a class="small" href={`${base}/project/memory`}>
              {writable ? "Edit" : "History"}
            </a>
          </div>
          {board.memory?.body.trim() ? (
            <>
              <div class="small">
                <Markdown text={board.memory.body.length > 1500 ? `${board.memory.body.slice(0, 1500)}…` : board.memory.body} />
              </div>
              <p class="faint small">
                Version {board.memory.n} by {board.memory.by_login}, <Time at={board.memory.at} />
              </p>
            </>
          ) : (
            <p class="muted small">Notes every task in this project reads: conventions, decisions, where things are.</p>
          )}
        </section>
        <section>
          <div class="row">
            <h3 class="grow">Settings</h3>
            {admin ? (
              <a class="small" href={`${base}/settings/project`}>
                Change
              </a>
            ) : null}
          </div>
          <p class="muted small">
            Up to <b>{board.settings.orgMaxRunning !== null && board.settings.orgMaxRunning < board.settings.maxRunning ? board.settings.orgMaxRunning : board.settings.maxRunning}</b> tasks run at once
            {board.settings.orgMaxRunning !== null && board.settings.orgMaxRunning < board.settings.maxRunning ? ", the organization's limit" : ""}; more wait in the queue.{" "}
            {board.settings.instructions ? "Every task follows the project instructions." : "No project instructions."}
          </p>
        </section>
      </aside>
    </div>,
  );
}

const Diff: FC<{ from: string; to: string }> = ({ from, to }) => {
  const d = lineDiff(from, to);
  if (!d.some((x) => x.op !== " ")) return <div class="empty">No changes.</div>;
  return (
    <table class="diff">
      {d.map((x) => (
        <tr class={x.op === "+" ? "add" : x.op === "-" ? "del" : ""}>
          <td class="ln">{x.op === " " ? "" : x.op}</td>
          <td class="code">{x.text}</td>
        </tr>
      ))}
    </table>
  );
};

async function memoryPage(c: AppContext, l: Loaded, opts: { error?: string; draft?: string; compare?: number } = {}) {
  const base = repoUrl(l.repo);
  const tk = csrfToken(c);
  const stub = projectStub(c.env, l.repo.id);
  const [current, versions] = await Promise.all([stub.memory(), stub.memoryVersions()]);
  const compare: MemoryRow | null = opts.compare !== undefined ? (versions.find((v) => v.n === opts.compare) ?? (await stub.memoryVersion(opts.compare))) : null;
  if (opts.compare !== undefined && !compare) throw new HttpError(404, "no such memory version");
  const writable = !l.repo.archived;
  return render(
    c,
    { title: `Memory · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "project" }, status: opts.error ? 422 : undefined },
    <div class="grid">
      <div>
        <h1>Project memory</h1>
        <p class="muted">
          Notes every agent task in this project reads with its goal: conventions, decisions, where things are. Tasks treat them as background, not as orders, and agent reviews don't read them. Each save keeps a version, so any change can be undone. See <a href="/docs/agents/projects">Projects</a>.
        </p>
        {opts.error ? <div class="flash error">{opts.error}</div> : null}
        {compare ? (
          <div class="box">
            <div class="head">
              <h2>
                Version {compare.n} by {compare.by_login}, <Time at={compare.at} />
              </h2>
              {writable && current && compare.n !== current.n ? (
                <Form action={`${base}/project/memory/${compare.n}/restore`} t={tk} class="inline" confirm={`Restore version ${compare.n}? It is saved as a new version, so this can be undone too.`}>
                  <button class="btn sm">Restore this version</button>
                </Form>
              ) : null}
            </div>
            <div class="body">
              {current && compare.n !== current.n ? <p class="muted small">What restoring it would change in the current memory:</p> : <p class="muted small">This is the current memory.</p>}
              <Diff from={current?.body ?? ""} to={compare.body} />
            </div>
          </div>
        ) : null}
        {writable ? (
          <Form action={`${base}/project/memory`} t={tk} class="box">
            <div class="head">
              <h2>Edit</h2>
            </div>
            <div class="body">
              <div class="field">
                <textarea name="body" rows={18} maxlength={MAX_MEMORY} class="mono" aria-label="Project memory">
                  {opts.draft ?? current?.body ?? ""}
                </textarea>
                <div class="hint">Markdown, up to {MAX_MEMORY.toLocaleString("en-US")} characters. Don't put secrets here: every task's agent and its sandbox see it.</div>
              </div>
              <button class="btn primary">Save</button>
            </div>
          </Form>
        ) : current ? (
          <div class="box">
            <div class="body">
              <Markdown text={current.body} />
            </div>
          </div>
        ) : null}
      </div>
      <aside class="side">
        <section>
          <h3>Versions</h3>
          {versions.length ? (
            <ul class="list small">
              {versions.map((v, i) => (
                <li>
                  <div class="grow">
                    <a href={`${base}/project/memory?version=${v.n}`}>
                      <b>Version {v.n}</b>
                    </a>
                    {i === 0 ? <span class="badge green">Current</span> : null}
                    <div class="muted">
                      {v.by_login}
                      {v.by_kind === "coordinator" ? " (coordinator)" : ""}, <Time at={v.at} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted small">No memory saved yet.</p>
          )}
        </section>
      </aside>
    </div>,
  );
}

const providerNames = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.name])) as Record<Provider, string>;

async function coordinatorPage(c: AppContext, l: Loaded, error?: string, values?: Partial<Record<string, string>>) {
  const me = requireAccount(c);
  const base = repoUrl(l.repo);
  const tk = csrfToken(c);
  const [current, agents, keys] = await Promise.all([projectStub(c.env, l.repo.id).coordinator(me.id), drivableAgents(c, me, l), new ModelKeys(c.env).providers(me.id)]);
  const s: Partial<CoordinatorSettings> = current ?? {};
  const v = (k: string, d: string) => values?.[k] ?? d;
  const runtimes = runtimeChoices(keys, providerNames);
  const currentChoice = s.runtime ? (s.via ? `${s.runtime}+${s.via}` : s.runtime) : undefined;
  return render(
    c,
    { title: `Your coordinator · ${l.repo.owner_login}/${l.repo.name}`, repo: { repo: l.repo, caller: l.caller, tab: "project" }, status: error ? 422 : undefined },
    <div style="max-width:780px">
      <h1>Your coordinator</h1>
      <p class="muted">
        When you post in the <a href={`${base}/project`}>project conversation</a>, your coordinator reads the post, the board and the memory in a read-only sandbox. Then it replies, starts tasks (each a complete brief for another agent), sends follow-ups to or stops your own tasks, and updates the memory. Diffinery checks everything it asks for and applies it as you, or applies nothing. See <a href="/docs/agents/projects#coordinator">Projects</a>.
      </p>
      {error ? <div class="flash error">{error}</div> : null}
      {current ? (
        <div class="flash info">
          Your coordinator is <b>on</b>: {current.agent.login} with {runtimeLabel(current.runtime, current)} (since <Time at={current.optedInAt} />).
        </div>
      ) : null}
      <Form action={`${base}/project/coordinator`} t={tk} class="box">
        <div class="body fbody">
          {!agents.length ? (
            <div class="flash info">
              You don't have an agent with write access here yet. <a href="/settings/agents">Create an agent</a>, then give it write access to this repository.
            </div>
          ) : null}
          <div class="field">
            <label for="agent">Agent</label>
            <KSelect id="agent" name="agent" block label="Agent" value={v("agent", s.agent && agents.some((a) => a.id === s.agent!.id) ? s.agent.login : (agents[0]?.login ?? ""))} options={agents.map((a) => ({ value: a.login, label: a.name ? `${a.login} (${a.name})` : a.login }))} placeholder="Choose an agent" />
            <div class="hint">The tasks it starts run as this agent too.</div>
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
            <input id="command" name="command" type="text" maxlength={2000} value={v("command", s.command ?? "")} placeholder='my-coordinator --prompt "$DIFFINERY_TASK_PROMPT"' />
            <div class="hint">Gets the coordinator's instructions in $DIFFINERY_TASK_PROMPT and must end its output with the actions block they describe.</div>
          </div>
          <div class="fgrid">
            <div class="field">
              <label for="tokens_per_run">Tokens per coordinator run</label>
              <input id="tokens_per_run" name="tokens_per_run" type="number" min={TOKENS_MIN} max={TOKENS_MAX} step={1} value={v("tokens_per_run", String(s.tokensPerRun ?? COORDINATOR_TOKENS_DEFAULT))} />
              <div class="hint">A coordinator run also stops after {COORDINATOR_TIMEOUT_MS / 60_000} minutes or 200 model requests.</div>
            </div>
            <div class="field">
              <label for="tokens_per_task">Tokens per run of a task it starts</label>
              <input id="tokens_per_task" name="tokens_per_task" type="number" min={TOKENS_MIN} max={TOKENS_MAX} step={1} value={v("tokens_per_task", String(s.tokensPerTask ?? TASK_TOKENS_DEFAULT))} />
              <div class="hint">
                Each run of a task your coordinator starts stops before it can pass this. It starts at most {TASKS_PER_RUN} tasks per post and {TASKS_PER_DAY} a day, and they wait their turn under the project's limit on how many run at once.
              </div>
            </div>
          </div>
          <div class="flash info">
            Your coordinator and every task it starts use <b>your</b> model key, only for your posts and ones you choose to hand it. Anything it reads, including the repository and the memory, can try to trick it ("prompt injection"); it can only reply, start or steer your tasks and edit the memory, and every memory change can be undone. Use a dedicated key with a spending limit.
          </div>
          <div class="fchecks">
            <KCheckbox name="accept" label="My coordinator, and the tasks it starts, use my model key" />
          </div>
          <div class="factions">
            <button class="btn primary" disabled={!agents.length}>
              {current ? "Save" : "Turn on my coordinator"}
            </button>
          </div>
        </div>
      </Form>
      {current ? (
        <Form action={`${base}/project/coordinator/off`} t={tk} class="box" confirm="Turn off your coordinator? A run in progress stops; tasks it started keep running.">
          <div class="body row">
            <div class="grow muted small">Your posts then stay in the conversation for people to read, and anyone's coordinator can handle them.</div>
            <button class="btn danger">Turn off</button>
          </div>
        </Form>
      ) : null}
    </div>,
  );
}

async function settingsForm(c: AppContext, l: Loaded, error?: string, values?: { max_running?: string; instructions?: string; plan_first?: string }) {
  const base = repoUrl(l.repo);
  const s = await projectStub(c.env, l.repo.id).projectSettings();
  return settingsPage(
    c,
    l,
    "project",
    <>
      <h1>Project</h1>
      <p class="muted">
        How agent tasks run in this repository's <a href={`${base}/project`}>Project tab</a>. See <a href="/docs/agents/projects">Projects</a>.
      </p>
      {error ? <div class="flash error">{error}</div> : null}
      <Form action={`${base}/settings/project`} t={csrfToken(c)} class="box">
        <div class="body fbody">
          <div class="fgrid c3">
            <div class="field span2">
              <label for="max_running">Tasks at once</label>
              <input id="max_running" name="max_running" type="number" min={MAX_RUNNING_MIN} max={MAX_RUNNING_MAX} step={1} required value={values?.max_running ?? String(s.maxRunning)} />
              <div class="hint">
                How many tasks run at the same time, from {MAX_RUNNING_MIN} to {MAX_RUNNING_MAX}. Tasks started beyond it wait in the queue and start, oldest first, as running ones finish. Agent reviews don't count and never wait.
                {s.orgMaxRunning !== null && s.orgMaxRunning < s.maxRunning ? ` The organization's agent policy allows at most ${s.orgMaxRunning}, so ${s.orgMaxRunning} run at once.` : ""}
              </div>
            </div>
          </div>
          <div class="field">
            <label>Plan first</label>
            <KRadio name="plan_first" label="Plan first" value={values?.plan_first ?? s.planFirst} items={Object.entries(PLAN_FIRST).map(([value, label]) => ({ value, label }))} />
            <div class="hint">A task that plans first writes a plan in a read-only sandbox, then waits for the person who started it to approve it, ask for changes, or split it into tasks with their coordinator. Autofix tasks never plan first.</div>
          </div>
          <div class="field">
            <label for="instructions">Project instructions</label>
            <textarea id="instructions" name="instructions" rows={10} maxlength={MAX_INSTRUCTIONS} placeholder="For example: run pnpm test before opening a pull request. Keep changes small.">
              {values?.instructions ?? s.instructions}
            </textarea>
            <div class="hint">Every agent task and agent review in this repository gets these in its prompt. Reviews also follow REVIEW.md files. Up to {MAX_INSTRUCTIONS.toLocaleString("en-US")} characters.</div>
          </div>
          <div class="factions">
            <button class="btn primary">Save</button>
          </div>
        </div>
      </Form>
    </>,
    error ? 422 : undefined,
  );
}

export function registerProject(web: WebApp): void {
  web.get("/:owner/:repo/project", async (c) => projectPage(c, await forProject(c)));

  post(web, "/:owner/:repo/project/posts", async (c, f) => {
    const l = await forProject(c);
    let out: Awaited<ReturnType<typeof postToProject>>;
    try {
      out = await postToProject(c, l, f.s("body"), { coordinator: f.all("coordinator").length > 0 });
    } catch (e) {
      const st = statusOf(e);
      if (st.status >= 500) throw e;
      return projectPage(c, l, st.message, f.s("body"));
    }
    const h: Handled | null = out.handled;
    if (h && "error" in h) flash(c, "error", `Posted, but your coordinator didn't start: ${h.error}`);
    else if (h) flash(c, "notice", h.status === "started" ? "Posted. Your coordinator is on it." : "Posted. Your coordinator takes it when its current run ends.");
    return c.redirect(`${repoUrl(l.repo)}/project#post-${out.post.n}`, 303);
  });

  post(web, "/:owner/:repo/project/posts/:n/handle", async (c) => {
    const l = await forProject(c);
    const n = prm(c, "n");
    if (!/^\d{1,9}$/.test(n)) throw new HttpError(404, "not found");
    return act(
      c,
      `${repoUrl(l.repo)}/project#post-${n}`,
      async () => {
        await handlePost(c, l, Number(n));
      },
      "Your coordinator is on it.",
    );
  });

  web.get("/:owner/:repo/project/coordinator", async (c) => coordinatorPage(c, await forProject(c)));

  post(web, "/:owner/:repo/project/coordinator", async (c, f) => {
    const l = await forProject(c);
    const values = { agent: f.s("agent"), runtime: f.s("runtime") || "claude-code", model: f.s("model"), command: f.s("command"), tokens_per_run: f.s("tokens_per_run"), tokens_per_task: f.s("tokens_per_task") };
    try {
      const { runtime, provider } = parseRuntimeChoice(values.runtime);
      await saveCoordinator(c, l, { ...values, runtime, provider, model: provider ? values.model : undefined, accept: f.all("accept").length > 0 });
    } catch (e) {
      const st = statusOf(e);
      if (st.status >= 500) throw e;
      return coordinatorPage(c, l, st.message, values);
    }
    return act(c, `${repoUrl(l.repo)}/project`, async () => {}, "Your coordinator is on. Your posts here go to it.");
  });

  post(web, "/:owner/:repo/project/coordinator/off", async (c) => {
    const l = await forProject(c);
    return act(
      c,
      `${repoUrl(l.repo)}/project`,
      async () => {
        await saveCoordinator(c, l, null);
      },
      "Your coordinator is off.",
    );
  });

  web.get("/:owner/:repo/project/memory", async (c) => {
    const l = await forProject(c);
    const v = c.req.query("version");
    return memoryPage(c, l, { compare: v && /^\d{1,9}$/.test(v) ? Number(v) : undefined });
  });

  post(web, "/:owner/:repo/project/memory", async (c, f) => {
    const l = await forProject(c);
    try {
      await saveMemory(c, l, f.s("body"));
    } catch (e) {
      const st = statusOf(e);
      if (st.status >= 500) throw e;
      return memoryPage(c, l, { error: st.message, draft: f.s("body") });
    }
    return act(c, `${repoUrl(l.repo)}/project/memory`, async () => {}, "Memory saved.");
  });

  post(web, "/:owner/:repo/project/memory/:n/restore", async (c) => {
    const l = await forProject(c);
    const n = prm(c, "n");
    if (!/^\d{1,9}$/.test(n)) throw new HttpError(404, "not found");
    return act(
      c,
      `${repoUrl(l.repo)}/project/memory`,
      async () => {
        await saveMemory(c, l, undefined, Number(n));
      },
      `Version ${n} restored.`,
    );
  });

  const admin = (c: AppContext) => loadRepo(c, prm(c, "owner"), prm(c, "repo"), "admin");

  web.get("/:owner/:repo/settings/project", async (c) => settingsForm(c, await admin(c)));

  post(web, "/:owner/:repo/settings/project", async (c, f) => {
    const l = await admin(c);
    requireAccount(c);
    const values = { max_running: f.s("max_running"), instructions: f.s("instructions"), plan_first: f.s("plan_first") || "off" };
    try {
      await saveProjectSettings(c, l, values);
    } catch (e) {
      const st = statusOf(e);
      if (st.status >= 500) throw e;
      return settingsForm(c, l, st.message, values);
    }
    return act(c, `${repoUrl(l.repo)}/settings/project`, async () => {}, "Project settings saved.");
  });
}
