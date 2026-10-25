import type { Env } from "../env.js";
import { quotasFor } from "./quotas.js";

/**
 * How much of the internet hosted compute (Actions jobs on hosted runners, agent sandboxes and web
 * terminals) reaches, set by EGRESS:
 *
 * - open (the default): everything.
 * - web: HTTP and HTTPS (ports 80 and 443) and DNS only. The container starts without internet
 *   access, which leaves the platform only those ports and DNS to Cloudflare's resolvers; requests to
 *   every host (allowedHosts "*") then go out through the Worker (ContainerProxy, exported in
 *   index.ts). HTTPS is intercepted with a CA the platform puts in the container, which the runner
 *   agent trusts at start (containers/runner/src/egress.ts). SMTP, SSH and other ports are refused.
 *
 * As with quotas, the account that owns the repository decides, and accounts run by a site
 * administrator stay open, so the instance's own Deploy and live tests keep their egress.
 * Self-hosted runners are not affected.
 */
export type Egress = "open" | "web";

export async function egressFor(env: Env, accountId: string): Promise<Egress> {
  if (env.EGRESS !== "web") return "open";
  return (await quotasFor(env, accountId)).exempt ? "open" : "web";
}

/** What a hosted container is started with under a policy (runner/containers.ts). */
export function egressStart(egress: Egress): { enableInternet: boolean; interceptHttps: boolean; allowedHosts?: string[]; envVars: Record<string, string> } {
  if (egress === "open") return { enableInternet: true, interceptHttps: false, envVars: {} };
  return { enableInternet: false, interceptHttps: true, allowedHosts: ["*"], envVars: { DIFFINERY_EGRESS: "web" } };
}
