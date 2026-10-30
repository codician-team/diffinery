import type { DiffineryEvent } from "@diffinery/shared";
import type { Env } from "./env.js";
import type { MailJob } from "./mail/types.js";
import { app, queue, scheduled } from "./app.js";
import { apiNotFound } from "./http/common.js";
import { web } from "./web/routes.js";

export { RepoDO } from "./repo/RepoDO.js";
export { SchedulerDO } from "./scheduler.js";
export { ComposeDO } from "./compose.js";
export { RateLimiterDO } from "./rate-limiter.js";
export { RunnerContainer, RunnerContainerMedium, RunnerContainerSmall, RunnerContainerTiny, SandboxContainer, SandboxPoolDO } from "./runner/containers.js";
export { RunWorkflow } from "./runner/workflow.js";
export { ImportWorkflow } from "./imports/workflow.js";
export { AccountWorkflow } from "./accounts/workflow.js";
export { ImportContainer } from "./imports/container.js";
export { ProjectDO } from "./agentic/ProjectDO.js";
export { GitHubRunnersDO } from "./github-runners/GitHubRunnersDO.js";
// Carries hosted containers' HTTP and HTTPS out under EGRESS=web (lib/egress.ts).
export { ContainerProxy } from "@cloudflare/containers";

// The web UI is mounted last so API, git and runner routes take precedence;
// unknown API paths answer in JSON rather than falling through to its HTML 404.
app.all("/api/*", () => apiNotFound());
app.route("/", web);

export default {
  fetch: app.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<Env, DiffineryEvent | MailJob>;
