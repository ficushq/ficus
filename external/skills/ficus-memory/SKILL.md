---
name: ficus-memory
description: Use when an agent needs to retrieve, preserve, or maintain durable organization or project knowledge across sessions using Ficus memory.
---

# Ficus Memory

Ficus is durable shared memory, not scratch space. Every memory operation must target an explicit **squad vault**, and every write must preserve useful context for future humans and agents.

## Workspace Path Context

Ficus memory is shared by remote squad agents and local developer agents. They often work on the same repositories, but in different checkouts and execution environments.

- Squad agents commonly refer to files under `/workspace/...`.
- Local developer agents may see the same repository under a local path such as `/Users/.../project`.
- For durable code references, prefer **repo-rooted paths** like `project-name/packages/shared/src/...`. These are representative paths that tell future agents where to look without depending on one machine's absolute checkout location.
- When reading memory, translate `/workspace/<repo-rooted-or-relative-path>` to the local checkout only when the mapping is clear.
- When writing memory, preserve `/workspace/...` if it describes squad-specific runtime or execution context, but also add a repo-rooted path when possible.
- Avoid documenting local absolute paths.

## When to Use

Use Ficus memory for durable knowledge such as:

- Architecture, product, or operational decisions with rationale.
- Reusable codebase patterns and conventions.
- Debugging playbooks and incident lessons.
- API contracts, integration references, and recurring setup steps.
- Stable, high-signal facts that will help future sessions.

Do **not** use Ficus memory for:

- Secrets, credentials, tokens, private keys, or personal data.
- Temporary TODOs, scratch notes, chat logs, or task-by-task progress.
- Unverified guesses or content copied without source/path attribution.
- Information that belongs only in the current workspace or agent notes.

## Required Workflow

Before reading, searching, writing, patching, appending, or deleting memory:

1. Use the Ficus CLI path shown in the generated **Installed Ficus CLI** section below.
   - If no installed path is documented, use `ficus` when it is on `PATH`; otherwise ask the human to install/configure Ficus CLI.
2. Run `<ficus-cli> squad list`.
3. Select the squad UUID:
   - If exactly one squad is listed, use that squad automatically.
   - If multiple squads are listed, confirm the intended company, human, project, and squad name before proceeding.
4. Copy the squad UUID.
5. Use `--squad <squad-id>` on **every** `<ficus-cli> memory ...` command.
6. Read the squad's routing and context files before any search/write/update/delete:

   ```bash
   <ficus-cli> memory get /memory/map.md --squad <squad-id>
   <ficus-cli> memory get /memory/context.md --squad <squad-id>
   ```

7. Search/read related memory before answering from memory or modifying memory.
8. If writing, choose the destination and conventions from `/memory/map.md`.
9. Prefer precise patch/append operations over full-file overwrite.
10. Re-read modified files to verify final content.
11. Tell the human or calling agent which memory paths changed.

Never rely on an implicit default squad when multiple squads are available. If the correct squad is unclear, ask the human or search/read only in explicitly confirmed squads.

## Mandatory First Reads

Treat `/memory/context.md` as always-on context for the selected squad. Re-read it when starting a new session or switching squads.

Treat `/memory/map.md` as the vault routing guide. Use it to decide where new durable knowledge belongs and which frontmatter, tags, wikilinks, paths, or naming conventions to follow.

If either file is missing, continue read/search cautiously. Create or update map/context only when explicitly asked or when maintaining the vault is part of the task. If unsure, search/read only; do not write.

## Memory Quality Rules

Before writing or modifying memory:

- Read existing related files first; do not overwrite useful context.
- Preserve frontmatter and existing headings unless intentionally improving them.
- Cite repo paths, URLs, PRs, or command outputs when documenting facts.
- Use exact memory paths beginning with `/memory/`.
- Use frontmatter for new Markdown files when vault conventions allow:

```markdown
---
title: 'API Error Handling Pattern'
kind: pattern
tags: [api, errors]
---

# API Error Handling Pattern

Durable guidance with source paths and rationale.
```

Common `kind` values include `decision`, `pattern`, `playbook`, `reference`, and `incident`; follow `/memory/map.md` if it defines different conventions.

Use wikilinks when helpful:

```markdown
See [[API Error Handling Pattern]] and [[Deploy Runbook#Rollback]].
```

## Safe Operations

- **Search first:** `<ficus-cli> memory search "authentication flow" --squad <squad-id> --limit 5`
- **List directories:** `<ficus-cli> memory list /memory/patterns --squad <squad-id>`
- **Read complete files:** `<ficus-cli> memory get /memory/patterns/api-errors.md --squad <squad-id>`
- **Create/write only intentionally:** `<ficus-cli> memory write /memory/patterns/api-errors.md --squad <squad-id> < api-errors.md`
- **Append additive notes:** `<ficus-cli> memory append /memory/runbooks/deploy.md --squad <squad-id> --newline --content "..."`
- **Patch exact matches:** `<ficus-cli> memory patch /memory/patterns/api-errors.md --squad <squad-id> --match "old exact text" --replace "new text"`
- **Check backlinks before destructive edits:** `<ficus-cli> memory backlinks /memory/patterns/api-errors.md --squad <squad-id>`

For detailed CLI examples, see `CLI_REFERENCE.md`. For HTTP fallback examples, see `HTTP_REFERENCE.md`.

## Indexing Latency

Memory writes are not immediately searchable through hybrid/vector search. `write`, `patch`, `append`, and delete operations schedule a throttled memory-file reindex for the squad. The default throttle interval is **60 seconds**: updates are indexed at most once per minute per squad, and continued updates can trigger another reindex on the next interval rather than postponing indexing indefinitely. Read the file directly with `memory get` when you need to verify a just-written path immediately.

## Conflict and Error Handling

- If read/search fails because the squad does not exist, stop and reconfirm the squad UUID.
- If patch reports no match or ambiguous matches, read the file again and choose a more precise exact match.
- If you discover sensitive data in memory, do not copy it elsewhere; ask a human or vault owner how to remediate.
- If you are not confident a fact is durable or correctly sourced, do not write it to memory.

## Setup Boundary

This skill assumes Ficus CLI or HTTP access is already configured. Do not turn normal memory tasks into installation work unless the human explicitly asks for setup help. To install the skill into a project, use `ficus skill install ficus-memory --agent <pi|claude-code|codex>` from the project root.

Never print, commit, or write `FICUS_PASSWORD` or `$HOME/.ficus/cli/auth.json` contents into memory.
