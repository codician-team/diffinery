package com.diffinery.jetbrains;

import com.intellij.icons.AllIcons;
import com.intellij.ide.impl.ProjectUtil;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.TextBrowseFolderListener;
import com.intellij.openapi.ui.TextFieldWithBrowseButton;
import com.intellij.openapi.ui.ValidationInfo;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.vcs.CheckoutProvider;
import com.intellij.openapi.vcs.ui.cloneDialog.VcsCloneDialogExtensionComponent;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.CollectionListModel;
import com.intellij.ui.ColoredListCellRenderer;
import com.intellij.ui.DocumentAdapter;
import com.intellij.ui.ScrollPaneFactory;
import com.intellij.ui.SearchTextField;
import com.intellij.ui.SimpleTextAttributes;
import com.intellij.ui.components.ActionLink;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBList;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.UIUtil;
import git4idea.checkout.GitCheckoutProvider;
import git4idea.commands.Git;
import java.awt.BorderLayout;
import java.awt.CardLayout;
import java.awt.FlowLayout;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.ListSelectionModel;
import javax.swing.SwingConstants;
import javax.swing.Timer;
import javax.swing.event.DocumentEvent;
import org.jetbrains.annotations.NotNull;

/**
 * The Diffinery page of Get from Version Control: sign in, then pick one of your repositories (or search all you
 * can read, or paste owner/name or a link) and where to put it.
 */
final class CloneComponent extends VcsCloneDialogExtensionComponent {
  private static final String SIGNED_OUT = "signed-out";
  private static final String SIGNED_IN = "signed-in";

  private final Project project;
  private final ModalityState modality;
  private final CardLayout cards = new CardLayout();
  private final JPanel root = new JPanel(cards);

  private final JBLabel account = new JBLabel();
  private final SearchTextField search = new SearchTextField(false);
  private final CollectionListModel<Repo> model = new CollectionListModel<>();
  private final JBList<Repo> list = new JBList<>(model);
  private final TextFieldWithBrowseButton directory = new TextFieldWithBrowseButton();
  private final JBLabel serverLabel = new JBLabel();
  private final JButton signInButton = new JButton("Sign In with Browser…");
  private final ActionLink suggestedLink = Plugin.link("", this::useSuggested);
  private String suggested;

  private List<Repo> mine = List.of();
  private List<Repo> found = List.of();
  private Repo looked;
  private boolean directoryEdited;
  private boolean settingDirectory;
  /** Bumped on every new load and every search, so a slow answer never overwrites a newer one. */
  private final AtomicInteger loads = new AtomicInteger();
  private final AtomicInteger searches = new AtomicInteger();
  private final Timer searchTimer;

  CloneComponent(Project project, ModalityState modality) {
    this.project = project;
    this.modality = modality;
    root.add(signedOutPanel(), SIGNED_OUT);
    root.add(signedInPanel(), SIGNED_IN);
    searchTimer = new Timer(300, e -> searchServer());
    searchTimer.setRepeats(false);
    Disposer.register(this, searchTimer::stop);
    Accounts.get().onChange(() -> ApplicationManager.getApplication().invokeLater(this::refresh, modality), this);
    refresh();
  }

  // ------------------------------------------------------------------ layout

  private JComponent signedOutPanel() {
    JPanel p = new JPanel(new GridBagLayout());
    GridBagConstraints c = new GridBagConstraints();
    c.gridx = 0;
    c.anchor = GridBagConstraints.CENTER;
    c.insets = JBUI.insetsBottom(8);
    JBLabel title = new JBLabel("Sign in to Diffinery", Plugin.ICON, SwingConstants.CENTER);
    title.setFont(JBUI.Fonts.label().biggerOn(3).asBold());
    p.add(title, c);
    JBLabel text = new JBLabel("<html><div style='text-align:center;width:300px'>Sign in with your passkey in the browser to see your repositories. Git then uses this sign-in to pull and push.</div></html>");
    text.setForeground(UIUtil.getContextHelpForeground());
    p.add(text, c);
    c.insets = JBUI.insets(8, 0);
    signInButton.addActionListener(e -> SignInDialogs.signInWithBrowser(project, a -> refresh()));
    p.add(signInButton, c);
    c.insets = JBUI.insetsBottom(4);
    p.add(Plugin.link("Use an access token…", () -> SignInDialogs.signInWithToken(project, a -> refresh())), c);
    serverLabel.setForeground(UIUtil.getContextHelpForeground());
    c.insets = JBUI.insetsTop(16);
    p.add(serverLabel, c);
    // A self-hosted Diffinery is one click away: the one this plugin was installed from, when the IDE's plugin
    // repositories name it, or any other by its address.
    JPanel servers = new JPanel(new FlowLayout(FlowLayout.CENTER, JBUI.scale(12), 0));
    servers.add(suggestedLink);
    servers.add(Plugin.link("Use another server…", () -> SignInDialogs.chooseServer(project, this::refresh)));
    c.insets = JBUI.emptyInsets();
    p.add(servers, c);
    return p;
  }

  private JComponent signedInPanel() {
    JPanel header = new JPanel(new BorderLayout(JBUI.scale(8), 0));
    header.add(account, BorderLayout.CENTER);
    header.add(Plugin.link("Sign out", () -> ApplicationManager.getApplication().executeOnPooledThread(() -> Accounts.get().signOut())), BorderLayout.EAST);

    search.getTextEditor().getEmptyText().setText("Search repositories, or paste owner/name or a link");
    search.addDocumentListener(new DocumentAdapter() {
      @Override
      protected void textChanged(@NotNull DocumentEvent e) {
        found = List.of();
        looked = null;
        show();
        searchTimer.restart();
      }
    });
    search.getTextEditor().addKeyListener(new KeyAdapter() {
      @Override
      public void keyPressed(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.VK_DOWN && model.getSize() > 0) {
          list.requestFocusInWindow();
          if (list.getSelectedIndex() < 0) list.setSelectedIndex(0);
        }
      }
    });

    list.setName("diffinery.repositories");
    list.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
    list.setCellRenderer(new ColoredListCellRenderer<>() {
      @Override
      protected void customizeCellRenderer(@NotNull JList<? extends Repo> l, Repo r, int index, boolean selected, boolean focus) {
        setIcon(r.isPrivate() ? AllIcons.Nodes.Padlock : AllIcons.Vcs.Branch);
        append(r.fullName());
        StringBuilder tags = new StringBuilder(r.isPrivate() ? "  Private" : "  Public");
        if (r.archived()) tags.append(" · archived");
        if (r.fork()) tags.append(" · fork");
        append(tags.toString(), SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES);
        if (r.description() != null && !r.description().isBlank()) append("   " + r.description(), SimpleTextAttributes.GRAYED_ATTRIBUTES);
      }
    });
    list.addListSelectionListener(e -> {
      if (e.getValueIsAdjusting()) return;
      Repo r = list.getSelectedValue();
      if (r != null && !directoryEdited) setDirectory(r);
      getDialogStateListener().onOkActionEnabled(r != null);
    });

    directory.addBrowseFolderListener(new TextBrowseFolderListener(FileChooserDescriptorFactory.createSingleFolderDescriptor().withTitle("Directory to Clone Into"), project));
    directory.getTextField().getDocument().addDocumentListener(new DocumentAdapter() {
      @Override
      protected void textChanged(@NotNull DocumentEvent e) {
        if (!settingDirectory) directoryEdited = true;
      }
    });

    JPanel dir = new JPanel(new BorderLayout(JBUI.scale(8), 0));
    dir.add(new JBLabel("Directory:"), BorderLayout.WEST);
    dir.add(directory, BorderLayout.CENTER);

    JPanel top = new JPanel(new BorderLayout(0, JBUI.scale(8)));
    top.add(header, BorderLayout.NORTH);
    top.add(search, BorderLayout.SOUTH);

    JPanel p = new JPanel(new BorderLayout(0, JBUI.scale(8)));
    p.add(top, BorderLayout.NORTH);
    p.add(ScrollPaneFactory.createScrollPane(list), BorderLayout.CENTER);
    p.add(dir, BorderLayout.SOUTH);
    p.setBorder(JBUI.Borders.empty(10, 12, 0, 12));
    setDirectoryText(ProjectUtil.getBaseDir());
    return p;
  }

  private void setDirectory(Repo r) {
    setDirectoryText(Paths.get(ProjectUtil.getBaseDir(), Util.folderName(r.name())).toString());
  }

  private void setDirectoryText(String text) {
    settingDirectory = true;
    try {
      directory.setText(text);
    } finally {
      settingDirectory = false;
    }
  }

  // ------------------------------------------------------------------ state

  private void refresh() {
    Accounts.Account a = Accounts.get().account();
    getDialogStateListener().onListItemChanged();
    if (a == null) {
      serverLabel.setText("Server: " + Util.host(Accounts.get().server()));
      List<String> others = SignInDialogs.pluginRepositoryServers();
      suggested = others.isEmpty() ? null : others.get(0);
      suggestedLink.setText(suggested == null ? "" : "Use " + Util.host(suggested));
      suggestedLink.setToolTipText(suggested == null ? null : "This IDE installs the Diffinery plugin from " + suggested);
      suggestedLink.setVisible(suggested != null);
      cards.show(root, SIGNED_OUT);
      getDialogStateListener().onOkActionEnabled(false);
      return;
    }
    account.setText("<html>Signed in to " + Util.host(a.server()) + " as <b>" + a.login() + "</b></html>");
    cards.show(root, SIGNED_IN);
    load();
  }

  /** Switches to the Diffinery this plugin came from: it served the plugin, so there's nothing to check. */
  private void useSuggested() {
    String s = suggested;
    if (s != null) ApplicationManager.getApplication().executeOnPooledThread(() -> Accounts.get().setServer(s));
  }

  private void load() {
    int gen = loads.incrementAndGet();
    mine = List.of();
    model.removeAll();
    list.getEmptyText().setText("Loading your repositories…");
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
      List<Repo> repos;
      String error = null;
      try {
        Api api = Accounts.get().api();
        repos = api == null ? List.of() : api.myRepos(1000);
      } catch (IOException e) {
        repos = List.of();
        error = e.getMessage();
      }
      List<Repo> r = repos;
      String err = error;
      ApplicationManager.getApplication().invokeLater(() -> {
        if (gen != loads.get()) return;
        mine = r;
        list.getEmptyText().setText(err != null ? "Couldn't load your repositories: " + err : "No repositories yet. Search, or paste owner/name.");
        show();
      }, modality);
    });
  }

  /** The list for what's typed: a pasted owner/name or link first, then your repositories that match, then search results. */
  private void show() {
    String q = search.getText().trim();
    Repo selected = list.getSelectedValue();
    Map<String, Repo> out = new LinkedHashMap<>();
    if (looked != null) out.put(looked.fullName().toLowerCase(), looked);
    for (Repo r : mine) if (q.isEmpty() || Util.matches(r, q)) out.putIfAbsent(r.fullName().toLowerCase(), r);
    for (Repo r : found) out.putIfAbsent(r.fullName().toLowerCase(), r);
    model.replaceAll(new ArrayList<>(out.values()));
    if (selected != null && out.containsKey(selected.fullName().toLowerCase())) list.setSelectedValue(out.get(selected.fullName().toLowerCase()), true);
    else if (!q.isEmpty() && model.getSize() > 0) list.setSelectedIndex(0);
    getDialogStateListener().onOkActionEnabled(list.getSelectedValue() != null);
  }

  private void searchServer() {
    String q = search.getText().trim();
    if (q.length() < 2) return;
    int gen = searches.incrementAndGet();
    String server = Accounts.get().server();
    ApplicationManager.getApplication().executeOnPooledThread(() -> {
      Repo direct = null;
      List<Repo> results = List.of();
      try {
        Api api = Accounts.get().api();
        if (api == null) return;
        String[] ref = Util.repoRef(server, q);
        if (ref != null) {
          try {
            direct = api.repo(ref[0], ref[1]);
          } catch (Api.Failure ignored) {
            // not found or not readable: the search below still runs
          }
        }
        if (!q.contains("://")) results = api.search(q);
      } catch (IOException ignored) {
        // the local matches stay
      }
      Repo d = direct;
      List<Repo> r = results;
      ApplicationManager.getApplication().invokeLater(() -> {
        if (gen != searches.get() || !q.equals(search.getText().trim())) return;
        looked = d;
        found = r;
        show();
      }, modality);
    });
  }

  // ------------------------------------------------------------------ the dialog

  @Override
  public @NotNull JComponent getView() {
    return root;
  }

  @Override
  public JComponent getPreferredFocusedComponent() {
    return Accounts.get().account() == null ? signInButton : search;
  }

  @Override
  public void onComponentSelected() {
    getDialogStateListener().onOkActionNameChanged("Clone");
    getDialogStateListener().onOkActionEnabled(Accounts.get().account() != null && list.getSelectedValue() != null);
  }

  @Override
  public @NotNull List<ValidationInfo> doValidateAll() {
    List<ValidationInfo> out = new ArrayList<>();
    if (Accounts.get().account() == null) {
      out.add(new ValidationInfo("Sign in to Diffinery first", signInButton));
      return out;
    }
    if (list.getSelectedValue() == null) out.add(new ValidationInfo("Choose a repository", list));
    String d = directory.getText().trim();
    if (d.isEmpty()) {
      out.add(new ValidationInfo("Choose a directory", directory.getTextField()));
    } else {
      try {
        Path p = Paths.get(d);
        if (Files.isRegularFile(p)) out.add(new ValidationInfo("There's a file with that name", directory.getTextField()));
        else if (Files.isDirectory(p)) {
          try (var entries = Files.list(p)) {
            if (entries.findAny().isPresent()) out.add(new ValidationInfo("That directory isn't empty", directory.getTextField()));
          }
        }
      } catch (Exception e) {
        out.add(new ValidationInfo("That isn't a valid directory", directory.getTextField()));
      }
    }
    return out;
  }

  @Override
  public void doClone(@NotNull CheckoutProvider.Listener listener) {
    Repo r = list.getSelectedValue();
    if (r == null) return;
    Path dest = Paths.get(directory.getText().trim()).toAbsolutePath();
    Path parent = dest.getParent();
    try {
      Files.createDirectories(parent);
    } catch (IOException e) {
      throw new IllegalStateException("Couldn't create " + parent + ": " + e.getMessage(), e);
    }
    VirtualFile parentFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(parent);
    if (parentFile == null) throw new IllegalStateException("Couldn't open " + parent);
    GitCheckoutProvider.clone(project, Git.getInstance(), listener, parentFile, r.cloneUrl(), dest.getFileName().toString(), parent.toString());
  }
}
