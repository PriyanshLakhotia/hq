# Deployment and operation

## Recommended first GCP deployment

Use one Compute Engine VM (Linux x86-64, around 2 vCPU / 4 GiB RAM), a durable
persistent disk, a domain pointing at its static IP, and Docker Engine + Compose.
This is a deployment recipe, not an already provisioned service. No GCP
credentials or domain are stored in this repository.

1. Create the VM and a persistent disk in your GCP project. Mount the data disk
   according to GCP's instructions, for example at `/mnt/disks/hq-data`. Disable
   automatic deletion of that disk when deleting the VM.
2. Allow inbound TCP 80 and 443 to this VM for Caddy's HTTPS. Keep port 8080
   private. Restrict SSH using your normal GCP/IAP access policy.
3. Point your domain's DNS A record at the VM. Add an AAAA record only if IPv6
   reaches the same host. Install Docker and the Compose plugin from their
   official distribution.
4. Clone the repo onto the VM. Copy `.env.example` to `.env`, make it private
   with `chmod 600 .env`, and edit it locally. Never paste credentials in chat.

Set these private deployment values:

| Variable | Value |
| --- | --- |
| `HQ_DOMAIN` | Your hostname, without a scheme or path |
| `PUBLIC_URL` | `https://` followed by exactly that hostname |
| `ACME_EMAIL` | Your certificate contact address |
| `HQ_DATA_DIR` | Absolute directory on the mounted durable disk, e.g. `/mnt/disks/hq-data/data` |
| `OWNER_PASSWORD_HASH` | Output of `npm run password` on a Node 24 machine |
| `COOKIE_SECRET` | Output of `openssl rand -hex 32`; preserve it across updates |
| `OAUTH_REDIRECT_URIS` | Exact callback(s) from your client, comma-separated; HTTPS only |
| `TIME_ZONE` | IANA time zone such as `Europe/Amsterdam` |
| `AMP_*` | Optional values from [the Amp guide](AMP.md) |

Create the data directory on the mounted disk and give UID/GID 1000 ownership.
The image runs as the unprivileged `node` user. For the example path above:

```sh
sudo install -d -o 1000 -g 1000 -m 700 /mnt/disks/hq-data/data
docker compose up -d --build
```

Compose starts one HQ container and one Caddy reverse proxy. Caddy obtains and
renews HTTPS certificates. HQ has no public host port, runs with a read-only
root filesystem, and stores SQLite/WAL files on the mounted data directory.
Its temporary Amp cache lives in a limited `/tmp` tmpfs. Application state does
not live in that cache. Compose reads your private `.env`; it is never copied
into the image. No cloud deployment happens from CI.

Check `https://YOUR_DOMAIN/healthz`, then `https://YOUR_DOMAIN/`.
A request to `/mcp` without a bearer token should return **401**, with a
`WWW-Authenticate` link to the protected-resource metadata. A public health
response must contain no personal records.

### Connect ChatGPT or another MCP client

1. Open your client's supported custom-app/MCP configuration screen.
2. Enter `https://YOUR_DOMAIN/mcp`, select OAuth, and copy its exact callback URL
   to `OAUTH_REDIRECT_URIS` before connecting. Restart HQ if you change `.env`:
   `docker compose up -d --force-recreate hq`.
3. Let the client discover metadata and register. HQ supports public PKCE or
   `client_secret_post` clients. Other auth methods require a client change.
4. In the browser, check the displayed client name, callback and requested
   permissions. Enter the owner password and authorize.
5. In text chat, list your lists, add a synthetic item, read it back, and complete
   it. Then repeat a small read/write in the exact voice client you intend to use.
6. Enable Amp only when ready. Read one known thread, inspect a live snapshot,
   then dispatch a harmless request against the configured remote project or
   runner and read its final job result. Reconnect with `amp:execute` if your
   initial grant did not include that permission.

Voice availability is determined by the client, plan and workspace policies.
Use text or another MCP client when custom tools are unavailable in voice.

### Development and managed proxies

On a normal host, `docker build -t hq-mcp .` is sufficient. In a managed executor
with a trusted outbound proxy, the Dockerfile accepts an optional CA build
secret, e.g. `docker build --secret id=proxy_ca,src=/path/to/proxy-ca.pem -t hq-mcp .`.
Keep TLS verification enabled; the CA is mounted only during dependency install.
Runtime proxy CA mounts are environment-specific and should stay outside source.

## Backups

Do not copy only `hq.db` while it is running: recent writes may still be in its
WAL. Use the included SQLite online-backup script for a consistent snapshot:

```sh
docker compose exec hq node scripts/backup.mjs /app/data/hq.db /app/data/backups/hq-backup.db
```

Choose a **new filename** for each run; the script refuses overwrites. Keep
backups private, encrypted and off the VM. Schedule backups with your existing
infrastructure scheduler; the repo does not create a GCP schedule or bucket.
Also securely retain `.env`, especially `COOKIE_SECRET`, so encrypted OAuth
client secrets remain readable after restore. Backups include private notes,
work output and authorization grants. Treat them as credentials.

To restore, stop HQ, preserve the current database and WAL/SHM files elsewhere,
place the chosen consistent backup at the configured database path, remove only
stale WAL/SHM files belonging to the replaced database, restore UID 1000
ownership, and start HQ. Restore one database at a time; never run two replicas
against different copies. If a backup may have exposed tokens, revoke all
connections before allowing clients back in.

## Updates and recovery

```sh
git pull --ff-only origin main
docker compose up -d --build
```

Back up before updates. Preserve `.env`, durable data and Caddy's certificate
volumes. On restart, HQ marks in-progress Amp observations interrupted; remote
work may still be running. Inspect Amp before dispatching the same task again.
Database initialization is additive for schema version 1. Future schema changes
need explicit migrations and a restore-tested backup.

Client disconnect: use its OAuth revocation/disconnect flow. For an emergency
all-client revocation, stop HQ, take a private backup, then delete the
`oauth_access`, `oauth_refresh`, `oauth_codes`, `oauth_pending` and `oauth_clients`
namespaces from the `documents` table using an offline SQLite tool. This keeps
lists, notes and study cards. Restart and reconnect clients. Changing only the
owner password does not invalidate existing bearer tokens.

Use `docker compose ps` and `docker compose logs --tail=50 hq` to check service
health. Do not add verbose request logging or print `.env` to troubleshoot.
Upstream Amp errors are deliberately summarized; inspect the private thread
and account in Amp for details.

## Why not default Cloud Run?

This server uses SQLite plus in-process Amp observation workers. Cloud Run's
writable layer is ephemeral, replicas do not share a database, and request-based
CPU allocation can suspend background work. Merely deploying this image there
would be unreliable. A Cloud Run variant should move state to Cloud SQL or
Firestore, dispatch jobs through a durable queue/worker, and keep OAuth token
rotation atomic in that shared store. Keep one durable VM until that work exists.
