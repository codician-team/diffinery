import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, clientId, editorRedirect, normalizeServer, pkce, readCallback } from "../src/util";

const S = "https://diffinery.com";

describe("server and OAuth", () => {
  it("normalizes the server setting", () => {
    expect(normalizeServer(undefined)).toBe(S);
    expect(normalizeServer(" https://diffinery.com/ ")).toBe(S);
    expect(normalizeServer("diffinery.example.org")).toBe("https://diffinery.example.org");
    expect(normalizeServer("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => normalizeServer("http://diffinery.com")).toThrow(/https/);
    expect(() => normalizeServer("https://")).toThrow(/valid URL/);
  });

  it("returns to the editor by its own scheme when the server knows it", () => {
    expect(editorRedirect("vscode")).toBe("vscode://codician.diffinery/oauth");
    expect(editorRedirect("cursor")).toBe("cursor://codician.diffinery/oauth");
    expect(editorRedirect("some-fork")).toBeNull();
    expect(clientId(S)).toBe("https://diffinery.com/oauth/clients/editor.json");
  });

  it("makes a PKCE pair and an authorization URL", () => {
    const p = pkce();
    expect(p.challenge).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    const u = new URL(authorizeUrl(S, "cursor://codician.diffinery/oauth", p.challenge, p.state));
    expect(u.origin + u.pathname).toBe(`${S}/oauth/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: clientId(S), redirect_uri: "cursor://codician.diffinery/oauth", code_challenge: p.challenge, code_challenge_method: "S256", state: p.state, scope: "write" });
  });

  it("accepts only the callback of this sign-in, from this server", () => {
    const expect_ = { state: "st", server: S };
    expect(readCallback(`code=dfa_1&state=st&iss=${encodeURIComponent(S)}`, expect_)).toEqual({ code: "dfa_1" });
    expect(readCallback("code=dfa_1&state=other", expect_)).toHaveProperty("error");
    expect(readCallback("code=dfa_1&state=st&iss=https%3A%2F%2Fevil.example", expect_)).toEqual({ error: expect.stringMatching(/evil\.example/) });
    expect(readCallback("error=access_denied&state=st", expect_)).toEqual({ error: "Sign-in was cancelled in the browser." });
    expect(readCallback("state=st", expect_)).toHaveProperty("error");
  });
});
