# Squad CLI Commands

The `ficus squad` command manages squads: teams of agents that work together on work streams. This page covers common commands; run `ficus squad --help` for additional workspace, memory, subscription, and administration commands.

## Overview

```bash
ficus squad [command] [options]
```

## Commands

### list

List all squads.

```bash
ficus squad list [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-s, --status <status>` | Filter by status (`active`, `paused`, `archived`) |
| `-a, --include-anonymous` | Include anonymous squads in the listing |

**Examples:**

```bash
# List visible squads (soft-deleted squads are excluded)
ficus squad list

# List only paused squads
ficus squad list --status paused

# Include anonymous squads
ficus squad list --include-anonymous
```

---

### create

Create a new squad.

```bash
ficus squad create|new [options] <name>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `name` | Name of the new squad |

**Options:**
| Option | Description |
|--------|-------------|
| `-p, --purpose <purpose>` | Squad purpose/mission statement |
| `-t, --type <typeId>` | Squad preset ID (e.g., `general`, `research`, `engineering`) |
| `-a, --default-agent <agentType>` | Default agent type to include (can be repeated) |

**Examples:**

```bash
# Create a basic squad
ficus squad create "Frontend Team"

# Create an engineering squad with purpose
ficus squad create "API Development" --preset engineering --purpose "Build and maintain REST APIs"

# Legacy manual default staffing; workflow participants are normally created lazily
ficus squad create "Full Stack Team" -a architect -a engineer -a reviewer
```

---

### get

Get detailed information about a squad.

```bash
ficus squad get|info <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# Get squad details
ficus squad get abc123

# Using alias
ficus squad info abc123
```

---

### update

Update an existing squad.

```bash
ficus squad update|edit [options] <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID to update |

**Options:**
| Option | Description |
|--------|-------------|
| `-n, --name <name>` | New name for the squad |
| `-p, --purpose <purpose>` | New purpose statement |
| `-s, --status <status>` | New status (`active`, `paused`, `archived`) |
| `--add-default-agent <agentType>` | Add a default agent type |
| `--remove-default-agent <agentType>` | Remove a default agent type |

**Examples:**

```bash
# Rename a squad
ficus squad update abc123 --name "New Team Name"

# Pause a squad
ficus squad update abc123 --status paused

# Add a reviewer agent to the squad
ficus squad update abc123 --add-default-agent reviewer

# Multiple updates at once
ficus squad update abc123 --name "Updated Team" --purpose "New mission"
```

---

### delete

Archive a squad (soft delete), preserving its agents, work streams, messages, and history. Archive hides it from normal listings, revokes its agent tokens, disables squad schedules, clears default channel routing to it, retires slot coordination, and removes its shared sandbox. It deletes indexed memory chunks while preserving memory documents and links. Archived squads reject guarded mutations with `410 Squad is archived`.

Workspace and SSH files are retained by default. `--delete-workspace` also permanently removes the managed storage workspace and squad SSH directory; a host workspace override is never deleted.

```bash
ficus squad delete|rm|archive [--delete-workspace] <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID to archive |

**Examples:**

```bash
# Archive a squad and keep workspace files
ficus squad delete abc123

# Using an alias
ficus squad archive abc123

# Archive and permanently remove managed workspace and SSH files
ficus squad delete abc123 --delete-workspace
```

---

### workspace

Show the workspace directory tree for a squad.

```bash
ficus squad workspace|ws <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# View squad workspace structure
ficus squad workspace abc123

# Using alias
ficus squad ws abc123
```

---

### file

Show file contents from a squad's workspace.

```bash
ficus squad file|cat <id> <path>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |
| `path` | Path to the file within the workspace |

**Examples:**

```bash
# View a file from squad workspace
ficus squad file abc123 src/index.js

# Using alias
ficus squad cat abc123 README.md
```

---

### link

Create a relationship between two squads.

```bash
ficus squad link [options] <source> <target>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `source` | Source squad ID |
| `target` | Target squad ID |

**Options:**
| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Relationship type: `reports_to`, `collaborates`, `depends_on` |

**Examples:**

```bash
# Create a reporting relationship
ficus squad link team-a team-b --type reports_to

# Create a collaboration relationship
ficus squad link frontend backend --type collaborates

# Create a dependency relationship
ficus squad link api database --type depends_on
```

---

### unlink

Remove a relationship between squads.

```bash
ficus squad unlink <relationshipId>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `relationshipId` | ID of the relationship to remove |

**Examples:**

```bash
# Remove a relationship
ficus squad unlink rel-123
```

---

### relationships

List all relationships for a squad.

```bash
ficus squad relationships|rels <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# List squad relationships
ficus squad relationships abc123

# Using alias
ficus squad rels abc123
```

---

### can-communicate

Check if two squads can communicate with each other.

```bash
ficus squad can-communicate|can-comm <squadA> <squadB>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `squadA` | First squad ID |
| `squadB` | Second squad ID |

**Examples:**

```bash
# Check communication capability
ficus squad can-communicate team-a team-b

# Using alias
ficus squad can-comm frontend backend
```

---

### agents

List all agents in a squad.

```bash
ficus squad agents <id>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `id` | Squad ID |

**Examples:**

```bash
# List squad agents
ficus squad agents abc123
```

---

### Listing squad work streams

Use the work-stream command group:

```bash
ficus workstream list --squad abc123
```

`ficus squad tasks` is not a command. `--squad <squadId>` filters the work-stream list by squad.

---

### spawn

Spawn a new agent in a squad.

```bash
ficus squad spawn [options] <agentType> <squadId>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `agentType` | Type of agent to spawn (e.g., `engineer`, `architect`, `reviewer`) |
| `squadId` | Squad ID to spawn the agent in |

**Options:**
| Option | Description |
|--------|-------------|
| `-w, --workstream <workstreamId>` | Assign the spawned agent to a work stream |

**Examples:**

```bash
# Spawn an engineer in a squad
ficus squad spawn engineer abc123

# Spawn and assign to a work stream
ficus squad spawn architect abc123 --workstream ws-456
```

---

### unspawn

Terminate a flex agent.

```bash
ficus squad unspawn <agentId>
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `agentId` | Agent ID to terminate |

**Examples:**

```bash
# Terminate a flex agent
ficus squad unspawn agent-789
```

---

## Attention (watch)

Watching a squad sets two independent attention levels for it: `decisions` (questions, reviews, blockers) and `progress` (active work and completions). Each is `mute` (hidden from your Action Center and feed), `show` (listed, never interrupts), or `notify` (listed, plus an inbox message and push).

```bash
ficus squad subscription SQUAD_ID          # your levels + watcher count
ficus squad watch SQUAD_ID                 # both kinds at notify (alias of subscribe)
ficus squad watch SQUAD_ID --progress mute # keep decisions as-is, stop completion notices
ficus squad watch SQUAD_ID --decisions mute --progress mute
ficus squad unwatch SQUAD_ID               # remove the row; back to show/show
```

An omitted flag keeps the kind at its current EFFECTIVE level — the level stored on your row if you have one, otherwise the default `show`. Changing one kind never turns the other one up. A per-work-stream row overrides these levels for that one stream.

## Workflow configuration

Configure the default source in squad `metadata.workflow`. Store selection guidance and alternatives in `metadata.workflowSetup`. The `setup-workflows` manager skill helps choose these without creating agents. A squad preset describes its domain; worker combinations and orchestration belong to workflows. See [the workflow guide](../workflows.md).

## Squad Presets

Use `ficus squad-preset` to view available squad presets:

```bash
# List all squad presets
ficus squad-preset list

# Get details about a specific type
ficus squad-preset get engineering
```

Available squad presets:

- `engineering` — Software development, starting with Solo Coding and a selection of engineering workflows.
- `engineering` - Software development team for building and maintaining code

## Common Workflows

### Creating a Development Team

```bash
# Create an engineering squad
ficus squad create "Backend API Team" \
  --preset engineering \
  --purpose "Develop and maintain the REST API"

# Link it to the platform team
ficus squad link backend-team platform-team --type collaborates
```

### Managing metadata

```bash
ficus squad set-meta <id> ledger.current.sequence 7
ficus squad get-meta <id> ledger.current.sequence
ficus squad unset-meta <id> ledger.current.sequence
```

`set-meta` and `unset-meta` send only the requested dot-path delta. The server recursively merges objects, deletes keys set to `null`, and serializes concurrent updates so unrelated keys are preserved. Arrays replace the whole array; changing one element requires `get-meta`, local modification, and `set-meta` of the entire array key. Concurrent writers to the same key are last-serialized-writer-wins. Empty path segments and `__proto__`, `prototype`, or `constructor` segments are rejected. `get-meta` uses one entity GET, extracts the value client-side, and reports missing paths as errors.

### Managing Squad Lifecycle

```bash
# Pause a squad (e.g., during reorganization)
ficus squad update abc123 --status paused

# Archive a completed squad with the full archive lifecycle
ficus squad archive abc123

# Reactivate a paused squad
ficus squad update abc123 --status active
```

Use `archive` (or `delete`) for the full archive lifecycle. The legacy `update --status archived` option remains accepted but only changes status; it does not perform the soft-delete cleanup above. `--status active` reactivates a paused squad, not a soft-deleted squad.

### Scaling a Squad

```bash
# Spawn additional engineers for a sprint
ficus squad spawn engineer abc123 --workstream ws-sprint-1
ficus squad spawn engineer abc123 --workstream ws-sprint-2

# Clean up after sprint
ficus squad unspawn agent-1
ficus squad unspawn agent-2
```
