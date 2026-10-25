package com.diffinery.jetbrains;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.InputValidatorEx;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.updateSettings.impl.UpdateSettings;
import java.io.IOException;
import java.util.List;
import java.util.function.Consumer;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/** Signing in from anywhere in the IDE: with a progress dialog that can be cancelled, and errors shown as sentences. */
final class SignInDialogs {
  private static final Logger LOG = Logger.getInstance(SignInDialogs.class);

  private SignInDialogs() {}

  /**
   * Signing in from a place that doesn't show the server (Share Project): says which Diffinery, with a way to pick
   * another one first. `done` runs on the UI thread with the account once signed in.
   */
  static void signIn(@Nullable Project project, @Nullable Consumer<Accounts.Account> done) {
    String host = Util.host(Accounts.get().server());
    int choice = Messages.showDialog(project, "Sign in to Diffinery at " + host + " with your passkey in the browser, or use another Diffinery server, such as your own.", "Sign In to Diffinery", new String[] {"Sign In to " + host + "…", "Use Another Server…", Messages.getCancelButton()}, 0, Plugin.ICON);
    if (choice == 0) signInWithBrowser(project, done);
    else if (choice == 1) chooseServer(project, () -> signInWithBrowser(project, done));
  }

  /**
   * The self-hosted Diffinery servers this IDE installs plugins from (Settings → Plugins → Manage Plugin
   * Repositories), other than the current one.
   */
  static List<String> pluginRepositoryServers() {
    try {
      return Util.pluginRepositoryServers(UpdateSettings.getInstance().getStoredPluginHosts(), Accounts.get().server());
    } catch (RuntimeException | LinkageError e) {
      // Only a suggestion: an IDE that keeps its plugin repositories elsewhere just doesn't get one.
      LOG.info("Couldn't read the IDE's plugin repositories: " + e);
      return List.of();
    }
  }

  /**
   * "Use another server…": asks for a self-hosted Diffinery's address (offering the one this plugin came from),
   * checks that a Diffinery answers there, and switches to it, which signs out of the current server. `done` runs on
   * the UI thread once switched; not when cancelled.
   */
  static void chooseServer(@Nullable Project project, @Nullable Runnable done) {
    String current = Accounts.get().server();
    List<String> suggested = pluginRepositoryServers();
    String initial = !suggested.isEmpty() ? suggested.get(0) : current.equals(Util.DEFAULT_SERVER) ? "" : current;
    Accounts.Account signedIn = Accounts.get().account();
    String raw = Messages.showInputDialog(
        project,
        "The address of your Diffinery, as in your browser's address bar, such as git.example.com. Enter diffinery.com to go back."
            + (signedIn != null ? "\nChanging the server signs you out of " + Util.host(current) + "." : ""),
        "Use Another Diffinery Server",
        Plugin.ICON,
        initial,
        new InputValidatorEx() {
          @Override
          public String getErrorText(String input) {
            return Util.serverInputError(input);
          }

          @Override
          public boolean checkInput(String input) {
            return Util.serverInputError(input) == null;
          }

          @Override
          public boolean canClose(String input) {
            return checkInput(input);
          }
        });
    if (raw == null) return;
    String server = Util.normalizeServer(raw);
    if (server.equals(current)) {
      if (done != null) done.run();
      return;
    }
    ProgressManager.getInstance().run(new Task.Modal(project, "Looking for Diffinery at " + Util.host(server), true) {
      private String problem;

      @Override
      public void run(@NotNull ProgressIndicator indicator) {
        indicator.setIndeterminate(true);
        problem = probe(server);
      }

      @Override
      public void onSuccess() {
        if (problem != null
            && Messages.showYesNoDialog(project, server + " doesn't look like a Diffinery server: " + problem + "\nCheck the address, and use it anyway only if you're sure.", "Use Another Diffinery Server", "Use Anyway", Messages.getCancelButton(), Messages.getWarningIcon())
                != Messages.YES) return;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
          Accounts.get().setServer(server);
          if (done != null) ApplicationManager.getApplication().invokeLater(done, ModalityState.any());
        });
      }
    });
  }

  /** Null when a Diffinery answers at the server (every instance serves this plugin's repository), else what went wrong. */
  private static String probe(String server) {
    try {
      Api.Response r = Api.send("GET", server + "/-/jetbrains/updatePlugins.xml", null, null, null);
      if (r.status() != 200) return "its plugin repository answered " + r.status() + ".";
      return r.body().contains("\"" + Plugin.ID + "\"") ? null : "it doesn't serve the Diffinery plugin.";
    } catch (IOException e) {
      return "it couldn't be reached (" + e.getMessage() + ").";
    }
  }

  /** Opens the browser to sign in; `done` runs on the UI thread with the account once signed in. */
  static void signInWithBrowser(@Nullable Project project, @Nullable Consumer<Accounts.Account> done) {
    ProgressManager.getInstance().run(new Task.Modal(project, "Sign In to Diffinery", true) {
      private Accounts.Account account;

      @Override
      public void run(@NotNull ProgressIndicator indicator) {
        indicator.setIndeterminate(true);
        try {
          account = Accounts.get().signInWithBrowser(indicator);
        } catch (com.intellij.openapi.progress.ProcessCanceledException e) {
          throw e;
        } catch (Exception e) {
          String m = e.getMessage() == null ? e.toString() : e.getMessage();
          ApplicationManager.getApplication().invokeLater(() -> Messages.showErrorDialog(project, "Signing in to Diffinery failed: " + m, "Diffinery"), ModalityState.any());
        }
      }

      @Override
      public void onSuccess() {
        if (account != null && done != null) done.accept(account);
      }
    });
  }

  /** Asks for an access token and signs in with it; `done` runs on the UI thread with the account. */
  static void signInWithToken(@Nullable Project project, @Nullable Consumer<Accounts.Account> done) {
    String server = Accounts.get().server();
    String token = Messages.showPasswordDialog(project, "Paste an access token from " + server + "/settings/tokens. Write access lets you push.", "Sign In to Diffinery with a Token", null);
    if (token == null || token.isBlank()) return;
    ProgressManager.getInstance().run(new Task.Modal(project, "Checking the Token with Diffinery", true) {
      private Accounts.Account account;

      @Override
      public void run(@NotNull ProgressIndicator indicator) {
        indicator.setIndeterminate(true);
        try {
          account = Accounts.get().signInWithToken(token);
        } catch (Exception e) {
          String m = e instanceof Api.Failure f && f.status == 401 ? "Diffinery didn't accept that token." : e.getMessage();
          ApplicationManager.getApplication().invokeLater(() -> Messages.showErrorDialog(project, "Signing in to Diffinery failed: " + m, "Diffinery"), ModalityState.any());
        }
      }

      @Override
      public void onSuccess() {
        if (account != null && done != null) done.accept(account);
      }
    });
  }
}
