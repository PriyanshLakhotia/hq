# Security

HQ is single-owner. Authorized clients share the same lists and Amp account.

OAuth uses S256 PKCE, exact HTTPS callback allowlists, owner-password consent,
browser binding and CSRF protection. Codes expire in two minutes, consent in ten
minutes, access tokens in one hour and rotating refresh tokens in 30 days.
Refresh replay marks a shared Firestore token family revoked atomically. Codes
and tokens are stored by hash; confidential client secrets are AES-256-GCM
encrypted using `COOKIE_SECRET`. The owner password is a scrypt hash. Keep the
cookie secret stable. Client registration secrets use the SDK's 30-day expiry.

Lists use `hq:read` / `hq:write`; Amp uses `amp:read` / `amp:execute`. Tools outside
the grant are not registered. Host/Origin checks and HTTP/body limits remain.
Rate limits are per-process protection, not a distributed spending cap.

Cloud Run's front-door Invoker IAM check is disabled so ChatGPT's custom OAuth
bearer tokens reach the app. `/mcp` requires HQ OAuth. `/internal/*` requires a
Google-signed OIDC ID token with the configured audience and the exact verified
`TASKS_SERVICE_ACCOUNT` email. Task headers and normal HQ tokens cannot authorize
workers. Cloud Tasks and Scheduler mint tokens via managed service identities.
No shared worker password or public unauthenticated execution route exists.

All persistent data is Firestore, accessed using the attached runtime identity.
Firebase client rules deny all reads/writes; server IAM is separate. There is no
bundled service-account key or local production database. Memory is development
only and rejected on Cloud Run. The emulator is also rejected on Cloud Run.
Firestore protects data at rest; authorized server identities can read its stored
list/work content. Restrict those identities and project access accordingly.

Secrets belong in Secret Manager and private local config. Docker/Cloud Build
use explicit source allowlists. Do not log bearer values, prompts, raw upstream
errors or private work output. SDK child processes inherit only allowed runtime
variables plus the Amp token, not HQ OAuth secrets or Google credential files.
Amp uses remote executors and does not automatically rerun uncertain work.

CI scans dependencies and runs Gitleaks; `.gitleaksignore` contains two exact
historical synthetic false positives, not broad exclusions. Treat list text and
Amp content as untrusted data. `amp:execute` can modify remote work and spend
credits, and requires an explicit user request.
