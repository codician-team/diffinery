import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import type { Today } from "../../src/agentic/today.js";
import type { TodayPull } from "../../src/agentic/today-repo.js";
import { COLLAPSED_COOKIE, SHOWN, TodayView, collapsedSections } from "../../src/agentic/web.js";

const repo = { id: "web", fullName: "acme/web", url: "/acme/web", defaultBranch: "main", visibility: "private" };
const pull = (n: number): TodayPull => ({
  number: n,
  title: `Change ${n}`,
  author: { id: "a-bot", login: "web-agent", kind: "agent" },
  head: `b${n}`,
  base: "main",
  draft: false,
  requestedReviewers: [],
  intent: null,
  createdAt: "2026-10-22T08:00:00Z",
  updatedAt: `2026-10-22T08:${String(n).padStart(2, "0")}:00Z`,
  approvedBy: [],
  approvedHead: false,
  changesRequestedBy: [],
  reviewerIds: [],
  checks: "none",
  failingChecks: [],
  autoMerge: false,
  queued: false,
  mergeState: "clean",
});
const today = (over: Partial<Today> = {}): Today => ({
  generatedAt: "2026-10-24T13:00:00Z",
  since: "2026-10-23T13:00:00Z",
  repositories: 1,
  incomplete: false,
  needsYou: [],
  agentsAtWork: [],
  landed: [],
  releases: [],
  failures: [],
  deployments: [],
  tasks: [],
  ...over,
});
const html = (t: Today, collapsed?: Set<string>) => String(jsx(TodayView, { today: t, name: "Can", collapsed }));
const section = (page: string, id: string) => page.slice(page.indexOf(`id="${id}"`), page.indexOf("</details>", page.lastIndexOf(`id="${id}"`)));

describe("Today view", () => {
  const eleven = today({ needsYou: Array.from({ length: 11 }, (_, i) => ({ kind: "agent_approval" as const, repo, pull: pull(11 - i) })) });

  it("shows the newest SHOWN rows of a section and the rest behind Show N more", () => {
    const page = html(eleven);
    const needs = page.slice(page.indexOf('id="needs-you"'), page.indexOf('id="agents"'));
    const [first, rest] = needs.split('class="today-more"');
    expect(SHOWN).toBe(3);
    expect(first!.match(/class="title"/g)).toHaveLength(3);
    expect(first).toContain("Change 11");
    expect(first).not.toContain("Change 8<");
    expect(rest).toContain("Show 8 more");
    expect(rest!.match(/class="title"/g)).toHaveLength(8);
    expect(rest).toContain("data-show-fewer");
    expect(needs).toMatch(/<span class="count">11<\/span>/);
  });

  it("has no expander when a section fits", () => {
    const page = html(today({ needsYou: [{ kind: "agent_approval", repo, pull: pull(1) }] }));
    expect(page).not.toContain("today-more");
    expect(page).toContain("Agent PR needs a person&#39;s approval");
  });

  it("renders every section open unless the viewer folded it", () => {
    expect(html(eleven)).toMatch(/<details class="box today-sec" id="needs-you" data-today-sec="needs-you" open/);
    const folded = html(eleven, collapsedSections("needs-you.landed"));
    expect(folded).toMatch(/<details class="box today-sec" id="needs-you" data-today-sec="needs-you">/);
    expect(folded).toMatch(/<details class="box today-sec" id="landed" data-today-sec="landed">/);
    expect(folded).toMatch(/<details class="box today-sec" id="agents" data-today-sec="agents" open/);
  });

  it("lists what happened since yesterday newest first, whatever it is", () => {
    const run = (id: string, at: string) => ({ repo, run: { id, runNumber: 1, workflow: "CI", title: id, ref: "refs/heads/main", event: "push", actor: { id: "u", login: "mia", kind: "user" }, conclusion: "failure", prNumber: null, at } });
    const merged = (n: number, mergedAt: string) => ({ repo, pull: { number: n, title: `Merged ${n}`, author: { id: "u", login: "mia", kind: "user" }, mergedAt, mergedBy: "mia" } });
    const page = html(today({ failures: [run("old failure", "2026-10-24T01:00:00Z")], landed: [merged(1, "2026-10-24T12:00:00Z"), merged(2, "2026-10-24T02:00:00Z"), merged(3, "2026-10-24T00:30:00Z")] }));
    const landed = section(page, "landed");
    expect(landed.indexOf("Merged 1")).toBeLessThan(landed.indexOf("Merged 2"));
    expect(landed.indexOf("Merged 2")).toBeLessThan(landed.indexOf("old failure"));
    expect(landed.indexOf("old failure")).toBeLessThan(landed.indexOf("Show 1 more"));
    expect(landed.indexOf("Show 1 more")).toBeLessThan(landed.indexOf("Merged 3"));
  });

  it("reads only known section ids from the cookie", () => {
    expect(COLLAPSED_COOKIE).toBe("today_collapsed");
    expect([...collapsedSections("needs-you.bogus..agents")]).toEqual(["needs-you", "agents"]);
    expect(collapsedSections(undefined).size).toBe(0);
  });
});
