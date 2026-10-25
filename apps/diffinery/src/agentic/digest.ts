import type { Env } from "../env.js";
import type { Account, Directory } from "../lib/directory.js";
import { localDate } from "../mail/digest.js";
import type { DigestItem, DigestSection, DigestSummary } from "../mail/types.js";
import { AGENT_TEXT, NEEDS_TEXT, TASK_TEXT, gatherToday, type Today } from "./today.js";

/**
 * The morning digest's content (phase 5c): Today (./today.ts) for one person, cut down to what fits
 * in an email. The schedule and sending are in mail/digest.ts and mail/send.ts.
 */

/** Lines per section; the email links to Today for the rest. */
export const DIGEST_MAX_ITEMS = 8;

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Today as the digest's sections, in the order the page shows them. Pure, so it is unit tested. */
export function digestSummary(base: string, t: Today, date: string): DigestSummary {
  const section = (id: DigestSection["id"], title: string, all: DigestItem[]): DigestSection => ({ id, title, total: all.length, items: all.slice(0, DIGEST_MAX_ITEMS) });
  const pull = (repo: { fullName: string; url: string }, n: number) => ({ url: `${base}${repo.url}/pull/${n}`, where: `${repo.fullName}#${n}` });
  const working = t.agentsAtWork.filter((x) => x.state !== "draft");
  const sections = [
    section(
      "needs_you",
      "Needs you",
      t.needsYou.map((x) => ({ title: short(x.pull.title), ...pull(x.repo, x.pull.number), note: `${NEEDS_TEXT[x.kind].label} · by ${x.pull.author.login}`, mark: x.kind === "checks_failing" ? "fail" : "dot" })),
    ),
    section(
      "deployments",
      "Deployments waiting for you",
      t.deployments.map((x) => ({ title: `${x.deployment.environment}: ${short(x.deployment.title || x.deployment.workflow)}`, url: `${base}${x.repo.url}/actions/runs/${x.deployment.runId}`, where: x.repo.fullName, note: `${x.deployment.workflow} #${x.deployment.runNumber}`, mark: "dot" })),
    ),
    section(
      "agents",
      "Agents at work",
      working.map((x) => ({ title: short(x.pull.title), ...pull(x.repo, x.pull.number), note: `${AGENT_TEXT[x.state].label} · ${x.pull.author.login}`, mark: x.state === "checks_failing" ? "fail" : x.state === "approved" || x.state === "landing" ? "ok" : "dot" })),
    ),
    section(
      "tasks",
      "Your agent tasks",
      t.tasks.map((x) => ({ title: short(x.title), url: `${base}/${x.repository}/tasks/${x.number}`, where: `${x.repository} task #${x.number}`, note: `${TASK_TEXT[x.state].label} · ${x.agent}`, mark: x.state === "failed" ? "fail" : x.state === "ready" ? "ok" : "dot" })),
    ),
    section(
      "failures",
      "Failed runs",
      t.failures.map((x) => ({ title: short(x.run.title || x.run.workflow), url: `${base}${x.repo.url}/actions/runs/${x.run.id}`, where: x.repo.fullName, note: `${x.run.workflow} on ${x.run.ref.replace(/^refs\/heads\//, "")} · ${x.run.actor.login}`, mark: "fail" })),
    ),
    section(
      "landed",
      "Merged",
      t.landed.map((x) => ({ title: short(x.pull.title), ...pull(x.repo, x.pull.number), note: `by ${x.pull.author.login}${x.pull.author.kind === "agent" ? " (agent)" : ""}${x.pull.mergedBy ? `, merged by ${x.pull.mergedBy}` : ""}`, mark: "ok" })),
    ),
    section(
      "releases",
      "Released",
      t.releases.map((x) => ({ title: short(x.release.name || x.release.tag), url: `${base}${x.repo.url}/releases/tag/${encodeURIComponent(x.release.tag)}`, where: x.repo.fullName, note: x.release.prerelease ? "Pre-release" : x.release.tag, mark: "ok" })),
    ),
  ].filter((s) => s.total > 0);
  return {
    date,
    counts: { needsYou: t.needsYou.length + t.deployments.length, agents: working.length, merged: t.landed.length, failed: t.failures.length },
    sections,
    repositories: t.repositories,
    incomplete: t.incomplete,
  };
}

/** Gather one person's digest now: Today since `since`, dated in their time zone. */
export async function gatherDigest(env: Env, dir: Directory, me: Account, since: string, timeZone: string, at = new Date()): Promise<DigestSummary> {
  const today = await gatherToday(env, dir, me, { since, now: at });
  return digestSummary(env.PUBLIC_URL, today, localDate(timeZone, at));
}
