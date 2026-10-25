import type { DiffineryEvent } from "@diffinery/shared";
import { ghRepo, nodeId, numericId } from "../http/gh.js";
import type { Repo } from "./directory.js";

/**
 * The JSON body of a webhook delivery, shaped like GitHub's. `row` is the
 * repository's directory row; it gives the full repository object with the real
 * `private` and `visibility`. Without it (a deleted repository) the object is
 * minimal and reported as private.
 */
export function webhookPayload(publicUrl: string, ev: Exclude<DiffineryEvent, { type: "audit" }>, row: Repo | null) {
  const repository = row
    ? ghRepo(publicUrl, row)
    : { id: numericId(ev.repoId), node_id: nodeId("Repository", ev.repoId), name: ev.repo, full_name: `${ev.owner}/${ev.repo}`, owner: { login: ev.owner }, private: true, visibility: "private", html_url: `${publicUrl}/${ev.owner}/${ev.repo}`, clone_url: `${publicUrl}/${ev.owner}/${ev.repo}.git` };
  const sender = { id: ev.actor.id, login: ev.actor.login, type: ev.actor.kind === "agent" ? "Bot" : ev.actor.kind === "system" ? "Bot" : "User", on_behalf_of: ev.actor.onBehalfOf };
  const { type: _t, repoId: _r, owner: _o, repo: _n, actor: _a, ...rest } = ev;
  const action = "action" in ev ? (ev.action === "merged" ? "closed" : ev.action) : undefined;
  const extra: Record<string, unknown> = {};
  if (ev.type === "pull_request") {
    extra.pull_request = { number: ev.number, html_url: `${publicUrl}/${ev.owner}/${ev.repo}/pull/${ev.number}`, head: { ref: ev.headRef, sha: ev.headSha }, base: { ref: ev.baseRef }, merged: ev.action === "merged" };
  }
  if (ev.type === "issues" || ev.type === "issue_comment") extra.issue = { number: ev.number, html_url: `${publicUrl}/${ev.owner}/${ev.repo}/issues/${ev.number}` };
  // GitHub-shaped events (release, status, deployment, ...) carry their payload ready-made.
  if ("payload" in ev) {
    const { payload, at: _at, ...head } = rest as typeof rest & { payload: Record<string, unknown>; at: string };
    return { ...head, ...payload, action, repository, sender };
  }
  return { ...rest, action, repository, sender, ...extra };
}
