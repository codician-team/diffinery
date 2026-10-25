# Diffinery for VS Code, Cursor and Windsurf

Work with [Diffinery](https://diffinery.com) repositories from VS Code and the editors built on it (Cursor,
Windsurf, VSCodium and others), the way you do with GitHub's.

- **Clone from Diffinery.** Run **Git: Clone** (or **Clone Repository** on the welcome page) and pick
  **Clone from Diffinery**. You see your repositories and your organizations', most recently pushed first;
  type to search everything you can read, or paste `owner/name`.
- **Sign in with your passkey.** The first time, choose your Diffinery (diffinery.com or your own server), the
  editor opens it in your browser, you approve the connection, and you're back in the editor. Diffinery shows up
  in the Accounts menu. Nothing to copy.
- **Push and pull without passwords.** Git uses your signed-in account for diffinery.com. The extension renews
  its token before it expires and keeps the copy Git saved in your keychain current.
- **Publish to Diffinery.** Publishing a local repository that has no remote offers **Publish to Diffinery**,
  under your account or one of your organizations, private or public.

## Install

The extension comes from diffinery.com and keeps itself up to date from there. Install it with your editor's
command line, for example:

```sh
curl -fsSLo /tmp/diffinery.vsix https://diffinery.com/-/vscode/diffinery.vsix
code --install-extension /tmp/diffinery.vsix      # cursor, windsurf or codium for those editors
```

Or download [diffinery.vsix](https://diffinery.com/-/vscode/diffinery.vsix) and choose **Extensions → … →
Install from VSIX…** in the editor.

The full guide, including JetBrains IDEs and the "Open in VS Code / Cursor" buttons on every repository, is at
[diffinery.com/docs/repositories/clone-in-your-editor](https://diffinery.com/docs/repositories/clone-in-your-editor).

## Self-hosted Diffinery

The extension works with any Diffinery, not only diffinery.com:

- **The first time you sign in** (from **Clone from Diffinery**, the Accounts menu or **Diffinery: Sign In**), the
  extension asks which Diffinery you use. Choose **Use another Diffinery server…** and enter its address, such as
  `git.example.com`. The extension checks that a Diffinery answers there and saves it in `diffinery.serverUrl`.
- **Diffinery: Use Another Server…** changes the server at any time. Each server keeps its own sign-in, so you can
  switch back without signing in again.
- **Installed from your server** with `curl -fsSL https://git.example.com/install-editor | bash` (or its
  `install-editor.ps1`), the extension asks on its next start whether to use that server: choose
  **Use git.example.com**. The installer leaves the address in `~/.config/diffinery/editor-server` for this; it
  doesn't edit the editor's settings.

The extension then updates itself from your server too.

## Commands

| Command | What it does |
|---|---|
| Diffinery: Clone Repository | Opens the Diffinery repository picker directly. |
| Diffinery: Sign In | Signs in through your browser. |
| Diffinery: Sign In with an Access Token | Uses a token from Settings → Access tokens instead (agents, browser-based editors). |
| Diffinery: Use Another Server… | Switches to a self-hosted Diffinery (or back to diffinery.com). |
| Diffinery: Sign Out | Signs out and disconnects the editor from your account. |
| Diffinery: Check for Extension Updates | Installs a newer build from the server, if there is one. |

## Settings

| Setting | Default | |
|---|---|---|
| `diffinery.serverUrl` | `https://diffinery.com` | The Diffinery to use: set it to your server's address for a self-hosted Diffinery. |
| `diffinery.gitAuthentication` | `true` | Answer Git's password prompts for the server with your signed-in account. |
| `diffinery.checkForUpdates` | `true` | Check the server once a day for a newer build. |
