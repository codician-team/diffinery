import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { dueSchedules, eachLimited, nextTick, tickMinutes, tickWindow } from "./lib/schedules.js";

/** Repository objects asked to start scheduled runs at the same time. */
const FAN_OUT = 16;

/**
 * Fires workflow `schedule` triggers. One instance ("global") ticks on its own alarm, which
 * survives deploys and restarts, instead of on the Worker's cron trigger: Cloudflare can take
 * minutes to apply a cron trigger after a deploy (every deploy re-sends it), and an invocation
 * that never comes, or fails, would drop that window's schedules. Each tick fires what is due
 * since the last tick that finished, so a late or failed tick is caught up by the next one.
 * The cron trigger and every repository that registers schedules only make sure the alarm is set.
 */
export class SchedulerDO extends DurableObject<Env> {
  /** Sets the alarm when none is due by the next tick (a first start, or a lost alarm). */
  async ensure(): Promise<void> {
    const next = nextTick(Date.now(), this.tick());
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at > next) await this.ctx.storage.setAlarm(next);
  }

  /** When the last tick finished, the minutes it covered up to, and when the next is due (ISO times, or null). */
  async status(): Promise<{ tick_minutes: number; last_tick_at: string | null; covered_until: string | null; next_tick_at: string | null }> {
    const [finished, last, next] = await Promise.all([this.ctx.storage.get<number>("finished"), this.ctx.storage.get<number>("last"), this.ctx.storage.getAlarm()]);
    const iso = (t: number | null | undefined) => (typeof t === "number" ? new Date(t).toISOString() : null);
    return { tick_minutes: this.tick(), last_tick_at: iso(finished), covered_until: iso(last), next_tick_at: iso(next) };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    // The next tick first, so nothing below can end the chain.
    await this.ctx.storage.setAlarm(nextTick(now, this.tick()));
    const minutes = tickWindow(now, await this.ctx.storage.get<number>("last"), this.tick());
    if (!minutes.length) return;
    try {
      await fireSchedules(this.env, minutes);
      await this.ctx.storage.put({ last: minutes[minutes.length - 1]!.getTime(), finished: Date.now() });
    } catch (e) {
      console.error("schedule tick failed; the next tick catches it up", e);
    }
  }

  private tick(): number {
    return tickMinutes(this.env.SCHEDULE_TICK_MINUTES);
  }
}

/** Starts a run for every schedule due in `minutes`. Throws only when the schedules can't be read. */
export async function fireSchedules(env: Env, minutes: Date[]): Promise<void> {
  const { results } = await env.DB.prepare("SELECT s.repo_id, s.workflow_path, s.cron FROM schedules s JOIN repos r ON r.id = s.repo_id WHERE r.archived = 0").all<{ repo_id: string; workflow_path: string; cron: string }>();
  await eachLimited(dueSchedules(results, minutes), FAN_OUT, async (s) => {
    try {
      await env.REPO.get(env.REPO.idFromName(s.repo_id)).scheduleTick(s.workflow_path, s.cron);
    } catch (e) {
      console.error("schedule failed", s.repo_id, s.workflow_path, e);
    }
  });
}
