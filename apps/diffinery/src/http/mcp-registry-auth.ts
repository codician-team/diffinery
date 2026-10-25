import { Hono } from "hono";
import type { AppVars } from "../auth/principal.js";
import type { Env } from "../env.js";

/**
 * /.well-known/mcp-registry-auth: the proof record that lets an instance's owner publish its MCP
 * server to the official MCP registry (registry.modelcontextprotocol.io) under the instance's own
 * domain, such as com.diffinery/diffinery. The registry fetches this file and checks that the key
 * `mcp-publisher login http` signs with is the one named here.
 *
 * The record comes from MCP_REGISTRY_AUTH, or for diffinery.com from PROOFS below, so the project's
 * own key is never served by another instance (it would let that key publish under that instance's
 * domain). Anything that isn't one well-formed record is a 404, like an unset one.
 */

/** Built-in records by host. Rotating a key means changing it here; the private key stays with whoever publishes. */
const PROOFS: Record<string, string> = {
  "diffinery.com": "v=MCPv1; k=ed25519; p=HbHhQYSP5tE1guSK2Df9MqxTJ8F+ojzjAesiFpgABTU=",
};

const RECORD = /^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/]+={0,2}$/;

/** This instance's proof record, or null when it has none. */
export function mcpRegistryAuth(env: Pick<Env, "PUBLIC_URL" | "MCP_REGISTRY_AUTH">): string | null {
  const own = env.MCP_REGISTRY_AUTH?.trim();
  if (own) return RECORD.test(own) ? own : null;
  return PROOFS[new URL(env.PUBLIC_URL).hostname] ?? null;
}

export const mcpRegistryAuthRoutes = new Hono<{ Bindings: Env; Variables: AppVars }>();

mcpRegistryAuthRoutes.get("/.well-known/mcp-registry-auth", (c) => {
  const record = mcpRegistryAuth(c.env);
  if (!record) return c.text("Not found", 404);
  return c.body(`${record}\n`, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
});
