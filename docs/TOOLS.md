# Tools and voice recipes

Use exact IDs returned by read tools for updates. If two items sound alike,
ask a short clarifying question rather than guessing. Calendar dates are sent as
`YYYY-MM-DD`; `hq_status` reports the owner's configured time zone.

| Tools | Permission | Purpose |
| --- | --- | --- |
| `hq_status` | `hq:read` | Configuration/capabilities, without credentials |
| `lists_get`, `items_get` | `hq:read` | List discovery and paged contents |
| `list_create`, `list_archive` | `hq:write` | Create, archive or restore custom lists |
| `items_add`, `item_update` | `hq:write` | Batch capture, edit, complete and reopen |
| `note_capture` | `hq:write` | Store a tagged thought or decision |
| `notes_search` | `hq:read` | Search captures by words and tags |
| `decks_get` | `hq:read` | Decks and due-card counts |
| `deck_create`, `cards_add` | `hq:write` | Turn supplied material into study cards |
| `study_next`, `study_reveal`, `study_grade` | `hq:write` | Review one question and persist the schedule |
| `ride_briefing` | `hq:read` | Tasks, shopping, study and recent captures; Amp observations need `amp:read` too |
| `amp_threads_get`, `amp_thread_read`, `amp_live_status` | `amp:read` | Fresh account metadata, conversation history and active-thread evidence |
| `amp_jobs_get`, `amp_job_get` | `amp:read` | Recorded observations of HQ-dispatched jobs |
| `amp_work_start`, `amp_monitor_stop` | `amp:execute` | Explicit remote dispatch or stop observing; monitoring stop is not remote cancellation |

## Grocery capture

“Add two cartons of oat milk, six bananas and bread to shopping.” The assistant
can do one `items_add` call with three entries and read back a short confirmation.
When you say “I got the bread,” it reads the list and marks the exact item done.
Completed items remain available through the done/all filters and can be reopened.

## Work loop

“Find my recent cache-review thread.” Read account metadata, choose the exact
thread ID, then fetch its latest conversation excerpt. Use a live snapshot for
activity evidence. Do not interpret a recent message or absent active thread as
completion. “Start a new review in my project” dispatches remotely and returns an
HQ job ID immediately; a later request can read observed progress or the result.

## Study loop

Create a deck, add cards from user-supplied notes, then call `study_next`.
Ask the question and wait. Call `study_reveal` only after an answer or explicit
request, discuss the explanation, and grade again/hard/good/easy. “Again” comes
back in ten minutes; other grades increase the interval up to a year. This is a
simple interval scheduler, not an FSRS implementation. A repeated grade for the
same review is idempotent; a conflicting grade is rejected.

## Retry behavior

For retryable list/capture/deck writes, use a unique `idempotencyKey` for that
logical action. Send the identical key and arguments only when retrying that
same action. Amp dispatch always requires a key. A new intentional action needs
a new key, even if its wording is identical. Receipts expire after 30 days.

Read tools have explicit limits/cursors. Follow a cursor when the user asks for
more; do not claim to have read an entire list or thread from a bounded excerpt.

## Pull-based updates

“Give me a ride briefing” is a snapshot. HQ does not keep listening, inject
notifications into ChatGPT voice, schedule reminders, or determine your location.
Ask again for new information. Calendar, GitHub and notifications are future
adapters described in the [roadmap](VISION.md), not enabled integrations.
