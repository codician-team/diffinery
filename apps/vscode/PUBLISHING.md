# Publishing to the VS Code Marketplace and Open VSX

The extension is served by every Diffinery instance (`/-/vscode/diffinery.vsix`, built by
`apps/diffinery/scripts/build-docs.mjs`). These are the steps for listing it on the marketplaces as well. Cursor,
Windsurf and VSCodium install from Open VSX; VS Code installs from the Visual Studio Marketplace, so both are needed.

## Before the first upload

1. Create the `codician` publisher on the Marketplace (https://marketplace.visualstudio.com/manage, display name
   **Codician**; a personal access token for command-line uploads needs an Azure DevOps organization) and the
   `codician` namespace on Open VSX (`pnpm dlx ovsx create-namespace codician`, after signing the Eclipse publisher
   agreement). The extension id `codician.diffinery` is what the server's OAuth client (`EDITOR_EXTENSION_ID` in
   `apps/diffinery/src/auth/oauth.ts`) and the docs use, so keep it.
2. The package already carries the license (`"license": "Apache-2.0"` and the repository's `LICENSE` as
   `extension/LICENSE.txt`), and the marketplace build (`--marketplace` below) ships with `diffinery.checkForUpdates`
   off by default, so the marketplace's updates and the extension's own check against the Diffinery server don't
   fight.

## Listing

| Field | Value |
| --- | --- |
| Name | Diffinery |
| Short description | `description` in `package.json` |
| Categories | SCM Providers, Other |
| Icon | `media/icon.png` (128×128) |
| Banner | `galleryBanner` in `package.json` |
| Details page | `README.md` (relative image links are rewritten to the repository) |
| Changelog | `CHANGELOG.md` |
| Q&A / issues | `bugs.url` in `package.json` |

## Each release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `node scripts/package.mjs --out dist --marketplace` builds `dist/diffinery-<version>-marketplace.vsix`
   (without `--marketplace`, `dist/diffinery-<version>.vsix` is the file diffinery.com serves).
3. Upload it on the publisher's page (**New extension → Visual Studio Code**, or **Update** on the extension) and on
   Open VSX, or from the command line: `pnpm dlx @vscode/vsce publish --packagePath dist/diffinery-<version>-marketplace.vsix` and
   `pnpm dlx ovsx publish dist/diffinery-<version>-marketplace.vsix`, with the tokens from step 1 of *Before the first upload* in `VSCE_PAT` and `OVSX_PAT`.
4. Deploying Diffinery keeps diffinery.com serving the same version for people who installed from there.
