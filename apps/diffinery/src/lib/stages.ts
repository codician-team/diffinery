/**
 * An event fans out to independent side effects (webhooks, notifications).
 * Each runs on its own: one that fails is put back on the events queue alone,
 * with a delay, so retrying it never repeats the others (webhooks going out
 * again with new delivery ids, or emails sent twice).
 */
export type Stage = "webhooks" | "notify";

export interface StageRetry<E> {
  type: "stage_retry";
  stage: Stage;
  event: E;
  /** Attempts made so far. */
  attempt: number;
}

// Delays after the first, second, ... failure: about 1.5 hours in all.
export const STAGE_RETRY_DELAYS = [30, 120, 600, 1800, 3600];

/** Run `stages` for `event`; never throws. Failures are requeued one stage at a time. */
export async function runStages<E>(
  event: E,
  stages: Stage[],
  run: (stage: Stage) => Promise<void>,
  requeue: (r: StageRetry<E>, delaySeconds: number) => Promise<void>,
  attempt = 0,
): Promise<void> {
  await Promise.all(
    stages.map(async (stage) => {
      try {
        await run(stage);
      } catch (e) {
        const delay = STAGE_RETRY_DELAYS[attempt];
        if (delay === undefined) {
          console.error(`event ${stage} failed ${attempt + 1} times; giving up`, e);
          return;
        }
        console.error(`event ${stage} failed; retrying it alone in ${delay}s`, e);
        await requeue({ type: "stage_retry", stage, event, attempt: attempt + 1 }, delay).catch((q) => console.error(`could not queue the ${stage} retry`, q));
      }
    }),
  );
}
