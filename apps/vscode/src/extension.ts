import * as vscode from "vscode";
import { AUTH_ID, DiffineryAuth, SCOPES } from "./auth";
import { GitCredentials, Publisher, syncCredentialStore } from "./git";
import { RemoteSources } from "./remoteSources";
import { offerInstallerServer, switchServer } from "./servers";
import type { GitAPI, GitBaseAPI, GitBaseExtension, GitExtension } from "./typings/git";
import { checkForUpdates } from "./updates";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const version = String(ctx.extension.packageJSON.version ?? "0.0.0");
  const log = vscode.window.createOutputChannel("Diffinery", { log: true });
  const auth = new DiffineryAuth(ctx, log, version);
  ctx.subscriptions.push(
    log,
    auth,
    vscode.authentication.registerAuthenticationProvider(AUTH_ID, "Diffinery", auth, { supportsMultipleAccounts: false }),
    vscode.window.registerUriHandler({ handleUri: (uri) => void auth.handleUri(uri) }),
  );

  const report = (what: string) => (e: unknown) => {
    if (e instanceof vscode.CancellationError) return;
    log.error(what, e);
    void vscode.window.showErrorMessage(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  };
  const command = (id: string, run: () => Promise<unknown>, what: string) => ctx.subscriptions.push(vscode.commands.registerCommand(id, () => run().catch(report(what))));

  command("diffinery.signIn", async () => vscode.authentication.getSession(AUTH_ID, SCOPES, { createIfNone: true }), "Signing in to Diffinery failed");
  command("diffinery.signInWithToken", () => auth.signInWithToken(), "Signing in to Diffinery failed");
  command("diffinery.signOut", () => auth.signOut(), "Signing out of Diffinery failed");
  command("diffinery.useServer", () => switchServer(ctx.globalState, () => auth.login()), "Changing the Diffinery server failed");
  command("diffinery.checkForUpdates", () => checkForUpdates(ctx, auth.server(), version, log, true), "Checking for updates failed");

  // ---------------------------------------------------------------- the built-in Git extensions
  let gitBase: GitBaseAPI | undefined;
  let git: GitAPI | undefined;
  const remoteSources = new RemoteSources(auth);
  const gitDisposables: vscode.Disposable[] = [];
  ctx.subscriptions.push({ dispose: () => gitDisposables.forEach((d) => d.dispose()) });
  let credentials: vscode.Disposable | undefined;
  const updateCredentials = () => {
    const on = !!git && vscode.workspace.getConfiguration("diffinery").get<boolean>("gitAuthentication", true);
    if (on && !credentials) credentials = git!.registerCredentialsProvider(new GitCredentials(auth));
    if (!on && credentials) {
      credentials.dispose();
      credentials = undefined;
    }
  };
  ctx.subscriptions.push(
    { dispose: () => credentials?.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("diffinery.gitAuthentication") && updateCredentials()),
    syncCredentialStore(auth, () => git, log),
  );

  const baseExt = vscode.extensions.getExtension<GitBaseExtension>("vscode.git-base");
  const gitExt = vscode.extensions.getExtension<GitExtension>("vscode.git");
  const connect = async () => {
    try {
      const base = baseExt && (baseExt.isActive ? baseExt.exports : await baseExt.activate());
      if (base?.enabled && !gitBase) {
        gitBase = base.getAPI(1);
        gitDisposables.push(gitBase.registerRemoteSourceProvider(remoteSources));
      }
      const g = gitExt && (gitExt.isActive ? gitExt.exports : await gitExt.activate());
      if (g?.enabled && !git) {
        git = g.getAPI(1);
        gitDisposables.push(git.registerRemoteSourcePublisher(new Publisher(auth)));
        updateCredentials();
      }
      return { base, g };
    } catch (e) {
      log.error("connecting to the built-in Git extension failed", e);
      return {};
    }
  };
  const { base, g } = await connect();
  if (base && !base.enabled) ctx.subscriptions.push(base.onDidChangeEnablement((on) => on && void connect()));
  if (g && !g.enabled) ctx.subscriptions.push(g.onDidChangeEnablement((on) => on && void connect()));
  if (!baseExt || !gitExt) log.warn("The editor's built-in Git extension isn't available, so Diffinery can't add itself to the clone picker.");

  command(
    "diffinery.clone",
    async () => {
      if (!gitBase) throw new Error("The editor's Git support is turned off (git.enabled). Turn it on to clone.");
      const picked = await gitBase.pickRemoteSource({ providerName: remoteSources.name, title: "Clone from Diffinery", urlLabel: "Clone from URL" });
      const url = typeof picked === "string" ? picked : picked?.url;
      if (url) await vscode.commands.executeCommand("git.clone", url);
    },
    "Cloning from Diffinery failed",
  );

  void offerInstallerServer(ctx.globalState, () => auth.login(), log).catch(report("Changing the Diffinery server failed"));
  void checkForUpdates(ctx, auth.server(), version, log, false).catch((e) => log.warn("update check failed", e));
}

export function deactivate(): void {}
