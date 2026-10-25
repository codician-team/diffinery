# Publishing to the VS Code Marketplace and Open VSX

The extension is served by every Diffinery instance (`/-/vscode/diffinery.vsix`, built by
`apps/diffinery/scripts/build-docs.mjs`). These are the steps for listing it on the marketplaces as well. Cursor,
Windsurf and VSCodium install from Open VSX; VS Code installs from the Visual Studio Marketplace, so both are needed.

## Before the first upload

1. Set `"license": "Apache-2.0"` in `package.json` and ship a copy of the repository's `LICENSE` in the package (both
   registries show it; `vsce` warns without it).
2. Create the `codician` publisher on the Marketplace (https://marketplace.visualstudio.com/manage, which needs an
   Azure DevOps organization for the personal access token) and the `codician` namespace on Open VSX
   (`npx ovsx create-namespace codician`, after signing the Eclipse publisher agreement). The extension id
   `codician.diffinery` is what the server's OAuth client (`EDITOR_EXTENSION_ID` in `apps/diffinery/src/auth/oauth.ts`)
   and the docs use, so keep it.
3. Marketplace builds update through the marketplace: ship them with `diffinery.checkForUpdates` defaulting to
   `false`, or have `src/updates.ts` skip the check when the extension was installed from a gallery, so the two
   update paths don't fight.

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
2. `node scripts/package.mjs --out dist` builds `dist/diffinery-<version>.vsix`, the same file diffinery.com serves.
3. `npx @vscode/vsce publish --packagePath dist/diffinery-<version>.vsix` and
   `npx ovsx publish dist/diffinery-<version>.vsix`, with the tokens from step 2 of *Before the first upload* in `VSCE_PAT` and `OVSX_PAT`.
4. Deploying Diffinery keeps diffinery.com serving the same version for people who installed from there.
