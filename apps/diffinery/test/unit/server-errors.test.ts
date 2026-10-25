import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env.js";
import { errorResponse } from "../../src/http/common.js";
import { HttpError } from "../../src/lib/util.js";
import { errorRecord, KEEP_ERRORS, pathToKeep, recordServerError, redact, serverErrors } from "../../src/lib/server-errors.js";
import { testD1 } from "./stubs/d1.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("server errors", () => {
  it("mask tokens and keep secret-carrying paths as their route", () => {
    expect(redact("push to https://x-token:dfy_abcdefghijklmnop@diffinery.com/a/b.git failed")).toBe("push to https://…@diffinery.com/a/b.git failed");
    expect(redact("token dfy_abcdefghijklmnop and ghs_0123456789abcdef")).toBe("token dfy_… and ghs_…");
    expect(redact("Authorization: Bearer abc.def.ghijklmnop")).toBe("Authorization: Bearer …");
    expect(pathToKeep("/signin/s3cr3t", "/signin/:token")).toBe("/signin/:token");
    expect(pathToKeep("/api/v3/repos/a/b/actions/secrets/X", "/api/v3/repos/:owner/:repo/actions/secrets/:name")).toBe("/api/v3/repos/a/b/actions/secrets/X");
  });

  it("a 5xx answer carries a request id that finds its record; other answers aren't recorded", async () => {
    const env = { DB: testD1() } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    app.onError((e, c) => errorResponse(e, c as never));
    app.put("/api/v3/repos/:owner/:repo/actions/secrets/:name", () => {
      throw new Error("D1_ERROR: storage operation exceeded timeout, using dfy_abcdefghijklmnop");
    });
    app.get("/signin/:token", () => {
      throw new Error("boom");
    });
    app.get("/missing", () => {
      throw new HttpError(404, "Not Found");
    });

    const res = await app.request("/api/v3/repos/acme/app/actions/secrets/CLOUDFLARE_API_TOKEN?x=1", { method: "PUT", headers: { "cf-ray": "8d2f3a1b4c5d6e7f-FRA" }, body: "{\"encrypted_value\":\"secret\"}" }, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string; request_id: string };
    expect(body).toEqual({ message: "internal error", request_id: "8d2f3a1b4c5d6e7f-FRA" });
    expect(res.headers.get("x-request-id")).toBe("8d2f3a1b4c5d6e7f-FRA");
    expect((await app.request("/signin/s3cr3t", {}, env)).status).toBe(500);
    expect((await app.request("/missing", {}, env)).status).toBe(404);
    await settle();

    const [e] = await serverErrors(env, { id: body.request_id });
    expect(e).toMatchObject({
      method: "PUT",
      route: "/api/v3/repos/:owner/:repo/actions/secrets/:name",
      path: "/api/v3/repos/acme/app/actions/secrets/CLOUDFLARE_API_TOKEN",
      status: 500,
      message: "Error: D1_ERROR: storage operation exceeded timeout, using dfy_…",
    });
    expect(e!.stack).toContain("D1_ERROR");
    expect(JSON.stringify(await serverErrors(env))).not.toMatch(/s3cr3t|encrypted_value|x=1|abcdefghijklmnop/);
    expect((await serverErrors(env)).map((r) => r.path)).toEqual(expect.arrayContaining(["/signin/:token"]));
    expect(await serverErrors(env)).toHaveLength(2);
  });

  it("keep only the newest records", async () => {
    const env = { DB: testD1() } as unknown as Env;
    for (let i = 0; i < KEEP_ERRORS + 5; i++) {
      const r = errorRecord(new Error(`e${i}`), { id: `r${i}`, method: "GET", route: "/x", path: "/x", status: 500 });
      await recordServerError(env, { ...r, at: new Date(Date.UTC(2026, 9, 14, 0, 0, i)).toISOString() });
    }
    const all = await serverErrors(env, { limit: 1000 });
    expect(all).toHaveLength(KEEP_ERRORS);
    expect(all[0]!.id).toBe(`r${KEEP_ERRORS + 4}`);
    expect(await serverErrors(env, { id: "r4" })).toEqual([]);
  });
});
