import { describe, expect, it } from "vitest";
import { mcpRegistryAuth } from "../../src/http/mcp-registry-auth.js";

describe("mcp-registry-auth", () => {
  const record = "v=MCPv1; k=ed25519; p=HbHhQYSP5tE1guSK2Df9MqxTJ8F+ojzjAesiFpgABTU=";

  it("serves the instance's own record, and nothing when it is missing or malformed", () => {
    expect(mcpRegistryAuth({ PUBLIC_URL: "https://git.example.com", MCP_REGISTRY_AUTH: ` ${record} ` })).toBe(record);
    expect(mcpRegistryAuth({ PUBLIC_URL: "https://git.example.com", MCP_REGISTRY_AUTH: "v=MCPv1; k=ecdsap384; p=AbC+/9==" })).toBe("v=MCPv1; k=ecdsap384; p=AbC+/9==");
    for (const MCP_REGISTRY_AUTH of [undefined, "", " ", "v=MCPv1; k=rsa; p=AAAA", "v=MCPv1; k=ed25519; p=", `${record}\nextra`, "<html>"]) {
      expect(mcpRegistryAuth({ PUBLIC_URL: "https://git.example.com", MCP_REGISTRY_AUTH })).toBeNull();
    }
  });

  it("serves diffinery.com's built-in record only on diffinery.com", () => {
    expect(mcpRegistryAuth({ PUBLIC_URL: "https://diffinery.com" })).toMatch(/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/);
    expect(mcpRegistryAuth({ PUBLIC_URL: "https://diffinery.com.evil.example" })).toBeNull();
    expect(mcpRegistryAuth({ PUBLIC_URL: "http://localhost:8787" })).toBeNull();
  });
});
