package com.diffinery.jetbrains;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.DumbAwareAction;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.openapi.vcs.ProjectLevelVcsManager;
import com.intellij.util.ui.cloneDialog.VcsCloneDialog;
import org.jetbrains.annotations.NotNull;

/** Git → Clone from Diffinery: Get from Version Control, with Diffinery already chosen. */
public final class CloneAction extends DumbAwareAction {
  @Override
  public @NotNull ActionUpdateThread getActionUpdateThread() {
    return ActionUpdateThread.BGT;
  }

  @Override
  public void actionPerformed(@NotNull AnActionEvent e) {
    Project project = e.getProject() != null ? e.getProject() : ProjectManager.getInstance().getDefaultProject();
    VcsCloneDialog dialog = new VcsCloneDialog.Builder(project).forExtension(CloneExtension.class);
    if (dialog.showAndGet()) dialog.doClone(ProjectLevelVcsManager.getInstance(project).getCompositeCheckoutListener());
  }
}
