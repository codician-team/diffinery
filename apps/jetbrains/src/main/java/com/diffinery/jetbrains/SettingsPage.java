package com.diffinery.jetbrains;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.options.Configurable;
import com.intellij.openapi.options.ConfigurationException;
import com.intellij.openapi.util.Disposer;
import com.intellij.ui.components.ActionLink;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBTextField;
import com.intellij.util.ui.FormBuilder;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.UIUtil;
import java.awt.FlowLayout;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JPanel;
import org.jetbrains.annotations.Nls;

/** Settings → Version Control → Diffinery: the account, and the server for a self-hosted Diffinery. */
public final class SettingsPage implements Configurable {
  private JBTextField server;
  private JBLabel account;
  private JButton signIn;
  private ActionLink useToken;
  private ActionLink signOut;
  private Disposable disposable;

  @Override
  public @Nls String getDisplayName() {
    return "Diffinery";
  }

  @Override
  public JComponent createComponent() {
    disposable = Disposer.newDisposable();
    server = new JBTextField();
    account = new JBLabel();
    signIn = new JButton("Sign In with Browser…");
    signIn.addActionListener(e -> SignInDialogs.signInWithBrowser(null, a -> update()));
    useToken = Plugin.link("Use an access token…", () -> SignInDialogs.signInWithToken(null, a -> update()));
    signOut = Plugin.link("Sign out", () -> ApplicationManager.getApplication().executeOnPooledThread(() -> Accounts.get().signOut()));
    Accounts.get().onChange(() -> ApplicationManager.getApplication().invokeLater(this::update, ModalityState.any()), disposable);

    JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, JBUI.scale(8), 0));
    buttons.add(signIn);
    buttons.add(useToken);
    buttons.add(signOut);
    JBLabel serverHelp = new JBLabel("Change it only for a self-hosted Diffinery. Changing it signs you out.");
    serverHelp.setForeground(UIUtil.getContextHelpForeground());
    JBLabel gitHelp = new JBLabel("<html>When you're signed in, Git uses this account for the server: clone, pull and push need no password.</html>");
    gitHelp.setForeground(UIUtil.getContextHelpForeground());

    reset();
    return FormBuilder.createFormBuilder()
        .addLabeledComponent("Account:", account)
        .addComponentToRightColumn(buttons)
        .addComponentToRightColumn(gitHelp)
        .addSeparator()
        .addLabeledComponent("Server:", server)
        .addComponentToRightColumn(serverHelp)
        .addComponentFillVertically(new JPanel(), 0)
        .getPanel();
  }

  private void update() {
    if (account == null) return;
    Accounts.Account a = Accounts.get().account();
    account.setText(a == null ? "Not signed in" : "<html><b>" + a.login() + "</b> on " + Util.host(a.server()) + (a.oauth() ? "" : " (access token)") + "</html>");
    signIn.setVisible(a == null);
    useToken.setVisible(a == null);
    signOut.setVisible(a != null);
  }

  @Override
  public boolean isModified() {
    return server != null && !server.getText().trim().equals(Accounts.get().server());
  }

  @Override
  public void apply() throws ConfigurationException {
    try {
      Accounts.get().setServer(server.getText());
    } catch (IllegalArgumentException e) {
      throw new ConfigurationException(e.getMessage());
    }
    reset();
  }

  @Override
  public void reset() {
    if (server == null) return;
    server.setText(Accounts.get().server());
    update();
  }

  @Override
  public void disposeUIResources() {
    if (disposable != null) Disposer.dispose(disposable);
    disposable = null;
    server = null;
    account = null;
  }
}
