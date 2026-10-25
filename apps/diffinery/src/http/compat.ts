import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AppVars } from "../auth/principal.js";
import { deployments } from "./deployments.js";
import { gitdata } from "./gitdata.js";
import { issues } from "./issues.js";
import { misc } from "./misc.js";
import { moderation } from "./moderation.js";
import { releases } from "./releases.js";
import { search } from "./search.js";
import { statuses } from "./statuses.js";

/**
 * GitHub-compatible REST endpoints beyond the core in ./api.ts, so Octokit,
 * `gh api`, actions/github-script and marketplace actions work unchanged.
 * Mounted at the top of the /api/v3 app.
 */
export const compat = new Hono<{ Bindings: Env; Variables: AppVars }>();

// Headers GitHub clients look at: API version and media type, and a (generous, unmetered) rate limit.
compat.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("x-github-media-type", "github.v3; format=json");
  h.set("x-github-api-version-selected", "2022-11-28");
  if (!h.has("x-ratelimit-limit")) {
    h.set("x-ratelimit-limit", "15000");
    h.set("x-ratelimit-remaining", "15000");
    h.set("x-ratelimit-used", "0");
    h.set("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 3600));
    h.set("x-ratelimit-resource", "core");
  }
});

compat.route("/", releases);
compat.route("/", statuses);
compat.route("/", gitdata);
compat.route("/", issues);
compat.route("/", deployments);
compat.route("/", search);
compat.route("/", misc);
compat.route("/", moderation);
