import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as vscode from "vscode";
import { DEFAULT_SERVER, installHintPath, normalizeServer, readInstallHint, serverInputError, serverLabel } from "./util";

/** Set (globalState) once someone has chosen a server, so signing in stops asking which one. */
const CHOSEN = "diffinery.serverChosen";
/** The installer's server this editor already asked about (globalState), so it asks once per address. */
const HINT_ANSWERED = "diffinery.installHintAnswered";

/** The server in diffinery.serverUrl, or undefined when the setting isn't a usable address. */
export function configuredServer(): string | undefined {
  try {
    return normalizeServer(vscode.workspace.getConfiguration("diffinery").get<string>("serverUrl"));
  } catch {
    return undefined;
  }
}

/** Saves the server in the user settings; diffinery.com clears the setting, so it follows the default. */
export async function useServer(state: vscode.Memento, server: string): Promise<void> {
  await vscode.workspace.getConfiguration("diffinery").update("serverUrl", server === DEFAULT_SERVER ? undefined : server, vscode.ConfigurationTarget.Global);
  await state.update(CHOSEN, true);
}

/**
 * Asks for a self-hosted Diffinery's address, and checks that a Diffinery answers there before it's used, so a typo
 * ends here rather than at an error page in the browser. Undefined when cancelled.
 */
export async function askForServer(value?: string): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    title: "Use Another Diffinery Server",
    prompt: "The address of your Diffinery, as in your browser's address bar. The extension signs in, clones and pushes there.",
    placeHolder: "git.example.com",
    value,
    ignoreFocusOut: true,
    validateInput: serverInputError,
  });
  if (raw === undefined) return undefined;
  const server = normalizeServer(raw);
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Looking for Diffinery at ${serverLabel(server)}…` }, () => isDiffinery(server));
  if (found !== true) {
    const go = await vscode.window.showWarningMessage(`${server} doesn't look like a Diffinery server`, { modal: true, detail: `${found} Check the address, and use it anyway only if you're sure.` }, "Use Anyway");
    if (!go) return undefined;
  }
  return server;
}

/** True when the server answers like Diffinery (every instance serves this extension at /-/vscode/), else what went wrong. */
async function isDiffinery(server: string): Promise<true | string> {
  try {
    const res = await fetch(`${server}/-/vscode/version.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return `${server}/-/vscode/version.json answered ${res.status}.`;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? true : `${server}/-/vscode/version.json isn't what Diffinery serves.`;
  } catch (e) {
    return `It couldn't be reached (${e instanceof Error ? e.message : String(e)}).`;
  }
}

/**
 * The first sign-in asks which Diffinery: diffinery.com, or a self-hosted one by its address, so nobody has to find
 * the setting first. Once someone has chosen, or set diffinery.serverUrl themselves, it doesn't ask again
 * ("Diffinery: Use Another Server…" changes it later).
 */
export async function chooseServer(state: vscode.Memento): Promise<void> {
  if (state.get<boolean>(CHOSEN) || vscode.workspace.getConfiguration("diffinery").inspect<string>("serverUrl")?.globalValue !== undefined) return;
  const items: Array<vscode.QuickPickItem & { server?: string }> = [
    { label: `$(diffinery-logo) Sign in to ${serverLabel(DEFAULT_SERVER)}`, server: DEFAULT_SERVER },
    { label: "$(server) Use another Diffinery server…", detail: "A self-hosted Diffinery on your own domain" },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "Sign in to Diffinery", placeHolder: "Which Diffinery do you use?", ignoreFocusOut: true });
  if (!pick) throw new vscode.CancellationError();
  const server = pick.server ?? (await askForServer());
  if (!server) throw new vscode.CancellationError();
  await useServer(state, server);
}

/** "Diffinery: Use Another Server…": switches the server. Sign-ins on other servers stay, for switching back. */
export async function switchServer(state: vscode.Memento, signedInAs: () => Promise<string | undefined>): Promise<void> {
  const server = await askForServer(configuredServer());
  if (!server) return;
  await useServer(state, server);
  await announce(server, await signedInAs());
}

async function announce(server: string, login: string | undefined): Promise<void> {
  if (login) {
    void vscode.window.showInformationMessage(`Diffinery now uses ${serverLabel(server)}, where you're signed in as ${login}.`);
    return;
  }
  const pick = await vscode.window.showInformationMessage(`Diffinery now uses ${serverLabel(server)}. Sign in to clone and push there.`, "Sign In");
  if (pick) void vscode.commands.executeCommand("diffinery.signIn");
}

/**
 * The installer that a self-hosted Diffinery serves leaves its address in a file (util.ts installHintPath), since an
 * editor's command line can't change a setting. The file only suggests: the person is asked, once per address.
 */
export async function offerInstallerServer(state: vscode.Memento, signedInAs: () => Promise<string | undefined>, log: vscode.LogOutputChannel): Promise<void> {
  let server: string | null;
  try {
    server = readInstallHint(await readFile(installHintPath(process.env, homedir()), "utf8"));
  } catch {
    return; // no file: installed from diffinery.com, or by hand
  }
  if (!server || state.get<string>(HINT_ANSWERED) === server) return;
  const current = configuredServer();
  if (server === current) {
    await state.update(HINT_ANSWERED, server);
    return;
  }
  log.info(`installed from ${server}; asking whether to use it`);
  const use = `Use ${serverLabel(server)}`;
  const keep = current ? `Keep ${serverLabel(current)}` : "Not Now";
  const pick = await vscode.window.showInformationMessage(`The Diffinery extension was installed from ${server}. Sign in, clone and push there?`, use, keep);
  if (!pick) return; // closed without answering: ask again next time
  await state.update(HINT_ANSWERED, server);
  if (pick !== use) return;
  await useServer(state, server);
  await announce(server, await signedInAs());
}
