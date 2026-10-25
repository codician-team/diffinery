import type { AppContext } from "../auth/principal.js";
import type { Account, Directory, Repo } from "../lib/directory.js";
import { HttpError } from "../lib/util.js";
import { MAX_REVIEW_COMMENT, MAX_REVIEWERS, type Reviewer } from "../repo/deployments.js";
import { atLeast } from "../repo/types.js";
import type { loadRepo } from "./common.js";
import { numericId } from "./gh.js";

type Loaded = Awaited<ReturnType<typeof loadRepo>>;

/**
 * Environment required reviewers (phase 3f): who may be one, and who may approve.
 * Shared by the REST API and the web pages.
 */

/**
 * Whether someone was given access to the repository: as its owner, a collaborator or a member of
 * its organization. Reading a public repository doesn't count, so a reviewer removed from a public
 * repository stops being one.
 */
export async function hasGrantedAccess(dir: Directory, repo: Repo, account: Account): Promise<boolean> {
  return atLeast(await dir.roleFor(account, { ...repo, visibility: "private" }), "read");
}

/** The signed-in person viewing a run, and whether they may still review its deployments. */
export async function viewerFor(c: AppContext, repo: Repo): Promise<{ id: string; login: string; mayReview: boolean } | null> {
  const p = c.get("principal");
  if (p.type !== "account") return null;
  return { id: p.account.id, login: p.account.login, mayReview: p.account.kind === "user" && (await hasGrantedAccess(c.get("dir"), repo, p.account)) };
}

/**
 * An environment's `reviewers` as the REST API takes them (`[{type: "User", id}]`, where `id` is
 * the numeric id Diffinery's API shows for a person, or `login` instead), resolved to people with
 * at least read access. Never an agent; Diffinery has no teams. Undefined leaves them as they are.
 */
export async function resolveReviewers(c: AppContext, repo: Repo, raw: unknown): Promise<Reviewer[] | null | undefined> {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) throw new HttpError(422, "reviewers must be a list of {type, id}");
  if (raw.length > MAX_REVIEWERS) throw new HttpError(422, `an environment can have at most ${MAX_REVIEWERS} required reviewers`);
  const dir = c.get("dir");
  let candidates: Array<{ id: string; login: string; kind: string }> | null = null;
  const people = async () => {
    if (candidates) return candidates;
    const list: Array<{ id: string; login: string; kind: string }> = (await dir.collaborators(repo.id)).map((x) => x.account);
    if (repo.owner_kind === "org") list.push(...(await dir.orgMembers(repo.owner_id)));
    else {
      const owner = await dir.account(repo.owner_id);
      if (owner) list.push(owner);
    }
    candidates = list;
    return list;
  };
  const out: Reviewer[] = [];
  for (const [i, r] of raw.entries()) {
    const at = `reviewers[${i}]`;
    if (!r || typeof r !== "object") throw new HttpError(422, `${at} must be {type: "User", id}`);
    const x = r as { type?: unknown; id?: unknown; login?: unknown };
    if (x.type === "Team") throw new HttpError(422, `${at}: Diffinery has no teams; list people as {type: "User", id}`);
    if (x.type !== "User") throw new HttpError(422, `${at}.type must be "User"`);
    let account = null;
    if (typeof x.login === "string" && x.login) account = await dir.accountByLogin(x.login);
    else if (typeof x.id === "number") {
      const hit = (await people()).find((p) => numericId(p.id) === x.id);
      account = hit ? await dir.account(hit.id) : null;
    }
    else if (typeof x.id === "string" && x.id) account = (await dir.account(x.id)) ?? (await dir.accountByLogin(x.id));
    if (!account) throw new HttpError(422, `${at}: no such person with access to this repository`);
    if (account.kind !== "user") throw new HttpError(422, `${at}: ${account.login} is ${account.kind === "agent" ? "an agent; only people can be required reviewers" : "not a person"}`);
    if (!(await hasGrantedAccess(dir, repo, account))) throw new HttpError(422, `${at}: ${account.login} has no access to this repository`);
    if (!out.some((o) => o.id === account!.id)) out.push({ type: "User", id: account.id, login: account.login });
  }
  return out;
}

/**
 * Who is approving: only a person, in a browser session or with a personal token that may write.
 * Never an agent, a workflow's GITHUB_TOKEN, a sandbox token or an import's token.
 */
export function reviewerFor(c: AppContext): { id: string; login: string; account: Account } {
  const p = c.get("principal");
  if (p.type !== "account") throw new HttpError(403, "only people can review deployments, not workflow or sandbox tokens");
  if (p.account.kind !== "user") throw new HttpError(403, "only people can review deployments, not agents");
  if (p.via === "token" && (p.importId || !p.scopes.some((s) => s === "write" || s === "admin"))) throw new HttpError(403, "reviewing deployments needs a token that may write");
  return { id: p.account.id, login: p.account.login, account: p.account };
}

/** Approve or reject environments a run waits on, as the person making the request; audited with the comment. */
export async function reviewDeployments(c: AppContext, l: Loaded, runId: string, input: { environment_ids?: unknown; state?: unknown; comment?: unknown }) {
  const reviewer = reviewerFor(c);
  if (l.repo.archived) throw new HttpError(403, "repository is archived (read-only)");
  // Checked now, not only when the list was set: someone removed from the repository no longer decides.
  if (!(await hasGrantedAccess(c.get("dir"), l.repo, reviewer.account))) throw new HttpError(403, "only people with access to this repository review its deployments");
  const ids = input.environment_ids;
  if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== "number" || !Number.isInteger(x))) throw new HttpError(422, "environment_ids must be a list of environment ids");
  if (input.state !== "approved" && input.state !== "rejected") throw new HttpError(422, 'state must be "approved" or "rejected"');
  if (input.comment !== undefined && typeof input.comment !== "string") throw new HttpError(422, "comment must be text");
  const comment = ((input.comment as string | undefined) ?? "").trim();
  if (comment.length > MAX_REVIEW_COMMENT) throw new HttpError(422, `comment is longer than ${MAX_REVIEW_COMMENT} characters`);
  const out = await l.stub.reviewDeployments(runId, { environmentIds: ids as number[], state: input.state, comment }, { id: reviewer.id, login: reviewer.login, mayReview: true });
  c.executionCtx.waitUntil(
    c
      .get("dir")
      .audit({ actorId: reviewer.id, actorLogin: reviewer.login, action: `deployment.${input.state === "approved" ? "approve" : "reject"}`, target: `${l.repo.owner_login}/${l.repo.name}`, detail: { run: runId, environments: out.reviews.map((r) => r.environment), comment } })
      .catch((e) => console.error("audit failed", e)),
  );
  return out;
}
