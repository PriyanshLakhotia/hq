# Amp integration

HQ uses the official [`@ampcode/sdk`](https://www.npmjs.com/package/@ampcode/sdk)
and the CLI it installs. The lockfile pins the SDK and CLI versions verified by
this project. It does not scrape private web APIs or guess endpoint contracts.

## Connect your account

Create an access token in [Amp Security Settings](https://ampcode.com/settings/security#access-token).
Set it as `AMP_API_KEY` in the private server environment and set `AMP_ENABLED=true`.
Do not send the token in a chat or commit it. Restart HQ and reconnect the MCP
client with `amp:read` and, if desired, `amp:execute` scopes.

Choose one execution target:

- `AMP_EXECUTOR=orb`: Amp-managed cloud sandbox. Optionally set `AMP_PROJECT` to
  an Amp project configured with the relevant repository, secrets and permissions.
- `AMP_EXECUTOR=runner`: a machine with your work checkout and a named Amp runner.
  Set `AMP_RUNNER_ID` and optionally `AMP_RUNNER_DIR` on HQ. On the work machine,
  run `amp --no-tui --runner-id work-bike --dir /absolute/path/to/work/repo`.
  The directory must be served by that runner; see your installed CLI's help.

Use the correct work account and an execution environment authorized for your
work repositories. HQ does not upload your work checkout or embed your account
configuration in this public repository. Configure remote tool permissions in
Amp itself; the SDK's local-only permissions do not apply to remote executors.

## What each tool actually knows

| Tool | Evidence and limitations |
| --- | --- |
| `amp_threads_get` | Fresh `amp threads list --json`, paged by limit/offset. Saved metadata is not an execution status. Upstream fields are preserved. |
| `amp_thread_read` | Fresh `amp threads markdown T-...`, latest excerpt by default. Returns timestamps, a revision hash and earlier/later character cursors. A changed revision requires rereading. |
| `amp_live_status` | First JSON snapshot from `amp top --stream-jsonl`; its schema is explicitly experimental. A 12-second timeout means unknown. Absence does not prove completion. |
| `amp_work_start` | Official SDK `execute()` against `orb` or `runner`. Returns an HQ job immediately; events update persistent observations in the background. |
| `amp_jobs_get` / `amp_job_get` | Persisted observations of HQ-dispatched work. Includes last observed text, result, permission denials and observation times. Does not refresh remote state. |
| `amp_monitor_stop` | Ends HQ observation. Remote execution may continue. Stop remote work in Amp itself. |

A successful job means Amp reported a successful end of the requested **turn**.
The text and permission denials determine whether your actual task is complete.
HQ records tool names, not tool arguments or chain-of-thought. It keeps the last
20 progress events and a bounded final excerpt; read the actual thread for more.

Existing account threads can be read and monitored. Execution can continue only
remote threads originally created by HQ. This conservative boundary prevents a
local-only historical thread from unexpectedly executing on the MCP server.
New threads use private visibility. HQ has no arbitrary shell or local executor
tool. Each execution needs an explicit user request and an idempotency key.

## Failure and lifecycle behavior

- At most two HQ coding jobs run concurrently; sending another prompt to the same
  active HQ thread is rejected.
- Identical retries with the same key return the existing job's current status.
  Reusing a key with different arguments is rejected.
- Dispatch receipts last 30 days. After that, inspect history before resubmitting
  an old request; the same key may be treated as a new action.
- Timeout, process loss, restart and shutdown produce `interrupted` monitoring,
  not a fabricated remote completion. HQ never automatically resubmits work.
- The default observation timeout is 30 minutes, configurable up to two hours.
- Responses are bounded; history retrieval has a 4 MiB maximum. Extremely large
  threads should be viewed in Amp. Lists and live snapshots cap tool output at
  24,000 characters and explicitly mark truncation.
- SDK execution and CLI reads run in dedicated child process groups. HQ's OAuth
  secrets and cloud credential variables are omitted from their environment.
  The Amp access token is passed as an environment variable, never a command
  argument. Upstream stderr is not forwarded or logged.

## Verification boundary

The test suite covers dispatch, retries, progress, restart reconciliation,
concurrency, history revisions, environment isolation, and the real installed
CLI/worker startup without network access. Live account behavior requires your
private token and outbound HTTPS to Amp. CLI flags were checked against the
pinned installed binary. Account access and the exact upstream list/live JSON
payloads still need a live smoke test on your server; HQ preserves those
payloads instead of inventing statuses or depending on undocumented field names.
