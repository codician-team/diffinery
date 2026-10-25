# Publishing to the JetBrains Marketplace

The plugin is served by every Diffinery instance from its own plugin repository (`/-/jetbrains/updatePlugins.xml`,
see [README.md](README.md)). These are the steps for listing it on the JetBrains Marketplace as well.

## Before the first upload

1. The Marketplace asks for a license and shows it: choose Apache-2.0, the repository's `LICENSE`.
2. Create a vendor profile for Diffinery at https://plugins.jetbrains.com (an organization, so more than one person
   can upload), and a permanent token under **My Tokens** for uploads from the command line.
3. Upload the first version by hand (**Upload plugin** on the Marketplace), choosing the license and the
   categories (Version Controls). The plugin id `com.diffinery` is what the server's plugin repository and the
   docs use, so keep it. JetBrains reviews the first upload, which takes a few working days.
4. People who installed from diffinery.com's plugin repository get Marketplace updates too (the IDE takes the highest
   version from any repository), so keep the two on the same version.

## Listing

| Field | Value |
| --- | --- |
| Name | Diffinery (`<name>` in `plugin.xml`) |
| Description | `<description>` in `src/main/resources/META-INF/plugin.xml` |
| Icon | `src/main/resources/META-INF/pluginIcon.svg` and `pluginIcon_dark.svg` |
| Change notes | `CHANGELOG.md` (add `changeNotes` to `pluginConfiguration` in `build.gradle.kts` to show it) |
| Compatibility | `since-build` 243 (2024.3), no upper bound; the Marketplace runs the Plugin Verifier on each upload |
| Screenshots | `apps/diffinery/docs/images/jetbrains-*.webp` (taken by `jetbrains-smoke.mjs` with `DOCS=1`) |

## Each release

1. Release as in [README.md](README.md#release).
2. `./gradlew publishPlugin` with the token in `ORG_GRADLE_PROJECT_intellijPlatformPublishingToken` (set
   `intellijPlatform { publishing { token = providers.gradleProperty("intellijPlatformPublishingToken") } }` first),
   or upload `dist/diffinery-jetbrains-<version>.zip` on the plugin's Marketplace page.
3. Deploying Diffinery keeps diffinery.com's plugin repository on the same version.
