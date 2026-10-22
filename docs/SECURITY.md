# Security

HQ is a single-owner server. Every authorized client accesses that owner's
lists and Amp account; it does not isolate multiple users.

- OAuth uses authorization codes, S256 PKCE, exact allowlisted HTTPS callbacks,
  owner-password consent, browser binding, and CSRF protection.
- Lists use `hq:read` / `hq:write`; Amp uses `amp:read` / `amp:execute`.
  Each client sees only the tools its token permits.
- Codes expire in two minutes, consent requests in ten minutes, access tokens
  in one hour, and refresh tokens in 30 days. Refresh rotation detects reuse
  and revokes the token family. Confidential client secrets follow the SDK's
  30-day expiry; public PKCE clients do not receive a client secret.
- Tokens and codes are stored by hash. Confidential client secrets are encrypted
  with AES-256-GCM using a key derived from `COOKIE_SECRET`; keep that value stable.
  The owner password is stored only as a scrypt hash.
- SQLite files use private permissions, but list data and work output are
  plaintext. Restrict access to the database and server environment.
- Host/Origin checks, body limits, OAuth rate limits, and a stricter consent
  attempt limit protect the HTTP endpoints. Proxy headers are not trusted.
- Amp runs in a child process with an environment whitelist that excludes HQ's
  OAuth and cloud credentials. Execution uses remote Amp executors, and only
  remote threads created by HQ can be continued. `amp:execute` can modify code
  and spend account credits; Amp's remote permissions govern that work.
- List text and Amp history are untrusted content. The MCP instructions tell
  the assistant to treat them as data and require explicit requests for execution.

Keep real `.env` values, tokens, passwords, databases, private work output and
credential files outside Git. HQ does not log request bodies, authorization
headers, OAuth codes, owner passwords or raw Amp stderr.

CI runs Gitleaks. `.gitleaksignore` contains only two exact historical false
positives: an empty environment assignment and a synthetic test idempotency key.
No secret rules or directories are broadly excluded.
