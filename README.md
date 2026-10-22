# HQ

A personal MCP server for **lists and Amp**, with OAuth at `/mcp`.

- **Lists:** TODO, Shopping, and custom lists with quantities, priorities, due
  dates, completion/reopening and cursor pagination.
- **Amp:** account threads, revision-aware history, live activity snapshots and
  durable queued work through the official SDK/CLI.
- **Cloud Run:** Firestore persistence, authenticated Cloud Tasks delivery,
  bounded worker requests and cross-instance coordination. No always-on worker.

## Run locally

Requires Node 24+.

```sh
npm ci
cp .env.example .env
npm run password
```

Put the hash in your private `OWNER_PASSWORD_HASH`, generate `COOKIE_SECRET`
using `openssl rand -hex 32`, and set the exact `OAUTH_REDIRECT_URIS` callback.
Then run `npm run dev`. Local memory storage resets on restart. For persistent
local work, set `STORAGE_BACKEND=firestore`, `GOOGLE_CLOUD_PROJECT` and use a
local emulator or your authorized Google identity. Old SQLite files are not
imported or modified by this version.

`npm run verify` checks types, runs tests and builds. Firestore integration tests
run when `FIRESTORE_EMULATOR_HOST=127.0.0.1:8787` is set; they require a local
emulator and never use a real project. The manual job backend is a test harness;
configure Cloud Tasks for actual queued execution.

## Connect

Set `PUBLIC_URL` to your HTTPS server origin and connect the MCP client to
`https://YOUR_DOMAIN/mcp` using OAuth/Streamable HTTP. Public PKCE and
`client_secret_post` clients are supported. ChatGPT custom app and voice tool
availability depend on your plan and client.

Lists use `hq:read` / `hq:write`; Amp uses `amp:read` / `amp:execute`.
`hq_status` reports the configured storage and job backends without credentials.

| Tools | Purpose |
| --- | --- |
| `lists_get`, `list_create`, `list_archive` | List discovery, creation, archive/restore |
| `items_get`, `items_add`, `item_update` | Paged reading, batch addition, editing and completion |
| `amp_threads_get`, `amp_thread_read`, `amp_live_status` | Fresh account metadata, conversation and activity evidence |
| `amp_work_start`, `amp_jobs_get`, `amp_job_get` | Queue work and inspect saved progress/results |
| `amp_monitor_stop` | Cancel queued work or request that active observation stops |

Use a stable `idempotencyKey` only for an identical retry. Write receipts and
terminal job history are retained for 30 days. Amp progress is coalesced every
10 seconds. A stopped or expired worker does not prove remote Amp execution stopped.

[Cloud Run deployment handoff](deploy/LOCAL_AGENT.md) · [Cost model](docs/COSTS.md) ·
[Amp behavior](docs/AMP.md) · [Security](docs/SECURITY.md)
