# Product and design conventions

These are the project's strong defaults for product and design decisions.
Contributions are expected to follow them; where one doesn't fit, say why in
the pull request.

## Sign-in: passkeys first

- People sign in with passkeys (WebAuthn). Don't add passwords.
- New people create their passkey from their invite link.
- Recovery goes through a one-time sign-in link from an admin, or email
  verification through Cloudflare Access at `/auth/access`. Access guards only
  that path.
- Machines (git, the CLI, MCP clients, runners) use Diffinery tokens, never
  browser sessions.

## UI: Kumo

- The look follows [Kumo](https://kumo-ui.com), Cloudflare's design system:
  its color tokens (light and dark), radii, type and focus styles. The tokens
  live as CSS variables in `apps/diffinery/src/web/assets.ts`.
- Never use a native `<select>`, checkbox or radio. Use the Kumo components
  through `KSelect`, `KCheckbox` and `KRadio` from
  `apps/diffinery/src/web/kumo.tsx`. The server renders a placeholder and the
  hidden inputs the form posts; a small client bundle (`apps/diffinery/islands/`)
  mounts the real Kumo component over it. Kumo's stylesheet is confined to those
  islands so it can't restyle the rest of the page.
- For anything else interactive (menus, dialogs, pickers), reach for the Kumo
  component the same way rather than hand-rolling one.
