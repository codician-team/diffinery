import java.security.MessageDigest
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
  java
  id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.diffinery"
version = providers.gradleProperty("pluginVersion").get()

repositories {
  intellijPlatform {
    localPlatformArtifacts()
    defaultRepositories()
  }
  // Maven Central through JetBrains' cache: Central rate-limits busy networks with 429s.
  maven("https://cache-redirector.jetbrains.com/maven-central")
}

dependencies {
  intellijPlatform {
    val local = providers.gradleProperty("ideaHome").orNull
    if (local != null) local(local) else intellijIdea(providers.gradleProperty("platformVersion"))
    bundledPlugin("Git4Idea")
    bundledModule("intellij.platform.vcs.dvcs")
    bundledModule("intellij.platform.vcs.dvcs.impl")
    bundledModule("intellij.platform.vcs.impl")
    testFramework(TestFrameworkType.Platform)
  }
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.opentest4j:opentest4j:1.3.0")
}

// Compiled with the JDK the IDE runs on, for Java 21: IDEs from 2024.3 on run it.
tasks.withType<JavaCompile>().configureEach { options.release = 21 }

intellijPlatform {
  buildSearchableOptions = false
  instrumentCode = false
  // ./gradlew verifyPlugin checks the plugin against the oldest IDE it supports and the ones since, with JetBrains'
  // Plugin Verifier (the same check the Marketplace runs).
  pluginVerification {
    ides {
      create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3.6")
      create(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2.4")
      create(IntelliJPlatformType.IntellijIdeaUltimate, providers.gradleProperty("platformVersion"))
    }
  }
  pluginConfiguration {
    version = providers.gradleProperty("pluginVersion")
    ideaVersion {
      sinceBuild = providers.gradleProperty("sinceBuild")
      untilBuild = provider { null }
    }
  }
}

// A fingerprint of src/main inside the plugin, and its version for the plugin's User-Agent. Diffinery's server build (apps/diffinery/scripts/build-docs.mjs)
// recomputes it from the sources and refuses a dist/ zip that was built from older ones.
val sourcesFingerprint = tasks.register("sourcesFingerprint") {
  val src = layout.projectDirectory.dir("src/main")
  val out = layout.buildDirectory.dir("generated/fingerprint")
  val pluginVersion = version.toString()
  inputs.dir(src)
  inputs.property("version", pluginVersion)
  outputs.dir(out)
  doLast {
    fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    val root = src.asFile
    val listing = root.walkTopDown().filter { it.isFile }.map { it.relativeTo(root).invariantSeparatorsPath }.sorted()
      .joinToString("") { "$it ${sha256(File(root, it).readBytes())}\n" }
    val file = out.get().file("META-INF/diffinery-sources.sha256").asFile
    file.parentFile.mkdirs()
    file.writeText(sha256(listing.toByteArray()) + "\n")
    out.get().file("META-INF/diffinery-version.txt").asFile.writeText(pluginVersion + "\n")
  }
}
sourceSets.main { resources.srcDir(sourcesFingerprint) }

// dist/ holds the zip diffinery.com serves (checked in, since the server's build has no JDK): ./gradlew dist
tasks.register<Copy>("dist") {
  from(tasks.named("buildPlugin"))
  into(layout.projectDirectory.dir("dist"))
  doFirst { layout.projectDirectory.dir("dist").asFile.listFiles()?.filter { it.name.endsWith(".zip") }?.forEach { it.delete() } }
}

// The same sources make the same zip, so dist/ only changes when the plugin does.
tasks.withType<AbstractArchiveTask>().configureEach {
  isPreserveFileTimestamps = false
  isReproducibleFileOrder = true
}
