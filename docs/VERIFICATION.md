# Verification record

The implementation was verified with synthetic data and no live account tokens.

- TypeScript checks, production compilation, and **27 tests** pass.
- The official MCP client initializes over real Streamable HTTP, discovers
  scoped tools/prompts, writes and reads records, and receives validation errors.
- OAuth tests cover callback allowlists, HTML escaping, CSRF/browser binding,
  incorrect owner passwords, PKCE, client/redirect/resource binding, single-use
  codes, expiry, read-only access, refresh rotation/replay, revocation, and
  database/server restarts.
- Amp tests cover official installed CLI startup through the isolated worker,
  remote-only dispatch boundaries, concurrency, retry keys, progress/results,
  interrupted monitoring, revision-aware history, environment isolation, and
  permission filtering for work data and execution.
- Domain tests cover lists, completion/reopening, archive/restore, atomic retry
  receipts and rollback, calendar validation, notes across restarts, and hidden
  study answers with review scheduling. Dates are checked at a local midnight.
- Online SQLite backup is verified while the source database remains open;
  restoring includes committed WAL writes and backup overwrite is refused.
- The production Docker image builds and runs the suite. A separate runtime
  smoke test runs as the non-root image user with a read-only filesystem, tmpfs
  and persistent volume, performs OAuth plus a real MCP write/read, restarts the
  container, reuses the persisted bearer grant, reads the saved item and verifies
  an online backup contains it.
- Docker Compose configuration validates. Dependency audit reports zero known
  runtime vulnerabilities. Gitleaks scans source and history with redacted
  output; only two documented exact historical false positives are excluded.

Still required on your deployment: real GCP/domain/TLS provisioning, a live Amp
account/runner check using a privately installed token, confirmation of the
upstream experimental live-status payload, and ChatGPT text/voice compatibility
in your actual plan, workspace and phone client. No cloud service was deployed
and no personal/work account data was read during implementation.
