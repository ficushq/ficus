<!-- Generated from apps/docs/src/content/docs/reference/workflow-definition.mdx; edit that page, then run: bun apps/docs/scripts/skill-references.ts -->

# Build a workflow

Technical reference for workflow definitions, participant settings, handoffs, parallel reviews, limits, approvals, and integration events.

Use this reference when building a flow in the visual editor, writing YAML or JSON, or asking an agent to configure a process. For choosing a starting preset, see [Choose a workflow](https://docs.ficus.sh/use/workflows/).

A **definition** describes the process. A **preset** gives a reusable definition an ID and visibility scope. A work stream resolves its selected source into a snapshot; editing the preset does not change existing work. A squad selects a default and alternatives, while its workspace, permissions, and integrations remain separate.

## Start with a complete example

This preset uses two participants with the same `general` agent type: one writes a brief and another reviews it independently. Review feedback returns to the writer, then comes back to the reviewer.

Pass this envelope to `ficus workflow create --stdin` with a quoted heredoc (shown below), or use `--content` for short JSON/YAML. You may also save it as `brief-review.yaml` and use `ficus workflow create brief-review.yaml` for reuse. In the visual editor's complete-definition field, use only the contents beneath `definition`.

```bash
ficus workflow create --stdin <<'FICUS_PRESET'
id: brief-review
description: Produce a concise brief with an independent evidence review.
scope: { kind: instance }
definition:
  schemaVersion: 1
  name: Brief with review
  participants:
    writer:
      agentTypeId: general
      session: reuse-within-stream
    reviewer:
      agentTypeId: general
      session: reuse-within-stream
  entry: draft
  routing:
    mode: guided
    returnTo: declared-only
    delegation: disabled
  limits:
    maxDelegations: 0
    onLimit: request-owner-input
  steps:
    - id: draft
      kind: agent
      participant: writer
      instructions: Write the requested brief. Cite sources and distinguish evidence from assumptions.
      output: A concise brief with citations and unresolved questions.

      outcomes:
        ready: { next: review }
    - id: review
      kind: agent
      participant: reviewer
      instructions: Check the brief against the request and sources. Approve it or give specific corrections.
      output: An evidence-backed verdict and any required corrections.

      outcomes:
        approved: { next: finish }
        changes-requested: { returnTo: draft, afterRework: follow-graph }
  completion:
    mode: deliverable
FICUS_PRESET
```

Attempts are unlimited by default. An optional `maxStepAttempts: 3` permits the initial attempt and up to two further attempts **per step**. It is not three revisions after the first attempt. Workers start only when their steps become active; saving this preset starts no agents.

## Definition fields

| Field           | Meaning                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `schemaVersion` | Must be `1`.                                                                                          |
| `name`          | Display name, 1–200 characters.                                                                       |
| `participants`  | Map of local participant IDs to agent configurations, at most 64 entries.                             |
| `entry`         | ID of the first step.                                                                                 |
| `steps`         | 1–128 step definitions. Handoffs determine execution order; array order alone does not connect steps. |
| `routing`       | Allowed returns, delegation, and adaptive changes.                                                    |
| `limits`        | Attempt, delegation, and concurrent-attempt bounds.                                                   |
| `completion`    | Delivery policy, separate from the last step's outcome.                                               |
| `subscriptions` | Optional integration-event consumers, at most 32.                                                     |

Objects reject unknown fields. Local participant, step, outcome, and preset IDs are 1–100 characters, begin with a lowercase letter, and contain lowercase letters, digits, or hyphens. `finish`, `constructor`, and `prototype` are reserved. `finish` is allowed as a terminal `next` destination, not as a step ID. Agent-type IDs reference existing agent types and do not use this local-ID restriction.

## Participants: who performs the work

Each participant has these fields:

| Field         | Values and behavior                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentTypeId` | Required existing agent-type ID. The agent type supplies agent instructions and configuration. Inspect available agent types rather than inventing an ID.                         |
| `tier`        | Optional enabled model-tier slug, such as `deep` or `exhaustive`. Overrides the agent type’s model settings for this participant.                                                 |
| `session`     | Required: `reuse-within-stream` or `fresh-per-attempt`. Reuse retains the participant's session for compatible subsequent attempts; fresh creates a new session for each attempt. |

A participant is a named role in this flow. It directly selects an agent type and owns its model tier override and session policy; there is no separate profile to configure. Agent steps reference the participant ID.

A participant can keep `agentTypeId: engineer` while selecting `tier: deep` or `tier: exhaustive`. The editor lists enabled tiers configured on the instance. With no tier override, the agent type’s model settings apply. The workflow saves the tier choice and resolves its current model chain when each execution starts. Tier edits affect queued work and the next execution of a reused participant, while an execution already running keeps its resolved chain. Missing or disabled selected tiers block execution instead of silently falling back.

Two participant IDs can use the same agent type without becoming the same agent. Conversely, multiple sequential steps can use one participant when continuity is useful. Concurrent branches receive separate sessions even when they name the same participant. A restart or participant configuration change can also require a new session.

An agent-type reference does not grant extra permissions or integration access. The squad and caller must have the required access. See [agent configuration](https://docs.ficus.sh/configure/agents/) and [models and credentials](https://docs.ficus.sh/configure/models/).

## Steps: instructions, results, and decisions

Agent and human-approval steps have these fields (a decision step has no `output`):

| Field          | Meaning                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Unique local step ID. Update all references when renaming it.                                                                 |
| `name`         | Optional display name, 1–200 characters. Cards use this label; connections still use `id`. Omit it to display the ID.         |
| `kind`         | `agent` (default when omitted), `human-approval`, or `decision`.                                                              |
| `instructions` | What to do and how to judge the result; nonempty, up to 64,000 characters.                                                    |
| `output`       | Expected deliverable or evidence; nonempty, up to 64,000 characters. This is guidance, not a machine-validated output schema. |
| `outcomes`     | 1–16 named outcomes, each with exactly one transition shape described below.                                                  |

The graph defines which work runs. There is no per-step required flag: to make a check mandatory, connect all successful paths through it. Finish waits for active branches and direct-return requests, then enforces the completion policy.

An **agent** step also requires `participant`. Use distinct participants for writer and reviewer when you want separate agents, even if they use the same agent type. There is no extra independence flag.

A **human-approval** step needs `id`, `kind: human-approval`, `instructions`, `output`, and `outcomes`. Its optional `approver` selects who can approve it:

- `assigned-reviewers` (default): any one user assigned in the work stream’s **Assigned reviewers** field who also has review permission for this squad. With nobody assigned, any human with review permission can decide. Assigning reviewers on an existing work stream requires `workstreams:update`.
- `reviewers`: any human with `workstreams:review` permission for this squad, whether or not they are assigned. Admin and Operator roles include this permission; custom roles can grant it without allowing squad settings changes.

For example, insert this step before `finish`, and route the preceding step to `approval`:

```yaml
id: approval
kind: human-approval
approver: assigned-reviewers
instructions: Check that the brief answers your question and authorize delivery.
output: Your decision and its rationale.

outcomes:
  approved: { next: finish }
  revise: { returnTo: draft, afterRework: follow-graph }
```

The review shows the handoff of the attempt being reviewed. When that attempt attached files with `--attach` (see below), the review adds a tab for each file after **Handoff**: Markdown reads as a document, text and code as highlighted blocks, PDFs page by page, and PNG, JPEG, GIF and WebP images inline. Other files (HTML, SVG, PDFs that are damaged or password-protected, and anything over 1 MB of text) offer a download instead. A step that is sent back and run again shows only the files its new attempt attached.

The shipped **Engineering with design approval** preset (`engineering-design-approval`) places a `reviewers` gate between the architect's `design` step and implementation: `approved` continues to `implement`, and `changes-requested` returns to `design`. Use it, or start from it with `ficus workflow get engineering-design-approval`, when work must have its design approved first.

A human gate waits for its designated decision. An ordinary question answer or generic unblock is not approval. You can place several gates at different points, independently of the final delivery policy.

## Handoffs and rework

Each outcome uses exactly one of these shapes:

| Shape                                                        | Behavior                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ next: step-id }`                                          | Continue to that step.                                                                                                                                     |
| `{ next: finish }`                                           | End this path; active work, joins, direct-return requests, waits, and completion checks still apply.                                                       |
| `{ returnTo: earlier-step, afterRework: follow-graph-step }` | Revise the target step, then follow its normal outgoing arrows. Use `return-to-requester` to send the result directly back to the requesting step instead. |
| `{ parallel: [security, qa], join: consolidate }`            | Start distinct branches and wait for them at their shared join.                                                                                            |

Outcome names such as `approved` are chosen by the author; they are not built-in verdicts with hidden semantics. Agents submit an outcome and evidence. Ficus enforces the configured transition, not the truth of a free-text verdict.

`returnTo` identifies the step doing the corrections. `afterRework` defaults to `follow-graph`, which follows that step’s ordinary forward connections after revisions. With `return-to-requester`, completing the correction returns directly to the requesting step, even if its normal outcome would branch, run another review, or finish. For example, `review.changes-requested: { returnTo: create-assets, afterRework: return-to-requester }` revises assets and brings them directly back to Review. The source step determines the requester; there is no separate resume destination.

Use return transitions for revision loops. Normal forward edges cannot form cycles. Returns preserve prior review history; Ficus does not invalidate every downstream review automatically. Instructions should tell reviewers which changes need another assessment.

During rework, an agent can complete with `resume: true` to return directly to the open obligation's destination. Without it, the declared forward path runs, and the open return must still be satisfied before leaving that path. Inspect the current run to understand which return is open.

## Parallel branches and joins

A fork accepts 2–16 distinct branch entry IDs. Ficus derives the first shared forward destination from their connections and stores it as `join`; authors can omit this field. The shared step runs once after **all active branches from that fork** arrive. The editor displays this on the destination card instead of inserting a separate join card. Separate tracks synchronize at `finish` if they share no earlier step. Alternative outcomes are considered when finding a shared destination; return edges do not introduce new branches. Use separate step IDs to keep executions independent.

For example, replace a build step's successful outcome with:

```yaml
ready:
  parallel: [security, qa]
  join: consolidate
```

Define both `security` and `qa` to continue to `consolidate`, and give `consolidate` its own outcomes. Their instructions can request returns to the builder when fixes are needed. Separate agent sessions share the work stream's workspace: specify who may edit which files and how reviewers coordinate changes.

`maxParallelAttempts` is an optional advanced override. Leave it unset for no workflow-specific concurrency limit. When set, it queues additional starts when the flow reaches its bound. Instance and squad capacity can also limit execution. Queued starts do not create workers early.

## Routing policy

| Field        | Values                               |
| ------------ | ------------------------------------ |
| `mode`       | `guided`, `flexible`, or `adaptive`. |
| `returnTo`   | `declared-only` or `earlier-steps`.  |
| `delegation` | `disabled` or `allowed`.             |

**Guided** allows declared paths only and requires `returnTo: declared-only` and `delegation: disabled`.

Workers receive the allowed handoffs and remaining delegation budget in each step assignment. “Earlier” means a predecessor in the declared graph, regardless of the order of steps in the definition. Delegation creates a tracked specialist participant whose result returns to the requesting step.

**Flexible** permits the additional behavior you enable: `earlier-steps` allows a return to an earlier step with the current step as requester; `allowed` permits bounded, tracked specialist delegation. It does not let agents jump arbitrarily between forward steps.

**Adaptive** also lets an active participant propose a runtime revision through the flow command interface. Without management permission, it must preserve active work, existing steps and their agent types/instructions, delivery mode, and delegation policy, and cannot raise limits. More extensive changes require `workstreams:revise-flow`. Adaptive does not grant unrestricted configuration or publishing access.

Delegation inserts tracked specialist work with a return to the requesting step. It is separate from declaring another participant or parallel branch in the original definition. If enabled, `maxDelegations` must be positive.

## Limits

| Field                 | Allowed values and meaning                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxStepAttempts`     | Optional integer 1–100; omitted means unlimited attempts. When set, attempts allowed for each step in the current execution pass. Rework consumes attempts too. |
| `maxDelegations`      | Required integer 0–100: maximum tracked delegations. Use `0` when disabled.                                                                                     |
| `maxParallelAttempts` | Optional integer 1–32: concurrently active attempts in this flow. Omitted means no workflow cap; global agent capacity still applies.                           |
| `onLimit`             | Must be `request-owner-input`.                                                                                                                                  |

Exhausting a step's attempt budget stops further progression for owner intervention. A delegation beyond its limit is rejected and requires an authorized revision. Neither limit automatically declares success. A managed reopen starts a new bounded pass while retaining history.

## Completion policy

Reaching the end of the graph makes a satisfied flow `completion-ready`. `ficus workstream finish` separately checks delivery conditions.

| `completion.mode` | Delivery condition                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `deliverable`     | Required work and returns are satisfied and blocking waits resolved; no intrinsic PR or additional reviewer.                    |
| `review-approval` | A human explicitly approves final delivery through flow finish.                                                                 |
| `pr-merge`        | The change request has been merged; Ficus independently verifies it. This policy does not authorize the agent to merge it.      |
| `pr-auto-merge`   | The current squad must explicitly allow automatic merge. The agent can enable it, but delivery still requires a verified merge. |
| `direct-merge`    | The squad must explicitly allow direct merge; Ficus verifies the recorded commit is contained in the remote base branch.        |

**Code hosting** (`completion.followChanges: true`) subscribes to linked PR and issue updates through the stream's code-hosting adapter, including PR comments, reviews, CI, and merges, plus issue comments, edits, and assignment changes. Issues and additional pull requests are tracked with `ficus workstream track <ws-id> --url <issue-or-pr-url>`, or recorded at creation from an integration notification with `ficus workstream create … --from-event <event-id>`; legacy `github.repo`/`github.pr.number` metadata is still recognized for the primary delivery PR, but a stale `github.repo`/`github.issue` pair is converted automatically at startup into a tracked issue entry and is never read afterward. Add `--delivery` when tracking a pull request that must also be merged before completion, alongside the primary `codeHost.changeRequest` PR — see [Delivery pull requests](#delivery-pull-requests) below. Code-host events come in two classes. **Change events** (CI results, pushes and other PR updates, review requests, reviews, and PR or issue comments and edits) go to the step that fixes things: set `completion.changeEventsTo: { step: implement }` to send them to an existing agent step, or omit it or use `delivery-owner` for automatic delivery ownership. **Delivery events** (a pull request merged or closed) always go to the delivery owner, the agent that finishes the stream (at `completion-ready`, the last completed agent attempt, such as the approving reviewer), whatever `changeEventsTo` says. Each code-host adapter declares which of its events are delivery events. The built-in Reviewed Coding, Engineering, and Engineering with design approval workflows set `changeEventsTo: { step: implement }`, so a CI failure after approval reaches the engineer for tracked implementation rework; when the engineer completes the fix, the flow follows its graph back to review, and the reviewer re-checks it and finishes delivery. `changeEventsTo` also chooses which attempt completion-ready rework reopens. It is optional and does not itself grant repository access or authorize delivery.

For inferred CI completion events, an inactive configured step or participant falls back to the existing running agent attempts for an observational check-in. This works in either direction: review after implementation, or implementation before review. A running configured consumer takes priority; at `completion-ready`, the configured completed consumer still receives CI. Explicit subscriptions keep their literal routing and inactivity policy. Observations do not start a future step, reopen a completed attempt, clear waits, cancel a reviewer, or grant edit/approval authority. Fixes still use the flow's declared return/rework path. A CI success is one workflow run, not all required checks passing: verify the exact current PR head and remaining checks. Unaccepted CI delivery can follow a transition to the current consumer without replaying an accepted delivery. Pauses, waits, dependencies, admission, connection/trust and supersession checks still apply. Otherwise events are retained while the recipient cannot receive them.

### Delivery pull requests

A work stream has one primary delivery PR (`codeHost.changeRequest`) and may designate additional **delivery pull requests** — tracked pull requests flagged `delivery: true` (issues cannot be flagged). For `pr-merge`/`pr-auto-merge`, `ficus workstream finish` verifies the primary change request is merged (its head/branch identity is what completion records), then independently verifies every flagged delivery PR is merged too; an unmerged one fails finish with `409 Delivery pull request <repo>#<n> must be merged before completion`. `direct-merge` does not consider delivery pull requests.

Observed merge/close/reopen events for a delivery PR (`pull_request.merged`, `pull_request.closed`, or `pull_request.updated` with a reopened action) are recorded under the stream's row lock in `metadata.delivery.pullRequests[<key>]` as `{ state: "open" | "merged" | "closed", at, headSha?, eventId? }`, with a newer `occurredAt` always superseding an older one; finish re-verifies live and overwrites this with the verified result. `GET /api/workstreams/:id/tracked` reports this as `delivery: { pullRequests: [{ key, repository, number, url?, primary, state, at?, headSha? }], complete }`, where `complete` requires at least one delivery pull request and all of them merged. Delivery pull request subscriptions (the primary PR's and any flagged tracked PR's) may pass the delivery-approval wait once the flow reaches `completion-ready`; other tracked resources' subscriptions never do.

GitHub is the implemented adapter today. The serialized `pr-merge` and `pr-auto-merge` names describe provider-neutral change-request verification, so future adapters do not require copies of your flow. Bind the resource in **work-stream metadata**, not the workflow definition:

```json
{
  "codeHost": {
    "integration": "github",
    "repository": "acme/project",
    "changeRequest": { "number": 42 }
  },
  "git": { "branch": "feature", "baseBranch": "main" }
}
```

An optional `codeHost.connectionId` selects an authorized account; omission uses the squad default. Direct merge also needs the full `git.commit` SHA. See [GitHub setup](https://docs.ficus.sh/connect/github/).

## Integration subscriptions

Subscriptions consume events for **existing work**. Use `ficus integration outputs` to inspect the installed output catalog and its typed fields. Integration IDs, output names, and versions must exist; a made-up event name cannot be saved successfully.

```yaml
subscriptions:
  - id: pr-feedback
    source:
      integration: github
      output: pull_request.reviewed
      version: 1
    match:
      repository: { streamMetadata: github.repo }
      pullRequest.number: { streamMetadata: github.pr.number }
    deliver:
      to: { participant: reviewer }
      whenInactive: retain
```

| Field                                                   | Meaning                                                                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                    | Unique subscription ID, 1–100 characters; lowercase start, then lowercase letters, digits, `_`, `.`, or `-`. The `code-host-` prefix is reserved when `followChanges` is enabled. |
| `source.integration`, `source.output`, `source.version` | Exact versioned output from the catalog.                                                                                                                                          |
| `source.connectionId`                                   | Optional authorized integration account UUID; otherwise use the squad default.                                                                                                    |
| `match`                                                 | 1–16 equality conditions. Every field must match, with the catalog's declared type and normalization.                                                                             |
| `deliver.to`                                            | `{ participant: id }`, `{ step: id }` for an agent step, `active`, or `delivery-owner`.                                                                                           |
| `deliver.whenInactive`                                  | `retain` (default) queues for the intended consumer; `manager` routes to the squad manager when that consumer is inactive.                                                        |

A match binds an event field either to `{ streamMetadata: path }` or to a literal `{ value: ... }`. Literals can be strings, numbers, or booleans. A PR number must be a number, not a numeric string. Data paths use dot-separated object fields, not array indexes or wildcard expressions.

Missing metadata leaves a subscription unbound. Adding a binding does not replay historical events. Events do not create future workers merely to deliver a notification. Pauses retain events; updates do not resolve waits or approve steps.

**Squad triggers** are separate configuration for creating new work from an event. Put `integrationTriggers` in squad metadata, with `id`, `source`, literal `match` conditions, and `create` containing `workflow`, optional `titlePrefix`, and `metadata` mappings from event fields:

```yaml
integrationTriggers:
  - id: assigned-issues
    source: { integration: github, output: issue.assigned, version: 1 }
    match:
      repository: { value: acme/project }
      assignee: { value: ficus-bot }
    create:
      workflow: { kind: preset, id: solo }
      titlePrefix: 'Investigate: '
      metadata:
        github.repo: { event: repository }
```

When the triggering event names an issue or pull request, Ficus records it in
`metadata.tracked[0]` for connection-authority events (all GitHub events) with a
server-stamped `origin` automatically; an instance-authority event has no squad
connection to pin on the entry, so it records none. Do not map
`github.issue`/`github.pr.number` into `create.metadata` for that — it is
never read for tracked-resource identity. `github.repo` above still gives the
new stream a resolvable repository identity. Triggers deduplicate work for their resource. They do not grant access to a repository. The resulting style can subscribe to later updates. Trigger metadata mappings accept up to 16 entries and cannot write reserved `completion`, `sources`, or `sourceWarnings` roots.

## Questions, waits, and pauses

These are runtime controls, not extra definition fields. A blocking question from a flow agent normally waits on its current attempt. For example, security can wait for a threat-model answer while QA continues; the join remains held until security finishes. Use a whole-stream wait for a shared blocker.

Answers provide input, not approval. Relevant open waits prevent advancement and automatic continuance for the waiting attempt. Pause requests cancellation of active execution and requires explicit resume; parking separately releases the stream's capacity slot. See [Review and intervene](https://docs.ficus.sh/use/review-and-intervene/) for operating controls.

## Presets, sources, and customizations

A preset file wraps a definition with:

| Field         | Meaning                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | Stable preset ID.                                                                                                                                   |
| `description` | Optional catalog description, at most 4,000 characters.                                                                                             |
| `scope`       | Optional visibility: `{ kind: instance }`, `{ kind: squad, squadId: UUID }`, or `{ kind: user, userId: UUID }`. Access is still permission-checked. |
| `definition`  | Complete definition described above.                                                                                                                |

A **source** chooses what a new stream should resolve. It is not the same file shape as a preset:

```yaml
kind: preset
id: brief-review
# Optional: pin the revision you inspected to detect a changed preset.
# revision: REVISION_FROM_GET
customizations:
  - op: set-name
    name: Brief for the board
  - op: set-limits
    limits:
      maxStepAttempts: 2
      maxDelegations: 0
      onLimit: request-owner-input
```

For a one-off flow, use `kind: inline` and `definition` containing the complete definition. It is stored with the stream without adding a catalog entry.

Preset sources accept up to 512 ordered customizations. The whole resulting definition is validated after applying them:

| `op`                 | Other fields                                   |
| -------------------- | ---------------------------------------------- |
| `set-name`           | `name`                                         |
| `set-entry`          | `entry`                                        |
| `put-participant`    | `id`, complete `participant`                   |
| `remove-participant` | `id`                                           |
| `put-step`           | Complete `step`; inserts or replaces by its ID |
| `remove-step`        | `id`                                           |
| `set-step-order`     | `ids` containing every step exactly once       |
| `set-routing`        | Complete `routing`                             |
| `set-limits`         | Complete `limits`                              |
| `set-completion`     | Complete `completion`                          |
| `set-subscriptions`  | Complete `subscriptions` array                 |

Removing an entry does not automatically repair references. A disabled preset cannot be resolved for new work. Existing stream snapshots are preserved.

## Structured CLI input

Choose **one** explicit source. Prefer single-quoted `--content` JSON for short
payloads and a quoted heredoc or pipe for longer JSON/YAML. YAML is a shell
string, not a native shell object; quote it rather than letting the shell expand
it. Do not create a temporary file just to pass a payload.

| Commands                                                           | Inline                         | Stdin          | Optional saved file              |
| ------------------------------------------------------------------ | ------------------------------ | -------------- | -------------------------------- |
| `workflow create`, `workflow update ID`, `workflow resolve`        | `--content '<JSON/YAML>'`      | `--stdin`      | positional file or `--file FILE` |
| `workstream advance ID`                                            | `--content '<JSON/YAML>'`      | `--stdin`      | `--file FILE`                    |
| `workstream create TITLE`, `schedule create`, `schedule update ID` | `--flow-content '<JSON/YAML>'` | `--flow-stdin` | `--flow FILE`                    |

Creation/scheduling also accept `--workflow ID` instead of a structured source;
omitting all workflow selectors preserves inheritance (or leaves an update's
workflow unchanged). `resolve` accepts a source envelope; workstream/schedule
inputs additionally accept a raw definition. Create/update presets use an envelope
with `id` and `definition`, not a source. Update still requires the inspected
`--revision`; advance still requires the inspected version/attempt and unchanged
retry `--request-id`. `--json` only controls output.

```bash
ficus workflow resolve --squad SQUAD_ID --content '{"kind":"preset","id":"solo"}'
ficus workflow resolve --squad SQUAD_ID --stdin <<'FICUS_FLOW'
kind: preset
id: solo
customizations:
  - op: set-name
    name: Daily audit
FICUS_FLOW

printf '%s\n' '{"kind":"preset","id":"solo"}' | ficus schedule update SCHEDULE_ID --flow-stdin
```

All sources are bounded to 1 MiB of UTF-8 and must contain one JSON/YAML object.
Empty input, conflicting/repeated sources, duplicate or non-string mapping keys,
unsupported tags/fields, malformed documents, cyclic aliases, and excessive
nesting/alias expansion fail locally without sending an API request. Parsing is
bounded to 100 levels, 100,000 expanded values, and an alias expansion factor of 100. Diagnostics omit source values. `--stdin`/`--flow-stdin` require a pipe or
redirection and reject interactive terminals rather than waiting for typing.
File arguments are always filenames, including `-`; stdin is never selected
implicitly. Saved files remain useful for reusable or large authored definitions
within the same bounds.

## Agent authoring workflow

1. Inspect `ficus workflow list`, then `ficus workflow get PRESET_ID` or `export` to start from a known definition. Inspect agent types and `ficus integration outputs` before selecting agent types or events.
2. Identify the deliverable, participants, approval authority, rework destinations, and budget. Use the smallest process that meets those requirements. Discuss uncertain choices before publishing.
3. Author a preset for reusable configuration or a source for one-off work. Prefer `--content '<JSON>'` for short payloads and `--stdin` with a quoted heredoc for longer JSON/YAML instead of creating temporary files. Validate with `ficus workflow resolve --content '<JSON source>' --squad SQUAD_ID` (or `--stdin`). This checks resolution in the target squad without creating a stream or workers.
4. Publish only when requested: `ficus workflow create --content '<JSON preset>'`, or `ficus workflow update PRESET_ID --content '<JSON preset>' --revision REVISION_FROM_GET`; both also accept `--stdin`. A revision conflict requires re-reading and reconciling changes.
5. Create requested work with `ficus workstream create "Title" --squad SQUAD_ID --workflow PRESET_ID`, or `--flow-content '<JSON source>'` / `--flow-stdin` for an inline/customized source.

Catalog access uses `workflows:read`, `workflows:create`, `workflows:update`, and `workflows:delete` permissions with scope checks. Runtime flow management uses `workstreams:revise-flow`; normal active participants submit their own allowed outcomes.

While executing, inspect `ficus workstream flow STREAM_ID`. Advance using the current `expectedVersion`, your current `attemptId`, an allowed action, and evidence. For example:

```bash
ficus workstream advance STREAM_ID --stdin --request-id REQUEST_UUID <<'FICUS_COMMAND'
{
  "expectedVersion": 1,
  "attemptId": 1,
  "action": "complete",
  "outcome": "ready",
  "evidence": "Brief written; each factual claim has a source."
}
FICUS_COMMAND
```

For an agent-produced completion or authorized explicit return whose effective route enters a `human-approval` step, add a structured `decisionBrief` alongside the independent `evidence` (complete) or `feedback` (return) string. Explicit return path authorization and `resumeAt` semantics are unchanged; attachment upload is available on complete and amend. Return/resume destinations, immediate parallel gates, human join arrivals and queued starts count. These string fields use normal readable prose and preserve exact literal identifiers:

| Field                    | Maximum characters | Content                                                                                                                |
| ------------------------ | -----------------: | ---------------------------------------------------------------------------------------------------------------------- |
| `decision`               |                500 | The person's choice, in one or two history-independent sentences.                                                      |
| `recommendation`         |              1,000 | What the agent recommends and why.                                                                                     |
| `approvalEffect`         |              2,400 | What approval permits, exact resource IDs and what remains forbidden.                                                  |
| `risks`                  |              1,600 | Main risks and tradeoffs.                                                                                              |
| `changesSinceLastReview` |              2,000 | Earlier decision, why work returned or stopped, and what changed. Required after an earlier decision on the same gate. |

Empty fields, unknown keys, invalid types, excessive length and compressed prose are rejected before the transition is written. CLI preflight runs before attachment uploads. Gate instructions describe the kind of gate, not that round's scope; the completing producer writes the brief and managers do not rewrite instructions each round. Human-to-human and automatic decision routing have no new authoring requirement: the next human gate displays an eligible same-stream producing-lineage brief read-only, clearly labeled as carried forward, or says **No decision brief for this gate** with its own message. Older agent-origin gates without a brief keep their legacy display. No existing gate is backfilled or rewritten. Restarting a human gate starts a fresh boundary, so inherited sources cannot donate a prior session brief; it shows the no-brief notice with the new gate message. A restarted agent can still supply its own new brief for a later gate.

The review screen opens the **Decision brief** tab first, with attachments in neighboring peer tabs. Only the internal agent handoff is collapsed beneath the brief, under **Internal handoff**. Legacy reviews retain their handoff-first layout. Web and Farm show carried-source attribution or the explicit missing-brief notice, including human-waiting decision steps; no new non-agent authoring requirement is introduced. A gate blocked by stream-wide or same-attempt waits remains readable as **Review queued** with disabled decision controls and blocking messages, but is not an actionable Feed review. Sibling waits do not block an otherwise actionable gate. Clearing blockers restores actionability without a gate rewrite; approval never bypasses permissions or holds.

To hand off files a reviewer should read (a design doc, a report, a screenshot), add `--attach PATH` once per file when completing a step: `ficus workstream advance STREAM_ID --stdin --attach docs/design.md <<'FICUS_COMMAND'`. Each file is uploaded to your attempt before the command is sent, and nothing is advanced if an upload fails. An attempt can attach at most 10 files of up to 10 MB each, and they count toward the instance's attachment storage limit. Attached files are kept for as long as the work stream exists, including after it is done or canceled, and are removed when it is deleted. Keep `evidence` a short summary that names the attached files.

While the human approval gate your completed attempt feeds is open, the reviewer may chat with you from the review screen. To refine your result for them, commit the change on the stream's branch, refresh `ficus workstream flow`, and send `action: amend` with the current `expectedVersion`, your `attemptId`, the complete revised `decisionBrief` and `evidence` naming the commit SHAs, optional `removeAttachmentPaths`, and `--attach` for files to add or replace. It records a new revision of the same attempt; the gate stays open and it is not a new review round. Recommend Changes requested for anything bigger, such as a new approach, a security change or a material change of scope.

The numbers above are examples; always use the current run's values. For short commands you can also use single-quoted JSON with `--content`. Saved command files remain supported via `--file`. Reuse the request ID only when retrying that exact command. Parallel branches can change the run version; re-read on conflict and proceed only if your attempt remains current. Do not advance by changing the legacy assignee or status directly.

In the editor conversation, the assistant's tools are deliberately narrower: read the current draft and apply targeted edits based on its revision. The `edit` tool accepts an atomic `operations` array for adding or updating participants and steps, changing connections, and setting flow options. It preserves everything not mentioned. A full `documentJson` replacement is available for complete redesigns; supply exactly one edit format. The assistant can also call `edit` with `historyAction: "undo"` or `"redo"`, using the same undo history as the preview buttons. `read.history` reports whether each action is available. It can brainstorm freely, but it cannot publish or start work. Valid edits apply automatically in the page and can be undone. Save explicitly to publish the preset. Use the interactive graph for direct edits. **Participants** and **Settings** in its header toggle their panels; selecting a card or arrow opens its inspector. **Make separate** copies a participant’s settings for one step without changing other steps. This is different from authorizing an operator agent to publish through the CLI.

## Validate before using a flow

Run `ficus workflow schema` to list the step kinds, and `ficus workflow schema human-approval` (or another kind) for that kind's required and optional fields with their allowed values. The command is generated from the same schema the CLI validates with. When a step is invalid, the error names its kind and the field to fix, for example `definition.steps[1]: human-approval step: output is required`; an unknown kind lists the valid kinds.

Check that every step is reachable from `entry` and has a path to `finish`; all participant, step, and subscription targets exist; forward edges have no cycles; rework targets differ from their requesters; parallel branches are distinct and converge correctly; and every successful path includes any mandatory checks. Schema validation catches structural errors, but clear instructions and an appropriate review process still need human judgment.

For implementation details, contributors can read the repository's [workflow runtime notes](https://github.com/ficushq/ficus/blob/main/docs/wiki/workflows.md) and the canonical [definition schema](https://github.com/ficushq/ficus/blob/main/packages/shared/src/workflows.ts). This page is the public authoring reference; use the schema matching your deployed version when building tooling.

## Upgrading older definitions

Rename each participant’s `profile` field to `agentTypeId` in custom YAML or API payloads. Ficus migrates saved styles, squad defaults, scheduled work, editor drafts, and running flows automatically. Pinned agent settings and existing revision references are preserved.

### Targeted editor edits

The editor assistant uses `read`, `edit`, and (with Realtime) `delegate`. After `read`, send the returned revision as `baseRevision` and a short `summary` with `edit`. For example:

```json
{
  "baseRevision": 3,
  "summary": "Ask the writer to include sources",
  "operations": [
    {
      "op": "update-step",
      "id": "write",
      "changes": { "instructions": "Write the report and cite every factual claim." }
    }
  ]
}
```

Use `put-participant` (`id`, `participant`) and `put-step` (`step`) to add or replace those objects. Use `update-step` (`id`, `changes`) to preserve unmentioned step fields. Step IDs and kinds are changed by replacement, not by `update-step`. Use `set-outcome` (`id`, `outcome`, `transition`) to add or change a connection, and `remove-outcome` (`id`, `outcome`) to disconnect it. A transition can use `next`, `parallel` and `join`, or `returnTo` and `afterRework`.

Other operations are `remove-step`, `remove-participant`, `set-name`, `set-entry`, `set-step-order`, `set-routing`, `set-limits`, `set-completion`, and `set-subscriptions`. Set operations replace the named value. Related changes belong in one batch: for example, add a reviewer participant, add its step, and redirect the preceding step's outcome together. Deleting a step also requires fixing connections that reference it. Ficus validates the complete resulting flow before applying anything; an invalid or stale batch changes nothing. Each successful batch is one undoable edit.
