---
name: setup-workflows
description: "Help a squad choose how it works: select a default workflow, configure when to use different flows, tailor specialist steps or decision-model routing steps, and save reusable presets without spawning participants. Use during squad onboarding or when the user wants to change their team's process."
---

# Set up how this squad works

The squad's purpose and its work process are separate choices. A writing,
research, operations, or engineering squad can use one capable agent, a builder
and reviewer, or its own combination of specialists. Do this configuration in
the manager conversation; it is not a work stream and needs no helper agents.

## Start from the existing configuration

Read `ficus squad get <squad-id>` and `ficus workflow list`. Inspect relevant
presets with `ficus workflow get <id>`. Existing `metadata.workflow` is the
default for new work. `metadata.workflowSetup` records the user's selection
policy and whether setup is complete. Preserve existing choices unless the
user asks to change them. Do not repeat completed onboarding on every chat.

When onboarding a new squad, introduce this briefly during its first user-led
setup conversation. Do not wake a manager solely to run this skill, interrupt
urgent work with a mandatory questionnaire, or silently replace an existing
squad's legacy process. If the user asks for a specific deliverable first,
handle that request and offer setup when useful.

## Have a short conversation

Use what the user has already told you. Ask only the missing questions, one
or two at a time, in ordinary language:

- What work will this squad handle? Which tasks recur?
- Do they prefer one capable agent by default, independent review, or a custom
  team? How do they weigh cost against additional specialist checks?
- Which kinds of work need more review or a human decision? What counts as
  delivered: a document/result, an approved review, or merged code?

Recommend the smallest useful default. Solo is a good fit for many routine
requests. A separate review step can be reserved for complex or sensitive
work. Avoid assuming software roles, mandatory architecture, or mandatory
review for every domain. Explain the proposed choices using task examples.
Leave maxStepAttempts unset by default for unlimited attempts; set an explicit attempt cap only when requested. Keep specialist delegation bounded by maxDelegations. Offer parallel reviews when independent checks can run together; use branches and a join to coordinate independent checks. Leave maxParallelAttempts unset by default so global agent capacity controls execution. Set a workflow-specific cap only when requested, and coordinate workspace edits between branches. Let agents request explicit rework
without automatically invalidating every previous review.

## Configure the agreed choices

Use the declarative schema documented by `ficus workflow get`, not prose as a
substitute for executable steps. A source is either `{kind: "preset", id: ...}`
(with optional typed customizations) or `{kind: "inline", definition: ...}`.
Agent types, participant IDs, models, sessions, steps, human gates, outcomes,
returns, limits, and delivery policy belong in the definition. One participant
can perform several steps. Separate participant IDs give independent sessions
even when they use the same agent type/model.

Choose delivery separately from the participant sequence. `completion.mode` keeps
`pr-merge`, `pr-auto-merge`, and `direct-merge`; it also supports `deliverable`
and `review-approval`. Solo Coding, Reviewed Coding, and Planned Coding default to `pr-merge`; their
sources can use a `set-completion` customization without duplicating the steps.
Preserve the full squad workflow source, including `set-completion` customizations;
explicit user or flow delivery choices override the default. Inherit the squad
source by omitting a source at creation, or pass the full agreed source; selecting
only a preset ID does not carry the squad's customizations.
`pr-auto-merge` still requires the squad's explicit `allowAutoMerge` policy;
`direct-merge` requires `allowDirectMerge`. Selecting a mode does not grant that
authority. Do not enable those policies without the user's authorization.
For non-PR results, prefer `deliverable`; use `review-approval` when a human
must approve final delivery.

Preview each source before saving it. Prefer single-quoted inline JSON for short
payloads and a quoted heredoc with `--stdin` for longer JSON/YAML, without a
temporary file:

```bash
ficus workflow resolve --squad <squad-id> --content '{"kind":"preset","id":"solo"}'
ficus workflow resolve --squad <squad-id> --stdin <<'FICUS_FLOW'
kind: preset
id: solo
FICUS_FLOW
```

For a new reusable preset, provide a JSON/YAML envelope with `id`, `description`,
`scope: {kind: squad, squadId: <squad-id>}`, and `definition`. Use an ID prefixed
with the squad's short ID to avoid collisions. Publish with `ficus workflow create
--content '<JSON preset>'` or `ficus workflow create --stdin` and a quoted heredoc.
Files remain optional for saved/reusable definitions (`ficus workflow create preset.yaml`).

Squad managers publish only inside their own squad scope. They do not need
instance-wide catalog privileges. Private user presets remain private; copy
only content the user has authorized to share. Never put secret values in a
preset. Saving a preset does not run it. If publication is not authorized,
keep the agreed flow inline in this squad's setup instead of broadening roles.

Set the default and the selection guidance with `ficus squad set-meta`. For
example, after agreeing to this arrangement (substitute actual IDs):

```bash
ficus squad set-meta <squad-id> workflow '{"kind":"preset","id":"solo"}'
ficus squad set-meta <squad-id> workflowSetup '{"guidance":"Use solo for routine work. Use independent review for customer-facing changes. Ask before relaxing a requested review.","choices":[{"when":"Customer-facing changes","source":{"kind":"preset","id":"builder-reviewer"}}],"completedAt":"2026-09-06T00:00:00.000Z"}'
```

Use the actual completion time. `when` and `guidance` are manager selection
advice, not an automatic classifier or an authorization grant. The manager
chooses an explicit source at creation; direct/API/scheduled creation uses its
explicit source or the squad default. Configure a schedule's source explicitly
when it should use a different workflow.

Read the squad back and summarize its default, exceptions, and delivery rules.
Existing work streams keep their snapshots. No participant agents, sessions,
work streams, or sample jobs should be created just to configure or validate
these choices.

## Use and revisit the setup

For each new request, consult the recorded guidance and select the suitable
source with `ficus workstream create --workflow <id>` or `--flow-content '<JSON source>'`;
use `--flow-stdin` and a quoted heredoc for longer JSON/YAML. Schedule create/update
uses the same `--workflow`, `--flow-content`, and `--flow-stdin` selection.
Do not also supply legacy `--agents`, assignee, model, or completion options.
The runtime creates only participants needed by active steps; queued
streams, future steps, and branch starts waiting for concurrency create none. Reuse the within-stream session on
returns unless the chosen policy calls for a fresh attempt.

For unusual work, propose or directly use an authorized ad hoc inline flow.
It is durable for that stream without polluting the catalog. Save it later
only if it is useful as a reusable preset. Users can revisit this conversation
or edit the squad's workflow settings whenever their needs change.

## Revise live outcomes without resetting context

Record scope changes in the work stream description first. Inspect the current
version and attempt with `ficus workstream flow ID`, then use the versioned
`advance` command with `action: revise`, customization `operations`, `reason`, and
`active: keep` for live outcome changes. This requires flow-management permission;
limited adaptive workers can still revise permitted future work, not live outcomes.

Keep refreshes only outcome transitions for affected kept running attempts,
including other active branches of a changed step. The initial instructions,
output, participant snapshot, attempt ID, and conversation stay unchanged. Future
attempts use the full revised definition. Inspect the response's `outcomeUpdates`
for affected attempt/agent IDs, version, and routes (`activeOutcomes` in inspection).
Steer all affected active agents after recording scope; do not create new workers
or assume revised instructions replace their original brief. Choose a truthful
outcome rather than fabricating approval as a waiver. Gates, waits, returns,
joins, limits, and delivery authorization still apply.

Use `active: restart` only when you deliberately want to cancel the selected
attempt and start a new attempt with a fresh session, even with session reuse.
It invalidates the old attempt token and retires its attempt-scoped waits. It is
not necessary merely to add an outcome. Completed/canceled history is not rewritten.

## Pause without changing the process

When asked to hold work briefly, use `ficus workstream pause <id> --reason "..."`.
This interrupts current executions and suppresses automatic continuations; it is
not just advice in a message. It keeps the admission slot by default. If requested,
use `--park-after <minutes>` or park an already paused stream to release capacity.
Parking does not resume it. Only explicit `ficus workstream resume <id>` clears the
pause, and parked work still needs admission. Do not create substitute streams,
wake paused participants, or schedule messages to bypass the hold.

## Explain waits and pause when choosing a flow

Blocking questions and manual requests from flow agents default to their own active attempt. Other branches continue, and the join waits. Use `waitScope: stream` for a shared question blocker or `ficus workstream request-input ID --scope stream -m "Reason"` for a shared manual blocker. A response provides input without approving the step. Use a human-approval step for an enforced decision.

Whole-stream pause interrupts work until explicit resume; park separately to release capacity.

See `docs/wiki/workflows.md` for the reference. Flow `subscriptions` and squad `integrationTriggers` are supported. Graph integration connections visualize those definitions; do not invent additional graph attachment fields outside the accepted schema.

## Route with a decision step

Pick each step's kind by what it needs:

- **Agent step**: the work, or any judgment that needs tools, investigation, or a written result.
- **Human approval**: a person must sign off before work moves on.
- **Decision step** (`kind: decision`): a quick routing judgment a decision model can make from
  the work's text or the previous steps' results, such as "a bug or a feature request?", "risky or
  safe to ship?", or "which track?". It answers in about a second for a fraction of a cent, but it
  cannot investigate, use tools, or produce anything.

A decision step has `instructions`, `input` (any of `title`, `description`, `handoff`,
`incoming-results`; default: title, description and incoming results), typed `questions`, ordered
`routes` (first match wins), `otherwise`, `unavailable`, and `outcomes`. It has no participant or
output, and it cannot be a `returnTo` target.

```yaml
- id: triage
  kind: decision
  instructions: Decide whether the change can ship without a human review.
  input: [title, description, incoming-results]
  questions:
    ready: { type: yesno, instructions: The change is complete and its tests pass. }
    risk:
      type: score
      instructions: How risky is the change to production?
      levels: [{ label: Low }, { label: Medium }, { label: High }]
  routes:
    - when: { type: score, question: risk, op: at-least, level: High }
      outcome: review
    - when: { type: yesno, question: ready, op: at-least, probability: 0.8 }
      outcome: ship
  otherwise: review
  unavailable: review
  outcomes:
    ship: { next: finish }
    review: { next: human-review }
```

- Questions are `yesno`, `choice` (2 to 64 `options`), or `score` (2 to 10 `levels`, lowest
  first); ask 1 to 64. Question and option names use lowercase letters, digits, and underscores
  (`is_bug`), unlike step IDs and outcomes, which use hyphens.
- A route's `when` reads one answer: a yes/no probability `at-least`/`at-most` a threshold, a
  choice that `equals` an option (optionally with `minConfidence`), or a score level
  `at-least`/`at-most` a level. `question` may be left out only when the step asks one question.
- Where a wrong guess matters, send `otherwise` and `unavailable` to a human approval, or omit them
  so a reviewer chooses instead of the step guessing.
- Decision steps need a decision model for **Workflow decisions** (Settings → Decision Providers).
  Without one they take `unavailable`, or wait for a reviewer. Saving or creating a flow with
  decision steps and no such model returns a `warnings` entry saying so; tell the user.

## Integration events

For linked PR and issue updates, enable **Code hosting** in the workflow editor
(`completion.followChanges: true`) and bind the stream's `metadata.codeHost` with
`integration`, `repository`, and `changeRequest: {number}` (plus optional
`connectionId`) for the primary delivery PR. The provider adapter supplies
subscriptions to the delivery owner and verifies merge evidence. GitHub is
supported today; other providers need adapters before use. Existing
`metadata.github` remains compatible for that primary PR binding. To follow a
GitHub issue (or an additional pull request), use `ficus workstream track` — do
not hand-write `github.repo`/`github.issue`, which is never read; Code hosting
then includes issue comments, edits, and assignment changes alongside any
linked PR events. Add `--delivery` when tracking a PR that must also be merged
before completion. The three shipped coding workflows enable this option. Use
explicit subscriptions for additional outputs or different consumers; do not
duplicate the generated subscriptions or use their reserved `code-host-` ID
prefix.

Ask which external events should create new work versus update existing work. Use `ficus integration outputs` to inspect accepted output names, versions, and data fields. Add flow `subscriptions` for updates to existing work, selecting local participants/steps, active attempts, or delivery-owner. Match explicit typed event fields against stream metadata; missing bindings do not match. Choose retain or manager handling for an inactive consumer. Notifications do not approve gates or clear questions.

Optional squad metadata `integrationTriggers` can create a saved or inline flow from a matched output (for example issue.assigned or pull_request.review_requested). Use explicit repository and assignee/reviewer matches, and map resource identities into stream metadata atomically. Repeated events reuse the trigger/resource receipt. Do not create a mandatory reviewer or wake unused participants. Explain that flows with GitHub subscriptions own their GitHub notifications, so include all outputs the user wants. See docs/wiki/workflows.md for complete examples.

For GitHub without webhooks, PR metadata and subscription bindings establish
polling watches automatically. Issue-assignment triggers need an exact repository
match, or explicit repositories in the squad's existing `metadata.github` when
matching only an assignee. The initial poll baselines old assignments. Do not
promise historical replay or wildcard repository discovery. Polling uses authorized
GitHub integration connections: `source.connectionId` selects an attached account
for a subscription or trigger, and `codeHost.connectionId` (or legacy `github.connectionId`) selects one for work-stream
metadata; otherwise the squad default applies. See
`docs/wiki/workflows.md` for current polling coverage and credential behavior.
