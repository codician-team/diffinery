import { checkPublicUrl } from "../imports/options.js";
import { hmacSha256Hex } from "./util.js";

/** One webhook delivery; failed ones go back on the events queue with a delay. */
export interface WebhookRetry {
  type: "webhook_retry";
  repoId: string;
  hookId: string;
  event: string;
  diffineryEvent: string;
  body: string;
  delivery: string;
  /** Attempts made so far. */
  attempt: number;
}

export interface WebhookDeps {
  /** The hook as it is now (it may have been deleted, disabled or re-keyed), or null. */
  hook(repoId: string, hookId: string): Promise<{ id: string; url: string; secret: string } | null>;
  /** Diffinery's own host name: deliveries never go there. */
  ownHost?: string;
  /** A Worker on this machine only (auth/dev.ts localOnly): deliveries may go to this machine, for the end-to-end tests. */
  local?: boolean;
  record(repoId: string, hookId: string, status: number): Promise<void>;
  requeue(r: WebhookRetry, delaySeconds: number): Promise<void>;
  fetch?: typeof fetch;
}

// Delays after the first, second, ... failed attempt: about five hours in all.
export const WEBHOOK_RETRY_DELAYS = [60, 300, 1800, 3600, 3 * 3600];

/** Network errors, timeouts, rate limits and server errors are worth another try. */
export const retryable = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

/** Send one delivery (to `known` when the caller already has the hook) and schedule a retry if it fails. */
export async function deliverWebhook(deps: WebhookDeps, r: WebhookRetry, known?: { id: string; url: string; secret: string }): Promise<number | null> {
  const h = known ?? (await deps.hook(r.repoId, r.hookId));
  if (!h) return null;
  // A hook saved before URLs were checked may point at an internal or Diffinery's own address: never deliver there.
  try {
    checkPublicUrl(h.url, !!deps.local, "webhook URL", deps.local ? undefined : deps.ownHost);
  } catch {
    await deps.record(r.repoId, h.id, 0);
    return 0;
  }
  let status = 0;
  try {
    const res = await (deps.fetch ?? fetch)(h.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Diffinery-Hookshot/1",
        "x-github-event": r.event,
        "x-github-delivery": r.delivery,
        "x-diffinery-event": r.diffineryEvent,
        "x-hub-signature-256": `sha256=${await hmacSha256Hex(h.secret, r.body)}`,
      },
      body: r.body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
  } catch {
    status = 0;
  }
  await deps.record(r.repoId, h.id, status);
  const delay = WEBHOOK_RETRY_DELAYS[r.attempt];
  if (retryable(status) && delay !== undefined) await deps.requeue({ ...r, attempt: r.attempt + 1 }, delay);
  return status;
}
