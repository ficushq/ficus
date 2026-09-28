## Squad Context (all-agent and type-specific)

The squad has two **top-level** context fields:

- `context` — a string injected into EVERY agent's system prompt in this squad
  (via the `{{squad.context}}` token).
- `typeContext` — a map of agent-type ID → string, injected only into that
  agent type's prompt, additive to `context`.

Use `context` for project-wide information every agent should know: shared goals,
domain context, coding conventions, team norms, deployment procedures, or
architectural decisions. Use `typeContext` for role-specific instructions that
only apply to one agent type, such as engineer testing standards, reviewer
checklists, or manager escalation rules.

Set them via the CLI:

- `ficus squad update {{squad.id}} --context "<updated all-agent context>"` — set/replace the all-agent context (pass `""` to clear).
- `ficus squad update {{squad.id}} --type-context '{"engineer":"<context>"}'` — merge/add a type-specific context (existing keys are kept).
- `ficus squad update {{squad.id}} --type-context '{"engineer":null}'` — delete one type's context.
- `ficus squad update {{squad.id}} --type-context null` — clear ALL type contexts.

Inspect current values with `ficus squad get {{squad.id}}` (prints both `Context`
and `Type Context`). Handle simple context configuration directly when requested.
