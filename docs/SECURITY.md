# Security model

HQ is a **single-owner** application. Every authorized client acts for that same
owner. It is not a multi-tenant SaaS server. Use a private deployment and do not
grant other people access expecting separate lists or isolated work accounts.

## Trust boundaries

- OAuth authorization code with mandatory **S256 PKCE** and exact callback
  registration allowlists. No wildcard callbacks or arbitrary redirect hosts.
- Owner authorization requires a scrypt password hash, a short-lived browser
  binding cookie, a form CSRF token, and explicit consent. No logged-in owner
  browser session is retained. The consent cookie is HttpOnly, SameSite=Lax,
  and Secure on HTTPS. Forms cannot be framed and third-party resources are absent.
- Codes expire in two minutes; consent requests in ten minutes. Access tokens
  expire in one hour. Refresh tokens rotate and expire after 30 days. Reuse
  revokes the grant's entire token family.
- Tokens and codes are stored only by SHA-256 hash. Confidential OAuth client
  secrets are encrypted with AES-256-GCM using a key derived from `COOKIE_SECRET`.
  Keep that secret stable and backed up privately.
- Tokens are bound to the `/mcp` resource. Read/write and Amp read/execute scopes
  are separate. Unauthorized tools are not registered for that client request.
- HTTP Host and Origin validation, body limits, SDK OAuth rate limits and a
  stricter owner-password attempt limit protect the public service. Proxy
  headers are not trusted by default. Through Compose, consent limits therefore
  apply to the single proxy as a whole, suitable for a single-owner deployment.
- SQLite files use private permissions. The database and backups contain
  plaintext personal data and work output; use encrypted disks, private backups
  and normal host access controls. OAuth hashing is not database encryption.
- Amp workers inherit an environment whitelist, not HQ's owner/OAuth/cloud
  credentials. Dispatch uses remote cloud/runner executors. Only HQ-created
  remote threads can be continued. Amp's own remote permissions govern code
  execution; `amp:execute` is a powerful permission and spends account credits.
- Personal notes, cards and Amp history are untrusted content. MCP instructions
  tell the assistant to treat them as data. These instructions are helpful but
  do not provide a complete prompt-injection defense; authorize only clients
  and execution requests you intend.

## What must never enter Git

`.env`, access tokens, owner password hashes from a real deployment, cookie
secrets, service-account keys, databases/WAL files, backups, private lecture
material and work transcripts. The repository ignores common local secret/data
files; Docker uses an explicit source allowlist so they cannot enter build context.
Keep custom private files in ignored data directories or outside the checkout.

Gitleaks runs on CI. Two exact historical false-positive fingerprints are
recorded in `.gitleaksignore`: a blank environment assignment interpreted across
lines and a synthetic test idempotency key. No directories or secret rules are
broadly excluded. New real findings must be removed and rotated, never allowlisted.

No request bodies, Authorization headers, OAuth codes, owner passwords or raw Amp
stderr are logged by HQ. Caddy access logging is not enabled. Avoid turning on
proxy/body debugging in production.

## Operational limits

One replica, local durable SQLite, no unsolicited notifications, no automatic
Amp retry, and no arbitrary URL-fetching or local command tool. Receipt-based
write retries are protected for 30 days. JSON output and thread excerpts are
bounded. Schema and live-status compatibility with Amp still require a live
account check when upgrading the pinned SDK/CLI.

To report a vulnerability, privately contact the repository owner through a
channel they already publish. Do not open a public issue containing credentials,
private work data or an exploit against a live personal deployment.
