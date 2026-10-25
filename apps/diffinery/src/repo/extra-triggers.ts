import { matchesTrigger } from "@diffinery/workflow-yaml";
import type { RepoDO } from "./RepoDO.js";
import { isJobCaller } from "./token-policy.js";
import type { Caller } from "./types.js";

/**
 * Start the workflows that listen for an activity event other than push and
 * pull_request (`release`, `repository_dispatch`), reading the workflow files
 * at `sha`. `types:` filters match `action`. Like GitHub, events caused by a
 * job's own token (GITHUB_TOKEN) start no new runs, so workflows can't loop;
 * repository_dispatch is the exception, as on GitHub.
 */
export async function triggerWorkflows(
  repo: RepoDO,
  ev: { name: string; action?: string; ref: string; sha: string; payload: Record<string, unknown>; title: string },
  caller: Caller,
): Promise<number> {
  if (isJobCaller(caller) && ev.name !== "repository_dispatch") return 0;
  let started = 0;
  let payload: Record<string, unknown> | undefined;
  try {
    for (const w of await repo.actions.loadWorkflows(ev.sha)) {
      if (!w.workflow || !matchesTrigger(w.workflow, { name: ev.name, action: ev.action })) continue;
      // Every event payload carries GitHub's repository object (with its real visibility) and a sender.
      payload ??= { ...ev.payload, repository: await repo.actions.repositoryPayload(), sender: ev.payload.sender ?? { login: caller.login, type: caller.kind === "user" ? "User" : "Bot" } };
      await repo.actions.createRun(w.workflow, { event: ev.name, ref: ev.ref, sha: ev.sha, payload, caller, title: ev.title });
      started++;
    }
  } catch (e) {
    console.warn(`${ev.name} trigger failed`, e);
  }
  return started;
}
