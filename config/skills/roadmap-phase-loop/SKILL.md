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

## Choose the branch strategy

If partial phases must not reach the repository's primary branch, create an
initiative branch from the agreed base. Each phase uses its own worktree and
branch, based on the latest delivered initiative branch. Its PR targets the
initiative branch. Only the final integration PR targets the original base.

Run repository/project commands through `squad_bash` from the dynamically resolved
repository path. If `squad_bash` is unavailable, delegate repository operations to
an agent with that capability. Never assume a fixed workspace path or change
another agent's checkout. Existing `git.worktree` and `git.branch` metadata are
authoritative; do not create a second worktree.

Record the repository, initiative branch, base branch, and base commit in the
roadmap. Do not use a dirty or diverged base without resolving it. Read-only
research phases need no worktree; changes to plan documents in a repository do.

## Deliver a phase

1. Read the roadmap and current delivered base. Verify prerequisites have landed.
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
   with a quoted heredoc for longer JSON/YAML. Saved definitions can still use `--flow`. Set dependencies with `--depends-on` and record the
   initiative and phase identifiers in metadata.
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

A dependent phase starts from the actual delivered result of its prerequisites.
Do not plan against a stale initiative checkout or silently treat an open PR as
merged. Independent phases may run in parallel if their flows and workspace
ownership allow it; joins or stream dependencies enforce the needed boundaries.

Record phase results, PRs, and unresolved follow-ups in the roadmap and stream
metadata. Refresh the initiative against its original base as needed, then run
cross-phase verification before final integration. The final delivery follows
its own configured policy and the requester's approval requirements.

If the initiative intentionally requires human merges for every phase, set
`pr-merge` on those styles and the final integration style. That policy is an
explicit choice for this initiative, not an inherent property of any agent type.
