import { cronMatches } from "@diffinery/workflow-yaml";
import type { Env } from "../env.js";

/**
 * Timing of workflow `schedule` triggers, kept free of platform imports so it can be unit tested.
 * The scheduler (src/scheduler.ts) ticks every few minutes; each tick fires the schedules due in
 * the minutes since the last tick that finished, so a late or missed tick is caught up by the next.
 */

/** The one scheduler object (src/scheduler.ts). */
export const schedulerStub = (env: Env) => env.SCHEDULER.get(env.SCHEDULER.idFromName("global"));

/** GitHub's shortest schedule interval, and the default tick. */
export const DEFAULT_TICK_MINUTES = 5;
/** A tick looks back at most this far: schedules missed for longer are dropped, as on GitHub. */
export const CATCH_UP_MINUTES = 60;

const MINUTE = 60_000;

/** Minutes between ticks: SCHEDULE_TICK_MINUTES if it's a whole number from 1 to 60, else the default. */
export function tickMinutes(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULT_TICK_MINUTES;
}

/** When the tick after `now` is due: the next multiple of the tick (on the hour, :05, :10 ... for 5). */
export function nextTick(now: number, tick: number): number {
  const step = tick * MINUTE;
  return (Math.floor(now / step) + 1) * step;
}

/**
 * The whole minutes (UTC) a tick at `now` covers: those after `last` (the previous finished tick)
 * up to now's minute, at most CATCH_UP_MINUTES of them. Without a previous tick, the tick's own window.
 */
export function tickWindow(now: number, last: number | undefined, tick: number): Date[] {
  const end = Math.floor(now / MINUTE) * MINUTE;
  const from = Math.max(last !== undefined ? Math.floor(last / MINUTE) * MINUTE + MINUTE : end - (tick - 1) * MINUTE, end - (CATCH_UP_MINUTES - 1) * MINUTE);
  const minutes: Date[] = [];
  for (let t = from; t <= end; t += MINUTE) minutes.push(new Date(t));
  return minutes;
}

/** The schedules due in any of `minutes`, each once however many of them match. Invalid crons are skipped. */
export function dueSchedules<T extends { cron: string }>(rows: T[], minutes: Date[]): T[] {
  return rows.filter((s) => {
    try {
      return minutes.some((m) => cronMatches(s.cron, m));
    } catch {
      return false;
    }
  });
}

/** Runs `fn` over `items`, at most `limit` at a time. Each call's failure is its own (`fn` should catch). */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
