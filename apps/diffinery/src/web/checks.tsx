/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import type { Check } from "../repo/collab.js";

/**
 * A check's name, linked to its job for Diffinery checks, or to the
 * `target_url` / `details_url` an external CI reported (http(s) only).
 */
export const CheckName: FC<{ base: string; ch: Pick<Check, "name" | "runId" | "jobId"> & { detailsUrl?: string | null }; class?: string }> = ({ base, ch, class: cls }) => {
  if (ch.runId)
    return (
      <a class={cls} href={`${base}/actions/runs/${ch.runId}${ch.jobId ? `/job/${ch.jobId}` : ""}`}>
        {ch.name}
      </a>
    );
  if (ch.detailsUrl && /^https?:\/\//i.test(ch.detailsUrl))
    return (
      <a class={cls} href={ch.detailsUrl} rel="noopener noreferrer nofollow" target="_blank">
        {ch.name}
      </a>
    );
  return <span class={cls}>{ch.name}</span>;
};
