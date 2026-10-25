# Changelog

## 0.1.2

- Works with any Diffinery, not only diffinery.com: the first sign-in asks which Diffinery you use, with **Use another Diffinery server…** for a self-hosted one.
- New command **Diffinery: Use Another Server…**. Each server keeps its own sign-in.
- Installed with a self-hosted Diffinery's `install-editor` script, the extension asks on its next start whether to use that server.

## 0.1.1

- "Sign In with an Access Token" goes through the editor's own sign-in, so the first clone afterwards no longer asks to allow the extension to sign in.
- Signing in again replaces the previous sign-in and disconnects it on Diffinery.

## 0.1.0

- "Clone from Diffinery" in the clone picker of VS Code, Cursor, Windsurf, VSCodium and other editors built on VS Code, listing your repositories and your organizations', with search.
- Sign in through the browser with your passkey (Diffinery's OAuth), or with an access token. Diffinery appears in the editor's Accounts menu.
- Git clone, pull and push to Diffinery use your signed-in account, and the token Git saves is kept current.
- "Publish to Diffinery" for a repository that has no remote yet.
- Updates itself from diffinery.com.
