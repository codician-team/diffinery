/** Hosts the importer downloads release assets from: GitHub's, plus an optional GitHub Enterprise host. */
const IMPORT_HOSTS = ["github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

export function importHostAllowed(host: string, gheHost?: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const ghe = gheHost?.trim().toLowerCase();
  return IMPORT_HOSTS.includes(h) || (!!ghe && h === ghe);
}

/**
 * The headers to keep when a redirect leaves the original host: only plain
 * content negotiation. Authorization, cookies, tokens and anything else that
 * could carry a credential are dropped.
 */
export function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const keep = new Set(["accept", "accept-encoding", "accept-language", "user-agent", "x-github-api-version"]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => keep.has(k.toLowerCase())));
}
