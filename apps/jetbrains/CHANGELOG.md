# Changelog

## 0.1.1

- Works with any Diffinery, not only diffinery.com: **Use another server…** under **Sign In with Browser…** on the
  Diffinery page of **Get from Version Control** asks for your server's address, checks that a Diffinery answers
  there, and switches to it.
- Installed from your own Diffinery's plugin repository, the sign-in page offers that server in one click
  (**Use git.example.com**).
- **Share Project on Diffinery…** asks which server to sign in to when you aren't signed in yet.

## 0.1.0

- **Diffinery** in **Get from Version Control**: your repositories and your organizations', search across every
  repository you can read, or paste `owner/name` or a link.
- Sign in with your passkey in the browser (OAuth with PKCE), or with an access token.
- Git asks the plugin for the password for the server you're signed in to; the token renews itself.
- **Git → Share Project on Diffinery…** creates a repository and pushes the current branch.
- **Settings → Version Control → Diffinery** for the account and the server.
