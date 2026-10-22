# Amp

HQ uses the official pinned `@ampcode/sdk` and CLI, with no private API scraping.
Set the access token from [Amp Security Settings](https://ampcode.com/settings/security#access-token)
as `AMP_API_KEY` privately and enable `AMP_ENABLED`. Use `AMP_EXECUTOR=orb` with
optional `AMP_PROJECT`, or `runner` with `AMP_RUNNER_ID` / `AMP_RUNNER_DIR`.
On the work machine, a runner can be started with `amp --no-tui --runner-id
work-bike --dir /absolute/path/to/repo`. Configure repository access and remote
tool permissions in Amp; HQ does not copy work credentials into source.

| Tool | What it knows |
| --- | --- |
| `amp_threads_get` | Fresh official CLI metadata; not execution status |
| `amp_thread_read` | Fresh bounded markdown excerpt, revision hash and character cursors |
| `amp_live_status` | First experimental `amp top --stream-jsonl` snapshot; absence does not prove completion |
| `amp_work_start` | Atomically save a job + retry receipt + daily reservation, then enqueue its ID |
| `amp_jobs_get`, `amp_job_get` | Firestore observations, timestamps and result/permission-denial excerpts |
| `amp_monitor_stop` | Cancel unclaimed queued work, or request observation stops within ten seconds; remote execution may continue |

The Cloud Tasks worker executes inside `/internal/amp/run`'s HTTP request. It
claims the Firestore job/worker slot before starting the SDK. Task redelivery
does not repeat a claimed prompt. There is no background worker after an MCP
response, no startup sweep that interrupts another instance, and no automatic
resubmission of uncertain remote work.

If scheduling fails, the record remains queued with `dispatchState=pending`.
Retrying the same key or the recovery schedule repairs dispatch. Jobs queued for
23 hours are cancelled rather than recreating an old request after task-name
retention. A worker lease expires after its timeout plus a two-minute margin;
recovery marks it interrupted and releases the slot. Inspect Amp before
requesting a new job after an interruption. Success means Amp reported a
successful **turn**, not that every desired task was completed.

Only remote threads originally created by HQ can be continued, with their
original target. Existing account threads remain readable. New threads are
private. Work is never dispatched to a local executor on the MCP host.

The default ten-minute timeout, ten admissions/day and 30-minute daily time
budget control HQ observation cost, not Amp credits. Progress is persisted in
coalesced updates every ten seconds; the latest ten tool-name events and bounded
result text are kept. Terminal job records and retry receipts last 30 days.
Readback and streaming errors are sanitized; upstream stderr is not forwarded.

Live account and experimental status-schema behavior still require a smoke test
using the owner's private token on their deployment. Automated tests use synthetic
adapters plus the real installed CLI's help command; no work account is accessed.
