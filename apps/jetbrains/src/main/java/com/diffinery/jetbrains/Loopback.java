package com.diffinery.jetbrains;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;

/**
 * A one-time listener on 127.0.0.1 for the browser's answer after Diffinery's consent page (RFC 8252): the browser
 * comes back to the IDE without asking to open an app.
 */
final class Loopback implements AutoCloseable {
  private static final String PAGE =
      """
      <!doctype html><meta charset="utf-8"><title>Signed in to Diffinery</title>
      <style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1f2328}
      main{max-width:28rem;text-align:center}h1{font-size:1.4rem}@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}</style>
      <main><h1>%s</h1><p>%s</p></main>""";

  final CompletableFuture<String> query = new CompletableFuture<>();
  private final HttpServer server;

  Loopback() throws IOException {
    server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    server.createContext("/callback", ex -> {
      String q = ex.getRequestURI().getRawQuery();
      boolean ok = q != null && Util.query(q).containsKey("code");
      String html = ok
          ? PAGE.formatted("You're signed in to Diffinery", "You can close this tab and go back to your IDE.")
          : PAGE.formatted("Sign-in didn't finish", "Go back to your IDE to see why, and try again.");
      byte[] b = html.getBytes(StandardCharsets.UTF_8);
      ex.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
      ex.getResponseHeaders().set("Cache-Control", "no-store");
      ex.sendResponseHeaders(200, b.length);
      try (OutputStream o = ex.getResponseBody()) {
        o.write(b);
      }
      query.complete(q == null ? "" : q);
    });
    server.start();
  }

  String redirectUri() {
    return "http://127.0.0.1:" + server.getAddress().getPort() + "/callback";
  }

  @Override
  public void close() {
    server.stop(0);
  }
}
