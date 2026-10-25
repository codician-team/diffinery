# Diffinery plugin for JetBrains IDEs

Adds **Diffinery** to **Get from Version Control** in IntelliJ IDEA, PyCharm, WebStorm, GoLand and the other
JetBrains IDEs (2024.3 and later), with the browser sign-in Diffinery's other apps use (OAuth with PKCE on a
`127.0.0.1` redirect, client `/oauth/clients/jetbrains.json`). Git asks the plugin for the password when it talks to
the server, and **Git → Share Project on Diffinery…** publishes a local repository. The guide people read is
[Clone in JetBrains IDEs](https://diffinery.com/docs/repositories/clone-in-jetbrains-ides).

It's plain Java (no Kotlin), against the platform's stable API only: `./gradlew verifyPlugin` runs JetBrains' Plugin
Verifier against IntelliJ IDEA 2024.3, 2025.2 and the version the plugin builds with, and fails on internal API use.

## Self-hosted Diffinery

The server is `server` in the IDE's `diffinery.xml` (`Accounts.setServer`), `https://diffinery.com` by default. People
change it from the Diffinery page of **Get from Version Control**: **Use another server…** under the sign-in button
(`SignInDialogs.chooseServer`, which checks that `/-/jetbrains/updatePlugins.xml` answers there first), or one click on
**Use git.example.com** when the IDE's plugin repositories include a Diffinery's `updatePlugins.xml`
(`Util.pluginRepositoryServers`). **Share Project on Diffinery…** offers the same choice before signing in, and
**Settings → Version Control → Diffinery → Server** remains. Changing the server signs out of the old one.

## Build

Gradle 9 through the wrapper, with a JDK 21 or later (the IDE's own JetBrains Runtime works):

```sh
./gradlew dist        # builds and copies the plugin to dist/diffinery-jetbrains-<version>.zip
./gradlew test        # unit tests
./gradlew verifyPlugin
```

`-PideaHome=/path/to/idea` builds against an IDE already on disk instead of downloading IntelliJ IDEA, and
`-Porg.gradle.java.installations.paths=/path/to/idea/jbr` uses its runtime as the JDK.

## How diffinery.com serves it

`dist/` is checked in, because Diffinery's server build has no JDK. `apps/diffinery/scripts/build-docs.mjs` reads it
through `scripts/plugin.mjs`, which refuses a zip whose version isn't `pluginVersion` in `gradle.properties` or that
was built from other sources than `src/main` now (the build puts a fingerprint of them in the jar). So after changing
the plugin, run `./gradlew dist` and commit the new zip with the change; the zip is byte-for-byte reproducible.

The Worker serves:

| Path | What |
| --- | --- |
| `/-/jetbrains/updatePlugins.xml` | The custom plugin repository the IDEs install and update from |
| `/-/jetbrains/diffinery-jetbrains-<version>.zip` | That version |
| `/-/jetbrains/diffinery-jetbrains.zip` | The current version, for **Install Plugin from Disk…** |

## Release

1. Bump `pluginVersion` in `gradle.properties` and add a `CHANGELOG.md` entry.
2. `./gradlew test verifyPlugin dist`, then run the real-IDE check (below).
3. Commit with the new `dist/` zip. Once deployed, IDEs with the plugin repository offer the update.

## Real-IDE check

`apps/diffinery/test/e2e/jetbrains-smoke.mjs` drives IntelliJ IDEA against a local Worker through JetBrains' Remote
Robot server: it installs the plugin from the Worker's plugin repository in **Settings → Plugins**, signs in through
the consent page in Chromium, lists, searches and clones a private repository, shares a project, signs out, and signs
in with a token. See the comment at its top for how to run it. `DOCS=1` retakes the pictures in the guide.

For listing the plugin on the JetBrains Marketplace, see [PUBLISHING.md](PUBLISHING.md).
