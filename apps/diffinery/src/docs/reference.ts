/**
 * Reference material generated from the running code: the REST API (from the
 * router itself, plus the notes in ./api-meta.ts) and the MCP tools (from the
 * MCP server's tool list). Nothing here is written by hand per endpoint or per
 * tool, so the docs can't fall behind the code.
 */
import { app } from "../app.js";
import { mcpTools, PROTOCOL_VERSIONS } from "../mcp/server.js";
import { ACCOUNT_SCOPES, API_DOCS, type Access, type Field, type OpDoc, type Scope } from "./api-meta.js";

export const API_BASE = "/api/v3";

export interface ApiOperation {
  method: string;
  /** OpenAPI-style path relative to /api/v3, like /repos/{owner}/{repo}. */
  path: string;
  params: string[];
  tag: string;
  doc: OpDoc;
  /** False when the summary was derived from the method and path. */
  documented: boolean;
  /** The least token scope that may call it, and whether the token must cover every repository. */
  scope: Scope;
  accountWide: boolean;
  /** No token may call it: only a browser session. */
  sessionOnly: boolean;
}

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Hono path → OpenAPI path: `:name{regex}` and `:name` → `{name}`, a trailing `*` → `{path}`. */
export function openApiPath(honoPath: string): string {
  return honoPath.replace(/:(\w+)(\{[^}]*\})?/g, "{$1}").replace(/\/\*$/, "/{path}");
}

/** Groups, in the order the reference lists them. The first matching rule wins. */
const TAGS: Array<[string, RegExp]> = [
  ["Meta", /^\/(meta|rate_limit)?$/],
  ["Users", /^\/users?(\/\{login\})?$|^\/user\/(orgs|avatar)$/],
  ["Organizations", /^\/orgs\/\{org\}(\/(members|invitations(\/\{id\})?|avatar))?$|^\/invitations(\/\{id\})?$/],
  ["Search", /^\/search\//],
  ["Repositories", /^\/(user|users\/\{login\}|orgs\/\{org\})\/repos$|^\/repos\/\{owner\}\/\{repo\}(\/(collaborators|invitations|assignees|languages|topics|dispatches)(\/|$)|$)/],
  ["Contents", /\/(contents|raw|readme|tarball|zipball|diffinery\/commits)(\/|$)/],
  ["Releases", /\/releases(\/|$)/],
  ["Git database", /\/git\/(blobs|trees|commits|tags|refs|ref|matching-refs)(\/|$)/],
  ["Branches and tags", /\/(branches|tags|merges)(\/|$)(?!.*protection)/],
  ["Commit statuses", /\/statuses\/|\/commits\/\{ref\}\/status(es)?$/],
  ["Checks", /\/check-(runs|suites)/],
  ["Commits", /\/(commits|compare)(\/|$)/],
  ["Branch protection", /\/protection$/],
  ["Issues", /\/(issues|labels|milestones)(\/|$)/],
  ["Pull requests", /\/pulls(\/|$)(?!.*merge-queue)/],
  ["Merge queue", /\/merge-queue/],
  ["Deployments", /\/deployments(\/|$)/],
  ["Environments", /\/environments(\/|$)/],
  ["Actions secrets and variables", /\/actions\/(secrets|variables)/],
  ["Actions artifacts and caches", /\/actions\/(artifacts|caches?)(\/|$)|\/actions\/runs\/\{runId\}\/artifacts$/],
  ["Actions", /\/actions\//],
  ["Webhooks", /\/hooks(\/|$)/],
  ["Packages", /\/packages(\/|$)/],
  ["Imports", /^\/diffinery\/(imports|user\/linked-accounts|admin\/linked-accounts)(\/|$)/],
  ["Status page", /^\/diffinery\/(admin\/)?status(\/|$)/],
  ["Notifications and email", /^\/notifications$|\/subscription$|\/diffinery\/(notification-settings|emails|admin)/],
  ["Tokens and agents", /\/diffinery\/(tokens|agents)/],
  ["Sandboxes", /\/diffinery\/sandboxes/],
];
export const TAG_ORDER = [...TAGS.map(([t]) => t), "Other"];

function tagFor(path: string): string {
  for (const [tag, re] of TAGS) if (re.test(path)) return tag;
  return "Other";
}

const words = (s: string) => s.replace(/[-_]/g, " ");
const singular = (s: string) => s.replace(/ies$/, "y").replace(/(ss)$/, "$1").replace(/s$/, "");

/** A readable summary for an endpoint nobody has written notes for yet. */
export function derivedSummary(method: string, path: string): string {
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  const endsWithParam = last.startsWith("{");
  const noun = words([...segs].reverse().find((s) => !s.startsWith("{")) ?? "resource");
  const one = `a ${singular(noun)}`;
  switch (method) {
    case "GET":
      return endsWithParam ? `Get ${one}` : `List ${noun}`;
    case "POST":
      return endsWithParam ? `Run ${words(last.slice(1, -1))} on ${one}` : `Create ${one}`;
    case "PUT":
      return endsWithParam ? `Set ${one}` : `Set ${noun}`;
    case "PATCH":
      return `Update ${endsWithParam ? one : noun}`;
    case "DELETE":
      return `Delete ${endsWithParam ? one : noun}`;
    default:
      return `${method} ${path}`;
  }
}

let opsCache: ApiOperation[] | null = null;

/** Every REST endpoint the Worker serves under /api/v3. */
export function apiOperations(): ApiOperation[] {
  if (opsCache) return opsCache;
  const seen = new Set<string>();
  const ops: ApiOperation[] = [];
  for (const r of app.routes) {
    if (!METHOD_ORDER.includes(r.method) || !(r.path === API_BASE || r.path.startsWith(`${API_BASE}/`))) continue;
    const path = openApiPath(r.path.slice(API_BASE.length)) || "/";
    const key = `${r.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = API_DOCS[key];
    ops.push({
      method: r.method,
      path,
      params: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!),
      tag: tagFor(path),
      doc: doc ?? { summary: derivedSummary(r.method, path) },
      documented: !!doc,
      // A token's scope also caps its repository role (write → maintain), so admin endpoints need an admin token.
      scope: ACCOUNT_SCOPES[key]?.scope ?? (doc?.access === "admin" ? "admin" : r.method === "GET" ? "read" : "write"),
      accountWide: !!ACCOUNT_SCOPES[key] && !ACCOUNT_SCOPES[key]!.anyToken,
      sessionOnly: !!ACCOUNT_SCOPES[key]?.sessionOnly,
    });
  }
  ops.sort((a, b) => TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag) || a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
  // Only cache once the web UI is mounted too (index.ts mounts it after app.ts loads).
  if (ops.length) opsCache = ops;
  return ops;
}

export const ACCESS_TEXT: Record<Access, string> = {
  public: "No authentication needed.",
  account: "Any active account (a token, or a browser session).",
  read: "Read access to the repository. Public repositories allow anyone to read.",
  triage: "Triage access to the repository.",
  write: "Write access to the repository.",
  maintain: "Maintain access to the repository.",
  admin: "Admin access to the repository (or to the package).",
  "org-admin": "An owner or admin of the organization (or a site admin).",
  "org-owner": "An owner of the organization (or a site admin).",
  "site-admin": "A site administrator.",
};

/** What a personal access token needs; browser sessions always have full scope. */
export function scopeText(op: Pick<ApiOperation, "scope" | "accountWide" | "sessionOnly" | "doc">): string {
  if (op.doc.access === "public") return "";
  if (op.sessionOnly) return "No token can call it: it needs a browser session.";
  return `Tokens need the \`${op.scope}\` scope${op.accountWide ? " and access to all repositories" : ""}.`;
}

const PARAM_TEXT: Record<string, string> = {
  owner: "Account (user or organization) that owns the repository or package.",
  repo: "Repository name.",
  org: "Organization login.",
  login: "Account login.",
  number: "Issue or pull request number.",
  branch: "Branch name (for protection rules: a branch name or pattern).",
  ref: "Branch, tag or commit SHA.",
  path: "Path inside the repository, or a ref name after `refs/`.",
  spec: "Two refs as `base...head`.",
  id: "Identifier.",
  name: "Name.",
  type: "Package type: `container`.",
  workflow: "Workflow file path (URL-encoded) or file name.",
  runId: "Workflow run id, or the run number (`github.run_id`).",
  format: "Archive format: `zip`.",
  action: "Action to take.",
};

const EXAMPLE: Record<string, string> = { owner: "acme", repo: "website", org: "acme", login: "diffy", number: "42", branch: "main", ref: "main", path: "README.md", spec: "main...feature", type: "container", name: "website", workflow: "ci.yml", action: "exec", runId: "42", format: "zip" };

function curl(origin: string, op: ApiOperation): string {
  const url = `${origin}${API_BASE}${op.path === "/" ? "" : op.path.replace(/\{(\w+)\}/g, (_, p: string) => EXAMPLE[p] ?? (p === "id" ? "1" : p))}`;
  const lines = [`curl${op.method === "GET" ? "" : ` -X ${op.method}`} "${url}"`];
  if (op.doc.access !== "public") lines.push(`  -H "Authorization: Bearer $DIFFINERY_TOKEN"`);
  const required = Object.entries(op.doc.body ?? {}).filter(([, f]) => f[2]);
  if (required.length) {
    const sample = Object.fromEntries(required.map(([k, f]) => [k, f[0] === "string[]" ? ["..."] : f[0] === "array" ? [] : f[0] === "object" ? {} : f[0] === "integer" ? 1 : f[0] === "boolean" ? true : "..."]));
    lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(sample)}'`);
  }
  return lines.join(" \\\n");
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function fieldTable(title: string, fields: Record<string, Field>): string[] {
  return [`${title}:`, "", "| Name | Type | Required | Description |", "| --- | --- | --- | --- |", ...Object.entries(fields).map(([k, [t, d, req]]) => `| \`${k}\` | ${t} | ${req ? "yes" : "no"} | ${cell(d)} |`), ""];
}

/** The /docs/api page: every endpoint, grouped, with parameters and an example. */
export function apiReferenceMarkdown(origin: string): string {
  const ops = apiOperations();
  const byTag = new Map<string, ApiOperation[]>();
  for (const op of ops) byTag.set(op.tag, [...(byTag.get(op.tag) ?? []), op]);
  const used = new Set<string>();
  const heading = (op: ApiOperation) => {
    let h = op.doc.summary;
    if (used.has(h.toLowerCase())) h = `${h} (${op.method} ${op.path.replace(/[{}]/g, "")})`;
    used.add(h.toLowerCase());
    return h;
  };
  const out: string[] = [
    `Every endpoint of the Diffinery REST API, generated from the server's router, so this list always matches what \`${origin}${API_BASE}\` serves. The same information is available as an [OpenAPI 3.1 document](/docs/api/openapi.json). For authentication, errors, pagination and GitHub compatibility, read the [REST API guide](/docs/reference/rest-api).`,
    "",
    "## Basics",
    "",
    `- Base URL: \`${origin}${API_BASE}\``,
    "- Authenticate with a personal access token: `Authorization: Bearer dfy_...` (`token dfy_...` and HTTP Basic with the token as the password work too). Create one under *Settings → Access tokens*.",
    "- Send and receive JSON. Errors are JSON objects with a `message` and a `documentation_url`, unknown paths included (404).",
    "- Reads of public repositories need no token. Every write needs a signed-in caller (401 otherwise) and, from a token, the `write` scope (403 otherwise). A token's scope also caps its role on a repository: `read` reads, `write` acts up to maintain, `admin` acts as admin. Each endpoint below says which scope it needs.",
    "- A private repository you can't see is a 404, whatever the method, so a read token's write to it doesn't reveal that it exists.",
    "- An archived repository refuses every write with 403 `repository is archived (read-only)`, except unarchiving it (`PATCH` with `archived: false`), deleting it and watching it.",
    "- A workflow job's `GITHUB_TOKEN` follows the job's `permissions:` instead of token scopes: each endpoint needs its permission (`contents`, `issues`, `pull-requests`, `actions` and so on), and settings, secrets, variables, webhooks and branch protection are out of its reach. See [Workflow permissions](/docs/actions/workflow-permissions).",
    "- Paths, field names and status codes follow GitHub's REST API wherever Diffinery has the same feature, so most GitHub clients work with `baseUrl` set to the URL above.",
    `- ${ops.length} endpoints in ${byTag.size} groups.`,
    "",
    "## Endpoints by group",
    "",
    ...[...byTag.entries()].map(([tag, list]) => `- [${tag}](#${slug(tag)}) (${list.length})`),
    "",
  ];
  for (const [tag, list] of byTag) {
    out.push(`## ${tag}`, "", "| Method | Path | Summary |", "| --- | --- | --- |");
    const heads = list.map((op) => heading(op));
    list.forEach((op, i) => out.push(`| ${op.method} | \`${op.path}\` | [${cell(op.doc.summary)}](#${slug(heads[i]!)}) |`));
    out.push("");
    list.forEach((op, i) => {
      out.push(`### ${heads[i]}`, "", "```http", `${op.method} ${API_BASE}${op.path === "/" ? "" : op.path}`, "```", "");
      if (op.doc.description) out.push(op.doc.description, "");
      out.push(`**Access:** ${[ACCESS_TEXT[op.doc.access ?? "read"], scopeText(op)].filter(Boolean).join(" ")}${op.doc.status ? ` **Success:** \`${op.doc.status}\`.` : ""}`, "");
      if (op.params.length) out.push(...fieldTable("Path parameters", Object.fromEntries(op.params.map((p) => [p, ["string", PARAM_TEXT[p] ?? p, true] as Field]))));
      if (op.doc.query) out.push(...fieldTable("Query parameters", op.doc.query));
      if (op.doc.body) out.push(...fieldTable("Body (JSON)", op.doc.body));
      out.push("```sh", curl(origin, op), "```", "");
    });
  }
  out.push(
    "## Other HTTP endpoints",
    "",
    "These aren't part of the JSON API, but clients and tools talk to them directly.",
    "",
    "| Endpoint | What it is |",
    "| --- | --- |",
    ...OTHER_ENDPOINTS.map(([path, what]) => `| \`${path}\` | ${what} |`),
    "",
  );
  return out.join("\n");
}

/** Non-API endpoints worth knowing. A unit test checks that each one is still routed. */
export const OTHER_ENDPOINTS: Array<[string, string]> = [
  ["GET /{owner}/{repo}.git/info/refs", "Git smart HTTP: ref advertisement (`git clone`, `git fetch`, `git push`). Authenticate with a token as the password. See [Git](/docs/repositories/git)."],
  ["POST /{owner}/{repo}.git/git-upload-pack", "Git smart HTTP: fetch and clone."],
  ["POST /{owner}/{repo}.git/git-receive-pack", "Git smart HTTP: push."],
  ["POST /{owner}/{repo}.git/info/lfs/objects/batch", "Git LFS batch API. See [Git LFS](/docs/repositories/git-lfs)."],
  ["GET, PUT /{owner}/{repo}.git/info/lfs/objects/{oid}", "Git LFS object download and upload."],
  ["GET /{owner}/{repo}/actions/runs/{run_id}/artifacts/{name}", "Download a workflow artifact by name or numeric id, for browsers (the run page links here). Serves a zip, the file itself for an artifact uploaded as a single unzipped file, or a `.tar.gz` for an artifact from an older runner. Expired artifacts aren't served."],
  ["GET /{owner}/{repo}/agent-setup.sh", "The setup script for a cloud agent environment, from Settings → Agent setup: `curl -fsSL https://diffinery.com/{owner}/{repo}/agent-setup.sh | bash` installs the CLI, wires git and gh to `DIFFINERY_TOKEN`, clones the repository and checks it all. The same script for anyone, with no secret in it. See [Cloud agent environments](/docs/connect/cloud-agents)."],
  ["POST /mcp", "The MCP server (Streamable HTTP, JSON-RPC). See [MCP](/docs/agents/mcp) and the [MCP tool reference](/docs/reference/mcp-tools)."],
  ["GET /.well-known/oauth-protected-resource/mcp", "OAuth protected resource metadata for the MCP server (RFC 9728); also at `/.well-known/oauth-protected-resource`. See [How sign-in works](/docs/connect/how-sign-in-works)."],
  ["GET /.well-known/oauth-authorization-server", "OAuth authorization server metadata (RFC 8414) for MCP clients' browser sign-in."],
  ["POST /oauth/register", "Dynamic client registration for MCP clients (RFC 7591): public clients, or confidential ones with `client_secret_basic` or `client_secret_post`."],
  ["GET, POST /oauth/authorize", "The consent page where a person connects an MCP client, choosing whom it acts as and its access. Authorization code with PKCE (S256) only."],
  ["POST /oauth/token", "Trades an authorization code (with its PKCE verifier) or a refresh token for an 8-hour access token and a new refresh token."],
  ["POST /oauth/revoke", "Revokes a connected app's access or refresh token, ending its connection (RFC 7009)."],
  ["/v2/...", "The OCI container registry (Docker Registry HTTP API v2). See [Container registry](/docs/packages/container-registry)."],
  ["GET /.well-known/openid-configuration", "OIDC discovery for workflow ID tokens. See [OIDC](/docs/actions/oidc)."],
  ["GET /.well-known/jwks", "Public keys that sign workflow ID tokens."],
  ["GET /.well-known/security.txt", "Where to report a vulnerability (RFC 9116): this instance's report form first, then any `SECURITY_CONTACT` entries. See [Reporting a vulnerability](/docs/security/disclosure)."],
  ["GET /.well-known/mcp-registry-auth", "The proof record that lets this instance's MCP server be published to the official MCP registry under its domain; 404 until `MCP_REGISTRY_AUTH` is set. See [MCP](/docs/agents/mcp#list-your-instance-in-the-mcp-registry)."],
  ["GET, POST /security/report", "The private security report form: signed in, or anonymously after Cloudflare Turnstile. Only site administrators can read reports. See [Reporting a vulnerability](/docs/security/disclosure)."],
  ["POST /-/github/webhook", "The GitHub App's webhook for [GitHub runners](/docs/actions/github-runners): queued `workflow_job` deliveries start Diffinery runners for GitHub jobs. Signed with `GITHUB_APP_WEBHOOK_SECRET` (`X-Hub-Signature-256`); 404 until the app is configured. See [Configuration](/docs/self-hosting/configuration#github-runners)."],
  ["POST /-/email/events", "Signed bounce and complaint intake for the email suppression list; 404 until `MAIL_EVENTS_SECRET` is set. See [Site administration](/docs/admin/site-administration#bounces-complaints-and-the-suppression-list)."],
  ["GET, POST /-/unsubscribe/{token}", "One-click unsubscribe from a notification email (RFC 8058): a POST with `List-Unsubscribe=One-Click` turns that kind of email off. See [Notifications](/docs/accounts/notifications)."],
  ["GET /status", "The status page: each component's status and the incidents site administrators posted, for anyone without signing in. As JSON at `GET /api/v3/diffinery/status`. See [Status page](/docs/self-hosting/status-page)."],
  ["GET /healthz", "Health check: `{\"ok\": true}`. Point an external uptime monitor at it: the status page can't report the whole Worker being down."],
  ["GET /llms.txt", "Index of these docs for AI agents. See [Docs for AI agents](/docs/agents/docs-for-agents)."],
  ["GET /llms-full.txt", "All of these docs in one Markdown file."],
  ["GET /docs/{page}.md", "Any docs page as Markdown."],
  ["GET /docs/api/openapi.json", "This reference as an OpenAPI 3.1 document."],
];

// Same rules as slugify() in src/web/markdown.ts.
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

// ---------------------------------------------------------------- OpenAPI

function schemaFor(type: string): Record<string, unknown> {
  if (type.endsWith("[]")) return { type: "array", items: schemaFor(type.slice(0, -2)) };
  if (["string", "integer", "boolean", "object", "array", "number"].includes(type)) return { type };
  return {};
}

/** The REST API as an OpenAPI 3.1 document. */
export function openApiDocument(origin: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of apiOperations()) {
    const params = [
      ...op.params.map((p) => ({ name: p, in: "path", required: true, description: PARAM_TEXT[p] ?? p, schema: { type: "string" } })),
      ...Object.entries(op.doc.query ?? {}).map(([name, [t, d, req]]) => ({ name, in: "query", required: !!req, description: d, schema: schemaFor(t) })),
    ];
    const body = op.doc.body
      ? {
          required: Object.values(op.doc.body).some((f) => f[2]),
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: Object.fromEntries(Object.entries(op.doc.body).map(([k, [t, d]]) => [k, { ...schemaFor(t), description: d }])),
                required: Object.entries(op.doc.body)
                  .filter(([, f]) => f[2])
                  .map(([k]) => k),
              },
            },
          },
        }
      : undefined;
    const ok = String(op.doc.status ?? 200);
    const access = op.doc.access ?? "read";
    (paths[op.path] ??= {})[op.method.toLowerCase()] = {
      operationId: operationId(op),
      summary: op.doc.summary,
      description: [op.doc.description, `Access: ${[ACCESS_TEXT[access], scopeText(op)].filter(Boolean).join(" ")}`].filter(Boolean).join("\n\n"),
      tags: [op.tag],
      ...(params.length ? { parameters: params } : {}),
      ...(body ? { requestBody: body } : {}),
      ...(access === "public" ? { security: [] } : {}),
      "x-diffinery-access": access,
      "x-diffinery-token-scope": op.sessionOnly ? "none" : op.scope,
      responses: {
        [ok]: { description: ok === "204" ? "No content" : "Success", ...(ok === "204" || ok === "205" ? {} : { content: { "application/json": { schema: {} } } }) },
        default: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Diffinery REST API",
      version,
      description: `The Diffinery REST API, generated from the server's router. Paths and payloads follow GitHub's REST API v3 where Diffinery has the same feature. Guide: ${origin}/docs/reference/rest-api`,
    },
    externalDocs: { description: "Diffinery docs", url: `${origin}/docs` },
    servers: [{ url: `${origin}${API_BASE}` }],
    security: [{ token: [] }],
    tags: TAG_ORDER.filter((t) => apiOperations().some((o) => o.tag === t)).map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        token: { type: "http", scheme: "bearer", description: "A Diffinery personal access token (`dfy_...`) from Settings → Access tokens. `Authorization: token dfy_...` and HTTP Basic (token as the password) also work." },
      },
      schemas: {
        Error: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
    },
  };
}

function operationId(op: ApiOperation): string {
  const parts = op.path
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("{") ? `by-${s.slice(1, -1)}` : s));
  return [op.method.toLowerCase(), ...parts]
    .join("-")
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, ch: string) => ch.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
}

// ---------------------------------------------------------------- MCP tools

const MCP_GROUPS: Array<[string, RegExp]> = [
  ["Identity and repositories", /^(whoami|list_repos)$/],
  ["Code", /^(list_tree|get_file|search_code|commit_files)$/],
  ["Branches and commits", /branch|commit|compare/],
  ["Pull requests", /pull_request|review|merge/],
  ["Issues", /issue|comment|label/],
  ["Actions", /workflow|run|job|artifact/],
  ["Releases", /release/],
  ["Imports", /import/],
  ["Sandboxes", /sandbox/],
  ["Docs", /docs/],
];

function mcpGroup(name: string): string {
  for (const [g, re] of MCP_GROUPS) if (re.test(name)) return g;
  return "Other";
}

type JsonSchemaProp = { type?: string; description?: string; enum?: string[]; items?: unknown };

/** The /docs/reference/mcp-tools page. */
export function mcpToolsMarkdown(origin: string): string {
  const tools = mcpTools();
  const groups = new Map<string, typeof tools>();
  for (const g of [...MCP_GROUPS.map(([n]) => n), "Other"]) groups.set(g, []);
  for (const t of tools) groups.get(mcpGroup(t.name))!.push(t);
  for (const [g, list] of groups) if (!list.length) groups.delete(g);
  const out: string[] = [
    `Every tool the Diffinery MCP server offers, generated from the server's own tool list, so it always matches what \`tools/list\` returns. For setup in Claude Code, Cursor and other clients, read [MCP](/docs/agents/mcp).`,
    "",
    "## Connection",
    "",
    `- Endpoint: \`${origin}/mcp\` (Streamable HTTP; responses are JSON, not event streams).`,
    "- Authentication: `Authorization: Bearer dfy_...`, a token for an agent or a person. Every call needs an active account.",
    `- Protocol versions: ${PROTOCOL_VERSIONS.map((v) => `\`${v}\``).join(", ")}. The server answers with the version the client asks for when it supports it, else the newest.`,
    "- Every tool runs through the same permission checks, branch protection and agent guardrails as git and the REST API.",
    "- Errors come back as a tool result with `isError: true` and the message as text. Successful results carry the JSON both as text and as `structuredContent`.",
    "",
    "## Tools",
    "",
    "| Tool | Read-only | Summary |",
    "| --- | --- | --- |",
    ...tools.map((t) => `| [\`${t.name}\`](#${slug(t.name)}) | ${t.annotations.readOnlyHint ? "yes" : "no"} | ${cell(firstSentence(t.description))} |`),
    "",
  ];
  for (const [g, list] of groups) {
    out.push(`## ${g}`, "");
    for (const t of list) {
      out.push(`### ${t.name}`, "", t.description, "", `Read-only: ${t.annotations.readOnlyHint ? "yes" : "no"}.`, "");
      const props = Object.entries(t.inputSchema.properties as Record<string, JsonSchemaProp>);
      if (props.length) {
        out.push("| Argument | Type | Required | Description |", "| --- | --- | --- | --- |");
        for (const [k, p] of props) {
          const type = p.type === "array" && p.items && typeof p.items === "object" ? `array of ${(p.items as { type?: string }).type ?? "object"}` : (p.type ?? "any");
          out.push(`| \`${k}\` | ${type}${p.enum ? ` (${p.enum.map((e) => `\`${e}\``).join(", ")})` : ""} | ${t.inputSchema.required.includes(k) ? "yes" : "no"} | ${cell(p.description ?? "")} |`);
        }
        out.push("");
      } else out.push("No arguments.", "");
      const args = Object.fromEntries(t.inputSchema.required.map((k) => [k, EXAMPLE[k] ?? (k.includes("number") ? 42 : "...")]));
      out.push("```json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: t.name, arguments: args } }), "```", "");
    }
  }
  return out.join("\n");
}

function firstSentence(s: string): string {
  const m = /^(.+?\.)(\s|$)/.exec(s);
  return m ? m[1]! : s;
}
