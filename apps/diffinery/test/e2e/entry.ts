// Worker entry for end-to-end tests while the web UI is optional: same app, no HTML routes.
import type { DiffineryEvent } from "@diffinery/shared";
import type { Env } from "../../src/env.js";
import type { MailJob } from "../../src/mail/types.js";
import { app, queue, scheduled } from "../../src/app.js";

export { RepoDO } from "../../src/repo/RepoDO.js";
export { SchedulerDO } from "../../src/scheduler.js";
export { ComposeDO } from "../../src/compose.js";
export { RunnerContainer, RunnerContainerMedium, RunnerContainerSmall, RunnerContainerTiny, SandboxContainer } from "../../src/runner/containers.js";
export { RunWorkflow } from "../../src/runner/workflow.js";
export { ImportWorkflow } from "../../src/imports/workflow.js";
export { AccountWorkflow } from "../../src/accounts/workflow.js";
export { ImportContainer } from "../../src/imports/container.js";

export default { fetch: app.fetch, queue, scheduled } satisfies ExportedHandler<Env, DiffineryEvent | MailJob>;
