---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

Write the plan for an engineer who knows the language but not this codebase or its
history. Name the files to change, the tests that prove each step, the commands to
run them, and the order. Keep steps small enough to commit one at a time, and leave
out anything the requirements did not ask for.

## Where the plan goes

Save plans to a task-scoped shared workspace directory outside the target
repository and its worktrees by default. Follow user or repository instructions
when the plan is a required repository deliverable (for example a committed
`docs/plans/YYYY-MM-DD-<feature-name>.md`). Apply the shared **Task artifacts and
repository closeout** guidance and include the chosen path in handoff evidence.

## What every plan states

- **Goal and approach:** one sentence on what it builds, two or three on how.
- **Requirements trace:** which original requirement each step serves, so a
  reviewer can check coverage against the request rather than against the plan.
- **Per step:** the files, the failing test to write first, the focused test
  command and its expected result, and the commit.
- **Open questions:** anything the requirements do not settle. Product questions go
  to the owner through `ask_human` before the dependent steps start.
- **Splitting:** when the work spans several deliverables or must land in a fixed
  order, see `roadmap-phase-loop` for dependent work streams and stacking.
