---
title: Security built in, not bolted on
seo_title: "Security: passkeys, push protection and agent guardrails · Diffinery"
description: How Diffinery protects code and secrets: passkeys instead of passwords, push protection, encrypted secrets, scoped job tokens, agent guardrails, audit log.
updated: 2026-10-25
---

A forge holds a team's most valuable asset and the keys to its production systems. When AI agents push code and run workflows too, the forge has to enforce limits on its own, not trust that every token is used well. These are the protections every account and repository on a Diffinery instance gets by default. Diffinery is open source (Apache-2.0), so you can read the code that enforces them at [diffinery.com/codician/diffinery](https://diffinery.com/codician/diffinery).

## People sign in with passkeys

There are no passwords to guess, reuse or phish. People sign in with a passkey (WebAuthn) kept by their device, password manager or security key, with user verification required. Passkeys are bound to your instance's domain (`diffinery.com` on diffinery.com), so a look-alike site can't use them. Sensitive actions, such as creating an agent or a token, ask you to confirm with your passkey again when your sign-in is older than two hours. See [Passkeys and sign-in](/docs/accounts/passkeys-and-sign-in).

## Invite-only by default

Every Diffinery instance is invite-only by default: nobody joins without an invitation from a site administrator, an organization owner or admin, or a repository admin. Invite links work once and expire after 14 days. An instance's administrators can open sign-up with `SIGNUP=open` ([Configuration](/docs/self-hosting/configuration#signup)). See [Invitations](/docs/accounts/invitations).

## Leaked credentials never land

Every push, and every commit made through the web editor, the REST API or MCP, is scanned for credentials such as cloud keys and tokens. A push that contains one is refused, and nothing from it is kept. Only a repository admin who is a person can push past it, with an audited reason; an agent never can. See [Push protection](/docs/security/push-protection).

## Secrets stay secret

- **Envelope encryption** with a key per repository, environment or organization, derived from a master key that can be rotated.
- **Masked in logs:** secret values are replaced with `***`.
- **Never handed to agent code:** a workflow run of code an agent pushed gets no repository or organization secrets, so an agent can't push a workflow that sends them elsewhere.
- **Job tokens** valid for one job and limited by the workflow's `permissions:`, read-only by default for new repositories, plus short-lived OIDC id tokens so deploys need no long-lived cloud keys. See [OIDC](/docs/actions/oidc).

## A human in the loop for agents

AI agents are accounts with their own tokens and server-enforced guardrails: no pushes to protected branches, a person's approval on every agent pull request, agent check results never counted as required checks, and no secret, variable, environment or branch protection changes. See [Diffinery for AI agents](/agents) and [Guardrails](/docs/agents/overview#guardrails).

## Tokens with limits

Personal and agent tokens (`dfy_...`) are stored hashed, expire, and can be limited to read, write or admin scope and to specific repositories. A read token never writes. See [Personal access tokens](/docs/accounts/tokens).

## Every sensitive action is recorded

An append-only audit log records sign-ins, token and agent changes, permission changes, secret changes, push protection bypasses and more, and security emails tell you when something important changes on your account. See [Audit log](/docs/security/audit-log).

## Isolation

Each repository is its own Durable Object with its own database, each workflow job runs in a fresh container thrown away after the job, and each agent sandbox is its own container. The web UI sends a strict, nonce-based Content Security Policy, HSTS with preload and frame protection on every page, and images from other sites in Markdown are fetched through Diffinery's own proxy, so those sites never see who reads a page.

## Reviewed before release

Diffinery's code was audited area by area in October 2026: identity and tokens, Git and storage, Actions and secrets, the agent features and MCP, the web UI and REST API, the GitHub importer, and Diffinery's own CI and deploys. The [Security overview](/docs/security/overview) documents the whole model in detail.

## Report a vulnerability

If you find a security problem, please tell us privately through the [report form](/security/report), the contact in [`/.well-known/security.txt`](/.well-known/security.txt). Good-faith research is covered by a safe harbour. See [Reporting a vulnerability](/docs/security/disclosure).
