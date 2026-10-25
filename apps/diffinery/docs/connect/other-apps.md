---
title: Other apps
description: Connect Cursor, VS Code or any other MCP client to Diffinery with the server URL and a browser sign-in, or with a token where sign-in isn't supported.
---

Any app that supports remote MCP servers over HTTP can connect to Diffinery. Apps that support MCP's OAuth sign-in need only the URL; the rest send a token.

```text
https://diffinery.com/mcp
```

On a [self-hosted Diffinery](/docs/self-hosting), use your instance's address instead, such as `https://git.example.com/mcp`. Use it in place of `https://diffinery.com/mcp` in the examples below.

## Cursor

Add Diffinery to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project to share it with everyone who opens the project:

```json
{
  "mcpServers": {
    "diffinery": { "url": "https://diffinery.com/mcp" }
  }
}
```

Cursor lists the server in its MCP settings with a way to sign in; Diffinery's consent page opens in your browser.

To clone Diffinery repositories in Cursor (**Clone from Diffinery** in the clone picker) and push without a password, install the Diffinery editor extension: see [Clone in VS Code, Cursor and other editors](/docs/repositories/clone-in-your-editor).

## VS Code

Add Diffinery to `.vscode/mcp.json` in a workspace (or run **MCP: Add Server** from the Command Palette and choose **HTTP**):

```json
{
  "servers": {
    "diffinery": { "type": "http", "url": "https://diffinery.com/mcp" }
  }
}
```

Start the server from the file or the MCP view, and sign in when VS Code asks.

To clone Diffinery repositories in VS Code (**Clone from Diffinery** in the clone picker) and push without a password, install the Diffinery editor extension: see [Clone in VS Code, Cursor and other editors](/docs/repositories/clone-in-your-editor).

## Any other app

Look for "remote MCP server", "HTTP" or "Streamable HTTP" in the app's settings, and give it `https://diffinery.com/mcp`. If the app supports OAuth for MCP, it finds everything else on its own: Diffinery answers its first request with a `401` that points at the sign-in details, the app registers itself, and you approve it on the consent page. See [How sign-in works](/docs/connect/how-sign-in-works).

## Apps without OAuth sign-in

Send a Diffinery token in the `Authorization` header instead. Use an [agent](/docs/agents/overview)'s token (created under **Settings → Agents**) and keep it in an environment variable, never in a file you commit:

```json
{
  "mcpServers": {
    "diffinery": {
      "url": "https://diffinery.com/mcp",
      "headers": { "Authorization": "Bearer ${DIFFINERY_TOKEN}" }
    }
  }
}
```

`diffinery mcp-config` prints this snippet. Apps that can only start local (stdio) servers, such as those set up through Claude Desktop's configuration file, can reach Diffinery through a small bridge; [MCP server](/docs/agents/mcp#claude-desktop-and-other-clients-that-start-local-servers) has the setup for those and for many more clients.

## Check that it works

Ask the app "Who am I on Diffinery?". It calls the `whoami` tool and answers with the account it acts as. Apps that signed in also show under **Settings → Access tokens → Connected apps** on Diffinery.
