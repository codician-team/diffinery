package com.diffinery.jetbrains;

import com.intellij.credentialStore.CredentialAttributes;
import com.intellij.credentialStore.Credentials;
import com.intellij.ide.BrowserUtil;
import com.intellij.ide.passwordSafe.PasswordSafe;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationAction;
import com.intellij.notification.NotificationType;
import com.intellij.notification.Notifications;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.util.Disposer;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The signed-in Diffinery account. Who it is lives in the IDE's settings (diffinery.xml); the tokens live in the
 * IDE's password storage (the system keychain where there is one). Browser sign-in uses Diffinery's OAuth with PKCE
 * and a loopback redirect: tokens last 8 hours and are renewed here before they run out.
 */
@Service(Service.Level.APP)
@State(name = "Diffinery", storages = @Storage("diffinery.xml"))
public final class Accounts implements PersistentStateComponent<Accounts.Settings> {
  private static final Logger LOG = Logger.getInstance(Accounts.class);
  private static final long RENEW_BEFORE_MS = 10 * 60_000;
  private static final long SIGN_IN_TIMEOUT_MS = 10 * 60_000;

  /** Settings and who is signed in: no secrets. */
  public static final class Settings {
    public String server = Util.DEFAULT_SERVER;
    public String login;
    /** "oauth" (browser sign-in) or "token" (a pasted access token). */
    public String kind;
    public long expiresAt;
  }

  public record Account(String server, String login, boolean oauth) {}

  private Settings settings = new Settings();
  private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
  private final Object renewing = new Object();

  public static Accounts get() {
    return ApplicationManager.getApplication().getService(Accounts.class);
  }

  @Override
  public Settings getState() {
    return settings;
  }

  @Override
  public void loadState(Settings state) {
    settings = state;
  }

  /** The server to sign in to: the setting, checked. */
  public String server() {
    return Util.normalizeServer(settings.server);
  }

  /** Switches to another server (a self-hosted Diffinery), signing out of the current one. */
  public void setServer(String server) {
    String s = Util.normalizeServer(server);
    if (s.equals(server())) return;
    String old = server();
    Secret secret;
    synchronized (renewing) {
      secret = "oauth".equals(settings.kind) ? secret() : null;
      forget();
      settings.server = s;
    }
    if (secret != null && secret.refresh() != null) ApplicationManager.getApplication().executeOnPooledThread(() -> revoke(old, secret.refresh()));
    changed();
  }

  public Account account() {
    Settings s = settings;
    return s.login == null ? null : new Account(server(), s.login, "oauth".equals(s.kind));
  }

  /** Runs `listener` (on any thread) whenever someone signs in or out, until `parent` is disposed. */
  public void onChange(Runnable listener, Disposable parent) {
    listeners.add(listener);
    Disposer.register(parent, () -> listeners.remove(listener));
  }

  private void changed() {
    for (Runnable l : listeners) l.run();
  }

  // ------------------------------------------------------------------ secrets

  private CredentialAttributes attributes(String server) {
    return new CredentialAttributes("Diffinery — " + server);
  }

  private record Secret(String access, String refresh) {}

  private Secret secret() {
    Credentials c = PasswordSafe.getInstance().get(attributes(server()));
    String raw = c == null ? null : c.getPasswordAsString();
    if (raw == null || raw.isEmpty()) return null;
    Map<String, Object> o = Json.object(Json.parse(raw));
    return new Secret(Json.string(o, "access"), Json.string(o, "refresh"));
  }

  private void store(String login, String kind, String access, String refresh, long expiresAt) {
    String json = "{\"access\":" + Json.quote(access) + (refresh == null ? "" : ",\"refresh\":" + Json.quote(refresh)) + "}";
    PasswordSafe.getInstance().set(attributes(server()), new Credentials(login, json));
    settings.login = login;
    settings.kind = kind;
    settings.expiresAt = expiresAt;
  }

  private void forget() {
    PasswordSafe.getInstance().set(attributes(server()), null);
    settings.login = null;
    settings.kind = null;
    settings.expiresAt = 0;
  }

  // ------------------------------------------------------------------ tokens

  /**
   * A token for the signed-in account, renewed first when it runs out within 10 minutes; null when nobody is signed
   * in, or the sign-in has lapsed (then the person is told to sign in again). Blocks: not on the UI thread.
   */
  public String token() {
    synchronized (renewing) {
      Settings s = settings;
      if (s.login == null) return null;
      Secret secret = secret();
      if (secret == null || secret.access() == null) return null;
      if (!"oauth".equals(s.kind) || s.expiresAt - System.currentTimeMillis() > RENEW_BEFORE_MS) return secret.access();
      if (secret.refresh() == null) return null;
      try {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("grant_type", "refresh_token");
        form.put("refresh_token", secret.refresh());
        form.put("client_id", Util.clientId(server()));
        Map<String, Object> t = tokenRequest(form);
        store(s.login, "oauth", Json.string(t, "access_token"), Json.string(t, "refresh_token"), expiry(t));
        changed();
        return Json.string(t, "access_token");
      } catch (Api.Failure e) {
        // The connection was disconnected on Diffinery, or lapsed: sign in again.
        LOG.info("Renewing the Diffinery token failed: " + e.getMessage());
        forget();
        changed();
        notifySignedOut("Your Diffinery sign-in has expired or was disconnected. Sign in again to keep cloning and pushing.");
        return null;
      } catch (IOException e) {
        // Offline: the current token may still work for a few minutes.
        LOG.warn("Renewing the Diffinery token failed", e);
        return s.expiresAt > System.currentTimeMillis() ? secret.access() : null;
      }
    }
  }

  private static long expiry(Map<String, Object> t) {
    return System.currentTimeMillis() + Json.number(t, "expires_in", 3600) * 1000;
  }

  private Map<String, Object> tokenRequest(Map<String, String> form) throws IOException {
    Api.Response r = Api.send("POST", server() + "/oauth/token", null, "application/x-www-form-urlencoded", Util.form(form));
    Map<String, Object> o = Json.object(Json.parse(r.body()));
    if (r.status() / 100 != 2 || Json.string(o, "access_token") == null) {
      String d = Json.string(o, "error_description");
      throw new Api.Failure(r.status(), d != null ? d : Json.string(o, "error") != null ? Json.string(o, "error") : Api.message(r));
    }
    return o;
  }

  /** An API client for the signed-in account, or null. Blocks: not on the UI thread. */
  public Api api() {
    String t = token();
    return t == null ? null : new Api(server(), t);
  }

  // ------------------------------------------------------------------ signing in and out

  /** Signs in through the browser: Diffinery's consent page, with the person's passkey. Blocks until it's done. */
  public Account signInWithBrowser(ProgressIndicator indicator) throws Exception {
    String server = server();
    String verifier = Util.random(32);
    String state = Util.random(16);
    try (Loopback loopback = new Loopback()) {
      String redirect = loopback.redirectUri();
      indicator.setText("Waiting for you to approve the connection in your browser…");
      BrowserUtil.browse(Util.authorizeUrl(server, redirect, Util.challenge(verifier), state));
      String query = null;
      long end = System.currentTimeMillis() + SIGN_IN_TIMEOUT_MS;
      while (query == null) {
        indicator.checkCanceled();
        if (System.currentTimeMillis() > end) throw new IllegalStateException("Signing in took too long. Try again.");
        try {
          query = loopback.query.get(250, TimeUnit.MILLISECONDS);
        } catch (TimeoutException ignored) {
          // keep waiting
        } catch (ExecutionException e) {
          throw new IllegalStateException(e.getCause());
        }
      }
      String code = Util.readCallback(query, state, server);
      indicator.setText("Signing in…");
      Map<String, String> form = new LinkedHashMap<>();
      form.put("grant_type", "authorization_code");
      form.put("code", code);
      form.put("redirect_uri", redirect);
      form.put("client_id", Util.clientId(server));
      form.put("code_verifier", verifier);
      Map<String, Object> t = tokenRequest(form);
      String access = Json.string(t, "access_token");
      String login = Json.string(new Api(server, access).user(), "login");
      synchronized (renewing) {
        revokeCurrent();
        store(login, "oauth", access, Json.string(t, "refresh_token"), expiry(t));
      }
    }
    changed();
    return account();
  }

  /** Signs in with an access token someone pastes: for an agent account, or where a browser can't reach the IDE. */
  public Account signInWithToken(String token) throws IOException {
    String t = token.trim();
    String login = Json.string(new Api(server(), t).user(), "login");
    synchronized (renewing) {
      revokeCurrent();
      store(login, "token", t, null, 0);
    }
    changed();
    return account();
  }

  /** Signs out here, and ends a browser sign-in's connection on Diffinery too. Blocks: not on the UI thread. */
  public void signOut() {
    synchronized (renewing) {
      revokeCurrent();
      forget();
    }
    changed();
  }

  /** Ends the current browser sign-in's connection on Diffinery. A pasted token is the person's own: only forgotten. */
  private void revokeCurrent() {
    if (!"oauth".equals(settings.kind)) return;
    Secret s = secret();
    if (s != null && s.refresh() != null) revoke(server(), s.refresh());
  }

  private static void revoke(String server, String refreshToken) {
    Map<String, String> form = new LinkedHashMap<>();
    form.put("token", refreshToken);
    form.put("client_id", Util.clientId(server));
    try {
      Api.send("POST", server + "/oauth/revoke", null, "application/x-www-form-urlencoded", Util.form(form));
    } catch (IOException e) {
      LOG.warn("Disconnecting the IDE on Diffinery failed", e);
    }
  }

  private void notifySignedOut(String text) {
    Notification n = new Notification("Diffinery", "Diffinery", text, NotificationType.WARNING);
    n.addAction(NotificationAction.createSimpleExpiring("Sign In…", () -> SignInDialogs.signInWithBrowser(null, null)));
    Notifications.Bus.notify(n);
  }
}
