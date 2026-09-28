# Ficus Squad System Overview

The Ficus Squad System provides a way to organize agents into teams (squads) and manage their work through work streams. This enables coordinated multi-agent workflows where agents can collaborate, hand off work, and request human input when needed.

See [Workflows, flows, and squads](../workflows.md) for the current flexible flow model. The quick start uses an explicit workflow; manual assignment is a separate legacy path for streams without a flow.

## Core Concepts

### Squads

A **squad** is a team of agents that work together. Squads have:

- **Name**: Human-readable identifier for the team
- **Purpose**: Mission statement describing what the squad does
- **Type**: Domain template; Engineering provides identity without mandatory worker roles
- **Workflows**: Default and alternative per-stream processes, from Solo to custom specialist flows
- **Default Agents**: Agents that are always part of the squad (typically `persist=true`)
- **Flex Agents**: Agents spawned for specific work streams (typically `persist=false`)
- **Status**: `active`, `paused`, or `archived`

### Work Streams

A **work stream** is a unit of work that can be assigned to an agent. Work streams:

- Belong to a squad
- Can be associated with a task
- Can have dependencies on other work streams
- Track status through their lifecycle
- Support blocking for human input
- Enable handoffs between agents

### Squad Relationships

Squads can have relationships with each other:

- **reports_to**: Hierarchical relationship
- **collaborates**: Peer relationship for coordination
- **depends_on**: Dependency relationship

## Quick Start

### 1. Create a Squad

```bash
# Create an engineering squad
ficus squad create "Backend Team" \
  --type engineering \
  --purpose "Develop and maintain backend services"
```

### 2. Create a Work Stream

```bash
# Create work for the squad
ficus workstream create "Build user authentication API" \
  --squad <squad-id> \
  --description "Implement JWT-based auth endpoints" \
  --workflow engineering
```

### 3. Let the workflow route the work

The selected flow creates participants as their steps become active. Do not spawn and assign a separate engineer for a flow-enabled work stream. Use `ficus workstream flow <workstream-id>` to inspect the run and its current steps.

### 4. Monitor Progress

```bash
# List work streams and their status
ficus workstream list --squad <squad-id>

# Get details about a specific work stream
ficus workstream get <workstream-id>
```

## CLI Commands Reference

| Command              | Description                             |
| -------------------- | --------------------------------------- |
| `ficus squad`        | Manage squads (teams of agents)         |
| `ficus squad-preset` | View available squad preset definitions |
| `ficus workstream`   | Manage work streams (units of work)     |

### Aliases

- `ficus ws` → `ficus workstream`
- `ficus st` → `ficus squad-preset`

## Detailed Documentation

- [Squad Commands](squad-commands.md) - Complete reference for `ficus squad`
- [Work Stream Commands](workstream-commands.md) - Complete reference for `ficus workstream`

## Example legacy staffing

The following diagram illustrates a manually staffed legacy squad, not mandatory roles for every workflow.

```
┌─────────────────────────────────────────────────────────────┐
│                          Squad                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Manager   │  │  Engineer   │  │  Reviewer   │          │
│  │ (default)   │  │   (flex)    │  │ (default)   │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│         │                │                │                  │
│         └────────────────┼────────────────┘                  │
│                          │                                   │
│  ┌───────────────────────┼───────────────────────┐          │
│  │              Work Streams                      │          │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐       │          │
│  │  │  WS-1   │  │  WS-2   │  │  WS-3   │       │          │
│  │  │(done)   │  │(active) │  │(blocked)│       │          │
│  │  └─────────┘  └─────────┘  └─────────┘       │          │
│  └───────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

## Work Stream Lifecycle

Stored status is `queued | active | done | canceled`; richer states are typed
OPEN WAITS on an `active`/`queued` stream plus a derived display.

```
        create                    admission (cap slot free,
   ┌────────────┐                 deps done, no open wait)
   │   queued   │◄───────────────────────────┐
   └─────┬──────┘                            │
         │ admit                             │ auto-park (open wait
   ┌─────▼──────┐                            │ older than squad grace)
   │   active   ├────────────────────────────┘
   └─────┬──────┘
         │  waits open/close while active or queued:
         │    block    -> open manual wait   (display: blocked)
         │    handoff  -> open review wait   (display: in_review)
         │    ask --blocking -> question wait (display: waiting_on_answer)
         │    dependsOn unsatisfied -> dependency wait
         │  unblock / answer / send-back / dep-done close them
         │
         │ approve (closes review wait + completes) or `ws done`
   ┌─────▼──────┐          ┌──────────┐
   │    done    │          │ canceled │◄─ cancel (any non-done)
   └────────────┘          └──────────┘
```

## Common Patterns

### Human-in-the-Loop

When an agent needs human input:

```bash
# Agent requests input (opens a manual wait)
ficus ws request-input ws-123 -m "Which approach should I use: A or B?"

# Human resolves it (the note is delivered to the agent)
ficus ws unblock ws-123 -m "Approach A"
```

### Agent Collaboration

```bash
# Engineer hands off to the reviewer
ficus ws handoff ws-123 --to reviewer-agent-id -m "Implementation complete, ready for review"

# Reviewer requests final review (approval completes the stream)
ficus ws request-review ws-123 -m "Code review complete"

# Manager approves (optionally with a note delivered to the owner)
ficus ws approve ws-123 -m "Approved. Follow-ups for a future stream: none"
```

### Squad Coordination

```bash
# Link related squads
ficus squad link frontend-squad backend-squad --type collaborates

# Check communication capability
ficus squad can-communicate frontend-squad backend-squad
```

## Best Practices

1. **Use meaningful names**: Give squads and work streams descriptive names
2. **Set clear purposes**: Squad purposes help agents understand their role
3. **Use dependencies**: Declare work stream dependencies to ensure proper ordering
4. **Provide context**: When blocking or handing off, include relevant context
5. **Clean up**: Unspawn flex agents when their work is complete
6. **Use squad presets**: Leverage predefined squad presets for consistent structure
