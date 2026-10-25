---
title: Docs for AI agents
description: How AI agents and tools can fetch these docs as Markdown, llms.txt, llms-full.txt, llms-small.txt, per-section files, OpenAPI and over MCP.
updated: 2026-10-25
---

These docs are written to be read by AI agents as well as people. Every page is available as plain Markdown, the whole set is available as one file, the REST API is described in OpenAPI, and agents connected over MCP can search and read the docs with tools. The URLs below need no account; the MCP tools need a Diffinery token, like every MCP call.

## Formats

| What | URL | Content type |
| --- | --- | --- |
| Index of every page, the site's and the docs' (the [llms.txt](https://llmstxt.org) convention) | `https://diffinery.com/llms.txt` | `text/plain` |
| Every page, the site's and the docs', in one Markdown file | `https://diffinery.com/llms-full.txt` | `text/plain` |
| The site's pages (what Diffinery is, comparisons, performance, FAQ) and the essential docs pages (overview, quickstart, concepts, the guides, compatibility with GitHub Actions and connecting AI apps) in one smaller file | `https://diffinery.com/llms-small.txt` | `text/plain` |
| One docs section: its index, and all its pages in one file | `https://diffinery.com/docs/<section>/llms.txt` and `/docs/<section>/llms-full.txt`, for example `/docs/actions/llms-full.txt` | `text/plain` |
| One page as Markdown | `https://diffinery.com/docs/<page>.md`, for example `/docs/actions/workflow-syntax.md` | `text/markdown` |
| The overview as Markdown | `https://diffinery.com/docs/index.md` | `text/markdown` |
| The site's other pages as Markdown: the home page, product pages and comparisons with other products | `https://diffinery.com/index.md`, and `.md` added to any page, for example `/compare/github.md` | `text/markdown` |
| REST API as OpenAPI 3.1 | `https://diffinery.com/docs/api/openapi.json` | `application/json` |
| Search index used by the docs search box | `https://diffinery.com/docs/search.json` | `application/json` |

The section names are the docs sections in lowercase with hyphens: `get-started`, `guides`, `connect-ai-apps`, `accounts`, `repositories`, `collaboration`, `actions`, `packages`, `agents-and-ai`, `security`, `administration` and `reference`. `llms.txt` links each section's file under its heading.

`/docs/llms.txt` and `/docs/llms-full.txt` redirect to the root files. These responses send `Access-Control-Allow-Origin: *`, so browser-based tools can fetch them too.

A `.md` URL for a page that doesn't exist returns `404` with a short Markdown body that points to `llms.txt`.

## Markdown pages

Each Markdown page starts with the page title as a level-1 heading, its one-line description as a blockquote and its source URL, followed by the page body:

```text
# Merge queue

> Merge pull requests in order, each tested on top of the base branch and the pull requests ahead of it, with merge_group workflows and required checks.

Source: https://diffinery.com/docs/collaboration/merge-queue

...
```

Links inside Markdown pages are absolute (`https://diffinery.com/docs/...`), so they work outside the site. Add `.md` to any of them to fetch that page as Markdown too.

### Content negotiation

A request for an HTML docs URL with `Accept: text/markdown` gets the Markdown version instead, so an agent can fetch the URL it was given:

```sh
curl -H "Accept: text/markdown" https://diffinery.com/docs/collaboration/pull-requests
```

HTML pages also point at their Markdown version with `<link rel="alternate" type="text/markdown">` in the page head and a `Link` response header.

### Copy page

Every page in the browser has **View as Markdown** and **Copy page** buttons. **Copy page** puts the page's Markdown on your clipboard, ready to paste into a chat with an AI assistant.

## Which format to use

- **Answering one question:** fetch [llms.txt](/llms.txt), pick the page from its one-line descriptions, then fetch that page's `.md` URL. This keeps the context small.
- **Explaining or comparing Diffinery:** load [llms-small.txt](/llms-small.txt). It holds the product, comparison, FAQ and company pages with their dates and sources, plus the essential docs, in a fraction of the size of `llms-full.txt`.
- **Working on one area for a while (for example, porting CI):** load that section's file, such as [the Actions section](/docs/actions/llms-full.txt).
- **Working on Diffinery broadly:** load [llms-full.txt](/llms-full.txt) once. It holds every page in reading order, separated by `---`, including the generated REST API reference, so it's large.
- **Calling the REST API:** read the [OpenAPI document](/docs/api/openapi.json) or the [REST API reference](/docs/api). Both are generated from the server's router, so every endpoint that exists is listed. Use the [REST API guide](/docs/reference/rest-api) for authentication, errors and pagination.
- **Using MCP:** the [MCP tool reference](/docs/reference/mcp-tools) is generated from the server's tool list and matches `tools/list` exactly.

## Searching and reading docs over MCP

An agent connected to the Diffinery MCP server (`https://diffinery.com/mcp`, with `Authorization: Bearer dfy_...`) has two read-only tools for the docs. They work with a token of any scope:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_docs` | `query` | Up to 8 matching pages, docs and site pages (comparisons, performance, FAQ) alike, each with `page`, `title`, `section`, the matching `heading`, `url`, `markdown_url` and a `snippet`. |
| `read_docs` | `page`: a slug like `actions/workflow-syntax`, `index`, a docs URL (a `.md` suffix or `#anchor` is ignored), or a site page's path or URL like `/compare/github` | `page`, `title` and `markdown`: the page in the same format as its `.md` URL. An unknown page returns an error that lists every slug and site page. |

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"workflow_dispatch inputs"}}}
```

Every term in the query must appear in a page for it to match. Title matches rank highest, then section headings, then body text. See [MCP](/docs/agents/mcp) for connecting a client.

## Pointing a coding agent at the docs

Add a line like this to your agent's instructions (`CLAUDE.md`, `AGENTS.md`, `.cursorrules` or similar) in repositories hosted on Diffinery:

```text
This repository is hosted on Diffinery (https://diffinery.com), a GitHub-compatible forge.
Docs index: https://diffinery.com/llms.txt (append .md to any docs URL for Markdown).
CI uses GitHub Actions syntax; check https://diffinery.com/docs/actions/compatibility.md
before using a GitHub-only feature. gh works after `diffinery auth setup-gh`; the
diffinery CLI and the MCP server at https://diffinery.com/mcp work too.
```

## Staying current

The docs ship with the server: each deploy of Diffinery serves the docs for exactly that version, and the API, CLI and MCP references are generated from the code (the API and MCP references at runtime, the CLI reference when the server is built), so they can't fall behind it. The Markdown, `llms.txt`, `llms-full.txt`, `llms-small.txt`, per-section, OpenAPI and search index responses are cached for at most five minutes. CI checks on every change that each page builds, that every link and anchor resolves, and that every endpoint and tool appears in the references.
