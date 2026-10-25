import { execFile } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import tls from "node:tls";
import { promisify } from "node:util";

/** Where Cloudflare puts the CA it intercepts a container's HTTPS with, once the container is up. */
export const EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/**
 * Under web-only egress (DIFFINERY_EGRESS=web, apps/diffinery/src/lib/egress.ts) HTTPS leaves the
 * container through Cloudflare's interception, signed by EGRESS_CA. The agent trusts it for its own
 * requests and adds it to the system store (git, curl, Docker, Python's ssl) and to the variables
 * Node.js and Python's requests read, so the steps and commands it starts trust it too.
 */
export async function trustEgressCa(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.DIFFINERY_EGRESS !== "web") return;
  let pem = "";
  for (let i = 0; i < 100 && !pem; i++) {
    pem = await readFile(EGRESS_CA, "utf8").catch(() => "");
    if (!pem) await new Promise((r) => setTimeout(r, 100));
  }
  if (!pem) {
    process.stderr.write(`[diffinery-runner] web-only egress, but ${EGRESS_CA} did not appear: HTTPS will fail\n`);
    return;
  }
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), pem]);
  try {
    await copyFile(EGRESS_CA, "/usr/local/share/ca-certificates/cloudflare-containers-ca.crt");
    await promisify(execFile)("update-ca-certificates");
  } catch (e) {
    process.stderr.write(`[diffinery-runner] could not add the egress CA to the system store: ${(e as Error).message}\n`);
  }
  env.NODE_EXTRA_CA_CERTS ??= EGRESS_CA;
  env.REQUESTS_CA_BUNDLE ??= "/etc/ssl/certs/ca-certificates.crt";
}
