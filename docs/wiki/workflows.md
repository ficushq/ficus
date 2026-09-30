# Workflows, flows, and squads

For user and agent authoring instructions, complete YAML examples, and the field reference, see [Build a workflow](../../apps/docs/src/content/docs/reference/workflow-definition.mdx) in the public documentation. This wiki page covers runtime behavior and repository integration.

GitHub account setup, account selection, and credential lifecycle are described in [GitHub integrations](github-integrations.md).

A squad defines a purpose, shared workspace, permissions, integrations, and optional persistent members. A workflow defines how one work stream gets done. The Engineering squad preset is a domain preset; it does not require architect, engineer, and reviewer agents. You can use Solo for a small change, Planned Coding for a larger change, and a custom research or editorial process in the same squad.

## Choose a starting point

Use the squad manager conversation and the `setup-workflows` skill to describe recurring work, cost preferences, approval needs, and delivery expectations. The manager can configure a default and alternatives without creating workers. Squad settings also expose these choices. Manage reusable definitions in **Administration → Workflows**, with search, previews, and an edit modal. Squad settings select workflows and usage guidance; they do not edit the shared definitions. New squads created through the UI start with **Solo** unless their selected squad preset specifies a default (Engineering selects **Solo Coding**). Solo uses one general-purpose worker without delegation. Every new stream resolves its explicit source, then the saved squad default, and finally Solo. Squad presets are copied once at creation. The upgrade snapshots defaults for older squads so they no longer inherit live preset changes. Invalid or disabled defaults produce a setup error, not an unstyled stream. Existing streams retain their flow or manual assignment behavior.

```sh
ficus workflow list
ficus workflow get solo
ficus workstream create "Investigate the issue" --squad SQUAD_ID --workflow solo
ficus workstream create "Build the feature" --squad SQUAD_ID --workflow engineering
```

A squad's `metadata.workflow` is its default source for new streams. `metadata.workflowSetup` contains human-readable selection guidance and alternatives. The manager uses that guidance; it is not an automatic classifier. Existing legacy streams are not retroactively converted.

## Visual and conversational editing

Open **Administration → Workflows**, then create, edit, or duplicate a workflow. Describe the flow you want or the changes you need in the conversation. The interactive graph is the main editor, with the assistant alongside it. Manual changes, selection, and preset details are included in the next assistant message. Both editors share Undo/Redo history. The graph represents steps, with the participant shown inside each agent step. Drag step cards to arrange the canvas; drag an outcome handle to a destination card to rewire it, or click both handles. Select a node or connection to open its inspector. The inspector shows only that selection; **Flow settings** opens workflow configuration. Selecting an arrow highlights it, and **Delete** or **Backspace** removes that connection rather than its source step. A selected parallel branch can be removed independently of its siblings. Warnings float inside the canvas. Card positions and zoom stay unchanged through deletion; **Auto arrange** explicitly resets the layout. Canvas positions are local to the editor; connections are saved in the definition. Add an agent step or human approval, connect an outcome by selecting its destination on the graph, and configure branches, return paths, participant settings, session reuse, prompts, and results in the inspector. Flow settings contain limits, completion policy, and integration-event subscriptions. The complete JSON definition remains available for advanced editing.

The assistant is the main editing surface. Brainstorm before making changes, describe a whole process, or ask about the selected step. Realtime supports typed messages and voice. Connection failures retry in the same conversation and offer Reconnect; they do not switch to a different assistant or enable the microphone. When Realtime is disabled, the user assistant handles text. The first delegated request starts that assistant; merely opening the editor does not start workers or a manager. The backend assistant has access only to the conversation's draft tools.

Valid assistant edits apply directly to the draft — there is no separate Apply step. The graph's own **Undo**/**Redo** buttons cover both assistant and manual changes, sharing one history; the assistant can also undo or redo through the same tool call (`edit` with `historyAction`), which uses that exact history rather than rewriting an earlier document. Edits based on an earlier revision cannot overwrite a newer edit. A pending edit must be acknowledged by the page before another is accepted, so voice and fallback text use the same revision boundaries. Save validates and publishes the preset separately. Running work streams retain their original snapshots.

## Presets and ad hoc flows

A saved preset has an ID, visibility scope, revision, and definition. Scopes are instance, squad, or private user. Presets participate in configuration synchronization and explicit overrides. Editing a preset does not rewrite a running stream: creation resolves a durable snapshot of the definition and participant settings.

An inline source contains `{ kind: inline, definition: ... }`. It is durable within its stream but does not add a catalog preset. Managers can author one for a single job, inspect it with `ficus workflow resolve --content '<JSON source>' --squad SQUAD_ID`, then use `ficus workstream create "Title" --squad SQUAD_ID --flow-content '<JSON source>'`. For longer JSON/YAML, prefer `--stdin` on resolve and `--flow-stdin` on create with quoted heredocs; no temporary file is required. Saved presets can also be customized at creation. The web and mobile interfaces support selecting presets and supplying inline definitions; web includes structured editing and a graph preview.

```sh
ficus workflow create --content '<JSON preset>'
ficus workflow update PRESET_ID --content '<JSON preset>' --revision REVISION_FROM_GET
ficus workflow export PRESET_ID
ficus workflow template-diff PRESET_ID
ficus workflow revert PRESET_ID --revision REVISION_FROM_GET
ficus workflow disable PRESET_ID --revision REVISION_FROM_GET
```

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

## Participants, steps, and handoffs

The Inspector, Participants, and Settings header toggles open their respective panels; clicking the active toggle closes it. Selecting a card or arrow switches to its inspector. Participants lists usage counts and the affected steps. Make separate copies shared agent configuration for one step without changing other assignments. Step display names are independent of their stable connection IDs; the inspector keeps ID editing under Advanced. A step’s Agent work / Human approval switch chooses whether an agent acts or a person approves. Agent steps select a participant; human approvals select an approver. The default is **Assigned reviewers** (`assigned-reviewers`): a human with `workstreams:review` in the squad who is listed in the work stream’s `assignedReviewerIds`. If nobody is assigned, any reviewer is allowed. **Any reviewer** (`reviewers`) allows anyone with that review permission, regardless of assignment. Any one assigned reviewer can decide. Work-stream editors can assign eligible users before or during an approval; an empty assignment allows any human with review permission. Assigning reviewers requires `workstreams:update`; reviewing alone does not permit self-assignment. Squad settings permissions do not authorize workflow reviews. Instructions, expected results, and outcomes belong to each step. Agent type, model tier override, and session policy belong to the participant; its editor lists every step affected by a change. Participants name the agent roles needed by the process. Agent participants choose an agent type, optional model tier overrides, and session reuse policy. Two participants can use the same agent type. With reuse enabled, sequential steps on the same track reuse the participant’s session and context. Parallel branches have separate sessions; after a join, work continues in the main track’s session with the branch results handed back. Fresh-per-attempt starts a new session each time a step runs, including revisions. Both policies receive the same activation handoff with step instructions, expected output, up to eight recent recorded results/feedback entries, and open return requests. Reuse additionally retains that session’s conversation history. Workers are created only when their steps become active, including when a parallel branch receives capacity. Saving a preset, configuring a squad, waiting in the queue, and future steps create no workers.

A participant can keep `agentTypeId: engineer` while selecting `tier: deep` or `tier: exhaustive`. The editor lists enabled tiers configured on the instance. With no tier override, the agent type’s model settings apply. The workflow saves the tier choice and resolves its current model chain when each execution starts. Tier edits affect queued work and the next execution of a reused participant, while an execution already running keeps its resolved chain. Missing or disabled selected tiers block execution instead of silently falling back.

Steps define instructions, expected output, outcomes, and whether they are required. Outcomes can move to another step, fork parallel branches, or reach delivery. Routing policies govern explicit returns and tracked delegation. Agents advance using the current run version and attempt ID; stale commands fail rather than silently advancing a different attempt.

A return records feedback and where work must resume. Earlier reviews remain in history; Ficus does not automatically invalidate every downstream check. Request re-review explicitly when the changes need it. Parallel branches have independent attempts and sessions, but share the stream workspace, so agents must coordinate file ownership. Convergence is inferred from forward connections: the first shared destination waits for its active branches and runs once. Its card shows a small wait indicator; there is no separate join card. A second output connection creates parallel branches, while removing all but one restores an ordinary handoff. Tracks with no shared step run separately until Delivery. Internally `join` stores the inferred boundary for durable execution. A concurrency limit queues branch starts without creating their agents early.

```sh
ficus workstream flow STREAM_ID
ficus workstream advance STREAM_ID --content '{"expectedVersion":1,"attemptId":1,"action":"complete","outcome":"completed","evidence":"Tests passed"}' --request-id REQUEST_UUID
```

Commands can complete, return, delegate, request completion-ready rework, or revise according to the flow and caller's permission. Retrying the same command uses the same request ID. Do not use legacy assignee/status edits to bypass a flow.

### Keep outcomes live; restart only for fresh context

An authorized manager can use `action: revise`, customization `operations`, `reason`, and `active: keep` to add, change, or remove outcomes on running work without resetting its conversation. Each affected kept running attempt, including parallel branches sharing the changed step, receives the revised outcome map. Completion at the new `expectedVersion` uses those routes; removed outcomes and old versions fail. Limited adaptive workers may revise permitted future work, but changing live outcomes requires flow-management permission.

Keep preserves the attempt ID, **initial instructions and expected output**, all other step fields, participant/agent snapshots, session binding, branch, incoming evidence, returns, and waits. Revised instructions and participant settings apply to future attempts, not the old brief. Existing human gates, joins, return destinations, limits, and delivery requirements still apply; outcome changes do not approve a gate, clear a blocker, or authorize merge/deploy.

Flow inspection exposes `activeOutcomes` (attempt ID, agent ID, binding version, routes) separately from the original `state.attempts[].step` snapshot. An affected attempt records `effectiveOutcomes: {version, outcomes}`; revision history records `affectedAttemptIds` and the immutable Core acceptance receipt `outcomeUpdates` alongside the definition, version, and reason. The receipt freezes agent identities at acceptance, including `agentId: null` for an unbound queued attempt; later admission changes live inspection, not the historical receipt. Completed/canceled snapshots are never retroactively changed. The revision response's `outcomeUpdates` identifies affected running attempts and agents and remains stable on request-ID retries, even after later revisions. Record scope in the stream description first, then steer every affected active agent with the new version/outcomes. Do not automatically dispatch new workers or fabricate approval to fit an old outcome.

Use `active: restart` only when a fresh context is intended: it cancels the selected attempt, creates a new snapshot/attempt, and starts a **fresh session even for reuse-within-stream**. Old attempt tokens fail, and superseded attempt-scoped waits are retired. Other kept branches retain their sessions (and receive any affected outcome changes). Restart behavior and explicit session policies are unchanged.

## Questions and scoped waits

An ordinary agent question is nonblocking. With `blocking: true`, a question from a flow execution opens a wait on that exact attempt by default. An agent's manual `request-input` similarly targets its current attempt. A security reviewer waiting for a threat-model answer does not prevent QA from continuing, but the join remains held until security finishes.

A relevant open wait prevents advancement and automatic continuance nudges for that attempt. It does not forcibly interrupt the agent's current execution; the agent is instructed to end its turn and await input. Incoming answers can still be delivered. Integration notifications are retained behind unrelated waits and retried after resolution. At completion-ready, final delivery review allows code-host CI/review feedback through; the delivery participant can request [tracked rework](cli/workstream-commands.md#rework-after-delivery-becomes-ready) before making corrections. Answering resumes the same current attempt and is not step approval. Replacing an attempt retires its scoped waits; late answers remain in history and must not wake a replacement session.

Use a whole-stream wait for shared blockers. The async question tool accepts `waitScope: stream`; a manual request accepts `--scope stream`. Human/operator manual requests default to whole-stream unless an attempt is selected explicitly.

```sh
ficus workstream request-input STREAM_ID -m "Confirm the threat model" --scope attempt --attempt ATTEMPT_ID
ficus workstream request-input STREAM_ID -m "Wait for the release freeze to end" --scope stream
ficus workstream unblock STREAM_ID --wait WAIT_ID -m "Use the published threat model"
```

Resolve questions through their question-answer interface. Dependency waits remain whole-stream and are system-resolved. Human-approval flow steps own their decision waits: use the flow's decision controls, not generic unblock. In the web app these controls sit at the top of the work stream detail, with the step's instructions, the handoff being reviewed, and the pull request. Each outcome shows where it sends the work. Final delivery approval offers **Approve and complete** and **Send back**, which requests tracked rework with your feedback. An open human-approval gate shows the stream as **In Review**, not Blocked. In parallel flows a human gate holds its branch while unrelated branches continue.

Automatic parking applies only when the whole stream is blocked: either a whole-stream wait exists or all active attempts are waiting. The full grace period starts when the last runnable branch becomes blocked. A single waiting branch does not park its runnable siblings.

## Pause, park, and resume

Pause means stop current work and wait for explicit resume. Ficus requests cancellation of current executions, cancels queued work, and prevents assigned flow agents from receiving automatic continuance. Cancellation must settle before resumed work can start; an external side effect already completed is not undone. Inbox messages remain durable while paused.

Pause retains the admission slot unless the stream is parked. Park releases capacity; it is separate from the pause flag. A paused parked stream cannot start merely because capacity becomes available. Optional pause auto-parking releases the slot after the configured delay without resuming work.

```sh
ficus workstream pause STREAM_ID --reason "Hold while I check the result"
ficus workstream resume STREAM_ID
```

## Delivery policy

Settling all active graph paths and direct-return requests puts the flow at `completion-ready`. Unchosen paths do not block Finish; there is no per-step required flag. Delivery is a separate condition, enforced by `ficus workstream finish STREAM_ID --version VERSION_FROM_RUN`.

| Mode              | Delivery condition                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `deliverable`     | Required work/returns are satisfied and blocking waits are resolved; no intrinsic PR or extra reviewer.                         |
| `review-approval` | A human approves delivery through flow finish.                                                                                  |
| `pr-merge`        | The human merges the PR; Ficus independently verifies it is merged.                                                             |
| `pr-auto-merge`   | The agent may enable GitHub auto-merge only when the current squad explicitly allows it; Ficus still verifies the PR is merged. |
| `direct-merge`    | Explicit squad permission allows direct merge; Ficus checks the recorded commit is included in the remote base branch.          |

These modes preserve the earlier PR policies. `pr-merge` does not mean auto-merge. Denied direct merge requires an authorized policy/flow change; it does not silently bypass the configured policy. Shared instructions explain delivery to every flow participant; completion does not belong intrinsically to a reviewer agent type.

Record repository and PR/commit metadata on the stream for verification and external event matching. Flows can choose their integration consumers with subscriptions; legacy streams keep their previous recipient fallback.

## Integration updates and new-work triggers

Use `ficus integration outputs` to list the versioned output catalog. Subscriptions belong to a workflow definition and work equally in saved presets and inline flows. For example, a solo flow can receive PR feedback in its existing worker:

```yaml
subscriptions:
  - id: pr-feedback
    source: { integration: github, output: pull_request.reviewed, version: 1 }
    match:
      repository: { streamMetadata: github.repo }
      pullRequest.number: { streamMetadata: github.pr.number }
    deliver:
      to: { participant: worker }
      whenInactive: retain
```

All match fields must match with the declared type. Bind `github.repo` to a repository string and `github.pr.number` to a number. Missing metadata leaves the subscription unbound. Setting a binding later does not replay old events. A subscription may alternatively target `{ step: security }`, `active` for all active consumers, or `delivery-owner`. The coding presets use `completion.followChanges: true` to derive delivery-owner subscriptions from their code hosting adapter. Explicit subscriptions remain available for other consumers and custom events.

An inactive consumer retains events until its step starts. No new agent is created just because an update arrives. Pausing retains updates without waking workers. Replies and notifications can inform a waiting agent, but they do not clear waits or approve steps. When the required work is ready for delivery, the chosen completed participant can still receive CI/merge events.

A **squad trigger** handles the case where no work stream exists yet. Put `integrationTriggers` in squad metadata to select a workflow for an incoming event. This example starts the Solo preset when an issue in a specific repository is assigned to a particular GitHub account:

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

When the triggering event names an issue or pull request, Ficus records it
in `metadata.tracked[0]` for connection-authority events (all GitHub events)
with a server-stamped `origin` automatically; an instance-authority event has
no squad connection to pin on the entry, so it records none. Do not
map `github.issue`/`github.pr.number` into `create.metadata` to attach it; that
key is never read for tracked-resource identity. `github.repo` above is still
useful to give the new stream a resolvable repository identity for later
correlation. This is optional squad policy, not a requirement of its squad preset. A manager can configure a saved preset or an inline flow using the normal squad metadata/configuration tools. Change the trigger source to `pull_request.review_requested`, match `requestedReviewer`, and map `github.pr.number` from `pullRequest.number` to start a configured PR-review flow instead.

The trigger binds metadata atomically and reuses an existing matching nonterminal stream. Repeated events create at most one stream per trigger/resource. A receipt remains even after completion/deletion; starting another stream for the same resource is an explicit action. The selected flow can also declare subscriptions for later updates—for example `issue.updated` and `issue.comment`, matched on `repository` and `issue.number`, sent to its `worker`.

Flow graphs show integrations with dotted connections. Select an integration to see its match rules, consumer, pending deliveries, and event links. Edit subscriptions in the complete YAML/JSON definition or ask the manager to configure them. A flow with GitHub subscriptions owns its GitHub notifications; omitted outputs are not sent through the old reviewer fallback. Integration event subscriptions documents the runtime, compatibility boundary, and current limits.

## Reference

- [Work-stream CLI commands](cli/workstream-commands.md)
- [Squad CLI commands](cli/squad-commands.md)
- Workflow runtime design
- Historical completion-policy design

### GitHub polling without webhooks

Attaching a PR to stream metadata automatically establishes a polling watch: use the
delivery PR (`codeHost.changeRequest`, or legacy `github.repo`/`github.pr.number`), a
tracked PR (`ficus workstream track --pr`/`--event`/`--url`), a PR URL, or custom paths
referenced by a GitHub subscription's repository and PR-number bindings. Tracked
issues get a repository-scoped issue-events poll instead of a per-resource watch.
Watches track current nonterminal streams and disappear when their bindings are
removed or the streams end.

Issue-assignment triggers can discover work before a stream exists. Specify an exact repository in the trigger's match, as above. If a trigger only matches an assignee, exact repositories in the squad's existing `metadata.github` configuration provide its polling scope. Ficus does not expand wildcard repository patterns or scan every repository accessible to the token. The first poll establishes a baseline; subsequent assignments are routed to the chosen workflow. Active watches normally poll every 1–2 minutes, subject to the shared budget and provider failures. A large event backlog may require several bounded page scans.

Polling uses the squad's authorized GitHub integration connection. Set `github.connectionId` on work-stream metadata or `source.connectionId` on a subscription/trigger to select an attached account; otherwise Ficus resolves the squad default. Resource metadata establishes polling interest, not repository authorization. See [GitHub integration accounts](github-integrations.md) for connection setup and migration from retired token secrets. Issue comments still require webhooks. Polling notifications remain subject to the same pause, current-attempt, and deduplication rules as webhooks.

## Built-in workflow collection and squad-preset recommendations

The built-in collection contains Solo (`solo`), With Review (`builder-reviewer`), Solo Coding (`solo-coding`), Reviewed Coding (`reviewed-coding`), Planned Coding (`engineering`), Research Brief (`research-brief`), Security Review (`security-review`), Code Review (`code-review`). IDs of earlier presets remain stable. See the [user guide](../../apps/docs/src/content/docs/use/workflows.mdx) for intended uses.

A squad preset's optional `workflows` field selects existing instance-scoped presets or inline definitions:

```yaml
workflows:
  default: { kind: preset, id: solo-coding }
  guidance: Prefer a single engineer for routine changes; request review when the risk warrants it.
  choices:
    - when: A change needs independent review.
      source: { kind: preset, id: reviewed-coding }
    - when: Architectural decisions need an explicit design step.
      source: { kind: preset, id: engineering }
```

Creation copies the default into `metadata.workflow` and guidance/choices into `metadata.workflowSetup`. Explicit creation values win. Existing squads are not rewritten on type sync; existing streams retain their resolved snapshots. References are validated and must not cross scope boundaries. The squad-preset editor exposes these recommendations; Workflows remains the definition editor. Neither a recommendation nor a flow participant creates a persistent squad member.

The Engineering squad preset includes all five engineering choices and defaults to Solo Coding. Built-in workflows disable additional delegation to keep their advertised staffing predictable; a custom flow can enable tracked delegation. Security Review and Release Validation deliver reports, while the three coding workflows default to `pr-merge`. Completion policies remain independently customizable; there are no separate copies for auto-merge or direct merge.

## Code-hosting adapters

The provider-neutral delivery contract and registry live in `apps/core/src/services/integrations/code-hosting/`. GitHub implements that contract in `integrations/github/code-hosting.ts`. It supplies merge evidence, remote commit containment, and provider output subscriptions. Credentials continue to resolve through the squad's authorized integration connections. GitLab and Bitbucket adapters are not implemented yet.

New work streams use this resource binding:

```json
{
  "codeHost": {
    "integration": "github",
    "repository": "acme/project",
    "changeRequest": { "number": 42, "url": "https://github.com/acme/project/pull/42" }
  },
  "git": { "branch": "feature", "baseBranch": "main" }
}
```

`codeHost.changeRequest` does not need to be written by hand when the delivery PR is opened from the stream's `git.branch`: the first code-host event that reports that pull request binds it (see [Delivery pull requests](work-streams.md#delivery-pull-requests)), and finish resolves it from the branch as a fallback. An optional `codeHost.connectionId` selects an authorized account; omission uses the squad default. Existing `github.repo`, `github.pr`, and `github.connectionId` are compatibility inputs for the delivery PR binding. A stale `github.repo`/`github.issue` pair (the old way of following one issue) is converted automatically at startup into a `tracked` issue entry and is never read afterward — use `tracked`/`ficus workstream track` going forward. An explicit invalid or unsupported `codeHost` binding fails closed rather than falling back to a different provider or account.

**Code hosting** (`completion.followChanges: true`) derives subscriptions for every resource in the work stream's canonical tracked set targeting `delivery-owner` by default: the primary delivery PR (`codeHost.changeRequest`) and every entry in `metadata.tracked[]`, including any pull request flagged `delivery: true` (see [Work streams](work-streams.md#tracked-issues-and-pull-requests)). This includes PR comments, reviews, CI, and merges, plus issue comments, edits, and assignment changes, for as many issues and PRs as the stream tracks. Attach resources with `ficus workstream track` (or `workstream create --from-event`) rather than hand-writing metadata; legacy `github.repo`/`github.pr.number` is still recognized for the delivery PR only. Set `completion.changeEventsTo: { step: engineer }` to route the entire bundle to a specific agent step instead. This does not change explicit subscriptions for custom events. The effective subscriptions are used by matching, durable delivery validation, polling discovery, and hosted relay interests. Resource/account changes invalidate queued deliveries. The `code-host-` and `tracked-` subscription ID prefixes are reserved when this option is enabled; there is no `code-host-issue-` prefix. No binding means no automatic subscription; adding one manually does not replay historical events, while the automatic binding of a pull request opened from the stream's branch also routes that pull request's earlier events. Existing definitions without this option keep their explicit subscriptions. Only the primary delivery PR's merge/completion evidence sets the delivered head for `pr-merge`/`pr-auto-merge`, though every flagged delivery PR must also be verified merged before finish succeeds; activity on any other tracked resource, including an issue closing, never finishes the stream, clears a wait, or bypasses admission and pauses.

`pr-merge` and `pr-auto-merge` retain their serialized names but verify normalized change-request evidence through the selected adapter. `direct-merge` verifies the full `git.commit` SHA is contained in `git.baseBranch`. GitHub-specific link displays and activity rendering can remain provider-specific; the flow engine does not choose credentials or call GitHub directly.

### Assigning reviewers

In a work stream, use **Assigned reviewers** to choose eligible people. Each person needs `workstreams:review` for the squad. Any one assigned reviewer can decide. With no one assigned, the filter allows any user with review permission.

```bash
ficus workstream reviewers --squad <squad-id>
ficus workstream update <stream-id> --reviewer <user-id> --reviewer <another-user-id>
ficus workstream update <stream-id> --clear-reviewers
```

`--reviewer` replaces the list on update and can also be passed to `workstream create`. Assignment requires `workstreams:update` on existing streams. Admin and Operator roles have this permission; custom roles can grant it separately from reviewing.

Editor tool revisions increase after every graph edit, including Undo and Redo. Applied edits return the confirmed revision and history availability, so the assistant can chain edits without an extra read. A queued backend edit must still be acknowledged by the open page. Routine reads contain the current draft and revision; the assistant can request the editing contract, agent types, or integration output catalog with `include`, filtering outputs by `integration` when needed.

## Automatic worktree cleanup

New work streams default to `autoCleanupWorktree: true`. The API accepts only a
boolean; CLI create/update accept `--auto-cleanup-worktree true|false`. The web
stream detail shows the effective setting and cleanup status, with changes
restricted to users who can update the stream. Set false to retain the worktree,
including after delivery while no removal is in flight. No-worktree streams are harmless no-ops.
Historical rows default false; explicit later opt-in does not invent ownership
or missing delivery proof.

Successful committed delivery creates a durable cleanup intent. A separate
startup/periodic worker attempts prompt asynchronous cleanup after associated
executions settle, with bounded retries. This does not delay or undo delivered
`done`. Other registered stream attachments/dependencies block cleanup; unrelated
executions continue. Undeclared cross-stream shell access is outside this
cooperative model: register shared use and do not interfere with cleanup paths.
Metadata-only worktree and source-repository attachments are resolved read-only,
including symlink aliases. Unresolved or concurrently changed identities defer
removal. A new binding during an uncertain/completed cleanup may require the
runtime to be available to prove its identity; otherwise it returns a conflict
without changing the binding. Unchanged retention settings remain editable
without this runtime check.

Only a newly platform-provisioned dedicated worktree qualifies. Metadata-only or
manually created paths are not ownership evidence. Before removal, the platform
revalidates canonical Git identity, authoritative delivered head, live merge
status and remote recoverability (including squash merges).

Only two kinds of data block removal:

- **Uncommitted changes:** modified or staged tracked files, untracked files that
  Git does not ignore, tracked files hidden by `assume-unchanged`/`skip-worktree`
  index flags, and in-progress Git operations (merge, rebase, cherry-pick, revert,
  bisect) or worktree-local refs and reflogs.
- **Unpushed commits that cannot be archived:** any commit reachable from the
  worktree's HEAD reflog, `ORIG_HEAD` or a leftover `REBASE_HEAD` that no surviving
  local branch, tag, remote-tracking or archive ref contains.

Rebased, force-pushed or abandoned history (for example pre-rebase commits of a
squash-merged branch whose remote was deleted) exists only in that reflog, which
removal destroys. Instead of blocking cleanup forever, the runner first archives
the independent tips of that history as shared, content-addressed refs
`refs/ficus-archive/<worktree directory name>/<commit>` in the main repository
(outside `refs/heads`, so branch lists stay clean). All tips are created in one
atomic `git update-ref` transaction, verified, and the reachability check is then
repeated with the archive included; removal proceeds only if it passes. Retries
reuse a matching archive ref and never overwrite a different one. Any write or
verification failure keeps the worktree, as before. The success reason recorded
in `ficus workstream cleanup inspect` names the archive prefix. List archived
commits with `git for-each-ref refs/ficus-archive/`; delete one with
`git update-ref -d <ref>` once it is no longer needed.

Files Git ignores (`node_modules`, `dist`, `*.tsbuildinfo`, `.test-db-port`, caches)
never block cleanup; they are deleted with the worktree. Leftover Git scratch
files (`COMMIT_EDITMSG`, `FETCH_HEAD`, `AUTO_MERGE`) are also discarded. Separate
correctness guards still defer removal: a primary checkout, a changed directory
identity or registration, a locked worktree or Git lock file, a changed delivered
head or branch, and committed submodules.

If the worktree's project-scoped test database is still running (the Compose
project `tau-test-<hash of the worktree path>`, recorded by `.test-db-port`), cleanup
stops it with `docker compose -p <project> down --volumes` right before removal.
Only containers carrying both that project name and this worktree's
`dev.ficus.test-db.repo-root` label are touched. If Docker cannot confirm the
project state, the label belongs to another path, or the teardown fails, cleanup
defers with that reason and retries. Cleanup never deletes branches, remote refs,
caches, other Docker resources, or arbitrary directories.

Deferred jobs retry automatically with capped backoff (at most hourly), so a
worktree that was previously deferred only for ignored files becomes eligible on
its next retry without manual action.

`worktreeCleanup` exposes status, actionable reason, retry timing and operation
ID, without private removal inputs. Exceptional blockers are deduplicated owner
notifications, not approval requests for every cleanup. A durable operation
marker and terminal receipt make retries safe after restarts or lost responses.
Unknown/partial removal keeps the same-worktree reuse fence: a missing directory
alone is **not** proof that a late command cannot arrive. Never reset that fence
or delete its marker to force reuse. Reopening after successful removal is
explicitly blocked; provision a new stream instead. Git and delivery metadata
remain available after reclamation. Reopening before removal invalidates old cleanup
decisions; a fresh delivered transition captures fresh proof and re-arms the intent.
Retention changes also invalidate stale reconciliation snapshots. No reclaimed-byte estimate is reported,
because hardlinked dependencies can make summed sizes misleading.

### Inspecting and recovering mismatched worktrees

`ficus workstream cleanup inspect <id> --json` (GET
`/api/workstreams/:id/worktree-cleanup`, requiring squad `workstreams:read`)
returns the original `owned` creation receipt, `current` Git bindings,
`bindingsMatch`, cleanup status, and a snapshot `recovery` state. It performs
only database reads; it does not start a sandbox. `owned: null` means no
platform-created ownership was recorded. `cleanup: null` only means no cleanup
job exists yet. Work stream JSON stores Git configuration under `metadata.git`,
not a top-level `git` field.

Normal updates reject changes to a platform-owned repository, worktree or branch,
including `set-meta` writes. Unrelated metadata and retention updates still work
for historical mismatches. New work needing another checkout belongs in a new
work stream; the original ownership receipt is never silently transferred.

For a historical duplicate-folder mismatch:

1. Inspect original ownership and current bindings for each affected stream.
2. Run `ficus workstream cleanup retain <id>`. This uses the existing permission-checked
   PATCH with `autoCleanupWorktree: false`. The lifecycle transaction invalidates
   stale cleanup claims, including after delivery. If removal already started, it
   returns a conflict instead; never clear that operation's markers manually.
3. Verify the response and inspect again. `retained` means automation is disabled,
   not that the folders are disposable. Keep automation disabled during manual work.
4. An authorized operator may remove only exact unused paths after fresh checks for
   live users, registered sharing, uncommitted changes, and unpushed
   commits. Retain active/open-PR working trees and branches. Keep any uncertain data.

No ownership or delivery records need to be rewritten to stop automatic cleanup.
Retention itself deletes nothing. It cannot undo successful reclamation or make
an uncertain removal safe. Do not re-enable automatic cleanup for a divergent or
manually removed tree: its original identity and delivered-head checks still apply.
