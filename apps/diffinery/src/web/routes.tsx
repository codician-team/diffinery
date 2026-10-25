/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppVars } from "../auth/principal.js";
import { registerAccount } from "./account.js";
import { registerAccountLifecycle } from "./account-lifecycle.js";
import { registerTasks } from "../agentic/tasks-web.js";
import { registerOrgAgents } from "../agentic/org-web.js";
import { registerReviews } from "../agentic/review-web.js";
import { registerProject } from "../agentic/project-web.js";
import { registerTerminals } from "../agentic/terminal-web.js";
import { registerMailWeb } from "../mail/web.js";
import { registerSecurityReports } from "./security-reports.js";
import { registerEarlyAccess } from "./early-access.js";
import { registerStatus } from "./status.js";
import { registerAuth } from "./auth.js";
import { registerCliLogin } from "./cli-login.js";
import { registerOAuth } from "./oauth.js";
import { registerActions } from "./actions.js";
import { registerCode } from "./code.js";
import { registerCollab } from "./collab.js";
import { registerReleases } from "./releases.js";
import { registerRepoSettings } from "./repo-settings.js";
import { registerAgentSetup } from "./agent-setup.js";
import { registerMergeOnGreen } from "./merge-on-green.js";
import { registerImports } from "./imports.js";
import { registerSeo } from "./seo.js";
import { registerSite } from "./site.js";
import { errorPage } from "./ui.js";
import { RESERVED_LOGINS } from "../lib/util.js";
import { registerPackages } from "./packages.js";
import { registerDocs } from "../docs/web.js";
import { registerModeration } from "./moderation.js";
import { registerApps } from "./apps.js";

/**
 * Server-rendered web UI. Mount at "/" after the API, Git and runner routes:
 * it owns `/`, `/docs/*`, `/llms.txt`, `/login`, `/auth/*`, `/signin`, `/signin/*`, `/new`, `/settings/*`, `/notifications/*`, `/invite/*`, `/-/*`,
 * `/:owner` and `/:owner/:repo/...` (including `/:owner/:repo/raw/*`).
 *
 * Expects the `principal` and `dir` variables to be set by an earlier middleware.
 * Every POST is CSRF-checked (double-submit cookie, see ./csrf.ts).
 */
export const web = new Hono<{ Bindings: Env; Variables: AppVars }>();

web.onError((err, c) => errorPage(c, err));

/**
 * A limited API token (read or write scope, or limited to some repositories) reaches the web only
 * for repository pages (/:owner/:repo/...), where loadRepo applies its scope and repository limits as
 * the API does. Everywhere else (the dashboard, the command palette, notifications, profiles,
 * settings, site administration) it would see what the API refuses it, so those pages treat it as
 * signed out. An unlimited admin token can already read all of that through the API.
 */
export function tokenMayUseWebPage(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  return segs.length >= 2 && !RESERVED_LOGINS.has(segs[0]!.toLowerCase()) && segs[1] !== "-";
}

web.use("*", async (c, next) => {
  const p = c.get("principal");
  const limited = p.type === "account" && p.via === "token" && (!!p.repoIds || !p.scopes.includes("admin"));
  if (limited && !tokenMayUseWebPage(c.req.path)) c.set("principal", { type: "anonymous" });
  await next();
});

// Browsers and crawlers ask for these on every origin; keep them off the /:owner route.
registerSeo(web);
// Public docs (/docs, /llms.txt, ...): before /:owner/:repo, which would otherwise match /docs/<page>.
registerDocs(web);
// The product, comparison and company pages (/features, /compare/github, ...) and /index.md: before /:owner.
registerSite(web);

// Order matters: fixed paths (/settings/tokens, /notifications/:id, …) must be
// registered before the /:owner/:repo patterns they would otherwise match.
registerAuth(web);
registerCliLogin(web);
registerOAuth(web);
registerPackages(web);
registerMailWeb(web);
registerSecurityReports(web);
registerEarlyAccess(web);
// /status: before the /:owner catch-all.
registerStatus(web);
// Before registerAccount: its /:owner catch-all would otherwise swallow /imports, /new/import and /settings/linked-accounts.
registerImports(web);
// Settings → Model access and /:owner/:repo/tasks: before the /:owner and /:owner/:repo catch-alls.
registerTasks(web);
registerOrgAgents(web);
registerReviews(web);
registerProject(web);
registerTerminals(web);
// Settings → Account and the account pages of site administration: fixed /settings paths, before /:owner.
registerAccountLifecycle(web);
// Settings → Apps and Installed apps, and /apps/:slug: fixed paths, before /:owner.
registerApps(web);
// /-/report and /:owner/:repo/comments/:id/...: before the /:owner and /:owner/:repo catch-alls.
registerModeration(web);
registerAccount(web);
// Settings → Agent setup: also for people with write access, so before the admin-only settings pages.
registerAgentSetup(web);
registerMergeOnGreen(web);
registerRepoSettings(web);
registerActions(web);
registerReleases(web);
registerCollab(web);
registerCode(web);
