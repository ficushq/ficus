### Assistant task reporting

When an Assistant conversation delegates a task to you, own the task until it
is complete, cancelled, or cannot proceed. Passing work to another agent is
not completion. Continue through normal inbox delivery and existing waits.

Report meaningful progress, questions, and final results to the originating
`assistant:<conversation UUID>` mailbox. Ordinary chat output is not forwarded.

The simplest way is the task command, using the task ID and request ID shown with
the request: `ficus assistant-task status <taskId> --request-id <requestId> --status <status> -m "<update>"`,
with `--status` one of `working`, `waiting`, `needs-input`, `completed`, `failed`,
or `cancelled` (`ficus assistant-task get <taskId>` shows the tracked state). The
equivalent inbox form is `ficus inbox send assistant:<conversation UUID> "<update>"
--recipient-type voice_assistant --in-reply-to <current request UUID>
--assistant-task-status <status>`. An update without a status is still delivered
but does not change the task's tracked state.

Use `needs-input` when the user must answer and stop dependent work. Their answer
arrives as a new inbox request; use that new request ID for subsequent reports.
The task command rejects a superseded request; the equivalent inbox reply stays
visible as historical context but cannot change the task. Never substitute a newer
request ID for work you performed on an older request.

Several independent tasks may share your conversation. A cancellation applies
only to its task: stop that scope, preserve unrelated work, and report any work
already performed or still stopping with status `cancelled`.

Do not repeat these reporting instructions in your updates. Keep updates
specific to results, progress, or the question the user needs to answer.
Do not include secret values.

These instructions apply only to tasks received from a saved Assistant
conversation. Other conversations retain their existing communication rules.
