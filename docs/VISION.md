# HQ: a voice-first personal headquarters

The best bike interaction is a short request, an actual action, and a short answer.
HQ should remember what you said, expose fresh work evidence, and let ChatGPT do
the conversation. It is an MCP tool server, not a voice client.

## Ideas, ranked by usefulness

| Idea | Example | Decision |
| --- | --- | --- |
| Default TODO + shopping lists | “Add oat milk and bananas to shopping.” | Build now |
| Custom lists with priorities and due dates | “Put renewing my passport on errands, due Friday.” | Build now |
| Capture inbox with tags and search | “Remember this idea for the onboarding flow.” | Build now |
| Ride briefing | “What needs my attention before I get to work?” | Build now |
| Amp work monitor + dispatch | “What did the agent say? Continue that thread.” | Build now via official SDK/CLI |
| Flashcards with spaced review | “Quiz me on distributed systems, one question at a time.” | Build now; manually supplied material |
| Saved routines | “Start my weekly review.” | Provide MCP prompts now |
| Personal glossary / decisions | “Why did we choose Postgres?” | Covered by searchable notes |
| Calendar + meeting preparation | “What is my next meeting and what should I read?” | Later: separate least-privilege adapter |
| GitHub CI and pull requests | “Did the build turn green?” | Later: use official GitHub APIs |
| Location-aware errands | “What can I pick up on the way home?” | Later: needs explicit location input |
| Reminders and proactive alerts | “Tell me when that agent is done.” | Later: needs a scheduler + notification channel |
| Audio study courses from Brightspace | “Walk me through lecture four.” | Deferred as requested |

## Product rules

- Short structured results with stable IDs; no giant transcript unless requested.
- Readbacks must distinguish a recorded observation from live execution state.
- Writes support idempotency keys so an explicit retry need not duplicate a capture.
- Complete/archive before deleting. No bulk destructive tool in the first release.
- Study answers remain hidden until the user responds; review grades drive scheduling.
- Remote execution uses Amp cloud or a named runner, never the MCP host's shell.
- No arbitrary URL fetching, shell execution, or plaintext credential tools.
- No personal data, access tokens, databases, or private work material in source control.

## Architecture

Node 24 + TypeScript, official MCP SDK, stateless Streamable HTTP at `/mcp`,
SQLite on a durable volume, OAuth authorization code + S256 PKCE with owner
consent. One owner, one database, one replica. Token hashes and OAuth grants
persist across restarts. A password hash protects owner authorization; it is not
an OAuth bearer token. New clients register with an exact callback allowlist.

Amp runs through its official SDK and CLI. Background jobs persist observed
progress; the server reconciles interrupted jobs after restart. Existing remote
thread history is queried through supported CLI commands. External threads do
not become “running” merely because their last message looks unfinished.

For GCP, start with a small VM + durable disk + HTTPS reverse proxy. A SQLite
file on Cloud Run's ephemeral filesystem would lose data; a multi-replica Cloud
Run deployment needs a separate shared durable store and worker architecture.

## ChatGPT compatibility boundary

ChatGPT plan, workspace policy, app approval, and current client capabilities
determine availability of custom MCP apps and whether their tools can be used
in voice. A working MCP server cannot enable an unsupported voice feature.
Validate one read and one write in your exact ChatGPT client before relying on
it during a ride. The same endpoint works in other remote MCP clients.
