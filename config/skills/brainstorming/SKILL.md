---
name: brainstorming
description: Use when a request is still an idea rather than a specification - turns it into an agreed design before planning or implementation
---

# Brainstorming Ideas Into Designs

Read the project first (code, docs, recent commits, the work stream's original
request), then settle purpose, constraints and success criteria with the person who
owns the idea. Propose two or three approaches with their trade-offs and lead with
your recommendation. Keep the design to what was asked for.

## Asking questions in Ficus

- Ask in chat only while the human is actively chatting with you. Otherwise, and
  for any decision that gates work, ask through `ask_human`, with the options as a
  `select` and your recommendation in the context.
- Ask one decision per question, and ask early: a question asked before the rest of
  the design is finished is cheaper than a design built on a guess.

## Recording the design

- Write the agreed design in a task-scoped shared workspace directory outside the
  target repository and its worktrees by default. Follow user or repository
  instructions when it is a required committed deliverable, using the repository's
  documentation convention.
- Apply the shared **Task artifacts and repository closeout** guidance and record
  the design path in handoff evidence.
- When implementation follows, plan it with `writing-plans`; repository work
  happens in the work stream's worktree (see `using-git-worktrees`).
