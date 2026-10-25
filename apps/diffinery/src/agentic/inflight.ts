import type { Env } from "../env.js";
import { randomToken } from "../lib/util.js";

/**
 * Model requests at once that a limit counts (phase 5b). A booking bounds a request's output and the input it
 * carries, but not what an image or PDF in it bills (by pixels and pages, not bytes), so runs held to their
 * bookings are also held to a few requests at once: past a budget or an allowance, at most that many can be on
 * their way.
 */
export const MAX_IN_FLIGHT = 4;
/** How long a lease counts at most: an answer still streaming after this stops counting. */
export const IN_FLIGHT_LEASE_MS = 15 * 60_000;

/** Take one of `scope`'s slots for a request: its lease id, or null when all are taken. One atomic step. */
export async function takeSlot(env: Pick<Env, "DB">, scope: string, at = Date.now()): Promise<string | null> {
  const id = randomToken(16);
  const [, taken] = await env.DB.batch([
    env.DB.prepare("DELETE FROM model_in_flight WHERE scope = ? AND expires_at <= ?").bind(scope, new Date(at).toISOString()),
    env.DB.prepare("INSERT INTO model_in_flight (id, scope, expires_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM model_in_flight WHERE scope = ?) < ?").bind(id, scope, new Date(at + IN_FLIGHT_LEASE_MS).toISOString(), scope, MAX_IN_FLIGHT),
  ]);
  return taken?.meta.changes ? id : null;
}

export async function freeSlot(env: Pick<Env, "DB">, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM model_in_flight WHERE id = ?").bind(id).run();
}
