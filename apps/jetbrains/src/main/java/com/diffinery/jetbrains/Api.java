package com.diffinery.jetbrains;

import com.intellij.util.io.HttpRequests;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Diffinery's REST API (/api/v3), as the signed-in account. Goes through the IDE's HTTP stack, so its proxy and
 * certificate settings apply. Every call blocks: never call it on the UI thread.
 */
final class Api {
  /** A response other than 2xx, with the server's message. */
  static final class Failure extends IOException {
    final int status;

    Failure(int status, String message) {
      super(message);
      this.status = status;
    }
  }

  record Response(int status, String body, List<String> links) {}

  private final String server;
  private final String token;

  Api(String server, String token) {
    this.server = server;
    this.token = token;
  }

  /** A request to Diffinery, with this plugin's user agent; `token` may be null. */
  static Response send(String method, String url, String token, String contentType, String body) throws IOException {
    var builder = method.equals("POST") ? HttpRequests.post(url, contentType) : HttpRequests.request(url);
    return builder
        .accept("application/json")
        .userAgent("Diffinery-JetBrains/" + Plugin.version())
        .connectTimeout(15_000)
        .readTimeout(60_000)
        .throwStatusCodeException(false)
        .isReadResponseOnError(true)
        .tuner(c -> {
          if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        })
        .connect(r -> {
          if (body != null) r.write(body);
          HttpURLConnection c = (HttpURLConnection) r.getConnection();
          int status = c.getResponseCode();
          String text = r.readString();
          return new Response(status, text, c.getHeaderFields().get("Link"));
        });
  }

  private Response call(String method, String pathOrUrl, String body) throws IOException {
    String url = pathOrUrl.startsWith("http") ? pathOrUrl : server + "/api/v3" + pathOrUrl;
    Response r = send(method, url, token, "application/json", body);
    if (r.status() / 100 != 2) throw new Failure(r.status(), message(r));
    return r;
  }

  static String message(Response r) {
    try {
      String m = Json.string(Json.object(Json.parse(r.body())), "message");
      if (m != null && !m.isEmpty()) return m + " (" + r.status() + ")";
    } catch (RuntimeException ignored) {
      // not JSON
    }
    return "Diffinery answered " + r.status();
  }

  Map<String, Object> user() throws IOException {
    return Json.object(Json.parse(call("GET", "/user", null).body()));
  }

  /** The repositories the account can push to or owns, most recently pushed first, up to `max`. */
  List<Repo> myRepos(int max) throws IOException {
    List<Repo> out = new ArrayList<>();
    String next = "/user/repos?per_page=100&sort=pushed";
    while (next != null && out.size() < max) {
      Response r = call("GET", next, null);
      for (Object o : Json.array(Json.parse(r.body()))) out.add(Repo.from(o));
      next = Util.nextLink(r.links());
    }
    return out;
  }

  List<Repo> search(String query) throws IOException {
    Response r = call("GET", "/search/repositories?per_page=30&q=" + Util.enc(query), null);
    List<Repo> out = new ArrayList<>();
    for (Object o : Json.array(Json.object(Json.parse(r.body())).get("items"))) out.add(Repo.from(o));
    return out;
  }

  Repo repo(String owner, String name) throws IOException {
    return Repo.from(Json.parse(call("GET", "/repos/" + Util.enc(owner) + "/" + Util.enc(name), null).body()));
  }

  List<String> orgs() throws IOException {
    List<String> out = new ArrayList<>();
    for (Object o : Json.array(Json.parse(call("GET", "/user/orgs", null).body()))) {
      String login = Json.string(Json.object(o), "login");
      if (login != null) out.add(login);
    }
    return out;
  }

  /** Creates a repository for the account (owner null) or an organization. */
  Repo createRepo(String owner, String name, boolean isPrivate) throws IOException {
    String body = "{\"name\":" + Json.quote(name) + ",\"private\":" + isPrivate + "}";
    return Repo.from(Json.parse(call("POST", owner == null ? "/user/repos" : "/orgs/" + Util.enc(owner) + "/repos", body).body()));
  }
}
