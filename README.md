# HQ

A personal MCP server for **lists and Amp**, with OAuth at `/mcp`.

- **Lists:** TODO, Shopping, and custom lists; batch additions, quantities,
  priorities, due dates, completion/reopening, archive/restore, and pagination.
- **Amp:** thread history, live activity snapshots, remote work through the
  official SDK/CLI, and persistent job progress.

## Run

Requires Node 24+.

```sh
npm ci
cp .env.example .env
npm run password
```

Put the generated hash in `OWNER_PASSWORD_HASH` in your private `.env`.
Generate a separate `COOKIE_SECRET` with `openssl rand -hex 32`.
Set `OAUTH_REDIRECT_URIS` to your MCP client's exact HTTPS callback URL and
`TIME_ZONE` to the IANA time zone your client should use for list dates.

```sh
npm run dev
```

Production build and start: `npm run build && npm start`.

To connect remotely, set `PUBLIC_URL` to your server's HTTPS origin and enter
`https://YOUR_DOMAIN/mcp` in your client's OAuth/Streamable HTTP configuration.
HQ supports dynamic registration for public PKCE and `client_secret_post`
clients, with owner consent, scoped permissions, token rotation and revocation.
ChatGPT custom app and voice availability depend on your plan and client.

## Lists

| Tool | Purpose |
| --- | --- |
| `lists_get` | Read lists and open-item counts |
| `list_create` | Create a custom list |
| `list_archive` | Archive or restore a custom list |
| `items_get` | Read paged open, done, or all items |
| `items_add` | Add up to 30 items in one call |
| `item_update` | Edit, complete, or reopen an item by exact ID |

Use `idempotencyKey` for an explicit retry of the same write. Identical retries
return the saved result; conflicting inputs are rejected. Receipts last 30 days.
`hq_status` reports capabilities, owner time zone, and Amp configuration status.

## Amp

Set `AMP_API_KEY` and `AMP_ENABLED=true` privately in `.env`. Use
`AMP_EXECUTOR=orb` for an Amp cloud sandbox or `runner` for a named work machine.
`AMP_PROJECT`, `AMP_RUNNER_ID`, and `AMP_RUNNER_DIR` select the remote context.

See [the Amp guide](docs/AMP.md) for thread tools, execution, and status semantics.
Lists use `hq:read` / `hq:write`; Amp uses `amp:read` / `amp:execute`.

## Development

```sh
npm run verify
```

Runs TypeScript checks, the lists/OAuth/Amp test suite, and a build. Tests use
synthetic data and do not need a live Amp token. CI also audits dependencies
and scans for secrets. See [security notes](docs/SECURITY.md) for auth and
public-repository boundaries.
