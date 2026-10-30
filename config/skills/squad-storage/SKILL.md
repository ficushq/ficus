---
name: squad-storage
description: "Read your own squad's storage breakdown (workspace box, agent box homes, largest folders, growth, stored files) with ficus squad storage, interpret it, and choose safe follow-ups. Requires the squad-scoped storage:read permission. Use when someone asks why a squad uses so much disk, which agent or folder is growing, or what can be cleaned up."
required-permission: storage:read
---

# Squad Storage

## When to Use

Use this skill when you need to know how much storage your squad uses and where:
a human asks why the squad is large, a box is filling up, you want to find a
growing folder before it becomes a problem, or you are deciding whether idle
agents or old worktrees are worth cleaning up. This skill only appears for
agents that hold `storage:read` (managers and consultants by default).

The view covers **your squad only**. It never shows other squads, the host
disk's used or total bytes, capacity warnings, or the instance attachment quota.
Those stay behind `system:logs` (`ficus system storage`, Settings → Storage).

## Reading the Breakdown

```bash
ficus squad storage                 # your squad (FICUS_SQUAD_ID is set in squad boxes)
ficus squad storage <squad-id>      # an explicit squad you have storage:read in (full id, or an id prefix of at least 8 characters)
ficus --json squad storage          # full folder tree and every field, for scripts
```

The command is read-only. It returns the latest saved measurements and never
starts, requests or waits for a scan. Another squad's id returns `403 Forbidden`.

## Interpreting the Output

- **Box homes total**: the sum of your squad's measured box homes across machines.
  `not measured` means no measurement exists yet. It does not mean zero.
- **Newest and oldest measurement**: the age of the most recent and least
  recent box-home measurements. Scanning is continuous and incremental (a pass
  every hour by default), so homes are measured at different times. Treat values
  older than a few hours as approximate and say how old they are when you report them.
- **Scanning**: `in progress` means an instance pass is running. Read again later
  for newer values; existing values stay visible meanwhile.
- **Machine … lines**: one per machine that holds one of your squad's box homes.
  - `Squad workspace` is the shared squad box: the shared workspace, repository
    clones, worktrees, package caches and squad deployments.
  - Agent lines are each agent's personal box home, labelled with the agent's
    purpose or name, type, status and short id. `[agent no longer exists]`
    marks a leftover home of a deleted agent.
  - The indented paths are the largest subfolders of that home (at most five;
    `--json` shows the whole tree).
- **Markers**: `≈` means the total is the sum of separately measured parts, so
  hard-linked files may be counted more than once. `(partial)` means part of the
  folder could not be measured. `from the previous pass` means the current pass
  has not reached that home yet.
- **Growth** (`+1.2 GB since 1d ago`): the change against a retained earlier
  measurement, usually about 24 hours old. Negative values mean it shrank.
- **Stored files on the Ficus host**: files Ficus keeps in its own storage for
  your squad, counted from database rows: agent file attachments, inbox
  attachments delivered to your agents, workflow handoff files and images.
  These are not inside any box.
- Sizes are allocated-byte estimates. They are not suggestions to delete anything.

## Safe Follow-Up Actions

Use only actions that are already permission-checked, and prefer the least
destructive one. Never delete files or agents just because they are large.

- **Workspace hygiene in the squad box** (your own work only): remove your own
  temporary files and finished build outputs, and run project-scoped cleanup
  commands such as `test:db:down` for harnesses you started. Never remove another
  agent's worktree or files, or a worktree that still has an open pull request,
  uncommitted changes or unpushed commits. Worktrees owned by work streams are
  cleaned up by the platform after delivery; retain or inspect them with
  `ficus workstream cleanup inspect <id>` instead of deleting them by hand.
- **Idle flex workers**: preview with `ficus squad cleanup-agents --squad <squad-id> --dry-run`,
  then run it without `--dry-run` to make the eligible workers dormant. This needs
  `agents:terminate` in the squad. Dormancy keeps history and worktrees; it is not deletion.
- **Idle consultants**: the squad's idle-consultant setting (30 days by default)
  makes idle consultants dormant automatically. A person with access to
  Settings → Storage can preview and apply it by hand there, backed by
  `GET /api/squads/:id/idle-consultants` and `POST /api/squads/:id/idle-consultants/dormant`
  (both `agents:terminate` in the squad; the server recomputes the idle set).
  There is no CLI command for it: ask a human rather than making a consultant
  dormant yourself, because a person may still be talking to it.
- **Dormant agents** are removed automatically after the retention period shown
  at the end of the output.

## When to Ask a Human or System Admin

Use `ask_human` (or tell your manager) instead of acting when:

- The host disk itself is filling up, or you need host totals, other squads'
  usage or capacity warnings. That needs `system:logs`.
- Instance-wide cleanup is needed: removing dormant agents now, cleaning up all
  squads, or workspace or package-store garbage collection. That needs `system:cleanup`.
- The largest item is someone else's work, a repository clone or a worktree you
  did not create, or anything whose owner you cannot confirm.
- Stored files on the Ficus host are large. Removing attachments or images is a
  human decision.

## Reference

- Endpoint: `GET /api/squads/:id/storage` (`storage:read` in that squad), response
  type `SquadStorageView` in `packages/shared/src/storage.ts`.
- Server: `apps/core/src/services/storage/squad-view.ts`.
