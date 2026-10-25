package com.diffinery.jetbrains;

import com.intellij.ide.BrowserUtil;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationAction;
import com.intellij.notification.NotificationType;
import com.intellij.notification.Notifications;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.ComboBox;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.ui.ValidationInfo;
import com.intellij.ui.components.JBCheckBox;
import com.intellij.ui.components.JBTextField;
import com.intellij.util.ui.FormBuilder;
import git4idea.commands.Git;
import git4idea.commands.GitCommand;
import git4idea.commands.GitCommandResult;
import git4idea.commands.GitLineHandler;
import git4idea.repo.GitRemote;
import git4idea.repo.GitRepository;
import git4idea.repo.GitRepositoryManager;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import javax.swing.JComponent;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/** Git → Share Project on Diffinery: creates a Diffinery repository for the project's Git repository and pushes it. */
public final class ShareAction extends DumbAwareAction {
  private static final Pattern NAME = Pattern.compile("[A-Za-z0-9._-]{1,100}");

  @Override
  public @NotNull ActionUpdateThread getActionUpdateThread() {
    return ActionUpdateThread.BGT;
  }

  @Override
  public void update(@NotNull AnActionEvent e) {
    Project p = e.getProject();
    e.getPresentation().setEnabledAndVisible(p != null && !p.isDefault());
  }

  @Override
  public void actionPerformed(@NotNull AnActionEvent e) {
    Project project = e.getProject();
    if (project == null) return;
    List<GitRepository> repos = GitRepositoryManager.getInstance(project).getRepositories();
    if (repos.isEmpty()) {
      Messages.showInfoMessage(project, "This project isn't a Git repository yet. Choose VCS → Create Git Repository, commit your files, then share it.", "Share Project on Diffinery");
      return;
    }
    GitRepository repo = repos.get(0);
    if (repo.getCurrentRevision() == null || repo.getCurrentBranchName() == null) {
      Messages.showInfoMessage(project, "Commit your files on a branch first, then share the project.", "Share Project on Diffinery");
      return;
    }
    if (Accounts.get().account() == null) SignInDialogs.signIn(project, a -> chooseAndShare(project, repo));
    else chooseAndShare(project, repo);
  }

  private static void chooseAndShare(Project project, GitRepository repo) {
    ProgressManager.getInstance().run(new Task.Modal(project, "Share Project on Diffinery", true) {
      private Accounts.Account account;
      private List<String> owners = List.of();
      private String error;

      @Override
      public void run(@NotNull ProgressIndicator indicator) {
        account = Accounts.get().account();
        try {
          Api api = Accounts.get().api();
          if (api == null) {
            error = "Sign in to Diffinery first.";
            return;
          }
          List<String> o = new ArrayList<>();
          o.add(account.login());
          o.addAll(api.orgs());
          owners = o;
        } catch (Exception ex) {
          error = ex.getMessage();
        }
      }

      @Override
      public void onSuccess() {
        if (error != null) {
          Messages.showErrorDialog(project, error, "Share Project on Diffinery");
          return;
        }
        ShareDialog d = new ShareDialog(project, owners, Util.folderName(repo.getRoot().getName()));
        if (!d.showAndGet()) return;
        String owner = d.owner();
        share(project, repo, owner.equals(account.login()) ? null : owner, d.name(), d.isPrivate());
      }
    });
  }

  private static void share(Project project, GitRepository repo, @Nullable String org, String name, boolean isPrivate) {
    String branch = repo.getCurrentBranchName();
    ProgressManager.getInstance().run(new Task.Backgroundable(project, "Sharing on Diffinery", true) {
      private Repo created;

      @Override
      public void run(@NotNull ProgressIndicator indicator) {
        Api api = Accounts.get().api();
        if (api == null) throw new IllegalStateException("Sign in to Diffinery first.");
        try {
          indicator.setText("Creating the repository…");
          created = api.createRepo(org, name, isPrivate);
        } catch (Exception ex) {
          throw new IllegalStateException("Diffinery couldn't create the repository: " + ex.getMessage(), ex);
        }
        boolean hasOrigin = repo.getRemotes().stream().map(GitRemote::getName).anyMatch("origin"::equals);
        String remote = hasOrigin ? "diffinery" : "origin";
        GitCommandResult add = Git.getInstance().addRemote(repo, remote, created.cloneUrl());
        if (!add.success()) throw new IllegalStateException("Adding the remote failed: " + add.getErrorOutputAsJoinedString());
        repo.update();
        indicator.setText("Pushing " + branch + "…");
        GitLineHandler push = new GitLineHandler(project, repo.getRoot(), GitCommand.PUSH);
        push.setUrl(created.cloneUrl());
        push.addParameters("--set-upstream", remote, "refs/heads/" + branch + ":refs/heads/" + branch);
        GitCommandResult pushed = Git.getInstance().runCommand(push);
        repo.update();
        if (!pushed.success()) throw new IllegalStateException("Created " + created.fullName() + ", but pushing failed: " + pushed.getErrorOutputAsJoinedString());
      }

      @Override
      public void onSuccess() {
        Notification n = new Notification("Diffinery", "Shared on Diffinery", "Pushed " + branch + " to " + created.fullName() + ".", NotificationType.INFORMATION);
        n.addAction(NotificationAction.createSimpleExpiring("Open on Diffinery", () -> BrowserUtil.browse(created.htmlUrl())));
        Notifications.Bus.notify(n, project);
      }

      @Override
      public void onThrowable(@NotNull Throwable error) {
        Notifications.Bus.notify(new Notification("Diffinery", "Sharing on Diffinery failed", String.valueOf(error.getMessage()), NotificationType.ERROR), project);
      }
    });
  }

  private static final class ShareDialog extends DialogWrapper {
    private final ComboBox<String> owner;
    private final JBTextField name;
    private final JBCheckBox isPrivate = new JBCheckBox("Private: only people and teams you give access can see it", true);

    ShareDialog(Project project, List<String> owners, String defaultName) {
      super(project);
      owner = new ComboBox<>(owners.toArray(String[]::new));
      name = new JBTextField(defaultName);
      setTitle("Share Project on Diffinery");
      setOKButtonText("Share");
      init();
    }

    @Override
    protected @Nullable JComponent createCenterPanel() {
      return FormBuilder.createFormBuilder()
          .addLabeledComponent("Owner:", owner)
          .addLabeledComponent("Repository name:", name)
          .addComponent(isPrivate)
          .getPanel();
    }

    @Override
    public @Nullable JComponent getPreferredFocusedComponent() {
      return name;
    }

    @Override
    protected @Nullable ValidationInfo doValidate() {
      String n = name.getText().trim();
      if (!NAME.matcher(n).matches() || n.equals(".") || n.equals("..")) return new ValidationInfo("Use letters, digits, '.', '-' or '_'", name);
      return null;
    }

    String owner() {
      return (String) owner.getSelectedItem();
    }

    String name() {
      return name.getText().trim();
    }

    boolean isPrivate() {
      return isPrivate.isSelected();
    }
  }
}
