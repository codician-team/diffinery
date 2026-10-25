package com.diffinery.jetbrains;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small JSON reader for Diffinery's API responses: objects become maps, arrays lists, numbers doubles. The
 * platform's own JSON libraries aren't part of its stable plugin API, and this needs only to read.
 */
final class Json {
  private final String s;
  private int i;

  private Json(String s) {
    this.s = s;
  }

  static Object parse(String text) {
    Json p = new Json(text);
    p.ws();
    Object v = p.value();
    p.ws();
    if (p.i != p.s.length()) throw p.error("unexpected text after the value");
    return v;
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> object(Object v) {
    return v instanceof Map ? (Map<String, Object>) v : Map.of();
  }

  @SuppressWarnings("unchecked")
  static List<Object> array(Object v) {
    return v instanceof List ? (List<Object>) v : List.of();
  }

  static String string(Map<String, Object> o, String key) {
    return o.get(key) instanceof String v ? v : null;
  }

  static boolean bool(Map<String, Object> o, String key) {
    return Boolean.TRUE.equals(o.get(key));
  }

  static long number(Map<String, Object> o, String key, long fallback) {
    return o.get(key) instanceof Double d ? d.longValue() : fallback;
  }

  /** A JSON string literal, for the little JSON the plugin writes. */
  static String quote(String v) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : v.toCharArray()) {
      switch (c) {
        case '"' -> b.append("\\\"");
        case '\\' -> b.append("\\\\");
        case '\n' -> b.append("\\n");
        case '\r' -> b.append("\\r");
        case '\t' -> b.append("\\t");
        default -> {
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
        }
      }
    }
    return b.append('"').toString();
  }

  private IllegalArgumentException error(String what) {
    return new IllegalArgumentException("Invalid JSON at " + i + ": " + what);
  }

  private void ws() {
    while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++;
  }

  private Object value() {
    if (i >= s.length()) throw error("unexpected end");
    char c = s.charAt(i);
    return switch (c) {
      case '{' -> obj();
      case '[' -> arr();
      case '"' -> str();
      case 't' -> literal("true", Boolean.TRUE);
      case 'f' -> literal("false", Boolean.FALSE);
      case 'n' -> literal("null", null);
      default -> {
        if (c == '-' || (c >= '0' && c <= '9')) yield num();
        throw error("unexpected '" + c + "'");
      }
    };
  }

  private Object literal(String word, Object v) {
    if (!s.startsWith(word, i)) throw error("expected " + word);
    i += word.length();
    return v;
  }

  private Map<String, Object> obj() {
    Map<String, Object> m = new LinkedHashMap<>();
    i++;
    ws();
    if (peek('}')) return m;
    while (true) {
      ws();
      if (i >= s.length() || s.charAt(i) != '"') throw error("expected a key");
      String k = str();
      ws();
      expect(':');
      ws();
      m.put(k, value());
      ws();
      if (peek('}')) return m;
      expect(',');
    }
  }

  private List<Object> arr() {
    List<Object> l = new ArrayList<>();
    i++;
    ws();
    if (peek(']')) return l;
    while (true) {
      ws();
      l.add(value());
      ws();
      if (peek(']')) return l;
      expect(',');
    }
  }

  private boolean peek(char c) {
    if (i < s.length() && s.charAt(i) == c) {
      i++;
      return true;
    }
    return false;
  }

  private void expect(char c) {
    if (!peek(c)) throw error("expected '" + c + "'");
  }

  private String str() {
    i++;
    StringBuilder b = new StringBuilder();
    while (true) {
      if (i >= s.length()) throw error("unterminated string");
      char c = s.charAt(i++);
      if (c == '"') return b.toString();
      if (c != '\\') {
        b.append(c);
        continue;
      }
      if (i >= s.length()) throw error("unterminated escape");
      char e = s.charAt(i++);
      switch (e) {
        case '"', '\\', '/' -> b.append(e);
        case 'b' -> b.append('\b');
        case 'f' -> b.append('\f');
        case 'n' -> b.append('\n');
        case 'r' -> b.append('\r');
        case 't' -> b.append('\t');
        case 'u' -> {
          if (i + 4 > s.length()) throw error("short \\u escape");
          b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
          i += 4;
        }
        default -> throw error("bad escape \\" + e);
      }
    }
  }

  private Double num() {
    int start = i;
    if (s.charAt(i) == '-') i++;
    while (i < s.length() && "0123456789.eE+-".indexOf(s.charAt(i)) >= 0) i++;
    try {
      return Double.valueOf(s.substring(start, i));
    } catch (NumberFormatException e) {
      throw error("bad number");
    }
  }
}
