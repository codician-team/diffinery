import type { Env } from "../env.js";
import { computePause } from "./killswitch.js";
import { HttpError, newId, now } from "./util.js";

/**
 * The status page: /status and GET /api/v3/diffinery/status, public, like githubstatus.com. Site
 * administrators open incidents that name the components they affect and post updates until they
 * are resolved. Each component's status is the worst impact of the unresolved incidents naming it,
 * in Atlassian Statuspage's terms (which GitHub's page uses too). Two signals need no incident: an
 * instance-wide kill switch (lib/killswitch.ts) puts what it stops under maintenance, and a summary
 * that can't read D1 shows the website as down. The page is served by this Worker, so it is down
 * whenever the whole Worker is: an external monitor of /healthz covers that.
 */

export const COMPONENTS = [
  { id: "web", name: "Website and API" },
  { id: "git", name: "Git operations" },
  { id: "actions", name: "Actions" },
  { id: "agents", name: "Agents and sandboxes" },
  { id: "packages", name: "Packages" },
  { id: "email", name: "Email" },
] as const;
export type ComponentId = (typeof COMPONENTS)[number]["id"];
export const COMPONENT_IDS: readonly ComponentId[] = COMPONENTS.map((c) => c.id);

export type Impact = "minor" | "major" | "critical" | "maintenance";
export const IMPACTS: readonly Impact[] = ["minor", "major", "critical", "maintenance"];
export type IncidentState = "investigating" | "identified" | "monitoring" | "resolved";
export const INCIDENT_STATES: readonly IncidentState[] = ["investigating", "identified", "monitoring", "resolved"];

export type ComponentStatus = "operational" | "under_maintenance" | "degraded_performance" | "partial_outage" | "major_outage";
export type Indicator = "none" | "minor" | "major" | "critical" | "maintenance";

/** Longest title and update, in characters. */
export const MAX_TITLE = 200;
export const MAX_BODY = 5_000;
/** How long a resolved incident stays on the page, in days. */
export const RECENT_DAYS = 14;

/** What an unresolved incident of each impact does to the components it names. */
export const IMPACT_STATUS: Record<Impact, ComponentStatus> = { critical: "major_outage", major: "partial_outage", minor: "degraded_performance", maintenance: "under_maintenance" };
/** Worse is higher: maintenance is better than any outage, so an incident during one still shows. */
const RANK: Record<ComponentStatus, number> = { operational: 0, under_maintenance: 1, degraded_performance: 2, partial_outage: 3, major_outage: 4 };
/** The page's overall indicator and description, by its worst component. */
const OVERALL: Record<ComponentStatus, { indicator: Indicator; description: string }> = {
  operational: { indicator: "none", description: "All systems operational" },
  under_maintenance: { indicator: "maintenance", description: "Service under maintenance" },
  degraded_performance: { indicator: "minor", description: "Degraded performance" },
  partial_outage: { indicator: "major", description: "Partial outage" },
  major_outage: { indicator: "critical", description: "Major outage" },
};

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  state: IncidentState;
  body: string;
  author_login: string | null;
  created_at: string;
}

export interface Incident {
  id: string;
  title: string;
  impact: Impact;
  components: ComponentId[];
  state: IncidentState;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  /** Newest first. */
  updates: IncidentUpdate[];
}

type IncidentRow = Omit<Incident, "components" | "updates"> & { components: string };

/** Something other than an incident that sets a component's status, with a note saying why. */
export interface Signal {
  component: ComponentId;
  status: ComponentStatus;
  note: string;
}

export interface ComponentState {
  id: ComponentId;
  name: string;
  status: ComponentStatus;
  note?: string;
}

export interface Summary {
  status: { indicator: Indicator; description: string };
  components: ComponentState[];
  /** Unresolved incidents, newest first. */
  incidents: Incident[];
  /** Incidents resolved in the last RECENT_DAYS days, most recently resolved first. */
  resolved: Incident[];
  updated_at: string;
}

// ---------------------------------------------------------------- deriving statuses

/**
 * Each component's status: the worst of the unresolved incidents naming it and of the signals for
 * it, operational otherwise. A signal's note stays even when an incident is worse; it is still true.
 */
export function componentStates(incidents: readonly Incident[], signals: readonly Signal[]): ComponentState[] {
  return COMPONENTS.map(({ id, name }) => {
    let status: ComponentStatus = "operational";
    const worse = (s: ComponentStatus) => {
      if (RANK[s] > RANK[status]) status = s;
    };
    for (const i of incidents) if (i.state !== "resolved" && i.components.includes(id)) worse(IMPACT_STATUS[i.impact]);
    const notes: string[] = [];
    for (const s of signals) {
      if (s.component !== id) continue;
      worse(s.status);
      notes.push(s.note);
    }
    return notes.length ? { id, name, status, note: notes.join(" ") } : { id, name, status };
  });
}

/** The overall indicator and description, from the worst component. */
export function overall(components: readonly ComponentState[]): Summary["status"] {
  const worst = components.reduce<ComponentStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "operational");
  return { ...OVERALL[worst] };
}

/** Which instance-wide kill switches are on. */
export interface InstanceSwitches {
  hostedJobs: boolean;
  selfHostedJobs: boolean;
  sandboxes: boolean;
}

/** Kill switches on for the whole instance, as signals: what they stop is under maintenance. */
export function killSwitchSignals(k: InstanceSwitches): Signal[] {
  const out: Signal[] = [];
  const jobs =
    k.hostedJobs && k.selfHostedJobs
      ? "Actions jobs are paused by the site administrators."
      : k.hostedJobs
        ? "Hosted jobs are paused by the site administrators. Jobs on self-hosted runners still run."
        : k.selfHostedJobs
          ? "Jobs on self-hosted runners are paused by the site administrators."
          : null;
  if (jobs) out.push({ component: "actions", status: "under_maintenance", note: jobs });
  if (k.sandboxes) out.push({ component: "agents", status: "under_maintenance", note: "Agent sandboxes are paused by the site administrators." });
  return out;
}

/** The instance's kill switches. Pausing hosted compute stops hosted jobs and sandboxes; self-hosted runners have no instance-wide switch. */
export async function instanceSwitches(env: Env): Promise<InstanceSwitches> {
  const paused = !!(await computePause(env));
  return { hostedJobs: paused, selfHostedJobs: false, sandboxes: paused };
}

/** The note on the website when the summary couldn't read the database. */
export const DB_DOWN = "This instance can't read its database right now, so most pages and API calls fail, and incidents can't be shown.";

/**
 * Everything the page shows. When D1 can't be read the summary still comes back, with the website
 * as a major outage and no incidents, so the page says something useful while the rest is down.
 */
export async function statusSummary(env: Env, at = new Date()): Promise<Summary> {
  const updated_at = at.toISOString();
  try {
    const store = new StatusIncidents(env.DB);
    const [incidents, resolved, switches] = await Promise.all([store.active(), store.resolvedSince(new Date(at.getTime() - RECENT_DAYS * 86400_000).toISOString()), instanceSwitches(env)]);
    const components = componentStates(incidents, killSwitchSignals(switches));
    return { status: overall(components), components, incidents, resolved, updated_at };
  } catch (e) {
    console.error("status page: reading D1 failed", e);
    const components = componentStates([], [{ component: "web", status: "major_outage", note: DB_DOWN }]);
    return { status: overall(components), components, incidents: [], resolved: [], updated_at };
  }
}

// ---------------------------------------------------------------- validation

export interface IncidentInput {
  title: string;
  impact: Impact;
  components: ComponentId[];
  state: IncidentState;
  body: string;
}

export interface UpdateInput {
  state: IncidentState;
  body: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function checkState(v: unknown): IncidentState {
  if (!INCIDENT_STATES.includes(v as IncidentState)) throw new HttpError(422, "Choose the incident's state: investigating, identified, monitoring or resolved.");
  return v as IncidentState;
}

function checkBody(v: unknown): string {
  // Line endings as the browser sent them, but no leading or trailing blank lines.
  const body = str(v).replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
  if (!body) throw new HttpError(422, "Write an update that says what is happening.");
  if (body.length > MAX_BODY) throw new HttpError(422, `Keep the update to ${MAX_BODY.toLocaleString("en")} characters.`);
  return body;
}

/** An update as sent: a state and a message, both required. */
export function validateUpdate(raw: { state?: unknown; body?: unknown }): UpdateInput {
  return { state: checkState(raw.state), body: checkBody(raw.body) };
}

/**
 * A new incident as sent: a one-line title, its impact, the components it affects (at least one,
 * each a known id, kept in the page's order) and its first update. Too long is refused, never cut.
 */
export function validateIncident(raw: { title?: unknown; impact?: unknown; components?: unknown; state?: unknown; body?: unknown }): IncidentInput {
  const title = str(raw.title).replace(/\s+/g, " ").trim();
  if (!title) throw new HttpError(422, "Give the incident a title.");
  if (title.length > MAX_TITLE) throw new HttpError(422, `Keep the title to ${MAX_TITLE} characters; the details go in the update.`);
  if (!IMPACTS.includes(raw.impact as Impact)) throw new HttpError(422, "Choose the incident's impact: minor, major, critical or maintenance.");
  const list = Array.isArray(raw.components) ? raw.components : [];
  if (!list.length) throw new HttpError(422, "Choose at least one affected component.");
  for (const c of list) if (!COMPONENT_IDS.includes(c as ComponentId)) throw new HttpError(422, `There is no component called "${String(c).slice(0, 40)}". Choose from ${COMPONENT_IDS.join(", ")}.`);
  const components = COMPONENT_IDS.filter((id) => list.includes(id));
  const { state, body } = validateUpdate(raw);
  return { title, impact: raw.impact as Impact, components, state, body };
}

// ---------------------------------------------------------------- storage

const parseComponents = (s: string): ComponentId[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? COMPONENT_IDS.filter((id) => v.includes(id)) : [];
  } catch {
    return [];
  }
};

/** Status incidents and their updates in D1. */
export class StatusIncidents {
  constructor(private db: D1Database) {}

  /** Incidents from `rows`, each with its updates, newest first. */
  private async withUpdates(rows: IncidentRow[]): Promise<Incident[]> {
    if (!rows.length) return [];
    const updates = (
      await this.db
        .prepare("SELECT * FROM status_incident_updates WHERE incident_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, rowid DESC")
        .bind(JSON.stringify(rows.map((r) => r.id)))
        .all<IncidentUpdate>()
    ).results;
    return rows.map((r) => ({ ...r, components: parseComponents(r.components), updates: updates.filter((u) => u.incident_id === r.id) }));
  }

  async get(id: string): Promise<Incident | null> {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    const row = await this.db.prepare("SELECT * FROM status_incidents WHERE id = ?").bind(id).first<IncidentRow>();
    return row ? (await this.withUpdates([row]))[0]! : null;
  }

  /** Every incident, newest first. */
  async list(o: { limit?: number } = {}): Promise<Incident[]> {
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    return this.withUpdates((await this.db.prepare("SELECT * FROM status_incidents ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(limit).all<IncidentRow>()).results);
  }

  /** Unresolved incidents, newest first. */
  async active(): Promise<Incident[]> {
    return this.withUpdates((await this.db.prepare("SELECT * FROM status_incidents WHERE state != 'resolved' ORDER BY created_at DESC, rowid DESC LIMIT 50").all<IncidentRow>()).results);
  }

  /** Incidents resolved after `since`, most recently resolved first. */
  async resolvedSince(since: string): Promise<Incident[]> {
    return this.withUpdates((await this.db.prepare("SELECT * FROM status_incidents WHERE state = 'resolved' AND resolved_at > ? ORDER BY resolved_at DESC, rowid DESC LIMIT 50").bind(since).all<IncidentRow>()).results);
  }

  /** Store an incident with its first update, together. */
  async create(input: IncidentInput, by: string): Promise<Incident> {
    const id = newId();
    const at = now();
    await this.db.batch([
      this.db
        .prepare("INSERT INTO status_incidents (id, title, impact, components, state, created_by, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, input.title, input.impact, JSON.stringify(input.components), input.state, by, at, at, input.state === "resolved" ? at : null),
      this.db.prepare("INSERT INTO status_incident_updates (id, incident_id, state, body, author_login, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(), id, input.state, input.body, by, at),
    ]);
    return (await this.get(id))!;
  }

  /**
   * Add an update and move the incident to its state. Resolving sets resolved_at (once); any other
   * state clears it, so an incident resolved too soon can be reopened.
   */
  async addUpdate(id: string, input: UpdateInput, by: string): Promise<void> {
    const at = now();
    await this.db.batch([
      this.db.prepare("INSERT INTO status_incident_updates (id, incident_id, state, body, author_login, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(), id, input.state, input.body, by, at),
      this.db.prepare("UPDATE status_incidents SET state = ?1, updated_at = ?2, resolved_at = CASE WHEN ?1 = 'resolved' THEN coalesce(resolved_at, ?2) ELSE NULL END WHERE id = ?3").bind(input.state, at, id),
    ]);
  }
}

// ---------------------------------------------------------------- changes (REST and web)

type Actor = { id: string; login: string };
type Audit = (e: { actorId?: string; actorLogin?: string; action: string; target?: string; detail?: unknown }) => Promise<void>;

/** Open an incident with its first update, audited as `status_incident.create` (without the update's text). */
export async function openIncident(db: D1Database, audit: Audit, me: Actor, input: IncidentInput, via: "web" | "api"): Promise<Incident> {
  const i = await new StatusIncidents(db).create(input, me.login);
  await audit({ actorId: me.id, actorLogin: me.login, action: "status_incident.create", target: i.id, detail: { title: i.title, impact: i.impact, components: i.components, state: i.state, via } });
  return i;
}

/**
 * Post an update to an incident, audited as `status_incident.resolve` when it resolves it and
 * `status_incident.update` otherwise. 404 when there is no such incident.
 */
export async function postUpdate(db: D1Database, audit: Audit, me: Actor, id: string, input: UpdateInput, via: "web" | "api"): Promise<Incident> {
  const store = new StatusIncidents(db);
  const before = await store.get(id);
  if (!before) throw new HttpError(404, "There is no incident with that id.");
  await store.addUpdate(id, input, me.login);
  await audit({ actorId: me.id, actorLogin: me.login, action: input.state === "resolved" ? "status_incident.resolve" : "status_incident.update", target: id, detail: { from: before.state, to: input.state, via } });
  return (await store.get(id))!;
}

// ---------------------------------------------------------------- JSON

/** The API's view of an incident. Who wrote it only for site administrators. */
export const incidentJson = (env: Pick<Env, "PUBLIC_URL">, i: Incident, o: { admin?: boolean } = {}) => ({
  id: i.id,
  title: i.title,
  impact: i.impact,
  state: i.state,
  components: i.components,
  ...(o.admin ? { created_by: i.created_by } : {}),
  created_at: i.created_at,
  updated_at: i.updated_at,
  resolved_at: i.resolved_at,
  updates: i.updates.map((u) => ({ id: u.id, state: u.state, body: u.body, ...(o.admin ? { author: u.author_login } : {}), created_at: u.created_at })),
  html_url: `${env.PUBLIC_URL}/status#incident-${i.id}`,
});

/** The public summary, shaped like Statuspage's /api/v2/summary.json. */
export const summaryJson = (env: Pick<Env, "PUBLIC_URL">, s: Summary) => ({
  status: s.status,
  components: s.components.map((c) => ({ ...c })),
  incidents: s.incidents.map((i) => incidentJson(env, i)),
  updated_at: s.updated_at,
});
