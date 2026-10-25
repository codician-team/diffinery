import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { compareVersions } from "./util";

const DAY_MS = 86_400_000;
const LAST_CHECK = "diffinery.lastUpdateCheck";

interface Latest {
  version: string;
  url: string;
  sha256: string;
}

/**
 * The extension is installed from the Diffinery server rather than a marketplace, so it updates itself from there:
 * once a day (or when asked) it reads /-/vscode/version.json and offers to install a newer build, checked against
 * the digest the server published.
 */
export async function checkForUpdates(ctx: vscode.ExtensionContext, server: string, current: string, log: vscode.LogOutputChannel, manual: boolean): Promise<void> {
  if (!manual) {
    if (!vscode.workspace.getConfiguration("diffinery").get<boolean>("checkForUpdates", true)) return;
    const last = ctx.globalState.get<number>(LAST_CHECK, 0);
    if (Date.now() - last < DAY_MS) return;
  }
  await ctx.globalState.update(LAST_CHECK, Date.now());
  let latest: Latest;
  try {
    const res = await fetch(`${server}/-/vscode/version.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    latest = (await res.json()) as Latest;
  } catch (e) {
    log.warn("checking for a newer Diffinery extension failed", e);
    if (manual) void vscode.window.showWarningMessage(`Couldn't check ${server} for a newer Diffinery extension: ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (compareVersions(latest.version, current) <= 0) {
    if (manual) void vscode.window.showInformationMessage(`The Diffinery extension is up to date (${current}).`);
    return;
  }
  const pick = await vscode.window.showInformationMessage(`Diffinery extension ${latest.version} is available (you have ${current}).`, "Install", "Later");
  if (pick !== "Install") return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing Diffinery extension ${latest.version}…` }, async () => {
    const res = await fetch(new URL(latest.url, server), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Downloading the extension failed: ${res.status} ${res.statusText}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== latest.sha256) throw new Error("The downloaded extension didn't match the published digest; nothing was installed.");
    const file = vscode.Uri.joinPath(ctx.globalStorageUri, `diffinery-${latest.version}.vsix`);
    await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
    await vscode.workspace.fs.writeFile(file, bytes);
    await vscode.commands.executeCommand("workbench.extensions.installExtension", file);
  });
  const reload = await vscode.window.showInformationMessage(`Diffinery extension ${latest.version} is installed. Reload the window to use it.`, "Reload Window");
  if (reload) void vscode.commands.executeCommand("workbench.action.reloadWindow");
}
