import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { PAUSE_FLAG } from "../../src/lib/killswitch.js";
import {
  COMPONENT_IDS,
  DB_DOWN,
  MAX_BODY,
  MAX_TITLE,
  StatusIncidents,
  componentStates,
  incidentJson,
  killSwitchSignals,
  openIncident,
  overall,
  postUpdate,
  statusSummary,
  summaryJson,
  validateIncident,
  validateUpdate,
  type Incident,
} from "../../src/lib/status.js";
import { HttpError } from "../../src/lib/util.js";
import { testD1 } from "./stubs/d1.js";

const PUB = "https://diffinery.example";
const root = { id: "u-root", login: "root" };

function setup() {
  const DB = testD1();
  const env = { DB, PUBLIC_URL: PUB } as unknown as Env;
  const audits: Array<{ action: string; target?: string; actorLogin?: string; detail?: unknown }> = [];
  const audit = async (e: (typeof audits)[number]) => void audits.push(e);
  return { env, DB, audits, audit };
}

/** An incident as the store would return it. */
const incident = (o: Partial<Incident>): Incident => ({
  id: "0".repeat(32),
  title: "Something",
  impact: "minor",
  components: ["web"],
  state: "investigating",
  created_by: "root",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  resolved_at: null,
  updates: [],
  ...o,
});

const statusOf = (incidents: Incident[], signals: Parameters<typeof componentStates>[1] = []) => Object.fromEntries(componentStates(incidents, signals).map((c) => [c.id, c.status]));

const refused = (f: () => unknown, msg: RegExp) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(422);
    expect((e as HttpError).detail).toMatch(msg);
    return;
  }
  throw new Error("expected it to be refused");
};

describe("component statuses", () => {
  it("lists every component, operational when nothing is wrong", () => {
    const c = componentStates([], []);
    expect(c.map((x) => [x.id, x.name])).toEqual([
      ["web", "Website and API"],
      ["git", "Git operations"],
      ["actions", "Actions"],
      ["agents", "Agents and sandboxes"],
      ["packages", "Packages"],
      ["email", "Email"],
    ]);
    expect(c.every((x) => x.status === "operational" && !("note" in x))).toBe(true);
    expect(overall(c)).toEqual({ indicator: "none", description: "All systems operational" });
  });

  it("maps each impact to Statuspage's component status, only for the components an incident names", () => {
    expect(statusOf([incident({ impact: "critical", components: ["git"] })])).toMatchObject({ git: "major_outage", web: "operational" });
    expect(statusOf([incident({ impact: "major", components: ["actions", "agents"] })])).toMatchObject({ actions: "partial_outage", agents: "partial_outage", git: "operational" });
    expect(statusOf([incident({ impact: "minor", components: ["email"] })])).toMatchObject({ email: "degraded_performance" });
    expect(statusOf([incident({ impact: "maintenance", components: ["packages"] })])).toMatchObject({ packages: "under_maintenance" });
  });

  it("takes the worst unresolved incident, and ignores resolved ones", () => {
    const s = statusOf([
      incident({ impact: "minor", components: ["web", "git"] }),
      incident({ impact: "critical", components: ["web"], state: "monitoring" }),
      incident({ impact: "critical", components: ["git"], state: "resolved", resolved_at: "2026-10-02T00:00:00.000Z" }),
      incident({ impact: "maintenance", components: ["git"] }),
    ]);
    expect(s).toMatchObject({ web: "major_outage", git: "degraded_performance" });
  });

  it("gives the overall indicator and description of the worst component", () => {
    const of = (impact: Incident["impact"]) => overall(componentStates([incident({ impact }), incident({ impact: "maintenance", components: ["email"] })], []));
    expect(of("critical")).toEqual({ indicator: "critical", description: "Major outage" });
    expect(of("major")).toEqual({ indicator: "major", description: "Partial outage" });
    expect(of("minor")).toEqual({ indicator: "minor", description: "Degraded performance" });
    expect(of("maintenance")).toEqual({ indicator: "maintenance", description: "Service under maintenance" });
  });
});

describe("kill switches and failures", () => {
  it("puts what an instance-wide switch stops under maintenance, with a note", () => {
    expect(killSwitchSignals({ hostedJobs: false, selfHostedJobs: false, sandboxes: false })).toEqual([]);
    const paused = killSwitchSignals({ hostedJobs: true, selfHostedJobs: false, sandboxes: true });
    const c = componentStates([], paused);
    expect(c.find((x) => x.id === "actions")).toEqual({ id: "actions", name: "Actions", status: "under_maintenance", note: "Hosted jobs are paused by the site administrators. Jobs on self-hosted runners still run." });
    expect(c.find((x) => x.id === "agents")).toEqual({ id: "agents", name: "Agents and sandboxes", status: "under_maintenance", note: "Agent sandboxes are paused by the site administrators." });
    expect(overall(c).indicator).toBe("maintenance");
    expect(killSwitchSignals({ hostedJobs: true, selfHostedJobs: true, sandboxes: false })).toEqual([{ component: "actions", status: "under_maintenance", note: "Actions jobs are paused by the site administrators." }]);
    expect(killSwitchSignals({ hostedJobs: false, selfHostedJobs: true, sandboxes: false })[0]!.note).toBe("Jobs on self-hosted runners are paused by the site administrators.");
  });

  it("lets a worse incident win over a switch, keeping the switch's note", () => {
    const signals = killSwitchSignals({ hostedJobs: true, selfHostedJobs: false, sandboxes: true });
    const c = componentStates([incident({ impact: "major", components: ["actions"] }), incident({ impact: "maintenance", components: ["agents"] })], signals);
    expect(c.find((x) => x.id === "actions")).toMatchObject({ status: "partial_outage", note: expect.stringMatching(/^Hosted jobs are paused/) });
    expect(c.find((x) => x.id === "agents")!.status).toBe("under_maintenance");
  });

  it("reads the instance's hosted compute pause into the summary", async () => {
    const { env, DB } = setup();
    expect((await statusSummary(env)).status).toEqual({ indicator: "none", description: "All systems operational" });
    DB.sqlite.prepare("INSERT INTO site_flags (key, value, updated_at, updated_by) VALUES (?, 'a secret reason', ?, 'root')").run(PAUSE_FLAG, new Date().toISOString());
    const s = await statusSummary(env);
    expect(s.status.indicator).toBe("maintenance");
    expect(s.components.find((c) => c.id === "actions")).toMatchObject({ status: "under_maintenance", note: expect.stringMatching(/^Hosted jobs are paused by the site administrators/) });
    expect(s.components.find((c) => c.id === "agents")!.status).toBe("under_maintenance");
    expect(s.components.find((c) => c.id === "git")!.status).toBe("operational");
    // The administrators' reason isn't public.
    expect(JSON.stringify(summaryJson(env, s))).not.toContain("secret");
  });

  it("still answers when the database can't be read: the website is down and there are no incidents", async () => {
    const DB = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1_ERROR: unavailable"); }, first: async () => { throw new Error("D1_ERROR: unavailable"); } }), all: async () => { throw new Error("D1_ERROR: unavailable"); }, first: async () => { throw new Error("D1_ERROR: unavailable"); } }) };
    const env = { DB, PUBLIC_URL: PUB } as unknown as Env;
    const error = console.error;
    console.error = () => {};
    try {
      const s = await statusSummary(env, new Date("2026-10-14T12:00:00.000Z"));
      expect(s.components.find((c) => c.id === "web")).toEqual({ id: "web", name: "Website and API", status: "major_outage", note: DB_DOWN });
      expect(s.components.filter((c) => c.status !== "operational").map((c) => c.id)).toEqual(["web"]);
      expect(s.status).toEqual({ indicator: "critical", description: "Major outage" });
      expect(s).toMatchObject({ incidents: [], resolved: [], updated_at: "2026-10-14T12:00:00.000Z" });
    } finally {
      console.error = error;
    }
  });
});

describe("validation", () => {
  const good = { title: "  Pushes\n are failing ", impact: "major", components: ["git", "web", "git"], state: "investigating", body: "\n\nWe are looking into it.\r\nMore soon.\n\n " };

  it("keeps a one-line title, the update's lines and the components in the page's order", () => {
    expect(validateIncident(good)).toEqual({ title: "Pushes are failing", impact: "major", components: ["web", "git"], state: "investigating", body: "We are looking into it.\nMore soon." });
    expect(validateUpdate({ state: "resolved", body: "Fixed." })).toEqual({ state: "resolved", body: "Fixed." });
  });

  it("refuses what is missing, too long or unknown, in full sentences", () => {
    refused(() => validateIncident({ ...good, title: " \n " }), /^Give the incident a title\.$/);
    refused(() => validateIncident({ ...good, title: "x".repeat(MAX_TITLE + 1) }), /200 characters/);
    expect(validateIncident({ ...good, title: "x".repeat(MAX_TITLE) }).title).toHaveLength(MAX_TITLE);
    refused(() => validateIncident({ ...good, impact: "huge" }), /^Choose the incident's impact: minor, major, critical or maintenance\.$/);
    refused(() => validateIncident({ ...good, components: [] }), /^Choose at least one affected component\.$/);
    refused(() => validateIncident({ ...good, components: "web" }), /at least one affected component/);
    refused(() => validateIncident({ ...good, components: ["web", "database"] }), /^There is no component called "database"\. Choose from web, git, actions, agents, packages, email\.$/);
    refused(() => validateIncident({ ...good, state: "closed" }), /^Choose the incident's state: investigating, identified, monitoring or resolved\.$/);
    refused(() => validateIncident({ ...good, body: "  \n " }), /^Write an update that says what is happening\.$/);
    refused(() => validateUpdate({ state: "monitoring", body: "x".repeat(MAX_BODY + 1) }), /^Keep the update to 5,000 characters\.$/);
    expect(validateUpdate({ state: "monitoring", body: "x".repeat(MAX_BODY) }).body).toHaveLength(MAX_BODY);
    refused(() => validateUpdate({ state: undefined, body: "x" }), /state/);
    refused(() => validateIncident({ ...good, title: 42 }), /title/);
    expect(COMPONENT_IDS).toEqual(["web", "git", "actions", "agents", "packages", "email"]);
  });
});

describe("opening, updating and resolving incidents", () => {
  it("opens an incident with its first update, audited, and the summary shows it", async () => {
    const { env, audits, audit } = setup();
    const i = await openIncident(env.DB, audit, root, validateIncident({ title: "Pushes are failing", impact: "major", components: ["git"], state: "investigating", body: "Looking into it." }), "api");
    expect(i).toMatchObject({ title: "Pushes are failing", impact: "major", components: ["git"], state: "investigating", created_by: "root", resolved_at: null });
    expect(i.updates).toEqual([expect.objectContaining({ state: "investigating", body: "Looking into it.", author_login: "root" })]);
    expect(audits).toEqual([{ actorId: "u-root", actorLogin: "root", action: "status_incident.create", target: i.id, detail: { title: "Pushes are failing", impact: "major", components: ["git"], state: "investigating", via: "api" } }]);
    const s = await statusSummary(env);
    expect(s.status).toEqual({ indicator: "major", description: "Partial outage" });
    expect(s.components.find((c) => c.id === "git")!.status).toBe("partial_outage");
    expect(s.incidents.map((x) => x.id)).toEqual([i.id]);
    const json = summaryJson(env, s);
    expect(json.incidents[0]).toEqual({
      id: i.id,
      title: "Pushes are failing",
      impact: "major",
      state: "investigating",
      components: ["git"],
      created_at: i.created_at,
      updated_at: i.updated_at,
      resolved_at: null,
      updates: [{ id: i.updates[0]!.id, state: "investigating", body: "Looking into it.", created_at: i.created_at }],
      html_url: `${PUB}/status#incident-${i.id}`,
    });
    expect(incidentJson(env, i, { admin: true })).toMatchObject({ created_by: "root", updates: [{ author: "root" }] });
  });

  it("posts updates newest first, and resolving returns the components to operational", async () => {
    const { env, audits, audit } = setup();
    const i = await openIncident(env.DB, audit, root, validateIncident({ title: "Slow pages", impact: "minor", components: ["web", "git"], state: "investigating", body: "Looking." }), "web");
    audits.length = 0;
    const found = await postUpdate(env.DB, audit, root, i.id, validateUpdate({ state: "identified", body: "Found it." }), "web");
    expect(found.state).toBe("identified");
    const done = await postUpdate(env.DB, audit, root, i.id, validateUpdate({ state: "resolved", body: "Fixed." }), "api");
    expect(done.state).toBe("resolved");
    expect(done.resolved_at).toBeTruthy();
    expect(done.updates.map((u) => u.state)).toEqual(["resolved", "identified", "investigating"]);
    expect(audits).toEqual([
      { actorId: "u-root", actorLogin: "root", action: "status_incident.update", target: i.id, detail: { from: "investigating", to: "identified", via: "web" } },
      { actorId: "u-root", actorLogin: "root", action: "status_incident.resolve", target: i.id, detail: { from: "identified", to: "resolved", via: "api" } },
    ]);
    expect(JSON.stringify(audits)).not.toContain("Found it");
    const s = await statusSummary(env);
    expect(s.components.every((c) => c.status === "operational")).toBe(true);
    expect(s.incidents).toEqual([]);
    expect(s.resolved.map((x) => x.id)).toEqual([i.id]);
    // Fourteen days later it is off the page.
    expect((await statusSummary(env, new Date(Date.now() + 15 * 86400_000))).resolved).toEqual([]);
    // Reopening clears resolved_at.
    const again = await postUpdate(env.DB, audit, root, i.id, validateUpdate({ state: "monitoring", body: "It came back." }), "api");
    expect(again).toMatchObject({ state: "monitoring", resolved_at: null });
  });

  it("refuses an update to an incident that doesn't exist", async () => {
    const { env, audit } = setup();
    await expect(postUpdate(env.DB, audit, root, "f".repeat(32), { state: "resolved", body: "x" }, "api")).rejects.toMatchObject({ status: 404 });
    await expect(postUpdate(env.DB, audit, root, "not-an-id", { state: "resolved", body: "x" }, "api")).rejects.toMatchObject({ status: 404 });
    expect(await new StatusIncidents(env.DB).list()).toEqual([]);
  });
});
