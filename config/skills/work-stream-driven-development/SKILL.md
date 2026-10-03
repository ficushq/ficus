---
name: work-stream-driven-development
description: Create and supervise code deliverables using saved or ephemeral workflow flows, isolated worktrees, explicit reviews, and verified delivery.
---

# Work-Stream-Driven Development

A work stream owns one deliverable. Its workflow owns the sequence of work,
participants, review gates, returns, joins, limits, and delivery. Agent types
provide expertise. Do not reproduce Architect → Engineer → Reviewer routing in
prompts, inbox messages, or manually assigned agent lists.

## Prepare the work

Read the squad's purpose, context, default `metadata.workflow`, and selection
guidance in `metadata.workflowSetup`. Inspect `ficus workflow list` and relevant
presets with `ficus workflow get`. Choose the smallest suitable process: Solo
Coding, Reviewed Coding, Planned Coding, or an authorized custom flow. An
engineering squad does not require three agents on every task.
Preserve the full squad workflow source, including `set-completion` customizations;
explicit user or flow delivery choices override the default. Omit a source to
inherit it, or pass the full agreed source via --flow-content/--flow-stdin. A bare
--workflow <preset-id> selects that preset without the squad's customizations.

Clarify the goal, current and desired behavior, constraints, acceptance criteria,
and authority for external changes. Put them in a self-contained description;
workers cannot see the conversation that led to it. Use step instructions for
stage-specific objectives. Separate work streams only for independently useful
deliverables or genuine dependencies; parallel checks can join within one flow.

Before repository mutations, create an isolated worktree using the configured
base branch. Use `squad_bash` for repository inspection, git, tests, builds, and
local deployments. Do not reset another checkout or create duplicate worktrees.
Pass `--repository <checkout-path>` to `ficus workstream create` to create or validate
an isolated worktree and detect code-host identity before workers start. Optional
`--branch`, `--worktree`, `--base-branch`, and `--git-remote` override defaults.
Without `--repository`, Git flags only attach existing metadata. Do not create a
second worktree or reattach code-host metadata when setup already supplied it.
Read-only investigations need no branch: state that repository mutations,
commits, and PRs are outside scope. Non-repository tasks need no git ceremony.

```bash
ficus workstream create '<deliverable>' --squad <squad-id> \
  --owner <manager-id> -d '<requirements and source context>' \
  --workflow <preset-id> --repository <checkout-path> \
  --branch <branch> --base-branch <base>
```

For one-off processes use `--flow-content '<JSON source>'` for short input, or
`--flow-stdin` with a quoted heredoc for longer JSON/YAML, containing a source
such as `{kind: inline, definition: ...}`. Validate with `ficus workflow resolve
--content` or `--stdin` first. Files remain optional via `--flow` for saved
definitions; do not create temporary files merely to pass input.
Do not also pass legacy agent lists, assignee, model, or completion flags.
Omit the source to inherit the squad default; it resolves to Solo when no squad default is stored. Squad presets only seed preferences at squad creation. The runtime
spawns only the participants needed by admitted, active steps. No eager crew
creation, manual handoff chains, or manager-maintained scheduling ledgers.

## Execute and return

Use the current handoff assignment and its incoming results. Read
`ficus workstream flow <id>` when earlier evidence or current state is needed;
do not reload the full history before every step. Perform the assigned step with the agent type's full expertise. Submit a declared outcome and evidence
using `ficus workstream advance <id> --content '<JSON>'`, or `--stdin` with a
quoted heredoc for longer JSON/YAML; include the current
`expectedVersion` and `attemptId`. Use permitted returns for rework and tracked
delegation if allowed. After a version conflict, re-read before retrying and
confirm the attempt is still active. Never route by legacy assignee/status edits.

Reports carry paths/links, findings, decisions, checks actually performed, and
unresolved questions. For a review, first check spec compliance, then quality.
For rework, identify the affected requirements and evidence. Re-review those
areas and broaden checks when justified; do not invalidate unrelated reviews.
Parallel branches share a workspace, so coordinate ownership of files before
editing concurrently. A declared join waits for its branches.

Blocking questions and manual waits default to the current attempt. Use explicit
stream scope for shared blockers. A human's answer supplies input, not approval.
Use human-approval steps for decisions that must be enforced. End the turn while
waiting or paused; never schedule continuations to bypass the hold. Limits need
an authorized decision or revision, not another untracked worker.

## Deliver

At completion-ready, follow the runtime's generated delivery instructions and
use `ficus workstream finish <id> --version <version>` when the condition is met.
No agent type owns PR creation by default. A solo engineer may deliver its own
work; a multi-step flow can assign that responsibility elsewhere.

- `deliverable`: finish the requested result with evidence.
- `review-approval`: a human approves delivery through flow finish.
- `pr-merge`: create or reuse the PR; a human merges it.
- `pr-auto-merge`: after required internal workflow validation/review and explicit
  current `allowAutoMerge=true`, enable provider-native auto-merge while external
  CI/PR approval may remain pending. Never bypass protections; wait for actual merge.
- `direct-merge`: requires explicit squad policy and verified inclusion of the
  delivered commit in the remote base branch.

Record generic `metadata.codeHost` bindings for integration events and completion
checks. GitHub is currently supported. Use the squad-assigned integration for
Git and provider commands. If access fails, report the specific failure; do not
bypass the integration with ambient host credentials or change host authentication. Check mergeability after creation, CI,
and review; repair conflicts through the flow and review the affected changes.
Record follow-up work with the owner. Preserve other work and any shared branch;
clean up owned temporary resources only after delivery and dependent use finish.

The primary delivery PR is `codeHost.changeRequest`. A PR opened from the
work stream's branch against its base branch is bound automatically as soon as
the code host reports it; set it by hand only for a PR from a different branch.
When an integration
notification supplies `Event reference: <id>`, create or attach work with
`ficus workstream create ... --from-event <id>` or
`ficus workstream track <ws-id> --event <id>` — never hand-write
`github.*`/`codeHost` metadata to track a resource; `--from-url` links are
reference material only and receive no updates. A stale
`github.repo`/`github.issue` pair is converted automatically at startup into a
`tracked` issue entry and is never read afterward.

`ficus workstream track --pr` adds a followed pull request alongside the
primary delivery PR without changing completion, unless `--pr ... --delivery`
(or `--url ... --delivery`) flags it as an additional delivery pull request:
`ficus workstream finish` then also requires that PR to be independently
verified merged, on top of the primary PR, before `pr-merge`/`pr-auto-merge`
can complete (`409 Delivery pull request <repo>#<n> must be merged before
completion` otherwise). `--delivery` only applies to pull requests. `ficus
workstream tracked <ws-id>` lists everything tracked, which pull requests
count toward delivery, their observed merge state, and whether subscriptions
are active. A tracked issue closing, or any non-delivery resource's activity,
is information, not completion: it never finishes the stream or clears a wait.

### PR auto-merge procedure (any delivery role)

The generated delivery instructions remain authoritative. At completion-ready,
check the selected mode, current squad policy, internal workflow evidence, and
live PR base/head against the validated deliverable. Solo uses self-review;
independent/human gates apply only when declared. Do not wait for external GitHub
CI or PR approval before enabling authorized auto-merge: GitHub enforces those
requirements at merge time.

For GitHub, use the squad-authorized integration and configured merge method:
`gh pr merge <pr-url> --auto --<configured-merge-method> --match-head-commit <validated-head-sha>`.
Replace the method placeholder with an allowed method (e.g. `squash`); never use
`--admin`, approve as a human, or change protections. If permission is missing or
the provider rejects the request, leave the PR for a human merge and tell the owner.

Inspect live provider state after the command: autoMergeRequest can be null after
an immediate merge. A pending request is not delivery; use integration events for
waiting, not polling. New-head failures/conflicts require tracked rework and
review of affected changes. Finish with the current version only after the primary
and every designated secondary delivery PR are verified merged. This procedure
confers no application publication/deployment authority.

Existing non-flow streams have a legacy lifecycle. Do not copy it into new flow
work or silently reinterpret in-flight work. Inspect the stored policy and ask
the owner when its routing or delivery is unclear.

See `docs/wiki/workflows.md` and the user documentation's workflow definition
reference for complete schemas, commands, examples, and integration bindings.

Task descriptions must be self-contained: include the goal, current behavior/problem,
desired behavior, constraints, and important decisions. Workers do not share the
requester's transcript; do not rely on or merely reference prior chat conversations,
"as discussed", or "the conversation above".
