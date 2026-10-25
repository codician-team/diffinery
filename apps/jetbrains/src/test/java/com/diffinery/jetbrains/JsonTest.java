package com.diffinery.jetbrains;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.Test;

public class JsonTest {
  @Test
  public void readsApiResponses() {
    Map<String, Object> o = Json.object(Json.parse("{\"login\":\"ada\",\"id\":42,\"site_admin\":false,\"private\":true,\"bio\":null,\"tags\":[\"a\",{\"b\":1.5e1}],\"name\":\"Ada \\\"L\\\" \\u00e9\\n\"}"));
    assertEquals("ada", Json.string(o, "login"));
    assertEquals(42, Json.number(o, "id", -1));
    assertFalse(Json.bool(o, "site_admin"));
    assertTrue(Json.bool(o, "private"));
    assertNull(Json.string(o, "bio"));
    assertEquals("Ada \"L\" é\n", Json.string(o, "name"));
    List<Object> tags = Json.array(o.get("tags"));
    assertEquals("a", tags.get(0));
    assertEquals(15, Json.number(Json.object(tags.get(1)), "b", -1));
    assertEquals(-1, Json.number(o, "missing", -1));
    assertEquals(List.of(), Json.array(o.get("login")));
  }

  @Test
  public void rejectsBrokenJson() {
    assertThrows(RuntimeException.class, () -> Json.parse("{\"a\":1"));
    assertThrows(RuntimeException.class, () -> Json.parse("{\"a\":1} x"));
    assertThrows(RuntimeException.class, () -> Json.parse("<html>"));
  }

  @Test
  public void quotesWhatItWrites() {
    String q = Json.quote("to\"k\\en\n\u0001");
    assertEquals("to\"k\\en\n\u0001", Json.string(Json.object(Json.parse("{\"t\":" + q + "}")), "t"));
  }
}
