---
title: Passkeys and sign-in
description: How people sign in to Diffinery with passkeys, join from an invite or open sign-up, manage passkeys and browser sessions, and recover a lost passkey.
---

People sign in to Diffinery in the browser with a passkey (WebAuthn). There are no passwords. This page covers signing in, joining from an invite or through open sign-up, adding and removing passkeys, managing signed-in browsers, the security emails you get, and how to get back in when you lose a passkey.

Passkeys are only for the web UI. Git, the `diffinery` CLI, scripts and MCP clients use personal access tokens instead (see [Personal access tokens](/docs/accounts/tokens)); the CLI gets its own when you approve `diffinery login` in the browser (see [Install and sign in to the CLI](/docs/accounts/cli-sign-in)). For your username, display name, profile picture and light or dark theme, see [Profile and preferences](/docs/accounts/profile-and-preferences).

## How passkey sign-in works

A passkey is a key pair that your device, browser or password manager creates for `diffinery.com`. Diffinery stores only the public key. When you sign in, your device proves it holds the private key after you unlock it with your fingerprint, face, PIN or screen lock.

Details that matter in practice:

| Behaviour | Value |
| --- | --- |
| Where a passkey works | Only on the host it was created for (the hostname of the instance, `diffinery.com`). A passkey for one Diffinery instance does not work on another. |
| Kind of passkey | Discoverable credentials (resident keys). You don't type a username: the browser offers the passkeys it holds for the site. |
| User verification | Required. The device must unlock the passkey with a biometric, PIN or screen lock, not just a tap. |
| Attestation | None requested. Diffinery accepts any authenticator that can create a discoverable, user-verifying passkey. |
| Time to complete the browser prompt | 2 minutes. The sign-in attempt itself expires after 5 minutes. |
| Browser session length | 30 days, extended by another 30 days on each day you use it, up to 90 days after you signed in. |

Diffinery is invite-only unless the instance turns on open sign-up. On an invite-only instance (the default) you can't create an account from the sign-in page: new people create their first passkey from an invite link (see [Join from an invite](#join-from-an-invite)). With open sign-up, the sign-in page also links to **Create an account** (see [Open sign-up](#open-sign-up)).

## Sign in

1. Open `https://diffinery.com/login`, or any page that needs you to be signed in. Diffinery redirects you to the sign-in page and back to that page afterwards.
2. Click **Sign in with a passkey**.
3. Your browser shows its passkey prompt. Pick the passkey for your Diffinery account, or choose to use a phone or a security key if the browser offers it.
4. Unlock the passkey with your fingerprint, face, PIN or screen lock.

You land on the page you were trying to open (or your dashboard). To sign out, click **Sign out** in the header; that ends this browser's session only.

The sign-in page also says how to recover a lost passkey on this instance: either a **Recover your account by email** link (when email recovery is set up) or "Ask an administrator for a sign-in link".

## Join from an invite

When someone invites you, Diffinery emails you a link like `https://diffinery.com/invite/<token>`. If you don't have an account yet, opening it shows a **Join Diffinery** page:

1. Check the **Username** field. It is filled in from the part of your email address before the `@`; change it if you like. Usernames start with a letter or digit and use letters, digits, `-` and `_`, up to 39 characters. Some names are reserved (for example `api`, `settings`, `login`, `admin`, `docs`).
2. Optionally fill in a **Display name** (up to 100 characters).
3. Click **Create a passkey and join**, and complete your browser's passkey prompt.

Diffinery creates your account, saves the passkey, signs you in and shows "Welcome to Diffinery, <username>. You can sign in with this passkey from now on." You land on the organization or repository the invite was for, or on your dashboard for an invite to the instance. You also get a welcome email. Creating the account accepts every open invite sent to your email address, so you join every organization or repository you were invited to at once.

If the email address already has an account, the invite page asks you to sign in with that account's passkey first; after that the same page shows an **Accept invite** button. See [Invitations](/docs/accounts/invitations) for how invites are created, how long they last and what each kind grants.

## Open sign-up

An instance whose operator set `SIGNUP=open` (see [Configuration](/docs/self-hosting/configuration#signup)) lets anyone create an account. The sign-in page then says **New here? Create an account**, which leads to `/signup`:

1. Enter your email address and, if the page shows one, complete the Cloudflare Turnstile check. Click **Email me a code**.
2. The page says "We sent a code to <address>". Find the email "Your sign-up code" and enter its 6 digits under **Code**, then click **Continue**. The code works once, for 10 minutes; a wrong code says how many tries are left (5 in all), and **send a new code** sends another one (up to 5 a day for an address).
3. Pick a **Username** and an optional **Display name**, as when joining from an invite, and click **Create a passkey and join**. This step must be finished within 30 minutes.

Diffinery creates your account (active right away, no invite needed), saves the passkey, signs you in and sends a welcome email. Any open invites for your address are accepted at the same time.

If the address already has an account, the page reads exactly the same, so nobody can use it to find out who has an account. No code is sent: the account's owner gets an email "Someone tried to sign up with your email address" with a link to sign in instead.

On an invite-only instance `/signup` doesn't exist (`404`). Limits on codes are listed in [Limits](/docs/reference/limits#sign-in-and-sessions).

## Manage your passkeys

Go to **Settings → Passkeys and sessions** (`/settings/security`). The **Passkeys** box lists every passkey on your account with:

- its name,
- a **synced** badge when the passkey is backed up by your password manager or platform (so it syncs to your other devices), or **this device only** when it is stored on a single device or security key,
- when it was added and when it was last used to sign in (or "never used to sign in").

### Add a passkey

Add a passkey on each device you use, or keep one in a password manager that syncs, so losing one device doesn't lock you out.

1. On the device or browser you want to add, sign in and open **Settings → Passkeys and sessions**.
2. Under **Add a passkey**, optionally type a name (up to 100 characters). If you leave it empty, Diffinery names it after the device and browser, for example `Mac · Safari` or `Android · Chrome`.
3. Click **Add a passkey** and complete the browser prompt.

You see "Passkey "<name>" added." and Diffinery sends you a "A passkey was added to your account" email.

If the browser says "This device already has a passkey for this account.", the authenticator you picked already holds a Diffinery passkey for you. Pick a different one (another device, a phone or a security key).

### Remove a passkey

Click **Remove** next to the passkey and confirm. Removing a passkey also signs out every other browser that signed in with it, which is what you want for a lost or stolen device. The browser you are using stays signed in. Diffinery sends you a "A passkey was removed from your account" email.

You can't remove your last passkey. The list shows **Only passkey** instead of a **Remove** button, and the server refuses with "Add another passkey before removing your last one." Add a new passkey first, then remove the old one.

Passkeys can only be managed from a signed-in browser. An API request made with an access token gets "Sign in with your passkey first."

## Confirming it's you

Adding or removing a passkey, creating a token or an agent, changing your username, deleting or transferring a repository or organization, exporting or deleting your account, and (for site administrators) deleting someone's account or changing who is a site administrator need a sign-in from the last 2 hours. If you signed in earlier, Diffinery shows **Confirm it's you**. Use your passkey (or **Confirm by email**, where email recovery is set up), and you go back to the page you were on. Then do the action again. See [Security overview](/docs/security/overview#confirming-its-you).

## Sessions and signing out other browsers

Each successful sign-in creates a browser session, stored in an HTTP-only, secure cookie (`__Host-dfy_session`) that only `diffinery.com` can read. A session lasts 30 days and is extended by another 30 days on each day you use it, so a browser you use regularly stays signed in. However often you use it, a session ends 90 days after you signed in, and you sign in with your passkey again.

The **Signed-in browsers** box on **Settings → Passkeys and sessions** lists your active sessions (up to 100), newest activity first. Each row shows the device and browser, a **this browser** badge for the one you are using, when it signed in, how (a passkey, email recovery or a sign-in link) and when it was last active.

To end one session, click **Sign out** on its row and confirm. You see "Signed out of that browser." To end every session except the current one, click **Sign out everywhere else** and confirm "Sign out every other browser?". You see "Signed out of every other browser." Those browsers need a passkey to sign in again.

When a site administrator disables your account, every browser session ends at once, and signing in again is refused with "Your account is disabled." until the account is enabled.

Signing out other browsers does not revoke access tokens. If you think someone has your token, revoke it under **Settings → Access tokens** (see [Personal access tokens](/docs/accounts/tokens#revoke-a-token)).

## Security emails about sign-in

These emails always send; you can't turn them off in notification settings.

| Email | When it is sent |
| --- | --- |
| New sign-in to your account | You sign in with a passkey from a browser and passkey combination Diffinery hasn't seen for your account before, and every time you sign in through email recovery. It shows when, the device, the location (city and country) and the IP address. |
| A passkey was added to your account | You add a passkey in settings, or with a sign-in link from an administrator. |
| A passkey was removed from your account | You remove a passkey. |
| Welcome to Diffinery | You create your account from an invite or through open sign-up. |
| Someone tried to sign up with your email address | With open sign-up, someone asked for a sign-up code for your address. No account was created and no code was sent. |
| Your one-time sign-in link | A site administrator creates a sign-in link for you. |

A browser is identified by the passkey used plus its operating system and browser name (for example `Mac · Chrome`). Signing in again from the same browser with the same passkey doesn't send another email. The device you joined or added a passkey from counts as known.

If you get one of these emails and it wasn't you: open **Settings → Passkeys and sessions**, click **Sign out everywhere else**, remove any passkey you don't recognize, revoke any token you don't recognize under **Settings → Access tokens**, and tell a site administrator.

See [Notifications](/docs/accounts/notifications) for every email Diffinery sends.

## Recover your account

If you have lost every passkey (or the device that held your only passkey), there are two ways back in. Both let you add a new passkey to your existing account; your repositories, tokens and settings are untouched.

Recovering your account signs out every other browser signed in to it, in case the device you lost is one of them. Only browser sessions end: your access tokens keep working, so scripts and Git keep running. If you think someone has a token, revoke it under **Settings → Access tokens** once you are back in. The page you land on says "Every other browser signed in to your account was signed out; your access tokens keep working.", and the audit log records it as `session.revoke_others`. Email recovery from a browser that is already signed in to the same account (Diffinery sends you there to [confirm it's you](#confirming-its-you)) doesn't sign anything out.

### Sign-in link from an administrator

A site administrator can create a one-time sign-in link for you:

1. The administrator opens **Settings → People and invitations**, finds you in the **Users** table and clicks **Sign-in link** (see [Site administration](/docs/admin/site-administration#sign-in-links)).
2. Diffinery emails you "Your one-time sign-in link". The administrator also sees the link and can send it to you another way.
3. Open the link (`https://diffinery.com/signin/<token>`). The **Add a passkey** page names the account it belongs to.
4. Optionally enter a **Name for this passkey**, click **Create a passkey** and complete the browser prompt.

You are signed in and taken to **Settings → Passkeys and sessions** with "Passkey "<name>" added. Use it to sign in from now on." Every other browser signed in to your account is signed out.

| Sign-in link rule | Value |
| --- | --- |
| Lifetime | 24 hours from when it was created |
| Uses | Once. After that, or after it expires, it shows "this sign-in link is invalid, already used, or expired". |
| Accounts | People only, and not disabled accounts |
| What it does | Adds a passkey to the account, signs that browser in and signs every other browser out. It doesn't remove your other passkeys or revoke your access tokens. |

Anyone with the link can add a passkey to your account, so don't forward the email. After you are back in, remove the passkey of the device you lost.

### Email recovery through /auth/access

An instance can also offer recovery by email. This path is protected by Cloudflare Access, which checks that you control your email address with a one-time PIN. Diffinery then signs you in to the account with that email address.

1. Open `https://diffinery.com/auth/access`, or click **Recover your account by email** on the sign-in page.
2. Enter your account's email address on the Cloudflare Access page. Cloudflare emails you a one-time PIN.
3. Enter the PIN. Cloudflare Access sends you back to Diffinery, which signs you in.
4. If your account has no passkeys, you land on **Settings → Passkeys and sessions** with "You're signed in. Add a passkey now so you can sign in directly next time." Add one right away. If you still have passkeys, you go to the page you were trying to open.

Every email-recovery sign-in sends a "New sign-in to your account" email and is recorded in the audit log. Unless this browser was already signed in to the account, every other browser is signed out; your access tokens keep working.

When email recovery isn't set up on an instance, `/auth/access` returns 404 with "Account recovery by email is not set up on this instance. Ask an administrator for a sign-in link.", and the sign-in page doesn't show the email recovery link.

If the email address you verify has no account, Diffinery creates one that waits for an invite (see [Invitations](/docs/accounts/invitations#access-requests)), unless that address has an open invite or is a bootstrap site administrator.

## Browser and device requirements

- A browser with WebAuthn passkey support, such as a current version of Chrome, Safari, Edge or Firefox. In a browser without it, the sign-in button shows "This browser does not support passkeys. Try a current version of Chrome, Safari, Edge or Firefox."
- JavaScript turned on. Without it the page shows "Passkeys need JavaScript."
- An authenticator that can store a discoverable passkey and verify you: a phone or computer with a fingerprint reader, face unlock, PIN or screen lock, a password manager that supports passkeys, or a hardware security key that stores passkeys and has a PIN or biometric.
- The real site address. Passkeys are bound to `diffinery.com`, so they don't work through another hostname or a raw IP address.

## Password managers and synced passkeys

Passkeys saved in a password manager or your platform's keychain usually sync to your other devices, so one passkey covers your laptop and phone. Diffinery shows these with the **synced** badge. A passkey on a hardware security key or in a device-only store shows **this device only**; keep a second passkey somewhere else so you can't be locked out by losing that one key.

If your browser offers several places to save the passkey when you create it, pick the password manager or keychain you use on all your devices.

## How Diffinery sign-in differs from GitHub

- Diffinery has no passwords and no username-and-password sign-in, so there is no password reset and no separate two-factor setup: the passkey's user verification is the second factor.
- Unless the instance turns on open sign-up, you can't sign up from the sign-in page: accounts come from invites. With open sign-up, an emailed code confirms your address instead of a password.
- Account recovery is a one-time link from a site administrator, or email recovery when the instance has it set up. There are no recovery codes.
- Git over HTTPS and the API never accept a passkey or browser session; they take a personal access token, much like GitHub.

## Troubleshooting

| Message or symptom | What it means and what to do |
| --- | --- |
| "The passkey prompt was closed or timed out. Try again when you are ready." | The browser prompt was cancelled, or 2 minutes passed. Click the button again. If no passkey is offered at all, this device has no passkey for Diffinery: use another device, or recover your account. |
| "This passkey is not registered with Diffinery. It may have been removed." | The passkey you picked was removed from your account (or belongs to another instance). Pick another passkey or recover your account. You can also delete the stale passkey from your device or password manager. |
| "This sign-in attempt expired. Please try again." | More than 5 minutes passed since the attempt started, or the browser didn't send the sign-in cookie back (for example, blocked cookies). Reload the page and try again. |
| "Passkey check failed: ..." | The browser's response didn't verify, for example because the page was opened on a different hostname. Open `https://diffinery.com/login` directly and try again. |
| "Your account is disabled." | A site administrator disabled your account. Ask them to enable it. |
| "This device already has a passkey for this account." | When adding a passkey: pick a different authenticator. |
| "This browser does not support passkeys..." | Update your browser or use another one. |
| "this invite is invalid, already used, or expired" | Ask the person who invited you for a new invite. |
| "That code has expired or was entered wrong too many times. Send a new code." | Sign-up codes last 10 minutes and allow 5 tries. Click **send a new code**. |
| "We have sent several codes to <address> today." | At most 5 sign-up codes a day go to one address. Check your spam folder, or try again tomorrow. |
| "Sign-up needs Turnstile configured" | The instance turned on open sign-up without Turnstile keys. Ask its administrators for an invite. |
| "this sign-in link is invalid, already used, or expired" | Sign-in links work once within 24 hours. Ask a site administrator for a new one. |
| "Waiting for an invite" page after email recovery | Your email address has no Diffinery account. Ask someone to invite that address, or click **Request access**. |
| Lost every passkey | Use [email recovery](#email-recovery-through-authaccess) if the sign-in page offers it, otherwise ask a site administrator for a [sign-in link](#sign-in-link-from-an-administrator). |
| `git` or the CLI asks for a password | Use a personal access token, not a passkey. See [Personal access tokens](/docs/accounts/tokens). |
