rootProject.name = "diffinery-jetbrains"

// Maven Central through JetBrains' cache first: Central rate-limits busy networks (CI runners) with 429s.
pluginManagement {
  repositories {
    maven("https://cache-redirector.jetbrains.com/maven-central")
    gradlePluginPortal()
  }
}
