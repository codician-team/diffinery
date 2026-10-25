import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * scripts/deploy-log-notes.sh: what the GitHub sync repeats from a Diffinery Deploy job's log. A
 * step's log begins with its script, whose `echo "::warning::..."` lines are not warnings.
 */

const script = new URL("../../../../scripts/deploy-log-notes.sh", import.meta.url).pathname;
const notes = (log: string) => {
  const r = spawnSync("bash", [script], { input: log, encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.split("\n").filter(Boolean);
};

// The "Check sign-in pages" step of a deploy where Access is set up and Turnstile works.
const step = (lines: string[]) =>
  [
    "2026-10-14T09:14:34.280Z ##[group]Run loc=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' https://$DIFFINERY_DOMAIN/auth/access)",
    "2026-10-14T09:14:34.281Z \u001b[36;1mloc=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' https://$DIFFINERY_DOMAIN/auth/access)\u001b[0m",
    '2026-10-14T09:14:34.281Z \u001b[36;1mecho "/auth/access -> $loc"\u001b[0m',
    '2026-10-14T09:14:34.282Z   [[ "$loc" == 302\\ https://*.cloudflareaccess.com/* ]] || echo "::warning::/auth/access is not behind Cloudflare Access yet, so email recovery and first admin sign-in will not work"',
    "2026-10-14T09:14:34.286Z report=$(curl -sS -w '\\n%{http_code}' https://$DIFFINERY_DOMAIN/security/report)",
    '2026-10-14T09:14:34.286Z   echo "/security/report shows Turnstile to people who aren\'t signed in"',
    '2026-10-14T09:14:34.286Z elif grep -q \'has no Turnstile configured\' <<<"$report"; then echo "::warning::/security/report has no Turnstile, so only people who are signed in can send security reports: the Worker lacks TURNSTILE_SITE_KEY or TURNSTILE_SECRET"',
    "2026-10-14T09:14:34.287Z ##[endgroup]",
    ...lines,
  ].join("\n");

describe("deploy log notes", () => {
  it("repeats what the deploy printed, not the warnings its scripts could print", () => {
    const log = [
      '2026-10-14T09:14:07.959Z Turnstile widget "diffinery diffinery.com" exists: 0x4AAAAAAFWX2OQHwh_jT9_h',
      "2026-10-14T09:14:08.227Z TURNSTILE_SECRET goes with site key 0x4AAAAAAFWX2OQHwh_jT9_h",
      step([
        "2026-10-14T09:14:34.500Z /auth/access -> 302 https://team.cloudflareaccess.com/cdn-cgi/access/login",
        "2026-10-14T09:14:34.730Z /security/report shows Turnstile to people who aren't signed in",
      ]),
    ].join("\n");
    const out = notes(log);
    expect(out.filter((l) => l.startsWith("::warning::"))).toEqual([]);
    expect(out).toEqual([
      '  deploy: 2026-10-14T09:14:07.959Z Turnstile widget "diffinery diffinery.com" exists: 0x4AAAAAAFWX2OQHwh_jT9_h',
      "  deploy: 2026-10-14T09:14:08.227Z TURNSTILE_SECRET goes with site key 0x4AAAAAAFWX2OQHwh_jT9_h",
      "  deploy: 2026-10-14T09:14:34.500Z /auth/access -> 302 https://team.cloudflareaccess.com/cdn-cgi/access/login",
      "  deploy: 2026-10-14T09:14:34.730Z /security/report shows Turnstile to people who aren't signed in",
    ]);
  });

  it("repeats the warnings the deploy raised", () => {
    const out = notes(
      step([
        "2026-10-14T09:14:34.500Z /auth/access -> 200 ",
        "2026-10-14T09:14:34.501Z ##[warning]/auth/access is not behind Cloudflare Access yet, so email recovery and first admin sign-in will not work",
        "2026-10-14T09:14:34.730Z ::warning::/security/report has no Turnstile: it answered 503 without the form",
      ]),
    );
    expect(out).toEqual([
      "::warning::Diffinery Deploy: /auth/access is not behind Cloudflare Access yet, so email recovery and first admin sign-in will not work",
      "::warning::Diffinery Deploy: /security/report has no Turnstile: it answered 503 without the form",
      "  deploy: 2026-10-14T09:14:34.500Z /auth/access -> 200 ",
    ]);
  });
});
