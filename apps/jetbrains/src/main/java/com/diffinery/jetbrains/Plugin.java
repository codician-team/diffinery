package com.diffinery.jetbrains;

import com.intellij.openapi.util.IconLoader;
import com.intellij.ui.components.ActionLink;
import java.awt.event.ActionListener;
import javax.swing.Icon;

final class Plugin {
  static final String ID = "com.diffinery";
  static final Icon ICON = IconLoader.getIcon("/icons/diffinery.svg", Plugin.class);

  private Plugin() {}

  /** A link that runs `action` when clicked. */
  static ActionLink link(String text, Runnable action) {
    return new ActionLink(text, (ActionListener) e -> action.run());
  }

  static String version() {
    try (var in = Plugin.class.getResourceAsStream("/META-INF/diffinery-version.txt")) {
      return in == null ? "dev" : new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim();
    } catch (java.io.IOException e) {
      return "dev";
    }
  }
}
