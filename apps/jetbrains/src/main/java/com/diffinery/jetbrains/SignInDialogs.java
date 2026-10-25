package com.diffinery.jetbrains;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import java.util.function.Consumer;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/** Signing in from anywhere in the IDE: with a progress dialog that can be cancelled, and errors shown as sentences. */
final class SignInDialogs {
  private SignInDialogs() {}

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
