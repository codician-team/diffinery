/**
 * Unit-test settings every package shares.
 *
 * CI runs on Cloudflare's hosted runners, and Cloudflare places them on hosts whose cores differ
 * about 2x in speed (AMD EPYC Zen 2, 3 and 4 were all seen on 2026-10-16), some of them busy enough
 * to stall a container's vCPUs for seconds. A test's timeout only catches a hang, so it allows for
 * the slowest of those hosts; a test that checks speed says so itself, comparing against work done
 * on the same machine rather than against a fixed number of seconds.
 */
export const timeouts = { testTimeout: 30_000, hookTimeout: 30_000 };
