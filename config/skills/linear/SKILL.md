---
name: linear
description: Safely use Ficus's authenticated Linear CLI to read, create, update and comment on Linear issues
---

# Linear CLI

Use Ficus's authenticated `linear` CLI (schpet/linear-cli) to work with the Linear workspace of the connection assigned to the current squad. Each `linear` command, including one started from a script, receives the connection's key for that command only. If the squad's Linear connection is detached or disabled, `linear` fails instead of falling back to any other account.

## Ficus owns authentication

- Never run `linear auth login`, `linear auth logout` or any other `linear auth` command, and never create credential files or `.linear.toml` files that hold an `api_key`.
- Never print or echo `LINEAR_API_KEY`, dump the environment, or put the key in commands, files, logs or messages.
- Do not pass `--workspace`. The CLI refuses it while Ficus supplies the key, and the connection already selects the workspace.
- Ficus sets `LINEAR_IGNORE_ENV_FILE=1` and pins the API endpoint, so a repository `.env` is never read. Do not override these variables.
- A repository `.linear.toml` can still set defaults such as the team. Pass `--team` explicitly when creating issues so a checked-in default does not decide where an issue goes.
- Exit status 4 means authentication failed: report that the Linear connection must be revalidated or reassigned in Ficus Settings → Integrations → Linear. Do not try to log in.

## Reading

Prefer `--json` output and explicit issue IDs. Commands such as `issue view` default to the issue named by the current git branch when the ID is omitted, which is easy to get wrong in a shared checkout.

```bash
linear issue view ENG-123 --json
linear issue view ENG-123 --json --no-download      # keep image URLs instead of downloading files
linear issue comment list ENG-123 --json
linear issue query --team ENG --search "login timeout" --json
linear issue query --team ENG --state started --assignee @me --json
linear team list
```

`linear issue list` shows only your own unstarted issues by default; use `linear issue query` with explicit filters for anything else.

## Writing

Everything you write through the CLI (issues, descriptions, comments) appears in Linear under the connected account, usually a person's own name. Treat it as public text: follow the squad's public voice and do not mention Ficus internals. Pass `--no-input` so the CLI fails instead of waiting for a prompt, and name every target explicitly.

```bash
linear --no-input issue create --team ENG --title "Fix login timeout" --description-file - -y <<'EOF'
Steps to reproduce...
EOF
linear --no-input issue update ENG-123 --add-label bug --priority high
linear --no-input issue comment add ENG-123 --body-file - -y <<'EOF'
Investigation notes...
EOF
```

Use `linear api` for anything the commands do not cover; `linear schema` prints the GraphQL schema. Pass values as variables rather than splicing them into the document:

```bash
linear api 'query($id: String!) { issue(id: $id) { identifier title state { name type } } }' --variable id=ENG-123
```

### Confirm before destructive or broad changes

Get explicit confirmation from the person who asked immediately before you:

- delete or archive an issue, comment, project or document (`issue delete`, `issue archive`, `issue comment delete` and similar);
- run any `--bulk` command, or change more than a handful of issues in one task;
- move an issue to another team, replace all of its labels with `--label`, or remove its project, cycle or parent;
- run a `linear api` mutation that deletes, archives or changes many records.

Never pass `-y` to a destructive command to skip the CLI's own confirmation unless that person has already confirmed this exact change.

### Leave workflow states to Linear

Do not change an issue's workflow state (`--state`, `issue start`, `issue create --start`) unless a person asked you to. Linear's own GitHub integration moves an issue through its states when a branch or pull request references the issue key. Put the key, for example `ENG-123`, in the branch name and in the pull request title or body, and let that integration update the state. Create pull requests with the squad's normal workflow rather than `linear issue pull-request`.

## Assignee and delegate

An issue has one **assignee**: the person accountable for it. It can also have a **delegate**: an agent working on the issue on that person's behalf, while the assignee stays responsible. Assigning an issue to an agent app in Linear sets it as the delegate, not the assignee. Use `--assignee` and `--unassign` for people, and `--delegate` and `--clear-delegate` for agents. Do not reassign or undelegate an issue that someone else owns unless asked.
