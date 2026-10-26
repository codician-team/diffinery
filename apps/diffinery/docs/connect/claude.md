---
title: Claude
description: Add Diffinery to claude.ai, Claude Desktop and the Claude mobile apps as a custom connector, approve it on Diffinery, and use it in chats and Projects.
---

Add Diffinery to Claude once as a custom connector, and Claude can read your repositories, open and review pull requests, follow CI and file issues from any chat. The connector works on claude.ai, in Claude Desktop and in the Claude mobile apps.

You need a Diffinery account and a Claude plan that allows custom connectors. For Claude Code in a terminal, see [Claude Code](/docs/connect/claude-code) instead.

## Add the connector

1. On [claude.ai](https://claude.ai) or in Claude Desktop, open **Settings → Connectors** and choose **Add custom connector**.
2. Fill in the two fields and choose **Add**:

   | Field | Value |
   | --- | --- |
   | Name | `Diffinery` |
   | Remote MCP server URL | `https://diffinery.com/mcp` |

   Leave **Advanced settings** (OAuth client ID and secret) empty: Claude registers itself with Diffinery. On a [self-hosted Diffinery](/docs/self-hosting), use your instance's address instead, such as `https://git.example.com/mcp`.
3. Choose **Connect** next to Diffinery. A Diffinery tab opens. Sign in with your passkey if you aren't signed in.
4. On the consent page, choose whom Claude acts as and its access, then choose **Connect**. The tab returns to Claude and the connector shows as connected.

> [!TIP]
> Pick one of your [agents](/docs/agents/overview) under **Act as** and **Write** access. Claude can then open pull requests and comment as that agent, and its pull requests wait for a person's approval like any agent's.

> [!NOTE]
> On a Team or Enterprise plan, an owner adds the connector once for the organization (in Claude's organization settings, under **Connectors**). Each member then chooses **Connect** and approves it with their own Diffinery account, so everyone's Claude acts with their own permissions.

## Use it in a chat

Open the tools menu below the message box and make sure **Diffinery** is turned on. Then ask in plain words, for example:

- "List my open pull requests on Diffinery and tell me which ones are waiting on CI."
- "Why did the last workflow run on acme/widgets fail? Read the failing job's log."
- "Open an issue in acme/widgets: the login page doesn't load on Safari."
- "Review pull request 42 in acme/widgets and comment on anything risky."

Claude asks before it uses a tool that changes something, unless you allowed that tool to run without asking.

The connector also works in Claude Projects, and in Claude Desktop and the mobile apps once you've added it on claude.ai or in Desktop.

## Check that it works

- In Claude, **Settings → Connectors** shows Diffinery as connected.
- On Diffinery, **Settings → Access tokens → Connected apps** lists **Claude**, with whom it acts as and its access.
- Ask Claude "Who am I on Diffinery?". It calls the `whoami` tool and answers with the account you picked.

## Disconnect

On Diffinery, choose **Disconnect** next to Claude under **Settings → Access tokens → Connected apps**. Its tokens stop working at once. To remove the connector from Claude too, remove it under **Settings → Connectors**.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The Diffinery tab says "Can't connect this app" | Claude's registration expired (registrations nobody used are removed after a week), or it asked to return somewhere it didn't register. Remove the connector in Claude and add it again. |
| Claude says a tool needs the write scope | You connected with **Read** access. Disconnect Claude on Diffinery and connect again with **Write**. |
| A tool fails with "agents may not push to protected or default branches" | Claude acts as an agent, which works on branches and opens pull requests. Ask it to open a pull request instead. |
| Claude asks you to connect again | The connection lapsed after 30 days without use, or it was disconnected. Choose **Connect** again. |
| Some tool calls fail with "Error POSTing to endpoint: Bad Gateway" | Look for those calls among your instance's requests, such as `POST /mcp` in the Cloudflare zone's analytics for your Diffinery domain. If they aren't there, they failed on Claude's side before reaching Diffinery, and asking Claude to try again usually gets through. If they are there, check your Worker's logs for errors. |

More detail on the consent page and what the tokens can do: [How sign-in works](/docs/connect/how-sign-in-works).
