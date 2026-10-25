package com.diffinery.jetbrains;

import com.intellij.openapi.project.Project;
import com.intellij.util.AuthData;
import git4idea.remote.GitHttpAuthDataProvider;
import java.net.URI;
import java.util.Locale;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Answers Git's password prompts for the Diffinery server with the signed-in account, so clone, pull and push need
 * no password. Silent: it never asks anything itself, and Git falls back to the IDE's own prompt when nobody's signed in.
 */
public final class GitAuth implements GitHttpAuthDataProvider {
  @Override
  public boolean isSilent() {
    return true;
  }

  @Override
  public @Nullable AuthData getAuthData(@NotNull Project project, @NotNull String url) {
    return data(url, null);
  }

  @Override
  public @Nullable AuthData getAuthData(@NotNull Project project, @NotNull String url, @NotNull String login) {
    return data(url, login);
  }

  private static AuthData data(String url, String login) {
    Accounts accounts = Accounts.get();
    Accounts.Account a = accounts.account();
    if (a == null || !sameServer(url, a.server())) return null;
    // Git asked for someone else (a username in the remote URL): leave that to them.
    if (login != null && !login.isEmpty() && !login.equalsIgnoreCase(a.login())) return null;
    String token = accounts.token();
    return token == null ? null : new AuthData(a.login(), token);
  }

  static boolean sameServer(String url, String server) {
    try {
      URI u = URI.create(url);
      URI s = URI.create(server);
      return u.getHost() != null
          && u.getHost().equalsIgnoreCase(s.getHost())
          && port(u) == port(s)
          && (u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT)).equals(s.getScheme().toLowerCase(Locale.ROOT));
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  private static int port(URI u) {
    if (u.getPort() != -1) return u.getPort();
    return "http".equalsIgnoreCase(u.getScheme()) ? 80 : 443;
  }
}
