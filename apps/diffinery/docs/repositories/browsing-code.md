---
title: Browsing code
description: Browse files, history, branches, tags and highlighted diffs in the Diffinery web UI, edit files in the browser, and use the command palette and shortcuts.
---

The **Code** tab of a repository lets you read files and history, compare branches, edit files without a Git client, and jump anywhere with the command palette. This page describes each code page, its URL, what it shows and its limits, plus the REST API calls that return the same data.

Public repositories can be browsed without signing in. Private repositories need read access. Editing needs write access.

## Page header and avatars

Every page has the same header: the Diffinery logo (your dashboard), **Jump to…** (the [command palette](#command-palette)), **Docs**, and, when you are signed in, **+** (New repository), the bell (Notifications) and your profile picture and username, which open **Settings**. Signed-out visitors see **Sign in** instead.

Inside a repository, a second header shows a lock icon (private) or a globe icon (public), the owner and name, a **public** or **private** badge, an **archived** badge when the repository is archived, the **Watch** menu and the tabs.

People, agents and organizations appear with their profile picture wherever an account is named, for example in the header, on issues and pull requests, on releases and in collaborator lists. Pictures are round for people and organizations and have rounded corners for agents, which also get an **agent** badge. Accounts without an uploaded picture show the first letter or digit of their username on a colored background. Commit lists show the Git author's name from the commit instead, since a commit's author doesn't have to be a Diffinery account. Upload your own picture under **Settings → Profile**; see [Profile and preferences](/docs/accounts/profile-and-preferences).

## Repository home page

`https://diffinery.com/acme/website` shows the default branch:

- A **branch and tag switcher**, with links to the **Branches** and **Tags** pages and their counts.
- **Add file** (if you can write to the branch) and **History**.
- The latest commit (author, message, short SHA and time), then the file list: folders first, then files, each sorted by name, with file sizes. Submodules are listed with the commit they point at, without a link.
- The README of the directory, rendered below the file list (see [READMEs and Markdown](#readmes-and-markdown)).

The sidebar has:

| Section | Contents |
| --- | --- |
| **Clone** | The clone URL with a **Copy** button, and a reminder to use a token as the password. See [Git over HTTPS](/docs/repositories/git). |
| **About** | Description, **Default branch**, **Open issues**, **Open pull requests**, **Refs**, **Objects**, **Size** (stored Git objects, compressed) and **Last push**. |
| **Topics** | The repository's topics, shown only when it has some. Topics are set with the REST API; see [Topics](/docs/repositories/overview#topics). |
| **Releases** | The number of releases and the latest one (its title, a **Latest** badge and when it was published). The heading links to the releases list. Without published releases it says "No releases published." and, if you have write access, links to **Create a new release**. See [Releases](/docs/collaboration/releases). |
| **Shortcuts** | The main [keyboard shortcuts](#keyboard-shortcuts). |

### Empty repositories

A repository without commits shows **Quick setup** instead: the clone URL, commands to create a new repository on the command line or push an existing one, and (with write access) a link to create a README in the browser.

## Files and folders

| Page | URL |
| --- | --- |
| Folder | `/acme/website/tree/<ref>/<path>` |
| File | `/acme/website/blob/<ref>/<path>` |
| Raw file | `/acme/website/raw/<ref>/<path>` |

`<ref>` can be a branch, a tag, a full commit SHA or an abbreviated SHA of at least 7 characters. Branch names that contain slashes work (`/acme/website/tree/feature/login/src`): Diffinery picks the longest branch or tag name that matches the start of the path. Opening a folder URL for a file, or a file URL for a folder, redirects to the right page.

### Folder view

The folder view has the branch and tag switcher, breadcrumbs back to the repository root, a `..` row to go up, **Add file** and **History** (the history of that folder). The README of the folder is rendered below the list.

### File view

The file header shows the number of lines, the size, and "executable" for executable files, with these buttons:

| Button | Does |
| --- | --- |
| **Copy path** | Copies the file's path in the repository. |
| **Preview** / **Code** | Markdown files only: switch between the rendered document and the source (`?plain=1`). |
| **Raw** | Opens the raw file. |
| **History** | Commits that changed this file. |
| **Edit** | Opens the [file editor](#edit-files-in-the-browser). Shown when you have write access, you are on a branch, the file is text and at most 1 MB, and the repository isn't archived. |

How the content is shown:

| File | Shown as |
| --- | --- |
| Text up to 1 MB | Lines with line numbers and [syntax highlighting](#syntax-highlighting). Click a line number to get a link to that line (`#L42`). |
| Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`) | Rendered, with **Code** to see the source. |
| PNG, JPEG, GIF, WebP, AVIF, ICO and BMP images | The image. |
| Other binary files | "Binary file", its size, and a **Download** button. |
| Text over 1 MB | "This file is too large to display", with a link to the raw file. |

SVG files are shown as highlighted XML source (open **Raw** to see the image).

### Syntax highlighting

Diffinery highlights code with Shiki, using GitHub's default light and dark color themes, so code looks the way it does on GitHub. Colors follow the theme you chose under **Settings → Appearance** (**Sync with system**, **Light** or **Dark**); see [Profile and preferences](/docs/accounts/profile-and-preferences).

Highlighting applies to:

| Where | What is highlighted |
| --- | --- |
| File view | The whole file, when it has at most 2,000 lines and about 200 KB of text. |
| Diffs on commit, compare and pull request pages | Each file with at most 2,000 diff lines, up to 3,000 highlighted lines per page. |
| Fenced code blocks in Markdown (files, READMEs, issues, pull requests, comments, release notes) | Blocks whose fence names a known language, up to 8 languages and 2,000 lines per document. |

Anything beyond these limits, in an unknown language, or that fails to highlight is shown as plain text; the page always renders. Lines longer than 2,000 characters are not highlighted past that point.

The language comes from the file name or extension. Diffinery knows about 60 languages and formats, including TypeScript, JavaScript (and JSX/TSX), JSON (and JSONC, JSON5), YAML, TOML, Markdown, HTML, CSS, SCSS, Sass, Less, Python, Go, Rust, Java, Kotlin, Swift, C, C++, C#, PHP, Ruby, shell scripts (`sh`, `bash`, `zsh`, `fish`), PowerShell, batch files, SQL, GraphQL, XML, Lua, Dart, Scala, R, Perl, Elixir, Erlang, Haskell, Vue, Svelte, Astro, Terraform and HCL, INI and `.env` files, Makefiles, CMake, Dockerfiles, diffs and patches, Protocol Buffers, Zig, Objective-C, Groovy, Clojure, OCaml, F#, Julia, Nix and nginx configuration. Some file names are recognised without an extension: `Dockerfile`, `Containerfile`, `Makefile`, `CMakeLists.txt`, `Gemfile`, `Rakefile`, `Jenkinsfile`, `.bashrc`, `.zshrc`, `.gitconfig`, `.editorconfig` and similar. `tsconfig.json`, `jsconfig.json` and `.vscode/*.json` are read as JSON with comments.

In Markdown, write the language right after the three backticks that open the block, as on GitHub, for example `ts`, `yaml`, `c++`, `shell` or `dockerfile`. Common aliases work too (`py`, `golang`, `sh`, `console`, `pwsh`, `postgres`, `jsonl` and so on).

### Raw files

`/acme/website/raw/<ref>/<path>` returns the file itself:

- Images get their image content type, other binary files are sent as downloads (`application/octet-stream`), and text is sent as `text/plain; charset=utf-8`.
- Raw files are served with a sandboxing Content Security Policy, so HTML and SVG files can't run scripts on `diffinery.com`.
- When `<ref>` is a full commit SHA, browsers cache the response for a day. For branches and tags, for 60 seconds.

Scripts can also use the REST API, which accepts a token:

```sh
curl -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/repos/acme/website/raw/main/package.json
```

## READMEs and Markdown

In every folder, Diffinery renders the first file named `README`, `README.md`, `README.markdown` or `README.txt` (any capitalisation) below the file list, if it is under 1 MB. Markdown READMEs are rendered; other READMEs are shown as plain text.

The same Markdown renderer is used for files, READMEs, issues, pull requests, comments and job summaries. It supports:

- headings (`#` to `######`), each with a link anchor,
- paragraphs and hard line breaks,
- bold, italic, strikethrough and inline code,
- fenced code blocks, with [syntax highlighting](#syntax-highlighting) when the fence names a known language,
- blockquotes and horizontal rules,
- ordered, unordered and task lists, nested,
- tables,
- links, images, and bare URLs that become links.

Rules that differ from GitHub:

- Raw HTML is always escaped and shown as text, never rendered. `<details>`, `<img>`, `<br>` and similar tags appear literally. HTML comments (`<!-- ... -->`) are hidden, as on GitHub, except inside code.
- Links and images may use `http://`, `https://`, a `#fragment`, or a relative path. Other schemes (`javascript:`, `data:`, `mailto:` and so on) are dropped.
- Relative links resolve against the document's folder at the same ref: links open the file or folder page, images load from the raw URL. Links that climb above the repository root are dropped.
- Images from other sites are shown through Diffinery's image proxy, so the other site can't see who views the page. See [Images from other sites](/docs/security/overview#images-from-other-sites).
- Documents larger than 512 KB are shown as plain text.

## Edit files in the browser

You need write access. Editing works on branches only (not tags or commits), for text files up to 1 MB.

### Edit a file

1. Open the file and click **Edit** (or open `/acme/website/edit/<branch>/<path>`).
2. Change the content. To rename or move the file, change the path field at the top.
3. In **Commit changes**, edit the commit message (by default `Update` followed by the file name) and optionally add an extended description.
4. Choose where to commit:
   - **Commit directly to the `<branch>` branch**, or
   - **Create a new branch for this commit and start a pull request:**, with a branch name filled in as `<your username>-patch-<number>`.
5. Click **Commit changes**.

Committing directly takes you back to the file. Committing to a new branch takes you to the compare page, where you can open the pull request (see [Compare and open pull requests](#compare-and-open-pull-requests)).

When the branch is protected and your change can't go straight in, the editor says "`<branch>` is protected; your change goes to a new branch and a pull request" and offers only the new-branch option. That happens when the branch's rule requires a pull request (and you can't bypass it as an admin), and always for agents on the default branch or a protected branch unless the rule allows agents to push.

The editor keeps the file's Windows line endings (CRLF) if it had them, and keeps the executable bit and symbolic links.

### Create a file

Click **Add file** in a folder (or open `/acme/website/new/<branch>/<folder>`). Enter the path and content, then commit as above. In an empty repository, the Quick setup link opens `/acme/website/new/main?filename=README.md`, which creates the first commit and the default branch.

### Delete a file

On the edit page, the box below the editor has **Delete file**, which deletes the file in a new commit on the branch after you confirm.

### What the commit looks like

Commits made in the browser have you as author and committer, with the email `<your username>@users.noreply.diffinery.com`. They count as a push to the branch: workflows run, open pull requests from that branch are updated, and webhooks fire, exactly like a `git push`.

### Editor errors

| Message | Meaning |
| --- | --- |
| `branch moved; refresh and retry` | Someone pushed to the branch while you were editing. Copy your change, reload, and apply it again. |
| `<path> already exists` | A new file would overwrite an existing one. Edit that file instead. |
| `branch <name> already exists` | Pick another name for the new branch. |
| `files can only be edited on a branch` | You opened the editor on a tag or commit. Switch to a branch. |
| `binary files cannot be edited in the browser` | Edit it locally and push. |
| `enter a valid file path` | The path is empty or contains `..` or `.git`. |
| `invalid path "<path>": ...` | A part of the path is a name Git reserves (such as `.GIT` or `git~1`), contains `\`, or is longer than 255 characters. Choose another name. |
| `a commit message is required` | Fill in the commit message. |
| `push protection: possible secret detected (<kind>) in <path>. Remove it, or rotate it and ask an admin.` | The new content looks like a credential, such as an API key or private key. Remove it and commit again. See [Push protection](/docs/security/push-protection). |
| `repository is archived (read-only)` | The repository is archived; nothing can be committed until an admin unarchives it. |

Without a browser or a Git client, you can change files with the REST API:

- `PUT /api/v3/repos/{owner}/{repo}/contents/{path}` creates or updates one file, as on GitHub. Send `message`, the new `content` in base64, an optional `branch`, and, when the file exists, its current blob `sha`. A missing `sha` for an existing file fails with HTTP 422, and a `sha` that no longer matches fails with HTTP 409 (`<path> does not match <sha>`), so you never overwrite someone else's change.
- `DELETE /api/v3/repos/{owner}/{repo}/contents/{path}` deletes one file, with `message` and the file's `sha`.
- `POST /api/v3/repos/{owner}/{repo}/diffinery/commits` (or the MCP `commit_files` tool) changes several files in one commit.

Branch protection and agent guardrails apply to all of them, as for a `git push`. Push protection does too: the web editor, `PUT .../contents`, `POST .../diffinery/commits`, MCP `commit_files` (and `POST .../git/blobs`) scan the new content for credentials before anything is written, and refuse it with HTTP 422 and `push protection: possible secret detected (...)`. A repository admin who is a person can commit a flagged file anyway through `POST .../diffinery/commits` by adding `"allow_secrets": "<reason>"`; the bypass is recorded in the audit log and emailed to the repository's admins. See [Push protection](/docs/security/push-protection), [REST API](/docs/reference/rest-api) and [MCP](/docs/agents/mcp).

A workflow's `GITHUB_TOKEN` can use these endpoints when the job has `contents: write`, but it can't create, change or delete files under `.github/workflows/` or `.diffinery/workflows/`: that fails with ``refusing to allow a GitHub App to create or update workflow `<path>` without `workflows` permission``.

## Commits

`/acme/website/commits/<ref>` lists the commits reachable from a branch, tag or commit, 30 per page, grouped by day ("Commits on October 13, 2026"), with **Newer** and **Older** buttons. Add `?path=src/app.ts` (the **History** button does this) to see only commits that changed that file or folder; the file history looks at the most recent 2,000 commits.

Each row shows the first line of the message, the author and time, a **signed** badge when the commit carries a GPG or SSH signature, and a group of three buttons: a copy icon that copies the full SHA, the short SHA (opens the commit) and a code icon that browses the repository at that commit.

> **Note:** The **signed** badge means the commit contains a signature. Diffinery doesn't check the signature against a key, so it is not the same as GitHub's "Verified".

### Commit view

`/acme/website/commit/<sha>` shows:

- the message (title and body), author and committer with times, the **signed** badge,
- the parent commits, the full SHA with **Copy**, and **Browse files** (the tree at this commit),
- the checks reported on this commit: workflow jobs link to their run or job, and checks and commit statuses reported by other tools link to the details URL they gave (see [Checks and statuses](/docs/collaboration/checks-and-statuses)),
- the diff against the first parent: files changed with additions and deletions, a **Files** list with links when more than 3 files changed, and one collapsible section per file with a **View file** button.

Diff limits, on commit, compare and pull request pages:

| Limit | What you see |
| --- | --- |
| More than 300 changed files | Only the first 300 are shown, with "showing the first 300 files". |
| A file with more than 800 diff lines | The file starts collapsed. Click its header to open it. |
| More than 20,000 diff lines on the page | Later files show "Diff not rendered to keep this page fast" with a link to the file. |
| Binary files | "Binary file not shown." |

Diff lines are syntax highlighted within the limits in [Syntax highlighting](#syntax-highlighting).

## Branches

`/acme/website/branches` lists every branch, with the default branch first and the rest by name. Each row shows **default** and **protected** badges, the last commit's message, author and time (for the first 40 branches), and the head commit's short SHA.

| Action | How | Needs |
| --- | --- | --- |
| Compare with the default branch | **Compare** on the branch's row | read |
| Create a branch | **Create a branch**: enter a **Branch name**, pick **From** (an existing branch), click **Create branch** | write |
| Delete a branch | The **x** button on the branch's row, then confirm | write. Not available for the default branch. Protection rules and agent guardrails apply as for `git push --delete`. |

The same operations through Git and the API:

```sh
git push origin main:refs/heads/release/2.0          # create from main
git push origin --delete release/2.0                 # delete

curl -H "Authorization: Bearer dfy_..." https://diffinery.com/api/v3/repos/acme/website/branches
curl -X POST -H "Authorization: Bearer dfy_..." -H "content-type: application/json" \
  https://diffinery.com/api/v3/repos/acme/website/git/refs \
  -d '{"ref": "refs/heads/release/2.0", "sha": "<commit sha>"}'
curl -X DELETE -H "Authorization: Bearer dfy_..." \
  https://diffinery.com/api/v3/repos/acme/website/git/refs/heads/release/2.0
```

## Tags

`/acme/website/tags` lists tags in reverse name order, each with the short SHA of the commit it points at (plus the commit's message and time for the first 40 tags) and a **Compare** button that compares the tag with the default branch. Tags are created by pushing them (`git tag v1.0.0 && git push --tags`) or with `POST /api/v3/repos/{owner}/{repo}/git/refs`. See [Tags](/docs/repositories/git#tags) for who can create, move and delete them.

A release is attached to a tag: open `/acme/website/releases` (the **Releases** heading in the home page sidebar) to see release notes and download assets. Publishing a release can also create its tag. See [Releases](/docs/collaboration/releases).

## Download a branch, tag or commit

Every ref can be downloaded as an archive without Git, at `/acme/website/archive/<ref>.zip` or `/acme/website/archive/<ref>.tar.gz` (for example `/acme/website/archive/v1.2.0.zip`). Release pages link to these as **Source code (zip)** and **Source code (tar.gz)**. Archives hold at most 24 MB of files; contents, limits and the matching API endpoints are in [Source code archives](/docs/repositories/overview#source-code-archives).

## Compare and open pull requests

`/acme/website/compare` (or **Compare** in the command palette) lets you pick a **base** and a **compare** branch or tag. The result lives at `/acme/website/compare/<base>...<head>`, for example `/acme/website/compare/main...feature/login`. It shows:

- how many commits the head is ahead of and behind the base,
- the commits on the head that aren't on the base (up to 250),
- the combined diff from the merge base to the head.

When both sides are branches, the head has new commits, and you have write access, the page has an **Open a pull request** form:

| Field | Notes |
| --- | --- |
| **Title** | Prefilled from the commit message when there is one commit, otherwise from the branch name. |
| **Intent** | What the change is meant to do, for human and AI reviewers. Optional, but agents should always fill it in. |
| **Description** | Markdown. |
| **Create as draft** | Opens a draft pull request. |

Click **Create pull request**. If an open pull request for the same branches exists, the page links to it instead. If the head has no new commits, it says "There isn't anything to compare." See [Pull requests](/docs/collaboration/pull-requests).

The API returns the same comparison: `GET /api/v3/repos/acme/website/compare/main...feature/login` (three dots, base first). Either side can be a branch, a tag, a commit SHA (full or abbreviated) or any of these with git's ancestry suffixes: `main~3` (three first parents back), `main^` (the first parent) or `HEAD^2` (a merge's second parent), for example `/compare/main~1...main`.

## Command palette

Press **Ctrl K** (or **Cmd K** on a Mac), or click **Jump to…** in the header, to open the command palette. It is available when you are signed in.

Type to filter. Matching is fuzzy: the characters you type must appear in that order, so `srcapp` finds `src/app.ts`. Use **↑** and **↓** to move, **Enter** to open, and **Esc** or a click outside to close. The palette contains:

| Group | Entries |
| --- | --- |
| Repository (inside a repository) | Code, Issues, New issue, Pull requests, Actions, Branches, Tags, Commits, Compare, Settings |
| Go to | Dashboard, New repository, Notifications, Settings, Tokens, Agents |
| Repository | Every repository you can see (up to 300) |
| File (inside a repository) | Files on the current branch or ref (up to 5,000; folders named `node_modules`, `.git`, `vendor`, `dist` and `target` are skipped) |
| Issue / PR | Type a number such as `42` or `#42` to jump to that issue or pull request |

## Keyboard shortcuts

Shortcuts don't fire while you type in a text field.

| Keys | Action | Where |
| --- | --- | --- |
| **Ctrl K** / **Cmd K** | Open the command palette | Everywhere, when signed in |
| **t** | Find a file (opens the palette) | In a repository |
| **g** then **c** | Go to the code | In a repository |
| **g** then **i** | Go to issues | In a repository |
| **g** then **p** | Go to pull requests | In a repository |
| **g** then **a** | Go to Actions | In a repository |
| **g** then **s** | Go to settings | In a repository |
| **g** then **d** | Go to your dashboard | Everywhere |
| **g** then **n** | Go to notifications | Everywhere |
| **/** | Focus the search box | Issue and pull request lists |

Press the second key of a **g** sequence within 1.5 seconds.

## Live updates

Code pages (files, folders, commits, branches, tags, compare) show the repository as it was when the page loaded. Reload to see new pushes.

Pages about activity update live over a WebSocket while they are open: the Actions list, workflow runs, job logs (streamed line by line), issues, pull requests and the merge queue. See [Actions](/docs/actions/overview) and [Pull requests](/docs/collaboration/pull-requests).

A live update only says that something changed; the page then fetches what changed with your own access, so an update never carries an event's payload or an audit entry. Access is checked when the page connects, and each connection lasts 10 minutes before the page quietly reconnects and is checked again. Someone who loses access to the repository, or a signed-out reader of a repository that was made private, stops getting updates within 10 minutes.

## The same data through the API

| Data | REST API (`https://diffinery.com/api/v3`) |
| --- | --- |
| Folder listing or file (base64) | `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}` |
| Raw file | `GET /repos/{owner}/{repo}/raw/{ref}/{path}` |
| Commit list | `GET /repos/{owner}/{repo}/commits?sha={ref}&path={path}&per_page=30&page=1` |
| One commit with its diff | `GET /repos/{owner}/{repo}/commits/{ref}` |
| Compare | `GET /repos/{owner}/{repo}/compare/{base}...{head}` |
| Branches, tags | `GET /repos/{owner}/{repo}/branches`, `GET /repos/{owner}/{repo}/tags` |
| README of the root or a folder | `GET /repos/{owner}/{repo}/readme?ref={ref}`, `GET /repos/{owner}/{repo}/readme/{dir}` |
| Source archive | `GET /repos/{owner}/{repo}/zipball/{ref}`, `GET /repos/{owner}/{repo}/tarball/{ref}` |
| Bytes per language | `GET /repos/{owner}/{repo}/languages` |
| Trees and blobs by SHA | `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`, `GET /repos/{owner}/{repo}/git/blobs/{sha}` |

The contents endpoint, like GitHub's, returns the raw file instead of JSON when you send `Accept: application/vnd.github.raw`. Lists take `per_page` (capped at 100) and `page` and send a GitHub-style `Link` header for paging, so clients such as Octokit can page through them. Every endpoint is listed in the [API reference](/docs/api). Agents can read code with the MCP tools `get_file` and `list_tree` (see [MCP tools](/docs/reference/mcp-tools)).
