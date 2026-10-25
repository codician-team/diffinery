import type { DiffineryEvent } from "@diffinery/shared";
import { describe, expect, it } from "vitest";
import type { Repo } from "../../src/lib/directory.js";
import { webhookPayload } from "../../src/lib/webhook-payload.js";

const BASE = "https://diffinery.example";
const row = (visibility: Repo["visibility"]): Repo => ({
  id: "r1",
  owner_id: "u1",
  owner_login: "octo",
  owner_kind: "user",
  name: "app",
  description: "",
  visibility,
  default_branch: "main",
  archived: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  pushed_at: null,
});
const push: Extract<DiffineryEvent, { type: "push" }> = { type: "push", repoId: "r1", owner: "octo", repo: "app", ref: "refs/heads/main", before: "0".repeat(40), after: "a".repeat(40), forced: false, created: false, deleted: false, actor: { id: "u1", login: "octo", kind: "user" }, at: "2026-01-01T00:00:00.000Z" };

describe("webhookPayload", () => {
  it("reports a public repository as public, like GitHub", () => {
    const body = webhookPayload(BASE, push, row("public"));
    expect(body.repository).toMatchObject({ full_name: "octo/app", private: false, visibility: "public", default_branch: "main", owner: { login: "octo" } });
  });

  it("reports a private repository as private", () => {
    expect(webhookPayload(BASE, push, row("private")).repository).toMatchObject({ private: true, visibility: "private" });
  });

  it("falls back to a minimal private repository when the directory row is gone", () => {
    expect(webhookPayload(BASE, push, null).repository).toMatchObject({ full_name: "octo/app", private: true, visibility: "private" });
  });
});
