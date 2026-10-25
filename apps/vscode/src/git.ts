import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { AUTH_ID, SCOPES, type DiffineryAuth, type Stored } from "./auth";
import type { Credentials, CredentialsProvider, GitAPI, RemoteSourcePublisher, Repository } from "./typings/git";
import { credentialInput, repoNameFrom } from "./util";

/** Answers Git's password prompts for the Diffinery server with the signed-in account (VS Code's Git askpass). */
export class GitCredentials implements CredentialsProvider {
  constructor(private readonly auth: DiffineryAuth) {}

  async getCredentials(host: vscode.Uri): Promise<Credentials | undefined> {
    let server: string;
    try {
      server = this.auth.server();
    } catch {
      return undefined;
    }
    if (host.authority.toLowerCase() !== new URL(server).host.toLowerCase()) return undefined;
    const session = await vscode.authentication.getSession(AUTH_ID, SCOPES, { createIfNone: true });
    // Signing in starts by choosing the server: if another one was chosen, its token isn't for this host.
    if (this.auth.server() !== server) return undefined;
    return { username: session.account.label, password: session.accessToken };
  }
}

/**
 * Keeps the token Git saved for the Diffinery server current. After Git uses a password from the editor it saves
 * it with the computer's credential helper (the macOS keychain, Git Credential Manager on Windows, libsecret), and
 * asks that helper first next time. Signed in through the browser, the token changes every few hours, so each
 * renewal replaces the saved one (with its expiry, for helpers that honour it), and signing out removes it.
 */
export function syncCredentialStore(auth: DiffineryAuth, git: () => GitAPI | undefined, log: vscode.LogOutputChannel): vscode.Disposable {
  return auth.onDidStore(async ({ before, after }) => {
    if (!vscode.workspace.getConfiguration("diffinery").get<boolean>("gitAuthentication", true)) return;
    const gitPath = git()?.git.path;
    if (!gitPath) return;
    try {
      if (before && before.accessToken !== after?.accessToken) await credential(gitPath, "reject", before);
      if (after && after.accessToken !== before?.accessToken) await credential(gitPath, "approve", after);
    } catch (e) {
      log.warn("updating Git's saved Diffinery credential failed", e);
    }
  });
}

function credential(gitPath: string, op: "approve" | "reject", s: Stored): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, ["credential", op], {
      // Never prompt: approve and reject only talk to the configured helpers.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never" },
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git credential ${op} exited ${code}: ${err.trim()}`))));
    child.stdin.end(credentialInput(s.server, s.login, s.accessToken, s.kind === "oauth" ? s.expiresAt : undefined));
  });
}

/** "Publish to Diffinery" when publishing a repository that has no remote yet. */
export class Publisher implements RemoteSourcePublisher {
  readonly name = "Diffinery";
  readonly icon = "diffinery-logo";

  constructor(private readonly auth: DiffineryAuth) {}

  async publishRepository(repository: Repository): Promise<void> {
    const api = await this.auth.api(true);
    if (!api) return;
    const head = repository.state.HEAD;
    if (!head?.commit) {
      void vscode.window.showWarningMessage("Commit your changes first, then publish the repository to Diffinery.");
      return;
    }
    const [me, orgs] = await Promise.all([api.user(), api.orgs().catch(() => [])]);
    const owners = [
      { label: me.login, description: "your account", owner: null as string | null },
      ...orgs.map((o) => ({ label: o.login, description: "organization", owner: o.login as string | null })),
    ];
    const owner = owners.length === 1 ? owners[0] : await vscode.window.showQuickPick(owners, { title: "Publish to Diffinery", placeHolder: "Owner of the new repository" });
    if (!owner) return;
    const name = await vscode.window.showInputBox({
      title: "Publish to Diffinery",
      prompt: `Repository name (it will be ${owner.label}/<name>)`,
      value: repoNameFrom(path.basename(repository.rootUri.fsPath)),
      validateInput: (v) => (/^[A-Za-z0-9._-]{1,100}$/.test(v) && v !== "." && v !== ".." ? null : "Use letters, digits, '.', '-' or '_'."),
    });
    if (!name) return;
    const vis = await vscode.window.showQuickPick(
      [
        { label: "$(lock) Private", description: "Only people and teams you give access can see it.", private: true },
        { label: "$(globe) Public", description: "Anyone on the internet can see and clone it.", private: false },
      ],
      { title: "Publish to Diffinery", placeHolder: `Who can see ${owner.label}/${name}?` },
    );
    if (!vis) return;
    const branch = head.name;
    const created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Publishing to Diffinery as ${owner.label}/${name}…` }, async () => {
      const repo = await api.createRepo(owner.owner, { name, private: vis.private });
      const remote = repository.state.remotes.some((r) => r.name === "origin") ? "diffinery" : "origin";
      await repository.addRemote(remote, repo.clone_url);
      if (branch) await repository.push(remote, branch, true);
      return repo;
    });
    const open = await vscode.window.showInformationMessage(`Published ${created.full_name} to Diffinery.`, "Open on Diffinery");
    if (open) void vscode.env.openExternal(vscode.Uri.parse(created.html_url));
  }
}
