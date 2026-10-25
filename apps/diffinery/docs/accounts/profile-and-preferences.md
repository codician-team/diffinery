---
title: Profile and preferences
description: Change your username, display name and profile picture, choose light, dark or system appearance, and link your GitHub account for imports.
---

Your profile is how other people see you on Diffinery: your username, display name and profile picture. This page also covers the **Appearance** setting (light, dark or following your system), **Linked accounts** (your GitHub account, for imports) and points to every other per-user setting under **Settings**.

## Where your settings are

Open **Settings** by clicking your picture and username at the top right of any page, or go to `https://diffinery.com/settings`. The sidebar has these pages:

| Page | Path | What it holds |
| --- | --- | --- |
| **Profile** | `/settings` | Profile picture, username, display name, and read-only account details |
| **Account** | `/settings/account` | Exporting your data and deleting your account. See [Exporting and deleting your account](/docs/accounts/account-data). |
| **Appearance** | `/settings/appearance` | Light, dark or system theme |
| **Pull requests** | `/settings/pull-requests` | **Turn on auto-merge for pull requests I open**, and its merge method. See [Merge on green automatically](/docs/collaboration/merge-on-green#your-own-pull-requests). |
| **Passkeys and sessions** | `/settings/security` | Passkeys and signed-in browsers. See [Passkeys and sign-in](/docs/accounts/passkeys-and-sign-in). |
| **Access tokens** | `/settings/tokens` | Personal access tokens. See [Personal access tokens](/docs/accounts/tokens). |
| **Agents** | `/settings/agents` | Agent accounts you or your organizations own. See [Agents](/docs/agents/overview). |
| **Organizations** | `/settings/orgs` | Organizations you belong to, and creating new ones. See [Organizations](/docs/accounts/organizations). |
| **Notifications** | `/settings/notifications` | What you hear about in the notifications list and by email. See [Notifications](/docs/accounts/notifications). |
| **Linked accounts** | `/settings/linked-accounts` | GitHub accounts linked to yours, so imported work is credited to you. See [Linked accounts](#linked-accounts). |
| **Imports** | `/imports` | The GitHub imports you started, and **Import from GitHub**. See [Migrate from GitHub](/docs/migrate-from-github). |

Site administrators also see a **Site administration** group with **People and invitations**, **Email** and **Audit log** (see [Site administration](/docs/admin/site-administration)).

Every settings page needs you to be signed in in the browser. Profile, appearance and passkey changes can't be made with an access token, except the profile picture, which has an API (see [Profile picture API](#profile-picture-api)).

## Your profile

**Settings → Profile** (`/settings`) has two boxes: **Profile picture** (see [Profile pictures](#profile-pictures)) and a form with:

| Field | Editable | Notes |
| --- | --- | --- |
| **Username** | Yes | Your login, the owner part of your repository URLs (`https://diffinery.com/diffy/...`) and your `@mention` handle |
| **Display name** | Yes | Optional. Shown on your profile page and in the settings sidebar, with your username under it, and returned as `name` by the API. If you leave it blank (or enter only spaces), Diffinery shows your username in its place and the API returns `"name": null`. |
| **Email** | No | Your account's email address. Notification emails go here. It can't be changed in Settings. |
| **Account type** | No | `user` for a person |
| **Joined** | No | When the account was created |
| **Site admin** | No | `yes` for site administrators, otherwise `no` |

Change the username or display name and click **Save profile**. You see "Profile saved."

Your public profile page is `https://diffinery.com/diffy`. It shows your picture, display name, username, your organizations and the repositories the viewer can see. On your own profile page there is an **Edit profile** button that opens **Settings → Profile**. Profile pages need the viewer to be signed in.

### Change your username

A username starts with a letter or digit, then uses letters, digits, `-` and `_`, up to 100 characters. Dots aren't allowed, and the name can't be reserved (for example `api`, `settings`, `login`, `admin`, `docs`) or already used by a person, organization or agent. The **Username** field checks the characters in your browser before you save, with the same rules as the server; the organization and agent name fields work the same way.

Renaming changes the URL of every repository you own. The old URLs keep working (see [Old URLs after a transfer or rename](/docs/repositories/overview#old-urls-after-a-transfer-or-rename) for how each kind behaves), but update existing clones:

```sh
git remote set-url origin https://diffinery.com/new-name/website.git
```

After a rename, `https://diffinery.com/old-name` and your repositories' old web and API URLs redirect to the new name, and Git and container images keep being served under the old name, until someone else takes the old name, which is free for them to take. Your picture moves with you: Diffinery forgets cached copies of the picture under the old name.

| Message | What to do |
| --- | --- |
| "invalid or reserved login" | The name is reserved, or breaks the rules above. Pick another. |
| "login already taken" | Another person, organization or agent uses it. Pick another. |

There is no API for changing your username or display name; use the web UI. `GET /api/v3/user` returns them as `login` and `name`.

## Profile pictures

People and organizations can upload a profile picture. Without one, Diffinery draws a picture from the first letter or digit of the name (see [Initials when there is no picture](#initials-when-there-is-no-picture)). Pictures appear next to your name everywhere in the web UI: the header, comments, pull requests, member and collaborator lists, and the user and organization pages.

### Upload your picture in the web UI

1. Go to **Settings → Profile** (`/settings`).
2. In the **Profile picture** box, under **Upload a new picture**, choose a file. The hint reads "JPEG, PNG or WebP, up to 5 MB. It is cropped to a centred square."
3. The current picture is replaced by a preview of the cropped square, with "Preview. Save to use this picture." If your browser can't open the file, you see "No preview for this file; it will be checked when you save."
4. Click **Save picture**. The status shows "Uploading…", then the page reloads with "Profile picture updated."

Your browser does part of the work before uploading: it cuts out the centred square, shrinks it to at most 512 by 512 pixels and converts it to WebP (or PNG, if the browser can't produce WebP). The server then checks and processes that upload like any other. If the browser can't decode the file, it uploads the original file and the server's checks decide.

### What Diffinery does with a picture

| Step | Detail |
| --- | --- |
| Format check | The format is detected from the file's first bytes, not its name or `Content-Type`. JPEG, PNG and WebP are accepted. Anything else (GIF, HEIC, SVG, ...) is refused with "Use a JPEG, PNG or WebP image." |
| Size check | At most 5 MB (5,242,880 bytes) and at most 3072 by 3072 pixels |
| Crop | The centred square of the picture is kept; the rest of a non-square picture is cut off. There is no manual crop control. |
| Orientation | The EXIF orientation of a JPEG (as written by phone cameras) is applied, so the picture isn't sideways |
| Resize | The square is resized to 64, 128 and 256 pixels |
| Encode | Each size is saved as WebP (quality 80). The original upload isn't kept. |
| Replace | The previous picture's files are deleted |

Transparent areas of a PNG or WebP stay transparent.

### Limits for profile pictures

| Limit | Value |
| --- | --- |
| Formats | JPEG, PNG, WebP |
| File size | 5 MB |
| Dimensions | 3072 by 3072 pixels |
| Stored sizes | 64, 128 and 256 pixels square, WebP |

### Remove your picture

When you have a picture, the **Profile picture** box has a **Remove picture** button ("Shows initials instead."). Click it and confirm "Remove your profile picture?". You see "Profile picture removed." and your initials come back everywhere.

### Initials when there is no picture

Without an uploaded picture, Diffinery serves a generated SVG picture: the first letter or digit of the name in white, upper case, on a colored background. The color is computed from the name, so it stays the same for that name. A name with no letters or digits shows `?`.

In the web UI, people and organizations appear as circles and agents as rounded squares.

### Organization pictures

An organization's picture is managed on its **Settings** tab (`https://diffinery.com/acme?tab=settings`), which only organization owners (and site administrators) can open. It has the same **Profile picture** box:

1. Open the organization, click **Settings**.
2. Under **Upload a new picture**, choose a file and click **Save picture**. You see "Organization picture updated."
3. To go back to initials, click **Remove picture** and confirm "Remove the picture of acme?". You see "Organization picture removed."

Through the API, organization owners (and site administrators) can change the picture; see the next section. Organization admins and members can't change it.

### Agent pictures

The web UI has no upload control for agents, so they show initials until a picture is uploaded. An agent can set its own picture through the API with one of its own tokens, the same way a person does (`PUT /api/v3/user/avatar`).

### Profile picture API

These endpoints are a Diffinery extension (GitHub has no API for uploading a profile picture). The request body is the raw image file, not a form or JSON.

| Method and path | Who | Response |
| --- | --- | --- |
| `PUT /api/v3/user/avatar` | You (the token's account) | `200` with `{"avatar_url": "..."}` |
| `DELETE /api/v3/user/avatar` | You | `200` with `{"avatar_url": "..."}` (the initials URL) |
| `PUT /api/v3/orgs/{org}/avatar` | Owners of the organization, site administrators | `200` with `{"avatar_url": "..."}` |
| `DELETE /api/v3/orgs/{org}/avatar` | Owners of the organization, site administrators | `200` with `{"avatar_url": "..."}` |

The token needs the `write` or `admin` scope and must not be restricted to repositories. A browser session works too.

Upload a picture:

```sh
curl -X PUT https://diffinery.com/api/v3/user/avatar \
  -H "Authorization: Bearer dfy_..." \
  --data-binary @me.jpg
```

```json
{ "avatar_url": "https://diffinery.com/api/avatars/diffy?v=1760350000" }
```

The `v` value is the new picture's version. Upload an organization's picture:

```sh
curl -X PUT https://diffinery.com/api/v3/orgs/acme/avatar \
  -H "Authorization: Bearer dfy_..." \
  --data-binary @logo.png
```

Remove it again:

```sh
curl -X DELETE https://diffinery.com/api/v3/user/avatar -H "Authorization: Bearer dfy_..."
```

```json
{ "avatar_url": "https://diffinery.com/api/avatars/diffy" }
```

The `diffinery api` CLI command sends text bodies only, so use `curl` (or another HTTP client) to upload a picture.

Errors:

| Status | Message | Cause |
| --- | --- | --- |
| 401 | `sign in required` | No token was sent |
| 403 | `changing a profile picture needs a write or admin token that is not limited to repositories` | The token has only the `read` scope, or is restricted to repositories |
| 403 | `only organization owners can change its picture` | You are an admin or member of the organization, but not an owner |
| 404 | `not found` | The organization doesn't exist, or you aren't a member |
| 413 | `That picture is larger than 5 MB. Use a smaller file.` | The body is over 5 MB |
| 422 | `Send the picture as the request body.` | The request had no body |
| 422 | `Use a JPEG, PNG or WebP image.` | The body isn't JPEG, PNG or WebP |
| 422 | `That picture could not be read. Use a JPEG, PNG or WebP image.` | The file is damaged or its header can't be read |
| 422 | `That picture is 4000×3000 pixels; the limit is 3072×3072.` | The picture is larger than 3072 by 3072 pixels |

Error bodies are JSON with a `message` field, like every API error.

Every change is recorded in the audit log as `avatar.update` or `avatar.remove`, with the account kind and whether it came from the web UI or the API.

### The avatar URL

Every person, organization and agent has a picture at:

```text
https://diffinery.com/api/avatars/{login}
```

This is the `avatar_url` in every user and organization object the REST API returns (for example `GET /api/v3/user`, the `user` of an issue, or `owner` of a repository), as on GitHub.

| Query parameter | Values | Default |
| --- | --- | --- |
| `s` | Size in pixels. Diffinery serves the smallest stored size at least this big: `64`, `128` or `256`. Larger values get `256`. | `128` |
| `v` | A picture version, as returned by the upload API. Pins the URL to that picture so it can be cached for a long time. | none |

```sh
# The 64-pixel picture of diffy
curl -o diffy.webp "https://diffinery.com/api/avatars/diffy?s=64"
```

The response is `image/webp` for an uploaded picture, or `image/svg+xml` for initials. The URL needs no sign-in or token, so you can use it in `<img>` tags, README files and other tools. A name that doesn't exist also gets an initials picture, so the URL doesn't reveal which accounts exist.

### Caching

| URL | `Cache-Control` | When a new picture shows up |
| --- | --- | --- |
| With the current `v` | `public, max-age=86400, immutable` | Never changes; a new picture gets a new `v` |
| Without `v` (or with an old `v`) | `public, max-age=600, stale-while-revalidate=86400` | Within about 10 minutes |

The header, the settings pages, profile and organization pages and member lists use the versioned URL, so your new picture shows there right away after you save. Other places use the plain URL (for example issue and pull request conversations in the web UI, API clients and other sites), so they can show the old picture for up to about 10 minutes, and browsers may show a cached copy a little longer while they check for a new one. Diffinery also keeps a copy at Cloudflare's edge for up to 10 minutes; uploading or removing a picture clears that copy in the data center that handled the change, and other data centers pick up the change when their copy expires.

## Appearance

**Settings → Appearance** (`/settings/appearance`) sets the color theme of the web UI. The page says "Choose how Diffinery looks to you. The choice follows your account to every browser you sign in to."

| Theme option | Description in the page | Behaviour |
| --- | --- | --- |
| **Sync with system** | "Light or dark, following your device's setting." | The default. Follows your operating system or browser's light or dark mode, and switches when it does. |
| **Light** | "Always light." | Always the light theme |
| **Dark** | "Always dark." | Always the dark theme |

To change it:

1. Go to **Settings → Appearance**.
2. Under **Theme**, pick **Sync with system**, **Light** or **Dark**.
3. Click **Save appearance**. You see "Appearance saved."

### How the appearance setting is stored and applied

- The choice is saved on your account, so every browser you sign in to uses it from the next page you open. There is no need to set it per device.
- The page is rendered with the theme already applied, so there is no flash of the wrong theme while it loads, and it works with JavaScript turned off.
- Saving **Light** or **Dark** also stores the choice in a cookie in the browser you saved it from (`dfy_theme`, kept for 400 days). Pages you open there while signed out, such as the sign-in page, invite pages and these docs, use it too. Saving **Sync with system** removes the cookie.
- In other browsers, pages you open while signed out follow the system setting until you sign in.
- The theme applies to every page of the web UI, including syntax-highlighted code and diffs, which use the GitHub Light Default and GitHub Dark Default color themes.
- Emails aren't affected: they follow the light or dark mode of your mail app.

There is no API or CLI command for the appearance setting.

## Linked accounts

**Settings → Linked accounts** (`/settings/linked-accounts`) is the **Linked GitHub accounts** page. When someone [imports from GitHub](/docs/migrate-from-github), issues, pull requests, comments and reviews written by a linked GitHub account are credited to your Diffinery account instead of a placeholder ("mannequin") for the GitHub user. Link your account before the import runs: work that was already imported stays with the mannequin.

### Link with a public gist

No GitHub token is needed:

1. Under **Step 1 · get a code**, leave **GitHub Enterprise API URL** blank for github.com, or enter your GitHub Enterprise API URL (for example `https://ghe.example.com/api/v3`), and click **Get my code**.
2. Copy the code (it starts with `diffinery-link-`). On GitHub, create a **public** gist whose description or one of whose files contains it.
3. Under **Step 2 · verify your gist**, enter **Your GitHub username on github.com** (or on your Enterprise host) and click **Verify and link**. You see "GitHub account linked."

Diffinery reads your public profile and gists without a token, from that one GitHub host, and stores GitHub's numeric user id with the link, so a later rename of your GitHub account doesn't break it. You can delete the gist afterwards.

### Link with GitHub OAuth

If the site administrator configured a GitHub OAuth app, the page also has **Link with GitHub**: click **Continue to GitHub**, approve read-only access to your profile, and you come back with the account linked. OAuth links github.com accounts only; use a gist for GitHub Enterprise.

### Manage your links

- Each link shows the GitHub login, the host (`on github.com`) and when it was linked. Click **Unlink** and confirm "Unlink diffy?" to remove it; you see "Account unlinked."
- You can link several GitHub accounts (for example one on github.com and one on an Enterprise host). A GitHub account can be linked to only one Diffinery account.
- Only people can link accounts; agents can't.
- Linking, unlinking and a site administrator clearing a link are recorded in the audit log (`account.link_github`, `account.unlink_github`, `account.link_cleared`).
- The same actions are available in the REST API under `/api/v3/diffinery/user/linked-accounts` with a personal token that has the `admin` scope and isn't restricted to repositories. See [Link your GitHub account](/docs/migrate-from-github#link-your-github-account).

| Message | What to do |
| --- | --- |
| "create a PUBLIC gist whose description or a file contains diffinery-link-..., then try again" | Make sure the gist is public (not secret) and contains the exact code, then click **Verify and link** again. |
| "GitHub user diffy was not found" | Check the username and, for Enterprise, the API URL. |
| "GitHub user diffy is linked to another Diffinery account" | Unlink it from that account first, or ask a site administrator to clear the link. |

## Notification preferences

Your notification preferences (which groups you hear about in the notifications list and by email, watching new repositories, emails about your own activity) are on **Settings → Notifications**, and can also be read and changed with `GET` and `PUT /api/v3/diffinery/notification-settings`. See [Notifications](/docs/accounts/notifications#notification-settings).

## How profiles differ from GitHub

- There is no bio, location, website, company, pronouns or status field. The profile has a username, a display name and a picture.
- Your email address comes from your invitation and isn't editable in Settings. Diffinery has no list of secondary email addresses.
- Profile pictures are uploaded to Diffinery. There is no Gravatar support (`gravatar_id` is always empty in API responses).
- Diffinery has an API to upload and remove profile pictures for users and organizations; GitHub doesn't.
- GitHub's theme settings have more options (for example separate day and night themes and high-contrast themes). Diffinery has light, dark and sync with system.
- After a username change, Diffinery redirects your profile and your repositories' old web, API and Git URLs until someone takes the old name; GitHub redirects the repositories only.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| "That picture is larger than 5 MB. Use a smaller file." | Use a file of 5 MB or less. In the web UI, files the browser can open are shrunk before uploading, so this mostly happens with the API or with files the browser can't preview. |
| "Use a JPEG, PNG or WebP image." | Convert the picture to JPEG, PNG or WebP. |
| "That picture is ... pixels; the limit is 3072×3072." | Resize the picture to at most 3072 by 3072 pixels, or upload it in the web UI, which shrinks it first. |
| "Choose a picture to upload." | Pick a file before clicking **Save picture**. |
| The old picture still shows in comments or in another tool | Those places use the unversioned avatar URL, which can be cached for about 10 minutes. Wait, or in your own tools use the URL with `?v=` from the upload response. |
| `403 changing a profile picture needs a write or admin token...` | Create a token with the `write` or `admin` scope and no repository restriction, under **Settings → Access tokens**. |
| The theme doesn't change on the sign-in page | Signed-out pages use the cookie of the browser where you last saved **Light** or **Dark**, or the system setting. Sign in, or save the setting again in this browser. |
| "login already taken" or "invalid or reserved login" | See [Change your username](#change-your-username). |
