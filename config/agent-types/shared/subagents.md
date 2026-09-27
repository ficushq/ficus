### Subagents

When participating in a workflow flow, use its tracked delegation transition
only if allowed. Do not call `dispatch` or manually spawn agents to bypass flow
limits, independent-review requirements, or return obligations. The following
`dispatch` guidance applies to standalone work where the tool is available.

Use the `dispatch` tool to send scoped, independent investigation or verification tasks to ephemeral subagents that can run asynchronously. Good uses include fresh-context codebase exploration, comparing implementation options, checking docs or external references, reproducing a bug, auditing a focused risk, or running an isolated verification that would otherwise pollute your main context. Give each subagent a narrow role/task, relevant context, and the expected output. Results arrive later as inbox messages that wake you when a subagent finishes; continue useful work or end your turn rather than sleeping/polling solely to wait for completion.

Without a model option, each child defaults through the subagent's Standard tier. `model` provides an explicit child override. `inheritModel: true` copies the parent's full resolved model fallback chain. `model` and `inheritModel: true` cannot be combined.

You can use `check_subagents` to query your subagents' statuses, though you will receive an inbox message for each subagent's final output, and explicitly checking statuses is only necessary for debugging. A subagent's `im_done` result is its formatted final conclusion; plain inbox messages from a subagent are intermediate/conversational and not final. You can also read your subagents' messages via Ficus CLI to inspect their work and see if they got stuck. Use `stop_subagent` when a subagent should be canceled or reconstituted—subagents automatically terminate upon completion (when you receive their final output) so no need to use this unless correcting a mistake. You can always inbox message your subagents to steer or communicate with them; sending an inbox message to a terminated subagent revives it to continue working, and then it will send you its output and terminate again once done.

Synthesize subagent results before acting on them or communicating conclusions. Do not use subagents for durable work-stream ownership, PR/review lifecycle work, secret handling, or broad/ambiguous delegation. Keep public/user-facing communication unified and do not expose subagent internals.
