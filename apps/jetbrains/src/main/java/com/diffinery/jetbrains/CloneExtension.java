package com.diffinery.jetbrains;

import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.ui.cloneDialog.VcsCloneDialogExtension;
import com.intellij.openapi.vcs.ui.cloneDialog.VcsCloneDialogExtensionComponent;
import com.intellij.openapi.vcs.ui.cloneDialog.VcsCloneDialogExtensionStatusLine;
import java.util.List;
import javax.swing.Icon;
import org.jetbrains.annotations.NotNull;

/** "Diffinery" in the Get from Version Control dialog, next to GitHub and GitLab. */
public final class CloneExtension implements VcsCloneDialogExtension {
  @Override
  public @NotNull String getName() {
    return "Diffinery";
  }

  @Override
  public @NotNull Icon getIcon() {
    return Plugin.ICON;
  }

  @Override
  public @NotNull List<VcsCloneDialogExtensionStatusLine> getAdditionalStatusLines() {
    Accounts.Account a = Accounts.get().account();
    if (a == null) return List.of(VcsCloneDialogExtensionStatusLine.Companion.greyText("No account"));
    return List.of(VcsCloneDialogExtensionStatusLine.Companion.greyText(a.login()));
  }

  @Override
  public @NotNull VcsCloneDialogExtensionComponent createMainComponent(@NotNull Project project, @NotNull ModalityState modalityState) {
    return new CloneComponent(project, modalityState);
  }
}
