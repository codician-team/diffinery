import * as vscode from "vscode";
import type { DiffineryAuth } from "./auth";
import type { RemoteSource, RemoteSourceAction, RemoteSourceProvider } from "./typings/git";
import { dedupe, matches, repoRef, type RepoJson } from "./util";

/** How long the list of your repositories is reused while you type in the picker. */
const MINE_TTL_MS = 60_000;

/**
 * "Clone from Diffinery" in the editor's clone picker (and "Add remote from Diffinery"): your repositories and
 * your organizations', most recently pushed first, and as you type, any repository you can read that matches.
 */
export class RemoteSources implements RemoteSourceProvider {
  readonly name = "Diffinery";
  readonly icon = "diffinery-logo";
  readonly supportsQuery = true;
  readonly placeholder = "Repository name or owner/name (type to search)";

  private mine: RepoJson[] = [];
  private mineAt = 0;

  constructor(private readonly auth: DiffineryAuth) {}

  async getRemoteSources(query?: string): Promise<RemoteSource[]> {
    const api = await this.auth.api(true);
    if (!api) return [];
    const q = (query ?? "").trim();
    if (!q || Date.now() - this.mineAt > MINE_TTL_MS) {
      this.mine = await api.myRepos();
      this.mineAt = Date.now();
    }
    if (!q) return this.mine.map(source);
    const ref = repoRef(api.server, q);
    const [direct, found] = await Promise.all([ref ? api.repo(ref).then((r) => [r], () => []) : Promise.resolve([]), api.search(q).catch(() => [] as RepoJson[])]);
    return dedupe(direct, this.mine.filter((r) => matches(r, q)), found).map(source);
  }

  async getBranches(url: string): Promise<string[]> {
    const api = await this.auth.api(true);
    const ref = api && repoRef(api.server, url);
    if (!api || !ref) return [];
    const [branches, repo] = await Promise.all([api.branches(ref), api.repo(ref)]);
    const main = repo.default_branch;
    return branches.sort((a, b) => (a === main ? -1 : b === main ? 1 : 0));
  }

  getRemoteSourceActions(url: string): RemoteSourceAction[] {
    let server: string;
    try {
      server = this.auth.server();
    } catch {
      return [];
    }
    const ref = repoRef(server, url);
    if (!ref || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return [];
    return [
      {
        label: "Open on Diffinery",
        icon: "link-external",
        run: (branch: string) => {
          const base = `${server}/${ref.owner}/${ref.repo}`;
          void vscode.env.openExternal(vscode.Uri.parse(branch ? `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}` : base));
        },
      },
    ];
  }
}

function source(r: RepoJson): RemoteSource {
  const tags = [r.private ? "Private" : "Public", r.archived ? "archived" : "", r.fork ? "fork" : ""].filter(Boolean);
  return { name: r.full_name, icon: "diffinery-logo", description: tags.join(" · "), detail: r.description || undefined, url: r.clone_url };
}
