package com.diffinery.jetbrains;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.Test;

public class UtilTest {
  private static final String S = "https://diffinery.com";

  @Test
  public void serverUrls() {
    assertEquals(S, Util.normalizeServer(null));
    assertEquals(S, Util.normalizeServer(" "));
    assertEquals(S, Util.normalizeServer("diffinery.com"));
    assertEquals(S, Util.normalizeServer("https://diffinery.com/"));
    assertEquals("https://git.example.com:8443/forge", Util.normalizeServer("https://git.example.com:8443/forge/"));
    assertEquals("http://localhost:8787", Util.normalizeServer("http://localhost:8787"));
    assertEquals("http://127.0.0.1:8787", Util.normalizeServer("http://127.0.0.1:8787"));
    // Plain http only on this computer: a token sent anywhere else would travel in the clear.
    assertThrows(IllegalArgumentException.class, () -> Util.normalizeServer("http://diffinery.com"));
    assertThrows(IllegalArgumentException.class, () -> Util.normalizeServer("ftp://diffinery.com"));
    assertEquals("diffinery.com", Util.host(S));
    assertEquals("localhost:8787", Util.host("http://localhost:8787"));
  }

  @Test
  public void authorizeUrl() {
    String url = Util.authorizeUrl(S, "http://127.0.0.1:5000/callback", "ch", "st");
    assertTrue(url.startsWith(S + "/oauth/authorize?"));
    Map<String, String> q = Util.query(url.substring(url.indexOf('?') + 1));
    assertEquals("code", q.get("response_type"));
    assertEquals(S + "/oauth/clients/jetbrains.json", q.get("client_id"));
    assertEquals("http://127.0.0.1:5000/callback", q.get("redirect_uri"));
    assertEquals("S256", q.get("code_challenge_method"));
    assertEquals("st", q.get("state"));
    assertEquals("write", q.get("scope"));
  }

  @Test
  public void pkceChallenge() {
    // RFC 7636, appendix B.
    assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Util.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
    assertEquals(43, Util.random(32).length());
  }

  @Test
  public void callback() {
    assertEquals("abc", Util.readCallback("code=abc&state=st&iss=https%3A%2F%2Fdiffinery.com", "st", S));
    assertEquals("abc", Util.readCallback("code=abc&state=st", "st", S));
    assertThrows(IllegalStateException.class, () -> Util.readCallback("code=abc&state=other", "st", S));
    assertThrows(IllegalStateException.class, () -> Util.readCallback("code=abc&state=st&iss=https%3A%2F%2Fevil.example", "st", S));
    IllegalStateException denied = assertThrows(IllegalStateException.class, () -> Util.readCallback("error=access_denied&state=st", "st", S));
    assertEquals("Sign-in was cancelled in the browser.", denied.getMessage());
    assertThrows(IllegalStateException.class, () -> Util.readCallback("state=st", "st", S));
  }

  @Test
  public void repositoryReferences() {
    assertArrayEquals(new String[] {"ada", "engine"}, Util.repoRef(S, "ada/engine"));
    assertArrayEquals(new String[] {"ada", "engine"}, Util.repoRef(S, " https://diffinery.com/ada/engine "));
    assertArrayEquals(new String[] {"ada", "engine"}, Util.repoRef(S, "https://diffinery.com/ada/engine.git"));
    assertArrayEquals(new String[] {"ada", "engine"}, Util.repoRef(S, "https://diffinery.com/ada/engine/tree/main/src"));
    assertArrayEquals(new String[] {"ada", "engine"}, Util.repoRef("https://git.example.com/forge", "https://git.example.com/forge/ada/engine"));
    assertNull(Util.repoRef(S, "https://github.com/ada/engine"));
    assertNull(Util.repoRef(S, "ada"));
    assertNull(Util.repoRef(S, "ada/engine/extra"));
    assertNull(Util.repoRef(S, "ada/.."));
    assertNull(Util.repoRef(S, "a da/engine"));
  }

  @Test
  public void searchAndPaging() {
    Repo r = new Repo("ada/difference-engine", "Gears and columns", false, false, false, "", "", "main");
    assertTrue(Util.matches(r, "engine"));
    assertTrue(Util.matches(r, "ADA gears"));
    assertFalse(Util.matches(r, "engine loom"));
    assertEquals("https://diffinery.com/api/v3/user/repos?page=2", Util.nextLink(List.of("<https://diffinery.com/api/v3/user/repos?page=2>; rel=\"next\", <https://diffinery.com/api/v3/user/repos?page=5>; rel=\"last\"")));
    assertNull(Util.nextLink(List.of("<https://diffinery.com/x?page=1>; rel=\"prev\"")));
    assertNull(Util.nextLink(null));
  }

  @Test
  public void folderNames() {
    assertEquals("engine", Util.folderName("engine"));
    assertEquals("my-engine", Util.folderName("my engine"));
    assertEquals("repository", Util.folderName(".."));
  }
}
