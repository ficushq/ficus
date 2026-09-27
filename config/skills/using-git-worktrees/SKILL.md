---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with smart directory selection and safety verification
---

# Using Git Worktrees

## Work stream authority and command runtime

When work is assigned through a Ficus work stream, first run `ficus workstream get <id> --json` with `squad_bash`. If `git.worktree` and `git.branch` are present, use that recorded worktree and branch; **do not create a second worktree**. Only use this skill's creation flow when no work stream controls the worktree. Run all git, setup, and verification commands with `squad_bash` from the project/shared worktree, and follow the repository's package-manager policy instead of the generic examples below. If `squad_bash` is unavailable, use another shell only when the Workspace & Sandbox prompt says it can reach the recorded worktree; otherwise delegate the repository operation to an agent with shared-runtime access.

## Overview

Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches simultaneously without switching.

**Core principle:** Systematic directory selection + safety verification = reliable isolation.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

## Directory Selection Process

Follow this priority order:

### 1. Check Existing Directories

```bash
# Check in priority order
ls -d .worktrees 2>/dev/null     # Preferred (hidden)
ls -d worktrees 2>/dev/null      # Alternative
```

**If found:** Use that directory. If both exist, `.worktrees` wins.

## Safety Verification

### For Project-Local Directories (.worktrees or worktrees)

**MUST verify directory is ignored before creating worktree:**

```bash
# Check if directory is ignored (respects local, global, and system gitignore)
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

**If NOT ignored:**

Per Jesse's rule "Fix broken things immediately":

1. Add appropriate line to .gitignore
2. Commit the change
3. Proceed with worktree creation

**Why critical:** Prevents accidentally committing worktree contents to repository.

## Creation Steps

### 1. Detect Project Name

```bash
project=$(basename "$(git rev-parse --show-toplevel)")
```

### 2. Create Worktree

```bash
# Determine full path
path="$LOCATION/$BRANCH_NAME"

# Create worktree with new branch
git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
```

### 3. Run Project Setup

Read the repository's `AGENTS.md` and use its declared package manager and setup commands through `squad_bash`. Do not let this generic skill override repository policy. Where no policy exists, choose setup from the project files (for example Cargo, Python requirements, or Go modules).

### 4. Verify Clean Baseline

Run the repository-declared test command through `squad_bash`. If no project policy exists, use the appropriate language test command.

**If tests fail:** Report failures, ask whether to proceed or investigate.

**If tests pass:** Report ready.

### 5. Report Location

```
Worktree ready at <full-path>
Tests passing (<N> tests, 0 failures)
Ready to implement <feature-name>
```

## Quick Reference

| Situation                  | Action                     |
| -------------------------- | -------------------------- |
| `.worktrees/` folder       | Use it (verify ignored)    |
| Directory not ignored      | Add to .gitignore + commit |
| Tests fail during baseline | Report failures + ask      |
| No package.json/Cargo.toml | Skip dependency install    |

## Common Mistakes

### Skipping ignore verification

- **Problem:** Worktree contents get tracked, pollute git status
- **Fix:** Always use `git check-ignore` before creating project-local worktree

### Proceeding with failing tests

- **Problem:** Can't distinguish new bugs from pre-existing issues
- **Fix:** Report failures, get explicit permission to proceed

### Hardcoding setup commands

- **Problem:** Breaks on projects using different tools
- **Fix:** Auto-detect from project files (package.json, etc.)

## Example Workflow

```
You: I'm using the using-git-worktrees skill to set up an isolated workspace.

[Check .worktrees/ - exists]
[Verify ignored - git check-ignore confirms .worktrees/ is ignored]
[Create worktree: git worktree add .worktrees/auth -b feature/auth]
[Read AGENTS.md and run the repository setup/test commands through squad_bash]

Worktree ready at <git.worktree>
Tests passing (47 tests, 0 failures)
Ready to implement auth feature
```

## Red Flags

**Never:**

- Create worktree without verifying it's ignored (project-local)
- Skip baseline test verification
- Proceed with failing tests without asking
- Assume directory location when ambiguous
- Skip CLAUDE.md check

**Always:**

- Verify directory is ignored for project-local
- Auto-detect and run project setup
- Verify clean test baseline

## Post-delivery lifetime

Platform-provisioned trees default to automatic asynchronous cleanup after delivery
and associated execution settlement. This is not a manual cleanup assignment.
Set `ficus workstream update <id> --auto-cleanup-worktree false` before finishing
when retention is required. Register other-stream use before accessing a shared
tree; undeclared shell access is outside the cooperative isolation guarantee.
Do not recreate or reuse a path with pending/uncertain cleanup, or delete its
operation marker. A cleaned stream requires a newly provisioned stream for more
work. Branches and delivery provenance are retained. Manually created or
historical trees without platform ownership are not automatically swept.
