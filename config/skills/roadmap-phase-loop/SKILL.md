---
name: roadmap-phase-loop
description: Plan and deliver a multi-phase initiative through workflow flows, using an initiative branch when partial phases must stay off the main branch.
---

# Roadmap Phase Loop

Use this for an initiative with independently useful phases and ordered dependencies.
A single deliverable with design, implementation, and review usually belongs in one
work stream with several steps. Do not split it merely to assign different roles.

The roadmap describes outcomes and dependencies. The workflow describes how each
phase gets delivered. Choose participants for the task; no phase requires a fixed
architect/engineer/reviewer team or a separate planning agent.

## Plan the initiative

Use brainstorming and writing-plans when needed to establish:

- The desired result, constraints, and acceptance criteria.
- Phase deliverables, dependencies, and exit criteria.
- Cross-phase migrations, compatibility, rollout, and integration checks.
- The intended delivery policy and any explicit human approval boundaries.

Keep the roadmap in a durable document and link it from work stream metadata.
Use work stream state, dependencies, and flow history as the execution record;
do not maintain a competing manual scheduler or duplicate status ledgers.

## Choose dependencies and the branch strategy

For same-repository code phases of one design, prefer `--depends-on <parent-id>:ready`
with platform-owned stacking rather than waiting for a human merge between phases.
The parent must have implemented its work, reached `completion-ready` under
`pr-merge` or `pr-auto-merge`, and have a bound delivery PR (or already be done).
A PR opened during implementation is not enough. Human-only PR merges gate
delivery, not downstream implementation; do not infer an implementation approval
gate from the merge policy. Other waits and declared flow gates still apply.

Use `:done` (also the CLI/API default for a bare ID) for an explicit
wait-before-next-phase user gate, a genuine need for a merged/deployed artifact
or runtime state unavailable on an open branch, or non-PR deliverables where
ready behaves like done. Independent work needs no artificial dependency.
Cross-repository dependencies can unlock work, but do not provide branch stacking;
verify how the required artifact or interface becomes available before choosing
`ready` rather than `done`.

If partial phases must not reach the repository's primary branch, create an
initiative branch from the agreed base. Each phase uses its own worktree and
branch, provisioned from the initiative branch and stacked on its ready parent
when applicable. Its PR targets the initiative branch. Only the final integration
PR targets the original base. Otherwise use the agreed repository base for phase
PRs; stacking changes the child's starting head, not the intended integration target.

Run repository/project commands through `squad_bash` from the dynamically resolved
repository path. If `squad_bash` is unavailable, delegate repository operations to
an agent with that capability. Never assume a fixed workspace path or change
another agent's checkout. Existing `git.worktree` and `git.branch` metadata are
authoritative; do not create a second worktree.

Record the repository, initiative branch, base branch, and base commit in the
roadmap. Do not use a dirty or diverged base without resolving it. Read-only
research phases need no worktree; changes to plan documents in a repository do.

## Deliver a phase

1. Read the roadmap, configured base, and prerequisite state. Verify each required
   input is available under its chosen dependency condition: ready branch/PR work
   may support implementation before merge; a done prerequisite must be delivered.
2. Choose a saved workflow or an ephemeral flow. Use Solo for direct work,
   specialist reviews when useful, and explicit approval steps where required.
   The same worker may plan and implement; use separate participants when an
   independent perspective matters.
3. Write a self-contained stream description with the phase goal, current state,
   decisions, constraints, affected resources, and acceptance criteria. Include
   links to the roadmap, but do not leave essential instructions only in a chat.
4. For repository changes, prepare and verify the phase branch/worktree and
   record `git.branch`, `git.worktree`, and `git.baseBranch`.
5. Create the work with `ficus workstream create` and `--workflow <preset-id>`
   or `--flow-content '<JSON source>'` for short payloads; use `--flow-stdin`
   with a quoted heredoc for longer JSON/YAML. Saved definitions can still use `--flow`.
   Set dependencies explicitly, for example `--depends-on <parent-id>:ready` with
   `--repository <checkout-path> --base-branch <agreed-base>` for a same-repo child
   phase (use the initiative branch as the base when isolating partial phases).
   Record the initiative and phase identifiers in metadata.
6. Let flow outcomes, return paths, and joins route work. Participants start
   lazily when needed. Do not pre-spawn a crew, manually assign phase handoffs,
   or create separate reminder schedules to bypass waits or pauses.
7. At completion-ready, the delivery owner follows the configured policy and
   finishes through `ficus workstream finish`. A passing review does not prove a
   merge. For `pr-merge`, wait for the verified human merge; auto/direct merge
   require their explicit policy authorization and may not bypass protections.

When feedback changes a phase, keep the same stream and use its return paths or
an authorized revision. Preserve relevant evidence and explain what changed so
reviewers can assess the affected areas. Update the shared scope before steering
active participants. Future participants receive it when their steps start.

## Advance and integrate

A dependent phase implements against the actual prerequisite branch/head made
available by its dependency condition, not a stale initiative checkout. Verify the
platform's recorded `git.stackedOn` and assignment instructions; if safe automatic
stacking was not possible, merge the named prerequisite branches into the child's
own branch as instructed, without rewriting another stream's worktree. Keep the
actual parent dependency and configured base tracking; never silently treat an
open PR as merged. Do not clear a dependency by hand just because its PR opens.

When an upstream branch changes after unlock, merge the updated prerequisite work
and revalidate the affected child changes through its flow; unlock is not evidence
that the stack is still current. The parent must be verified merged and done before
the stacked child can deliver; merge the configured base branch into the child and
revalidate before delivery. Do not enable child auto-merge before the parent merges
and the base is merged in. See `docs/wiki/workflows.md`, “Dependencies and stacked
work,” for stacking fallbacks, delivery holds, and cancellation handling.
Independent phases may run in parallel if their flows and workspace ownership
allow it; joins or stream dependencies enforce the needed boundaries.

Record phase results, PRs, and unresolved follow-ups in the roadmap and stream
metadata. Refresh the initiative against its original base as needed, then run
cross-phase verification before final integration. The final delivery follows
its own configured policy and the requester's approval requirements.

If the initiative requires human merges for every phase, select `pr-merge` in
those flows and the final integration flow. This delivery choice does not itself
require serial `:done` implementation dependencies; choose conditions using the
prerequisite criteria above. Preserve all selected human review/merge gates.
