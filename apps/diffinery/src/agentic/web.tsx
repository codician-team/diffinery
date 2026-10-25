/** @jsxImportSource hono/jsx */
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { ICONS } from "../web/assets.js";
import { Actor, Status, Time } from "../web/ui.js";
import { AGENT_TEXT, NEEDS_TEXT, TASK_TEXT, type AgentItem, type NeedsItem, type Today } from "./today.js";
import type { TodayPull } from "./today-repo.js";
import type { MyTask } from "./tasks.js";

/**
 * The Today view's sections on the dashboard (web/account.tsx): what needs you, your agents, and the last day.
 * Each section folds away (the site script remembers which in COLLAPSED_COOKIE, so the page renders them that
 * way) and shows its newest SHOWN rows, with the rest behind "Show N more".
 */

/** Rows a section shows before "Show N more". */
export const SHOWN = 3;
/** Which sections are folded away: their ids, joined with dots. Written by the site script (web/assets.ts). */
export const COLLAPSED_COOKIE = "today_collapsed";
const SECTIONS = ["needs-you", "deployments", "agents", "tasks", "landed", "notifications"];

/** The sections a COLLAPSED_COOKIE value folds away. */
export function collapsedSections(cookie: string | undefined): Set<string> {
  return new Set((cookie ?? "").split(".").filter((id) => SECTIONS.includes(id)));
}

const ChecksIcon: FC<{ p: TodayPull }> = ({ p }) =>
  p.checks === "none" ? (
    <span class="st faint" title="No checks">{raw(ICONS.pr)}</span>
  ) : p.checks === "pending" ? (
    <Status status="in_progress" />
  ) : (
    <Status conclusion={p.checks} />
  );

const PullLine: FC<{ repo: { fullName: string; url: string }; p: TodayPull; badge: { label: string; tone: string } }> = ({ repo, p, badge }) => (
  <li>
    <ChecksIcon p={p} />
    <div class="grow">
      <a class="title" href={`${repo.url}/pull/${p.number}`}>
        {p.title}
      </a>{" "}
      <span class={`badge ${badge.tone}`}>{badge.label}</span>
      <div class="meta">
        <a href={repo.url} class="muted">
          {repo.fullName}
        </a>{" "}
        #{p.number} by <Actor login={p.author.login} kind={p.author.kind} avatar={false} /> · updated <Time at={p.updatedAt} />
        {p.failingChecks.length ? <> · failing: {p.failingChecks.slice(0, 3).join(", ")}</> : null}
        {p.changesRequestedBy.length ? <> · changes requested by {p.changesRequestedBy.join(", ")}</> : null}
      </div>
      {p.intent ? <div class="meta">Intent: {p.intent.length > 160 ? `${p.intent.slice(0, 157)}…` : p.intent}</div> : null}
    </div>
  </li>
);

const Tile: FC<{ n: number; label: string; href: string; tone?: string }> = ({ n, label, href, tone }) => (
  <a class={`tile ${n && tone ? tone : ""}`} href={href}>
    <span class="num">{n}</span>
    <span class="lbl">{label}</span>
  </a>
);

export const TodayView: FC<{ today: Today; name: string; collapsed?: Set<string> }> = ({ today, name, collapsed = new Set() }) => {
  const working = today.agentsAtWork.filter((x) => x.state !== "draft").length;
  const landedByAgents = today.landed.filter((x) => x.pull.author.kind === "agent").length;
  return (
    <div>
      <div class="row between mb">
        <h1 class="m0" style="font-size:22px">Today</h1>
        <span class="muted small">
          {name} · {today.repositories} active {today.repositories === 1 ? "repository" : "repositories"}
          {today.incomplete ? " (some left out)" : ""}
        </span>
      </div>
      <div class="tiles">
        <Tile n={today.needsYou.length} label="need you" href="#needs-you" tone="purple" />
        <Tile n={working} label="agent pull requests open" href="#agents" />
        <Tile n={today.landed.length} label={`merged since yesterday${landedByAgents ? ` (${landedByAgents} by agents)` : ""}`} href="#landed" />
        <Tile n={today.failures.length} label="failed runs" href="#landed" tone="red" />
      </div>
      <NeedsYou items={today.needsYou} collapsed={collapsed} />
      {today.deployments.length ? <Deployments items={today.deployments} collapsed={collapsed} /> : null}
      <Agents items={today.agentsAtWork} collapsed={collapsed} />
      {today.tasks.length ? <Tasks items={today.tasks} collapsed={collapsed} /> : null}
      <SinceYesterday today={today} collapsed={collapsed} />
    </div>
  );
};

/** A Today section that folds away from its header (the dashboard's unread notifications use it too). */
export const Section: FC<{ id: string; icon: string; title: string; count: number; note?: string; collapsed: Set<string>; action?: Child; children?: Child }> = (p) => (
  <details class="box today-sec" id={p.id} data-today-sec={p.id} open={!p.collapsed.has(p.id)}>
    <summary class="head">
      <span class="tog">{raw(ICONS.caret)}</span>
      <h2>
        {raw(p.icon)} {p.title}
      </h2>
      {p.count ? <span class="count">{p.count}</span> : null}
      {p.note ? <span class="muted small note">{p.note}</span> : null}
      {p.action}
    </summary>
    {p.children}
  </details>
);

/** The first SHOWN rows, and the rest behind "Show N more". */
export function Rows<T>({ items, row }: { items: T[]; row: (x: T) => Child }) {
  const rest = items.slice(SHOWN);
  return (
    <>
      <ul class="list">{items.slice(0, SHOWN).map(row)}</ul>
      {rest.length ? (
        <details class="today-more">
          <summary>
            <span class="btn sm">
              Show {rest.length} more {raw(ICONS.caret)}
            </span>
          </summary>
          <ul class="list">{rest.map(row)}</ul>
          <div class="fewer" hidden>
            <button type="button" class="btn sm" data-show-fewer>
              Show fewer
            </button>
          </div>
        </details>
      ) : null}
    </>
  );
}

const Tasks: FC<{ items: MyTask[]; collapsed: Set<string> }> = ({ items, collapsed }) => (
  <Section id="tasks" icon={ICONS.zap} title="Your agent tasks" count={items.length} note="Running, or changed since yesterday" collapsed={collapsed}>
    <Rows
      items={items}
      row={(t) => (
        <li>
          <div class="grow">
            <a href={`/${t.repository}/tasks/${t.number}`}>
              <b>{t.title}</b>
            </a>{" "}
            <span class={`badge ${TASK_TEXT[t.state].tone}`}>{TASK_TEXT[t.state].label}</span>
            <div class="muted small">
              {t.repository} · task #{t.number} · {t.agent}
              {t.prNumber ? (
                <>
                  {" "}
                  · <a href={`/${t.repository}/pull/${t.prNumber}`}>#{t.prNumber}</a>
                </>
              ) : null}
            </div>
          </div>
          <span class="muted small">
            <Time at={t.updatedAt} />
          </span>
        </li>
      )}
    />
  </Section>
);

const Deployments: FC<{ items: Today["deployments"]; collapsed: Set<string> }> = ({ items, collapsed }) => (
  <Section id="deployments" icon={ICONS.rocket} title="Deployments waiting for you" count={items.length} note="You're a required reviewer for these environments" collapsed={collapsed}>
    <Rows
      items={items}
      row={({ repo, deployment: d }) => (
        <li>
          <div class="grow">
            <a href={`${repo.url}/actions/runs/${d.runId}`}>
              <b>{d.environment}</b>: {d.title || d.workflow}
            </a>
            <div class="muted small">
              {repo.fullName} · {d.workflow} #{d.runNumber} on {d.ref.replace(/^refs\/(heads|tags)\//, "")} · started by {d.actor.login}
            </div>
          </div>
          <span class="muted small">
            <Time at={d.since} />
          </span>
        </li>
      )}
    />
  </Section>
);

const NeedsYou: FC<{ items: NeedsItem[]; collapsed: Set<string> }> = ({ items, collapsed }) => (
  <Section id="needs-you" icon={ICONS.eye} title="Needs you" count={items.length} note="Reviews you were asked for, agent work waiting for a person, and your own blocked pull requests" collapsed={collapsed}>
    {items.length ? <Rows items={items.slice(0, 30)} row={(x) => <PullLine repo={x.repo} p={x.pull} badge={NEEDS_TEXT[x.kind]} />} /> : <div class="empty">Nothing is waiting on you.</div>}
  </Section>
);

const Agents: FC<{ items: AgentItem[]; collapsed: Set<string> }> = ({ items, collapsed }) => (
  <Section
    id="agents"
    icon={ICONS.bot}
    title="Agents at work"
    count={items.length}
    note="Open pull requests from agents you and your organizations own"
    collapsed={collapsed}
    action={
      <a class="small manage" href="/settings/agents">
        Manage agents
      </a>
    }
  >
    {items.length ? (
      <Rows items={items.slice(0, 30)} row={(x) => <PullLine repo={x.repo} p={x.pull} badge={AGENT_TEXT[x.state]} />} />
    ) : (
      <div class="empty">
        Your agents have no open pull requests. <a href="/docs/agents/overview">Set up a coding agent</a>
      </div>
    )}
  </Section>
);

type Happened = { at: string; row: () => Child };

const SinceYesterday: FC<{ today: Today; collapsed: Set<string> }> = ({ today, collapsed }) => {
  // One list, newest first, so the first rows are the latest whatever they are.
  const items: Happened[] = [
    ...today.releases.map((x) => ({
      at: x.release.publishedAt,
      row: () => (
        <li>
          <span class="st ok">{raw(ICONS.tag)}</span>
          <div class="grow">
            <a class="title" href={`${x.repo.url}/releases/tag/${encodeURIComponent(x.release.tag)}`}>
              {x.release.name}
            </a>{" "}
            <span class="badge green">{x.release.prerelease ? "Pre-release" : "Released"}</span>
            <div class="meta">
              {x.repo.fullName} · by <Actor login={x.release.author.login} kind={x.release.author.kind} avatar={false} /> · <Time at={x.release.publishedAt} />
            </div>
          </div>
        </li>
      ),
    })),
    ...today.failures.map((x) => ({
      at: x.run.at,
      row: () => (
        <li>
          <span class="st bad">{raw(ICONS.failure)}</span>
          <div class="grow">
            <a class="title" href={`${x.repo.url}/actions/runs/${x.run.id}`}>
              {x.run.title || x.run.workflow}
            </a>{" "}
            <span class="badge red">{x.run.workflow} failed</span>
            <div class="meta">
              {x.repo.fullName} · {x.run.ref.replace(/^refs\/heads\//, "")} · <Actor login={x.run.actor.login} kind={x.run.actor.kind} avatar={false} /> · <Time at={x.run.at} />
            </div>
          </div>
        </li>
      ),
    })),
    ...today.landed.map((x) => ({
      at: x.pull.mergedAt,
      row: () => (
        <li>
          <span class="st" style="color:var(--purple)">
            {raw(ICONS.prMerged)}
          </span>
          <div class="grow">
            <a class="title" href={`${x.repo.url}/pull/${x.pull.number}`}>
              {x.pull.title}
            </a>{" "}
            <span class="badge purple">Merged</span>
            <div class="meta">
              {x.repo.fullName} #{x.pull.number} by <Actor login={x.pull.author.login} kind={x.pull.author.kind} avatar={false} />
              {x.pull.mergedBy ? <> · merged by {x.pull.mergedBy}</> : null} · <Time at={x.pull.mergedAt} />
            </div>
          </div>
        </li>
      ),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Section id="landed" icon={ICONS.history} title="Since yesterday" count={items.length} note="Merged, released and failed in the last 24 hours" collapsed={collapsed}>
      {items.length ? <Rows items={items} row={(x) => x.row()} /> : <div class="empty">Nothing merged, released or failed in the last 24 hours.</div>}
    </Section>
  );
};
