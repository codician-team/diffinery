import type { Account, Directory, Repo } from "../lib/directory.js";
import { atLeast, type Caller } from "../repo/types.js";

/**
 * Who may run an agent task: a person with write access to the repository,
 * driving an agent they manage (they own it, or they are an owner or admin of
 * the organization that owns it) that itself has write access there.
 */

/** Whether `person` may drive `agent`: the same rule as managing it in Settings → Agents. */
export async function mayDriveAgent(dir: Directory, person: Account, agent: Account): Promise<boolean> {
  if (person.kind !== "user" || person.status !== "active") return false;
  if (agent.kind !== "agent" || agent.status !== "active" || !agent.owner_id) return false;
  if (agent.owner_id === person.id) return true;
  const role = await dir.orgRole(agent.owner_id, person.id);
  return role === "owner" || role === "admin";
}

/**
 * The caller a task's sandbox acts as: the agent, on behalf of the person, at
 * most write. Throws when the person or the agent isn't allowed (any more).
 */
export async function taskCaller(dir: Directory, person: Account, agent: Account, repo: Repo): Promise<Caller> {
  const personRole = await dir.roleFor(person, repo);
  if (!atLeast(personRole, "write")) throw new TaskAccessError("you need write access to this repository to run agent tasks");
  if (!(await mayDriveAgent(dir, person, agent))) throw new TaskAccessError(`you can't run tasks as ${agent.login}: you must own it, or administer the organization that owns it`);
  const agentRole = await dir.roleFor(agent, repo);
  if (!atLeast(agentRole, "write")) throw new TaskAccessError(`${agent.login} needs write access to this repository`);
  // Like any sandbox, at most write, whatever the agent's own role.
  return { id: agent.id, login: agent.login, kind: "agent", onBehalfOf: person.login, role: "write" };
}

/** Whether the person who started a task may still drive it (checked on every resume and every use of its git credential). */
export async function taskPersonAllowed(dir: Directory, personId: string, agent: Account, repo: Repo): Promise<boolean> {
  const person = await dir.account(personId);
  if (!person) return false;
  try {
    await taskCaller(dir, person, agent, repo);
    return true;
  } catch {
    return false;
  }
}

export class TaskAccessError extends Error {}
