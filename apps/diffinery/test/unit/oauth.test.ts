/**
 * OAuth for MCP clients (auth/oauth.ts): which redirect URIs an app may register and use, the access
 * preselected on the consent page, resource indicators, metadata document client IDs, and the
 * discovery documents. The whole flow, in a browser, is test/e2e/oauth.test.mjs.
 */
import { describe, expect, it } from "vitest";
import { adminAllowed, authorizationServerMetadata, checkResource, formActionSource, isMetadataClientId, mcpChallenge, protectedResourceMetadata, redirectLabel, redirectMatches, requestedScope, validRedirectUri } from "../../src/auth/oauth.js";
import { bucketsFor } from "../../src/lib/rate-limit.js";

const env = { PUBLIC_URL: "https://diffinery.com" };

describe("redirect URIs", () => {
  it("allows https anywhere, http only on this computer, and apps' own schemes", () => {
    for (const ok of ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback", "http://127.0.0.1:33418/cb", "http://[::1]:9/x", "cursor://anysphere.cursor-retrieval/oauth/callback", "vscode://vscode.github-authentication/did-authenticate"]) expect(validRedirectUri(ok), ok).toBe(true);
    for (const bad of ["http://evil.example/cb", "http://localhost.evil.example/cb", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://a.example/cb#x", "https://user:pw@a.example/cb", "chrome-extension://abc/cb", "not a url", "", 42]) expect(validRedirectUri(bad), String(bad)).toBe(false);
  });

  it("matches exactly, except a loopback port (RFC 8252)", () => {
    const reg = ["http://127.0.0.1/callback", "https://app.example/cb"];
    expect(redirectMatches(reg, "https://app.example/cb")).toBe(true);
    expect(redirectMatches(reg, "http://127.0.0.1:51234/callback")).toBe(true);
    expect(redirectMatches(reg, "http://127.0.0.1:51234/other")).toBe(false);
    expect(redirectMatches(reg, "http://localhost:51234/callback")).toBe(false);
    expect(redirectMatches(reg, "https://app.example:8443/cb")).toBe(false);
    expect(redirectMatches(reg, "https://app.example/cb?x=1")).toBe(false);
  });

  it("names where the person goes back to, and lets the form lead there", () => {
    expect(redirectLabel("http://127.0.0.1:5/callback")).toBe("an app on this computer");
    expect(redirectLabel("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(redirectLabel("cursor://anysphere.cursor-retrieval/oauth")).toBe("cursor://anysphere.cursor-retrieval");
    expect(formActionSource("https://claude.ai/api/mcp/auth_callback")).toBe("https://claude.ai");
    expect(formActionSource("cursor://anysphere.cursor-retrieval/oauth")).toBe("cursor:");
  });
});

describe("scopes and resources", () => {
  it("preselects write for apps that ask for everything, never admin", () => {
    expect(requestedScope("read write admin")).toBe("write");
    expect(requestedScope("admin")).toBe("write");
    expect(requestedScope("read")).toBe("read");
    expect(requestedScope("")).toBe("write");
    expect(requestedScope("openid profile")).toBe("write");
  });

  it("never lets an app act as a site administrator with admin access", () => {
    expect(adminAllowed({ site_admin: 1 } as never)).toBe(false);
    expect(adminAllowed({ site_admin: 0 } as never)).toBe(true);
  });

  it("accepts only this server or its /mcp as the resource", () => {
    expect(() => checkResource(env, "https://diffinery.com/mcp")).not.toThrow();
    expect(() => checkResource(env, "https://diffinery.com/")).not.toThrow();
    expect(() => checkResource(env, undefined)).not.toThrow();
    expect(() => checkResource(env, "https://evil.example/mcp")).toThrow(/resource must be/);
  });

  it("takes https URLs with a path as metadata document client IDs (plain http only locally)", () => {
    expect(isMetadataClientId("https://claude.ai/oauth/claude-code-client-metadata")).toBe(true);
    expect(isMetadataClientId("https://claude.ai/")).toBe(false);
    expect(isMetadataClientId("http://127.0.0.1:9/client.json")).toBe(false);
    expect(isMetadataClientId("http://127.0.0.1:9/client.json", true)).toBe(true);
    expect(isMetadataClientId("dfc_abc")).toBe(false);
  });
});

describe("discovery", () => {
  it("points /mcp's 401 at the resource metadata, and that at this server", () => {
    expect(mcpChallenge(env)).toBe('Bearer realm="Diffinery", resource_metadata="https://diffinery.com/.well-known/oauth-protected-resource/mcp"');
    expect(mcpChallenge(env, "invalid_token")).toMatch(/error="invalid_token"$/);
    expect(protectedResourceMetadata(env)).toMatchObject({ resource: "https://diffinery.com/mcp", authorization_servers: ["https://diffinery.com"] });
    expect(authorizationServerMetadata(env)).toMatchObject({ issuer: "https://diffinery.com", token_endpoint: "https://diffinery.com/oauth/token", code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });
  });

  it("counts registrations against the sign-in rate limit", () => {
    expect(bucketsFor("POST", "/oauth/register", { type: "anonymous" }, "1.2.3.4")).toEqual([["RL_AUTH", "ip:1.2.3.4"]]);
    expect(bucketsFor("POST", "/oauth/token", { type: "anonymous" }, "1.2.3.4")).toEqual([["RL_ANON", "ip:1.2.3.4"]]);
  });
});
