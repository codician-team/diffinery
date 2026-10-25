package com.diffinery.jetbrains;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Helpers without the IDE's classes, so the unit tests can run them on their own. */
final class Util {
  static final String DEFAULT_SERVER = "https://diffinery.com";
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final Pattern NAME = Pattern.compile("[A-Za-z0-9._-]+");
  private static final Pattern SCHEME = Pattern.compile("^[a-z][a-z0-9+.-]*://", Pattern.CASE_INSENSITIVE);
  private static final Pattern LOOPBACK = Pattern.compile("^(localhost|127(\\.\\d{1,3}){3}|\\[::1])$");

  private Util() {}

  /** The server's base URL from the setting: https (or http on this computer), no trailing slash. */
  static String normalizeServer(String raw) {
    String s = raw == null || raw.isBlank() ? DEFAULT_SERVER : raw.trim();
    URI u;
    try {
      u = new URI(s.contains("://") ? s : "https://" + s);
    } catch (Exception e) {
      throw new IllegalArgumentException("The Diffinery server URL \"" + s + "\" isn't a valid URL.");
    }
    String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
    String host = u.getHost();
    if (host == null) throw new IllegalArgumentException("The Diffinery server URL \"" + s + "\" has no host.");
    if (!scheme.equals("https") && !(scheme.equals("http") && LOOPBACK.matcher(host).matches()))
      throw new IllegalArgumentException("The Diffinery server URL must use https (it is " + s + ").");
    String path = u.getRawPath() == null ? "" : u.getRawPath().replaceAll("/+$", "");
    return scheme + "://" + u.getRawAuthority() + path;
  }

  /** Why what someone typed as a server address can't be used, for the dialog; null when it can. */
  static String serverInputError(String raw) {
    String s = raw == null ? "" : raw.trim();
    if (s.isEmpty()) return "Enter your Diffinery's address, such as git.example.com.";
    if (s.chars().anyMatch(Character::isWhitespace)) return "An address has no spaces.";
    try {
      normalizeServer(s);
      return null;
    } catch (IllegalArgumentException e) {
      return e.getMessage();
    }
  }

  /** The Diffinery that serves a plugin repository (https://git.example.com/-/jetbrains/updatePlugins.xml), or null. */
  static String serverOfPluginRepository(String url) {
    if (url == null) return null;
    String u = url.trim().replaceAll("[?#].*$", "");
    String suffix = "/-/jetbrains/updatePlugins.xml";
    if (!u.endsWith(suffix) || !SCHEME.matcher(u).find()) return null;
    try {
      return normalizeServer(u.substring(0, u.length() - suffix.length()));
    } catch (IllegalArgumentException e) {
      return null;
    }
  }

  /**
   * The Diffinery servers among the IDE's plugin repositories, other than `current`, in order: someone who installed
   * this plugin from their own Diffinery has its updatePlugins.xml there, so it's the server they most likely mean.
   */
  static List<String> pluginRepositoryServers(List<String> repositories, String current) {
    List<String> out = new ArrayList<>();
    for (String r : repositories) {
      String s = serverOfPluginRepository(r);
      if (s != null && !s.equals(current) && !out.contains(s)) out.add(s);
    }
    return out;
  }

  /** The OAuth client_id of this plugin on a server: the URL of the metadata document the server publishes about it. */
  static String clientId(String server) {
    return server + "/oauth/clients/jetbrains.json";
  }

  static String host(String server) {
    return URI.create(server).getRawAuthority().toLowerCase(Locale.ROOT);
  }

  static String b64url(byte[] b) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  static String random(int bytes) {
    byte[] b = new byte[bytes];
    RANDOM.nextBytes(b);
    return b64url(b);
  }

  static String challenge(String verifier) {
    try {
      return b64url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  static String enc(String v) {
    return URLEncoder.encode(v, StandardCharsets.UTF_8);
  }

  static String form(Map<String, String> fields) {
    StringBuilder b = new StringBuilder();
    for (Map.Entry<String, String> e : fields.entrySet()) {
      if (!b.isEmpty()) b.append('&');
      b.append(enc(e.getKey())).append('=').append(enc(e.getValue()));
    }
    return b.toString();
  }

  static String authorizeUrl(String server, String redirectUri, String challenge, String state) {
    Map<String, String> q = new LinkedHashMap<>();
    q.put("response_type", "code");
    q.put("client_id", clientId(server));
    q.put("redirect_uri", redirectUri);
    q.put("code_challenge", challenge);
    q.put("code_challenge_method", "S256");
    q.put("state", state);
    q.put("scope", "write");
    return server + "/oauth/authorize?" + form(q);
  }

  static Map<String, String> query(String raw) {
    Map<String, String> m = new LinkedHashMap<>();
    if (raw == null || raw.isEmpty()) return m;
    for (String part : raw.split("&")) {
      int eq = part.indexOf('=');
      String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
      String v = eq < 0 ? "" : URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8);
      m.putIfAbsent(k, v);
    }
    return m;
  }

  /**
   * The code from the server's answer, after checking it belongs to this sign-in (state) and comes from this server
   * (RFC 9207 iss). Throws with a sentence for the person otherwise.
   */
  static String readCallback(String rawQuery, String state, String server) {
    Map<String, String> q = query(rawQuery);
    if (!state.equals(q.get("state"))) throw new IllegalStateException("The sign-in response didn't match this sign-in. Try again.");
    String iss = q.get("iss");
    if (iss != null && !iss.replaceAll("/+$", "").equals(server)) throw new IllegalStateException("The sign-in response came from " + iss + ", not " + server + ".");
    String err = q.get("error");
    if (err != null) {
      if (err.equals("access_denied")) throw new IllegalStateException("Sign-in was cancelled in the browser.");
      String d = q.get("error_description");
      throw new IllegalStateException("Diffinery refused the sign-in: " + (d == null || d.isEmpty() ? err : d));
    }
    String code = q.get("code");
    if (code == null || code.isEmpty()) throw new IllegalStateException("The sign-in response had no code. Try again.");
    return code;
  }

  /** {owner, repo} from "owner/repo", or from a web or clone URL on this server; null for anything else. */
  static String[] repoRef(String server, String input) {
    String s = input.trim();
    String path;
    boolean url = SCHEME.matcher(s).find();
    if (url) {
      URI u;
      try {
        u = new URI(s);
      } catch (Exception e) {
        return null;
      }
      URI base = URI.create(server);
      if (u.getRawAuthority() == null || !u.getRawAuthority().equalsIgnoreCase(base.getRawAuthority())) return null;
      String bp = base.getRawPath() == null ? "" : base.getRawPath().replaceAll("/+$", "");
      String p = u.getRawPath() == null ? "" : u.getRawPath();
      if (!p.startsWith(bp)) return null;
      path = p.substring(bp.length());
    } else {
      path = s;
    }
    String[] parts = path.replaceAll("^/+|/+$", "").split("/");
    if (parts.length < 2 || (parts.length > 2 && !url)) return null;
    String owner = parts[0];
    String repo = parts[1].replaceAll("\\.git$", "");
    if (!NAME.matcher(owner).matches() || !NAME.matcher(repo).matches() || repo.equals(".") || repo.equals("..")) return null;
    return new String[] {owner, repo};
  }

  /** Whether a repository matches what someone typed: every word in its full name or description, ignoring case. */
  static boolean matches(Repo r, String query) {
    String hay = (r.fullName() + " " + (r.description() == null ? "" : r.description())).toLowerCase(Locale.ROOT);
    for (String w : query.toLowerCase(Locale.ROOT).trim().split("\\s+")) if (!w.isEmpty() && !hay.contains(w)) return false;
    return true;
  }

  /** The next page from a Link header (RFC 8288), as GitHub-style APIs send it. */
  static String nextLink(List<String> headers) {
    if (headers == null) return null;
    Pattern p = Pattern.compile("<([^>]+)>\\s*;\\s*rel=\"?next\"?");
    for (String h : headers)
      for (String part : h.split(",")) {
        Matcher m = p.matcher(part);
        if (m.find()) return m.group(1);
      }
    return null;
  }

  /** A folder name for a clone, from a repository name. */
  static String folderName(String repo) {
    String n = repo.replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^[-.]+|[-.]+$", "");
    return n.isEmpty() ? "repository" : n;
  }
}
