import { Hono } from "hono";
import type { ImportGitResult, ImportProgress } from "@diffinery/shared";
import type { Env } from "../env.js";
import { credentialFrom, requireAccount, requireAccountScope, type AppContext, type AppVars } from "../auth/principal.js";
import type { Account } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { BULK_STEPS, ImportService, REPO_STEPS, type GitState, type ImportRow, type ImportSummary, type StepState, type StoredRequest } from "../imports/service.js";
import { webHostOf } from "../imports/options.js";
import type { Milestone } from "../repo/imports.js";
import { loadRepo } from "./common.js";

/**
 * GitHub imports (`/api/v3/diffinery/imports`), the import agent's endpoints,
 * milestones (`/repos/:owner/:repo/milestones`, GitHub-compatible), organization
 * Actions variables and linked GitHub accounts. Mounted from api.ts.
 */
export const imports = new Hono<{ Bindings: Env; Variables: AppVars }>();

async function body<T>(c: AppContext): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/** A person or agent signed in normally (an import's own push token can't manage imports). */
function actor(c: AppContext): Account {
  const a = requireAccount(c);
  const p = c.get("principal");
  if (p.type === "account" && p.importId) throw new HttpError(403, "this token can only be used by its GitHub import");
  return a;
}

const steps = (row: ImportRow) => {
  const state = JSON.parse(row.steps || "{}") as Record<string, StepState>;
  return (row.kind === "bulk" ? BULK_STEPS : REPO_STEPS).map(([name, title]) => ({ name, title, status: state[name]?.status ?? "pending", message: state[name]?.message ?? null, count: state[name]?.count ?? null, started_at: state[name]?.startedAt ?? null, finished_at: state[name]?.finishedAt ?? null }));
};

/** The JSON form of an import (no credentials, ever). Shared by the REST API, MCP and the web UI. */
export async function importJson(env: Env, svc: ImportService, row: ImportRow, o: { children?: boolean } = {}) {
  const [owner, creator] = await Promise.all([svc.dir.account(row.target_owner_id), svc.dir.account(row.created_by)]);
  const req = JSON.parse(row.request || "{}") as StoredRequest;
  const summary = JSON.parse(row.summary || "{}") as ImportSummary;
  const git = row.git ? (JSON.parse(row.git) as GitState) : null;
  const web = webHostOf(row.api_url);
  const fullName = row.target_name ? `${owner?.login}/${row.target_name}` : null;
  const out = {
    id: row.id,
    url: `${env.PUBLIC_URL}/api/v3/diffinery/imports/${row.id}`,
    html_url: `${env.PUBLIC_URL}/imports/${row.id}`,
    kind: row.kind === "bulk" ? "organization" : "repository",
    parent_id: row.parent_id,
    status: row.status,
    attempt: row.attempt,
    source: { full_name: row.source, html_url: `https://${web}/${row.source}`, api_url: row.api_url },
    target: { owner: owner?.login ?? null, name: row.target_name, full_name: fullName, html_url: fullName && row.repo_id ? `${env.PUBLIC_URL}/${fullName}` : null },
    visibility: req.visibility,
    options: req.options ? { issues: req.options.issues, releases: req.options.releases, labels: req.options.labels, branch_protection: req.options.protection, variables: req.options.variables, lfs: req.options.lfs, secrets: req.options.secrets } : null,
    concurrency: row.kind === "bulk" ? req.concurrency : undefined,
    candidates: row.status === "draft" ? (req.candidates ?? []) : undefined,
    created_by: creator ? { login: creator.login, type: creator.kind === "agent" ? "Bot" : "User" } : null,
    steps: steps(row),
    git: git ? { phase: git.phase ?? null, message: git.message ?? null, chunks: git.chunks ?? 0, bytes: git.bytes ?? 0, tries: git.tries ?? 0 } : null,
    summary,
    warnings: JSON.parse(row.warnings || "[]") as string[],
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    children: undefined as unknown[] | undefined,
  };
  if (o.children && row.kind === "bulk") {
    const owners = new Map<string, string>([[row.target_owner_id, owner?.login ?? ""]]);
    out.children = (await svc.children(row.id)).map((ch) => {
      const s = JSON.parse(ch.steps || "{}") as Record<string, StepState>;
      const current = REPO_STEPS.find(([n]) => s[n]?.status === "running");
      return {
        id: ch.id,
        html_url: `${env.PUBLIC_URL}/imports/${ch.id}`,
        source: ch.source,
        target: `${owners.get(ch.target_owner_id)}/${ch.target_name}`,
        status: ch.status,
        step: current ? current[1] : null,
        error: ch.error,
      };
    });
  }
  return out;
}

const loadImport = async (c: AppContext, svc: ImportService, a: Account) => {
  const row = await svc.row(c.req.param("id")!);
  if (!row || !(await svc.visibleTo(row, a))) throw new HttpError(404, "import not found");
  return row;
};

const scopesOf = (c: AppContext) => {
  const p = c.get("principal");
  return p.type === "account" ? p.scopes : [];
};

// ---------------------------------------------------------------- imports

imports.post("/diffinery/imports", async (c) => {
  const a = actor(c);
  // An import creates a repository and mints its push token: not for tokens limited to repositories.
  requireAccountScope(c, "write");
  const svc = new ImportService(c.env);
  const row = await svc.create(a, scopesOf(c), await body(c));
  return c.json(await importJson(c.env, svc, row, { children: true }), 201);
});

imports.get("/diffinery/imports", async (c) => {
  const a = actor(c);
  const svc = new ImportService(c.env);
  const rows = await svc.list(a.id);
  return c.json(await Promise.all(rows.map((r) => importJson(c.env, svc, r))));
});

imports.get("/diffinery/imports/:id", async (c) => {
  const a = actor(c);
  const svc = new ImportService(c.env);
  return c.json(await importJson(c.env, svc, await loadImport(c, svc, a), { children: true }));
});

imports.post("/diffinery/imports/:id/cancel", async (c) => {
  requireAccountScope(c, "write");
  const a = actor(c);
  const svc = new ImportService(c.env);
  const row = await svc.cancel((await loadImport(c, svc, a)).id, a);
  return c.json(await importJson(c.env, svc, row, { children: true }));
});

imports.post("/diffinery/imports/:id/retry", async (c) => {
  requireAccountScope(c, "write");
  const a = actor(c);
  const svc = new ImportService(c.env);
  const b = await body<{ github_token?: string | null }>(c).catch(() => ({}) as { github_token?: string | null });
  const row = await svc.retry((await loadImport(c, svc, a)).id, a, typeof b.github_token === "string" && b.github_token.trim() ? b.github_token.trim() : null);
  return c.json(await importJson(c.env, svc, row, { children: true }), 202);
});

/** Bulk drafts: choose the repositories, which starts the import. */
imports.post("/diffinery/imports/:id/selection", async (c) => {
  requireAccountScope(c, "write");
  const a = actor(c);
  const svc = new ImportService(c.env);
  const b = await body<{ repositories?: unknown }>(c);
  if (!Array.isArray(b.repositories) || b.repositories.some((r) => typeof r !== "string")) throw new HttpError(422, "repositories must be a list of names");
  const row = await svc.select(c.req.param("id"), a, b.repositories as string[]);
  return c.json(await importJson(c.env, svc, row, { children: true }), 202);
});

/** Local development and tests (IMPORT_GIT_AGENT=external): hand the Git transfer to an agent started by hand. */
imports.post("/diffinery/imports/:id/claim", async (c) => {
  const a = actor(c);
  return c.json(await new ImportService(c.env).claim(c.req.param("id"), a));
});

// ---------------------------------------------------------------- the import agent (push token only)

const agentAuth = (c: AppContext): { importId: string | undefined; tokenId: string | undefined } => {
  const p = c.get("principal");
  return p.type === "account" ? { importId: p.importId, tokenId: p.tokenId } : { importId: undefined, tokenId: undefined };
};

imports.get("/diffinery/imports/:id/agent/spec", async (c) => {
  const a = agentAuth(c);
  return c.json(await new ImportService(c.env).agentSpec(c.req.param("id"), a.importId, a.tokenId, credentialFrom(c.req.raw) ?? ""));
});

imports.post("/diffinery/imports/:id/agent/progress", async (c) => {
  const a = agentAuth(c);
  await new ImportService(c.env).agentProgress(c.req.param("id"), a.importId, a.tokenId, await body<ImportProgress>(c));
  return c.body(null, 204);
});

imports.post("/diffinery/imports/:id/agent/complete", async (c) => {
  const a = agentAuth(c);
  await new ImportService(c.env).agentComplete(c.req.param("id"), a.importId, a.tokenId, await body<ImportGitResult>(c));
  return c.body(null, 204);
});

// ---------------------------------------------------------------- linked GitHub accounts

imports.get("/diffinery/user/linked-accounts", async (c) => c.json(await new ImportService(c.env).links(actor(c).id)));

/** Step 1 of gist linking: the nonce the person must put in a PUBLIC gist. */
imports.post("/diffinery/user/linked-accounts/github/challenge", async (c) => {
  requireAccountScope(c, "admin");
  const a = actor(c);
  const b = await body<{ api_url?: string }>(c).catch(() => ({}) as { api_url?: string });
  return c.json(await new ImportService(c.env).linkChallenge(a, b.api_url ?? null));
});

/** Step 2: verify the gist contains the nonce and link the account. */
imports.post("/diffinery/user/linked-accounts/github", async (c) => {
  requireAccountScope(c, "admin");
  const a = actor(c);
  const b = await body<{ login?: string; api_url?: string }>(c);
  if (!b.login || typeof b.login !== "string") throw new HttpError(422, "login (your GitHub username) is required");
  return c.json(await new ImportService(c.env).linkByGist(a, b.login.trim(), b.api_url ?? null), 201);
});

imports.delete("/diffinery/user/linked-accounts/:id", async (c) => {
  requireAccountScope(c, "admin");
  await new ImportService(c.env).unlink(actor(c), c.req.param("id"));
  return c.body(null, 204);
});

/** Site admin: clear any account's GitHub link. */
imports.delete("/diffinery/admin/linked-accounts/:id", async (c) => {
  requireAccountScope(c, "admin");
  const a = actor(c);
  if (!a.site_admin) throw new HttpError(403, "site admin only");
  await new ImportService(c.env).clearLink(a, c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------- milestones

const P = (c: AppContext) => ({ owner: c.req.param("owner")!, repo: c.req.param("repo")! });
const num = (c: AppContext, name = "number") => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "not found");
  return n;
};


const milestoneJson = (c: AppContext, m: Milestone) => ({
  url: `${c.env.PUBLIC_URL}/api/v3/repos/${P(c).owner}/${P(c).repo}/milestones/${m.number}`,
  html_url: `${c.env.PUBLIC_URL}/${P(c).owner}/${P(c).repo}/issues?milestone=${m.number}`,
  id: m.number,
  number: m.number,
  title: m.title,
  description: m.description,
  state: m.state,
  creator: m.creator ? { login: m.creator } : null,
  open_issues: m.openIssues,
  closed_issues: m.closedIssues,
  created_at: m.createdAt,
  updated_at: m.updatedAt,
  closed_at: m.closedAt,
  due_on: m.dueOn,
});

const milestoneInput = (b: Record<string, unknown>) => {
  const out: { title?: string; description?: string; state?: "open" | "closed"; dueOn?: string | null } = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 255) throw new HttpError(422, "title must be 1 to 255 characters");
    out.title = b.title;
  }
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string" || b.description.length > 65536) throw new HttpError(422, "description must be a string");
    out.description = b.description;
  }
  if (b.state !== undefined) {
    if (b.state !== "open" && b.state !== "closed") throw new HttpError(422, "state must be open or closed");
    out.state = b.state;
  }
  if (b.due_on !== undefined) {
    if (b.due_on !== null && (typeof b.due_on !== "string" || Number.isNaN(Date.parse(b.due_on)))) throw new HttpError(422, "due_on must be an ISO 8601 timestamp");
    out.dueOn = b.due_on === null ? null : new Date(b.due_on as string).toISOString();
  }
  return out;
};

imports.get("/repos/:owner/:repo/milestones", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  const state = c.req.query("state") ?? "open";
  if (!["open", "closed", "all"].includes(state)) throw new HttpError(422, "state must be open, closed or all");
  const list = await stub.milestones(state as "open" | "closed" | "all");
  return c.json(list.map((m) => milestoneJson(c, m)));
});

imports.get("/repos/:owner/:repo/milestones/:number", async (c) => {
  const { stub } = await loadRepo(c, P(c).owner, P(c).repo);
  return c.json(milestoneJson(c, await stub.milestone(num(c))));
});

imports.post("/repos/:owner/:repo/milestones", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "triage");
  const input = milestoneInput(await body<Record<string, unknown>>(c));
  if (!input.title) throw new HttpError(422, "title is required");
  return c.json(milestoneJson(c, await stub.saveMilestone(null, input, caller.login)), 201);
});

imports.patch("/repos/:owner/:repo/milestones/:number", async (c) => {
  const { stub, caller } = await loadRepo(c, P(c).owner, P(c).repo, "triage");
  return c.json(milestoneJson(c, await stub.saveMilestone(num(c), milestoneInput(await body<Record<string, unknown>>(c)), caller.login)));
});

// ---------------------------------------------------------------- organization Actions variables

async function orgFor(c: AppContext, admin: boolean) {
  const a = actor(c);
  const dir = c.get("dir");
  const org = await dir.accountByLogin(c.req.param("org")!);
  if (!org || org.kind !== "org") throw new HttpError(404, "not found");
  const role = await dir.orgRole(org.id, a.kind === "agent" ? (a.owner_id ?? "") : a.id);
  const isMember = !!role || a.site_admin || (a.kind === "agent" && a.owner_id === org.id);
  if (!isMember) throw new HttpError(404, "not found");
  if (admin && (a.kind === "agent" || (role !== "owner" && role !== "admin" && !a.site_admin))) throw new HttpError(403, "organization admins only");
  return { a, org };
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

imports.get("/orgs/:org/actions/variables", async (c) => {
  // Low 2: variable values are readable only by an org owner/admin, not every member.
  const { org } = await orgFor(c, true);
  const vars = await c.get("dir").orgVariables(org.id);
  return c.json({ total_count: vars.length, variables: vars.map((v) => ({ name: v.name, value: v.value, visibility: "all", updated_at: v.updated_at, created_at: v.updated_at })) });
});

const putOrgVariable = async (c: AppContext, name: string, value: unknown) => {
  requireAccountScope(c, "admin");
  const { a, org } = await orgFor(c, true);
  if (!VAR_NAME.test(name) || /^GITHUB_/i.test(name)) throw new HttpError(422, "invalid variable name");
  if (typeof value !== "string" || value.length > 48 * 1024) throw new HttpError(422, "value must be a string of at most 48 KB");
  await c.get("dir").setOrgVariables(org.id, { [name]: value });
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "org.variable_set", target: org.login, detail: { name: name.toUpperCase(), via: "api" } }));
};

imports.post("/orgs/:org/actions/variables", async (c) => {
  const b = await body<{ name?: string; value?: string }>(c);
  await putOrgVariable(c, String(b.name ?? ""), b.value);
  return c.body(null, 201);
});

imports.patch("/orgs/:org/actions/variables/:name", async (c) => {
  await putOrgVariable(c, c.req.param("name"), (await body<{ value?: string }>(c)).value);
  return c.body(null, 204);
});

imports.get("/orgs/:org/actions/variables/:name", async (c) => {
  const { org } = await orgFor(c, true);
  const v = (await c.get("dir").orgVariables(org.id)).find((x) => x.name === c.req.param("name").toUpperCase());
  if (!v) throw new HttpError(404, "variable not found");
  return c.json({ name: v.name, value: v.value, visibility: "all", updated_at: v.updated_at, created_at: v.updated_at });
});

imports.delete("/orgs/:org/actions/variables/:name", async (c) => {
  requireAccountScope(c, "admin");
  const { a, org } = await orgFor(c, true);
  const name = c.req.param("name").toUpperCase();
  // Like GitHub: deleting a variable that doesn't exist is a 404, and nothing is audited.
  if (!(await c.get("dir").orgVariables(org.id)).some((v) => v.name === name)) throw new HttpError(404, "variable not found");
  await c.get("dir").setOrgVariables(org.id, { [name]: null });
  c.executionCtx.waitUntil(c.get("dir").audit({ actorId: a.id, actorLogin: a.login, action: "org.variable_delete", target: org.login, detail: { name, via: "api" } }));
  return c.body(null, 204);
});
