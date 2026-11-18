---
name: using-git-worktrees
description: Use when starting repository work that needs an isolated branch, or when a work stream's recorded worktree is missing - finds or creates the right git worktree safely
---

# Using Git Worktrees

## The work stream decides

When work is assigned through a Ficus work stream, first run
`ficus workstream get <id> --json` with `squad_bash` and read `git.worktree` and
`git.branch`. If they are present, use that recorded worktree and branch; **do not
create a second worktree**. If the directory is missing, follow the worktree rules in
your system prompt (inspect `worktreeCleanup` first; never recreate a path whose
cleanup is pending or uncertain). Use the creation steps below only when no work
stream controls the worktree.

Run every git, setup and test command with `squad_bash` from the worktree. If
`squad_bash` is unavailable, use another shell only when your Workspace & Sandbox
prompt says it can reach the worktree; otherwise delegate the repository operation
to an agent with shared-runtime access.

## Creating a worktree yourself

1. Choose the directory: the location the repository's `AGENTS.md` names, otherwise
   an existing `.worktrees/` or `worktrees/` folder, otherwise create `.worktrees/`.
2. For a project-local directory, confirm it is ignored before creating anything
   (`git check-ignore -q .worktrees`). If it is not, add it to `.gitignore` and
   commit that first, so worktree contents are never tracked.
3. Create the branch from the configured base branch, not an assumed `main`:

   ```bash
   git worktree add "<dir>/<branch>" -b "<branch>" "<base-branch>"
   ```

4. Run the setup and focused test commands that `AGENTS.md` declares, using the
   repository's package manager. If the baseline already fails, report it; when the
   assignment does not settle whether to continue, ask with `ask_human`.

## After delivery

Platform-provisioned worktrees are cleaned up automatically after the stream is
delivered. To keep one, run `ficus workstream cleanup retain <id>` before finishing.
Branches and delivery history remain after cleanup; further work needs a newly
provisioned stream.
