# HQ

**Your personal MCP headquarters for the thoughts between places.**

Ask ChatGPT to keep your lists, catch an idea, quiz you on a topic, or check on
Amp while you're out riding. HQ provides the tools and memory; your MCP client
provides the conversation.

- **Lists:** built-in TODO and Shopping, custom lists, batch additions, quantities,
  priorities, due dates, completion/reopening, archive/restore, and pagination.
- **Capture:** searchable notes with tags for ideas, decisions and open loops.
- **Study:** question/answer decks, one-card-at-a-time reviews, hidden answers,
  and spaced scheduling with again/hard/good/easy grades.
- **Briefings:** overdue work, urgent tasks, shopping count, due cards, recent
  captures, and authorized Amp job observations in one call.
- **Amp:** official SDK/CLI integration for remote work, thread history, live
  activity snapshots, and persistent background job progress.
- **Remote MCP + OAuth:** `/mcp`, owner consent, S256 PKCE, scoped access, refresh
  rotation/replay detection, revocation, and durable grants.

Brightspace is deferred. The [brainstorm and roadmap](docs/VISION.md) include
calendar prep, GitHub/CI monitoring, routines, location-aware errands and reminders.

## Try it locally

Requires **Node 24+**. The Amp dependency includes a platform-specific CLI binary.

```sh
npm ci
cp .env.example .env
npm run password
```

Copy the generated hash into `OWNER_PASSWORD_HASH` in your private `.env`.
Generate a separate `COOKIE_SECRET` with `openssl rand -hex 32` and paste that
output into `.env`. Keep the owner password in your password manager.

Set `OAUTH_REDIRECT_URIS` to the **exact** callback URL your MCP client displays.
The example includes ChatGPT's connector callback; confirm it in your setup.
Set `TIME_ZONE` to your IANA time zone for local briefing dates.

```sh
npm run verify
npm run dev
```

Open [localhost:8080](http://localhost:8080). Health is at `/healthz`; MCP is at
`/mcp`. Production start: `npm run build && npm start`.

Use a remote MCP client that supports OAuth and Streamable HTTP. Connect it to
`https://YOUR_DOMAIN/mcp` after [deploying with HTTPS](docs/DEPLOYMENT.md).
The authorization metadata is at `/.well-known/oauth-authorization-server` and
protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`.
Dynamic registration supports public PKCE clients or `client_secret_post`.

**Check ChatGPT voice support first.** Custom MCP apps depend on your plan,
workspace policy and current client. Tool access in text does not establish
availability in voice. Validate a read and a write in your exact phone/client
before depending on it during a ride. HQ cannot enable unsupported client features.

## Things to say

> “Add two cartons of oat milk and bananas to my shopping list.”
>
> “Put renewing my passport on TODO, high priority, due November first.”
>
> “Capture this idea, tagged onboarding: show a worked example before setup.”
>
> “Give me a quick ride briefing. What needs my attention?”
>
> “Create a distributed systems deck from these notes, then quiz me one question at a time.”
>
> “Read the latest reply in my Amp cache-review thread.”
>
> “Start a private Amp thread to review the cache in my configured project.”

MCP prompts `ride-start`, `weekly-review`, and `study-ride` provide ready-made
conversation starters. See [the tool guide](docs/TOOLS.md) for the exact surface.

## Connect Amp

Set `AMP_API_KEY` and `AMP_ENABLED=true` privately on the server. Choose
`AMP_EXECUTOR=orb` for an Amp cloud sandbox or `runner` for a named work machine.
Optional `AMP_PROJECT`, `AMP_RUNNER_ID`, and `AMP_RUNNER_DIR` select your workspace.
New threads are private. No arbitrary local shell is exposed by HQ.

[The Amp guide](docs/AMP.md) explains setup, sources of status evidence, restricted
continuations, credit usage, and what still requires a live account smoke test.

## Deploy and operate

Start with **one GCP VM, a durable disk and HTTPS** using the included Docker
Compose + Caddy configuration. SQLite is a deliberate single-owner, single-replica
choice. Cloud Run's default ephemeral disk is unsuitable for this version.

- [Deployment, backup and recovery](docs/DEPLOYMENT.md)
- [Security and public-repository boundaries](docs/SECURITY.md)
- [Feature ideas and architecture](docs/VISION.md)
- [Tool guide and voice recipes](docs/TOOLS.md)

`npm run verify` runs TypeScript checks, domain/OAuth/Amp tests, and a production
build. Tests use synthetic data and do not need live tokens. Docker builds run
the same suite. CI adds dependency auditing, container builds and Gitleaks.

The server is pull-based: ask again for fresh updates. It does not push alerts,
run a reminder scheduler, access Brightspace, or fetch arbitrary URLs.
