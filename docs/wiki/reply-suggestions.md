# Reply suggestions and the Lite tier

When an agent ends a chat turn by asking you something in plain text (not through a question card),
the chat offers two to four one-tap replies just above the composer. They are suggestions only:
nothing is tracked, no wait is opened, and nothing blocks on them.

## The Lite model tier

`config/model-tiers/lite.yaml` is the cheapest tier, for one-shot utility calls (suggestions, labels,
short summaries). Its chain is Claude Haiku 4.5, then GPT-6 Luna, then the cheapest zai model, all
without thinking. It appears in **Settings → Agent Types → Model tiers** like any other tier and can be
edited there. No shipped agent type uses it.

One-shot calls go through `completeWithTier` (`apps/core/src/services/model-tiers/`). It walks the
tier's chain, skipping candidates that agent model selection would skip (disabled, unauthenticated or
unhealthy providers), and uses the stored provider accounts through the shared model runtime. Each
candidate gets a short timeout and the whole call has an overall deadline and a small output cap. It
never throws; a failure resolves to `null`.

When the account selected for a candidate is Claude Code, the call goes through a one-shot Claude Code
query (`apps/core/src/services/agent/claude-code/one-shot.ts`), not the agent session bridge. It
sends a plain string prompt with no tools, no user or project settings, a single turn and no saved
session, in an empty working directory, and closes the query (ending the `claude` process) as soon as
the answer arrives, and on a timeout, an abort or an error. Claude Code uses its own sign-in; none of
Core's credentials reach it. Because starting `claude` takes a few seconds, that candidate waits at
least 10 seconds; the request's overall deadline still bounds it, and later candidates get what is
left. The output cap is passed to Claude Code and enforced again on the answer. Usage of these calls is
not recorded anywhere yet, as with the other Lite candidates.

## When suggestions run

Core (the API process) listens for `execution.completed` and, without delaying anything, asks for
suggestions only when all of these hold:

- **Reply suggestions** is on (the switch under the Lite tier; `REPLY_SUGGESTIONS_ENABLED`, on by
  default). While it is off, no database read or model call happens.
- The agent is idle, shows no question card and has no open questions.
- The agent's latest human-role message is a person's chat message (`source: user_chat`), so
  inbox-driven or system-driven turns (most worker turns) get none, and the agent's latest message
  after it has text.
- A cheap pre-check finds a likely question in the last two paragraphs, after removing URLs and query
  strings, code, block quotes, headings and bold heading-style questions: a `?`, or phrases such as
  "want me to", "should I", "let me know" or "your call".

The model sees only two text excerpts: the end of the agent's message (about 1,500 characters) and
the start of the person's previous message (about 500). Tool calls, tool results and thinking are
never sent. Its answer is untrusted: it must be a JSON array, and only plain single-line strings of
at most 40 characters without links are kept, at most four, and at least two or none. A newer human
message makes the save a no-op.

The replies are saved as `metadata.replySuggestions` on the agent message and pushed to clients with
`message.updated`, so reopening the chat costs nothing. While the switch is off, the message endpoints
(`GET /api/agents/:id/messages` and `.../messages/:messageId`) leave saved replies out, so web and
mobile stop showing them without checking the setting themselves; turning it back on shows them again.

## In Settings

`GET /api/model-tiers` reports each tier's `usableCandidates`: the models a one-shot call could use
right now (enabled, signed in, healthy; OpenRouter fallbacks excluded). A signed-in Claude Code
account counts, so a setup whose only sign-in is Claude Code gets suggestions. When the Lite tier has none
and the switch is on, Settings says "No Lite model is signed in" beside it. The saved preference is not
changed.

## In the chat

Chips show only for the latest agent message while it is the last thing in the transcript. They hide
while the agent works, beside a question card or open questions, once you start typing, and after any
message is sent. A tap sends the reply; Shift+click (desktop) or a long press (touch) puts it in the
composer to edit first.

## Checking the prompt

`apps/core/src/services/reply-suggestions/fixtures.ts` holds paraphrased real examples. Unit tests run
the pre-check over them. To try the shipped prompt against live models (never run in CI):

```bash
ANTHROPIC_API_KEY=... bun apps/core/src/services/reply-suggestions/live-eval.ts
```
