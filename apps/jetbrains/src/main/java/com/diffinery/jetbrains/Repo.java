package com.diffinery.jetbrains;

import java.util.Map;

/** A repository as Diffinery's REST API describes it. */
record Repo(String fullName, String description, boolean isPrivate, boolean archived, boolean fork, String cloneUrl, String htmlUrl, String defaultBranch) {
  static Repo from(Object json) {
    Map<String, Object> o = Json.object(json);
    return new Repo(
        Json.string(o, "full_name"),
        Json.string(o, "description"),
        Json.bool(o, "private"),
        Json.bool(o, "archived"),
        Json.bool(o, "fork"),
        Json.string(o, "clone_url"),
        Json.string(o, "html_url"),
        Json.string(o, "default_branch"));
  }

  String name() {
    int slash = fullName.indexOf('/');
    return slash < 0 ? fullName : fullName.substring(slash + 1);
  }

  String owner() {
    int slash = fullName.indexOf('/');
    return slash < 0 ? "" : fullName.substring(0, slash);
  }
}
